import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createRemoteHandler, MAX_BODY_BYTES, MAX_CONCURRENT_REQUESTS } from "../dist/remote.js";

const TOKEN = "test-mcp-access-token";
const KEY = "test-caller-jev-key";
const env = { MCP_ACCESS_TOKENS: TOKEN };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
} };
const verify = { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
  name: "jev_verify", arguments: { claims: ["The sky is blue."], evidence: "The sky is blue." },
} };

function request(body = initialize, headers = {}, extra = {}) {
  return new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...extra,
  });
}

function fixture(options = {}) {
  const calls = [];
  const handler = createRemoteHandler({ env, fetch: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const answers = Object.fromEntries(Object.keys(calls.at(-1).body.questions).map((id) => [id, {
      type: "choice", choice: "supports", confidence: 0.99,
      probabilities: { supports: 0.99, contradicts: 0.005, says_nothing: 0.005 },
    }]));
    return Response.json({ answers, usage: { input_tokens: 10, output_tokens: 5 } });
  }, ...options });
  return { handler, calls };
}

test("health is public, keyless, and never calls Jev", async () => {
  const { handler, calls } = fixture({ env: {} });
  const response = await handler(new Request("https://mcp.example/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(calls.length, 0);
  assert.equal((await handler(new Request("https://mcp.example/unknown"))).status, 404);
  assert.equal((await handler(new Request("https://mcp.example/health", { method: "POST" }))).status, 405);
});

test("missing, malformed, duplicate, and invalid MCP tokens cannot reach Jev", async () => {
  const { handler, calls } = fixture();
  for (const authorization of ["", "Basic abc", "Bearer wrong", `Bearer ${TOKEN}, Bearer ${TOKEN}`, "Bearer", "Bearer two tokens"]) {
    const response = await handler(request(verify, { Authorization: authorization, "X-Jev-Api-Key": KEY }));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /^Bearer/);
    assert.doesNotMatch(await response.text(), new RegExp(KEY));
  }
  const unauthenticated = new Request("https://mcp.example/mcp", { method: "GET" });
  assert.equal((await handler(unauthenticated)).status, 401);
  assert.equal(calls.length, 0);
});

test("token rotation accepts raw allowlists and SHA-256 digests, and fails closed on bad config", async () => {
  const hash = createHash("sha256").update(TOKEN).digest("hex");
  for (const configured of [{ MCP_ACCESS_TOKENS: `other, ${TOKEN}` }, { MCP_ACCESS_TOKEN_SHA256: hash.toUpperCase() }]) {
    const { handler } = fixture({ env: configured });
    assert.equal((await handler(request())).status, 200);
  }
  for (const configured of [{}, { MCP_ACCESS_TOKENS: " , " }, { MCP_ACCESS_TOKENS: TOKEN, MCP_ACCESS_TOKEN_SHA256: "bad-hash" }]) {
    const { handler, calls } = fixture({ env: configured });
    assert.equal((await handler(request(verify, { "X-Jev-Api-Key": KEY }))).status, 503);
    assert.equal(calls.length, 0);
  }
});

test("initialize and tool discovery are keyless; every tool call requires BYOK", async () => {
  const { handler, calls } = fixture();
  const init = await handler(request());
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("mcp-session-id"), null);
  const discovered = await handler(request({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  const tools = (await discovered.json()).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["jev_verify", "jev_screen", "jev_find", "jev_rerank", "jev_classify", "jev_decide", "jev_compare", "jev_extract", "jev_review", "jev_gate"].sort());
  assert.doesNotMatch(JSON.stringify(tools), /api_key|apiKey|X-Jev-Api-Key/);
  for (const key of ["", " ", "first,second", "has spaces"]) {
    const response = await handler(request(verify, { "X-Jev-Api-Key": key }));
    assert.equal(response.status, 400);
  }
  const argumentKey = structuredClone(verify);
  argumentKey.params.arguments.api_key = KEY;
  assert.equal((await handler(request(argumentKey))).status, 400);
  // Even a tool that can complete without a Jev call requires the header.
  const extract = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "jev_extract", arguments: { document: "abc", fields: [{ id: "v", pattern: "[0-9]+", description: "version" }] } } };
  assert.equal((await handler(request(extract))).status, 400);
  assert.equal(calls.length, 0);
});

test("SDK client completes handshake, notification, discovery, and tool invocation", async () => {
  const { handler, calls } = fixture();
  const client = new Client({ name: "remote-integration", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, "X-Jev-Api-Key": KEY } },
    fetch: (input, init) => handler(new Request(input, init)),
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 10);
    const result = await client.callTool(verify.params);
    assert.ok(!result.isError, JSON.stringify(result));
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.provider, "typesafe");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${KEY}`);
    assert.equal(calls[0].init.redirect, "error");
    assert.doesNotMatch(calls[0].init.body, new RegExp(`${TOKEN}|${KEY}`));
  } finally {
    await client.close();
  }
});

test("remote jev_extract executes regex worker and returns a picked value", async () => {
  const calls = [];
  const handler = createRemoteHandler({
    env,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      assert.deepEqual(Object.keys(body.questions.f0.criteria).sort(), ["c0", "none_of_them"]);
      return Response.json({
        answers: {
          f0: {
            type: "choice",
            choice: "c0",
            confidence: 0.99,
            probabilities: { c0: 0.99, none_of_them: 0.01 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });
  const client = new Client({ name: "remote-extract-regression", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, "X-Jev-Api-Key": KEY } },
    fetch: (input, init) => handler(new Request(input, init)),
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "jev_extract",
      arguments: {
        document: "Alice from Acme starts on 15 October 2026.",
        fields: [{
          id: "name",
          pattern: "Alice|Bob",
          description: "The person's name",
        }],
      },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.tool, "jev_extract");
    assert.equal(payload.results[0].value, "Alice");
    assert.equal(payload.results[0].status, "auto");
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
  }
});

test("overlapping requests use their own key and ignore all local provider environment", async () => {
  const overrides = { TYPESAFE_API_KEY: "shared-key-must-not-be-used", TYPESAFE_BASE_URL: "https://wrong.example", JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-unwanted", TYPESAFE_LOG_LEVEL: "debug" };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const calls = [];
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const handler = createRemoteHandler({ env: { ...env, ...overrides }, fetch: async (url, init) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization") });
      if (calls.length === 2) release();
      await barrier;
      return Response.json({ answers: {} });
    } });
    const results = await Promise.all([handler(request(verify, { "X-Jev-Api-Key": "caller-one" })), handler(request(verify, { "X-Jev-Api-Key": "caller-two" }))]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    assert.deepEqual(calls.map((call) => call.auth).sort(), ["Bearer caller-one", "Bearer caller-two"]);
    assert.ok(calls.every((call) => call.url.startsWith("https://api.typesafe.ai/")));
    assert.equal((await handler(request(verify))).status, 400);
    assert.equal(calls.length, 2);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("upstream failures redact secrets from tool errors and emit no logs or retries", async (t) => {
  const logged = [];
  for (const method of ["log", "error", "warn", "info", "debug"]) t.mock.method(console, method, (...args) => logged.push(args));
  for (const status of [401, 403, 429, 500]) {
    let count = 0;
    const { handler } = fixture({ fetch: async () => {
      count++;
      return Response.json({ error: { message: `Authorization: Bearer ${TOKEN}; X-Jev-Api-Key: ${KEY}` } }, { status });
    } });
    const response = await handler(request(verify, { "X-Jev-Api-Key": KEY }));
    const body = await response.json();
    assert.equal(body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(`${TOKEN}|${KEY}|Authorization|X-Jev-Api-Key`));
    assert.equal(count, 1);
  }
  const { handler } = fixture({ fetch: async () => { throw new Error(`secret ${KEY}`); } });
  const body = await (await handler(request(verify, { "X-Jev-Api-Key": KEY }))).text();
  assert.doesNotMatch(body, new RegExp(KEY));
  assert.deepEqual(logged, []);
});

test("oversized declared, actual, UTF-8, and chunked bodies are rejected before Jev", async () => {
  const { handler, calls } = fixture();
  const headers = { "X-Jev-Api-Key": KEY };
  assert.equal((await handler(request(verify, { ...headers, "Content-Length": `${MAX_BODY_BYTES + 1}` }))).status, 413);
  assert.equal((await handler(request(" ".repeat(MAX_BODY_BYTES + 1), { ...headers, "Content-Length": "1" }))).status, 413);
  const unicode = JSON.stringify({ ...verify, padding: "é".repeat(MAX_BODY_BYTES / 2) });
  assert.equal((await handler(request(unicode, headers))).status, 413);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; },
  });
  assert.equal((await handler(request(null, headers, { body: stream, duplex: "half" }))).status, 413);
  assert.equal(cancelled, true);
  const base = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const exact = base + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(base));
  assert.equal((await handler(request(exact))).status, 200);
  assert.equal(calls.length, 0);
});

test("malformed JSON, batches, encodings, origins, and protocol headers fail safely", async () => {
  const { handler, calls } = fixture();
  for (const [body, headers, status] of [
    ["{", {}, 400], [null, {}, 400], [[verify, verify], { "X-Jev-Api-Key": KEY }, 400],
    [initialize, { "Content-Type": "text/plain" }, 415],
    [initialize, { "Content-Encoding": "gzip" }, 415],
    [initialize, { Accept: "text/html" }, 406],
    [initialize, { Origin: "https://untrusted.example" }, 403],
    [{ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "invalid" }, 400],
  ]) {
    assert.equal((await handler(request(body, headers))).status, status);
  }
  assert.equal((await handler(request(initialize, { Origin: "https://mcp.example" }))).status, 200);
  const { handler: allowed } = fixture({ env: { ...env, MCP_ALLOWED_ORIGINS: "https://approved.example" } });
  assert.equal((await allowed(request(initialize, { Origin: "https://approved.example" }))).status, 200);
  assert.equal(calls.length, 0);
});

test("notifications return 202 and unsupported HTTP methods return 405 without sessions", async () => {
  const { handler, calls } = fixture();
  const notification = await handler(request({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
    const response = await handler(new Request("https://mcp.example/mcp", { method, headers: { Authorization: `Bearer ${TOKEN}` } }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
  assert.equal(calls.length, 0);
});

test("local concurrency ceiling rejects excess work and releases capacity", async () => {
  const { handler, calls } = fixture();
  const controllers = [];
  const pending = Array.from({ length: MAX_CONCURRENT_REQUESTS }, () => {
    const body = new ReadableStream({ start(controller) { controllers.push(controller); } });
    return handler(request(null, {}, { body, duplex: "half" }));
  });
  const busy = await handler(request(verify, { "X-Jev-Api-Key": KEY }));
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "1");
  assert.equal(calls.length, 0);
  for (const controller of controllers) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(initialize)));
    controller.close();
  }
  assert.ok((await Promise.all(pending)).every((response) => response.status === 200));
  assert.equal((await handler(request())).status, 200);
});

test("aborted request bodies return promptly and release capacity", async () => {
  const { handler } = fixture();
  const abort = new AbortController();
  const pending = handler(request(null, {}, { body: new ReadableStream(), duplex: "half", signal: abort.signal }));
  abort.abort();
  assert.equal((await pending).status, 408);
  assert.equal((await handler(request())).status, 200);
});

test("credentials and query strings are removed before entering MCP metadata", async (t) => {
  const { handler } = fixture();
  const original = WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
  let inspected = false;
  t.mock.method(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest", function (incoming, options) {
    inspected = true;
    assert.equal(incoming.headers.get("authorization"), null);
    assert.equal(incoming.headers.get("x-jev-api-key"), null);
    assert.equal(incoming.headers.get("x-extra-secret"), null);
    assert.equal(new URL(incoming.url).search, "");
    assert.equal(incoming.headers.get("mcp-protocol-version"), "2025-11-25");
    return original.call(this, incoming, options);
  });
  const incoming = new Request(`https://mcp.example/mcp?token=${TOKEN}`, request(verify, {
    "X-Jev-Api-Key": KEY, "X-Extra-Secret": "private", "MCP-Protocol-Version": "2025-11-25",
  }));
  assert.equal((await handler(incoming)).status, 200);
  assert.equal(inspected, true);
});

test("client cancellation aborts an in-flight Jev call and frees the request", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let upstreamSignal;
  const { handler } = fixture({ fetch: async (_url, init) => {
    upstreamSignal = init.signal;
    started();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  } });
  const controller = new AbortController();
  const pending = handler(request(verify, { "X-Jev-Api-Key": KEY }, { signal: controller.signal }));
  await ready;
  controller.abort();
  const result = await (await pending).json();
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(result.result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
  assert.equal((await handler(request())).status, 200);
});
