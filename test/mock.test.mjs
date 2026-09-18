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
