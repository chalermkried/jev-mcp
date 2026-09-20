#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { askJev } from "./provider.js";
import { registerJevTools } from "./tools.js";
import { serverInfo } from "./server-info.js";

const model = process.env.JEV_MCP_MODEL ?? "jev-latest";
const server = new McpServer(serverInfo);
registerJevTools(server, askJev, model);
await server.connect(new StdioServerTransport());
console.error(`[jev-mcp] ready — model ${model}`);
