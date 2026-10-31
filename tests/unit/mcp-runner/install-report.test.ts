// Stdio MCP host redesign, task T6: the install task tells the controller its result (PUT /result) and the controller never has to read a log.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { controllerReporter, main } from "../../../packages/broker/src/mcp-runner/install-main.js";

const TOKEN = "t".repeat(43);
const servers: Array<() => void> = [];
afterEach(() => { for (const close of servers.splice(0)) close(); });

async function controller(status = 200) {
  const received: Array<{ method: string; url: string; authorization: string; body: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { received.push({ method: req.method ?? "", url: req.url ?? "", authorization: String(req.headers.authorization), body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(status); res.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

describe("controllerReporter", () => {
  it("PUTs the result as JSON to /result with the task's token", async () => {
    const c = await controller();
    await controllerReporter({ url: `${c.url}/`, token: TOKEN }).report({ ok: false, code: "install_failed", sentence: "x" });
    expect(c.received).toEqual([{ method: "PUT", url: "/result", authorization: `Bearer ${TOKEN}`, body: JSON.stringify({ ok: false, code: "install_failed", sentence: "x" }) }]);
  });
  it("fails when the controller refuses, and refuses to send the token over plain http to another machine", async () => {
    const c = await controller(403);
    await expect(controllerReporter({ url: c.url, token: TOKEN }).report({ ok: true })).rejects.toThrow();
    expect(() => controllerReporter({ url: "http://controller.example:8443", token: TOKEN })).toThrow(/https/u);
  });
});

describe("install main: the result goes to the controller too", () => {
  it("reports a failed request to the controller as well as printing it, with a fixed sentence and no token", async () => {
    const c = await controller();
    const lines: string[] = [];
    const code = await main({ env: { MCP_RUNNER_TOKEN: TOKEN, MCP_CONTROLLER_URL: c.url, MCP_INSTALL_REQUEST: "not json", ROVARA_MCP_NPM_REGISTRY: "https://registry.example/" }, getuid: () => 10_002, getgid: () => 10_002, write: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(c.received).toHaveLength(1);
    expect(JSON.parse(c.received[0]!.body)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("invalid_request");
    expect(lines.join("")).not.toContain(TOKEN);
  });
  it("reports a missing registry the same way", async () => {
    const c = await controller();
    expect(await main({ env: { MCP_RUNNER_TOKEN: TOKEN, MCP_CONTROLLER_URL: c.url, MCP_INSTALL_REQUEST: "{}" }, getuid: () => 10_002, getgid: () => 10_002, write: () => undefined })).toBe(1);
    expect(JSON.parse(c.received[0]!.body)).toMatchObject({ ok: false, code: "invalid_request" });
  });
  it("still exits 1 and prints the failure when the controller cannot be reached", async () => {
    const lines: string[] = [];
    expect(await main({ env: { MCP_RUNNER_TOKEN: TOKEN, MCP_CONTROLLER_URL: "http://127.0.0.1:1", MCP_INSTALL_REQUEST: "not json", ROVARA_MCP_NPM_REGISTRY: "https://r.example/" }, getuid: () => 10_002, write: (line) => lines.push(line) })).toBe(1);
    expect(lines).toHaveLength(1);
  });
});
