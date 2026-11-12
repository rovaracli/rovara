// Plan 4 Task 10: the run view through the real broker. A run started on the app route is read back through `/v1/app/chain-runs/*` with Plan 3's real task layer behind the
// view's ports: the task view of the first step, as a reader of the run is shown it, and nothing to someone who does not read the run.
import "../support/automations-on.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ChainRunViewSchema } from "@rovara-code/contracts";
import { ChainRunEventPageSchema } from "@rovara-code/contracts";
import { ChainStepTaskViewSchema } from "../../packages/cloud-contracts/src/chain-session.js";
import { DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { agentGuardrailsKey, orgProjectCatalogKey } from "@rovara-code/contracts";
import { MAYA, OMAR, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

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
  return { h, call };
}

const ONE_STEP = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] };

describe("reading a run through the broker", () => {
  it("serves a started run's view, its events and its first step's task through the real task layer", async () => {
    const { h, call } = await setup();
    const created = await call(MAYA, "POST", "/v1/app/chains", { name: "Look into it", definition: ONE_STEP });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const chainId = (created.body.chain as { chainId: string }).chainId;
    const draft = await call(MAYA, "GET", `/v1/app/chains/${chainId}/draft`);
    const published = await call(MAYA, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: (draft.body.draft as { revision: number }).revision });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const started = await call(MAYA, "POST", `/v1/app/chains/${chainId}/runs`, { project: "payments" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body.run as { runId: string }).runId;

    const view = await call(MAYA, "GET", `/v1/app/chain-runs/${runId}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    const { requestId: _viewId, ...viewBody } = view.body; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(ChainRunViewSchema.parse(viewBody)).toMatchObject({ sessionId: runId, status: "running", sections: [{ seq: 1, stepId: "look", kind: "agent", detail: { kind: "task", rovaraCode: false } }] });

    const events = await call(MAYA, "GET", `/v1/app/chain-runs/${runId}/events?after=0`);
    const { requestId: _eventsId, ...eventsBody } = events.body; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(ChainRunEventPageSchema.parse(eventsBody).events.map((event) => event.type)).toEqual(["started", "step_started"]);

    const task = await call(MAYA, "GET", `/v1/app/chain-runs/${runId}/sections/1/task`);
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    const { requestId: _taskId, ...taskBody } = task.body; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(ChainStepTaskViewSchema.parse(taskBody)).toMatchObject({ seq: 1, rovaraCode: false, task: { agent: { agentId: "root-cause-analyst" }, run: { state: "RUNNING" } } });
    expect(JSON.stringify(task.body)).not.toContain("\"arguments\"");

    const list = await call(MAYA, "GET", "/v1/app/chain-runs?project=payments");
    expect((list.body.runs as Array<{ sessionId: string }>).map((run) => run.sessionId)).toEqual([runId]);
    expect((await call(OMAR, "GET", `/v1/app/chain-runs/${runId}`)).status).toBe(404);
    expect((await call(OMAR, "GET", `/v1/app/chain-runs/${runId}/sections/1/task`)).status).toBe(404);
    expect(h.db.find((item) => item.entityType === "CHAIN_RUN")).toHaveLength(1);
  });
});
