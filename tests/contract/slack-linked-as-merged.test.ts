// 0.5.18x (owner decision 183(d)): a Slack account LINKED to a web account behaves as if MERGED. While the link is active every Slack request acts as the web account (its id, its role, its
// rights alone, followed through merges to the survivor), tasks started from Slack belong to the web account from the start, and an unlink removes the rights at once. One named case per threat
// of the lane brief (briefs/0518x-slack-linked-as-merged.md, "Adversarial set"), through the real Slack ingress (the broker handler's `agentx.slack-ingress` events, `slackCallerFor`) and the
// service-route rule (`slackRequesterStanding`, `slackRequesterProjectRole`, `linkedRequester`). Nothing here stubs the seat.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLACK_OIDC_ISSUER, projectMemberKey, type OrgId } from "@rovara-code/contracts";
import { developerOrgKey, erasedPersonKey, orgBanKey, orgMemberKey, orgRemovedKey, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { brokerDependencies, slackCallerFor, slackRequesterStanding } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { slackRequesterProjectRole } from "../../packages/broker/src/aws/broker/workspace-preparation.js";
import { linkedRequester } from "../../packages/broker/src/aws/broker/model-access.js";
import { installLessons, type learningDepsFor } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { uninstallLearningTaskEnd } from "../../packages/broker/src/aws/broker/learning-wiring.js";
import { seatTaskOwner } from "../../packages/broker/src/aws/developer-routes/owner-seat.js";
import { backfillMergedTaskOwners } from "../../packages/broker/src/developer/merged-owner-backfill.js";
import { taskIndexKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { buildReflectorInput } from "../../packages/broker/src/lessons/reflect-input.js";
import { buildTaskReflectSubject } from "../../packages/broker/src/lessons/task-subject.js";
import { OMAR, createSingleAnswerPlanBroker, grantProject, seedMembership, MAYA } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { planAnswer } from "../support/plan-documents.js";
import { pagePlan } from "../support/page-tasks.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
type Item = Record<string, unknown>;

/** The Slack account under test (the harness's channel lists it as a member of the bound channel) and its Slack-derived developer id. */
const SLACK_USER = MAYA.slackUserId!;
const SLACK_ID = developerIdForSlackUser(SLACK_USER);
/** A second Slack account, for "another person's Slack". */
const OTHER_SLACK_USER = "U0OTHER0099";
/** The web account the Slack account is linked to, and two other web people. */
const PERSON = "7".repeat(64);
const PERSON_B = "8".repeat(64);
const SURVIVOR = "9".repeat(64);
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
const LINKED_AT = "2020-01-01T00:00:00.000Z";
const PLAN = pagePlan();
delete PLAN.checks;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

afterEach(() => { vi.restoreAllMocks(); uninstallLearningTaskEnd(); });

/** A web person's sign-in record (no `developerId` attribute, so the harness does not make them a member by itself) and, unless `role` is null, their membership. */
function person(h: Harness, id: string, options: { role?: string | null; orgId?: OrgId; revoked?: boolean; extra?: Item } = {}): void {
  h.db.set({ pk: `DEVELOPER#${id}`, sk: "META", provider: "cloud", issuer: "https://cloud.test", subject: id.slice(0, 8), displayName: "Pat Web", firstSignInAt: "x", lastSignInAt: "x", revoked: options.revoked === true, ...options.extra });
  if (options.role !== null) seedMembership(h.db, id, { orgId: options.orgId ?? TEST_ORG, role: (options.role ?? "member") as never });
}

/** The verified "Sign in with Slack" link, as the sign-in function writes it: the forward link row, the reverse item and the account's one-Slack-link marker, in one go. */
function link(h: Harness, target: string, options: { slackUser?: string; linkedAt?: string } = {}): void {
  const slackUser = options.slackUser ?? SLACK_USER;
  const key = developerIdForSlackUser(slackUser);
  const at = options.linkedAt ?? LINKED_AT;
  const body = { entityType: "IDENTITY_LINK", developerId: target, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUser, linkedAt: at, lastSignInAt: at };
  h.db.set({ pk: `SIGNIN_IDENTITY#${key}`, sk: "META", ...body });
  h.db.set({ pk: `DEVELOPER#${target}`, sk: `IDENTITY#${key}`, ...body });
  const record = h.db.get(`DEVELOPER#${target}`, "META");
  if (record !== undefined) h.db.set({ ...record, slackLinkedIdentity: key });
}

/** The unlink, as `unlinkIdentity` writes it in its one transaction: the tombstone, the reverse item gone, the account's marks. */
function unlink(db: FakeDynamoDb, from: string, slackUser = SLACK_USER): void {
  const key = developerIdForSlackUser(slackUser);
  const at = new Date().toISOString();
  const row = db.get(`SIGNIN_IDENTITY#${key}`, "META")!;
  db.set({ ...row, unlinkedFrom: from, unlinkedAt: at });
  db.delete({ pk: `DEVELOPER#${from}`, sk: `IDENTITY#${key}` });
  const record = db.get(`DEVELOPER#${from}`, "META");
  if (record !== undefined) {
    const { slackLinkedIdentity: _marker, ...rest } = record;
    void _marker;
    db.set({ ...rest, [`identityUnlinked#${key}`]: at, [`sessionsEndedByIdentity#${key}`]: at, "sessionsEndedByMethod#slack": at });
  }
}

/** Runs `effect` just before the first transaction that `match` picks, then lets that transaction through: a write that commits in the window after the seat was read. */
function beforeTransaction(h: Harness, match: (items: Item[]) => boolean, effect: () => void): { fired: () => boolean } {
  const original = h.db.send;
  let fired = false;
  h.db.send = async (command: never) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    if (!fired && name === "TransactWriteCommand" && match(((command as { input: { TransactItems?: Item[] } }).input.TransactItems ?? []))) {
      fired = true;
      effect();
    }
    return original(command);
  };
  return { fired: () => fired };
}
const writesTask = (items: Item[], taskId?: string) => items.some((entry) => {
  const action = Object.values(entry)[0] as { Item?: Item; Key?: Item };
  const key = action.Item ?? action.Key;
  return typeof key?.pk === "string" && key.pk.startsWith("DEVTASK#") && key.sk === "META" && (taskId === undefined || key.pk === `DEVTASK#${taskId}`);
});

const threadOf = (ts: string) => ({ teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: ts });
async function slackStart(h: Harness, ts: string, userId = SLACK_USER) {
  return h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: threadOf(ts), userId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() }) as Promise<{ statusCode: number; body: string }>;
}
const taskIdOf = (response: { body: string }) => String((JSON.parse(response.body) as { taskId?: string }).taskId);
const taskOf = (h: Harness, taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as (Item & { developerId: string; currentOwner?: { developerId: string }; createdAt: string; workspaceId: string; workflow: WorkflowSnapshot }) | undefined;
const taskCount = (h: Harness) => h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META").length;
const stop = (h: Harness, ts: string, userId = SLACK_USER) => h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: threadOf(ts), userId }) as Promise<{ statusCode: number; body: string }>;
const deps = (h: Harness) => brokerDependencies(h.brokerInput as never);
const codeOf = async (run: () => Promise<unknown>) => run().then(() => "ok", (error: { code?: string }) => error.code ?? "error");

/** A linked world: the web account PERSON is a member and Maya's Slack account is linked to it. */
async function linkedWorld(options: { role?: string | null } = {}) {
  const h = await createSingleAnswerPlanBroker();
  person(h, PERSON, { role: options.role ?? "member" });
  link(h, PERSON);
  return h;
}

/** A task created under the bare Slack id, as the code before this lane wrote it for a linked account (the Slack account is not linked while it starts; the link is dated before it). */
async function preLaneSlackTask(h: Harness, ts: string): Promise<string> {
  const started = await slackStart(h, ts);
  expect(started.statusCode, started.body).toBe(200);
  const taskId = taskIdOf(started);
  expect(taskOf(h, taskId)!.developerId).toBe(SLACK_ID);
  return taskId;
}

/** A Slack-started task whose plan waits for its owner's decision. */
async function waitingPlan(h: Harness, ts: string): Promise<{ taskId: string; decide: (extra?: Item) => Promise<{ statusCode: number; body: string; requestId: string }> }> {
  const started = await slackStart(h, ts);
  expect(started.statusCode, started.body).toBe(200);
  const taskId = taskIdOf(started);
  const record = taskOf(h, taskId)!;
  const operations = () => h.db.find((item) => item.pk === `WORKSPACE#${record.workspaceId}` && item.entityType === "OPERATION");
  await h.finish(record.workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const planning = operations().find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
  await h.artifact(record.workspaceId, String(planning.id), "plan.md", planAnswer(PLAN));
  await h.finish(record.workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const decide = async (extra: Item = {}) => {
    const workflow = taskOf(h, taskId)!.workflow;
    const requestId = randomUUID();
    const response = await h.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId, userId: SLACK_USER, thread: threadOf(ts), requestId,
      expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "REQUEST_CHANGES", reason: "Use the shared helper.", selectedOptionalCheckIds: [], ...extra }) as { statusCode: number; body: string };
    return { ...response, requestId };
  };
  return { taskId, decide };
}
const decided = (h: Harness, taskId: string, requestId: string) => (taskOf(h, taskId)!.workflow.decisions ?? []).some((decision) => decision.requestId === requestId);

describe("0.5.18x: a linked Slack account acts as its web account (DECISIONS 183(d))", () => {
  it("baseline: a task started from Slack while linked belongs to the web account from the start (owner, creator, initiator); the Slack id is the channel identity only", async () => {
    const h = await linkedWorld();
    const started = await slackStart(h, "1695500000.000201");
    expect(started.statusCode, started.body).toBe(200);
    const task = taskOf(h, taskIdOf(started))!;
    expect(task).toMatchObject({ developerId: PERSON, slackUserId: SLACK_USER });
    expect(task.initiatorId ?? task.developerId).toBe(PERSON);
    expect(h.db.find((item) => item.pk === `DEVELOPER#${SLACK_ID}` && String(item.sk).startsWith("TASK#"))).toEqual([]);
  });
});

describe("threat 1: the unlink race", () => {
  it("1a: an unlink that commits between the seat read and the task-start write refuses the start (nothing is written)", async () => {
    const h = await linkedWorld();
    const before = taskCount(h);
    const window = beforeTransaction(h, (items) => writesTask(items), () => unlink(h.db, PERSON));
    const started = await slackStart(h, "1695500000.000211");
    expect(window.fired(), "the unlink landed in the window").toBe(true);
    expect(started.statusCode).not.toBe(200);
    expect(taskCount(h)).toBe(before);
  });

  it("1b: an unlink that commits between the seat read and a decision commit refuses the decision", async () => {
    const h = await linkedWorld();
    const plan = await waitingPlan(h, "1695500000.000212");
    expect(taskOf(h, plan.taskId)!.developerId, "the task is the web account's").toBe(PERSON);
    const window = beforeTransaction(h, (items) => writesTask(items, plan.taskId), () => unlink(h.db, PERSON));
    const answer = await plan.decide();
    expect(window.fired(), "the unlink landed in the window").toBe(true);
    expect(decided(h, plan.taskId, answer.requestId), answer.body).toBe(false);
  });

  it("1c: the merge press (a press that hands an older Slack-id task on): hands it on while linked; an unlink in the window refuses the hand-on", async () => {
    const control = await createSingleAnswerPlanBroker();
    person(control, PERSON);
    const handed = await preLaneSlackTask(control, "1695500000.000213");
    link(control, PERSON);
    await stop(control, "1695500000.000213");
    expect(taskOf(control, handed)!.currentOwner?.developerId, "positive control: the linked account's press hands it on").toBe(PERSON);

    const h = await createSingleAnswerPlanBroker();
    person(h, PERSON);
    const taskId = await preLaneSlackTask(h, "1695500000.000214");
    link(h, PERSON);
    const window = beforeTransaction(h, (items) => items.some((entry) => (entry.Update as { Key?: Item; UpdateExpression?: string } | undefined)?.Key?.pk === `DEVTASK#${taskId}`
      && String((entry.Update as { UpdateExpression?: string }).UpdateExpression).includes("currentOwner")), () => unlink(h.db, PERSON));
    await stop(h, "1695500000.000214");
    expect(window.fired(), "the unlink landed in the window").toBe(true);
    expect(taskOf(h, taskId)!.currentOwner?.developerId).not.toBe(PERSON);
  });
});

describe("threat 2: a stale identity carried in data", () => {
  it("after the unlink, a decision press whose payload names the old web account, and a queued thread reply, act as nobody", async () => {
    const h = await linkedWorld();
    const plan = await waitingPlan(h, "1695500000.000221");
    unlink(h.db, PERSON);
    const answer = await plan.decide({ developerId: PERSON, caller: { developerId: PERSON, orgId: TEST_ORG, orgRole: "owner" }, sessionId: "slack-workflow" });
    expect(answer.statusCode).not.toBe(200);
    expect(decided(h, plan.taskId, answer.requestId)).toBe(false);
    const note = await h.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId: plan.taskId, thread: threadOf("1695500000.000221"), userId: SLACK_USER, messageTs: "1695500002.000001", eventId: "EvStale1", text: "Change it." }) as { body: string };
    expect((JSON.parse(note.body) as { outcome?: string }).outcome).toBe("refused");
    // The old web id in a session record does not seat anyone either: the next Slack request is refused as not linked.
    expect(await codeOf(() => slackCallerFor(deps(h), SLACK_USER, SLACK_TEAM))).toBe("SLACK_ACCOUNT_NOT_LINKED");
  });
});

describe("threat 3: link takeover", () => {
  it("a link row with no reverse item (made from the Slack side alone) never seats the web account, and nothing is written", async () => {
    const h = await createSingleAnswerPlanBroker();
    person(h, PERSON, { role: "owner" });
    h.db.set({ pk: `SIGNIN_IDENTITY#${SLACK_ID}`, sk: "META", entityType: "IDENTITY_LINK", developerId: PERSON, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: SLACK_USER, linkedAt: LINKED_AT, lastSignInAt: LINKED_AT });
    const before = taskCount(h);
    expect((await slackStart(h, "1695500000.000231")).statusCode).toBe(403);
    expect(taskCount(h)).toBe(before);
  });

  it("a link row for ANOTHER Slack user's subject, or another provider, never seats", async () => {
    for (const forged of [{ subject: "U0SOMEONE01" }, { provider: "github" }]) {
      const h = await createSingleAnswerPlanBroker();
      person(h, PERSON, { role: "owner" });
      link(h, PERSON);
      h.db.set({ ...h.db.get(`SIGNIN_IDENTITY#${SLACK_ID}`, "META")!, ...forged });
      expect(await codeOf(() => slackCallerFor(deps(h), SLACK_USER, SLACK_TEAM)), JSON.stringify(forged)).toBe("FORBIDDEN");
    }
  });

  it("a replayed old sign-in (the tombstone of an earlier link) never seats, and the single-org implicit member does not come back through it", async () => {
    const h = await linkedWorld();
    unlink(h.db, PERSON);
    const before = taskCount(h);
    const started = await slackStart(h, "1695500000.000233");
    expect(started.statusCode).not.toBe(200);
    expect(JSON.parse(started.body)).toMatchObject({ error: { code: "SLACK_ACCOUNT_NOT_LINKED" } });
    expect(taskCount(h)).toBe(before);
  });

  it("a link made by a different web person seats THAT person, never the first one", async () => {
    const h = await createSingleAnswerPlanBroker();
    person(h, PERSON, { role: "owner" });
    person(h, PERSON_B);
    link(h, PERSON_B);
    const started = await slackStart(h, "1695500000.000234");
    expect(started.statusCode, started.body).toBe(200);
    expect(taskOf(h, taskIdOf(started))!.developerId).toBe(PERSON_B);
  });
});

describe("threat 4: re-link", () => {
  it("linked to A, unlinked, linked to B: acts as B from the next request, can do nothing to A's tasks from Slack, and A's tasks are not handed to B", async () => {
    const h = await createSingleAnswerPlanBroker();
    person(h, PERSON);
    person(h, PERSON_B);
    link(h, PERSON);
    const first = await slackStart(h, "1695500000.000241");
    const aTask = taskIdOf(first);
    expect(taskOf(h, aTask)!.developerId).toBe(PERSON);
    unlink(h.db, PERSON);
    // A bare-Slack-id task from A's time (made by the code before this lane while linked to A): older than B's link.
    h.db.set({ pk: `SIGNIN_IDENTITY#${SLACK_ID}`, sk: "META", entityType: "IDENTITY_LINK", developerId: PERSON, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: SLACK_USER, linkedAt: LINKED_AT, lastSignInAt: LINKED_AT, unlinkedFrom: PERSON, unlinkedAt: new Date().toISOString() });
    link(h, PERSON_B, { linkedAt: new Date(Date.now() + 60_000).toISOString() });
    const second = await slackStart(h, "1695500000.000242");
    expect(second.statusCode, second.body).toBe(200);
    expect(taskOf(h, taskIdOf(second))!.developerId).toBe(PERSON_B);
    // A's task: refused from Slack (B is not its owner) and left with A.
    const stopA = await stop(h, "1695500000.000241");
    expect(JSON.parse(stopA.body)).not.toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect(taskOf(h, aTask)).toMatchObject({ developerId: PERSON });
    expect(taskOf(h, aTask)!.currentOwner?.developerId ?? PERSON).toBe(PERSON);
    // An older bare-Slack-id task from before B's link is not handed to B.
    const old = "55555555-5555-4555-8555-555555555555";
    const createdAt = new Date(Date.now() - 1000).toISOString();
    h.db.set({ ...taskOf(h, aTask)!, pk: `DEVTASK#${old}`, taskId: old, developerId: SLACK_ID, ownerKey: SLACK_ID, provider: "slack", createdAt, share: { ...(taskOf(h, aTask)!.share as Item), threadTs: "1695500000.000243" } });
    h.db.set({ ...taskIndexKey(SLACK_ID, createdAt, old), taskId: old, status: "RUNNING" });
    h.db.set({ pk: `SLACK_THREAD#${SLACK_TEAM}#${SLACK_CHANNEL}#1695500000.000243`, sk: "TASK", taskId: old });
    await stop(h, "1695500000.000243");
    expect(taskOf(h, old)!.currentOwner?.developerId).not.toBe(PERSON_B);
  });
});

describe("threat 5: cross-company", () => {
  it("a link to a web account of another company is refused for writes AND reads; so is one whose company pointer moved after the link", async () => {
    for (const shape of ["other_company", "pointer_moved"] as const) {
      const h = await createSingleAnswerPlanBroker();
      if (shape === "other_company") person(h, PERSON, { orgId: OTHER_ORG });
      else {
        person(h, PERSON);
        h.db.set({ ...developerOrgKey(PERSON), entityType: "DEVELOPER_ORG", orgId: OTHER_ORG, role: "member", joinedAt: "x" });
      }
      link(h, PERSON);
      const before = taskCount(h);
      expect((await slackStart(h, "1695500000.000251")).statusCode, shape).toBe(403);
      expect(taskCount(h), shape).toBe(before);
      expect(await codeOf(() => slackRequesterStanding(deps(h), SLACK_USER, TEST_ORG, { allowUnlinked: true, allowReadOnly: true })), shape).toBe("FORBIDDEN");
    }
  });
});

describe("threat 6: role edges", () => {
  it("an Auditor web account: writes from Slack refused, reads allowed", async () => {
    const h = await linkedWorld({ role: "auditor" });
    expect((await slackStart(h, "1695500000.000261")).statusCode).toBe(403);
    expect((await slackRequesterStanding(deps(h), SLACK_USER, TEST_ORG, { allowUnlinked: true, allowReadOnly: true })).role).toBe("auditor");
  });

  it("a removed, banned, revoked web account, or one with no member row: refused, and nothing is written", async () => {
    const shapes = {
      removed: (h: Harness) => { h.db.delete(orgMemberKey(TEST_ORG, PERSON)); h.db.delete(developerOrgKey(PERSON)); h.db.set({ ...orgRemovedKey(TEST_ORG, PERSON), entityType: "ORG_REMOVED" }); },
      banned: (h: Harness) => { h.db.set({ ...orgBanKey(TEST_ORG, PERSON), entityType: "ORG_BAN" }); },
      bannedSlackId: (h: Harness) => { h.db.set({ ...orgBanKey(TEST_ORG, SLACK_ID), entityType: "ORG_BAN" }); },
      revoked: (h: Harness) => { h.db.set({ ...h.db.get(`DEVELOPER#${PERSON}`, "META")!, revoked: true }); },
      noMemberRow: (h: Harness) => { h.db.delete(orgMemberKey(TEST_ORG, PERSON)); h.db.delete(developerOrgKey(PERSON)); },
    };
    for (const [name, apply] of Object.entries(shapes)) {
      const h = await linkedWorld();
      apply(h);
      const before = taskCount(h);
      const started = await slackStart(h, "1695500000.000262");
      expect(started.statusCode, name).toBe(403);
      expect(taskCount(h), name).toBe(before);
      expect(await codeOf(() => slackRequesterStanding(deps(h), SLACK_USER, TEST_ORG, { allowUnlinked: true, allowReadOnly: true })), name).not.toBe("ok");
    }
  });
});

describe("threat 7: merge and link chains", () => {
  it("a link to an account merged into a survivor acts as the survivor", async () => {
    const h = await createSingleAnswerPlanBroker();
    person(h, PERSON, { role: null, extra: { mergedInto: SURVIVOR } });
    person(h, SURVIVOR);
    link(h, PERSON);
    const started = await slackStart(h, "1695500000.000271");
    expect(started.statusCode, started.body).toBe(200);
    expect(taskOf(h, taskIdOf(started))!.developerId).toBe(SURVIVOR);
  });

  it("a loop, or a chain longer than MERGE_HOPS_MAX, is refused, never guessed", async () => {
    const loop = await createSingleAnswerPlanBroker();
    person(loop, PERSON, { role: null, extra: { mergedInto: SURVIVOR } });
    person(loop, SURVIVOR, { extra: { mergedInto: PERSON } });
    link(loop, PERSON);
    expect((await slackStart(loop, "1695500000.000272")).statusCode).toBe(403);

    const long = await createSingleAnswerPlanBroker();
    const ids = [PERSON, ...Array.from({ length: 5 }, (_, index) => String(index + 1).repeat(64)), SURVIVOR];
    for (let index = 0; index < ids.length - 1; index += 1) person(long, ids[index]!, { role: null, extra: { mergedInto: ids[index + 1] } });
    person(long, SURVIVOR);
    link(long, PERSON);
    // The link plus six merges: seven hops in all, past the bound of five.
    const before = taskCount(long);
    expect((await slackStart(long, "1695500000.000273")).statusCode).toBe(403);
    expect(taskCount(long)).toBe(before);
  });
});

describe("threat 8: no union of rights", () => {
  it("the Slack id is itself an owner and has a project grant; the linked account acts with the web account's role and grant only", async () => {
    const h = await linkedWorld();
    seedMembership(h.db, SLACK_ID, { orgId: TEST_ORG, role: "owner" });
    h.db.set({ ...projectMemberKey(TEST_ORG, SLACK_ID, "payments"), entityType: "MEMBERSHIP", ownerKey: SLACK_ID, projectName: "payments", role: "maintainer" });
    const caller = await slackCallerFor(deps(h), SLACK_USER, SLACK_TEAM);
    expect(caller).toMatchObject({ developerId: PERSON, orgRole: "member" });
    const role = await slackRequesterProjectRole(deps(h), TEST_ORG, SLACK_USER, "payments");
    expect(role).not.toBe("maintainer");
  });
});

describe("threat 9: one rule everywhere", () => {
  it("ingress, the service-route rule, the project role and the spend's member name the same person with the same role; after the unlink all refuse", async () => {
    const h = await linkedWorld({ role: "admin" });
    const d = deps(h);
    const caller = await slackCallerFor(d, SLACK_USER, SLACK_TEAM);
    const standing = await slackRequesterStanding(d, SLACK_USER, TEST_ORG, { allowUnlinked: true });
    expect(caller).toMatchObject({ developerId: PERSON, orgRole: "admin" });
    expect({ person: standing.ids.at(-1), role: standing.role }).toEqual({ person: PERSON, role: "admin" });
    expect(await slackRequesterProjectRole(d, TEST_ORG, SLACK_USER, "payments")).toBeDefined();
    // R31: the spend counts once, against the web person.
    expect(await linkedRequester(d, TEST_ORG, { teamId: SLACK_TEAM, userId: SLACK_USER } as never)).toBe(PERSON);
    unlink(h.db, PERSON);
    expect(await codeOf(() => slackCallerFor(d, SLACK_USER, SLACK_TEAM))).toBe("SLACK_ACCOUNT_NOT_LINKED");
    expect(await codeOf(() => slackRequesterStanding(d, SLACK_USER, TEST_ORG, { allowUnlinked: true }))).toBe("SLACK_ACCOUNT_NOT_LINKED");
    expect(await codeOf(() => slackRequesterProjectRole(d, TEST_ORG, SLACK_USER, "payments"))).toBe("SLACK_ACCOUNT_NOT_LINKED");
    expect(await linkedRequester(d, TEST_ORG, { teamId: SLACK_TEAM, userId: SLACK_USER } as never)).toBeUndefined();
  });
});

describe("threat 10: hand-on boundaries", () => {
  function seatDeps(h: Harness) {
    return { documentClient: h.db, tableName: "state", now: () => Date.now(), developer: { signInTableName: "signin" }, orgs: new OrgStore({ documentClient: h.db, tableName: "state", now: Date.now }), agents: {} };
  }
  const seat = (h: Harness, taskId: string, actorId: string) => seatTaskOwner(seatDeps(h) as never, TEST_ORG, taskOf(h, taskId) as unknown as DeveloperTaskRecord, actorId);

  it("the linked web account's own web action hands an older Slack-id task on; another member's never does", async () => {
    const h = await createSingleAnswerPlanBroker();
    person(h, PERSON);
    const taskId = await preLaneSlackTask(h, "1695500000.000301");
    link(h, PERSON);
    expect(await seat(h, taskId, OMAR.developerId)).not.toMatchObject({ kind: "seated" });
    expect(taskOf(h, taskId)!.currentOwner?.developerId).not.toBe(PERSON);
    expect(await seat(h, taskId, PERSON)).toMatchObject({ kind: "seated", handedOn: true, caller: { developerId: PERSON } });
    expect(taskOf(h, taskId)!.currentOwner?.developerId).toBe(PERSON);
  });

  it("never by another Slack account, never when closed, never across companies, never after an unlink", async () => {
    // Another Slack account (linked to its own person) pressing on it.
    const other = await createSingleAnswerPlanBroker();
    person(other, PERSON);
    person(other, PERSON_B);
    const t1 = await preLaneSlackTask(other, "1695500000.000302");
    link(other, PERSON);
    link(other, PERSON_B, { slackUser: OTHER_SLACK_USER });
    await stop(other, "1695500000.000302", OTHER_SLACK_USER);
    expect(taskOf(other, t1)!.currentOwner?.developerId ?? SLACK_ID, "another Slack account").toBe(SLACK_ID);
    // Closed.
    const closed = await createSingleAnswerPlanBroker();
    person(closed, PERSON);
    const t2 = await preLaneSlackTask(closed, "1695500000.000303");
    link(closed, PERSON);
    closed.db.set({ ...taskOf(closed, t2)!, closedAt: new Date().toISOString() });
    expect(await seat(closed, t2, PERSON), "closed").not.toMatchObject({ kind: "seated", handedOn: true });
    expect(taskOf(closed, t2)!.currentOwner, "closed").toBeUndefined();
    // Another company's task.
    const elsewhere = await createSingleAnswerPlanBroker();
    person(elsewhere, PERSON);
    const t3 = await preLaneSlackTask(elsewhere, "1695500000.000304");
    link(elsewhere, PERSON);
    elsewhere.db.set({ ...taskOf(elsewhere, t3)!, orgId: OTHER_ORG });
    await stop(elsewhere, "1695500000.000304");
    expect(taskOf(elsewhere, t3)!.currentOwner, "other company").toBeUndefined();
    // After an unlink.
    const after = await createSingleAnswerPlanBroker();
    person(after, PERSON);
    const t4 = await preLaneSlackTask(after, "1695500000.000305");
    link(after, PERSON);
    unlink(after.db, PERSON);
    await stop(after, "1695500000.000305");
    expect(await seat(after, t4, PERSON), "after unlink").not.toMatchObject({ kind: "seated", handedOn: true });
    expect(taskOf(after, t4)!.currentOwner, "after unlink").toBeUndefined();
  });
});

describe("threat 11: the backfill", () => {
  const OPEN = "11111111-1111-4111-8111-111111111111";
  const CLOSED = "22222222-2222-4222-8222-222222222222";
  const TOMBSTONED = "33333333-3333-4333-8333-333333333333";
  const CREATED = "2026-11-13T09:00:00.000Z";
  const LATE_SLACK = "U0LATE0001";

  function store() {
    const db = new FakeDynamoDb();
    const record = (id: string, extra: Item = {}) => db.set({ pk: `DEVELOPER#${id}`, sk: "META", provider: "cloud", displayName: "Person", revoked: false, ...extra });
    record(PERSON);
    record(PERSON_B);
    db.set({ ...developerOrgKey(PERSON), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "member" });
    db.set({ ...developerOrgKey(PERSON_B), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "member" });
    const linkRow = (slackUser: string, target: string, extra: Item = {}) => {
      const key = developerIdForSlackUser(slackUser);
      const body = { entityType: "IDENTITY_LINK", developerId: target, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUser, linkedAt: LINKED_AT, lastSignInAt: LINKED_AT };
      db.set({ pk: `SIGNIN_IDENTITY#${key}`, sk: "META", ...body, ...extra });
      if (extra.unlinkedFrom === undefined) db.set({ pk: `DEVELOPER#${target}`, sk: `IDENTITY#${key}`, ...body });
    };
    linkRow(SLACK_USER, PERSON);
    linkRow(LATE_SLACK, PERSON_B, { unlinkedFrom: PERSON_B, unlinkedAt: CREATED });
    const task = (taskId: string, developerId: string, extra: Item = {}) => {
      db.set({ pk: `DEVTASK#${taskId}`, sk: "META", taskId, orgId: TEST_ORG, developerId, developerName: "Person", provider: "slack", project: "payments", createdAt: CREATED, ...extra });
      db.set({ ...taskIndexKey(developerId, CREATED, taskId), taskId, status: "RUNNING" });
    };
    task(OPEN, SLACK_ID);
    task(CLOSED, SLACK_ID, { closedAt: CREATED });
    task(TOMBSTONED, developerIdForSlackUser(LATE_SLACK));
    return db;
  }
  const run = (db: { send(command: unknown): Promise<unknown> }, apply: boolean) => backfillMergedTaskOwners({ documentClient: db, stateTable: "state", signInTable: "signin", now: () => Date.parse("2026-11-13T10:00:00.000Z") }, { apply });

  it("dry run by default; only active links; a second apply hands on 0", async () => {
    const db = store();
    const pristine = JSON.stringify(db.find(() => true));
    const dry = await run(db, false);
    expect(dry.taskIds).toEqual([OPEN]);
    expect(JSON.stringify(db.find(() => true)), "a dry run writes nothing").toBe(pristine);
    const applied = await run(db, true);
    expect(applied.taskIds).toEqual([OPEN]);
    expect(db.get(`DEVTASK#${OPEN}`, "META")).toMatchObject({ currentOwner: { developerId: PERSON } });
    expect(db.get(`DEVTASK#${CLOSED}`, "META")).not.toHaveProperty("currentOwner");
    expect(db.get(`DEVTASK#${TOMBSTONED}`, "META")).not.toHaveProperty("currentOwner");
    const again = await run(db, true);
    expect(again.outcomes.handed).toBe(0);
  });

  it("an account unlinked between the dry run and the apply (or during the apply) is not handed on", async () => {
    const db = store();
    expect((await run(db, false)).taskIds).toEqual([OPEN]);
    unlink(db, PERSON);
    expect((await run(db, true)).taskIds).toEqual([]);
    expect(db.get(`DEVTASK#${OPEN}`, "META")).not.toHaveProperty("currentOwner");
    // During the apply: the unlink commits just before the hand-on's write.
    const racing = store();
    let fired = false;
    const client = { send: async (command: unknown) => {
      if (!fired && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { fired = true; unlink(racing, PERSON); }
      return racing.send(command as never);
    } };
    expect((await run(client, true)).taskIds).toEqual([]);
    expect(fired).toBe(true);
    expect(racing.get(`DEVTASK#${OPEN}`, "META")).not.toHaveProperty("currentOwner");
  });
});

describe("threat 12: lessons (LP-2b restated for linked people)", () => {
  async function lessonsWorld(h: Harness, taskId: string) {
    const dependencies = {
      ...h.brokerInput, developer: { ...(h.brokerInput as { developer: object }).developer, signInTableName: "signin" },
      teamRecord: { table: { documentClient: new FakeDynamoDb(), tableName: "record" }, edition: "public", emitter: { sendBack: async () => undefined }, taskVisibility: async () => ({ kind: "shared" }) },
      modelAccess: { access: { learningCompletion: async () => ({ text: "{}", model: "m" }) }, proxyUrl: "http://proxy" },
    } as Record<string, unknown>;
    installLessons(dependencies as never);
    const learning = dependencies["learning"] as NonNullable<ReturnType<typeof learningDepsFor>>;
    const read = async () => (await learning.source.read({ workspaceId: TEST_ORG, taskId }))!;
    const verdict = async () => { const base = await read(); return buildReflectorInput(buildTaskReflectSubject({ ...base.facts, sendBacks: [] })); };
    return { read, verdict };
  }

  it("before the link the Slack account names nobody; during the link the task is the person's; after the unlink it stays attributed to them; an erase of the person removes it; another person's erase does not", async () => {
    // Before any link: the single-org implicit member starts under the bare Slack id, which names nobody.
    const before = await createSingleAnswerPlanBroker();
    person(before, PERSON);
    grantProject(before.db, { developerId: PERSON, name: "Pat", provider: "cloud", sessionId: "s-p" });
    const t0 = await preLaneSlackTask(before, "1695500000.000321");
    expect((await (await lessonsWorld(before, t0)).read()).facts.rest).toMatchObject({ initiatorTrust: "outsider" });

    const h = await linkedWorld();
    grantProject(h.db, { developerId: PERSON, name: "Pat", provider: "cloud", sessionId: "s-p" });
    const started = await slackStart(h, "1695500000.000322");
    const taskId = taskIdOf(started);
    const lessons = await lessonsWorld(h, taskId);
    const during = await lessons.read();
    expect(during.facts.task.developerId).toBe(PERSON);
    expect(during.facts.rest).toMatchObject({ initiatorTrust: "member", intentTrust: "member" });
    expect(await lessons.verdict()).toMatchObject({ eligible: true });
    unlink(h.db, PERSON);
    const after = await lessons.read();
    expect(after.facts.task.developerId, "still the person's after the unlink").toBe(PERSON);
    expect(after.facts.rest).toMatchObject({ initiatorTrust: "member" });
    expect(await lessons.verdict()).toMatchObject({ eligible: true });
    // Another person's erase never touches it.
    h.db.set({ ...erasedPersonKey(TEST_ORG, { developerId: PERSON_B }), entityType: "ERASED_PERSON", orgId: TEST_ORG });
    expect(await lessons.verdict()).toMatchObject({ eligible: true });
    // The person's erase removes it.
    h.db.set({ ...erasedPersonKey(TEST_ORG, { developerId: PERSON }), entityType: "ERASED_PERSON", orgId: TEST_ORG });
    expect(await lessons.verdict()).toMatchObject({ eligible: false });
  });
});

describe("threat 13: unchanged before a link", () => {
  it("before any link, a Slack account on a single-org install is still the implicit member acting as its own Slack id", async () => {
    const h = await createSingleAnswerPlanBroker();
    person(h, PERSON);
    const started = await slackStart(h, "1695500000.000331");
    expect(started.statusCode, started.body).toBe(200);
    expect(taskOf(h, taskIdOf(started))!.developerId).toBe(SLACK_ID);
  });
});

describe("threat 14: words and logs", () => {
  it("refusals name no Slack id and no account id; each refusal reason has its own log code", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const shapes: Record<string, (h: Harness) => void> = {
      link_unverified: (h) => { h.db.delete({ pk: `DEVELOPER#${PERSON}`, sk: `IDENTITY#${SLACK_ID}` }); },
      survivor_other_company: (h) => { h.db.set({ ...developerOrgKey(PERSON), entityType: "DEVELOPER_ORG", orgId: OTHER_ORG, role: "member", joinedAt: "x" }); },
      survivor_not_member: (h) => { h.db.delete(orgMemberKey(TEST_ORG, PERSON)); h.db.delete(developerOrgKey(PERSON)); },
      survivor_revoked: (h) => { h.db.set({ ...h.db.get(`DEVELOPER#${PERSON}`, "META")!, revoked: true }); },
      link_unlinked: (h) => { unlink(h.db, PERSON); },
    };
    const reasons = new Set<string>();
    for (const [reason, apply] of Object.entries(shapes)) {
      const h = await linkedWorld();
      apply(h);
      lines.length = 0;
      const started = await slackStart(h, "1695500000.000341");
      expect(started.statusCode, reason).not.toBe(200);
      for (const secret of [SLACK_ID, PERSON, SLACK_USER]) expect(started.body, reason).not.toContain(secret);
      const seen = lines.map((line) => { try { return JSON.parse(line) as Item; } catch { return {}; } }).filter((line) => line.event === "slack.linked_seat_refused");
      expect(seen.map((line) => line.reason), reason).toContain(reason);
      for (const line of seen) for (const secret of [SLACK_ID, PERSON, SLACK_USER]) expect(JSON.stringify(line)).not.toContain(secret);
      reasons.add(reason);
    }
    expect(reasons.size).toBe(Object.keys(shapes).length);
  });
});
