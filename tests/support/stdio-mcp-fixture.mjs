// A tiny stdio MCP server for the MCP host tests: two read-only tools. `env_keys` reports which environment variable names the host gave it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo a word", inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] }, annotations: { readOnlyHint: true } },
    { name: "env_keys", description: "Names of the environment variables", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "echo") return { content: [{ type: "text", text: `echo:${String(request.params.arguments?.word)}` }] };
  if (request.params.name === "env_keys") return { content: [{ type: "text", text: Object.keys(process.env).sort().join(",") }], structuredContent: { key: "ENV-1", cwd: process.cwd() } };
  return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
});
await server.connect(new StdioServerTransport());
