import { ApiError, GoogleGenAI } from '@google/genai';

/**
 * Gemini provider module. Contains ONLY provider/API concerns: key lookup,
 * request shape, structured-output config, and mapping provider failures onto
 * a small error taxonomy. No application logic lives here.
 *
 * The API key is read in the Electron main process only and is never returned,
 * logged, or passed to the renderer.
 */

/** The single place the Gemini model is selected. */
export const GEMINI_MODEL = 'gemini-2.5-flash-lite';

const REQUEST_TIMEOUT_MS = 90_000;

export type GeminiErrorCategory = 'missing_api_key' | 'network' | 'api' | 'quota' | 'malformed_output';

export class GeminiError extends Error {
  constructor(
    public readonly category: GeminiErrorCategory,
    message: string,
    /** Whether trying the same request again can plausibly succeed. */
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiJsonRequest {
  systemInstruction: string;
  prompt: string;
  /** JSON Schema the response must conform to. */
  responseJsonSchema: unknown;
}

export interface GeminiJsonResponse {
  /** Raw JSON text. Parsing/validation is the caller's job. */
  text: string;
  /** Concrete model version that answered (falls back to the constant). */
  modelVersion: string;
}

export interface IGeminiClient {
  readonly model: string;
  isConfigured(): boolean;
  generateJson(request: GeminiJsonRequest): Promise<GeminiJsonResponse>;
}

/** The slice of the SDK this module uses — the injection seam for tests. */
export interface GeminiTransport {
  generateContent(params: {
    model: string;
    contents: string;
    config: Record<string, unknown>;
  }): Promise<{ text?: string; modelVersion?: string }>;
}

export interface GeminiClientOptions {
  /** Defaults to `process.env.GEMINI_API_KEY`, read at call time. */
  getApiKey?: () => string | undefined;
  /** Defaults to the real `@google/genai` SDK. */
  createTransport?: (apiKey: string) => GeminiTransport;
}

export class GeminiClient implements IGeminiClient {
  readonly model = GEMINI_MODEL;
  private readonly getApiKey: () => string | undefined;
  private readonly createTransport: (apiKey: string) => GeminiTransport;
  private transport: GeminiTransport | null = null;
  private transportKey: string | null = null;

  constructor(options: GeminiClientOptions = {}) {
    this.getApiKey = options.getApiKey ?? (() => process.env.GEMINI_API_KEY);
    this.createTransport = options.createTransport ?? defaultTransport;
  }

  isConfigured(): boolean {
    return this.readKey() !== null;
  }

  async generateJson(request: GeminiJsonRequest): Promise<GeminiJsonResponse> {
    const apiKey = this.readKey();
    if (!apiKey) {
      throw new GeminiError('missing_api_key', 'GEMINI_API_KEY is not set', false);
    }

    let response: { text?: string; modelVersion?: string };
    try {
      response = await this.transportFor(apiKey).generateContent({
        model: this.model,
        contents: request.prompt,
        config: {
          systemInstruction: request.systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema: request.responseJsonSchema,
          temperature: 0.2,
        },
      });
    } catch (err) {
      throw toGeminiError(err, apiKey);
    }

    const text = response.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new GeminiError('malformed_output', 'Gemini returned an empty response', true);
    }
    return { text, modelVersion: response.modelVersion ?? this.model };
  }

  private readKey(): string | null {
    const key = this.getApiKey()?.trim();
    return key ? key : null;
  }

  private transportFor(apiKey: string): GeminiTransport {
    if (!this.transport || this.transportKey !== apiKey) {
      this.transport = this.createTransport(apiKey);
      this.transportKey = apiKey;
    }
    return this.transport;
  }
}

function defaultTransport(apiKey: string): GeminiTransport {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  return {
    generateContent: (params) => ai.models.generateContent(params),
  };
}

function toGeminiError(err: unknown, apiKey: string): GeminiError {
  if (err instanceof GeminiError) return err;
  const message = scrub(err instanceof Error ? err.message : String(err), apiKey);
  const status = err instanceof ApiError ? err.status : statusOf(err);

  if (typeof status === 'number') {
    if (status === 429) return new GeminiError('quota', `Gemini quota/rate limit (429): ${message}`, true, status);
    if (status === 408 || status >= 500) return new GeminiError('api', `Gemini API error (${status}): ${message}`, true, status);
    return new GeminiError('api', `Gemini API error (${status}): ${message}`, false, status);
  }
  // No HTTP status → the request never completed (DNS, offline, timeout, abort).
  return new GeminiError('network', `Gemini network error: ${message}`, true);
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Provider messages can echo the request URL; never let the key through. */
function scrub(message: string, apiKey: string): string {
  return message.split(apiKey).join('[REDACTED]').slice(0, 500);
}
