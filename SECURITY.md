# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

https://github.com/chalermkried/jev-mcp/security/advisories/new

Do not open a public issue with exploit details, credentials, or other sensitive information. If the private report form is unavailable, contact the repository owner through GitHub first and wait for a private channel before sharing technical details.

For vulnerabilities in the upstream npm package rather than this fork's hosted remote transport, see the original [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp) project.

## Hosted remote service

This fork adds a hosted MCP proxy. Tool inputs pass through the deployment operator's Vercel function before reaching TypeSafe.

Remote callers provide two independent credentials:

- an owner-issued MCP access token in `Authorization: Bearer ...`;
- their own Jev key in `X-Jev-Api-Key`.

The application keeps both credentials request-scoped. It does not persist caller Jev keys or use a shared TypeSafe key for remote tool calls.

The remote path also:

- authenticates the MCP token before MCP processing;
- removes credential and unrelated headers before constructing MCP request metadata;
- fixes the remote Jev origin to `https://api.typesafe.ai` and refuses redirects;
- disables remote SDK logging;
- sanitizes upstream failures before returning them to callers;
- bounds request bodies, concurrency, and request duration.

See [Security and design](README.md#security-and-design) for the current architecture and deployment notes.

Deployment operators are still responsible for configuring Vercel, log drains, observability integrations, proxies, and other infrastructure so sensitive request headers and bodies are not captured.

## Scope

Security fixes for this fork target the current `main` branch and hosted deployment.

Local stdio support remains inherited from the upstream project and uses local provider credentials. Treat any text sent to Jev as data leaving your environment: model inputs are sent to the configured provider.

There is no bug bounty or guaranteed response time.
