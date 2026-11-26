/** Baseline diff: which solo paths are new since a previous audit. */
import type { AuditResult } from "./types.js";

export interface PathDiff {
  addedSolo: string[];
  resolvedSolo: string[];
  verdictChanges: Array<{ key: string; from: string; to: string }>;
  addedUnknown: string[];
}

export function diffAudits(
  baseline: AuditResult,
  current: AuditResult,
): PathDiff {
  const baseByKey = new Map(baseline.paths.map((p) => [p.key, p]));
  const curByKey = new Map(current.paths.map((p) => [p.key, p]));
  const addedSolo: string[] = [];
  const resolvedSolo: string[] = [];
  const verdictChanges: Array<{ key: string; from: string; to: string }> = [];
  const addedUnknown: string[] = [];

  for (const [key, cur] of curByKey) {
    const base = baseByKey.get(key);
    if (!base) {
      if (cur.verdict === "SOLO-PATH") addedSolo.push(key);
      if (cur.verdict === "UNKNOWN") addedUnknown.push(key);
      continue;
    }
    if (base.verdict !== cur.verdict) {
      verdictChanges.push({ key, from: base.verdict, to: cur.verdict });
      if (cur.verdict === "SOLO-PATH") addedSolo.push(key);
      if (base.verdict === "SOLO-PATH" && cur.verdict !== "SOLO-PATH") {
        resolvedSolo.push(key);
      }
    }
  }
  for (const [key, base] of baseByKey) {
    if (!curByKey.has(key) && base.verdict === "SOLO-PATH")
      resolvedSolo.push(key);
  }
  return { addedSolo, resolvedSolo, verdictChanges, addedUnknown };
}

/** True when the diff is a regression: a new solo path, or a path turned solo. */
export function isRegression(d: PathDiff): boolean {
  return d.addedSolo.length > 0;
}
