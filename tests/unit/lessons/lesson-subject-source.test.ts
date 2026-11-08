// Lessons in production, lane 1: the production TaskSubjectSource reads the task record and its workflow, and applies erasure, standing and workspace rules at READ time.
import { humanSendBackCount, isHumanSendBack } from "../../../packages/broker/src/lessons/human-send-backs.js";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_SEND_BACK_IDS, lessonSubjectSource, type LessonSubjectSourceDeps } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { taskKey, taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { buildTaskReflectSubject } from "../../../packages/broker/src/lessons/task-subject.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { WS } from "./lesson-helpers.js";

const PROJECT = "proj-1";
const TASK = randomUUID();
const OTHER_WS = "org_bbbbbbbbbbbbbbbbbbbb";
const CREATOR = "creator-1";
const STARTER = "starter-1";
const SHA40 = "a".repeat(40);
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function decision(over: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), workflowRevision: 1, decision: "REQUEST_CHANGES", actorId: taskOwnerKey(CREATOR, TASK), actorRole: "TASK_OWNER", reason: "use the helper", source: "SEND_BACK", at: "2026-11-01T00:00:00.000Z", ...over };
}

function record(over: Record<string, unknown> = {}, workflow: Record<string, unknown> = {}) {
  return {
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
    requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: STARTER }, ownerKey: taskOwnerKey(CREATOR, TASK),
    workflow: {
      schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [],
      reviewBase: [{ repositoryId: "api", baseCommitSha: SHA40 }],
      pullRequests: [{ repositoryId: "api", number: 7, url: "https://github.com/acme/api/pull/7", candidateDigest: "b".repeat(64), required: true, state: "MERGED" }],
      ...workflow,
    },
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}, workflow: Record<string, unknown> = {}, deps: Partial<LessonSubjectSourceDeps> = {}) {
  const db = new FakeDynamoDb();
  db.set(record(over, workflow));
  const erasedAsked: string[] = [];
  const source = lessonSubjectSource({
    documentClient: db, tableName: "state",
    repositoriesOf: async () => ["api", "web"],
    standing: async (_org, who) => (who === "outsider-1" ? "outsider" : "member"),
    isErased: async (_org, who) => { erasedAsked.push(who); return false; },
    visibility: async () => ({ kind: "shared" }),
    now: () => 1_800_000_000_000,
    ...deps,
  });
  return { db, source, erasedAsked };
}
const read = (source: ReturnType<typeof setup>["source"], workspaceId = WS) => source.read({ workspaceId, taskId: TASK });

describe("the task's facts", () => {
  it("reads the base commit, the project's repositories, the links, the start fields and the intent authored by the creator", async () => {
    const { source } = setup();
    const base = (await read(source))!;
    expect(base.facts).toMatchObject({ workspaceId: WS, project: PROJECT, taskId: TASK, repositories: ["api"], baseCommit: SHA40, outcome: "merged" });
    expect(base.facts.mergedCommit).toBeUndefined();
    expect(base.facts.rest.links).toEqual(["https://github.com/acme/api/pull/7"]);
    expect(base.facts.rest).toMatchObject({ initiatorTrust: "member", intentTrust: "member" });
    // The start fields make initiatorId the person who pressed Start, not the creator.
    expect(buildTaskReflectSubject({ ...base.facts, sendBacks: [] }).initiatorId).toBe(STARTER);
    expect(base.facts.rest.spans?.[0]).toMatchObject({ kind: "intent", text: "Make the retries use withRetry", authorId: CREATOR, trust: "member" });
    expect(base.facts.rest.audience).toEqual({ kind: "project" });
  });

  it("repositories come from the project's own definition, never the record's claim; several bases claim no base commit", async () => {
    const { source } = setup({ repositories: ["evil"] }, { reviewBase: [{ repositoryId: "api", baseCommitSha: SHA40 }, { repositoryId: "web", baseCommitSha: "c".repeat(40) }] });
    const base = (await read(source))!;
    expect(base.facts.repositories).toEqual(["api", "web"]);
    expect(base.facts.baseCommit).toBeUndefined();
    const stranger = setup({}, { reviewBase: [{ repositoryId: "elsewhere", baseCommitSha: SHA40 }] });
    expect((await read(stranger.source))!.facts.baseCommit).toBeUndefined();
  });

  it("review findings and CI problems become agent spans without an author; advisory-origin findings stay out", async () => {
    const report = (role: string, findings: unknown[]) => ({ operationId: randomUUID(), candidateDigest: "d".repeat(64), role, provider: "p", version: "1", status: "FINDINGS", findings, readOnly: true, recordedAt: "2026-11-01T00:00:00.000Z" });
    const { source } = setup({}, {
      reviews: [report("CRITIC", [{ text: "Missing null check", origin: "INTRODUCED" }, { text: "Old smell", origin: "PRE_EXISTING" }])],
      fixSource: "ci", fixProblems: ["unit tests", "lint"],
    });
    const spans = (await read(source))!.facts.rest.spans!;
    const finding = spans.filter((s) => s.kind === "review_finding");
    expect(finding).toHaveLength(1);
    // Worker-written text is untrusted agent text: the "system" class, never "rovara" (M5).
    expect(finding[0]).toMatchObject({ text: "Missing null check", trust: "system" });
    expect(finding[0]!.authorId).toBeUndefined();
    const ci = spans.filter((s) => s.kind === "ci_failure");
    expect(ci.map((s) => s.sourceKey)).toEqual(["ci", "ci"]);
    expect(ci.every((s) => s.authorId === undefined && s.trust === "system")).toBe(true);
  });

  it("the plan is an agent span with no author, read from the artifact store", async () => {
    const markdown = "# Plan\nUse withRetry.";
    const artifact = { type: "plan", version: 1, objectKey: "plans/x.md", sha256: sha(markdown), format: "markdown", createdAt: "2026-11-01T00:00:00.000Z" };
    const { source } = setup({}, { artifacts: [artifact] }, { readObject: async (key) => (key === "plans/x.md" ? markdown : undefined) });
    const plan = (await read(source))!.facts.rest.spans!.find((s) => s.kind === "plan");
    expect(plan).toMatchObject({ trust: "system", text: markdown });
    expect(plan!.authorId).toBeUndefined();
    // No store, or a copy that does not match its digest: no plan span.
    expect((await read(setup({}, { artifacts: [artifact] }).source))!.facts.rest.spans!.some((s) => s.kind === "plan")).toBe(false);
    const wrong = setup({}, { artifacts: [artifact] }, { readObject: async () => "tampered" });
    expect((await read(wrong.source))!.facts.rest.spans!.some((s) => s.kind === "plan")).toBe(false);
  });

  it("the close reason is the owner's own words, authored by them; an admin's close is not attributed", async () => {
    const closed = { outcome: "CLOSED", decisions: [decision({ decision: "REJECT", source: "GATE", reason: "not needed" })] };
    const { source } = setup({}, closed);
    expect((await read(source))!.facts.rest.spans!.find((s) => s.kind === "close_reason")).toMatchObject({ text: "not needed", authorId: CREATOR, trust: "member" });
    const admin = setup({}, { outcome: "CLOSED", decisions: [decision({ decision: "REJECT", source: "GATE", actorRole: "PROJECT_ADMIN", actorId: "e".repeat(64) })] });
    expect((await read(admin.source))!.facts.rest.spans!.some((s) => s.kind === "close_reason")).toBe(false);
  });

  it("each person-span's trust is read now: an outsider creator's intent is an outsider span", async () => {
    const { source } = setup({ developerId: "outsider-1", ownerKey: taskOwnerKey("outsider-1", TASK), startedBy: undefined, agent: undefined });
    const base = (await read(source))!;
    expect(base.facts.rest.intentTrust).toBe("outsider");
    expect(base.facts.rest.spans![0]).toMatchObject({ kind: "intent", trust: "outsider" });
  });
});

describe("human send-backs", () => {
  it("lists the request ids of the human SEND_BACK decisions only, never an automatic one or an approval", async () => {
    const human = decision(), auto = decision({ actorRole: "AGENTX", actorId: "f".repeat(64), source: "AUTO_FIX", auto: { stage: "VERIFY" } }), gate = decision({ source: "GATE", decision: "APPROVE" });
    const { source } = setup({}, { decisions: [gate, human, auto] });
    expect((await read(source))!.sendBackRequestIds).toEqual([human.requestId]);
  });

  it("M2: a resolve-findings decision that sent the task back to coding (a FIX) is a send-back the reflector reads too; accepting every finding is an approval and is not", async () => {
    const plain = decision(), fixed = decision({ source: "FINDINGS", reason: "1 accepted, 1 to fix" }), acceptedAll = decision({ source: "FINDINGS", decision: "APPROVE", reason: "2 accepted, 0 to fix" });
    const autoFindings = decision({ source: "FINDINGS", actorRole: "AGENTX", actorId: "f".repeat(64) });
    const { source } = setup({}, { decisions: [plain, acceptedAll, fixed, autoFindings] });
    expect((await read(source))!.sendBackRequestIds).toEqual([plain.requestId, fixed.requestId]);
  });

  it("M2: the round number the announcement writes and the list the reflector reads count the same decisions (one shared rule)", () => {
    const decisions = [decision(), decision({ source: "FINDINGS" }), decision({ source: "FINDINGS", decision: "APPROVE" }), decision({ source: "GATE", decision: "APPROVE" }), decision({ source: "AUTO_FIX", actorRole: "AGENTX" })];
    expect(humanSendBackCount({ decisions } as never)).toBe(2);
    expect(decisions.filter((entry) => isHumanSendBack(entry as never))).toHaveLength(2);
  });

  it("caps the ids it hands on", async () => {
    const many = Array.from({ length: 80 }, () => decision());
    const { source } = setup({}, { decisions: many.slice(0, 80) });
    const ids = (await read(source))!.sendBackRequestIds;
    expect(ids).toHaveLength(MAX_SEND_BACK_IDS);
    expect(ids).toEqual(many.slice(0, MAX_SEND_BACK_IDS).map((d) => d.requestId));
  });
});

describe("workspace and kind of task", () => {
  it("another workspace's caller gets nothing, and an unknown or malformed workspace too", async () => {
    const { source } = setup();
    expect(await read(source, OTHER_WS)).toBeUndefined();
    expect(await read(source, "not-an-org")).toBeUndefined();
    expect(await source.read({ workspaceId: WS, taskId: randomUUID() })).toBeUndefined();
    expect(await read(source)).toBeDefined();
  });

  it("an automatic run, a diagnosis and a task nobody can record for give nothing", async () => {
    expect(await read(setup({ automatic: { job: "nightly" } }).source)).toBeUndefined();
    expect(await read(setup({ purpose: "diagnosis" }).source)).toBeUndefined();
    expect(await read(setup({}, {}, { visibility: async () => undefined }).source)).toBeUndefined();
  });

  it("the audience is the task's visibility, not the project's", async () => {
    const { source } = setup({}, {}, { visibility: async () => ({ kind: "private", ownerDeveloperId: CREATOR }) });
    expect((await read(source))!.facts.rest.audience).toMatchObject({ kind: "restricted", acl: { principals: [CREATOR] } });
  });
});

describe("sharedTask: the mark repository publishing needs (lessons connect)", () => {
  const sharedNow = { visibility: async () => ({ kind: "shared" as const }), strictVisibility: async () => ({ kind: "shared" as const }) };
  const sharedOf = async (deps: Partial<LessonSubjectSourceDeps>): Promise<unknown> => (await read(setup({}, {}, deps).source))!.facts.rest.sharedTask;

  it("a task that is project-wide with no People denial is a shared task, and the subject carries it to the reflector", async () => {
    const { source } = setup({}, {}, sharedNow);
    const base = (await read(source))!;
    expect(base.facts.rest.sharedTask).toBe(true);
    expect(buildTaskReflectSubject({ ...base.facts, sendBacks: [] }).sharedTask).toBe(true);
  });
  it("a narrowed task (shared with named people), a private one, and a live read that turns up narrower than the first are KNOWN not project-wide: the mark is false, not unset", async () => {
    expect(await sharedOf({ visibility: async () => ({ kind: "shared_with", developerIds: [CREATOR, "dev-x"] }), strictVisibility: async () => ({ kind: "shared_with", developerIds: [CREATOR, "dev-x"] }) })).toBe(false);
    expect(await sharedOf({ visibility: async () => ({ kind: "private", ownerDeveloperId: CREATOR }), strictVisibility: async () => ({ kind: "private", ownerDeveloperId: CREATOR }) })).toBe(false);
    // The strict reader is what decides: a task the first read called shared but the strict read finds narrowed (a People denial) is not shared.
    expect(await sharedOf({ visibility: async () => ({ kind: "shared" }), strictVisibility: async () => ({ kind: "shared_with", developerIds: [CREATOR] }) })).toBe(false);
    expect(await sharedOf({ visibility: async () => ({ kind: "shared" }), strictVisibility: async () => undefined })).toBe(false);
  });
  it("owner decision 32 (M4): an ordinary task nobody shared counts as project-wide when no People entry denies anyone, whatever the Team record's audience for it is; a denial makes it not", async () => {
    const owner = { visibility: async () => ({ kind: "private" as const, ownerDeveloperId: CREATOR }), strictVisibility: async () => ({ kind: "private" as const, ownerDeveloperId: CREATOR }) };
    const asked: string[][] = [];
    const wide = setup({}, {}, { ...owner, projectWide: async (org, task) => { asked.push([org, task]); return true; } });
    const base = (await read(wide.source))!;
    expect(base.facts.rest.sharedTask).toBe(true);
    expect(asked).toEqual([[WS, TASK]]);
    // The Team record's own audience is unchanged: the unshared task's rows are still the owner's alone.
    expect(base.facts.rest.audience).toMatchObject({ kind: "restricted" });
    expect(await sharedOf({ ...owner, projectWide: async () => false })).toBe(false);
    // Positive control: the same ordinary task without the project-wide reader is not shared.
    expect(await sharedOf(owner)).toBe(false);
  });
  it("L1: a read that fails is read again once, and a second failure leaves the mark UNSET (unknown), with one fixed count-only line", async () => {
    const logs: Array<[string, Record<string, string | number>]> = [];
    let calls = 0;
    const flaky = { ...sharedNow, strictVisibility: async () => { calls += 1; if (calls === 1) throw new Error("People list can't be read"); return { kind: "shared" as const }; }, log: (event: string, fields: Record<string, string | number>) => logs.push([event, fields]) };
    expect(await sharedOf(flaky)).toBe(true);
    expect(logs).toEqual([]);
    const down = { ...sharedNow, strictVisibility: async () => { throw new Error("secret table text"); }, projectWide: async () => { throw new Error("secret table text"); }, log: flaky.log };
    expect(await sharedOf(down)).toBeUndefined();
    expect(logs).toEqual([["learning.shared_task_unreadable", { task: createHash("sha256").update(`${WS}\u0000${TASK}`).digest("hex").slice(0, 12) }]]);
    expect(JSON.stringify(logs)).not.toContain(TASK);
  });
  it("positive control: the strict reader is asked for this company's task", async () => {
    const asked: string[][] = [];
    expect(await sharedOf({ ...sharedNow, strictVisibility: async (org, task) => { asked.push([org, task]); return { kind: "shared" }; } })).toBe(true);
    expect(asked).toEqual([[WS, TASK]]);
  });
});

describe("erasure at read time", () => {
  const erasing = (...ids: string[]) => ({ isErased: async (_org: string, who: string) => ids.includes(who) });

  it("an erased author's spans are dropped: the intent of an erased creator, the close reason of an erased owner", async () => {
    const closed = { outcome: "CLOSED", decisions: [decision({ decision: "REJECT", source: "GATE", reason: "secret words" })] };
    const kept = setup({}, closed);
    expect((await read(kept.source))!.facts.rest.spans!.map((s) => s.kind)).toEqual(["intent", "close_reason"]);
    const gone = setup({}, closed, erasing(CREATOR));
    const base = (await read(gone.source))!;
    expect(base.facts.rest.spans!.map((s) => s.kind)).toEqual([]);
    expect(JSON.stringify(base)).not.toContain("secret words");
    expect(JSON.stringify(base)).not.toContain("withRetry");
    expect(base.facts.rest.intentTrust).toBeUndefined();
  });

  it("an erased initiator gives no initiatorId (and no initiator trust), so nothing is measured against them", async () => {
    const live = setup();
    expect(buildTaskReflectSubject({ ...(await read(live.source))!.facts, sendBacks: [] }).initiatorId).toBe(STARTER);
    const gone = setup({}, {}, erasing(STARTER));
    const base = (await read(gone.source))!;
    const subject = buildTaskReflectSubject({ ...base.facts, sendBacks: [] });
    expect(subject.initiatorId).toBeUndefined();
    expect(subject.initiatorTrust).toBeUndefined();
    // The creator's own, un-erased intent is still read (the positive control: the check ran per person).
    expect(base.facts.rest.spans!.some((s) => s.kind === "intent")).toBe(true);
  });

  it("an erased taker's decisions do not steer; a read that cannot tell throws instead of passing", async () => {
    const broken = setup({}, {}, { isErased: async () => { throw new Error("marker unreadable"); } });
    await expect(read(broken.source)).rejects.toThrow();
  });

  it("nothing is read from Slack: the source never touches a channel and only asks the injected ports", async () => {
    const { source, erasedAsked } = setup({ threadNoteCount: 2 });
    const base = (await read(source))!;
    // A thread reply cannot be attributed to a member by the record: the task counts as steered by someone unnamed (an outsider).
    expect(base.facts.rest.steeringTrust).toContain("outsider");
    expect(erasedAsked).toContain(CREATOR);
  });
});

describe("steering through the pull request feedback flow (M4)", () => {
  const FEEDBACK_DECISION = { schemaVersion: 1, requestId: randomUUID(), workflowRevision: 2, decision: "REQUEST_CHANGES", actorId: taskOwnerKey(CREATOR, TASK), actorRole: "TASK_OWNER", reviewDigest: "1".repeat(64), proposalDigest: "2".repeat(64), bundleDigests: ["3".repeat(64)], selectedFindingIds: [], selectedCommentIds: [], candidates: [], at: "2026-11-01T00:00:00.000Z" };
  const steering = async (workflow: Record<string, unknown>, over: Record<string, unknown> = {}) => (await read(setup(over, workflow).source))!.facts.rest.steeringTrust;

  it("positive control: a task nobody steered has an empty steering list", async () => {
    expect(await steering({})).toEqual([]);
  });

  it("a feedback round that acted on selected pull request comments is steered by whoever wrote them: an outsider", async () => {
    expect(await steering({ feedbackDecisions: [{ ...FEEDBACK_DECISION, selectedCommentIds: ["c1"] }] })).toContain("outsider");
  });

  it("a collected feedback review history, a review thread observation or a thread reply also make the task outsider-steered; an owner's own note does not", async () => {
    expect(await steering({ feedbackReviewHistory: [{ sha256: "4".repeat(64), objectKey: "k" }] })).toContain("outsider");
    expect(await steering({ feedbackThreadObservations: [{ threadId: "t" }] })).toContain("outsider");
    expect(await steering({ feedbackReview: { status: "COLLECTING", bundleRefs: [], threadObservations: [] } })).toContain("outsider");
    // A reply in the task's thread has no named author; an owner's own note is a named steer (a member).
    const note = (source: string) => ({ requestId: randomUUID(), actorId: taskOwnerKey(CREATOR, TASK), source, sourceId: "x", text: "do it", at: "2026-11-01T00:00:00.000Z" });
    expect(await steering({ feedbackNotes: [note("THREAD_REPLY")] })).toContain("outsider");
    expect(await steering({ feedbackNotes: [note("REQUEST_CHANGES")] })).toEqual(["member"]);
  });

  it("a feedback decision with no selected comments (findings only) is the owner's own steer: a member", async () => {
    expect(await steering({ feedbackDecisions: [{ ...FEEDBACK_DECISION, selectedFindingIds: ["f1"] }] })).toEqual(["member"]);
  });
});

describe("worker-written text and erased people (M5, M6)", () => {
  const erasing = (...ids: string[]) => ({ isErased: async (_org: string, who: string) => ids.includes(who) });
  const markdown = "# Plan\nUse withRetry.";
  const artifact = { type: "plan", version: 1, objectKey: "plans/x.md", sha256: sha(markdown), format: "markdown", createdAt: "2026-11-01T00:00:00.000Z" };
  const report = { operationId: randomUUID(), candidateDigest: "d".repeat(64), role: "CRITIC", provider: "p", version: "1", status: "FINDINGS", findings: [{ text: "Missing null check", origin: "INTRODUCED" }], readOnly: true, recordedAt: "2026-11-01T00:00:00.000Z" };
  const workerKinds = ["plan", "review_finding", "ci_failure"];
  const workerSpans = async (over: Record<string, unknown>, workflow: Record<string, unknown>, deps: Partial<LessonSubjectSourceDeps>) =>
    (await read(setup(over, { artifacts: [artifact], reviews: [report], fixSource: "ci", fixProblems: ["unit tests"], ...workflow }, { readObject: async () => markdown, ...deps }).source))!.facts.rest.spans!.filter((s) => workerKinds.includes(s.kind));

  it("positive control: with nobody erased the plan, the finding and the CI text are all read, as untrusted agent text", async () => {
    const spans = await workerSpans({}, {}, {});
    expect(spans.map((s) => s.kind).sort()).toEqual(["ci_failure", "plan", "review_finding"]);
    expect(spans.every((s) => s.trust === "system")).toBe(true);
  });

  it("an erased person who answered the plan questions: the plan, the findings and the CI text are not read (fail closed)", async () => {
    const answers = [{ by: { actorId: taskOwnerKey(CREATOR, TASK) } }];
    expect(await workerSpans({}, { intent: { answers } }, erasing(CREATOR))).toEqual([]);
  });

  it("an erased person who decided on the task, or who took it over, taints the worker text too", async () => {
    const decided = { decisions: [decision({ source: "GATE", decision: "APPROVE" })] };
    expect(await workerSpans({}, decided, erasing(CREATOR))).toEqual([]);
    expect((await workerSpans({}, decided, erasing("someone-else"))).length).toBe(3);
    const taken = { currentOwner: { developerId: "taker-1", name: "Taker", provider: "oidc", since: "2026-11-02T00:00:00.000Z" } };
    expect(await workerSpans(taken, {}, erasing("taker-1"))).toEqual([]);
    expect((await workerSpans(taken, {}, erasing("someone-else"))).length).toBe(3);
  });

  it("an erased steerer is an outsider (the task stays ineligible), never removed from the list (M6)", async () => {
    const decided = { decisions: [decision({ source: "GATE", decision: "APPROVE" })] };
    const live = (await read(setup({}, decided).source))!.facts.rest.steeringTrust;
    expect(live).toEqual(["member"]);
    const gone = (await read(setup({}, decided, erasing(CREATOR)).source))!.facts.rest.steeringTrust;
    expect(gone).toContain("outsider");
    const answered = (await read(setup({}, { intent: { answers: [{ by: { actorId: taskOwnerKey(CREATOR, TASK) } }] } }, erasing(CREATOR)).source))!.facts.rest.steeringTrust;
    expect(answered).toContain("outsider");
    // An erased taker who decided: still an outsider steerer, with the creator (not erased) alone steering as a member.
    const taken = { currentOwner: { developerId: "taker-1", name: "Taker", provider: "oidc", since: "2026-11-02T00:00:00.000Z" } };
    const takerDecided = { decisions: [decision({ source: "GATE", decision: "APPROVE", actorId: taskOwnerKey("taker-1", TASK) })] };
    expect((await read(setup(taken, takerDecided).source))!.facts.rest.steeringTrust).toEqual(["member"]);
    expect((await read(setup(taken, takerDecided, erasing("taker-1")).source))!.facts.rest.steeringTrust).toContain("outsider");
  });
});
