import { createHash } from 'node:crypto';
import { GeminiError, type GeminiJsonRequest, type GeminiJsonResponse, type IGeminiClient } from '../../../src/intelligence/GeminiClient';
import { buildSystemInstruction } from '../../../src/intelligence/IntelligencePrompt';

/**
 * A transparent meter around the production `GeminiClient`.
 *
 * It forwards every request unchanged to the real client (same model, same
 * prompt, same schema) and only watches: how many requests each pipeline
 * stage made, how long they took, how they ended — and whether anything from
 * the answer key ever appeared in a prompt.
 */

export type GeminiStage =
  /** `IntelligenceService`: raw events → AI activities. */
  | 'activity_reconstruction'
  /** `ReflectionAnnotator`: AI activities → work thread + priority link. */
  | 'thread_linking'
  /** `ReflectionService` for a day, with the Coach in the same request. */
  | 'daily_reflection_coach'
  /** `ReflectionService` without the Coach (week / month, or a day long past). */
  | 'reflection'
  | 'other';

export interface GeminiCallRecord {
  seq: number;
  /** Simulated day being processed when the request was made. */
  dayNumber: number | null;
  stage: GeminiStage;
  model: string;
  modelVersion: string | null;
  /** Real wall-clock time of the request. */
  requestedAt: string;
  /** Simulated time of the request. */
  simulatedAt: string;
  latencyMs: number;
  ok: boolean;
  errorCategory: string | null;
  retryable: boolean | null;
  httpStatus: number | null;
  systemChars: number;
  promptChars: number;
  responseChars: number;
  /** Hash of system instruction + prompt: identical inputs across runs hash alike. */
  promptSha256: string;
  /** Answer-key fragments found in the request. Must always be empty. */
  leaks: string[];
}

export class GroundTruthLeakError extends Error {
  constructor(public readonly fragments: string[]) {
    super(`Ground truth reached a Gemini prompt: ${fragments.slice(0, 3).map((f) => JSON.stringify(f)).join(', ')}`);
    this.name = 'GroundTruthLeakError';
  }
}

export interface MeteredGeminiOptions {
  simulatedNow: () => Date;
  /** Returns the answer-key fragments found in `text` (empty when clean). */
  findLeaks: (text: string) => string[];
  minCallIntervalMs?: number;
  /** Called after every request with the full payload (for `--save-prompts`). */
  onCall?: (record: GeminiCallRecord, request: GeminiJsonRequest, responseText: string | null, error: string | null) => void;
}

const INTELLIGENCE_SYSTEM = buildSystemInstruction();

export function classifyStage(systemInstruction: string): GeminiStage {
  if (systemInstruction === INTELLIGENCE_SYSTEM) return 'activity_reconstruction';
  if (systemInstruction.includes("You label a user's activities for Reflect")) return 'thread_linking';
  if (systemInstruction.includes('You are Reflect, a personal activity reflection system.')) {
    return systemInstruction.includes('THE COACH') ? 'daily_reflection_coach' : 'reflection';
  }
  return 'other';
}

export class MeteredGemini implements IGeminiClient {
  readonly calls: GeminiCallRecord[] = [];
  /** Set by the runner before it processes a day. */
  dayNumber: number | null = null;
  private lastCallEndedAt = 0;

  constructor(
    private readonly inner: IGeminiClient,
    private readonly options: MeteredGeminiOptions,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  async generateJson(request: GeminiJsonRequest): Promise<GeminiJsonResponse> {
    const leaks = this.options.findLeaks(`${request.systemInstruction}\n${request.prompt}`);
    const record: GeminiCallRecord = {
      seq: this.calls.length + 1,
      dayNumber: this.dayNumber,
      stage: classifyStage(request.systemInstruction),
      model: this.inner.model,
      modelVersion: null,
      requestedAt: new Date(Date.now()).toISOString(),
      simulatedAt: this.options.simulatedNow().toISOString(),
      latencyMs: 0,
      ok: false,
      errorCategory: null,
      retryable: null,
      httpStatus: null,
      systemChars: request.systemInstruction.length,
      promptChars: request.prompt.length,
      responseChars: 0,
      promptSha256: createHash('sha256').update(request.systemInstruction).update('\n').update(request.prompt).digest('hex'),
      leaks,
    };
    this.calls.push(record);

    // The safeguard: an answer-key fragment in a prompt is never sent.
    if (leaks.length > 0) {
      record.errorCategory = 'ground_truth_leak';
      this.options.onCall?.(record, request, null, 'ground truth leak');
      throw new GroundTruthLeakError(leaks);
    }

    const wait = this.lastCallEndedAt + (this.options.minCallIntervalMs ?? 0) - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    const started = performance.now();
    try {
      const response = await this.inner.generateJson(request);
      record.latencyMs = Math.round(performance.now() - started);
      record.ok = true;
      record.modelVersion = response.modelVersion;
      record.responseChars = response.text.length;
      this.options.onCall?.(record, request, response.text, null);
      return response;
    } catch (err) {
      record.latencyMs = Math.round(performance.now() - started);
      if (err instanceof GeminiError) {
        record.errorCategory = err.category;
        record.retryable = err.retryable;
        record.httpStatus = err.status ?? null;
      } else {
        record.errorCategory = 'internal';
      }
      this.options.onCall?.(record, request, null, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this.lastCallEndedAt = performance.now();
    }
  }

  callsFor(dayNumber: number): GeminiCallRecord[] {
    return this.calls.filter((c) => c.dayNumber === dayNumber);
  }
}

export interface GeminiUsageSummary {
  model: string;
  modelVersions: string[];
  totalCalls: number;
  succeeded: number;
  failed: number;
  byStage: Record<string, { calls: number; failed: number; meanLatencyMs: number | null }>;
  failuresByCategory: Record<string, number>;
  meanLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalLatencyMs: number;
  leaks: number;
}

export function summarizeCalls(calls: GeminiCallRecord[], model: string): GeminiUsageSummary {
  const mean = (values: number[]) => (values.length > 0 ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null);
  const byStage: GeminiUsageSummary['byStage'] = {};
  const failuresByCategory: Record<string, number> = {};
  for (const call of calls) {
    const stage = (byStage[call.stage] ??= { calls: 0, failed: 0, meanLatencyMs: null });
    stage.calls++;
    if (!call.ok) {
      stage.failed++;
      const category = call.errorCategory ?? 'unknown';
      failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
    }
  }
  for (const [stage, summary] of Object.entries(byStage)) {
    summary.meanLatencyMs = mean(calls.filter((c) => c.stage === stage && c.ok).map((c) => c.latencyMs));
  }
  const latencies = calls.filter((c) => c.ok).map((c) => c.latencyMs).sort((a, b) => a - b);
  return {
    model,
    modelVersions: [...new Set(calls.map((c) => c.modelVersion).filter((v): v is string => v !== null))],
    totalCalls: calls.length,
    succeeded: calls.filter((c) => c.ok).length,
    failed: calls.filter((c) => !c.ok).length,
    byStage,
    failuresByCategory,
    meanLatencyMs: mean(latencies),
    p95LatencyMs: latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null,
    totalLatencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    leaks: calls.filter((c) => c.leaks.length > 0).length,
  };
}
