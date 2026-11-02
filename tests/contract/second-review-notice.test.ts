// Lane cr-settings: the notice to company admins when the model that gives the second opinion stops qualifying: once per change, as a decision card and a banner on the settings page, put away by "I've seen it".
import { afterEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, orgMetaKey, secondReviewModelKey, type ModelIdentifier } from "../../packages/contracts/src/index.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";
import { noteQualification, noticeLines, problemOf, readNotice, secondReviewNoticeItemsFor, SECOND_REVIEW_NOTICE_SK, markNoticeSeen } from "../../packages/broker/src/rovara-code/second-review-notice.js";
import { prepareSecondReview } from "../../packages/broker/src/rovara-code/second-review-start.js";
import { projectDecisionCards } from "../../packages/broker/src/decisions/project.js";
import type { SecondReviewPlan } from "../../packages/broker/src/rovara-code/second-review.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

afterEach(() => { delete process.env.SECOND_REVIEW_ENABLED; delete process.env.DECISION_CARDS_ENABLED; });
const PATH = "/v1/app/org/second-review";
const GONE = { provider: "openrouter", modelId: "mistral/large-9" };
const OTHER = { provider: "openrouter", modelId: "x/other-9" };
const table = () => ({ documentClient: new FakeDynamoDb(), tableName: "state" });
const notRunning = (models: Array<{ model: { provider: string; modelId: string }; why: "same-company" | "not-routable" }>): SecondReviewPlan => ({ run: false, reason: "choice-not-qualifying", skipped: models });
const choiceLost = problemOf(notRunning([{ model: GONE, why: "not-routable" }]))!;

describe("what is a problem", () => {
  it("the choice not qualifying, a model of it dropped, the default moved on, nothing qualifying; and nothing else", () => {
    expect(choiceLost).toMatchObject({ code: "choice-not-qualifying", models: [{ model: GONE, why: "not-routable" }] });
    const dropped = problemOf({ run: true, mode: "shadow", model: GONE, candidates: [GONE], company: "openai", against: [], choice: "company", skipped: [{ model: OTHER, why: "same-company" }] });
    expect(dropped).toMatchObject({ code: "model-dropped" });
    const moved = problemOf({ run: true, mode: "shadow", model: GONE, candidates: [GONE], company: "openai", against: [], choice: "default", defaultChanged: true, skipped: [] });
    expect(moved).toMatchObject({ code: "default-changed", models: [{ model: GONE }] });
    expect(problemOf({ run: false, reason: "no-candidate" })).toMatchObject({ code: "no-candidate", models: [] });
    // Fine plans, and plans that do not run for a reason that is not about the model, are not problems.
    expect(problemOf({ run: true, mode: "shadow", model: GONE, candidates: [GONE], company: "openai", against: [], choice: "company", skipped: [] })).toBeUndefined();
    expect(problemOf({ run: true, mode: "on", model: GONE, candidates: [GONE], company: "openai", against: [], choice: "default", skipped: [] })).toBeUndefined();
    for (const reason of ["switch-off", "mode-off", "no-reference-model"] as const) expect(problemOf({ run: false, reason }), reason).toBeUndefined();
  });

  it("the same situation has the same key, a different model or reason a different one", () => {
    expect(problemOf(notRunning([{ model: GONE, why: "not-routable" }]))!.key).toBe(choiceLost.key);
    expect(problemOf(notRunning([{ model: GONE, why: "same-company" }]))!.key).not.toBe(choiceLost.key);
    expect(problemOf(notRunning([{ model: OTHER, why: "not-routable" }]))!.key).not.toBe(choiceLost.key);
  });
});

describe("told once per change", () => {
  it("writes an open notice once; the same problem again writes nothing; a different one replaces it", async () => {
    const t = table();
    expect(await noteQualification(t, TEST_ORG, choiceLost, 1_000)).toBe("written");
    expect(await noteQualification(t, TEST_ORG, choiceLost, 2_000)).toBe("same");
    expect(await readNotice(t, TEST_ORG)).toMatchObject({ key: choiceLost.key, status: "open", code: "choice-not-qualifying", createdAt: new Date(1_000).toISOString() });
    const next = problemOf(notRunning([{ model: OTHER, why: "same-company" }]))!;
    expect(await noteQualification(t, TEST_ORG, next, 3_000)).toBe("written");
    expect((await readNotice(t, TEST_ORG))!.key).toBe(next.key);
  });

  it("two starts at once write it once", async () => {
    const t = table();
    const results = await Promise.all([noteQualification(t, TEST_ORG, choiceLost, 1), noteQualification(t, TEST_ORG, choiceLost, 1)]);
    expect(results.filter((result) => result === "written")).toHaveLength(1);
  });

  it("a start that finds it qualifying again closes the notice, so the same problem coming back is told again", async () => {
    const t = table();
    await noteQualification(t, TEST_ORG, choiceLost, 1_000);
    expect(await noteQualification(t, TEST_ORG, undefined, 2_000)).toBe("closed");
    expect(await readNotice(t, TEST_ORG)).toBeUndefined();
    expect(await noteQualification(t, TEST_ORG, undefined, 2_500)).toBe("none");
    expect(await noteQualification(t, TEST_ORG, choiceLost, 3_000)).toBe("written");
    expect(await readNotice(t, TEST_ORG)).toMatchObject({ status: "open", createdAt: new Date(3_000).toISOString() });
  });

  it("'seen' puts it away without closing the problem, and the same problem is not told again; only the notice with that key", async () => {
    const t = table();
    await noteQualification(t, TEST_ORG, choiceLost, 1_000);
    expect(await markNoticeSeen(t, TEST_ORG, "f".repeat(32), 1_500)).toBe(false);
    expect(await markNoticeSeen(t, TEST_ORG, choiceLost.key, 1_500)).toBe(true);
    expect(await markNoticeSeen(t, TEST_ORG, choiceLost.key, 1_600)).toBe(false);
    expect(await noteQualification(t, TEST_ORG, choiceLost, 2_000)).toBe("same");
    expect(await readNotice(t, TEST_ORG)).toMatchObject({ status: "seen" });
  });

  it("a notice that cannot be written is logged by error name and never thrown", async () => {
    const broken = { documentClient: { send: async () => { throw Object.assign(new Error("secret detail"), { name: "ProvisionedThroughputExceededException" }); } }, tableName: "state" };
    expect(await noteQualification(broken, TEST_ORG, choiceLost, 1)).toBe("failed");
  });

  it("holds model names and fixed words only", async () => {
    const t = table();
    await noteQualification(t, TEST_ORG, choiceLost, 1);
    expect(noticeLines((await readNotice(t, TEST_ORG))!).join(" ")).toContain("mistral/large-9: no connected source serves it");
  });
});

describe("a review start tells the admins", () => {
  const GPT_ID: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
  const DIGEST = "a".repeat(64);
  function world(settings: Record<string, unknown>) {
    const db = new FakeDynamoDb();
    db.set({ ...orgMetaKey(TEST_ORG), pk: orgMetaKey(TEST_ORG).pk, sk: "SECONDREVIEW#SETTINGS", entityType: "SECOND_REVIEW_SETTINGS", ...settings });
    db.set({ pk: "WORKSPACE#w", sk: "OPERATION#b1", entityType: "OPERATION", kind: "task", conversationId: "c", workflowMode: "IMPLEMENT", status: "SUCCEEDED", model: GPT_ID });
    return { db, dependencies: { documentClient: db, tableName: "state" } as unknown as AwsBrokerDependencies, task: { taskId: "t", developerId: "d", workflow: { candidate: { digest: DIGEST } } } as never };
  }
  const start = (w: ReturnType<typeof world>) => prepareSecondReview({ dependencies: w.dependencies, orgId: TEST_ORG, project: "web", workspaceId: "w", conversationId: "c", task: w.task, workflowMode: "REVIEW", agentRun: undefined, workflowReviewers: undefined, firstReviewerModel: GPT_ID, approved: undefined, routing: {} });
  const notice = (w: ReturnType<typeof world>) => readNotice({ documentClient: w.db, tableName: "state" }, TEST_ORG);

  it("a chosen model that no company source serves: one notice for any number of starts, and the review is flagged as before", async () => {
    process.env.SECOND_REVIEW_ENABLED = "1";
    const w = world({ default: "on", models: [GONE] });
    const first = await start(w);
    expect(first.record).toMatchObject({ notRun: { reason: "choice-not-qualifying" } });
    expect(await notice(w)).toMatchObject({ code: "choice-not-qualifying", status: "open", models: [{ model: GONE, why: "not-routable" }] });
    const written = w.db.find((item) => item.sk === SECOND_REVIEW_NOTICE_SK)[0];
    await start(w); await start(w);
    expect(w.db.find((item) => item.sk === SECOND_REVIEW_NOTICE_SK)[0]).toEqual(written);
  });

  it("a company that fixes its choice closes it; mode off and cr off write nothing", async () => {
    process.env.SECOND_REVIEW_ENABLED = "1";
    const w = world({ default: "shadow", models: [GONE] });
    await start(w);
    expect(await notice(w)).toBeDefined();
    w.db.set({ ...(w.db.get(orgMetaKey(TEST_ORG).pk, "SECONDREVIEW#SETTINGS") as Record<string, unknown>), models: undefined });
    await start(w);
    expect(await notice(w)).toBeUndefined();
    const off = world({ default: "off", models: [GONE] });
    await start(off);
    expect(await notice(off)).toBeUndefined();
    delete process.env.SECOND_REVIEW_ENABLED;
    const disabled = world({ default: "on", models: [GONE] });
    await start(disabled);
    expect(await notice(disabled)).toBeUndefined();
  });
});

describe("the admins are told", () => {
  async function bench() {
    const t = await setupWizardBench({ audit: capturingAuditDeps() });
    await t.person(MAYA, "member");
    process.env.SECOND_REVIEW_ENABLED = "1";
    return t;
  }
  const raise = async (t: Bench) => {
    await t.web(OMAR, "POST", PATH, { action: "mode", scope: "company", mode: "shadow" });
    t.db.set({ ...orgMetaKey(TEST_ORG), pk: orgMetaKey(TEST_ORG).pk, ...(t.db.get(orgMetaKey(TEST_ORG).pk, "SECONDREVIEW#SETTINGS") as Record<string, unknown>), models: [GONE] });
    await noteQualification({ documentClient: t.db, tableName: "state" }, TEST_ORG, choiceLost, Date.now());
  };
  const state = async (t: Bench, who = OMAR) => (await t.web(who, "GET", PATH)).body as { notice: { key: string; seen: boolean; lines: string[] } | null };

  it("on the settings page: everyone who reads it sees the notice, an admin presses 'I've seen it', a member cannot, a stale key is refused", async () => {
    const t = await bench();
    expect((await state(t)).notice).toBeNull();
    await raise(t);
    const seen = await state(t);
    expect(seen.notice).toMatchObject({ key: choiceLost.key, seen: false });
    expect(seen.notice!.lines[0]).toMatch(/no longer qualifies/u);
    expect((await state(t, MAYA)).notice).toMatchObject({ seen: false });
    expect((await t.web(MAYA, "POST", PATH, { action: "notice-seen", key: choiceLost.key })).status).toBe(403);
    expect((await t.dev(OMAR, "POST", PATH, { action: "notice-seen", key: choiceLost.key })).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "notice-seen", key: "f".repeat(32) })).status).toBe(409);
    expect((await t.web(OMAR, "POST", PATH, { action: "notice-seen", key: choiceLost.key })).status).toBe(200);
    expect((await state(t)).notice).toMatchObject({ seen: true });
  });

  it("with the mode off the page shows no notice", async () => {
    const t = await bench();
    await raise(t);
    expect((await state(t)).notice).not.toBeNull();
    t.db.set({ ...(t.db.get(orgMetaKey(TEST_ORG).pk, "SECONDREVIEW#SETTINGS") as Record<string, unknown>), default: "off", lock: "off" });
    expect((await state(t)).notice).toBeNull();
  });

  it("as a decision card for an owner or admin (not a member), until 'seen'; it opens the settings page and has no other action", async () => {
    const t = await bench();
    await raise(t);
    process.env.DECISION_CARDS_ENABLED = "1";
    const cards = async (who = OMAR) => { const { requestId: _gateway, ...own } = (await t.web(who, "GET", "/v1/app/decisions")).body; void _gateway; return DecisionCardsViewSchema.parse(own).cards; };
    const list = await cards();
    expect(list.map((card) => card.id)).toEqual([`second_review_notice:${choiceLost.key}`]);
    expect(list[0]).toMatchObject({ kind: "second_review_notice", risk: "low", actions: [{ kind: "open", href: "/app/admin/second-review", method: "GET" }], rejectReasons: [] });
    expect(list[0]!.question).toMatch(/no longer qualifies/u);
    expect(await cards(MAYA)).toEqual([]);
    await t.web(OMAR, "POST", PATH, { action: "notice-seen", key: choiceLost.key });
    expect(await cards()).toEqual([]);
    delete process.env.SECOND_REVIEW_ENABLED;
    expect(await cards()).toEqual([]);
  });

  it("the card source gives nothing for a non-admin and nothing without a notice", async () => {
    const t = table();
    expect(await secondReviewNoticeItemsFor({ table: t, isAdmin: () => true }, { orgId: TEST_ORG, developerId: "d" })).toEqual([]);
    await noteQualification(t, TEST_ORG, choiceLost, 1_000);
    expect(await secondReviewNoticeItemsFor({ table: t, isAdmin: () => false }, { orgId: TEST_ORG, developerId: "d" })).toEqual([]);
    const items = await secondReviewNoticeItemsFor({ table: t, isAdmin: () => true }, { orgId: TEST_ORG, developerId: "d" });
    expect(items).toHaveLength(1);
    expect(projectDecisionCards(items).cards[0]).toMatchObject({ kind: "second_review_notice", status: "pending" });
  });
});

void secondReviewModelKey;
