// Pure helpers — no API access, fully unit-testable.

/** Max candidates in one jev_find call. TypeSafe Choice supports up to 255 options. */
export const MAX_CANDIDATES = 250;

/** Default per-candidate text cap (characters) to keep request size bounded. */
export const MAX_CANDIDATE_CHARS = 2000;

/**
 * Sanitize a caller-supplied id into a safe Choice option key.
 * Keeps alphanumerics, underscore, dash and dot; collapses the rest.
 */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "";
}

export type Identifiable = { id?: string; [key: string]: unknown };

/** Ensure ids exist, are safe, and are unique; returns the id actually used per candidate. */
export function ensureUniqueIds<T extends Identifiable>(
  items: T[],
  fallbackPrefix: string,
): { items: Array<T & { id: string }>; renamed: Map<string, string> } {
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  const out = items.map((item, i) => {
    const raw = item.id ?? "";
    const base = sanitizeId(raw) || `${fallbackPrefix}${i}`;
    let id = base;
    let n = 1;
    while (used.has(id)) {
      id = `${base}_${n++}`;
    }
    used.add(id);
    if (raw && raw !== id) renamed.set(raw, id);
    return { ...item, id } as T & { id: string };
  });
  return { items: out, renamed };
}

/** Truncate long text with an explicit marker so the model knows it is partial. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + " […truncated]";
}

/** Map a jev_verify relation answer to a verdict label (citation-check cookbook). */
export const RELATION_TO_VERDICT: Record<string, string> = {
  supports: "verified",
  contradicts: "contradicted",
  says_nothing: "unsupported",
};

/** Does this verdict stand on its own, or should a human confirm it? */
export function verifyAction(confidence: number, autoAccept: number): "auto" | "review" {
  return confidence >= autoAccept ? "auto" : "review";
}

/**
 * Screen recommendation from probabilities.
 * injection: probability the text contains instructions aimed at an AI agent.
 * relevance: probability the text is useful for the stated purpose (optional).
 * substance: probability the text has substantive readable content (optional).
 */
export function screenRecommendation(input: {
  injection: number;
  relevance?: number;
  substance?: number;
  blockAt: number;
  reviewAt: number;
}): { action: "pass" | "review" | "block" | "skip"; reason: string } {
  const { injection, relevance, substance, blockAt, reviewAt } = input;
  if (injection >= blockAt)
    return { action: "block", reason: `injection probability ${injection.toFixed(2)} >= block threshold ${blockAt}` };
  if (injection >= reviewAt)
    return { action: "review", reason: `injection probability ${injection.toFixed(2)} >= review threshold ${reviewAt}` };
  if (substance !== undefined && substance < 0.3)
    return { action: "skip", reason: `little substantive content (substance ${substance.toFixed(2)})` };
  if (relevance !== undefined && relevance < 0.3)
    return { action: "skip", reason: `not relevant to the stated purpose (relevance ${relevance.toFixed(2)})` };
  return { action: "pass", reason: "no signals above thresholds" };
}

/** Turn the exists Noul into a document-level verdict (semantic-find cookbook thresholds). */
export function existsVerdict(exists: number, found = 0.7, absent = 0.35): string {
  if (exists >= found) return "answered";
  return exists < absent ? "absent" : "partial";
}

/** Rank candidate ids by Choice probability, descending. Ties keep caller order. */
export function rankCandidates<T extends { id: string }>(
  candidates: T[],
  probabilities: Record<string, number>,
): Array<T & { probability: number }> {
  return candidates
    .map((candidate, index) => ({ candidate: { ...candidate, probability: probabilities[candidate.id] ?? 0 }, index }))
    .sort((a, b) => b.candidate.probability - a.candidate.probability || a.index - b.index)
    .map(({ candidate }) => candidate);
}

/** Max classes per jev_classify call, bounded by the Choice option limit. */
export const MAX_CLASSES = 250;

/** Max items per jev_classify call; each becomes one Choice question in one request. */
export const MAX_ITEMS = 64;

/** Item text cap; classification works on bounded excerpts, not whole documents. */
export const MAX_ITEM_CHARS = 2000;

/** Winner-to-runner-up gap; a lone probability has no runner-up, so its margin is 0. */
export function marginOf(probabilities: Record<string, number> | undefined | null): number {
  const ranked = Object.values(probabilities ?? {}).sort((a, b) => b - a);
  if (ranked.length < 2) return 0;
  return ranked[0] - ranked[1];
}

/**
 * Auto-accept requires BOTH a high top probability and a clear margin, per the
 * conservative thresholds recommended after classification spike testing.
 */
export function classificationDecision(
  topProbability: number,
  margin: number,
  autoAccept: number,
  minimumMargin: number,
): "auto" | "review" {
  return topProbability >= autoAccept && margin >= minimumMargin ? "auto" : "review";
}
