import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
export const serverInfo = { name: "jev-mcp", version };
