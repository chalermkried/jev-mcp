# Contributing

Thanks for considering a contribution. This is a small server with a narrow scope: three MCP tools over TypeSafe's Jev, with question design kept in the server so every caller gets well-formed judgments.

## Development

```bash
npm install
npm run build
npm run typecheck
```

Node.js 22 or newer. TypeScript and ESM; dependencies are locked with npm. `src/tools.ts` registers the shared tools, `src/index.ts` starts stdio, and `src/remote.ts` provides the stateless HTTP handler used by Vercel's `api/` entrypoints. Keep remote credentials request-scoped and preserve the shared tool logic.

## Tests

```bash
npm test            # unit, mock stdio, and remote security/protocol tests, offline
npm run test:e2e    # live API tests, requires TYPESAFE_API_KEY
```

Build before running tests. Unit tests cover the pure helpers in `src/lib.ts`; mock tests exercise the built stdio server against a local TypeSafe stub. Remote tests use the MCP client and mocked upstream fetches to verify auth, caller-key isolation, redaction, limits, and protocol handling without spending Jev credits. CI runs the offline suites on Node.js 22 and 24. Live end-to-end tests use the TypeSafe API and run only when `TYPESAFE_API_KEY` is configured.

Both suites must pass before a pull request can merge. If you add behavior, add the test that would have caught its absence.

## Pull requests

- Keep changes small and scoped to one tool or one helper.
- New judgments belong in the tool questions and criteria, not in post-processing that second-guesses the model.
- Do not add tools without opening an issue first describing the judgment you want and why the existing three do not cover it.
- Update the README example for any tool whose arguments or results change.

## Notes

- The three tools intentionally follow TypeSafe cookbook patterns. Link the relevant cookbook when you change a question design.
- Thresholds are parameters, not constants. Keep defaults in one place and document changes.
