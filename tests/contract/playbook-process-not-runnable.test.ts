// "How we work" (S1 fix round 1): a project's process layer runs only as the project's way of working, through `startCodeIntent`. A chain step, a trigger and an autonomous run
// refuse it with the same words as an agent that is not there; so does a person's run that is not a code intent (the generic agent runs route is in playbook-start-process.test.ts).
import { describe, expect, it } from "vitest";
import { resolveAgentForAutonomousRun, resolveAgentForTask } from "../../packages/broker/src/agents/roster.js";
import { validateChainForPublish } from "../../packages/broker/src/chains/validate.js";
import { ChainDefinitionSchema } from "@rovara-code/contracts";
import { DANA, ORG_A, setupTriggerWorld } from "../support/trigger-world.js";

const NOT_THERE = { code: "NOT_FOUND", message: "no agent has that ID" };
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

async function layerWorld() {
  const v = setupTriggerWorld();
  const created = await v.agents.create({
    orgId: ORG_A, name: "web process", owner: { kind: "project", project: "web" }, accountable: { developerId: DANA }, extends: "rovara-code", overlay: {}, purpose: "process", createdBy: DANA,
  });
  await v.agents.publish({ orgId: ORG_A, agentId: created.agentId, expectedDraftRevision: created.draftRevision, digest: "d".repeat(64), by: DANA });
  const caller = { orgId: ORG_A, developerId: DANA, orgRole: "admin" as const };
  return { v, agentId: created.agentId, caller };
}

describe("a process layer by id", () => {
  it("is refused as a chain step when the chain is checked for publishing", async () => {
    const { v, agentId, caller } = await layerWorld();
    const def = ChainDefinitionSchema.parse({ start: "work", steps: [{ kind: "agent", id: "work", name: "work", agent: { agentId, version: "current" }, next: { kind: "end" } }] });
    const checked = await validateChainForPublish(v.deps, caller, ORG_A, def);
    expect(checked.problems).toHaveLength(1);
    expect(checked.problems[0]).toMatchObject({ path: "steps.0.agent" });
    // The words are the ones an agent that is not there gets.
    expect(checked.problems[0]!.message).toBe((await validateChainForPublish(v.deps, caller, ORG_A, ChainDefinitionSchema.parse({ start: "work", steps: [{ kind: "agent", id: "work", name: "work", agent: { agentId: `agt_${"q".repeat(20)}`, version: "current" }, next: { kind: "end" } }] }))).problems[0]!.message);
  });

  it("is refused as a chain step that a person's run reaches, and as an autonomous run (a chain step with no person, an event, a schedule)", async () => {
    const { v, agentId, caller } = await layerWorld();
    expect(await failure(resolveAgentForTask(v.deps, caller, { project: "web", agent: { agentId }, role: "maintainer" }))).toEqual(NOT_THERE);
    expect(await failure(resolveAgentForAutonomousRun(v.deps, { orgId: ORG_A, project: "web", agentId }))).toEqual(NOT_THERE);
  });

  it("is run only when the start says it is the project's code intent", async () => {
    const { v, agentId, caller } = await layerWorld();
    const resolved = await resolveAgentForTask(v.deps, caller, { project: "web", agent: { agentId }, role: "maintainer", allowProcessLayer: true });
    expect(resolved.ref).toMatchObject({ agentId, builtin: false });
  });

  it("is refused as a draft test run too, even for the project's own code intent (follow-up M4), while an ordinary agent's draft is still a test run", async () => {
    const { v, agentId, caller } = await layerWorld();
    const draft = { agentId, version: "draft" as const };
    expect(await failure(resolveAgentForTask(v.deps, caller, { project: "web", agent: draft, role: "maintainer" }))).toEqual(NOT_THERE);
    expect(await failure(resolveAgentForTask(v.deps, caller, { project: "web", agent: draft, role: "maintainer", allowProcessLayer: true }))).toEqual(NOT_THERE);
    const ordinary = await v.agents.create({ orgId: ORG_A, name: "web helper", owner: { kind: "project", project: "web" }, accountable: { developerId: DANA }, extends: "rovara-code", overlay: {}, createdBy: DANA });
    const resolved = await resolveAgentForTask(v.deps, caller, { project: "web", agent: { agentId: ordinary.agentId, version: "draft" }, role: "maintainer" });
    expect(resolved).toMatchObject({ testRun: true, ref: { agentId: ordinary.agentId, version: "draft" } });
  });

  it("cannot have a trigger put on it", async () => {
    const { v, agentId } = await layerWorld();
    const put = await v.agentCall(DANA, "PUT", `/v1/app/agents/${agentId}/triggers/ctr_${"a".repeat(20)}`, { project: "web", spec: { kind: "event", source: "github", type: "pull_request.opened" } });
    expect(put).toMatchObject({ status: 404, body: NOT_THERE });
  });
});
