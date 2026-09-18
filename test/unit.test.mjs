import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classificationDecision,
  contradictsRecommendation,
  DECIDE_ESCAPE_HATCHES,
  ensureUniqueIds,
  existsVerdict,
  marginOf,
  MAX_CANDIDATES,
  MAX_CANDIDATES_DECIDE,
  MAX_CLASSES,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_REQUIREMENTS,
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



test("marginOf measures winner-to-runner-up gap", () => {
  assert.ok(Math.abs(marginOf({ a: 0.7, b: 0.2, c: 0.1 }) - 0.5) < 1e-9);
  assert.equal(marginOf({ a: 0.5, b: 0.5 }), 0);
  assert.equal(marginOf({ only: 0.8 }), 0); // lone probability: no runner-up, margin 0
  assert.equal(marginOf(undefined), 0);
  assert.equal(marginOf(null), 0);
});

test("classificationDecision requires both top probability and margin", () => {
  assert.equal(classificationDecision(0.9, 0.6, 0.85, 0.5), "auto");
  assert.equal(classificationDecision(0.9, 0.4, 0.85, 0.5), "review"); // high conf, thin margin
  assert.equal(classificationDecision(0.8, 0.8, 0.85, 0.5), "review"); // wide margin, low top
  assert.equal(classificationDecision(0.85, 0.5, 0.85, 0.5), "auto"); // exactly at both gates
});

test("catalog and batch caps stay within Jev limits", () => {
  assert.ok(MAX_CLASSES <= 255);
  assert.ok(MAX_ITEMS >= 2 && MAX_ITEMS <= 255);
});

test("contradictsRecommendation flags only the recommended candidate", () => {
  const checks = [
    { candidate: "a", requirement: 0, answer: "contradicted" },
    { candidate: "a", requirement: 1, answer: "supported" },
    { candidate: "b", requirement: 0, answer: "contradicted" },
    { candidate: "a", requirement: 2, answer: "unknown" },
  ];
  assert.deepEqual(contradictsRecommendation(checks, "a"), [0]);
  assert.deepEqual(contradictsRecommendation(checks, "b"), [0]); // b also contradicts req 0
  assert.deepEqual(contradictsRecommendation([], "a"), []);
});

test("decide caps stay sane", () => {
  assert.ok(MAX_CANDIDATES_DECIDE >= 2 && MAX_CANDIDATES_DECIDE <= 10);
  assert.ok(MAX_REQUIREMENTS >= 0 && MAX_REQUIREMENTS <= 10);
  assert.ok(Object.keys(DECIDE_ESCAPE_HATCHES).length === 3);
});
