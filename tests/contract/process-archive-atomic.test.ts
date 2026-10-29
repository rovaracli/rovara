// "How we work" follow-up F2: archiving a process layer checks, in the archive's own transaction, that the playbook did not come to point at it after the route looked.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, projectPlaybookKey, type AgentId } from "../../packages/contracts/src/index.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { CELL, MAX, ORG_A } from "../support/agent-session-world.js";
import { callerOf, failure, playbookDeps, world, type Client } from "../support/process-switch-world.js";
import type { MergeWorld } from "../support/rovara-code-merge-world.js";

describe("archiving a process layer checks the playbook in the archive's own transaction", () => {
  const archive = (w: MergeWorld, client: Client, agentId: AgentId) => {
    const path = `/v1/app/agents/${agentId}/archive`;
    return failure(routeAgentRequest({ ...w.deps, documentClient: client } as never, callerOf(w, MAX), { method: "POST", path, requestId: "r", headers: {}, body: JSON.stringify({ requestId: randomUUID() }) }, new URL(`${CELL}${path}`)));
  };
  /** Points the playbook at the layer the way a publish or the PUT does. */
  const pointAt = (w: MergeWorld, agentId: AgentId, revision: number) => w.db.set({ ...projectPlaybookKey(ORG_A, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision, defaultProcess: { kind: "project_process", agentId } });
  const isPlaybookRead = (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
    command.constructor.name === "GetCommand" && (command.input["Key"] as { pk?: string } | undefined)?.pk === projectPlaybookKey(ORG_A, "web").pk;

  it("a layer the playbook came to point at after the check is not archived (document missing at the check)", async () => {
    const w = world();
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    // Read first, then pointed at: the pointing lands after the check, before the archive.
    let pointed = false;
    const racing: Client = { send: async (command) => { const result = await w.db.send(command as never); if (!pointed && isPlaybookRead(command as never)) { pointed = true; pointAt(w, agentId, 1); } return result; } };
    expect(await archive(w, racing, agentId)).toMatchObject({ code: "PROCESS_IN_USE", status: 409 });
    expect(pointed).toBe(true);
    expect((await w.store.get(ORG_A, agentId))!.status).toBe("active");
  });

  it("the same when the document existed at the check (pointing at the built-in) and moved to the layer after it", async () => {
    const w = world();
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    w.db.set({ ...projectPlaybookKey(ORG_A, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision: 1, defaultProcess: { kind: "builtin" } });
    let pointed = false;
    const racing: Client = { send: async (command) => { const result = await w.db.send(command as never); if (!pointed && isPlaybookRead(command as never)) { pointed = true; pointAt(w, agentId, 2); } return result; } };
    expect(await archive(w, racing, agentId)).toMatchObject({ code: "PROCESS_IN_USE", status: 409 });
    expect((await w.store.get(ORG_A, agentId))!.status).toBe("active");
  });

  it("an ordinary agent's archive does not depend on the playbook at all", async () => {
    const w = world();
    const ordinary = await w.store.create({ orgId: ORG_A, name: "helper", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    // Whatever happens to the playbook while it is being archived (a change at every read of it) does not matter to it.
    const racing: Client = { send: async (command) => { const result = await w.db.send(command as never); if (isPlaybookRead(command as never)) pointAt(w, ordinary.agentId, 7); return result; } };
    expect(await archive(w, racing, ordinary.agentId)).toBeUndefined();
    expect((await w.store.get(ORG_A, ordinary.agentId))!.status).toBe("archived");
  });

  it("archives a layer the playbook does not point at, with no race, and an ordinary agent", async () => {
    const w = world();
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    expect(await archive(w, w.db, agentId)).toBeUndefined();
    expect((await w.store.get(ORG_A, agentId))!.status).toBe("archived");
    const ordinary = await w.store.create({ orgId: ORG_A, name: "helper", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    expect(await archive(w, w.db, ordinary.agentId)).toBeUndefined();
    expect((await w.store.get(ORG_A, ordinary.agentId))!.status).toBe("archived");
  });
});
