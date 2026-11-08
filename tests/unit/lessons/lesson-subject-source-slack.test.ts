// Lessons sweep, lane D (owner decision 43 item 4): a task steered through Slack thread replies feeds lessons when every reply's author is named through a VERIFIED Rovara link and is a project member.
// The subject source names the authors (`slackAuthor`, `threadNotes`); the resolver (`lessonSlackAuthor`) proves the link. Every doubt is an outsider (fail closed).
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SLACK_OIDC_ISSUER, slackTeamOrgKey } from "@agentx/contracts";
import { MAX_SLACK_AUTHORS, MAX_THREAD_REPLIES, lessonSubjectSource, type LessonSubjectSourceDeps, type ThreadNoteAuthor } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { lessonSlackAuthor } from "../../../packages/broker/src/aws/broker/lesson-slack-author.js";
import { ownerKeyForSubject } from "../../../packages/broker/src/aws/lambda.js";
import { DeveloperSignInStore } from "../../../packages/broker/src/developer/store.js";
import { taskKey, taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { buildReflectorInput } from "../../../packages/broker/src/lessons/reflect-input.js";
import { buildTaskReflectSubject } from "../../../packages/broker/src/lessons/task-subject.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { WS } from "./lesson-helpers.js";

const PROJECT = "proj-1";
const TASK = randomUUID();
const CREATOR = "creator-1";
const TEAM = "T0TEAM001";
const OTHER_TEAM = "T0OTHER02";
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const REPLIER = "replier-dev";
const SLACK_REPLIER = "U0REPLY01";

function record(over: Record<string, unknown> = {}, workflow: Record<string, unknown> = {}) {
  return {
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
    requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: CREATOR }, ownerKey: taskOwnerKey(CREATOR, TASK),
    workflow: {
      schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [], ...workflow,
    },
    ...over,
  };
}

const slackNote = (slackUserId = SLACK_REPLIER, teamId = TEAM): ThreadNoteAuthor => ({ kind: "slack", teamId, slackUserId });

/** A task with `notes` saved replies; `deps` overrides the ports. Authors: the Slack account SLACK_REPLIER in TEAM is REPLIER, a linked member. */
function setup(notes: readonly ThreadNoteAuthor[], deps: Partial<LessonSubjectSourceDeps> = {}, over: Record<string, unknown> = {}, workflow: Record<string, unknown> = {}) {
  const db = new FakeDynamoDb();
  db.set(record({ threadNoteCount: notes.length, ...over }, workflow));
  const asked: Array<{ orgId: string; teamId: string; slackUserId: string }> = [];
  const standingAsked: string[] = [];
  const erasedAsked: string[] = [];
  const source = lessonSubjectSource({
    documentClient: db, tableName: "state",
    repositoriesOf: async () => ["api"],
    standing: async (_org, who) => { standingAsked.push(who); return who === "no-role-dev" || who === "outsider-1" ? "outsider" : "member"; },
    isErased: async (_org, who) => { erasedAsked.push(who); return false; },
    visibility: async () => ({ kind: "shared" }),
    now: () => 1_800_000_000_000,
    threadNotes: async () => notes,
    slackAuthor: async (input) => { asked.push(input); return input.teamId === TEAM && input.slackUserId === SLACK_REPLIER ? REPLIER : undefined; },
    ...deps,
  });
  return { source, asked, standingAsked, erasedAsked };
}
const base = async (s: ReturnType<typeof setup>) => (await s.source.read({ workspaceId: WS, taskId: TASK }))!;
const steering = async (s: ReturnType<typeof setup>) => (await base(s)).facts.rest.steeringTrust;
const verdict = async (s: ReturnType<typeof setup>) => {
  const b = await base(s);
  return buildReflectorInput(buildTaskReflectSubject({ ...b.facts, sendBacks: [] }));
};

describe("a Slack reply's author is named through the linked Rovara identity", () => {
  it("a linked member's reply: the author is named, counts as a member steerer, and the task is eligible", async () => {
    const s = setup([slackNote()]);
    expect(await steering(s)).toEqual(["member"]);
    expect(s.asked).toEqual([{ orgId: WS, teamId: TEAM, slackUserId: SLACK_REPLIER }]);
    // The person the link names is the one whose standing and erasure were asked (not the Slack id, not the creator).
    expect(s.standingAsked).toContain(REPLIER);
    expect(s.erasedAsked).toContain(REPLIER);
    expect(await verdict(s)).toMatchObject({ eligible: true });
  });

  it("an unlinked Slack account stays an outsider and the task is ineligible", async () => {
    const s = setup([slackNote("U0NOLINK1")]);
    expect(await steering(s)).toContain("outsider");
    expect(await verdict(s)).toMatchObject({ eligible: false, reason: "outsider_steered" });
  });

  it("a linked person with no project role is not a member: the task is ineligible", async () => {
    const s = setup([slackNote()], { slackAuthor: async () => "no-role-dev" });
    expect(await steering(s)).toEqual(["outsider"]);
    expect(await verdict(s)).toMatchObject({ eligible: false, reason: "outsider_steered" });
  });

  it("one unnamed account among named members makes the whole task outsider-steered", async () => {
    const s = setup([slackNote(), slackNote("U0NOLINK1")]);
    expect(await steering(s)).toEqual(expect.arrayContaining(["member", "outsider"]));
    expect(await verdict(s)).toMatchObject({ eligible: false });
  });

  it("the same Slack user id in another workspace is asked about with THAT workspace and stays an outsider", async () => {
    const s = setup([slackNote(SLACK_REPLIER, OTHER_TEAM)]);
    expect(await steering(s)).toContain("outsider");
    expect(s.asked).toEqual([{ orgId: WS, teamId: OTHER_TEAM, slackUserId: SLACK_REPLIER }]);
  });

  it("the owner's reply for the pull request feedback review (kept on the workflow with its Slack account) is named the same way", async () => {
    const note = { requestId: randomUUID(), actorId: taskOwnerKey(CREATOR, TASK), source: "THREAD_REPLY", sourceId: "Ev1", text: "do it", at: "2026-11-01T00:00:00.000Z",
      slack: { teamId: TEAM, channelId: "C0CHAN001", threadTs: "1700000000.000001", userId: SLACK_REPLIER, messageTs: "1700000001.000001", eventId: "Ev1" } };
    const s = setup([], {}, {}, { feedbackNotes: [note] });
    expect(await steering(s)).toEqual(["member"]);
    expect(s.asked).toHaveLength(1);
    const unlinked = setup([], {}, {}, { feedbackNotes: [{ ...note, slack: { ...note.slack, userId: "U0NOLINK1" } }] });
    expect(await steering(unlinked)).toContain("outsider");
  });

  it("the same account that replied twice (and in the feedback review) is resolved once", async () => {
    const s = setup([slackNote(), slackNote(), slackNote()]);
    expect(await steering(s)).toEqual(["member"]);
    expect(s.asked).toHaveLength(1);
  });

  it("a task with no replies is unchanged: nobody steered it and nothing is asked", async () => {
    const s = setup([]);
    expect(await steering(s)).toEqual([]);
    expect(s.asked).toEqual([]);
  });
});

describe("every doubt is an outsider (fail closed)", () => {
  it("a read of the saved replies that fails, and an author lookup that fails, are unknown", async () => {
    const broken = setup([slackNote()], { threadNotes: async () => { throw new Error("table down"); } });
    expect(await steering(broken)).toContain("outsider");
    const lookup = setup([slackNote()], { slackAuthor: async () => { throw new Error("link table down"); } });
    expect(await steering(lookup)).toContain("outsider");
    expect(await verdict(lookup)).toMatchObject({ eligible: false });
  });

  it("without the readers the old rule holds: any saved reply is someone unnamed", async () => {
    expect(await steering(setup([slackNote()], { threadNotes: undefined }))).toContain("outsider");
    expect(await steering(setup([slackNote()], { slackAuthor: undefined }))).toContain("outsider");
  });

  it("fewer rows than the task counts (a row unreadable or gone) is unknown", async () => {
    const s = setup([slackNote()], {}, { threadNoteCount: 2 });
    expect(await steering(s)).toContain("outsider");
  });

  it("a note that is not a Slack reply (a session message) is not named by this source", async () => {
    const s = setup([slackNote(), { kind: "other" }]);
    expect(await steering(s)).toContain("outsider");
  });

  it("a person who cannot be named after a blank answer is unknown, not a member", async () => {
    const s = setup([slackNote()], { slackAuthor: async () => "  " });
    expect(await steering(s)).toContain("outsider");
  });

  it("cap: a task with more saved replies than the limit is unnamed and its replies are not even read", async () => {
    let read = 0;
    const many = Array.from({ length: MAX_THREAD_REPLIES + 1 }, () => slackNote());
    const s = setup(many, { threadNotes: async () => { read += 1; return many; } });
    expect(await steering(s)).toContain("outsider");
    expect(read).toBe(0);
  });

  it("cap: the limit itself is still read; more distinct Slack accounts than the limit are not all resolved and the task is unnamed", async () => {
    const atLimit = Array.from({ length: MAX_THREAD_REPLIES }, () => slackNote());
    expect(await steering(setup(atLimit))).toEqual(["member"]);
    const crowd = Array.from({ length: MAX_SLACK_AUTHORS + 5 }, (_, index) => slackNote(`U0CROWD${String(index).padStart(2, "0")}`));
    const s = setup(crowd, { slackAuthor: async () => REPLIER });
    expect(await steering(s)).toContain("outsider");
    expect(s.asked.length).toBeLessThanOrEqual(MAX_SLACK_AUTHORS);
  });
});

describe("erasure reaches the Slack-derived words", () => {
  const markdown = "# Plan\nUse withRetry. A teammate said: prefer the helper.";
  const artifact = { type: "plan", version: 1, objectKey: "plans/x.md", sha256: sha(markdown), format: "markdown", createdAt: "2026-11-01T00:00:00.000Z" };
  const report = { operationId: randomUUID(), candidateDigest: "d".repeat(64), role: "CRITIC", provider: "p", version: "1", status: "FINDINGS", findings: [{ text: "Missing null check", origin: "INTRODUCED" }], readOnly: true, recordedAt: "2026-11-01T00:00:00.000Z" };
  const workflow = { artifacts: [artifact], reviews: [report], fixSource: "ci", fixProblems: ["unit tests"] };
  const kinds = async (s: ReturnType<typeof setup>) => (await base(s)).facts.rest.spans!.filter((span) => ["plan", "review_finding", "ci_failure"].includes(span.kind)).map((span) => span.kind).sort();

  it("positive control: with nobody erased the plan, the finding and the CI text are read, and the task is steered by a member", async () => {
    const s = setup([slackNote()], { readObject: async () => markdown }, {}, workflow);
    expect(await kinds(s)).toEqual(["ci_failure", "plan", "review_finding"]);
    expect(await steering(s)).toEqual(["member"]);
  });

  it("an erased replier: none of the worker-written text (the plan quotes replies) is read, and the task stays ineligible", async () => {
    const s = setup([slackNote()], { readObject: async () => markdown, isErased: async (_org, who) => who === REPLIER }, {}, workflow);
    expect(await kinds(s)).toEqual([]);
    expect(await steering(s)).toContain("outsider");
    expect(await verdict(s)).toMatchObject({ eligible: false });
  });

  it("erasing someone else leaves the text alone; an erasure check that cannot tell throws instead of passing", async () => {
    const other = setup([slackNote()], { readObject: async () => markdown, isErased: async (_org, who) => who === "someone-else" }, {}, workflow);
    expect(await kinds(other)).toHaveLength(3);
    const broken = setup([slackNote()], { isErased: async () => { throw new Error("marker unreadable"); } });
    await expect(base(broken)).rejects.toThrow();
  });

  it("no span carries a reply's words: the reply text is never read by the source", async () => {
    const s = setup([slackNote()]);
    expect((await base(s)).facts.rest.spans!.some((span) => span.authorId === REPLIER)).toBe(false);
  });
});

describe("messages sent from a session (app or Linear) name their sender", () => {
  const person = (developerId: string): ThreadNoteAuthor => ({ kind: "person", developerId });

  it("a member's session message: named, a member steerer, eligible; mixed with a linked Slack reply it is still eligible", async () => {
    const alone = setup([person("session-member")]);
    expect(await steering(alone)).toEqual(["member"]);
    expect(await verdict(alone)).toMatchObject({ eligible: true });
    expect(alone.standingAsked).toContain("session-member");
    expect(await steering(setup([person("session-member"), slackNote()]))).toEqual(["member"]);
  });

  it("a sender with no project role, an erased sender, a blank id and too many senders: not eligible", async () => {
    expect(await verdict(setup([person("no-role-dev")]))).toMatchObject({ eligible: false, reason: "outsider_steered" });
    expect(await verdict(setup([person("session-member")], { isErased: async (_org, who) => who === "session-member" }))).toMatchObject({ eligible: false });
    expect(await steering(setup([person("  ")]))).toContain("outsider");
    const crowd = Array.from({ length: MAX_SLACK_AUTHORS + 1 }, (_, index) => person(`session-${String(index)}`));
    expect(await steering(setup(crowd))).toContain("outsider");
  });

  it("an erased sender taints the worker text (the plan carries the message)", async () => {
    const markdown = "# Plan\nUse withRetry.";
    const artifact = { type: "plan", version: 1, objectKey: "plans/x.md", sha256: sha(markdown), format: "markdown", createdAt: "2026-11-01T00:00:00.000Z" };
    const s = setup([person("session-member")], { readObject: async () => markdown, isErased: async (_org, who) => who === "session-member" }, {}, { artifacts: [artifact] });
    expect((await base(s)).facts.rest.spans!.some((span) => span.kind === "plan")).toBe(false);
  });
});

describe("a task started in Slack is created under the Slack-derived id; its creator is read as the linked person (LP-2b)", () => {
  const CREATOR_SLACK = "U0CREATE01";
  const DERIVED = ownerKeyForSubject(SLACK_OIDC_ISSUER, CREATOR_SLACK);
  const WEB_CREATOR = "web-creator";
  const slackStarted = { developerId: DERIVED, ownerKey: taskOwnerKey(DERIVED, TASK), startedBy: undefined, agent: undefined, slackUserId: CREATOR_SLACK, share: { teamId: TEAM } };
  // Members: only the web accounts (the Slack-derived id has no membership of its own).
  const members = new Set([WEB_CREATOR, REPLIER]);
  const standing = async (_org: string, who: string) => (members.has(who) ? "member" as const : "outsider" as const);
  const lookups: Array<{ orgId: string; teamId: string; slackUserId: string }> = [];
  const linkedCreator = async (input: { orgId: string; teamId: string; slackUserId: string }) => (lookups.push(input), input.teamId !== TEAM ? undefined : input.slackUserId === CREATOR_SLACK ? WEB_CREATOR : input.slackUserId === SLACK_REPLIER ? REPLIER : undefined);
  const started = (notes: readonly ThreadNoteAuthor[] = [slackNote()], deps: Partial<LessonSubjectSourceDeps> = {}, over: Record<string, unknown> = {}) => {
    lookups.length = 0;
    return setup(notes, { standing, slackAuthor: linkedCreator, ...deps }, { ...slackStarted, ...over });
  };

  it("a creator linked through a web account is a member, and so are the replies: eligible, and the person is named as the initiator and the intent's author", async () => {
    const s = started();
    const b = await base(s);
    expect(b.facts.rest).toMatchObject({ initiatorTrust: "member", intentTrust: "member", steeringTrust: ["member"] });
    expect(b.facts.rest.spans![0]).toMatchObject({ kind: "intent", trust: "member", authorId: WEB_CREATOR });
    const subject = buildTaskReflectSubject({ ...b.facts, sendBacks: [] });
    expect(subject.initiatorId).toBe(WEB_CREATOR);
    expect(buildReflectorInput(subject)).toMatchObject({ eligible: true });
    expect(lookups).toContainEqual({ orgId: WS, teamId: TEAM, slackUserId: CREATOR_SLACK });
  });

  it("an unlinked creator (the Slack-derived id has no membership) is an outsider: ineligible", async () => {
    const s = started([slackNote()], { slackAuthor: async (input) => (input.slackUserId === SLACK_REPLIER ? REPLIER : undefined) });
    expect(await base(s)).toMatchObject({ facts: { rest: { initiatorTrust: "outsider", intentTrust: "outsider" } } });
    expect(await verdict(s)).toMatchObject({ eligible: false });
  });

  it("a link removed after the task started, a lookup that fails, a task with no workspace on its share: the creator is read as recorded (an outsider here)", async () => {
    const removed = started([slackNote()], { slackAuthor: async (input) => { if (input.slackUserId === CREATOR_SLACK) throw new Error("down"); return REPLIER; } });
    expect(await verdict(removed)).toMatchObject({ eligible: false, reason: "outsider_initiated" });
    const noTeam = started([slackNote()], {}, { share: undefined });
    expect(await verdict(noTeam)).toMatchObject({ eligible: false });
    expect(lookups.some((a) => a.slackUserId === CREATOR_SLACK)).toBe(false);
  });

  it("only the creator's own Slack-derived id is looked up: a creator id that is not derived from the record's Slack account is never mapped", async () => {
    const s = started([slackNote()], {}, { developerId: "someone-else", ownerKey: taskOwnerKey("someone-else", TASK) });
    expect(await verdict(s)).toMatchObject({ eligible: false });
    expect(lookups.some((a) => a.slackUserId === CREATOR_SLACK)).toBe(false);
  });

  it("an erased linked creator is erased (checked under the linked person as well as the recorded id): no intent span, no worker text, no initiator trust", async () => {
    const s = started([slackNote()], { isErased: async (_org, who) => who === WEB_CREATOR });
    const b = await base(s);
    expect(b.facts.rest.spans!.some((span) => span.kind === "intent")).toBe(false);
    expect(b.facts.rest.initiatorTrust).toBeUndefined();
    expect(b.facts.rest.intentTrust).toBeUndefined();
    expect(await verdict(s)).toMatchObject({ eligible: false });
  });
});

describe("the resolver proves the link (lessonSlackAuthor)", () => {
  const LINKED_DEV = "dev-web-1";
  const slackKey = (slackUserId: string): string => ownerKeyForSubject(SLACK_OIDC_ISSUER, slackUserId);

  function world(over: { link?: Record<string, unknown> | null; developer?: Record<string, unknown> | null; bound?: string | null; merged?: Record<string, unknown> } = {}) {
    const db = new FakeDynamoDb();
    if (over.bound !== null) db.set({ ...slackTeamOrgKey(TEAM), orgId: over.bound ?? WS });
    if (over.link !== null) db.set({ pk: `SIGNIN_IDENTITY#${slackKey(SLACK_REPLIER)}`, sk: "META", entityType: "IDENTITY_LINK", developerId: LINKED_DEV, provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: SLACK_REPLIER, linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z", ...over.link });
    if (over.developer !== null) db.set({ pk: `DEVELOPER#${LINKED_DEV}`, sk: "META", provider: "github", issuer: "https://github.com", subject: "1", displayName: "Dana", firstSignInAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z", revoked: false, ...over.developer });
    if (over.merged !== undefined) db.set({ pk: `DEVELOPER#${over.merged["id"] as string}`, sk: "META", provider: "github", issuer: "https://github.com", subject: "2", displayName: "Dana 2", firstSignInAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z", revoked: false });
    const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "state", now: () => 1_800_000_000_000 });
    return lessonSlackAuthor({ documentClient: db, tableName: "state", signIn });
  }
  const who = (resolve: ReturnType<typeof world>, input: Partial<{ orgId: string; teamId: string; slackUserId: string }> = {}) => resolve({ orgId: WS, teamId: TEAM, slackUserId: SLACK_REPLIER, ...input });

  it("an active Slack link in the task's own workspace names the linked developer", async () => {
    expect(await who(world())).toBe(LINKED_DEV);
  });

  it("follows a merge to the person the developer is now", async () => {
    const resolve = world({ developer: { mergedInto: "dev-survivor" }, merged: { id: "dev-survivor" } });
    expect(await who(resolve)).toBe("dev-survivor");
  });

  it("no link row, an unlinked identity, a link for another provider, issuer or subject: nobody", async () => {
    expect(await who(world({ link: null }))).toBeUndefined();
    expect(await who(world({ link: { unlinkedFrom: LINKED_DEV } }))).toBeUndefined();
    expect(await who(world({ link: { provider: "github" } }))).toBeUndefined();
    expect(await who(world({ link: { issuer: "https://example.invalid" } }))).toBeUndefined();
    expect(await who(world({ link: { subject: "U0SOMEONE" } }))).toBeUndefined();
    expect(await who(world({ link: { developerId: "" } }))).toBeUndefined();
  });

  it("another workspace's account (same user id) and a workspace bound to another company or to none: nobody", async () => {
    expect(await who(world(), { teamId: OTHER_TEAM })).toBeUndefined();
    expect(await who(world({ bound: "org_zzzzzzzzzzzzzzzzzzzz" }))).toBeUndefined();
    expect(await who(world({ bound: null }))).toBeUndefined();
    expect(await who(world(), { orgId: "org_zzzzzzzzzzzzzzzzzzzz" })).toBeUndefined();
  });

  it("a revoked or missing developer is nobody", async () => {
    expect(await who(world({ developer: { revoked: true } }))).toBeUndefined();
    expect(await who(world({ developer: null }))).toBeUndefined();
  });

  it("a bot, Slackbot, a malformed id or a malformed workspace is nobody (and no read is needed)", async () => {
    const resolve = world();
    for (const slackUserId of ["B0BOT0001", "USLACKBOT-", "u0lower01", "", "U0", "U0REPLY01 "]) expect(await who(resolve, { slackUserId }), slackUserId).toBeUndefined();
    for (const teamId of ["", "t0team001", "X0TEAM001", "T0"]) expect(await who(resolve, { teamId }), teamId).toBeUndefined();
  });

  it("a table that cannot be read throws (the source treats that as unknown)", async () => {
    const failing = lessonSlackAuthor({ documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state", signIn: { getIdentityLink: async () => undefined, getDeveloper: async () => undefined } });
    await expect(failing({ orgId: WS, teamId: TEAM, slackUserId: SLACK_REPLIER })).rejects.toThrow();
  });
});
