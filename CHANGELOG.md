# Changelog

## Unreleased

- New `jev_classify` tool: assign up to 64 items to a shared catalog of up to 250 classes in one batched request (catalog sent once, one Choice per item). Per-item distribution, confidence, winner margin, and an auto-versus-review decision gated on both top probability (default 0.85) and margin (default 0.5).

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
