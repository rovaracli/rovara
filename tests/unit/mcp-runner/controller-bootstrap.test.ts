// Stdio MCP host redesign, fix round 1 (I4): RunTask carries only a one-time nonce per container. The task redeems it once over the runner listener, from its own address, for the real
// token. A nonce read from DescribeTasks or CloudTrail is worth nothing: it is spent, it expires, and it only works from the address of the task it was issued to.
import { describe, expect, it } from "vitest";
import { BROKER, mcp, useControllerWorld, world } from "../../support/mcp-controller-world.js";
import type { FakeRunnerOptions } from "../../support/mcp-controller-fixtures.js";
import type { McpControllerOptions } from "../../../packages/gateway/src/mcp-controller.js";

useControllerWorld();

const redeem = (url: string, body: unknown, method = "POST") => fetch(`${url}/bootstrap`, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const clock = { offset: 0 };
const now = (): number => Date.now() + clock.offset;

/** A serve task whose containers have not redeemed yet (the fake does not boot it), so the test holds its nonces, as someone reading DescribeTasks would. */
async function held(runner: FakeRunnerOptions = {}, controller: Partial<McpControllerOptions> = {}) {
  clock.offset = 0;
  const w = await world({ runner: { neverRunning: true, ...runner }, controller: { now, limits: { startMs: 5_000 }, ...controller } });
  const request = mcp(w.brokerUrl, "mcpsim000001").catch(() => undefined);
  for (let tries = 0; tries < 200 && w.runner.started("serve").length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const task = w.runner.started("serve")[0]!;
  return { ...w, task, fetchNonce: task.spec.containers.fetch!.MCP_BOOTSTRAP_NONCE!, serverNonce: task.spec.containers.server!.MCP_BOOTSTRAP_NONCE!, request };
}

describe("fix round 1, I4: the bootstrap", () => {
  it("gives the token to the task's own address, once, and the same token to both of its containers", async () => {
    const w = await held();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = await redeem(w.runnerUrl, { nonce: w.fetchNonce });
    expect(first.status).toBe(200);
    const body = await first.json() as { token: string; request?: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body.request).toBeUndefined();
    const second = await redeem(w.runnerUrl, { nonce: w.serverNonce });
    expect((await second.json() as { token: string }).token).toBe(body.token);
    // the token works for what it is for
    expect((await fetch(`${w.runnerUrl}/bundles/${"0".repeat(64)}`, { headers: { authorization: `Bearer ${body.token}` } })).status).toBe(403);
  });
  it("does not accept a nonce from any other address, and does not spend it for the one who tried", async () => {
    const w = await held({ taskAddress: "10.9.9.9" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let round = 0; round < 3; round += 1) expect((await redeem(w.runnerUrl, { nonce: w.fetchNonce })).status).toBe(403);
    expect(w.runner.stops).toEqual([]);
  });
  it("tells the container to try again until it knows the task and its address", async () => {
    const early = await held({ startDelayMs: 400 });
    expect((await redeem(early.runnerUrl, { nonce: early.fetchNonce })).status).toBe(409);
    const noAddress = await held({ taskAddress: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await redeem(noAddress.runnerUrl, { nonce: noAddress.fetchNonce })).status).toBe(409);
  });
  it("stops the task and revokes its token when a nonce that was spent is presented again from the task's own address", async () => {
    const w = await held();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const token = (await (await redeem(w.runnerUrl, { nonce: w.fetchNonce })).json() as { token: string }).token;
    expect((await redeem(w.runnerUrl, { nonce: w.fetchNonce })).status).toBe(401);
    expect(w.runner.stoppedFor(w.task.taskId)).toBe("failed");
    expect((await fetch(`${w.runnerUrl}/bundles/${"0".repeat(64)}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    // and the other container's nonce is worth nothing now
    expect((await redeem(w.runnerUrl, { nonce: w.serverNonce })).status).toBe(401);
  });
  it("lets a nonce run out", async () => {
    const w = await held();
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock.offset = 3 * 60_000 + 1;
    expect((await redeem(w.runnerUrl, { nonce: w.fetchNonce })).status).toBe(401);
  });
  it("lets the lifetime of a nonce be set", async () => {
    const w = await held({}, { limits: { startMs: 5_000, nonceMs: 1_000 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock.offset = 1_001;
    expect((await redeem(w.runnerUrl, { nonce: w.fetchNonce })).status).toBe(401);
  });
  it("answers 401 to anything that is not a nonce of a task that is still wanted: another string, a token, the broker's token, a number, nothing", async () => {
    const w = await held();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const nonce of ["x".repeat(43), "short", BROKER, 5, null, undefined, "A".repeat(44)]) expect((await redeem(w.runnerUrl, { nonce })).status, String(nonce)).toBe(401);
    expect((await redeem(w.runnerUrl, {})).status).toBe(401);
    expect((await redeem(w.runnerUrl, "not json")).status).toBe(400);
    expect((await redeem(w.runnerUrl, { nonce: w.fetchNonce, pad: "x".repeat(2_000) })).status).toBe(400);
    expect((await redeem(w.runnerUrl, {}, "GET")).status).toBe(405);
  });
  it("is not a token: a nonce used as a bearer opens nothing", async () => {
    const w = await held();
    expect((await fetch(`${w.runnerUrl}/bundles/${"0".repeat(64)}`, { headers: { authorization: `Bearer ${w.fetchNonce}` } })).status).toBe(401);
    expect((await mcp(w.brokerUrl, "mcpsim000001", undefined, w.fetchNonce)).status).toBe(401);
  });
  it("refuses a nonce once the task has stopped or the controller is closed, and has no such route on the broker's listener", async () => {
    const w = await held();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const wrongListener = await redeem(w.brokerUrl, { nonce: w.fetchNonce });
    expect(wrongListener.status).toBe(401);
    expect(await wrongListener.text()).not.toContain("token");
    await w.runner.stop(w.task.taskId, "failed");
    expect((await redeem(w.runnerUrl, { nonce: w.fetchNonce })).status).toBe(401);
    const other = await held();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await other.controller.close();
    expect((await redeem(other.runnerUrl, { nonce: other.fetchNonce })).status).toBe(401);
  });
  it("revokes the nonces with the grant: a task that failed to start leaves none that work", async () => {
    const w = await held({}, { limits: { startMs: 100 } });
    await w.request;
    expect((await redeem(w.runnerUrl, { nonce: w.fetchNonce })).status).toBe(401);
  });
  it("hands an install task its request with its token, and a different nonce to each task", async () => {
    let url = "";
    const seen: Array<Record<string, unknown>> = [];
    const w = await world({ runner: { install: async ({ request, token }) => { seen.push(request); await fetch(`${url}/result`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ok: false, code: "install_failed", sentence: "x" }) }); } } });
    url = w.runnerUrl;
    const proposal = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } };
    await fetch(`${w.brokerUrl}/install`, { method: "POST", headers: { authorization: `Bearer ${BROKER}`, "content-type": "application/json" }, body: JSON.stringify({ spec: proposal }) });
    await fetch(`${w.brokerUrl}/install`, { method: "POST", headers: { authorization: `Bearer ${BROKER}`, "content-type": "application/json" }, body: JSON.stringify({ spec: proposal }) });
    expect(seen).toEqual([{ registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [] }, { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [] }]);
    const nonces = w.runner.started("install").map((task) => task.spec.containers.install!.MCP_BOOTSTRAP_NONCE);
    expect(new Set(nonces).size).toBe(2);
  });
});
