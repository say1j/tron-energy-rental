#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, settingsFromEnv } from "./index.js";

try {
  const server = createServer(settingsFromEnv());
  await server.connect(new StdioServerTransport());
} catch (error) {
  // stdout carries the MCP protocol; diagnostics go to stderr only.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
