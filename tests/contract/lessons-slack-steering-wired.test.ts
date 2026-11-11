// Lessons sweep, lane D: a task steered through Slack thread replies, through the REAL Slack ingress path (start-workflow, then thread-note events saved by recordSlackThreadNote) and the REAL production wiring of the
// lessons subject source (`learningDepsFor`). A reply's author counts only through a verified Rovara link, and only as a member of the task's project.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SLACK_OIDC_ISSUER, projectMemberKey } from "@rovara-code/contracts";
import { erasedPersonKey } from "@agentx/cloud-contracts";
import { installLessons } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import type { learningDepsFor } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { uninstallLearningTaskEnd } from "../../packages/broker/src/aws/broker/learning-wiring.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { buildReflectorInput } from "../../packages/broker/src/lessons/reflect-input.js";
import { buildTaskReflectSubject } from "../../packages/broker/src/lessons/task-subject.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { recordSessionNote } from "../../packages/broker/src/aws/developer-tasks/thread-notes.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, grantProject, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { uninstallLearningTaskEnd(); });

const DANA: Developer = { developerId: "a".repeat(64), name: "Dana", provider: "oidc", sessionId: "s-dana" };
const DANA_SLACK = "U0DANA0001";
/** A Slack-started task is created under the Slack-derived developer id (`slackWorkflowCaller`). Maya signed in with Slack, so that id is her own developer, a member of the project, and her Slack link points at herself. */
const MAYA_SLACK_DEV = developerIdForSlackUser(MAYA.slackUserId!);
const MAYA_NATIVE: Developer = { ...MAYA, developerId: MAYA_SLACK_DEV };
const STRANGER_SLACK = "U0STRANGER";

/** The Sign in with Slack link row: the Slack account is `developer`'s. */
function linkSlack(db: FakeDynamoDb, slackUserId: string, developerId: string): void {
  db.set({ pk: `SIGNIN_IDENTITY#${ownerKeyForSubject(SLACK_OIDC_ISSUER, slackUserId)}`, sk: "META", entityType: "IDENTITY_LINK", developerId, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId, linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" });
}

async function world(options: { replies: Array<{ slackUserId: string; text: string }>; link?: Array<[string, Developer]>; project?: Developer[]; webCreator?: true }) {
  const harness = await createSingleAnswerPlanBroker();
  seedMembership(harness.db, DANA.developerId);
  harness.db.set({ pk: `DEVELOPER#${DANA.developerId}`, sk: "META", developerId: DANA.developerId, provider: "oidc", displayName: "Dana", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  // webCreator: Maya is a member through her WEB account (MAYA); the Slack-derived id the task is created under has no membership of its own.
  const maya = options.webCreator === true ? MAYA : MAYA_NATIVE;
  if (options.webCreator !== true) {
    seedMembership(harness.db, MAYA_SLACK_DEV);
    harness.db.set({ pk: `DEVELOPER#${MAYA_SLACK_DEV}`, sk: "META", developerId: MAYA_SLACK_DEV, provider: "slack", displayName: "Maya", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  }
  for (const who of options.project ?? [maya]) grantProject(harness.db, who);
  for (const [slackUserId, who] of options.link ?? [[MAYA.slackUserId!, maya]]) linkSlack(harness.db, slackUserId, who.developerId);
  const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000031" };
  const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA.slackUserId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
  const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
  const workspaceId = String(harness.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
  const outcomes: string[] = [];
  for (const [index, reply] of options.replies.entries()) {
    const sent = await harness.handler({ source: "agentx.slack-ingress", action: "thread-note", taskId, thread, userId: reply.slackUserId, messageTs: `1695500002.00000${String(index)}`, eventId: `EvR${String(index)}`, text: reply.text });
    outcomes.push((JSON.parse(sent.body) as { outcome: string }).outcome);
  }
  const dependencies = {
    ...harness.brokerInput, developer: { ...(harness.brokerInput as { developer: object }).developer, signInTableName: "signin" },
    teamRecord: { table: { documentClient: new FakeDynamoDb(), tableName: "record" }, edition: "public", emitter: { sendBack: async () => undefined }, taskVisibility: async () => ({ kind: "shared" }) },
    modelAccess: { access: { learningCompletion: async () => ({ text: "{}", model: "m" }) }, proxyUrl: "http://proxy" },
  } as Record<string, unknown>;
  installLessons(dependencies as never);
  const learning = dependencies["learning"] as NonNullable<ReturnType<typeof learningDepsFor>>;
  const read = async () => (await learning.source.read({ workspaceId: TEST_ORG, taskId }))!;
  const verdict = async () => { const base = await read(); return buildReflectorInput(buildTaskReflectSubject({ ...base.facts, sendBacks: [] })); };
  return { harness, taskId, workspaceId, outcomes, read, verdict };
}

describe("a task steered through Slack replies, through the real Slack path and the production wiring", () => {
  it("the owner's reply, from a Slack account linked to a project member: the reply is saved, the author is named, and the task is eligible", async () => {
    const w = await world({ replies: [{ slackUserId: MAYA.slackUserId!, text: "Keep the old flag." }] });
    expect(w.outcomes).toEqual(["captured"]);
    const base = await w.read();
    expect(base.facts.rest.steeringTrust).toEqual(["member"]);
    expect(await w.verdict()).toMatchObject({ eligible: true });
  });

  it("a teammate's reply from an UNLINKED Slack account (the single-org install lets them reply) stays an outsider: the task is ineligible", async () => {
    const w = await world({ replies: [{ slackUserId: MAYA.slackUserId!, text: "Keep the old flag." }, { slackUserId: STRANGER_SLACK, text: "Also change the colour." }] });
    expect(w.outcomes).toEqual(["captured", "captured"]);
    expect((await w.read()).facts.rest.steeringTrust).toContain("outsider");
    expect(await w.verdict()).toMatchObject({ eligible: false, reason: "outsider_steered" });
  });

  it("a teammate linked to a Rovara person who is a project member: eligible; the same teammate with no project role: ineligible", async () => {
    const linked = await world({ replies: [{ slackUserId: MAYA.slackUserId!, text: "Keep the old flag." }, { slackUserId: DANA_SLACK, text: "Check mobile." }], link: [[MAYA.slackUserId!, MAYA_NATIVE], [DANA_SLACK, DANA]], project: [MAYA_NATIVE, DANA] });
    expect((await linked.read()).facts.rest.steeringTrust).toEqual(["member"]);
    expect(await linked.verdict()).toMatchObject({ eligible: true });
    const noRole = await world({ replies: [{ slackUserId: MAYA.slackUserId!, text: "Keep the old flag." }, { slackUserId: DANA_SLACK, text: "Check mobile." }], link: [[MAYA.slackUserId!, MAYA_NATIVE], [DANA_SLACK, DANA]], project: [MAYA_NATIVE] });
    expect((await noRole.read()).facts.rest.steeringTrust).toContain("outsider");
    expect(await noRole.verdict()).toMatchObject({ eligible: false });
  });

  it("a link the person removed (unlinked their Slack account) stops counting on the next read", async () => {
    const w = await world({ replies: [{ slackUserId: MAYA.slackUserId!, text: "Keep the old flag." }, { slackUserId: DANA_SLACK, text: "Check mobile." }], link: [[MAYA.slackUserId!, MAYA_NATIVE], [DANA_SLACK, DANA]], project: [MAYA_NATIVE, DANA] });
    expect((await w.read()).facts.rest.steeringTrust).toEqual(["member"]);
    const key = `SIGNIN_IDENTITY#${ownerKeyForSubject(SLACK_OIDC_ISSUER, DANA_SLACK)}`;
    w.harness.db.set({ ...w.harness.db.get(key, "META")!, unlinkedFrom: DANA.developerId, unlinkedAt: "2026-11-02T00:00:00.000Z" });
    expect((await w.read()).facts.rest.steeringTrust).toContain("outsider");
  });

  it("a person erased after they replied: the task is ineligible on the next read and none of the worker-written text (which quotes replies) is read", async () => {
    const w = await world({ replies: [{ slackUserId: MAYA.slackUserId!, text: "Keep the old flag." }, { slackUserId: DANA_SLACK, text: "Check mobile." }], link: [[MAYA.slackUserId!, MAYA_NATIVE], [DANA_SLACK, DANA]], project: [MAYA_NATIVE, DANA] });
    expect(await w.verdict()).toMatchObject({ eligible: true });
    // The Team record's permanent erased marker for Dana (the person the reply's Slack account is linked to; the install's one table holds it).
    w.harness.db.set({ ...erasedPersonKey(TEST_ORG, { developerId: DANA.developerId }), entityType: "ERASED_PERSON", orgId: TEST_ORG });
    expect((await w.read()).facts.rest.steeringTrust).toContain("outsider");
    expect(await w.verdict()).toMatchObject({ eligible: false, reason: "outsider_steered" });
  });
});

describe("a task started in Slack by a member who is linked through a web account (LP-2b)", () => {
  const replies = [{ slackUserId: MAYA.slackUserId!, text: "Keep the old flag." }];

  it("the creator is read as the linked web account: a member, and the task is eligible with them as the initiator", async () => {
    const w = await world({ replies, webCreator: true });
    const base = await w.read();
    expect(base.facts.rest).toMatchObject({ initiatorTrust: "member", intentTrust: "member", steeringTrust: ["member"] });
    expect(base.facts.task.developerId).toBe(MAYA.developerId);
    expect(await w.verdict()).toMatchObject({ eligible: true });
  });

  it("a creator whose Slack account is not linked to anyone stays an outsider", async () => {
    const w = await world({ replies, webCreator: true, link: [] });
    expect((await w.read()).facts.rest).toMatchObject({ initiatorTrust: "outsider", intentTrust: "outsider" });
    expect(await w.verdict()).toMatchObject({ eligible: false });
  });

  it("the link removed after the task started: the creator is an outsider again on the next read", async () => {
    const w = await world({ replies, webCreator: true });
    expect(await w.verdict()).toMatchObject({ eligible: true });
    const key = `SIGNIN_IDENTITY#${ownerKeyForSubject(SLACK_OIDC_ISSUER, MAYA.slackUserId!)}`;
    w.harness.db.set({ ...w.harness.db.get(key, "META")!, unlinkedFrom: MAYA.developerId, unlinkedAt: "2026-11-02T00:00:00.000Z" });
    expect(await w.verdict()).toMatchObject({ eligible: false, reason: "outsider_initiated" });
  });

  it("the linked web account removed from the project: ineligible (the live project role decides)", async () => {
    const w = await world({ replies, webCreator: true });
    w.harness.db.delete(projectMemberKey(TEST_ORG, MAYA.developerId, "payments"));
    expect((await w.read()).facts.rest).toMatchObject({ initiatorTrust: "outsider", intentTrust: "outsider" });
    expect(await w.verdict()).toMatchObject({ eligible: false });
  });

  it("a message a member sent to the agent from a session (saved by the real session-note path) is named; a sender with no project role is not", async () => {
    const w = await world({ replies, webCreator: true });
    const send = async (who: Developer, messageId: string) => recordSessionNote({ documentClient: w.harness.db, tableName: "state", now: Date.now },
      { taskId: w.taskId, source: "app", developerId: who.developerId, name: who.name, isOwner: false, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", messageId, text: "Please also add a test." });
    expect(await send(MAYA, "msg_aaaaaaaaaaaaaaaaaaaa")).toMatchObject({ outcome: "captured" });
    expect((await w.read()).facts.rest.steeringTrust).toEqual(["member"]);
    expect(await w.verdict()).toMatchObject({ eligible: true });
    expect(await send(OMAR, "msg_bbbbbbbbbbbbbbbbbbbb")).toMatchObject({ outcome: "captured" });
    expect((await w.read()).facts.rest.steeringTrust).toContain("outsider");
    expect(await w.verdict()).toMatchObject({ eligible: false });
  });
});
