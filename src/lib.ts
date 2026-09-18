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

/** Max candidates per jev_decide call. */
export const MAX_CANDIDATES_DECIDE = 6;

/** Max requirements per jev_decide call. */
export const MAX_REQUIREMENTS = 3;

/** Escape-hatch options appended to the Choice criteria so the model can decline to rank. */
export const DECIDE_ESCAPE_HATCHES: Record<string, string> = {
  ask_user: "A consequential user preference or requirement is missing; ask instead of inventing it",
  investigate: "Gather missing technical or factual evidence before selecting a candidate",
  none: "None of the supplied candidates fits the known requirements",
};

/**
 * A requirement check contradicts the recommended candidate when it returns
 * "contradicted" for that candidate. Independent questions may disagree with
 * the recommendation; surface the disagreement, do not average it away.
 */
export function contradictsRecommendation(
  checks: Array<{ candidate: string; requirement: number; answer: string }>,
  recommended: string,
): number[] {
  return checks
    .filter((c) => c.candidate === recommended && c.answer === "contradicted")
    .map((c) => c.requirement);
}

/** Max candidates for jev_rerank, bounded by the Choice option limit. */
export const MAX_RERANK_CANDIDATES = 250;

/** Aggregate candidate-text budget for jev_rerank (characters, across all candidates). */
export const MAX_RERANK_TOTAL_CHARS = 100_000;

/** Max aspects for jev_compare (independent per-aspect Choices). */
export const MAX_COMPARE_ASPECTS = 10;

/** Max fields for jev_extract per call. */
export const MAX_EXTRACT_FIELDS = 32;

/** Max regex candidates per field before the set is flagged truncated. */
export const MAX_EXTRACT_CANDIDATES = 20;

/** A single regex match longer than this is skipped and flagged, never silently truncated. */
export const MAX_EXTRACT_CANDIDATE_CHARS = 2_000;

/** Aggregate candidate-preview budget for jev_extract (characters, across all fields). */
export const MAX_EXTRACT_TOTAL_CHARS = 50_000;

/** Hard per-field deadline for caller-supplied regex execution in a worker. */
export const REGEX_TIMEOUT_MS = 1_000;

/** The three pairwise relations jev_compare judges overall. */
export const COMPARE_RELATIONS: Record<string, string> = {
  same_fact: "Both passages state the same underlying fact or claim",
  contradicts: "The passages state opposing facts about the same subject",
  different_facts: "The passages discuss different subjects or make non-overlapping claims",
};

/**
 * Per-aspect wording of the same three relations. At aspect granularity the
 * third outcome usually means one or both passages do not address the aspect,
 * so the criterion says so explicitly instead of relying on the label alone.
 */
export const ASPECT_RELATIONS: Record<string, string> = {
  same_fact: "Both passages make comparable assertions about this aspect and they agree",
  contradicts: "Both passages address this aspect and their assertions conflict",
  different_facts:
    "The passages do not both make a comparable assertion about this aspect: at least one does not address it, or their mentions do not overlap",
};

/**
 * Rerank candidates by per-candidate relevance scores aligned by index,
 * descending. Scores are validated by the caller before this runs; the 0
 * fallback only guards an internal wiring mistake, never a model answer.
 */
export function rerankByScore<T extends object>(candidates: T[], scores: number[]): Array<T & { relevance: number }> {
  return candidates
    .map((c, i) => ({ ...c, relevance: scores[i] ?? 0 }))
    .sort((a, b) => b.relevance - a.relevance);
}
