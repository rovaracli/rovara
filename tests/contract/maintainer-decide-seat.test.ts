// Approval place (U4, owner decision Q7): the web app learns when a project maintainer may decide someone else's coding plan. Read-only: the task state's `decideAs`, and the plan document's
// `access` (`canDecide`, `decideAs`, `ownerName`). The seat is the decide route's own rule (`resolveTaskApprover`: the cards switch, the task's company, the live maintainer role in the task's project,
// the People list); the decide route stays the only authority (tests/contract/approval-place-decide.test.ts). Each condition here has a test that fails without it.
import { randomUUID } from "node:crypto";
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRole } from "@rovara-code/contracts";
import { decideSeatOf, getTaskDocumentView, getTaskPageState } from "../../packages/broker/src/aws/developer-tasks/task-page.js";
import { planPanelView } from "../../packages/broker/src/aws/developer-routes/plan-panel.js";
import { chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { UNAVAILABLE_NAME, forgetResolvedNames, resolveStoredName } from "../../packages/broker/src/developer/name-resolver.js";
import type * as NameResolverModule from "../../packages/broker/src/developer/name-resolver.js";
import type * as TaskAccessModule from "../../packages/broker/src/developer/task-access.js";
import { resolveTaskApprover } from "../../packages/broker/src/developer/task-access.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, type Developer } from "../support/developer-task-broker.js";
import { browserRequests } from "../support/browser-session.js";
import { signInToReview } from "../support/page-browser.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

// Pass-through spies on the two reads the seat makes: the approver read (`resolveTaskApprover`: the task, the live project role, the People list) and the owner-name lookup (`resolveStoredName`).
vi.mock("../../packages/broker/src/developer/task-access.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskAccessModule>();
  return { ...actual, resolveTaskApprover: vi.fn(actual.resolveTaskApprover) };
});
vi.mock("../../packages/broker/src/developer/name-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NameResolverModule>();
  return { ...actual, resolveStoredName: vi.fn(actual.resolveStoredName) };
});

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; forgetResolvedNames(); vi.mocked(resolveTaskApprover).mockClear(); vi.mocked(resolveStoredName).mockClear(); });
afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; forgetResolvedNames(); });

/** A teammate Slack's directory knows, by the developer ID "Sign in with Slack" gives them. */
const SAM: Developer = { developerId: developerIdForSlackUser("U0SAMLEE01"), name: "Sam Lee", provider: "slack", sessionId: "s-sam-decide", slackUserId: "U0SAMLEE01" };

type ListRole = "owner" | "commenter" | "viewer" | "denied";
type Who = { developerId: string; name: string; sessionId: string; provider: string; slackUserId?: string };

/**
 * A Quick task of MAYA's whose coding plan waits for her decision, with a People list (so a teammate may read the task: MAYA owns it, OMAR is on it as `omarOnList`). Every Slack proof says eligible and
 * in the channel unless `outOfChannel` names the person (the narrowed audience). `projectRoles` is the live project role check, by project: OMAR's role in "payments" (the task's project) and elsewhere.
 */
async function world(options: { omarOnList?: ListRole | "absent"; outOfChannel?: string[]; ineligible?: string[]; teammate?: boolean } = {}) {
  // `teammate`: the task is shared to the project's channel and SAM is in it, so the broker's own rules let SAM (not the owner) read it through the real routes; there is no People list then.
  const h = await createSingleAnswerPlanBroker(options.teammate !== true ? {} : { channelMembers: async (request) => ({ ok: true, memberOf: [MAYA.slackUserId, SAM.slackUserId].includes(request.slackUserId) ? request.channelIds : [] }) });
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
  const slackIds: Record<string, string> = { [MAYA.developerId]: "U0MAYA001", [OMAR.developerId]: "U0OMAR001", [SAM.developerId]: SAM.slackUserId! };
  const people = [{ developerId: MAYA.developerId, slackUserId: "U0MAYA001", name: MAYA.name, role: "owner" },
    ...(options.omarOnList === "absent" ? [] : [{ developerId: OMAR.developerId, slackUserId: "U0OMAR001", name: OMAR.name, role: options.omarOnList ?? "commenter" }])];
  if (options.teammate === true) h.db.set({ ...meta(), shared: true, share: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, mode: "view", sharedReason: "requested", sharedAt: new Date().toISOString() } });
  else h.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false, people });
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
    // As the panel's route reads: the seat is worked out for the coding plan's read only (`decideSeat`).
    const planView = await getTaskDocumentView(d, caller(who, orgId), taskId, { decideSeat: true });
    const otherView = await getTaskDocumentView(d, caller(who, orgId), taskId);
    return { plan: planPanelView(planView, "plan").access, design: planPanelView(otherView, "design").access, state: await getTaskPageState(d, caller(who, orgId), taskId) };
  };
  const task = () => meta() as never;
  return { h, taskId, deps, caller, read, task, meta };
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

describe("the owner's name on a maintainer's seat is bounded and never the stored copy when it cannot be settled", () => {
  it("a very long owner name is held to the 80-character cap on the plan panel's summary: by the stored name's own bound, and again by the panel (79 characters and an ellipsis)", async () => {
    const t = await world();
    t.h.db.set({ ...(t.task() as Record<string, unknown>), developerName: `Maya ${"Q".repeat(300)}` });
    const omar = await t.read(OMAR);
    expect(omar.plan).toMatchObject({ canDecide: true, decideAs: "maintainer" });
    const name = String(omar.plan.ownerName);
    expect(Array.from(name)).toHaveLength(80);
    expect(name).toMatch(/^Maya Q{70,}/u);
    // The panel bounds it itself as well, whatever the seat carries.
    const view = { ...(await getTaskDocumentView(t.deps(), t.caller(OMAR), t.taskId, { decideSeat: true })), decideSeat: { as: "maintainer" as const, ownerName: `Maya ${"Q".repeat(300)}` } };
    expect(planPanelView(view, "plan").access.ownerName).toBe(`Maya ${"Q".repeat(74)}…`);
    expect(Array.from(planPanelView(view, "plan").access.ownerName!)).toHaveLength(80);
    // Control characters and line breaks are flattened to plain text, and are not counted against the name's own letters.
    t.h.db.set({ ...(t.task() as Record<string, unknown>), developerName: "Maya\u202e\nChen" });
    forgetResolvedNames();
    expect((await t.read(OMAR)).plan.ownerName).toBe("Maya Chen");
  });

  it("a name lookup that fails reads \"A member\" for the owner: never the stored copy, and the seat itself stays", async () => {
    const t = await world();
    const failing = { ...(t.deps() as object), documentClient: { send: (command: unknown) => command instanceof BatchGetCommand ? Promise.reject(new Error("name items are down")) : t.h.db.send(command as never) } } as never;
    const planView = await getTaskDocumentView(failing, t.caller(OMAR), t.taskId, { decideSeat: true });
    const access = planPanelView(planView, "plan").access;
    expect(access).toEqual({ canComment: true, canSuggest: true, canDecide: true, canAsk: false, decideAs: "maintainer", ownerName: UNAVAILABLE_NAME });
    expect(UNAVAILABLE_NAME).toBe("A member");
    expect(JSON.stringify(planView.decideSeat)).not.toContain(MAYA.name);
    // Positive control: with the lookup healthy the same reader sees the owner's own name.
    forgetResolvedNames();
    expect((await t.read(OMAR)).plan.ownerName).toBe(MAYA.name);
  });
});

describe("the seat is for a coding plan that waits, and for someone other than the owner", () => {
  it("only while the coding plan waits: a plan not waiting, or a full-path task still in its requirements or design review, has no seat; positive control: the waiting plan has it", async () => {
    const t = await world();
    const workflow = (change: Record<string, unknown>) => t.h.db.set({ ...(t.task() as Record<string, unknown>), workflow: { ...t.meta().workflow, ...change } });
    const original = { ...t.meta().workflow };
    expect(await decideSeatOf(t.deps(), t.caller(OMAR), t.task(), false), "positive control").toEqual({ as: "maintainer" });
    for (const change of [{ state: "RUNNING" }, { stage: "CODING" }, { path: "FULL", reviewPhase: "REQUIREMENTS" }, { path: "FULL", reviewPhase: "DESIGN" }]) {
      workflow(change);
      expect(await decideSeatOf(t.deps(), t.caller(OMAR), t.task(), false), JSON.stringify(change)).toBeUndefined();
      workflow(Object.fromEntries(Object.keys(change).map((key) => [key, (original as Record<string, unknown>)[key]])));
    }
    expect(await decideSeatOf(t.deps(), t.caller(OMAR), t.task(), false), "restored").toEqual({ as: "maintainer" });
  });

  it("the owner is never given the maintainer's seat: the seat rule alone refuses the owner, who has the owner's own seat instead", async () => {
    const t = await world();
    expect(await decideSeatOf(t.deps(), t.caller(MAYA), t.task(), false)).toBeUndefined();
    expect(await decideSeatOf(t.deps(), t.caller(MAYA), t.task(), true)).toEqual({ as: "owner" });
  });

  it("the panel gives the seat to the coding plan alone, whatever the read carries", async () => {
    const t = await world();
    const view = await getTaskDocumentView(t.deps(), t.caller(OMAR), t.taskId, { decideSeat: true });
    expect(view.decideSeat).toMatchObject({ as: "maintainer" });
    expect(planPanelView(view, "plan").access).toMatchObject({ canDecide: true, decideAs: "maintainer" });
    for (const document of ["design", "requirements"] as const) expect(planPanelView(view, document).access, document).toEqual(NO_SEAT);
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

describe("the seat is worked out for the coding plan's read only", () => {
  const approverReads = () => vi.mocked(resolveTaskApprover).mock.calls.length;
  const nameReads = () => vi.mocked(resolveStoredName).mock.calls.length;

  it("a read that does not ask for the seat (the design and requirements panels, the old page's read) makes no approver read and no name lookup, and carries no seat; positive control: the plan read does both", async () => {
    const t = await world();
    for (const options of [undefined, {}, { decideSeat: false }]) {
      const view = await getTaskDocumentView(t.deps(), t.caller(OMAR), t.taskId, options);
      expect(view, JSON.stringify(options)).not.toHaveProperty("decideSeat");
      expect(planPanelView(view, "design").access, JSON.stringify(options)).toEqual(NO_SEAT);
      expect(planPanelView(view, "requirements").access, JSON.stringify(options)).toEqual(NO_SEAT);
    }
    expect([approverReads(), nameReads()], "no seat asked for").toEqual([0, 0]);
    const view = await getTaskDocumentView(t.deps(), t.caller(OMAR), t.taskId, { decideSeat: true });
    expect(view.decideSeat).toEqual({ as: "maintainer", ownerName: MAYA.name });
    expect(approverReads(), "the plan read does read the approver").toBeGreaterThan(0);
    expect(nameReads(), "and names the owner").toBe(1);
  });

  it("the owner's name is looked up only for a maintainer's seat: the owner and a reader with no seat cause no name lookup", async () => {
    const t = await world();
    const maya = await getTaskDocumentView(t.deps({ payments: "contributor" }), t.caller(MAYA), t.taskId, { decideSeat: true });
    expect(maya.decideSeat).toEqual({ as: "owner" });
    const contributor = await getTaskDocumentView(t.deps({ payments: "contributor" }), t.caller(OMAR), t.taskId, { decideSeat: true });
    expect(contributor).not.toHaveProperty("decideSeat");
    expect(planPanelView(contributor, "plan").access).toEqual(NO_SEAT);
    expect(nameReads()).toBe(0);
    // The owner is never given the maintainer's seat, so her own read does not ask the approver either.
    expect(await decideSeatOf(t.deps(), t.caller(MAYA), t.task(), true, { ownerName: true })).toEqual({ as: "owner" });
    expect(nameReads()).toBe(0);
  });

  it("the routes: the design and requirements panels and the old page make no approver read for a teammate; the plan panel does, and still answers its access summary", async () => {
    const t = await world({ teammate: true });
    const web = browserRequests({ db: t.h.db, handler: t.h.handler, orgOf: t.h.orgOf });
    const base = `/v1/app/tasks/${t.taskId}`;
    for (const document of ["design", "requirements"]) {
      const answer = await web(SAM, "GET", `${base}/documents/${document}`);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(answer.body, document).toMatchObject({ document, access: { canComment: true, canDecide: false } });
    }
    const session = signInToReview({ db: t.h.db, handler: t.h.handler, taskId: () => t.taskId }, { developerId: SAM.developerId, name: SAM.name, slackUserId: SAM.slackUserId! });
    const page = await t.h.handler({ version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${t.taskId}/task`, rawQueryString: "", headers: { cookie: `__Host-agentx_review_session=${session}` },
      isBase64Encoded: false, requestContext: { requestId: randomUUID(), http: { method: "GET" } } }) as { statusCode: number };
    expect(page.statusCode, "the old page rendered for the teammate").toBe(200);
    expect(approverReads(), "design, requirements and the old page").toBe(0);
    const plan = await web(SAM, "GET", `${base}/documents/plan`);
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(approverReads(), "the plan panel").toBe(1);
    expect(plan.body).toMatchObject({ document: "plan", waiting: true, access: { canComment: true, canSuggest: true, canDecide: false, canAsk: false } });
  });
});
