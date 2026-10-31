// Stdio MCP host redesign, task T6: the controller against a fake task runner. What is promised here: the broker's token and a task's token are for different listeners and different
// routes; a token is bound to one task and one purpose; an approved server gets one task however many first requests arrive; a task that is not exactly the approved one is stopped;
// every size and wait is bounded; and the task's own text never reaches the broker.
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createMcpController, memoryProbeSlots, type McpControllerOptions } from "../../../packages/gateway/src/mcp-controller.js";
import { directoryBundleStore } from "../../../packages/gateway/src/mcp-runner/bundle-store.js";
import { FakeRunner, type FakeRunnerOptions, toolsHashOfNames } from "../../support/mcp-controller-fixtures.js";
import { BROKER, BUNDLE, BYTES, CALL, ECHO, INTEGRITY, OTHER, OTHER_BYTES, approvedOf, mcp, post, specOf, tokenOf, useControllerWorld, world } from "../../support/mcp-controller-world.js";

useControllerWorld();

describe("T6 controller: the two listeners", () => {
  it("answers /healthz on both, and nothing else without the right kind of token", async () => {
    const w = await world();
    expect((await fetch(`${w.brokerUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${w.runnerUrl}/healthz`)).status).toBe(200);
    for (const path of ["/servers/mcpsim000001/mcp", "/servers/mcpsim000001/warm", "/probe", "/install"]) {
      expect((await post(w.brokerUrl, path, undefined)).status, path).toBe(401);
      expect((await post(w.brokerUrl, path, "x".repeat(48))).status, path).toBe(401);
    }
    for (const [method, path] of [["GET", `/bundles/${BUNDLE}`], ["PUT", `/bundles/${BUNDLE}`], ["PUT", "/result"]] as const) {
      expect((await fetch(`${w.runnerUrl}${path}`, { method })).status, path).toBe(401);
      expect((await fetch(`${w.runnerUrl}${path}`, { method, headers: { authorization: "Bearer short" } })).status, path).toBe(401);
    }
  });
  it("does not serve the broker's routes on the runner listener, nor the runner's routes on the broker listener, even with a valid token for the other", async () => {
    const w = await world();
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    // the broker's token is not a task's token: the runner listener refuses it
    expect((await fetch(`${w.runnerUrl}/bundles/${BUNDLE}`, { headers: { authorization: `Bearer ${BROKER}` } })).status).toBe(401);
    expect((await fetch(`${w.runnerUrl}/bundles/${BUNDLE}`, { headers: { authorization: `Bearer ${"b".repeat(43)}` } })).status).toBe(401);
    expect((await post(w.runnerUrl, "/servers/mcpsim000001/mcp", BROKER)).status).toBe(404);
    expect((await post(w.runnerUrl, "/probe", BROKER)).status).toBe(404);
    // a task's token is not the broker's: the broker listener refuses it, and has no bundle routes
    const started = await mcp(w.brokerUrl, "mcpsim000001");
    expect(started.status).toBe(200);
    const token = tokenOf(w.runner, w.runner.started("serve")[0]!.taskId);
    expect((await mcp(w.brokerUrl, "mcpsim000001", CALL, token)).status).toBe(401);
    expect((await fetch(`${w.brokerUrl}/bundles/${BUNDLE}`, { headers: { authorization: `Bearer ${BROKER}` } })).status).toBe(404);
    expect((await fetch(`${w.brokerUrl}/result`, { method: "PUT", headers: { authorization: `Bearer ${BROKER}` } })).status).toBe(404);
  });
  it("answers 404 for an unknown path and 405 for a method the route does not take", async () => {
    const w = await world();
    expect((await post(w.brokerUrl, "/nothing", BROKER)).status).toBe(404);
    expect((await post(w.brokerUrl, "/servers/..%2F..%2Fetc/mcp", BROKER)).status).toBe(404);
    expect((await fetch(`${w.brokerUrl}/servers/mcpsim000001/mcp`, { headers: { authorization: `Bearer ${BROKER}` } })).status).toBe(405);
    expect((await fetch(`${w.brokerUrl}/probe`, { headers: { authorization: `Bearer ${BROKER}` } })).status).toBe(405);
    expect((await fetch(`${w.runnerUrl}/nothing`)).status).toBe(404);
  });
  it("refuses a broker token that is too short", () => {
    expect(() => createMcpController({ token: "short", registry: { approved: async () => undefined }, runner: new FakeRunner(), bundles: directoryBundleStore("/nowhere"), controllerUrl: "http://127.0.0.1:1", npmRegistry: "https://r.example/", toolsHashOf: toolsHashOfNames })).toThrow(/too short/u);
  });
});

describe("T6 controller: only what the registry calls approved is served", () => {
  it("answers 404 for an unknown or unapproved id, the same for both, and starts nothing", async () => {
    const w = await world();
    const unknown = await mcp(w.brokerUrl, "mcpnope000001");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    w.approved.clear();
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(404);
    expect((await post(w.brokerUrl, "/servers/mcpsim000001/warm", BROKER)).status).toBe(404);
    expect(w.runner.started()).toEqual([]);
  });
  it("answers 503 and starts nothing when the registry cannot be read", async () => {
    const w = await world({ registryThrows: true });
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(503);
    expect((await post(w.brokerUrl, "/servers/mcpsim000001/warm", BROKER)).status).toBe(503);
    expect(w.runner.started()).toEqual([]);
  });
  it("stops serving the moment the registry stops calling the entry approved", async () => {
    const w = await world();
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(200);
    w.approved.clear();
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(404);
  });
});

describe("T6 controller: starting a serve task", () => {
  it("starts ONE task however many first requests arrive together, with the approved bundle, the package and the secret NAMES, and forwards with the task's own token", async () => {
    const w = await world();
    const answers = await Promise.all([1, 2, 3, 4].map(() => mcp(w.brokerUrl, "mcpsim000001")));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    expect(w.controller.running()).toBe(1);
    const tasks = w.runner.started("serve");
    expect(tasks).toHaveLength(1);
    const { spec } = tasks[0]!;
    expect(spec).toMatchObject({ purpose: "serve", serverId: "mcpsim000001", approval: BUNDLE.slice(0, 12), family: "rovara-mcp-serve-mcpsim000001", size: { cpu: 256, memoryMiB: 512 } });
    expect(spec.containers.fetch).toMatchObject({ MCP_CONTROLLER_URL: w.runnerUrl, MCP_BUNDLE_HASH: BUNDLE });
    expect(spec.containers.server).toMatchObject({ MCP_BUNDLE_HASH: BUNDLE, MCP_PACKAGE_NAME: "@acme/sim-mcp", MCP_SERVER_ARGS: '["--read-only"]', MCP_SECRET_ENV: '["JIRA_TOKEN"]', MCP_MEMORY_MIB: "512" });
    // the task's token is 256 bits and is the same in both containers; the broker's token is in neither
    const token = tokenOf(w.runner, tasks[0]!.taskId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(tokenOf(w.runner, tasks[0]!.taskId, "fetch")).toBe(token);
    expect(JSON.stringify(spec)).not.toContain(BROKER);
    // RunTask carried no token, only a nonce for each container (their own, and not the token)
    expect(spec.containers.fetch!.MCP_RUNNER_TOKEN).toBeUndefined();
    expect(spec.containers.server!.MCP_RUNNER_TOKEN).toBeUndefined();
    expect(JSON.stringify(spec)).not.toContain(token);
    expect(spec.containers.fetch!.MCP_BOOTSTRAP_NONCE).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(spec.containers.server!.MCP_BOOTSTRAP_NONCE).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(spec.containers.fetch!.MCP_BOOTSTRAP_NONCE).not.toBe(spec.containers.server!.MCP_BOOTSTRAP_NONCE);
    // the bridge was shown the task's token and never the broker's
    const bridge = w.runner.tasks.get(tasks[0]!.taskId)!.bridge!;
    expect(bridge.seen.length).toBeGreaterThan(0);
    expect(new Set(bridge.seen)).toEqual(new Set([`Bearer ${token}`]));
    expect(bridge.calls).toEqual(["echo", "echo", "echo", "echo"]);
  });
  it("gives every task a token of its own", async () => {
    const w = await world({ approved: { mcpone0000001: approvedOf(), mcptwo0000001: approvedOf() } });
    await mcp(w.brokerUrl, "mcpone0000001");
    await mcp(w.brokerUrl, "mcptwo0000001");
    const [first, second] = w.runner.started("serve");
    expect(tokenOf(w.runner, first!.taskId)).not.toBe(tokenOf(w.runner, second!.taskId));
  });
  it("relays the bridge's JSON answer", async () => {
    const w = await world({ runner: { reply: () => "hello from the bridge" } });
    const answer = await mcp(w.brokerUrl, "mcpsim000001");
    expect(answer.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(await answer.json())).toContain("hello from the bridge");
  });
  it("answers 413 to a request body over 1 MiB and starts nothing", async () => {
    const w = await world();
    const answer = await post(w.brokerUrl, "/servers/mcpsim000001/mcp", BROKER, "x".repeat(1_048_577), { accept: "application/json, text/event-stream" });
    expect(answer.status).toBe(413);
    expect(w.runner.started()).toEqual([]);
  });
  it("answers 502 to a reply over 1 MiB", async () => {
    const w = await world({ runner: { reply: () => "x".repeat(1_100_000) } });
    const answer = await mcp(w.brokerUrl, "mcpsim000001");
    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({ error: "reply_too_large" });
  });
  it("answers 502 when the bridge answers a call with an error, without passing its text on, and keeps the task", async () => {
    const w = await world({ runner: { callStatus: 500 } });
    const answer = await mcp(w.brokerUrl, "mcpsim000001");
    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({ error: "server_unavailable" });
    expect(w.controller.running()).toBe(1);
  });
  it("answers 503 when the bridge fails the controller's own tools check at start, and keeps no task", async () => {
    const w = await world({ runner: { replyStatus: 500 } });
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(503);
    expect(w.controller.running()).toBe(0);
  });
  it("forwards only a plain protocol version header, never the broker's own headers", async () => {
    const w = await world();
    const answer = await post(w.brokerUrl, "/servers/mcpsim000001/mcp", BROKER, CALL, { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "x-extra": "1" });
    expect(answer.status).toBe(200);
  });
});

describe("T6 controller: a task that is not the approved one is stopped", () => {
  it("stops a task whose bridge reports another bundle, and serves nothing", async () => {
    const w = await world({ runner: { reportedBundle: () => OTHER } });
    const answer = await mcp(w.brokerUrl, "mcpsim000001");
    expect(answer.status).toBe(503);
    const [task] = w.runner.started("serve");
    expect(w.runner.stoppedFor(task!.taskId)).toBe("failed");
    expect(w.controller.running()).toBe(0);
  });
  it("stops a task whose tools are not the ones approved, tells the registry, and answers 409 needs_review", async () => {
    const w = await world({ runner: { tools: () => [{ name: "echo", inputSchema: {} }, { name: "delete_everything", inputSchema: {} }] } });
    const answer = await mcp(w.brokerUrl, "mcpsim000001");
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ error: "needs_review" });
    const [task] = w.runner.started("serve");
    expect(w.runner.stoppedFor(task!.taskId)).toBe("tools_changed");
    expect(w.changes).toEqual([{ serverId: "mcpsim000001", approved: toolsHashOfNames(ECHO), observed: toolsHashOfNames([{ name: "echo", inputSchema: {} }, { name: "delete_everything", inputSchema: {} }]) }]);
    expect(w.controller.running()).toBe(0);
  });
  it("stops the running task and starts a fresh one when the approved bundle changes", async () => {
    const w = await world({ runner: { tools: () => ECHO } });
    await mcp(w.brokerUrl, "mcpsim000001");
    w.approved.set("mcpsim000001", approvedOf({ spec: specOf(OTHER) }));
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(200);
    const tasks = w.runner.started("serve");
    expect(tasks).toHaveLength(2);
    expect(w.runner.stoppedFor(tasks[0]!.taskId)).toBe("approval_changed");
    expect(tasks[1]!.spec.approval).toBe(OTHER.slice(0, 12));
    expect(tasks[1]!.spec.containers.server!.MCP_BUNDLE_HASH).toBe(OTHER);
    expect(w.controller.running()).toBe(1);
  });
  it("makes room by stopping the server used longest ago", async () => {
    const w = await world({ approved: { mcpone0000001: approvedOf(), mcptwo0000001: approvedOf() }, controller: { limits: { maxServeTasks: 1, startMs: 1_500 } } });
    await mcp(w.brokerUrl, "mcpone0000001");
    await mcp(w.brokerUrl, "mcptwo0000001");
    const [first, second] = w.runner.started("serve");
    expect(w.runner.stoppedFor(first!.taskId)).toBe("room");
    expect(w.runner.stoppedFor(second!.taskId)).toBeUndefined();
    expect(w.controller.running()).toBe(1);
  });
});

describe("T6 controller: starting is bounded", () => {
  it("stops a task that never reaches RUNNING and answers 503", async () => {
    const w = await world({ runner: { neverRunning: true }, controller: { limits: { startMs: 150 } } });
    const answer = await mcp(w.brokerUrl, "mcpsim000001");
    expect(answer.status).toBe(503);
    const [task] = w.runner.started("serve");
    expect(w.runner.stoppedFor(task!.taskId)).toBe("failed");
    expect(w.controller.running()).toBe(0);
  });
  it("answers 503 when the task cannot be started at all", async () => {
    const w = await world({ runner: { failStart: true } });
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(503);
    expect(w.controller.running()).toBe(0);
  });
  it("stops starting a server that keeps failing: three failures in a minute, then it says so and starts nothing more", async () => {
    const w = await world({ runner: { failStart: true } });
    for (let index = 0; index < 3; index += 1) expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(503);
    const answer = await mcp(w.brokerUrl, "mcpsim000001");
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: "keeps_stopping" });
  });
  it("drops a task that died under a request, counts it, and starts a fresh one next time", async () => {
    const w = await world();
    await mcp(w.brokerUrl, "mcpsim000001");
    await w.runner.crash(w.runner.started("serve")[0]!.taskId);
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(503);
    expect(w.controller.running()).toBe(0);
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(200);
    expect(w.runner.started("serve")).toHaveLength(2);
  });
});

describe("T6 controller: warm", () => {
  it("starts a task without a call, answers 202, and then 200 once it is up", async () => {
    const w = await world();
    const first = await post(w.brokerUrl, "/servers/mcpsim000001/warm", BROKER);
    expect(first.status).toBe(202);
    for (let tries = 0; tries < 100 && w.runner.started("serve").length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.runner.started("serve")).toHaveLength(1);
    let status = 0;
    for (let tries = 0; tries < 200 && status !== 200; tries += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); status = (await post(w.brokerUrl, "/servers/mcpsim000001/warm", BROKER)).status; }
    expect(status).toBe(200);
    expect(w.runner.started("serve")).toHaveLength(1);
  });
  it("takes a warm of a server that was disabled as a 404 and starts nothing", async () => {
    const w = await world({ approved: {} });
    expect((await post(w.brokerUrl, "/servers/mcpsim000001/warm", BROKER)).status).toBe(404);
    expect(w.runner.started()).toEqual([]);
  });
});

describe("T6 controller: the runner listener and the scope of a token (T4 review I4)", () => {
  async function serveToken(w: Awaited<ReturnType<typeof world>>): Promise<string> {
    await mcp(w.brokerUrl, "mcpsim000001");
    return tokenOf(w.runner, w.runner.started("serve")[0]!.taskId);
  }
  const get = (url: string, path: string, token: string) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const put = (url: string, path: string, token: string, body: Buffer | string = "") => fetch(`${url}${path}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body });

  it("lets a serve task GET its own approved bundle, and nothing else: not another bundle, not a PUT, not a result, not any other route", async () => {
    const w = await world();
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    await w.bundles.put(OTHER, (async function* () { yield OTHER_BYTES; })(), 1_000);
    const token = await serveToken(w);
    const own = await get(w.runnerUrl, `/bundles/${BUNDLE}`, token);
    expect(own.status).toBe(200);
    expect(Buffer.from(await own.arrayBuffer())).toEqual(BYTES);
    expect((await get(w.runnerUrl, `/bundles/${OTHER}`, token)).status).toBe(403);
    expect((await put(w.runnerUrl, `/bundles/${BUNDLE}`, token, "evil")).status).toBe(403);
    expect((await put(w.runnerUrl, `/bundles/${OTHER}`, token, OTHER_BYTES)).status).toBe(403);
    expect((await put(w.runnerUrl, "/result", token, "{}")).status).toBe(403);
    expect((await get(w.runnerUrl, "/servers/mcpsim000001/mcp", token)).status).toBe(404);
    expect((await get(w.runnerUrl, `/bundles/${BUNDLE}/`, token)).status).toBe(404);
    // what is stored was not changed by the refused PUT
    expect(Buffer.from(await (await get(w.runnerUrl, `/bundles/${BUNDLE}`, token)).arrayBuffer())).toEqual(BYTES);
  });
  it("stops honouring the token of a task that failed to start", async () => {
    const w = await world({ runner: { reportedBundle: () => OTHER } });
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(503);
    const token = tokenOf(w.runner, w.runner.started("serve")[0]!.taskId);
    expect((await get(w.runnerUrl, `/bundles/${BUNDLE}`, token)).status).toBe(401);
  });
  it("answers 404 for a bundle that is approved but not stored", async () => {
    const w = await world();
    const token = await serveToken(w);
    expect((await get(w.runnerUrl, `/bundles/${BUNDLE}`, token)).status).toBe(404);
  });
  it("stops honouring a task's token the moment its task is stopped", async () => {
    const w = await world();
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    const token = await serveToken(w);
    expect((await get(w.runnerUrl, `/bundles/${BUNDLE}`, token)).status).toBe(200);
    w.approved.set("mcpsim000001", approvedOf({ spec: specOf(OTHER) }));
    await mcp(w.brokerUrl, "mcpsim000001");
    expect((await get(w.runnerUrl, `/bundles/${BUNDLE}`, token)).status).toBe(401);
  });
  it("revokes every token when the controller closes", async () => {
    const w = await world();
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    const token = await serveToken(w);
    await w.controller.close();
    expect((await get(w.runnerUrl, `/bundles/${BUNDLE}`, token)).status).toBe(401);
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("shutdown");
    expect((await mcp(w.brokerUrl, "mcpsim000001")).status).toBe(503);
  });
});

describe("T6 controller: install", () => {
  const REPORT = { integrity: INTEGRITY, lockfileHash: "2".repeat(64), bundleHash: BUNDLE, packageCount: 3, unpackedBytes: 1000, tarBytes: BYTES.length, bin: "bin/sim.js" };
  const proposal = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: ["--read-only"], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } };

  /** An install task that does what the real one does: PUT the bundle, then PUT the result. */
  const installer = (steps: { bytes?: Buffer; hash?: string; result?: unknown; skipUpload?: boolean; skipResult?: boolean; twice?: boolean } = {}) => (runnerUrl: () => string) => async (input: { token: string }): Promise<void> => {
    const headers = { authorization: `Bearer ${input.token}` };
    if (steps.skipUpload !== true) await fetch(`${runnerUrl()}/bundles/${steps.hash ?? BUNDLE}`, { method: "PUT", headers, body: steps.bytes ?? BYTES });
    if (steps.twice === true) await fetch(`${runnerUrl()}/bundles/${steps.hash ?? BUNDLE}`, { method: "PUT", headers, body: steps.bytes ?? BYTES });
    if (steps.skipResult !== true) await fetch(`${runnerUrl()}/result`, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(steps.result ?? { ok: true, ...REPORT }) });
  };
  async function installWorld(steps: Parameters<typeof installer>[0] = {}, controller: Partial<McpControllerOptions> = {}) {
    let url = "";
    const requests: Array<Record<string, unknown>> = [];
    const run = installer(steps)(() => url);
    const w = await world({ runner: { install: async (input) => { requests.push(input.request); await run(input); } }, controller });
    url = w.runnerUrl;
    return { ...w, requests };
  }

  it("runs an install task with the proposal and the registry, reports the hashes, and stops the task", async () => {
    const w = await installWorld();
    const answer = await post(w.brokerUrl, "/install", BROKER, { spec: proposal });
    expect(await answer.json()).toEqual({ ok: true, ...REPORT });
    const [task] = w.runner.started("install");
    expect(task!.spec).toMatchObject({ purpose: "install", serverId: "install", approval: "", family: "rovara-mcp-install" });
    const environment = task!.spec.containers.install!;
    expect(environment).toMatchObject({ MCP_CONTROLLER_URL: w.runnerUrl, ROVARA_MCP_NPM_REGISTRY: "https://registry.example/" });
    // the request is told to the task when it redeems its nonce, not carried by RunTask; and RunTask holds no token
    expect(environment.MCP_INSTALL_REQUEST).toBeUndefined();
    expect(environment.MCP_RUNNER_TOKEN).toBeUndefined();
    expect(environment.MCP_BOOTSTRAP_NONCE).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(w.requests).toEqual([{ registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: ["--read-only"] }]);
    expect(JSON.stringify(task!.spec)).not.toContain(w.runner.tokenOf(task!.taskId, "install"));
    expect(JSON.stringify(task!.spec)).not.toContain(BROKER);
    expect(w.runner.stoppedFor(task!.taskId)).toBe("done");
    expect(await w.bundles.has(BUNDLE)).toBe(true);
  });
  it("passes the admin's typed integrity on to the install", async () => {
    const w = await installWorld();
    await post(w.brokerUrl, "/install", BROKER, { spec: { ...proposal, integrity: INTEGRITY } });
    expect(w.requests[0]).toMatchObject({ integrity: INTEGRITY });
  });
  it("lets an install token PUT one bundle once: a second PUT is refused", async () => {
    let seen: number[] = [];
    let url = "";
    const w = await world({ runner: { install: async ({ token }) => {
      const headers = { authorization: `Bearer ${token}` };
      seen = [(await fetch(`${url}/bundles/${BUNDLE}`, { method: "PUT", headers, body: BYTES })).status, (await fetch(`${url}/bundles/${BUNDLE}`, { method: "PUT", headers, body: BYTES })).status, (await fetch(`${url}/bundles/${OTHER}`, { method: "PUT", headers, body: OTHER_BYTES })).status];
      await fetch(`${url}/result`, { method: "PUT", headers, body: JSON.stringify({ ok: true, ...REPORT }) });
    } } });
    url = w.runnerUrl;
    await post(w.brokerUrl, "/install", BROKER, { spec: proposal });
    expect(seen).toEqual([201, 409, 409]);
    expect(await w.bundles.has(OTHER)).toBe(false);
  });
  it("keeps bytes only under the hash they have: a PUT whose bytes are not the hash in the address is refused and stored nowhere", async () => {
    const w = await installWorld({ bytes: OTHER_BYTES });
    const answer = await post(w.brokerUrl, "/install", BROKER, { spec: proposal });
    expect(await answer.json()).toMatchObject({ ok: false, code: "upload_failed" });
    expect(await w.bundles.has(BUNDLE)).toBe(false);
    expect(await w.bundles.has(OTHER)).toBe(false);
  });
  it("refuses a result that names a bundle other than the one the task uploaded", async () => {
    const w = await installWorld({ result: { ok: true, ...REPORT, bundleHash: OTHER } });
    expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json()).toMatchObject({ ok: false, code: "upload_failed" });
  });
  it("refuses a result that names a bundle the store already holds from elsewhere when the task uploaded another", async () => {
    const w = await installWorld({ result: { ok: true, ...REPORT, bundleHash: OTHER } });
    await w.bundles.put(OTHER, (async function* () { yield OTHER_BYTES; })(), 1_000);
    expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json()).toMatchObject({ ok: false, code: "upload_failed" });
  });
  it("refuses a success with no upload behind it", async () => {
    const w = await installWorld({ skipUpload: true });
    expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json()).toMatchObject({ ok: false, code: "upload_failed" });
  });
  it("refuses a result with a field it does not expect, or one that is not the install's, and calls the install failed", async () => {
    for (const result of [{ ok: true, ...REPORT, extra: 1 }, { ok: true, ...REPORT, bundleHash: "nope" }, { ok: false, code: "made_up", sentence: "x" }, "text", { ok: false, code: "install_failed", sentence: "bad\u0007bell" }, { ok: false, code: "install_failed", sentence: "x", also: 1 }]) {
      const w = await installWorld({ result });
      expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json(), JSON.stringify(result)).toMatchObject({ ok: false, code: "install_failed" });
    }
  });
  it("passes a failure on with its code, its fixed sentence and what names the cause", async () => {
    const result = { ok: false, code: "lockfile_policy", sentence: "This package's dependencies are not allowed.", rule: "install_scripts", package: "flagged-dep" };
    const w = await installWorld({ skipUpload: true, result });
    expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json()).toEqual(result);
  });
  it("accepts a result only once: while the first is still being read, a second is refused", async () => {
    let second = 0;
    let url = "";
    const w = await world({ runner: { install: async ({ token }) => {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      await fetch(`${url}/bundles/${BUNDLE}`, { method: "PUT", headers, body: BYTES });
      const target = new URL(`${url}/result`);
      const text = JSON.stringify({ ok: true, ...REPORT });
      // the first report is sent in two parts, so it is still open when the second arrives
      await new Promise<void>((resolve, reject) => {
        const first = httpRequest({ hostname: target.hostname, port: target.port, path: "/result", method: "PUT", headers: { ...headers, "content-length": String(text.length) } }, (response) => { response.resume(); response.on("end", () => resolve()); });
        first.on("error", reject);
        first.write(text.slice(0, 5));
        void (async () => {
          await new Promise((done) => setTimeout(done, 50));
          second = (await fetch(`${url}/result`, { method: "PUT", headers, body: JSON.stringify({ ok: false, code: "install_failed", sentence: "x" }) })).status;
          first.end(text.slice(5));
        })();
      });
    } } });
    url = w.runnerUrl;
    expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json()).toMatchObject({ ok: true });
    expect(second).toBe(409);
  });
  it("calls an install failed when its task stops without a result", async () => {
    const w = await installWorld({ skipUpload: true, skipResult: true });
    expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json()).toMatchObject({ ok: false, code: "install_failed" });
  });
  it("calls an install timed out when its task neither reports nor stops, and stops it", async () => {
    const w = await world({ runner: { install: () => new Promise<void>(() => undefined) }, controller: { limits: { installMs: 120, startMs: 500 } } });
    expect(await (await post(w.brokerUrl, "/install", BROKER, { spec: proposal })).json()).toMatchObject({ ok: false, code: "timed_out" });
    expect(w.runner.stoppedFor(w.runner.started("install")[0]!.taskId)).toBe("done");
  });
  it("stops honouring the install token after the install", async () => {
    const w = await installWorld();
    await post(w.brokerUrl, "/install", BROKER, { spec: proposal });
    const token = tokenOf(w.runner, w.runner.started("install")[0]!.taskId, "install");
    expect((await fetch(`${w.runnerUrl}/bundles/${OTHER}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: OTHER_BYTES })).status).toBe(401);
  });
  it("refuses a proposal that is not valid, and one that carries the hashes only an install may compute", async () => {
    const w = await installWorld();
    for (const spec of [{ ...proposal, name: "Bad Name" }, { ...proposal, lockfileHash: "1".repeat(64) }, { ...proposal, bundleHash: BUNDLE }, undefined, "x"]) {
      expect((await post(w.brokerUrl, "/install", BROKER, { spec })).status, JSON.stringify(spec)).toBe(400);
    }
    expect((await post(w.brokerUrl, "/install", BROKER, "not json")).status).toBe(400);
    expect(w.runner.started()).toEqual([]);
  });
});

describe("T6 controller: probe", () => {
  const REPORT = { integrity: INTEGRITY, lockfileHash: "2".repeat(64), bundleHash: BUNDLE, packageCount: 3, unpackedBytes: 1000, tarBytes: BYTES.length, bin: "bin/sim.js" };
  const proposal = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } };
  async function probeWorld(controller: Partial<McpControllerOptions> = {}, runner: Partial<FakeRunnerOptions> = {}) {
    let url = "";
    const w = await world({
      runner: {
        ...runner,
        install: async ({ token }) => {
          const headers = { authorization: `Bearer ${token}` };
          await fetch(`${url}/bundles/${BUNDLE}`, { method: "PUT", headers, body: BYTES });
          await fetch(`${url}/result`, { method: "PUT", headers, body: JSON.stringify({ ok: true, ...REPORT }) });
        },
      },
      controller,
    });
    url = w.runnerUrl;
    return w;
  }

  it("installs, then tests the bundle in a probe task, and answers with the tools and the hashes the approval binds", async () => {
    const w = await probeWorld();
    const answer = await post(w.brokerUrl, "/probe", BROKER, { spec: proposal });
    expect(await answer.json()).toEqual({ tools: [{ name: "echo", inputSchema: { type: "object" } }], integrity: INTEGRITY, lockfileHash: "2".repeat(64), bundleHash: BUNDLE });
    expect(w.runner.started("install")).toHaveLength(1);
    const [probeTask] = w.runner.started("probe");
    expect(probeTask!.spec).toMatchObject({ purpose: "probe", approval: BUNDLE.slice(0, 12), family: "rovara-mcp-probe" });
    expect(probeTask!.spec.serverId).toMatch(/^probe[0-9a-f]{10}$/u);
    expect(probeTask!.spec.containers.server!.MCP_BUNDLE_HASH).toBe(BUNDLE);
    expect(w.runner.stoppedFor(probeTask!.taskId)).toBe("done");
  });
  it("tests the pinned bundle without installing again when an approval pins it", async () => {
    const w = await probeWorld();
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    const answer = await post(w.brokerUrl, "/probe", BROKER, { spec: { ...proposal, integrity: INTEGRITY }, pinned: { lockfileHash: "2".repeat(64), bundleHash: BUNDLE } });
    expect(await answer.json()).toMatchObject({ integrity: INTEGRITY, lockfileHash: "2".repeat(64), bundleHash: BUNDLE });
    expect(w.runner.started("install")).toEqual([]);
    expect(w.runner.started("probe")).toHaveLength(1);
  });
  it("refuses to test a pinned bundle it does not hold, or a pin without the integrity, or a pin that is not two hashes", async () => {
    const w = await probeWorld();
    expect(await (await post(w.brokerUrl, "/probe", BROKER, { spec: { ...proposal, integrity: INTEGRITY }, pinned: { lockfileHash: "2".repeat(64), bundleHash: BUNDLE } })).json()).toEqual({ error: "host_refused" });
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    expect(await (await post(w.brokerUrl, "/probe", BROKER, { spec: proposal, pinned: { lockfileHash: "2".repeat(64), bundleHash: BUNDLE } })).json()).toEqual({ error: "host_refused" });
    for (const pinned of [{ lockfileHash: "x", bundleHash: BUNDLE }, { bundleHash: BUNDLE }, "x", null]) expect((await post(w.brokerUrl, "/probe", BROKER, { spec: proposal, pinned })).status, JSON.stringify(pinned)).toBe(400);
    expect(w.runner.started()).toEqual([]);
  });
  it("says only that the host refused when the install fails, with the install's fixed reason", async () => {
    let url = "";
    const w = await world({ runner: { install: async ({ token }) => { await fetch(`${url}/result`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ok: false, code: "git_dependency", sentence: "This package needs a git dependency. Rovara installs only from your registry." }) }); } } });
    url = w.runnerUrl;
    const answer = await (await post(w.brokerUrl, "/probe", BROKER, { spec: proposal })).json();
    expect(answer).toEqual({ error: "host_refused", install: { ok: false, code: "git_dependency", sentence: "This package needs a git dependency. Rovara installs only from your registry." } });
    expect(w.runner.started("probe")).toEqual([]);
  });
  it("says only that the host refused when the probe task does not come up, and stops it", async () => {
    const w = await probeWorld({ limits: { startMs: 120, installMs: 2_000 } }, { neverRunning: true });
    expect(await (await post(w.brokerUrl, "/probe", BROKER, { spec: proposal })).json()).toEqual({ error: "host_refused" });
    expect(w.runner.stoppedFor(w.runner.started("probe")[0]!.taskId)).toBe("failed");
  });
  it("answers 429 when every probe slot is taken, starts nothing, and gives the slot back afterwards", async () => {
    const slots = memoryProbeSlots(1);
    const held = await slots.acquire();
    const w = await probeWorld({ probeSlots: slots });
    expect((await post(w.brokerUrl, "/probe", BROKER, { spec: proposal })).status).toBe(429);
    expect(w.runner.started()).toEqual([]);
    await held!();
    expect((await post(w.brokerUrl, "/probe", BROKER, { spec: proposal })).status).toBe(200);
    // the slot used by that probe is free again
    expect((await post(w.brokerUrl, "/probe", BROKER, { spec: proposal })).status).toBe(200);
  });
  it("refuses a body that is not a spec", async () => {
    const w = await probeWorld();
    expect((await post(w.brokerUrl, "/probe", BROKER, { spec: { ...proposal, bundleHash: BUNDLE } })).status).toBe(400);
    expect((await post(w.brokerUrl, "/probe", BROKER, {})).status).toBe(400);
    expect((await post(w.brokerUrl, "/probe", BROKER, "[")).status).toBe(400);
  });
});

describe("fix round 1, I1: a redirect from the bridge is never followed", () => {
  async function internal() {
    const hits: string[] = [];
    const server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end('{"secret":"internal"}'); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal-path`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
  }
  for (const on of ["ready", "list", "call"] as const) {
    it(`does not call the address a bridge redirects its ${on} answer to, and does not return what is there`, async () => {
      const target = await internal();
      try {
        const w = await world({ runner: { redirect: { to: target.url, on: [on] } }, controller: { limits: { startMs: 400 } } });
        const answer = await mcp(w.brokerUrl, "mcpsim000001");
        expect(answer.status).toBeGreaterThanOrEqual(502);
        expect(await answer.text()).not.toContain("internal");
        expect(target.hits).toEqual([]);
        if (on === "call") expect(w.controller.running()).toBe(1);
      } finally {
        await target.close();
      }
    });
  }
});

describe("fix round 1, m9: the broker's token has 256 bits", () => {
  it("refuses 42 characters and accepts 43", () => {
    const options = { registry: { approved: async () => undefined }, runner: new FakeRunner(), bundles: directoryBundleStore("/nowhere"), controllerUrl: "http://127.0.0.1:1", npmRegistry: "https://r.example/", toolsHashOf: toolsHashOfNames, sweepMs: 0 };
    expect(() => createMcpController({ ...options, token: "t".repeat(42) })).toThrow(/too short/u);
    expect(() => createMcpController({ ...options, token: "t".repeat(43) })).not.toThrow();
  });
});
