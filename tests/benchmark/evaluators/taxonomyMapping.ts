/**
 * Evaluator-side mapping from the dataset's semantic labels to Reflect's
 * actual taxonomy. Production classifications are never altered to fit the
 * dataset; the dataset's words are translated here, in the open, and every
 * translation that is not one-to-one says so.
 *
 * The dataset and Reflect use the same four dimension NAMES for partly
 * different things:
 *
 *   dataset "context"  Work / Leisure / Personal      = Reflect's AREA dimension
 *   dataset "area"     Own SaaS / Freelance / …       = the body of work. Reflect's
 *                      classification has no such dimension out of the box (its
 *                      Context dimension is the user-defined activity list:
 *                      Coding, Learning, Meetings, …). The nearest thing Reflect
 *                      produces is Reflection's link from an activity to a
 *                      stated PRIORITY, so that is what it is compared with.
 *   dataset "intent"   = Reflect's INTENT dimension (two labels have no exact twin)
 *   dataset "quality"  = Reflect's QUALITY dimension (Reflect is finer-grained)
 *
 * `accept` lists Reflect NAMES; they are resolved to the live ids of the
 * benchmark database at evaluation time, and a name that does not exist there
 * is reported instead of guessed.
 */

export type DatasetDimension = 'context' | 'area' | 'intent' | 'quality';
export type ReflectTarget = 'area' | 'intent' | 'quality' | 'priority';

export interface LabelMapping {
  /** Reflect names that count as correct. `null` means "no value assigned". */
  accept: (string | null)[];
  /**
   * exact       one unambiguous Reflect value
   * ambiguous   no single twin; judged against the accept-set, excluded from strict accuracy
   * unmappable  no meaningful counterpart; excluded from every accuracy figure
   */
  kind: 'exact' | 'ambiguous' | 'unmappable';
  note?: string;
}

export interface DimensionMapping {
  target: ReflectTarget;
  note: string;
  labels: Record<string, LabelMapping>;
}

/** Key used for a dataset label of `null`. */
export const NULL_LABEL = '(none)';

export const TAXONOMY_MAPPING: Record<DatasetDimension, DimensionMapping> = {
  context: {
    target: 'area',
    note: 'Dataset "context" (Work / Leisure / Personal) is Reflect\'s Area dimension.',
    labels: {
      Work: { accept: ['Work'], kind: 'exact' },
      Leisure: { accept: ['Leisure'], kind: 'exact' },
      Personal: { accept: ['Personal'], kind: 'exact' },
    },
  },
  area: {
    target: 'priority',
    note:
      'Dataset "area" names the body of work. Reflect has no classification dimension for it; it is compared with the stated priority ' +
      'Reflection linked the activity to. This is a cross-concept comparison and is reported as ambiguous.',
    labels: {
      'Own SaaS': { accept: ['Ship the SaaS MVP'], kind: 'ambiguous', note: 'Compared with the priority link, not a classification id.' },
      Freelance: {
        accept: ['Complete existing client work', 'Generate new freelance leads'],
        kind: 'ambiguous',
        note: 'One dataset area covers two stated priorities; either link counts.',
      },
      Plan: { accept: [], kind: 'unmappable', note: 'General planning serves no single stated priority.' },
      Learning: { accept: [], kind: 'unmappable', note: 'Learning serves no single stated priority.' },
      [NULL_LABEL]: { accept: [null], kind: 'ambiguous', note: 'Leisure / personal time: no priority should be linked.' },
    },
  },
  intent: {
    target: 'intent',
    note: 'Dataset "intent" is Reflect\'s Intent dimension. Reflect has no "Review" or "Complete"; it has "Organize", which the dataset never uses.',
    labels: {
      Create: { accept: ['Create'], kind: 'exact' },
      Communicate: { accept: ['Communicate'], kind: 'exact' },
      Plan: { accept: ['Plan'], kind: 'exact' },
      Consume: { accept: ['Consume'], kind: 'exact' },
      Learn: { accept: ['Learn'], kind: 'exact' },
      Manage: { accept: ['Manage'], kind: 'exact' },
      Research: { accept: ['Research'], kind: 'exact' },
      Review: { accept: ['Research', 'Manage', 'Organize'], kind: 'ambiguous', note: 'Reflect has no "Review" intent.' },
      Complete: { accept: ['Create', 'Manage'], kind: 'ambiguous', note: 'Reflect has no "Complete" intent.' },
    },
  },
  quality: {
    target: 'quality',
    note: 'Dataset "quality" is Reflect\'s Quality dimension. Reflect also has "Deep Work" and "Distracting", which the dataset never uses.',
    labels: {
      Focused: { accept: ['Focused', 'Deep Work'], kind: 'ambiguous', note: 'Reflect splits focused work into "Focused" and "Deep Work"; both count.' },
      Routine: { accept: ['Routine'], kind: 'exact' },
      'Break-Idle': { accept: ['Break / Idle'], kind: 'exact' },
    },
  },
};

/**
 * The mapping's own spelling of a dataset label. "review", "Review" and
 * "REVIEW" are one label; anything else is returned as it is and has no
 * mapping.
 */
export function canonicalLabel(dimension: DatasetDimension, label: string | null): string | null {
  if (label === null) return null;
  const labels = TAXONOMY_MAPPING[dimension].labels;
  if (label in labels) return label;
  const lower = label.trim().toLowerCase();
  return Object.keys(labels).find((known) => known.toLowerCase() === lower) ?? label;
}

export interface ReflectTaxonomy {
  areas: { id: string; name: string }[];
  intents: { id: string; name: string }[];
  qualities: { id: string; name: string }[];
  priorities: { id: string; text: string }[];
}

export interface ResolvedLabel {
  kind: LabelMapping['kind'];
  /** Accepted Reflect ids (`null` = no value). */
  acceptIds: (string | null)[];
  acceptNames: (string | null)[];
  note: string | null;
}

export interface ResolvedMapping {
  dimensions: Record<DatasetDimension, { target: ReflectTarget; note: string; labels: Map<string, ResolvedLabel> }>;
  /** Mapping targets that do not exist in the live taxonomy, and dataset labels with no mapping. */
  issues: string[];
}

/** Resolve the mapping's Reflect names against the live taxonomy of the benchmark database. */
export function resolveMapping(taxonomy: ReflectTaxonomy, usedLabels: Record<DatasetDimension, (string | null)[]>): ResolvedMapping {
  const issues: string[] = [];
  const lookup: Record<ReflectTarget, Map<string, string>> = {
    area: new Map(taxonomy.areas.map((x) => [x.name, x.id])),
    intent: new Map(taxonomy.intents.map((x) => [x.name, x.id])),
    quality: new Map(taxonomy.qualities.map((x) => [x.name, x.id])),
    priority: new Map(taxonomy.priorities.map((x) => [x.text, x.id])),
  };

  const dimensions = {} as ResolvedMapping['dimensions'];
  for (const dimension of Object.keys(TAXONOMY_MAPPING) as DatasetDimension[]) {
    const mapping = TAXONOMY_MAPPING[dimension];
    const labels = new Map<string, ResolvedLabel>();
    for (const [label, entry] of Object.entries(mapping.labels)) {
      const acceptIds: (string | null)[] = [];
      const acceptNames: (string | null)[] = [];
      for (const name of entry.accept) {
        if (name === null) {
          acceptIds.push(null);
          acceptNames.push(null);
          continue;
        }
        const id = lookup[mapping.target].get(name);
        if (id === undefined) {
          issues.push(`${dimension}="${label}" maps to Reflect ${mapping.target} "${name}", which does not exist in the benchmark database`);
          continue;
        }
        acceptIds.push(id);
        acceptNames.push(name);
      }
      const kind = entry.kind !== 'unmappable' && acceptIds.length === 0 ? 'unmappable' : entry.kind;
      labels.set(label, { kind, acceptIds, acceptNames, note: entry.note ?? null });
    }
    for (const used of new Set(usedLabels[dimension].map((l) => l ?? NULL_LABEL))) {
      if (!labels.has(used)) {
        issues.push(`Dataset ${dimension}="${used}" has no entry in the evaluator's taxonomy mapping; it is excluded from accuracy`);
        labels.set(used, { kind: 'unmappable', acceptIds: [], acceptNames: [], note: 'No mapping defined.' });
      }
    }
    dimensions[dimension] = { target: mapping.target, note: mapping.note, labels };
  }
  return { dimensions, issues };
}
