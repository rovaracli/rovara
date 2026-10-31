// Stdio MCP host redesign, fix round 1 (I4): the task side of the bootstrap: redeem a nonce once for the token, retry only "not yet", and never leave the nonce in the environment.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BootstrapError, bootstrapEnvironment, redeemBootstrap } from "../../../packages/gateway/src/mcp-runner/bootstrap.js";
import { main as fetchMain } from "../../../packages/broker/src/mcp-runner/fetch-main.js";
import { main as installMain } from "../../../packages/broker/src/mcp-runner/install-main.js";
import { start as startServe } from "../../../packages/broker/src/mcp-runner/serve-main.js";

const NONCE = "n".repeat(43);
const TOKEN = "t".repeat(43);
const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) { server.close(); server.closeAllConnections(); } });

async function controller(answers: Array<{ status: number; body?: unknown }>) {
  const seen: Array<{ method: string; url: string; body: string; type: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), type: String(req.headers["content-type"]) });
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen };
}
const fast = { delayMs: 5 };

describe("redeemBootstrap", () => {
  it("posts the nonce to /bootstrap and returns the token, and the request when there is one", async () => {
    const c = await controller([{ status: 200, body: { token: TOKEN, request: '{"name":"x"}' } }]);
    expect(await redeemBootstrap(NONCE, { controllerUrl: c.url, ...fast })).toEqual({ token: TOKEN, request: '{"name":"x"}' });
    expect(c.seen).toEqual([{ method: "POST", url: "/bootstrap", body: JSON.stringify({ nonce: NONCE }), type: "application/json" }]);
    expect(await redeemBootstrap(NONCE, { controllerUrl: (await controller([{ status: 200, body: { token: TOKEN } }])).url, ...fast })).toEqual({ token: TOKEN });
  });
  it("tries again when the controller says not yet, and stops at once on any other answer", async () => {
    const waiting = await controller([{ status: 409 }, { status: 409 }, { status: 200, body: { token: TOKEN } }]);
    expect((await redeemBootstrap(NONCE, { controllerUrl: waiting.url, ...fast })).token).toBe(TOKEN);
    expect(waiting.seen).toHaveLength(3);
    for (const status of [401, 403, 400, 500, 404]) {
      const refusing = await controller([{ status }, { status: 200, body: { token: TOKEN } }]);
      await expect(redeemBootstrap(NONCE, { controllerUrl: refusing.url, ...fast }), String(status)).rejects.toMatchObject({ code: "refused" });
      expect(refusing.seen, String(status)).toHaveLength(1);
    }
  });
  it("gives up after its tries: 'refused' if the controller kept saying not yet, 'unavailable' if it could not be reached", async () => {
    const waiting = await controller([{ status: 409 }]);
    await expect(redeemBootstrap(NONCE, { controllerUrl: waiting.url, attempts: 3, ...fast })).rejects.toMatchObject({ code: "refused" });
    expect(waiting.seen).toHaveLength(3);
    await expect(redeemBootstrap(NONCE, { controllerUrl: "http://127.0.0.1:1/", attempts: 2, ...fast })).rejects.toMatchObject({ code: "unavailable" });
  });
  it("refuses an answer that is not a token, or a request that is too long, and a nonce that is not one", async () => {
    for (const body of [{ token: "short" }, { token: 5 }, {}, { token: TOKEN, request: 5 }, { token: TOKEN, request: "x".repeat(2_049) }]) {
      const c = await controller([{ status: 200, body }]);
      await expect(redeemBootstrap(NONCE, { controllerUrl: c.url, ...fast }), JSON.stringify(body)).rejects.toBeInstanceOf(BootstrapError);
    }
    for (const nonce of ["", "short", "n".repeat(42), "n".repeat(44), `${"n".repeat(42)}!`]) await expect(redeemBootstrap(nonce, { controllerUrl: "http://127.0.0.1:1/", ...fast }), nonce).rejects.toMatchObject({ code: "bad_request" });
  });
  it("sends the nonce only over https, or to this machine's own loopback", async () => {
    for (const controllerUrl of ["http://controller.example:8443", "ftp://x", "not a url", "", "https://user:pass@controller.example"]) {
      await expect(redeemBootstrap(NONCE, { controllerUrl, ...fast }), controllerUrl).rejects.toMatchObject({ code: "bad_request" });
    }
  });
});

describe("bootstrapEnvironment", () => {
  it("replaces the nonce in an environment with the token (and the request), and leaves no nonce", async () => {
    const c = await controller([{ status: 200, body: { token: TOKEN, request: '{"a":1}' } }]);
    const env: Record<string, string | undefined> = { MCP_BOOTSTRAP_NONCE: NONCE, MCP_CONTROLLER_URL: c.url };
    await bootstrapEnvironment(env, fast);
    expect(env).toEqual({ MCP_CONTROLLER_URL: c.url, MCP_RUNNER_TOKEN: TOKEN, MCP_INSTALL_REQUEST: '{"a":1}' });
  });
  it("leaves no nonce even when the exchange fails, and does nothing when there is no nonce", async () => {
    const env: Record<string, string | undefined> = { MCP_BOOTSTRAP_NONCE: NONCE, MCP_CONTROLLER_URL: (await controller([{ status: 401 }])).url };
    await expect(bootstrapEnvironment(env, fast)).rejects.toBeInstanceOf(BootstrapError);
    expect(env.MCP_BOOTSTRAP_NONCE).toBeUndefined();
    expect(env.MCP_RUNNER_TOKEN).toBeUndefined();
    const plain: Record<string, string | undefined> = { MCP_RUNNER_TOKEN: TOKEN };
    await bootstrapEnvironment(plain, fast);
    expect(plain).toEqual({ MCP_RUNNER_TOKEN: TOKEN });
  });
  it("uses the CA the task was given", async () => {
    const env: Record<string, string | undefined> = { MCP_BOOTSTRAP_NONCE: NONCE, MCP_CONTROLLER_URL: "https://127.0.0.1:1/", ROVARA_MCP_CONTROLLER_CA: "not a certificate" };
    await expect(bootstrapEnvironment(env, { attempts: 1, ...fast })).rejects.toBeInstanceOf(BootstrapError);
  });
});

describe("the three programs redeem first", () => {
  it("fetch: exits 1 with a fixed code when the nonce is refused, and prints neither nonce nor token", async () => {
    const c = await controller([{ status: 401 }]);
    const lines: string[] = [];
    expect(await fetchMain({ env: { MCP_BOOTSTRAP_NONCE: NONCE, MCP_CONTROLLER_URL: c.url, MCP_BUNDLE_HASH: "a".repeat(64) }, getuid: () => 10_002, getgid: () => 10_002, write: (line) => lines.push(line), bootstrap: fast })).toBe(1);
    expect(lines).toEqual([JSON.stringify({ component: "mcp-fetch", ok: false, code: "bootstrap_refused" })]);
    expect(lines.join("")).not.toContain(NONCE);
  });
  it("serve: starts nothing and listens on nothing when the nonce is refused", async () => {
    const c = await controller([{ status: 401 }]);
    const env: Record<string, string | undefined> = { MCP_BOOTSTRAP_NONCE: NONCE, MCP_CONTROLLER_URL: c.url, MCP_BUNDLE_HASH: "a".repeat(64), MCP_PACKAGE_NAME: "@acme/sim-mcp", MCP_MEMORY_MIB: "512", PORT: "18099" };
    await expect(startServe({ env, getuid: () => 10_003, getgid: () => 10_003, bootstrap: fast })).rejects.toMatchObject({ code: "refused" });
    await expect(fetch("http://127.0.0.1:18099/healthz")).rejects.toThrow();
  });
  it("install: prints a fixed failure and exits 1 when the nonce is refused", async () => {
    const c = await controller([{ status: 401 }]);
    const lines: string[] = [];
    expect(await installMain({ env: { MCP_BOOTSTRAP_NONCE: NONCE, MCP_CONTROLLER_URL: c.url, ROVARA_MCP_NPM_REGISTRY: "https://r.example/" }, getuid: () => 10_002, getgid: () => 10_002, write: (line) => lines.push(line), bootstrap: fast })).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("invalid_request");
    expect(lines.join("")).not.toContain(NONCE);
  });
});
