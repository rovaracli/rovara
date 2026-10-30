// Track record (v1.2 slice 1): the email and browser confirmation page. A less-safe change to a project's process shows, read-only, the record of the stage it is about (`ConfirmView.facts`): the
// plan check, code and security review, or tests. A change about no stage with a record shows none, and the confirmation rules are unchanged.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, type AgentId, type OrgRole, type OutcomeClaim } from "../../packages/contracts/src/index.js";
import { getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { readProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { putProjectPlaybook, type ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { recordOutcomeSample } from "../../packages/broker/src/rovara-code/outcomes.js";
import { MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? "member" });
const DAY = 86_400_000;
function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
function playbookDeps(w: MergeWorld): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps,
    projectFor: async (caller, rawName) => ({ name: rawName, role: (await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" }))! }),
  };
}
type Steps = Record<string, { instructions?: string; timeoutMinutes?: number | null }>;
async function setDraft(w: MergeWorld, agentId: AgentId, steps: Steps) {
  const agent = (await w.store.get(ORG_A, agentId))!;
  await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { steps }, expectedRevision: agent.draftRevision, by: MAX });
}
const publish = async (w: MergeWorld, who: string, agentId: AgentId) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return publishDraft(w.deps, callerOf(w, who), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
};
const approvalIdOf = (w: MergeWorld, result: { applied: boolean }) => w.approvalIdOf((result as unknown as { confirmUrl: string }).confirmUrl);
async function adoptVersion2(w: MergeWorld) {
  await w.store.adoptBuiltinVersion({ orgId: ORG_A, agentId: ROVARA_CODE_AGENT_ID, version: 2, expectedPinnedVersion: await w.store.pinnedBuiltinVersion(ORG_A, ROVARA_CODE_AGENT_ID), by: MAX });
}
/** A process layer whose first (safe) version is published, so later changes are compared with it. */
async function layer(w: MergeWorld): Promise<AgentId> {
  await adoptVersion2(w);
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  expect(await publish(w, MAX, agentId)).toMatchObject({ applied: true, value: { version: 1 } });
  return agentId;
}
let counter = 0;
async function seed(w: MergeWorld, claim: OutcomeClaim, state: "held" | "not_held" | "closed_unmerged", count: number, project = "web") {
  const stage = claim === "plan_ready" ? "plan_critic" : claim === "proves_change" ? "check" : claim === "risk_low" ? "risk" : "review";
  for (let index = 0; index < count; index += 1) {
    counter += 1;
    await recordOutcomeSample({ ddb: w.db, tableName: "state" }, {
      orgId: ORG_A, project, stage, taskId: `task-${String(counter)}`, claim, round: "r1", state, reason: "closed_unmerged",
      agent: { id: ROVARA_CODE_AGENT_ID, version: "3", digest: "d".repeat(64) }, model: "anthropic/test", createdAt: new Date(w.clock.now - 20 * DAY).toISOString(), scoredAt: new Date(w.clock.now - 2 * DAY).toISOString(),
    });
  }
}
const viewOf = async (w: MergeWorld, approvalId: string) => {
  const inspected = await w.kind.inspect({ orgId: ORG_A, developerId: OLA, approvalId });
  expect(inspected.status).toBe("open");
  return (inspected as unknown as { view: { facts: Array<{ label: string; value: string }>; paragraphs: string[] } }).view;
};
const records = (view: { facts: Array<{ label: string; value: string }> }) => view.facts.filter((fact) => fact.label.startsWith("Record so far"));

describe("the confirmation page shows the stage's record beside a less-safe change", () => {
  it("for a publish that changes the review instructions: the code review's and the security review's lines, read-only", async () => {
    const w = world();
    const agentId = await layer(w);
    await seed(w, "review_pass:CRITIC", "held", 9); await seed(w, "review_pass:CRITIC", "not_held", 1); await seed(w, "review_pass:CRITIC", "closed_unmerged", 2);
    await seed(w, "review_pass:SECURITY", "held", 4);
    await seed(w, "plan_ready", "held", 15);
    await setDraft(w, agentId, { review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, MAX, agentId);
    expect(waiting.applied).toBe(false);
    const view = await viewOf(w, approvalIdOf(w, waiting));
    expect(view.paragraphs.join("\n")).toContain('Changes the instructions of the review step "Review"');
    expect(records(view)).toEqual([
      { label: "Record so far: Code review", value: "No changes requested by a person on 9 of 10 merged PRs (last 30 days). 2 closed unmerged · Reverts after merge aren't tracked yet." },
      { label: "Record so far: Security review", value: "Not enough history yet (4 so far). Reverts after merge aren't tracked yet." },
    ]);
  });

  it("for a change to the plan check: the plan check's lines", async () => {
    const w = world();
    const agentId = await layer(w);
    await seed(w, "plan_ready", "held", 14); await seed(w, "plan_ready", "not_held", 3);
    await setDraft(w, agentId, { plan_critic: { instructions: "Check the plan against the tests." } });
    const waiting = await publish(w, MAX, agentId);
    expect(records(await viewOf(w, approvalIdOf(w, waiting)))).toEqual([{ label: "Record so far: Plan check", value: "The person approved the plan 14 of 17 times (last 30 days)." }]);
  });

  it("for a switch back to the built-in that removes a stricter review: the review's lines of that project", async () => {
    const w = world();
    const agentId = await layer(w);
    await setDraft(w, agentId, { review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, MAX, agentId);
    await w.decide(approvalIdOf(w, waiting), await w.browser(OLA, approvalIdOf(w, waiting)));
    await putProjectPlaybook(playbookDeps(w), callerOf(w, MAX), "web", { expectedRevision: (await readProjectPlaybook(playbookDeps(w), ORG_A, "web")).revision, defaultProcess: { kind: "project_process", agentId } });
    await seed(w, "review_pass:CRITIC", "held", 10);
    await seed(w, "review_pass:CRITIC", "held", 3, "other");
    const reply = await putProjectPlaybook(playbookDeps(w), callerOf(w, MAX), "web", { expectedRevision: (await readProjectPlaybook(playbookDeps(w), ORG_A, "web")).revision, defaultProcess: { kind: "builtin" } });
    expect(reply.statusCode).toBe(202);
    const view = await viewOf(w, w.approvalIdOf((reply.body as { confirmUrl: string }).confirmUrl));
    expect(records(view).map((fact) => fact.label)).toEqual(["Record so far: Code review", "Record so far: Security review"]);
    expect(records(view)[0]!.value).toContain("No changes requested by a person on 10 of 10 merged PRs (last 30 days)");
  });

  it("shows nothing for a change about no stage with a record, and a stage's record only once however many of its changes there are", async () => {
    const w = world();
    const agentId = await layer(w);
    await setDraft(w, agentId, { build: { timeoutMinutes: 240 } });
    const waiting = await publish(w, MAX, agentId);
    expect(waiting.applied).toBe(false);
    const view = await viewOf(w, approvalIdOf(w, waiting));
    expect(view.paragraphs.join("\n")).toMatch(/Raises the time the step "Build"/u);
    expect(records(view)).toEqual([]);
  });

  it("changes no confirmation rule: the change is still held, listed word for word, and waits for another person", async () => {
    const w = world();
    const agentId = await layer(w);
    await seed(w, "review_pass:CRITIC", "held", 12);
    await setDraft(w, agentId, { review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, MAX, agentId);
    const id = approvalIdOf(w, waiting);
    expect((await getAnyApproval(w.deps, ORG_A, id))!.status).toBe("PENDING");
    expect((waiting as unknown as { changes: string[] }).changes).toEqual(['Changes the instructions of the review step "Review"']);
    expect((await w.store.get(ORG_A, agentId))!.currentVersion).toBe(1);
  });

  it("leaves the page as it was when the record cannot be read", async () => {
    const w = world();
    const agentId = await layer(w);
    await seed(w, "review_pass:CRITIC", "held", 12);
    await setDraft(w, agentId, { review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, MAX, agentId);
    const id = approvalIdOf(w, waiting);
    const send = w.db.send.bind(w.db);
    (w.db as { send: unknown }).send = async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, string> } }) => {
      if (command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues?.[":pk"] ?? "").includes("OUTCOME_SCORED")) throw new Error("boom");
      return send(command);
    };
    const view = await viewOf(w, id);
    expect(records(view)).toEqual([]);
    expect(view.paragraphs.join("\n")).toContain('Changes the instructions of the review step "Review"');
  });
});
