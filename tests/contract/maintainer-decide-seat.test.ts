// Approval place (U4, owner decision Q7): the web app learns when a project maintainer may decide someone else's coding plan. Read-only: the task state's `decideAs`, and the plan document's
// `access` (`canDecide`, `decideAs`, `ownerName`). The seat is the decide route's own rule (`resolveTaskApprover`: the cards switch, the task's company, the live maintainer role in the task's project,
// the People list); the decide route stays the only authority (tests/contract/approval-place-decide.test.ts). Each condition here has a test that fails without it.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectRole } from "../../packages/contracts/src/index.js";
import { decideSeatOf, getTaskDocumentView, getTaskPageState } from "../../packages/broker/src/aws/developer-tasks/task-page.js";
import { planPanelView } from "../../packages/broker/src/aws/developer-routes/plan-panel.js";
import { chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { forgetResolvedNames } from "../../packages/broker/src/developer/name-resolver.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; forgetResolvedNames(); });
afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; forgetResolvedNames(); });

type ListRole = "owner" | "commenter" | "viewer" | "denied";
type Who = { developerId: string; name: string; sessionId: string; provider: string; slackUserId?: string };

/**
 * A Quick task of MAYA's whose coding plan waits for her decision, with a People list (so a teammate may read the task: MAYA owns it, OMAR is on it as `omarOnList`). Every Slack proof says eligible and
 * in the channel unless `outOfChannel` names the person (the narrowed audience). `projectRoles` is the live project role check, by project: OMAR's role in "payments" (the task's project) and elsewhere.
 */
async function world(options: { omarOnList?: ListRole | "absent"; outOfChannel?: string[]; ineligible?: string[] } = {}) {
  const h = await createSingleAnswerPlanBroker();
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const meta = () => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: { stage: string; state: string } };
  const operation = (predicate: (item: Record<string, unknown>) => boolean) => String(h.db.find((item) => item.pk === `WORKSPACE#${meta().workspaceId}` && item.entityType === "OPERATION").filter(predicate).at(-1)!.id);
  await h.finish(meta().workspaceId, operation((item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
  const planning = operation((item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
  await h.artifact(meta().workspaceId, planning, "plan.md", planAnswer(planDocument()));
  await h.finish(meta().workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  expect(meta().workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  const slackIds: Record<string, string> = { [MAYA.developerId]: "U0MAYA001", [OMAR.developerId]: "U0OMAR001" };
  const people = [{ developerId: MAYA.developerId, slackUserId: "U0MAYA001", name: MAYA.name, role: "owner" },
    ...(options.omarOnList === "absent" ? [] : [{ developerId: OMAR.developerId, slackUserId: "U0OMAR001", name: OMAR.name, role: options.omarOnList ?? "commenter" }])];
  h.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people });
  const checkTaskPerson = async (_task: unknown, developerId: string) => {
    const slackUserId = slackIds[developerId] ?? "U0NOONE001";
    return { subject: { developerId, slackUserId }, identity: { developerId, slackUserId, name: "Someone", method: "slack", issuer: "https://slack.com", subject: slackUserId },
      eligible: !(options.ineligible ?? []).includes(developerId), channelMember: !(options.outOfChannel ?? []).includes(developerId) };
  };
  const deps = (projectRoles: Record<string, ProjectRole> = { payments: "maintainer" }) => ({
    documentClient: h.db, tableName: "state", signInTableName: "signin", actions: h.actions, orgId: TEST_ORG, log: () => undefined, now: () => Date.now(), checkTaskPerson,
    checkAccess: async (project: string) => {
      const role = projectRoles[project];
      if (role === undefined) throw Object.assign(new Error("PROJECT_ACCESS_DENIED"), { code: "PROJECT_ACCESS_DENIED" });
      return { revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role };
    },
    projectChannelIds: async () => [],
  }) as never;
  const caller = (who: Who, orgId: string = TEST_ORG) => ({ orgId, developerId: who.developerId, orgRole: "member", name: who.name, amr: who.provider, sessionId: who.sessionId, browserSession: true as const }) as never;
  /** The plan document route's answer (`GET /v1/app/tasks/{id}/documents/plan` is `planPanelView(getTaskDocumentView(...))`), and the task state, for one reader. */
  const read = async (who: Who, projectRoles?: Record<string, ProjectRole>, orgId?: string) => {
    const d = deps(projectRoles);
    const view = await getTaskDocumentView(d, caller(who, orgId), taskId);
    return { plan: planPanelView(view, "plan").access, design: planPanelView(view, "design").access, state: await getTaskPageState(d, caller(who, orgId), taskId) };
  };
  const task = () => meta() as never;
  return { h, taskId, deps, caller, read, task };
}

const NO_SEAT = { canComment: true, canSuggest: true, canDecide: false, canAsk: false };

describe("the plan document's access summary and the task state name the maintainer's seat", () => {
  it("a maintainer of the task's project who is not the owner may decide: canDecide, decideAs maintainer and the owner's name; the task state says the seat with no name", async () => {
    const t = await world();
    const omar = await t.read(OMAR);
    expect(omar.plan).toEqual({ canComment: true, canSuggest: true, canDecide: true, canAsk: false, decideAs: "maintainer", ownerName: MAYA.name });
    expect(omar.state).toMatchObject({ canDecide: true, decideAs: "maintainer" });
    expect(omar.state).not.toHaveProperty("ownerName");
    // The seat is for the coding plan only: another document's summary offers nothing to decide.
    expect(omar.design).toEqual(NO_SEAT);
  });

  it("the owner decides as the owner, and is not named to themselves", async () => {
    const t = await world();
    const maya = await t.read(MAYA, { payments: "contributor" });
    expect(maya.plan).toMatchObject({ canDecide: true, decideAs: "owner" });
    expect(maya.plan).not.toHaveProperty("ownerName");
    expect(maya.state).toMatchObject({ canDecide: true, decideAs: "owner" });
  });

  it("live role: a contributor or a viewer of the task's project, and a member with no role in it, reads the plan with nothing to decide and no seat", async () => {
    const t = await world();
    for (const role of ["contributor", "viewer"] as const) {
      const omar = await t.read(OMAR, { payments: role });
      expect(omar.plan, role).toEqual(NO_SEAT);
      expect(omar.state.canDecide, role).toBe(false);
      expect(omar.state, role).not.toHaveProperty("decideAs");
    }
  });

  it("project match: a maintainer of ANOTHER project (a contributor in this one) has no seat; positive control: the same person made maintainer of this project has it", async () => {
    const t = await world();
    const elsewhere = await t.read(OMAR, { payments: "contributor", ops: "maintainer" });
    expect(elsewhere.plan).toEqual(NO_SEAT);
    expect(elsewhere.state).not.toHaveProperty("decideAs");
    expect((await t.read(OMAR, { payments: "maintainer", ops: "contributor" })).plan).toMatchObject({ canDecide: true, decideAs: "maintainer" });
  });

  it("switch: with the decision cards off, a maintainer has nothing to decide and no seat (the owner keeps hers)", async () => {
    const t = await world();
    delete process.env.DECISION_CARDS_ENABLED;
    const omar = await t.read(OMAR);
    expect(omar.plan).toEqual(NO_SEAT);
    expect(omar.state.canDecide).toBe(false);
    expect(omar.state).not.toHaveProperty("decideAs");
    expect((await t.read(MAYA)).plan).toMatchObject({ canDecide: true, decideAs: "owner" });
  });

  it("an erased owner is named \"A former member\", never by the stored name or an id", async () => {
    const t = await world();
    t.h.db.set({ ...chosenNameKey(MAYA.developerId), entityType: "DEVELOPER_NAME", developerId: MAYA.developerId, erased: true, erasedAt: "2026-11-01T00:00:00.000Z" });
    const omar = await t.read(OMAR);
    expect(omar.plan).toMatchObject({ canDecide: true, decideAs: "maintainer", ownerName: "A former member" });
    expect(JSON.stringify(omar)).not.toContain(MAYA.name);
    expect(JSON.stringify(omar)).not.toContain(MAYA.developerId);
  });

  it("a finished task has no seat: nothing waits to be decided", async () => {
    const t = await world();
    t.h.db.set({ ...(t.task() as Record<string, unknown>), closedAt: new Date().toISOString() });
    const omar = await t.read(OMAR);
    expect(omar.plan.canDecide).toBe(false);
    expect(omar.plan).not.toHaveProperty("decideAs");
  });
});

describe("a narrowed People list, and another company, never get the seat", () => {
  it("People list: a maintainer the list denies cannot read the task at all, and the seat rule alone refuses them too; positive control: on the list, the seat", async () => {
    const t = await world({ omarOnList: "denied" });
    await expect(t.read(OMAR)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    // The seat rule is checked on its own as well (a reader can hold a task through a session level, which skips the list): it refuses a denied maintainer.
    expect(await decideSeatOf(t.deps(), t.caller(OMAR), t.task(), false, { ownerName: true })).toBeUndefined();
    const listed = await world({ omarOnList: "commenter" });
    expect(await decideSeatOf(listed.deps(), listed.caller(OMAR), listed.task(), false, { ownerName: true })).toEqual({ as: "maintainer", ownerName: MAYA.name });
  });

  it("narrowed audience: a maintainer the task's audience leaves out (not on the list and not in the task's channel, or no longer eligible) reads nothing and has no seat; positive control: in the channel, the seat", async () => {
    for (const narrowed of [{ omarOnList: "absent" as const, outOfChannel: [OMAR.developerId] }, { ineligible: [OMAR.developerId] }]) {
      const t = await world(narrowed);
      await expect(t.read(OMAR), JSON.stringify(narrowed)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(await decideSeatOf(t.deps(), t.caller(OMAR), t.task(), false), JSON.stringify(narrowed)).toBeUndefined();
    }
    const inChannel = await world({ omarOnList: "absent" });
    expect((await inChannel.read(OMAR)).plan).toMatchObject({ canDecide: true, decideAs: "maintainer" });
  });

  it("company: another company's maintainer reads the task as missing, and the seat rule alone refuses them", async () => {
    const t = await world();
    await expect(t.read(OMAR, { payments: "maintainer" }, OTHER_ORG)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await decideSeatOf(t.deps(), t.caller(OMAR, OTHER_ORG), t.task(), false)).toBeUndefined();
    expect(await decideSeatOf(t.deps(), t.caller(OMAR), t.task(), false), "positive control: the same person in the task's company").toEqual({ as: "maintainer" });
  });
});
