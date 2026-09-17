import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureUniqueIds,
  existsVerdict,
  MAX_CANDIDATES,
  rankCandidates,
  RELATION_TO_VERDICT,
  sanitizeId,
  screenRecommendation,
  truncate,
  verifyAction,
} from "../dist/lib.js";

test("sanitizeId keeps safe characters and drops the rest", () => {
  assert.equal(sanitizeId("src/lib.ts"), "src_lib.ts");
  assert.equal(sanitizeId("note: hello?!"), "note_hello");
  assert.equal(sanitizeId("???"), "");
  assert.equal(sanitizeId("a".repeat(100)).length, 64);
});

test("ensureUniqueIds assigns fallbacks and resolves collisions", () => {
  const { items, renamed } = ensureUniqueIds(
    [
      { id: "src/lib.ts", text: "a" },
      { id: "src/lib.ts", text: "b" },
      { text: "c" },
    ],
    "candidate",
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ["src_lib.ts", "src_lib.ts_1", "candidate2"],
  );
  assert.equal(renamed.size, 1);
});

test("truncate marks truncated text", () => {
  const out = truncate("abcdef", 3);
  assert.equal(out.length > 3, true);
  assert.match(out, /…truncated\]$/);
  assert.equal(truncate("abc", 3), "abc");
});

test("relation maps to verdict labels", () => {
  assert.equal(RELATION_TO_VERDICT.supports, "verified");
  assert.equal(RELATION_TO_VERDICT.contradicts, "contradicted");
  assert.equal(RELATION_TO_VERDICT.says_nothing, "unsupported");
  assert.equal(RELATION_TO_VERDICT.other, undefined);
});

test("verifyAction gates on auto-accept threshold", () => {
  assert.equal(verifyAction(0.8, 0.8), "auto");
  assert.equal(verifyAction(0.79, 0.8), "review");
  assert.equal(verifyAction(0.99, 0.8), "auto");
});

test("screenRecommendation escalates by injection then demotes junk", () => {
  assert.deepEqual(screenRecommendation({ injection: 0.9, blockAt: 0.75, reviewAt: 0.25 }).action, "block");
  assert.deepEqual(screenRecommendation({ injection: 0.4, blockAt: 0.75, reviewAt: 0.25 }).action, "review");
  assert.deepEqual(screenRecommendation({ injection: 0.01, blockAt: 0.75, reviewAt: 0.25 }).action, "pass");
  assert.deepEqual(
    screenRecommendation({ injection: 0.01, substance: 0.1, blockAt: 0.75, reviewAt: 0.25 }).action,
    "skip",
  );
  assert.deepEqual(
    screenRecommendation({ injection: 0.01, relevance: 0.05, blockAt: 0.75, reviewAt: 0.25 }).action,
    "skip",
  );
});

test("existsVerdict uses cookbook thresholds", () => {
  assert.equal(existsVerdict(0.98), "answered");
  assert.equal(existsVerdict(0.46), "partial");
  assert.equal(existsVerdict(0.14), "absent");
});

test("rankCandidates orders by probability and keeps caller order on ties", () => {
  const candidates = [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }];
  const ranked = rankCandidates(candidates, { a: 0.1, b: 0.5, c: 0.1 });
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["b", "a", "c"],
  );
  const missing = rankCandidates([{ id: "x", text: "1" }], {});
  assert.equal(missing[0].probability, 0);
});

test("MAX_CANDIDATES stays within TypeSafe Choice option limit", () => {
  assert.ok(MAX_CANDIDATES <= 255);
});
