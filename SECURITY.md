# Security policy

## Remote fork

This fork adds a hosted proxy: tool inputs pass through the deployment operator's Vercel function before reaching TypeSafe. Remote callers supply an MCP access token and their own Jev key in headers. Keys are held only for the request and are not persisted by the application. The remote route disables SDK logging, removes credentials from MCP metadata, and replaces upstream errors with safe messages. Deployment operators must also keep external logging integrations from capturing credentials.

See the [remote setup and protection details](README.md#remote-mcp-on-vercel) for body limits, origin checks, token rotation, and the per-process concurrency ceiling. Local stdio provider configuration remains separate. The reporting contact below belongs to the upstream project; deployment-specific issues should be reported privately to the operator of that deployment.

## Reporting a vulnerability

Email **joey@jkudish.com** with "jev-mcp security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (tool, arguments, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

jev-mcp makes API calls to the TypeSafe service with the text you pass it. It does not execute browser actions, read files, or make other network calls. Treat any text you send as leaving your environment: it goes to TypeSafe, and to nowhere else.

Only the latest released version receives fixes. There is no support policy for older versions yet.
