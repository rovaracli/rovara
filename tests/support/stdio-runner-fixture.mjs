// A stdio MCP server for the runner tests (bridge, fetch, serve). Its tools report what the bridge gave it, or misbehave on purpose: a big reply, a slow call, noise on stderr,
// a crash. It is started by `node` from a stub program inside a test bundle.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tool = (name, description, properties = {}) => ({ name, description, inputSchema: { type: "object", properties }, annotations: { readOnlyHint: true } });
const server = new Server({ name: "runner-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    tool("echo", "Echo a word", { word: { type: "string" } }), tool("env_keys", "Names of the environment variables"), tool("env_get", "One variable's value", { name: { type: "string" } }),
    tool("who", "uid, pid, cwd and arguments"), tool("big", "A reply of n bytes", { n: { type: "number" } }), tool("slow", "Sleeps ms", { ms: { type: "number" } }),
    tool("noise", "Writes n bytes to stderr", { n: { type: "number" } }), tool("crash", "Exits at once"),
  ],
}));
const text = (value) => ({ content: [{ type: "text", text: value }] });
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "echo": return text(`echo:${String(args.word)}`);
    case "env_keys": return text(Object.keys(process.env).sort().join(","));
    case "env_get": return text(String(process.env[String(args.name)] ?? "<unset>"));
    case "who": return text(JSON.stringify({ uid: process.getuid?.(), pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) }));
    case "big": return text("x".repeat(Number(args.n)));
    case "slow": await new Promise((resolve) => setTimeout(resolve, Number(args.ms))); return text("done");
    case "noise": process.stderr.write("e".repeat(Number(args.n))); return text("noisy");
    case "crash": setTimeout(() => process.exit(3), 10); return text("bye");
    default: return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
  }
});
await server.connect(new StdioServerTransport());
