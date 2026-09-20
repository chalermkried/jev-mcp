# Jev MCP

[![CI](https://github.com/chalermkried/jev-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chalermkried/jev-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A hosted MCP server for fast, typed judgments from TypeSafe's Jev model.

This fork turns [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp) into a stateless remote MCP service with owner-issued access control and caller-supplied Jev credentials, while preserving the same ten judgment tools and local stdio support.

- Hosted instance: [jev.surely.run](https://jev.surely.run/)
- MCP endpoint: `https://jev.surely.run/mcp`
- Health check: `https://jev.surely.run/health`
- Jev / TypeSafe: [typesafe.ai](https://typesafe.ai/)

> The hosted instance is access-controlled. You need an MCP access token from the deployment owner and your own TypeSafe Jev API key.

## What this is

Jev MCP gives an agent a small set of bounded judgment primitives instead of asking a general-purpose model to improvise every classification, verification, ranking, or decision.

The remote deployment is intentionally simple:

```text
MCP client
   │
   │ Authorization: Bearer <MCP_ACCESS_TOKEN>
   │ X-Jev-Api-Key: <YOUR_JEV_API_KEY>
   ▼
jev.surely.run/mcp
   │
   │ caller-owned Jev credential
   ▼
api.typesafe.ai
```

The proxy is stateless. It does not maintain MCP sessions, store caller Jev keys, or use a shared TypeSafe account for remote tool calls.

## Quick start

You need two credentials:

| Credential | Purpose |
| --- | --- |
| `MCP_ACCESS_TOKEN` | Authorizes access to the hosted MCP server. Issued by the deployment owner. |
| `JEV_API_KEY` | Your own TypeSafe API key. Jev usage is billed to your TypeSafe account. |

Create a Jev API key at [console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys).

Keep both values in your client's secret store or environment. Do not commit them to the repository.

### ChatGPT Desktop / Codex

ChatGPT Desktop and Codex share the Codex MCP configuration. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.jev]
enabled = true
url = "https://jev.surely.run/mcp"
bearer_token_env_var = "MCP_BEARER_TOKEN"
env_http_headers = { "X-Jev-Api-Key" = "JEV_API_KEY" }
```

Set these environment variables before starting the client:

```text
MCP_BEARER_TOKEN=<MCP access token issued by the server owner>
JEV_API_KEY=<your TypeSafe Jev API key>
```

Restart the client after changing environment variables.

### Generic MCP client

For clients that support Streamable HTTP with custom headers:

```json
{
  "mcpServers": {
    "jev": {
      "url": "https://jev.surely.run/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_ACCESS_TOKEN>",
        "X-Jev-Api-Key": "<YOUR_JEV_API_KEY>"
      }
    }
  }
}
```

Header and environment interpolation syntax differs between MCP clients. Prefer secret storage or environment variables over literal credentials in configuration files.

## Tools

The hosted and local transports expose the same ten tools.

| Tool | Purpose |
| --- | --- |
| `jev_verify` | Verify claims against supplied evidence. |
| `jev_screen` | Screen external text for prompt injection, substance, and relevance before it enters context. |
| `jev_find` | Find the best semantic match from a candidate set. |
| `jev_rerank` | Score and reorder candidates by relevance. |
| `jev_classify` | Classify many items against a shared label catalog. |
| `jev_decide` | Choose among bounded alternatives using evidence, priorities, and requirements. |
| `jev_compare` | Compare two passages for agreement, contradiction, or different facts. |
| `jev_extract` | Extract verbatim values from regex candidates, with Jev choosing the right match. |
| `jev_review` | Review a proposed change for correctness, spec match, test gap, and blast radius. |
| `jev_gate` | Review a change and verify completion claims against supplied evidence in one call. |

These tools return structured judgments such as probability distributions, confidence values, scores, and explicit review/escalation outcomes. Policy remains with the calling agent or application.

## Authentication model

Remote access uses two independent credentials.

### MCP access token

Every `/mcp` request must include:

```http
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

The deployment accepts tokens configured through either:

- `MCP_ACCESS_TOKENS` — comma-separated raw tokens
- `MCP_ACCESS_TOKEN_SHA256` — comma-separated SHA-256 token digests

Both may be used together for token rotation.

### Caller Jev key

Every tool call must include:

```http
X-Jev-Api-Key: <YOUR_JEV_API_KEY>
```

The key is not accepted as an MCP tool argument. For remote calls, the server creates a request-scoped TypeSafe client and forwards the caller's credential only to the fixed TypeSafe API origin.

Initialization and tool discovery require the MCP access token but do not require a Jev key.

## Hosted endpoints

| Method | Path | Purpose | Access |
| --- | --- | --- | --- |
| `GET` | `/` | Hosted connection guide | Public |
| `POST` | `/mcp` | MCP initialize, discovery, notifications, and tool calls | MCP bearer token; Jev key for tool calls |
| `GET` | `/health` | Returns `{"status":"ok"}` | Public |

The remote transport uses the official MCP SDK's stateless Streamable HTTP transport with JSON responses.

## Security and design

The remote service is deliberately narrow:

- no persisted MCP sessions
- no stored caller Jev credentials
- no shared remote `TYPESAFE_API_KEY`
- access is checked before MCP processing
- Jev credentials are removed before MCP request metadata is constructed
- the upstream Jev origin is fixed to `https://api.typesafe.ai`
- upstream redirects are refused
- Jev calls use a bounded timeout and no automatic retries
- request bodies are bounded
- errors returned to clients are sanitized
- raw upstream exceptions and credentials are not logged by the MCP service

`MCP_ALLOWED_ORIGINS` can optionally enforce an exact Origin allowlist. Requests without an Origin are accepted for normal non-browser MCP clients.

For vulnerability reporting and additional security notes, see [SECURITY.md](SECURITY.md).

## Self-hosting on Vercel

Requirements:

- Node.js 22+
- a Vercel project connected to this repository
- one or more high-entropy MCP access tokens

Generate a token with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Configure the deployment environment:

```text
MCP_ACCESS_TOKENS=<one or more comma-separated access tokens>

# Optional: use token hashes instead of raw tokens
MCP_ACCESS_TOKEN_SHA256=

# Optional exact Origin allowlist
MCP_ALLOWED_ORIGINS=

# Optional model override
JEV_MCP_MODEL=jev-latest
```

Do **not** configure a shared TypeSafe API key for the hosted remote service. Remote callers bring their own Jev key through `X-Jev-Api-Key`.

`vercel.json` configures the build and routes:

- `/mcp` → `api/mcp.ts`
- `/health` → `api/health.ts`
- static files → `public/`

After deployment:

```bash
curl https://<your-deployment>/health
```

Expected response:

```json
{"status":"ok"}
```

See [`.env.example`](.env.example) for the supported remote environment variables.

## Local stdio

The original local stdio transport is preserved.

To run this fork locally:

```bash
npm install
npm run build
TYPESAFE_API_KEY=ts_... node dist/index.js
```

The upstream package is also published as:

```bash
npx -y @jkudish/jev-mcp
```

For the full set of local provider options and upstream package usage, see the original [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp) project.

Remote and local credentials are intentionally separate: the hosted HTTP path uses `X-Jev-Api-Key` per request, while local stdio uses the provider environment available to the local process.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

Live API tests require a TypeSafe key:

```bash
TYPESAFE_API_KEY=ts_... npm run test:e2e
```

For local Vercel function development:

```bash
npx vercel dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [CHANGELOG.md](CHANGELOG.md) for project history.

## Upstream and credits

This repository is a fork of [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp), created by [Joey Kudish](https://github.com/jkudish).

The original MCP judgment tools and local stdio implementation come from that project. This fork adds and maintains the hosted remote MCP transport, access-control layer, Vercel deployment path, and hosted connection experience.

Jev is built by [TypeSafe](https://typesafe.ai/). This repository and hosted deployment are maintained independently and are not an official TypeSafe service.

Maintained by [Gear](https://github.com/chalermkried), with development assistance from Codex / OpenAI.

## License

[MIT](LICENSE)

The original MIT license and copyright notice remain in [LICENSE](LICENSE).
