#!/usr/bin/env node
// jev-mcp: TypeSafe Jev as MCP judgment tools.
//
// Three purpose-built tools instead of a raw API passthrough — the question
// design lives here so every agent thread gets well-formed judgments:
//
//   jev_verify — check claims against evidence (citation-check pattern)
//   jev_screen — guardrail fetched/external text before it enters context
//   jev_find   — semantic search over candidates, no embeddings required

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { choice, noul } from "@typesafe-ai/sdk";
import { z } from "zod";
import {
  classificationDecision,
  ensureUniqueIds,
  existsVerdict,
  marginOf,
  MAX_CLASSES,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_CANDIDATES,
  MAX_CANDIDATE_CHARS,
  rankCandidates,
  RELATION_TO_VERDICT,
  screenRecommendation,
  truncate,
  verifyAction,
} from "./lib.js";

const MODEL = process.env.JEV_MCP_MODEL ?? "jev-latest";

const server = new McpServer({ name: "jev-mcp", version: "0.1.0" });

import { askJev as askProvider } from "./provider.js";

async function askJev(state: unknown, questions: Record<string, unknown>) {
  return askProvider(state, questions, MODEL);
}

const text = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

const evidenceSchema = z.union([
  z.string().describe("A single evidence document."),
  z
    .object({
      id: z.string().optional().describe("Short identifier for this evidence item."),
      text: z.string().describe("The evidence text."),
    })
    .describe("A single evidence item."),
  z
    .array(
      z.object({
        id: z.string().optional().describe("Short identifier for this evidence item (e.g. 'site-html', 'rfc-4.1.3')."),
        text: z.string().describe("The evidence text."),
      }),
    )
    .min(1)
    .describe("Multiple evidence items; each claim is also matched to the item it rests on."),
]);

const candidatesSchema = z
  .array(
    z.object({
      id: z.string().optional().describe("Short identifier for this candidate (e.g. a file path, note name, or line id)."),
      text: z.string().describe("The candidate's text."),
    }),
  )
  .min(1)
  .max(MAX_CANDIDATES)
  .describe(`Candidates to search. Up to ${MAX_CANDIDATES} in one call; texts are truncated at ${MAX_CANDIDATE_CHARS} chars.`);

// ─────────────────────────────────────────────────────────────────────────────
// jev_verify
// ─────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "jev_verify",
  {
    title: "Verify claims against evidence",
    description:
      "Check each claim against provided evidence text with TypeSafe Jev. Returns per claim: " +
      "verdict (verified | contradicted | unsupported), full probability distribution, confidence, " +
      "and whether the verdict stands on its own (auto) or needs human review. " +
      "Pattern: docs.typesafe.ai/cookbooks/citation_check. Pass reports, PR descriptions, or agent briefs as claims " +
      "and their cited sources, diffs, or documents as evidence.",
    inputSchema: {
      claims: z.array(z.string()).min(1).describe("Claims to verify, e.g. individual factual statements from a report."),
      evidence: evidenceSchema,
      auto_accept: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Verdicts at or above this confidence stand automatically; below it they are flagged 'review'. Default 0.8."),
    },
  },
  async ({ claims, evidence: rawEvidence, auto_accept }) => {
    const autoAccept = auto_accept ?? 0.8;
    const evidenceItems =
      typeof rawEvidence === "string"
        ? [{ id: "evidence", text: rawEvidence }]
        : Array.isArray(rawEvidence)
          ? rawEvidence
          : [rawEvidence];
    const { items: evidence } = ensureUniqueIds(evidenceItems, "evidence");
    const { items: claimItems } = ensureUniqueIds(claims.map((text) => ({ text })), "claim");

    const questions: Record<string, unknown> = {};
    for (const claim of claimItems) {
      questions[`relation_${claim.id}`] = choice(
        `How does the evidence relate to claim \`${claim.id}\` (${claim.text})?`,
        {
          supports: "The evidence states the claim or directly implies that it is true",
          contradicts: "The evidence states the opposite of the claim or implies that it is false",
          says_nothing: "The evidence does not address what the claim asserts, either way",
        },
      );
      if (evidence.length > 1) {
        const criteria: Record<string, string | null> = Object.fromEntries(evidence.map((e) => [e.id, null]));
        criteria["none"] = "No single evidence item contains the content the claim depends on";
        questions[`source_${claim.id}`] = choice(
          `Which evidence item does claim \`${claim.id}\` (${claim.text}) rest on?`,
          criteria,
        );
      }
    }

    const state = {
      purpose: "Verify each claim in claims against the evidence in evidence.",
      claims: claimItems,
      evidence,
    };

    const { answers, usage, provider, model } = await askJev(state, questions);

    const results = claimItems.map((claim) => {
      const relation = answers[`relation_${claim.id}`];
      const source = answers[`source_${claim.id}`];
      const confidence = relation?.confidence ?? null;
      const verdict = RELATION_TO_VERDICT[relation?.choice] ?? "unknown";
      return {
        id: claim.id,
        claim: claim.text,
        verdict,
        probabilities: relation?.probabilities ?? null,
        confidence,
        action: confidence === null ? "review" : verifyAction(confidence, autoAccept),
        supporting_evidence: source?.choice && source.choice !== "none" ? source.choice : null,
      };
    });

    return text({
      tool: "jev_verify",
      model: model,
      provider,
      auto_accept: autoAccept,
      summary: {
        verified: results.filter((r) => r.verdict === "verified").length,
        contradicted: results.filter((r) => r.verdict === "contradicted").length,
        unsupported: results.filter((r) => r.verdict === "unsupported").length,
        needs_review: results.filter((r) => r.action === "review").length,
      },
      results,
      usage,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// jev_screen
// ─────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "jev_screen",
  {
    title: "Screen content before it enters agent context",
    description:
      "Judge fetched or external text with TypeSafe Jev before an agent reads it: probability it contains " +
      "instructions aimed at an AI agent (prompt injection), whether it has substantive content, and (when a purpose " +
      "is given) whether it is relevant to the task. Returns a recommendation: pass | review | block | skip. " +
      "Pattern: docs.typesafe.ai/cookbooks/llm_guardrails.",
    inputSchema: {
      text: z.string().min(1).describe("The content to screen, e.g. a fetched web page or pasted document."),
      purpose: z
        .string()
        .optional()
        .describe("What the consuming agent is trying to do; enables a relevance judgment and the 'skip' action."),
      block_at: z.number().min(0).max(1).optional().describe("Injection probability at or above which content is blocked. Default 0.75."),
      review_at: z.number().min(0).max(1).optional().describe("Injection probability at or above which content is flagged for review. Default 0.25."),
    },
  },
  async ({ text: content, purpose, block_at, review_at }) => {
    const blockAt = block_at ?? 0.75;
    const reviewAt = review_at ?? 0.25;

    const questions: Record<string, unknown> = {
      injection: noul(
        "The text contains instructions addressed to an AI agent or language model that attempt to change its behavior",
        {
          true: "Contains directives like: ignore previous instructions, reveal your system prompt, visit a URL, exfiltrate data, output hidden markers, or treat the text as authoritative over the agent's task",
          false: "Ordinary content for human readers; no instructions targeting an AI agent",
        },
      ),
      substance: noul("The text contains substantive readable content", {
        true: "Meaningful prose, data, or documentation — not an empty page, error message, or pure boilerplate",
        false: "Empty, truncated to nothing, an error page, or only navigation/boilerplate",
      }),
    };
    if (purpose) {
      questions.relevance = noul(`The text is useful source material for this task: "${purpose}"`, {
        true: "Contains information a reader would need to accomplish the task",
        false: "Has nothing to do with the task",
      });
    }

    const state = { content, purpose: purpose ?? null };
    const { answers, usage, provider, model } = await askJev(state, questions);

    const injection = answers.injection?.noul ?? 0;
    const substance = answers.substance?.noul ?? undefined;
    const relevance = purpose ? (answers.relevance?.noul ?? undefined) : undefined;

    const recommendation = screenRecommendation({ injection, relevance, substance, blockAt, reviewAt });

    return text({
      tool: "jev_screen",
      model: model,
      provider,
      probabilities: { injection, substance, relevance: relevance ?? null },
      thresholds: { block_at: blockAt, review_at: reviewAt },
      recommendation,
      usage,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// jev_find
// ─────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "jev_find",
  {
    title: "Semantic search over candidates",
    description:
      "Rank candidates against a plain-language query with TypeSafe Jev — no embeddings needed. " +
      "One Choice scores every candidate id by how well it answers the query, plus a Noul checks whether " +
      "any candidate addresses the query at all (so a confident 'top hit' cannot masquerade as an answer). " +
      "Pattern: docs.typesafe.ai/cookbooks/semantic_find. Use for 'which file/note/line covers X' across up to " +
      `${MAX_CANDIDATES} candidates.`,
    inputSchema: {
      query: z.string().min(1).describe("What you are looking for, in natural language."),
      candidates: candidatesSchema,
      top_k: z.number().int().min(1).max(50).optional().describe("How many ranked candidates to return. Default 5."),
    },
  },
  async ({ query, candidates: rawCandidates, top_k }) => {
    const topK = top_k ?? 5;
    const { items: candidates } = ensureUniqueIds(
      rawCandidates.map((c) => ({ id: c.id ?? "", text: truncate(c.text, MAX_CANDIDATE_CHARS) })),
      "candidate",
    );

    const criteria: Record<string, null> = Object.fromEntries(candidates.map((c) => [c.id, null]));
    const questions: Record<string, unknown> = {
      best: choice(`Which candidate contains the best answer to: "${query}"?`, criteria),
      exists: noul(`Does any candidate address or answer: "${query}"?`, {
        true: "At least one candidate states or directly implies the answer",
        false: "No candidate addresses this",
      }),
    };

    const state = { query, candidates };
    const { answers, usage, provider, model } = await askJev(state, questions);

    const probabilities = answers.best?.probabilities ?? {};
    const ranked = rankCandidates(candidates, probabilities).slice(0, topK);
    const exists = answers.exists?.noul ?? 0;

    return text({
      tool: "jev_find",
      model: model,
      provider,
      query,
      exists,
      exists_verdict: existsVerdict(exists),
      top: ranked.map((c) => ({ id: c.id, probability: Number(c.probability.toFixed(4)), text: c.text })),
      usage,
    });
  },
);


// ─────────────────────────────────────────────────────────────────────────────
// jev_classify
// ─────────────────────────────────────────────────────────────────────────────
server.registerTool(
  "jev_classify",
  {
    title: "Classify items against a shared label set",
    description:
      "Assign each item to one class from a shared catalog with TypeSafe Jev, in one batched request: " +
      "the class catalog is sent once and every item becomes an independent Choice question. " +
      "Returns per item: the chosen class, the full distribution, confidence, winner-to-runner-up margin, " +
      "and an auto-versus-review decision. Auto requires both a high top probability (default 0.85) and a " +
      "clear margin (default 0.50); everything else is flagged for review. Include a manual_review class " +
      "in the catalog if you want an explicit escape hatch; the tool never invents one.",
    inputSchema: {
      items: z
        .array(z.object({ id: z.string().optional(), text: z.string() }))
        .min(1)
        .max(MAX_ITEMS)
        .describe(`Items to classify. Text is truncated at ${MAX_ITEM_CHARS} characters; send bounded excerpts, not whole documents.`),
      classes: z
        .array(z.object({ id: z.string().optional(), description: z.string() }))
        .min(2)
        .max(MAX_CLASSES)
        .describe(
          "Shared class catalog. Strong descriptions carry the decision: a precise definition, " +
          "what belongs, what does not, precedence over overlapping classes, and a short example.",
        ),
      purpose: z.string().optional().describe("What this classification is for; shared across all items."),
      context: z
        .union([z.string(), z.record(z.any())])
        .optional()
        .describe("Shared context available to every item's judgment: policies, catalogs, anything stable."),
      auto_accept: z.number().min(0).max(1).optional().describe("Minimum top probability for auto. Default 0.85."),
      minimum_margin: z.number().min(0).max(1).optional().describe("Minimum winner-to-runner-up gap for auto. Default 0.5."),
    },
  },
  async ({ items: rawItems, classes: rawClasses, purpose, context, auto_accept, minimum_margin }) => {
    const autoAccept = auto_accept ?? 0.85;
    const minMargin = minimum_margin ?? 0.5;
    const { items: classList } = ensureUniqueIds(
      rawClasses.map((c) => ({ ...c, text: c.description.slice(0, MAX_ITEM_CHARS) })),
      "class",
    );
    const { items: itemList } = ensureUniqueIds(
      rawItems.map((i) => ({ ...i, text: truncate(i.text, MAX_ITEM_CHARS) })),
      "item",
    );

    const criteria: Record<string, string> = {};
    for (const c of classList) criteria[c.id] = c.text;
    const questions: Record<string, unknown> = {};
    for (const item of itemList) {
      questions[`item_${item.id}`] = choice(
        `Which class does item \`${item.id}\` belong to?`,
        criteria,
      );
    }

    const state = {
      purpose: purpose ?? "Assign each item to exactly one class.",
      context: context ?? null,
      classes: classList.map((c) => ({ id: c.id, description: c.text })),
      items: itemList.map((i) => ({ id: i.id, text: i.text })),
    };

    const { answers, usage, provider, model } = await askJev(state, questions);

    const results = itemList.map((item) => {
      const answer = answers[`item_${item.id}`];
      const probabilities: Record<string, number> = answer?.probabilities ?? {};
      const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
      const top = ranked[0]?.[0] ?? answer?.choice ?? null;
      const topProbability = top !== null ? (probabilities[top] ?? 0) : 0;
      const margin = marginOf(probabilities);
      return {
        id: item.id,
        classification: top,
        probabilities: probabilities,
        confidence: answer?.confidence ?? null,
        margin,
        decision: classificationDecision(topProbability, margin, autoAccept, minMargin),
      };
    });

    const byClass: Record<string, number> = {};
    for (const r of results) {
      if (r.classification !== null) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
    }

    return text({
      tool: "jev_classify",
      model: model,
      provider,
      summary: {
        items: results.length,
        auto: results.filter((r) => r.decision === "auto").length,
        review: results.filter((r) => r.decision === "review").length,
        by_class: byClass,
      },
      thresholds: { auto_accept: autoAccept, minimum_margin: minMargin },
      results,
      usage,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
await server.connect(new StdioServerTransport());
console.error(`[jev-mcp] ready — model ${MODEL}`);
