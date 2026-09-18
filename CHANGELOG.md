# Changelog

## Unreleased

- New `jev_decide` tool: one bounded decision over 2-6 candidates with evidence and priorities. Jev returns a Choice distribution over the candidates plus escape hatches (`ask_user`, `investigate`, `none`), and an independent supported / contradicted / unknown check per candidate per requirement, all in one request. A requirement contradicted by the recommended candidate surfaces as a warning.
- New `jev_rerank` tool: one independent relevance probability per candidate in a single request, returned sorted with scores. Candidate ids preserved verbatim; any malformed answer marks the whole ranking `invalid_response` instead of sorting a missing score as zero. TypeSafe's rerank cookbook reports that on the CLERC benchmark this pattern lifted top-1 from 5% to 18% and top-10 from 38% to 62%. Bounded at 250 candidates and a 100,000-character aggregate budget.
- New `jev_compare` tool: overall same_fact / contradicts / different_facts relation between two passages, plus optional per-aspect judgments, each an independent Choice in the same request with aspect-specific wording for the third outcome, with distributions, confidence, an argmax guard, and an auto-versus-review decision.
- New `jev_extract` tool: your regex finds candidate substrings, Jev picks which candidate is each field's value, and the value returns verbatim. Regexes run in a sandboxed worker with a 1-second deadline, so pathological patterns cannot hang the server. Complete zero-match fields are omitted from the model request (`not_found`); if no field reaches the model, no API call is made, and a confident `none_of_them` is a model-judged negative. An incomplete candidate universe (matches beyond the 20-per-field cap, or matches skipped for exceeding 2,000 characters) forces every otherwise-valid positive or `none_of_them` result to `review` (malformed answers remain `invalid_response`), with explicit flags rather than silent truncation; invalid patterns and timeouts report `invalid_pattern` without failing the call. Bounded at 32 fields and a 50,000-character aggregate budget.

## 0.4.0

- New `jev_classify` tool: assign up to 64 items to a shared catalog of up to 250 classes in one batched request (catalog sent once, one Choice per item). Per-item distribution, confidence, winner margin, and an auto-versus-review decision gated on both top probability (default 0.85) and margin (default 0.5). Caller IDs are preserved verbatim (opaque internal keys on the wire); the catalog is sent once in shared state with each item in its own question; malformed responses surface as invalid_response rather than uncertainty; batches are capped at an 8,000 item-class budget.

## 0.3.0

- Cloudflare Workers AI support: with `CLOUDFLARE_API_TOKEN` (or `JEV_CLOUDFLARE_API_TOKEN`) and `CLOUDFLARE_ACCOUNT_ID` set, judgments run through Cloudflare at the `typesafe/jev` alias; `JEV_PROVIDER=cloudflare` forces it. Usage tokens are reported on every call.
- Vercel AI Gateway support: with `AI_GATEWAY_API_KEY` set, judgments run through the AI SDK evaluate API at `typesafe-ai/jev`; `JEV_PROVIDER=vercel` forces it. Noul, choice, and score answers are adapted back to this package's shapes, with TypeSafe confidence included.
- Provider resolution order: TypeSafe direct, OpenRouter, Cloudflare, Vercel.
- Internal fix: transport branches are explicitly guarded per provider.

## 0.2.0

- OpenRouter support: with only an `OPENROUTER_API_KEY`, all judgments route through OpenRouter's Decisions API (alpha) at the same pricing; `JEV_PROVIDER` forces `typesafe` or `openrouter`. `jev-latest` maps to `typesafe/jev-1.13` there.
- Results now report the transport used (`provider`, resolved `model`).

## 0.1.0

Initial release, published to npm as `@jkudish/jev-mcp` (the unscoped `jev-mcp` name belongs to another project).

- `jev_verify`: claims versus evidence with supports / contradicts / says_nothing distributions, confidence, and an auto-versus-review gate.
- `jev_screen`: injection, substance, and relevance probabilities with an advisory pass / review / block / skip recommendation.
- `jev_find`: semantic ranking of up to 250 candidates plus an existence check, no embeddings.
- Token usage and estimated cost on every result.

No versioning policy has been declared yet; treat 0.x APIs as unstable.
