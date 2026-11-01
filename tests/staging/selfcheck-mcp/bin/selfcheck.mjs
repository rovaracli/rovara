// A test-only stdio MCP server for the Rovara staging smoke (stdio MCP host redesign, T12). It has one tool, `selfcheck`, that reports from INSIDE a real serve task what the task can reach:
//   - the task metadata endpoint (169.254.170.2) hands out no credentials (a runner task has no task role);
//   - an address on the internet, and an address in the VPC that was not approved, time out;
//   - the approved address answers;
//   - the environment holds only the names the server was declared with.
// It has no dependencies and reports codes and names only: never a value of any variable. It does nothing unless the call says `live: true`.
import net from "node:net";
import http from "node:http";

const tcp = (host, port, timeoutMs) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (outcome) => { socket.destroy(); resolve(outcome); };
  socket.setTimeout(timeoutMs, () => done("timeout"));
  socket.once("connect", () => done("connected"));
  socket.once("error", (error) => done(error?.code === "ECONNREFUSED" ? "refused" : "error"));
});

const metadata = (timeoutMs) => new Promise((resolve) => {
  const request = http.get({ host: "169.254.170.2", port: 80, path: "/v2/credentials/00000000-0000-0000-0000-000000000000", timeout: timeoutMs }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
  request.on("timeout", () => { request.destroy(); resolve("timeout"); });
  request.on("error", () => resolve("unreachable"));
});

const target = (value) => (typeof value?.host === "string" && Number.isInteger(value?.port) ? value : undefined);

async function selfcheck(args) {
  const live = args?.live === true;
  const base = { live, plan: ["credentials", "internet", "vpc", "approved", "environment"] };
  if (!live) return base;
  const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 && args.timeoutMs <= 15_000 ? args.timeoutMs : 5_000;
  const approved = target(args.approved), vpc = target(args.vpc), internet = target(args.internet);
  return {
    ...base,
    credentials: { uriVariable: process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined, metadataStatus: await metadata(timeoutMs) },
    internet: internet === undefined ? "not-asked" : await tcp(internet.host, internet.port, timeoutMs),
    vpc: vpc === undefined ? "not-asked" : await tcp(vpc.host, vpc.port, timeoutMs),
    approved: approved === undefined ? "not-asked" : await tcp(approved.host, approved.port, timeoutMs),
    environment: Object.keys(process.env).sort(),
  };
}

const TOOL = { name: "selfcheck", description: "Reports what this task can reach", inputSchema: { type: "object", properties: { live: { type: "boolean" } } }, annotations: { readOnlyHint: true } };
const send = (message) => { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };

async function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") { send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "selfcheck", version: "1.0.0" } } }); return; }
  if (message.method === "ping") { send({ id: message.id, result: {} }); return; }
  if (message.method === "tools/list") { send({ id: message.id, result: { tools: [TOOL] } }); return; }
  if (message.method === "tools/call" && message.params?.name === "selfcheck") {
    send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(await selfcheck(message.params?.arguments)) }] } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "unknown method" } });
}

let buffer = "";
let pending = 0;
let ended = false;
const finish = () => { if (ended && pending === 0) process.exit(0); };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== "") { let parsed; try { parsed = JSON.parse(line); } catch { continue; } pending += 1; void handle(parsed).finally(() => { pending -= 1; finish(); }); }
  }
});
// The input ending is the end of the session, but an answer still being worked out is sent first.
process.stdin.on("end", () => { ended = true; finish(); });
