import { APIError, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import type { askJev } from "./provider.js";

/** A request-owned client: never consult the local provider or credential environment. */
export function createRemoteEvaluator(apiKey: string, signal: AbortSignal, fetchImpl?: Fetch): typeof askJev {
  const client = new TypeSafeClient({
    apiKey,
    baseURL: "https://api.typesafe.ai",
    logLevel: "off",
    retry: { maxRetries: 0 },
    timeout: 15_000,
    // Forbid redirects so the caller's key can only be sent to the fixed API origin.
    fetch: (input, init) => (fetchImpl ?? globalThis.fetch)(input, { ...init, redirect: "error" }),
  });

  return async (state, questions, model) => {
    try {
      const response = await client.systemOne({ state, questions, model } as Parameters<typeof client.systemOne>[0], { signal });
      return {
        answers: response.answers,
        usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
        provider: "typesafe",
        model,
      };
    } catch (error) {
      // SDK errors may contain upstream bodies, headers, or request details. Never
      // log, attach as a cause, or return them through an MCP tool result.
      if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
        throw new Error("Jev rejected the supplied API key.");
      }
      if (error instanceof APIError && error.status === 429) {
        throw new Error("Jev rate limit reached. Try again later.");
      }
      throw new Error("Jev request failed. Check your key or try again later.");
    }
  };
}
