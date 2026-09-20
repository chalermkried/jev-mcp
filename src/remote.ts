import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Fetch } from "@typesafe-ai/sdk";
import { createRemoteEvaluator } from "./remote-provider.js";
import { registerJevTools } from "./tools.js";
import { serverInfo } from "./server-info.js";

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_CONCURRENT_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 25_000;

const digest = (token: string) => createHash("sha256").update(token).digest();
const entries = (value = "") => value.split(",").map((item) => item.trim()).filter(Boolean);

function error(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

class BodyTooLarge extends Error {}

async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) throw new BodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Fetch injection is for offline verification; it is never configurable by HTTP or env. */
export function createRemoteHandler(options: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}) {
  const env = options.env ?? process.env;
  // A best-effort ceiling per warm process, not a distributed rate limiter.
  let active = 0;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return request.method === "GET"
        ? Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } })
        : error(405, -32000, "Method not allowed.", { Allow: "GET" });
    }
    if (url.pathname !== "/mcp") return error(404, -32000, "Not found.");

    const bearer = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(request.headers.get("authorization") ?? "");
    if (!bearer) return error(401, -32000, "Unauthorized.", { "WWW-Authenticate": 'Bearer realm="jev-mcp"' });
    const hashes = entries(env.MCP_ACCESS_TOKEN_SHA256);
    if (hashes.some((value) => !/^[a-f0-9]{64}$/i.test(value))) {
      return error(503, -32000, "MCP access is not configured.");
    }
    const allowed = [...entries(env.MCP_ACCESS_TOKENS).map(digest), ...hashes.map((value) => Buffer.from(value, "hex"))];
    if (allowed.length === 0) return error(503, -32000, "MCP access is not configured.");
    const presented = digest(bearer[1]);
    // Compare every fixed-length digest, including after a match.
    const valid = allowed.reduce((match, candidate) => Number(timingSafeEqual(presented, candidate)) | match, 0);
    if (!valid) return error(401, -32000, "Unauthorized.", { "WWW-Authenticate": 'Bearer realm="jev-mcp"' });

    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin && !entries(env.MCP_ALLOWED_ORIGINS).includes(origin)) {
      return error(403, -32000, "Origin is not allowed.");
    }
    if (request.method !== "POST") return error(405, -32000, "Use POST for stateless MCP.", { Allow: "POST" });
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return error(415, -32000, "Content-Type must be application/json.");
    }
    if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") {
      return error(415, -32000, "Compressed request bodies are not supported.");
    }
    if (active >= MAX_CONCURRENT_REQUESTS) return error(429, -32000, "Server is busy. Try again shortly.", { "Retry-After": "1" });

    active++;
    let server: McpServer | undefined;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    try {
      let message: unknown;
      try {
        message = await readBody(request, signal);
      } catch (cause) {
        if (cause instanceof BodyTooLarge) return error(413, -32000, "Request body exceeds 256 KiB.");
        if (signal.aborted) return error(408, -32000, "Request interrupted or timed out.");
        return error(400, -32700, "Invalid JSON.");
      }
      // One operation per request bounds work and follows current Streamable HTTP.
      if (Array.isArray(message)) return error(400, -32600, "JSON-RPC batches are not supported.");
      const isToolCall = typeof message === "object" && message !== null && "method" in message && message.method === "tools/call";
      const apiKey = request.headers.get("x-jev-api-key")?.trim();
      if (isToolCall && (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey) || apiKey.includes(","))) {
        return error(400, -32600, "Supply one X-Jev-Api-Key header for tool calls.");
      }

      server = new McpServer(serverInfo);
      const evaluator = isToolCall && apiKey
        ? createRemoteEvaluator(apiKey, signal, options.fetch)
        : async () => { throw new Error("Supply X-Jev-Api-Key for tool calls."); };
      registerJevTools(server, evaluator, env.JEV_MCP_MODEL ?? "jev-latest");
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);

      // Credentials and unrelated headers must not enter MCP request metadata.
      const headers = new Headers();
      for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const cleanRequest = new Request(new URL("/mcp", url), { method: "POST", headers, signal });
      const response = await transport.handleRequest(cleanRequest, { parsedBody: message });
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      // Never log raw exceptions: they can contain credential-bearing requests.
      return error(500, -32603, "MCP request failed.");
    } finally {
      try { await server?.close(); } catch { /* no raw error logging */ }
      active--;
    }
  };
}

export const handleRemoteRequest = createRemoteHandler();
