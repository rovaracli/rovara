// Plan 4 Task 18: the trigger routes are reachable through the real broker, on the paths the plan names, and answer what the route functions answer.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { agentGuardrailsKey, orgProjectCatalogKey } from "@rovara-code/contracts";
import { TriggerStore } from "../../packages/broker/src/triggers/store.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const ONE_STEP = { start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] };
const PR = { kind: "event", source: "github", type: "pull_request.opened" };
const TRIGGER = `ctr_${"a".repeat(20)}`;

async function setup() {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { projectMembers: members } } });
  members.setOrgRole(TEST_ORG, MAYA.developerId, "owner");
  members.grant(TEST_ORG, "payments", MAYA.developerId, "maintainer");
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments" });
  h.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: MAYA.developerId, updatedAt: "2026-10-21T00:00:00.000Z", guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "run" } });
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>) => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    return { status: reply.status, body: reply.body };
  };
  const created = await call(MAYA, "POST", "/v1/app/chains", { name: "Look into it", definition: ONE_STEP });
  const chainId = (created.body.chain as { chainId: string }).chainId;
  const draft = await call(MAYA, "GET", `/v1/app/chains/${chainId}/draft`);
  expect((await call(MAYA, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: (draft.body.draft as { revision: number }).revision })).status).toBe(200);
  return { h, call, chainId };
}

describe("the trigger routes through the broker", () => {
  it("asks for a budget first, then stores a chain's trigger off and waits for the page, and lists, shows its activity and deletes it", async () => {
    const { call, chainId } = await setup();
    const path = `/v1/app/chains/${chainId}/triggers/${TRIGGER}`;
    const refused = await call(MAYA, "PUT", path, { project: "payments", spec: PR });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((refused.body.error as { code: string }).code).toBe("CHAIN_BUDGET_REQUIRED");
    expect((await call(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, { monthlyUsd: 20 })).status).toBe(200);
    const asked = await call(MAYA, "PUT", path, { project: "payments", spec: PR });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: ["turn on github pull request opened for payments"] });
    const listed = await call(MAYA, "GET", `/v1/app/chains/${chainId}/triggers`);
    expect(listed.body.triggers).toMatchObject([{ triggerId: TRIGGER, enabled: false, project: "payments" }]);
    expect((await call(MAYA, "GET", `${path}/activity`)).body).toEqual(expect.objectContaining({ activity: [] }));
    expect((await call(OMAR, "GET", `/v1/app/chains/${chainId}/triggers`)).status).toBe(404);
    expect((await call(MAYA, "DELETE", path, {})).body).toMatchObject({ deleted: true });
    expect((await call(MAYA, "GET", `/v1/app/chains/${chainId}/triggers`)).body.triggers).toEqual([]);
  });

  it("serves the project's switch for the triggers the built-in agents suggest, all off, and refuses a built-in on the generic route", async () => {
    const { call } = await setup();
    const rows = await call(MAYA, "GET", "/v1/app/projects/payments/builtin-triggers");
    expect(rows.status, JSON.stringify(rows.body)).toBe(200);
    expect(rows.body.triggers).toContainEqual(expect.objectContaining({ agentId: "code-reviewer", index: 0, enabled: false, needsHook: false }));
    const generic = await call(MAYA, "PUT", `/v1/app/agents/code-reviewer/triggers/${TRIGGER}`, { project: "payments", spec: PR });
    expect(generic.status).toBe(400);
    expect((generic.body.error as { message: string }).message).toContain("use the project's built-in trigger switch");
    expect((await call(OMAR, "GET", "/v1/app/projects/payments/builtin-triggers")).status).toBe(404);
  });

  it("turns a chain's trigger off when its budget goes, and a built-in's when the company turns the built-in off, through the hooks the broker builds", async () => {
    const { h, call, chainId } = await setup();
    const triggers = new TriggerStore({ documentClient: h.db, tableName: "state", now: Date.now });
    expect((await call(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, { monthlyUsd: 20 })).status).toBe(200);
    const onChain = await triggers.create({ record: { orgId: TEST_ORG, triggerId: TRIGGER, target: { kind: "chain", chainId }, project: "payments", spec: { kind: "event", source: "github", type: "pull_request.opened" }, enabled: true, maxRunsPerHour: 30, createdBy: MAYA.developerId } });
    const removed = await call(MAYA, "PUT", `/v1/app/chains/${chainId}/budget`, { monthlyUsd: null });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((removed.body.disabledTriggers as Array<{ triggerId: string }>).map((entry) => entry.triggerId)).toEqual([onChain.triggerId]);
    expect((await triggers.get(TEST_ORG, TRIGGER))?.enabled).toBe(false);
    const onBuiltin = await triggers.create({ record: { orgId: TEST_ORG, triggerId: `ctr_${"b".repeat(20)}`, target: { kind: "agent", agentId: "code-reviewer" }, project: "payments", spec: { kind: "event", source: "github", type: "pull_request.opened" }, enabled: true, maxRunsPerHour: 30, createdBy: MAYA.developerId } });
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const guardrails = await call(MAYA, "GET", "/v1/app/org/agent-guardrails");
    const turnedOff = await call(MAYA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: guardrails.body.revision, guardrails: { ...(guardrails.body.guardrails as object), disabledBuiltins: ["code-reviewer"] } });
    expect(turnedOff.status, JSON.stringify(turnedOff.body)).toBe(200);
    expect((turnedOff.body.disabledTriggers as Array<{ triggerId: string }>).map((entry) => entry.triggerId)).toEqual([onBuiltin.triggerId]);
  });
});
