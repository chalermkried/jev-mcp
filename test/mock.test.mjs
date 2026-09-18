// Deterministic coverage against a local mock of the TypeSafe API: pins the
// jev_extract gating branches and wire payload with controlled answers, so the
// tests do not depend on live model behavior or an API key.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function withMock(answers, fn) {
  const requests = [];
  const http = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: typeof answers === "function" ? answers(JSON.parse(raw)) : answers, usage: { input_tokens: 10, output_tokens: 10 } }));
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = http.address().port;
  const client = new Client({ name: "jev-mcp-mock-e2e", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      TYPESAFE_API_KEY: "test-key",
      TYPESAFE_BASE_URL: `http://127.0.0.1:${port}`,
    },
  });
  await client.connect(transport);
  try {
    return await fn(client, requests);
  } finally {
    await client.close();
    http.close();
  }
}

function payload(result) {
  const block = result.content?.find((b) => b.type === "text");
  assert.ok(block, "tool returned no text content");
  return JSON.parse(block.text);
}

// A Choice distribution over n candidate keys that picks key at full margin.
function pick(choiceKey, keys) {
  const rest = keys.filter((k) => k !== choiceKey);
  const probabilities = { [choiceKey]: 0.95 };
  rest.forEach((k) => (probabilities[k] = 0.05 / rest.length));
  return { choice: choiceKey, confidence: 0.99, probabilities };
}

const VERSIONS = Array.from({ length: 25 }, (_, i) => `1.0.${i}`).join(" ");
const EXTRACT_ARGS = {
  document: `Changelog: ${VERSIONS}`,
  fields: [{ id: "ceo", pattern: "\\d+\\.\\d+\\.\\d+", description: "The full name of the company's CEO" }],
};

test("jev_extract sends only eligible matches when overlong ones would fill the cap", async () => {
  // Twenty distinct overlong digit runs, then the short eligible match. The
  // overlong runs are skipped before the 20-candidate cap is applied, so the
  // version token still reaches the model and the skips force review.
  const longs = Array.from({ length: 20 }, (_, i) => `${10 + i}` + "7".repeat(2100)).join(" ");
  await withMock(() => ({ f0: pick("c0", ["c0", "none_of_them"]) }), async (client, requests) => {
    const result = await client.callTool({
      name: "jev_extract",
      arguments: {
        document: `${longs} v1.2.3`,
        fields: [{ id: "version", pattern: "[0-9][0-9.]*", description: "The release version number of the software" }],
      },
    });
    const body = payload(result);
    const field = body.results[0];
    assert.equal(field.value, "1.2.3");
    assert.equal(field.status, "review");
    assert.equal(field.reason, "candidate_limit");
    assert.equal(field.matches_skipped_too_long, 20);
    assert.equal(field.candidates_truncated, false);
    // On the wire, the only candidate sent is the short match.
    const criteria = requests[0].body.questions.f0.criteria;
    assert.deepEqual(Object.keys(criteria).sort(), ["c0", "none_of_them"]);
    assert.ok(criteria.c0.includes("1.2.3"));
  });
});

test("jev_extract turns a confident none_of_them from a truncated universe into review", async () => {
  await withMock(() => {
    const keys = Array.from({ length: 20 }, (_, i) => `c${i}`).concat("none_of_them");
    return { f0: pick("none_of_them", keys) };
  }, async (client, requests) => {
    const result = await client.callTool({ name: "jev_extract", arguments: EXTRACT_ARGS });
    const body = payload(result);
    const field = body.results[0];
    assert.equal(field.value, null);
    assert.equal(field.status, "review");
    assert.equal(field.reason, "candidate_limit");
    assert.equal(field.candidates_truncated, true);
    assert.equal(field.candidates_considered, 20);
    assert.deepEqual(
      Object.keys(requests[0].body.questions.f0.criteria).sort(),
      Array.from({ length: 20 }, (_, i) => `c${i}`).concat("none_of_them").sort(),
    );
  });
});

test("jev_extract keeps a positive pick from a truncated universe provisional, not auto", async () => {
  await withMock(() => {
    const keys = Array.from({ length: 20 }, (_, i) => `c${i}`).concat("none_of_them");
    return { f0: pick("c3", keys) };
  }, async (client) => {
    const result = await client.callTool({ name: "jev_extract", arguments: EXTRACT_ARGS });
    const body = payload(result);
    const field = body.results[0];
    assert.equal(field.value, "1.0.3");
    assert.equal(field.status, "review");
    assert.equal(field.reason, "candidate_limit");
    assert.ok(field.candidates_truncated);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// jev_decide: Choice contract enforcement with controlled answers.
// ─────────────────────────────────────────────────────────────────────────────

const DECIDE_ARGS = {
  decision: "Which database should the service use?",
  evidence: "The service is a small CRUD API with one table and no concurrent writers.",
  priorities: "Minimize operational overhead.",
  candidates: [
    { id: "postgres", description: "A full relational database server" },
    { id: "sqlite", description: "An embedded database stored in one file" },
  ],
  requirements: ["Runs without a separate server process"],
};

const REC_KEYS = ["option_0", "option_1", "ask_user", "investigate", "none"];
const CHECK_KEYS = ["supported", "contradicted", "unknown"];

test("jev_decide recommendation that is not the argmax is invalid_response", async () => {
  await withMock(() => ({
    // option_1 is chosen while option_0 holds the top probability.
    recommendation: { choice: "option_1", confidence: 0.99, probabilities: { option_0: 0.9, option_1: 0.04, ask_user: 0.02, investigate: 0.02, none: 0.02 } },
    check_0_0: pick("supported", CHECK_KEYS),
  }), async (client) => {
    const result = await client.callTool({ name: "jev_decide", arguments: DECIDE_ARGS });
    const body = payload(result);
    assert.equal(body.recommendation.status, "invalid_response");
    assert.equal(body.recommendation.selected, null);
    assert.equal(body.recommendation.probabilities, null);
  });
});

test("jev_decide requirement check that is not the argmax is invalid_response", async () => {
  await withMock(() => ({
    recommendation: pick("option_1", REC_KEYS),
    // "contradicted" is chosen while "supported" holds the top probability.
    check_0_0: { choice: "contradicted", confidence: 0.9, probabilities: { supported: 0.8, contradicted: 0.1, unknown: 0.1 } },
  }), async (client) => {
    const result = await client.callTool({ name: "jev_decide", arguments: DECIDE_ARGS });
    const body = payload(result);
    assert.equal(body.checks[0].answer, "invalid_response");
  });
});

test("jev_decide normalizes non-finite confidence to null without discarding the pick", async () => {
  await withMock(() => ({
    recommendation: { ...pick("option_1", REC_KEYS), confidence: 1.7 },
    check_0_0: pick("supported", CHECK_KEYS),
  }), async (client) => {
    const result = await client.callTool({ name: "jev_decide", arguments: DECIDE_ARGS });
    const body = payload(result);
    assert.equal(body.recommendation.selected, "sqlite");
    assert.equal(body.recommendation.confidence, null);
    assert.equal(body.checks[0].answer, "supported");
  });
});

test("jev_decide accepts a candidate id named constructor", async () => {
  await withMock(() => ({
    recommendation: pick("option_0", REC_KEYS),
  }), async (client) => {
    const result = await client.callTool({
      name: "jev_decide",
      arguments: {
        ...DECIDE_ARGS,
        candidates: [
          { id: "constructor", description: "An option whose id is an Object prototype key" },
          { id: "sqlite", description: "An embedded database stored in one file" },
        ],
      },
    });
    const body = payload(result);
    assert.equal(body.recommendation.selected, "constructor");
    assert.equal(body.recommendation.escaped, false);
  });
});
