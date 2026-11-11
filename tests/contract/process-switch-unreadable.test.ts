// "How we work" follow-up F2 (PB16): a playbook document that EXISTS but can't be read is not the built-in. The switch to the built-in is held for a second person and the process layer
// can't be archived. A missing document is as before.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, projectPlaybookKey, projectRevisionKey } from "@rovara-code/contracts";
import { getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { requireNotCurrentProcess } from "../../packages/broker/src/playbook/process-in-use.js";
import type { BuiltinSwitchDependencies } from "../../packages/broker/src/playbook/process-switch.js";
import { MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { callerOf, changedEvents, corruptPlaybook, failure, layerWith, playbook, playbookDeps, publish, rawPlaybook, toBuiltin, world } from "../support/process-switch-world.js";

describe("a playbook document that exists but can't be read (PB16)", () => {
  it("holds the switch to the built-in for a second person even when the layer loses nothing, and changes nothing until it is confirmed", async () => {
    const w = world();
    const layer = await layerWith(w);
    const revision = corruptPlaybook(w);
    const before = rawPlaybook(w);
    const events = changedEvents(w).length;
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(202);
    expect(reply.body).toMatchObject({ status: "NEEDS_CONFIRMATION" });
    expect(rawPlaybook(w)).toEqual(before);
    expect(changedEvents(w)).toHaveLength(events);
    // Nothing is listed as lost (the layer is no stricter), so the page says why it is waiting.
    expect((reply.body as { changes: string[] }).changes.join("\n")).toContain("can't be read right now");
    // The second person confirms: the document is the built-in at the next revision.
    const approvalId = w.approvalIdOf((reply.body as { confirmUrl: string }).confirmUrl);
    const { decideApproval } = await import("../../packages/broker/src/agents/approvals.js");
    await decideApproval(w.deps, callerOf(w, OLA), approvalId, { requestId: randomUUID(), decision: "APPROVE" });
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))!.status).toBe("APPROVED_DONE");
    expect(await playbook(w)).toEqual({ revision: revision + 1, defaultProcess: { kind: "builtin" } });
    expect(changedEvents(w)).toHaveLength(events + 1);
    expect(layer).toBeDefined();
  });

  it("holds a switch from a stricter layer the same way, listing what is lost", async () => {
    const w = world();
    await layerWith(w, true);
    corruptPlaybook(w);
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(202);
    expect((reply.body as { changes: string[] }).changes.join("\n")).toContain('Changes the instructions of the review step "Review"');
  });

  it("a project with no layer to lose is repaired at once, as before", async () => {
    const w = world();
    const revision = corruptPlaybook(w);
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(200);
    expect(await playbook(w)).toEqual({ revision: revision + 1, defaultProcess: { kind: "builtin" } });
  });

  it("only the project's own published process layer holds it: an ordinary agent and another project's layer do not", async () => {
    const w = world();
    // Another project's published layer and an ordinary published agent of this one.
    w.grant(MAX, "mobile", "maintainer");
    w.db.set({ ...projectRevisionKey(ORG_A, "mobile", 1), entityType: "PROJECT", registeredAt: new Date(w.clock.now).toISOString(), definition: { name: "mobile", revision: 1, repositories: [{ name: "mobile", url: "https://github.com/acme/mobile.git", path: "repo/mobile", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." } });
    const other = await w.store.create({ orgId: ORG_A, name: "mobile process", owner: { kind: "project", project: "mobile" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, purpose: "process", createdBy: MAX });
    await publish(w, other.agentId);
    const ordinary = await w.store.create({ orgId: ORG_A, name: "helper", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    await publish(w, ordinary.agentId);
    const revision = corruptPlaybook(w);
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(200);
    expect(await playbook(w)).toEqual({ revision: revision + 1, defaultProcess: { kind: "builtin" } });
  });

  it("a layer that is only a draft has nothing to lose", async () => {
    const w = world();
    await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    const revision = corruptPlaybook(w);
    expect((await toBuiltin(w)).statusCode).toBe(200);
    expect(await playbook(w)).toEqual({ revision: revision + 1, defaultProcess: { kind: "builtin" } });
  });

  it("a missing document is still the built-in: a layer that loses nothing and is not the default switches at once", async () => {
    const w = world();
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    await publish(w, agentId);
    w.db.delete(projectPlaybookKey(ORG_A, "web").pk, projectPlaybookKey(ORG_A, "web").sk);
    expect(rawPlaybook(w)).toBeUndefined();
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(200);
  });

  it("refuses to archive a process layer of the project (PROCESS_IN_USE), but not an ordinary agent, and a missing document stays as it was", async () => {
    const w = world();
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    const layer = (await w.store.get(ORG_A, agentId))!;
    // No document: the layer is not in use (the archive gets the guard to carry into its transaction).
    await expect(requireNotCurrentProcess(playbookDeps(w), layer)).resolves.toMatchObject({ items: [expect.anything()] });
    corruptPlaybook(w);
    expect(await failure(requireNotCurrentProcess(playbookDeps(w), layer))).toMatchObject({ code: "PROCESS_IN_USE", status: 409 });
    const ordinary = await w.store.create({ orgId: ORG_A, name: "helper", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    await expect(requireNotCurrentProcess(playbookDeps(w), ordinary)).resolves.toBeUndefined();
    // A layer of another project is not this project's to hold.
    const elsewhere = await w.store.create({ orgId: ORG_A, name: "other process", owner: { kind: "project", project: "mobile" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, purpose: "process", createdBy: MAX });
    await expect(requireNotCurrentProcess(playbookDeps(w), elsewhere)).resolves.toMatchObject({ items: [expect.anything()] });
  });
});


describe("the switch's store must be able to list agents (PB21)", () => {
  it("lists the company's agents to find the layer of a playbook that can't be read, and holds the switch for it", async () => {
    const w = world();
    await layerWith(w);
    corruptPlaybook(w);
    const listed: string[] = [];
    const store = Object.assign(Object.create(w.store) as typeof w.store, { list: async (orgId: string) => { listed.push(orgId); return w.store.list(orgId); } });
    const reply = await toBuiltin(w, { ...playbookDeps(w), store });
    expect(listed).toEqual([ORG_A]);
    expect(reply.statusCode).toBe(202);
  });

  it("refuses the switch (RUNTIME_UNAVAILABLE) when the agent store is missing and the project runs a process layer, or its playbook can't be read, and writes nothing", async () => {
    const w = world();
    await layerWith(w);
    const before = rawPlaybook(w);
    const events = changedEvents(w).length;
    expect(await failure(toBuiltin(w, { ...playbookDeps(w), store: undefined }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(rawPlaybook(w)).toEqual(before);
    corruptPlaybook(w);
    const unreadable = rawPlaybook(w);
    expect(await failure(toBuiltin(w, { ...playbookDeps(w), store: undefined }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(rawPlaybook(w)).toEqual(unreadable);
    expect(changedEvents(w)).toHaveLength(events);
  });

  it("a project already on the built-in switches at once with no agent store (nothing to lose)", async () => {
    const w = world();
    expect((await toBuiltin(w, { ...playbookDeps(w), store: undefined })).statusCode).toBe(200);
  });

  it("is checked by the compiler: a store with no list is not accepted (tsc fails if `list` is optional again)", () => {
    const w = world();
    const noList = { get: w.store.get.bind(w.store), getVersion: w.store.getVersion.bind(w.store) };
    // @ts-expect-error `list` is required: without it an unreadable playbook's layer could not be found, and the second person skipped.
    const deps: BuiltinSwitchDependencies = { ...playbookDeps(w), store: noList };
    expect(deps).toBeDefined();
  });
});
