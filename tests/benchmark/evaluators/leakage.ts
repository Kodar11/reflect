import type { EvaluationOnly, ReflectInput } from '../runner/dataset';

/**
 * The tripwire behind the input / answer-key separation.
 *
 * The runner can only hand `ReflectInput` to Reflect, so ground truth has no
 * path into a prompt or a table. This module checks that claim instead of
 * trusting it: it turns every sentence of the answer key into word shingles
 * and looks for them in each outgoing Gemini request and, after the run, in
 * every text column of the benchmark database.
 *
 * It holds the answer key in a closure and exposes only a function from text
 * to the fragments found in it.
 */

const SHINGLE_WORDS = 8;

const wordsOf = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function shinglesOf(text: string): string[] {
  const tokens = wordsOf(text);
  const out: string[] = [];
  for (let i = 0; i + SHINGLE_WORDS <= tokens.length; i++) out.push(tokens.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
}

export interface LeakDetector {
  /** Answer-key fragments present in `text` (empty when clean). */
  findLeaks(text: string): string[];
  /** Number of distinct answer-key shingles being watched for. */
  shingleCount: number;
}

export function buildLeakDetector(evaluation: EvaluationOnly, input: ReflectInput): LeakDetector {
  // Wording Reflect legitimately receives is not a leak, wherever else it appears.
  const legitimate: string[] = [];
  collectStrings(input, legitimate);
  const allowed = new Set(legitimate.flatMap(shinglesOf));

  const secret: string[] = [];
  for (const day of evaluation.days) {
    collectStrings(
      {
        circumstances: day.circumstances,
        activities: day.groundTruth.activities.map((a) => [a.title, a.summary]),
        unobserved: day.groundTruth.unobserved_periods.map((u) => u.reason),
        reflection: day.expectedReflection,
        coach: day.expectedCoachOutcome,
        objectives: day.evaluationObjectives,
      },
      secret,
    );
  }
  const shingles = new Map<string, string>();
  for (const sentence of secret) {
    for (const shingle of shinglesOf(sentence)) {
      if (!allowed.has(shingle) && !shingles.has(shingle)) shingles.set(shingle, sentence);
    }
  }
  // Day-type slugs are single tokens no prompt has a reason to contain.
  const slugs = evaluation.days.map((d) => d.dayType.toLowerCase()).filter((s) => s.includes('_'));

  return {
    shingleCount: shingles.size,
    findLeaks(text: string): string[] {
      const found = new Set<string>();
      const tokens = wordsOf(text);
      for (let i = 0; i + SHINGLE_WORDS <= tokens.length; i++) {
        const source = shingles.get(tokens.slice(i, i + SHINGLE_WORDS).join(' '));
        if (source) found.add(source);
      }
      const lower = text.toLowerCase();
      for (const slug of slugs) if (lower.includes(slug)) found.add(slug);
      return [...found];
    },
  };
}

export interface DatabaseLeak {
  table: string;
  column: string;
  fragment: string;
}

interface Queryable {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Search every text value of every table for answer-key fragments. */
export function scanDatabaseForLeaks(db: Queryable, detector: LeakDetector): { tablesScanned: number; valuesScanned: number; leaks: DatabaseLeak[] } {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  const leaks: DatabaseLeak[] = [];
  let valuesScanned = 0;
  for (const table of tables) {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'string' || value.length < 20) continue;
        valuesScanned++;
        for (const fragment of detector.findLeaks(value)) leaks.push({ table, column, fragment });
      }
    }
  }
  return { tablesScanned: tables.length, valuesScanned, leaks };
}
