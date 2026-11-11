// v1.2 learning loop, B1: the store (design §3): retention, terminal suggestions, caps, the projectCreatedAt filter and paginated partition reads.
import { describe, expect, it } from "vitest";
import {
  captureCorrection, clearCorrectionText, closeSuggestion, getLearningItem, openSuggestion, putDismissed, readLearningPartition, readLearningState, type CaptureInput,
} from "../../packages/broker/src/learning/store.js";
import { learningExpiry, learningItemKind } from "../../packages/broker/src/learning/retention.js";
import { LEARNING_DAILY_AUTOMATIC_MAX, LEARNING_DAILY_PR_MAX, LEARNING_LIVE_CORRECTIONS_MAX, LEARNING_OPEN_SUGGESTIONS_MAX, LEARNING_REMEMBER_MAX, LearningSuggestionSchema } from "@rovara-code/contracts";
import { projectLearningKey } from "@rovara-code/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { DAY_MS, NOW_MS, ORG_B, PROJECT_CREATED, epochSeconds, iso, makeWorld, seedCorrection, seedItem, type World } from "../support/learning-world.js";

const DAYS_180 = 180 * 86_400;
const capture = (n: number, overrides: Partial<CaptureInput> = {}): CaptureInput => ({
  id: `c${n}`, stage: "build", source: "comment", sourceKey: `comment-${n}`, sourceRef: { taskId: `t${n}`, commentId: `k${n}` }, taskId: `t${n}`, text: "Use the shared retry helper.",
  signature: ["h1", "h2"], author: "dev1", standing: "member", limit: "remember", actor: "dev1", ...overrides,
});
const suggestionInput = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `s${n}`, stage: "build", correctionIds: [`a${n}`, `b${n}`], allFromOnePerson: false, proposedText: "Use the shared retry helper.", signature: ["h1"], lessSafe: false, kinds: [], overlaps: [], ...overrides,
});
const stateOf = async (world: World) => (await readLearningState(world.deps, world.scope))!;
const partitionItems = (world: World) => world.db.find((item) => item.pk === projectLearningKey(world.scope.orgId, world.scope.project, "STATE").pk);

async function captureMany(world: World, count: number, make: (n: number) => Partial<CaptureInput>, from = 0) {
  const results = [];
  for (let n = from; n < from + count; n += 1) results.push(await captureCorrection(world.deps, world.scope, capture(n, make(n))));
  return results;
}

describe("retention: 180 days on indexExpiresAt", () => {
  it("gives a correction, its source record and a dismissed pattern an expiry of capture time + 180 days", async () => {
    const world = makeWorld();
    const result = await captureCorrection(world.deps, world.scope, capture(1));
    expect(result).toMatchObject({ ok: true, created: true });
    const expected = epochSeconds(NOW_MS) + DAYS_180;
    const correction = partitionItems(world).find((item) => String(item.sk).startsWith("CORRECTION#"))!;
    expect(correction.indexExpiresAt).toBe(expected);
    expect(partitionItems(world).find((item) => String(item.sk).startsWith("SOURCE#"))!.indexExpiresAt).toBe(expected);
    await putDismissed(world.deps, world.scope, { signatureHash: "sig1", suggestionId: "s1", signature: ["h1"] });
    expect(partitionItems(world).find((item) => String(item.sk) === "DISMISSED#sig1")!.indexExpiresAt).toBe(expected);
    // Not the admin helper's 30 days.
    expect(learningExpiry(NOW_MS)).toBe(expected);
  });

  it("gives daily and rate items a short expiry of their own", async () => {
    const world = makeWorld();
    await captureCorrection(world.deps, world.scope, capture(1, { limit: "automatic" }));
    await captureCorrection(world.deps, world.scope, capture(2, { limit: "remember" }));
    const short = partitionItems(world).filter((item) => /^(DAILY|RATE)#/.test(String(item.sk)));
    expect(short.map((item) => String(item.sk).split("#")[0]).sort()).toEqual(["DAILY", "RATE"]);
    for (const item of short) expect(item.indexExpiresAt as number).toBeLessThanOrEqual(epochSeconds(NOW_MS) + 3 * 86400);
  });

  it("treats an expired item as absent on every read, and leaves it for the TTL and the sweep (no delete-on-read)", async () => {
    const world = makeWorld();
    const expiredSk = seedCorrection(world.db, TEST_ORG, "web", 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    const liveSk = seedCorrection(world.db, TEST_ORG, "web", 2);
    expect(await getLearningItem(world.deps, world.scope, expiredSk)).toBeUndefined();
    expect(await getLearningItem(world.deps, world.scope, liveSk)).toBeDefined();
    const page = await readLearningPartition(world.deps, world.scope, { prefix: "CORRECTION#" });
    expect(page.items.map((item) => item.sk)).toEqual([liveSk]);
    const deletes = world.db.commandNames().filter((name) => name === "DeleteCommand");
    expect(deletes).toEqual([]);
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", expiredSk))).toBeDefined();
  });

  it("never expires the items that hold no correction text (STATE, SETTINGS, RULE, METRIC)", () => {
    for (const sk of ["STATE", "SETTINGS", "RULE#r1", "METRIC#2026-10"]) expect(learningItemKind(sk), sk).toMatchObject({ expires: false });
    for (const sk of ["CORRECTION#x#y", "SOURCE#k", "DISMISSED#h", "PROPOSAL#p", "DAILY#d", "RATE#a#b"]) expect(learningItemKind(sk), sk).toMatchObject({ expires: true });
  });
});

describe("suggestions: terminal states drop correction text and expire (re-check gap 1)", () => {
  it("opens a suggestion and counts it", async () => {
    const world = makeWorld();
    const opened = await openSuggestion(world.deps, world.scope, suggestionInput(1));
    expect(opened).toMatchObject({ ok: true });
    expect((await stateOf(world)).openSuggestions).toBe(1);
    const stored = await getLearningItem(world.deps, world.scope, "SUGGESTION#s1");
    expect(LearningSuggestionSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({ status: "open", proposedText: "Use the shared retry helper.", revision: 0 });
    expect(stored).not.toHaveProperty("indexExpiresAt");
  });

  it.each(["accepted", "dismissed", "withdrawn", "expired"] as const)("on %s removes proposedText and dismissNote, sets terminalAt and a 180-day expiry, and uncounts it", async (status) => {
    const world = makeWorld();
    await openSuggestion(world.deps, world.scope, suggestionInput(1, { dismissNote: "private words" }));
    world.clock.ms += 5000;
    const closed = await closeSuggestion(world.deps, world.scope, { id: "s1", expectedRevision: 0, status, decidedBy: "dev1", ...(status === "dismissed" ? { dismissKind: "one_off" as const } : {}) });
    expect(closed).toMatchObject({ ok: true });
    const raw = world.db.get(projectLearningKey(TEST_ORG, "web", "SUGGESTION#s1"))!;
    expect(raw).not.toHaveProperty("proposedText");
    expect(raw).not.toHaveProperty("dismissNote");
    expect(JSON.stringify(raw)).not.toContain("shared retry helper");
    expect(JSON.stringify(raw)).not.toContain("private words");
    expect(raw).toMatchObject({ status, terminalAt: iso(world.clock.ms), indexExpiresAt: epochSeconds(world.clock.ms) + DAYS_180, revision: 1 });
    expect(LearningSuggestionSchema.safeParse(raw).success).toBe(true);
    expect((await stateOf(world)).openSuggestions).toBe(0);
  });

  it("refuses a second terminal move and a stale revision", async () => {
    const world = makeWorld();
    await openSuggestion(world.deps, world.scope, suggestionInput(1));
    expect(await closeSuggestion(world.deps, world.scope, { id: "s1", expectedRevision: 5, status: "withdrawn" })).toMatchObject({ ok: false, reason: "stale" });
    expect(await closeSuggestion(world.deps, world.scope, { id: "s1", expectedRevision: 0, status: "withdrawn" })).toMatchObject({ ok: true });
    expect(await closeSuggestion(world.deps, world.scope, { id: "s1", expectedRevision: 1, status: "dismissed" })).toMatchObject({ ok: false, reason: "already_terminal" });
    expect(await closeSuggestion(world.deps, world.scope, { id: "nope", expectedRevision: 0, status: "dismissed" })).toMatchObject({ ok: false, reason: "missing" });
    expect((await stateOf(world)).openSuggestions).toBe(0);
  });

  it("removes correction text from the named corrections only", async () => {
    const world = makeWorld();
    const a = seedCorrection(world.db, TEST_ORG, "web", 1);
    const b = seedCorrection(world.db, TEST_ORG, "web", 2);
    await clearCorrectionText(world.deps, world.scope, [a]);
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", a))).not.toHaveProperty("text");
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", b))).toHaveProperty("text");
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", a))).toMatchObject({ id: "c00001", standing: "member" });
  });
});

describe("caps", () => {
  it("allows 20 open suggestions per project and holds the 21st", async () => {
    const world = makeWorld();
    for (let n = 0; n < LEARNING_OPEN_SUGGESTIONS_MAX; n += 1) expect(await openSuggestion(world.deps, world.scope, suggestionInput(n))).toMatchObject({ ok: true });
    expect(await openSuggestion(world.deps, world.scope, suggestionInput(99))).toMatchObject({ ok: false, reason: "suggestion_cap" });
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", "SUGGESTION#s99"))).toBeUndefined();
    // Another project is not held by it.
    const other = makeWorld({ db: world.db, project: "api" });
    expect(await openSuggestion(other.deps, other.scope, suggestionInput(1))).toMatchObject({ ok: true });
    // Closing one makes room.
    await closeSuggestion(world.deps, world.scope, { id: "s0", expectedRevision: 0, status: "dismissed", dismissKind: "wrong" });
    expect(await openSuggestion(world.deps, world.scope, suggestionInput(99))).toMatchObject({ ok: true });
  });

  it("refuses capture at 2,000 live corrections, and counts only the live ones", async () => {
    const world = makeWorld();
    for (let n = 0; n < LEARNING_LIVE_CORRECTIONS_MAX; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    seedItem(world.db, TEST_ORG, "web", "STATE", { entityType: "LEARNING_STATE", revision: 1, projectCreatedAt: PROJECT_CREATED, openSuggestions: 0, liveCorrections: LEARNING_LIVE_CORRECTIONS_MAX, pendingRules: 0 });
    expect(await captureCorrection(world.deps, world.scope, capture(5000, { limit: "automatic" }))).toMatchObject({ ok: false, reason: "store_full" });
    expect(world.db.find((item) => String(item.sk).startsWith("SOURCE#"))).toEqual([]);
  });

  it("holds the 2,000 cap inside the write itself, so a racing capture that read the counter a moment ago cannot pass it", async () => {
    const world = makeWorld();
    seedItem(world.db, TEST_ORG, "web", "STATE", { entityType: "LEARNING_STATE", revision: 1, projectCreatedAt: PROJECT_CREATED, openSuggestions: 0, liveCorrections: LEARNING_LIVE_CORRECTIONS_MAX - 1, pendingRules: 0 });
    const racing = { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") world.db.set({ ...world.db.get(projectLearningKey(TEST_ORG, "web", "STATE"))!, liveCorrections: LEARNING_LIVE_CORRECTIONS_MAX });
      return world.db.send(command as never);
    } };
    const result = await captureCorrection({ ...world.deps, documentClient: racing }, world.scope, capture(1));
    expect(result).toMatchObject({ ok: false, reason: "store_full" });
    expect(world.db.find((item) => String(item.sk).startsWith("CORRECTION#"))).toEqual([]);
    expect(world.db.find((item) => String(item.sk).startsWith("SOURCE#"))).toEqual([]);
  });

  it("repairs a counter that TTL deletions left too high, then accepts the capture", async () => {
    const world = makeWorld();
    for (let n = 0; n < 3; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    seedItem(world.db, TEST_ORG, "web", "STATE", { entityType: "LEARNING_STATE", revision: 1, projectCreatedAt: PROJECT_CREATED, openSuggestions: 0, liveCorrections: LEARNING_LIVE_CORRECTIONS_MAX, pendingRules: 0 });
    expect(await captureCorrection(world.deps, world.scope, capture(9000))).toMatchObject({ ok: true, created: true });
    expect((await stateOf(world)).liveCorrections).toBe(4);
  });

  it("limits automatic captures to 100 a day per project, PR comments to 50 of them, and starts a new day fresh; Remember is not a daily capture", async () => {
    const world = makeWorld();
    const pr = await captureMany(world, LEARNING_DAILY_PR_MAX, () => ({ limit: "automatic_pr", source: "pr_comment" }));
    expect(pr.every((result) => result.ok)).toBe(true);
    expect(await captureCorrection(world.deps, world.scope, capture(100, { limit: "automatic_pr", source: "pr_comment" }))).toMatchObject({ ok: false, reason: "pr_daily_cap" });
    const rest = await captureMany(world, LEARNING_DAILY_AUTOMATIC_MAX - LEARNING_DAILY_PR_MAX, () => ({ limit: "automatic", source: "send_back" }), 200);
    expect(rest.every((result) => result.ok)).toBe(true);
    expect(await captureCorrection(world.deps, world.scope, capture(300, { limit: "automatic", source: "send_back" }))).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(await captureCorrection(world.deps, world.scope, capture(301, { limit: "remember" }))).toMatchObject({ ok: true });
    // Another project has its own day.
    const other = makeWorld({ db: world.db, project: "api" });
    expect(await captureCorrection(other.deps, other.scope, capture(1, { limit: "automatic" }))).toMatchObject({ ok: true });
    world.clock.ms += DAY_MS;
    expect(await captureCorrection(world.deps, world.scope, capture(302, { limit: "automatic" }))).toMatchObject({ ok: true });
  });

  it("limits Remember to 30 per person per project per 10 minutes", async () => {
    const world = makeWorld();
    const first = await captureMany(world, LEARNING_REMEMBER_MAX, () => ({ limit: "remember", actor: "dev1" }));
    expect(first.every((result) => result.ok)).toBe(true);
    expect(await captureCorrection(world.deps, world.scope, capture(100, { limit: "remember", actor: "dev1" }))).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(await captureCorrection(world.deps, world.scope, capture(101, { limit: "remember", actor: "dev2" }))).toMatchObject({ ok: true });
    const other = makeWorld({ db: world.db, project: "api" });
    expect(await captureCorrection(other.deps, other.scope, capture(102, { limit: "remember", actor: "dev1" }))).toMatchObject({ ok: true });
    world.clock.ms += 10 * 60_000;
    expect(await captureCorrection(world.deps, world.scope, capture(103, { limit: "remember", actor: "dev1" }))).toMatchObject({ ok: true });
  });

  it("is idempotent per source: a repeat finds the first correction and counts nothing", async () => {
    const world = makeWorld();
    const first = await captureCorrection(world.deps, world.scope, capture(1, { limit: "automatic" }));
    const again = await captureCorrection(world.deps, world.scope, capture(1, { id: "other-id", limit: "automatic" }));
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false, correctionId: "c1" });
    expect((await stateOf(world)).liveCorrections).toBe(1);
    expect(world.db.find((item) => String(item.sk).startsWith("CORRECTION#"))).toHaveLength(1);
    const daily = world.db.find((item) => String(item.sk).startsWith("DAILY#"))[0]!;
    expect(daily.autoCount).toBe(1);
  });

  it("stores no standing, author or stage that the caller did not pass (the item is what the input says)", async () => {
    const world = makeWorld();
    await captureCorrection(world.deps, world.scope, capture(1, { standing: "outsider", stage: "plan" }));
    expect(world.db.find((item) => String(item.sk).startsWith("CORRECTION#"))[0]).toMatchObject({ standing: "outsider", stage: "plan", author: "dev1", projectCreatedAt: PROJECT_CREATED });
  });
});

describe("a full project does not read its whole partition on every attempt", () => {
  const fullState = (world: World) => seedItem(world.db, TEST_ORG, "web", "STATE", { entityType: "LEARNING_STATE", revision: 1, projectCreatedAt: PROJECT_CREATED, openSuggestions: 0, liveCorrections: LEARNING_LIVE_CORRECTIONS_MAX, pendingRules: 0 });
  const queries = (world: World) => world.db.commandNames().filter((name) => name === "QueryCommand").length;
  const pcEpoch = Math.floor(Date.parse(PROJECT_CREATED) / 1000);

  it("checks the daily cap before it recounts: a capture the daily cap refuses reads no partition", async () => {
    const world = makeWorld();
    for (let n = 0; n < 3; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    fullState(world);
    seedItem(world.db, TEST_ORG, "web", `DAILY#${iso(NOW_MS).slice(0, 10)}#${String(pcEpoch)}`, { autoCount: LEARNING_DAILY_AUTOMATIC_MAX, prCount: 0, projectCreatedAt: PROJECT_CREATED, indexExpiresAt: epochSeconds(NOW_MS) + 86400 });
    expect(await captureCorrection(world.deps, world.scope, capture(1, { limit: "automatic" }))).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(queries(world)).toBe(0);
  });

  it("checks the rate cap before it recounts", async () => {
    const world = makeWorld();
    for (let n = 0; n < 3; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    fullState(world);
    seedItem(world.db, TEST_ORG, "web", `RATE#dev1#${String(Math.floor(NOW_MS / 1000 / 600))}#${String(pcEpoch)}`, { rememberCount: LEARNING_REMEMBER_MAX, projectCreatedAt: PROJECT_CREATED, indexExpiresAt: epochSeconds(NOW_MS) + 86400 });
    expect(await captureCorrection(world.deps, world.scope, capture(1, { limit: "remember", actor: "dev1" }))).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(queries(world)).toBe(0);
  });

  it("recounts a really full project once, then refuses without reading until the recount is old", async () => {
    const world = makeWorld();
    for (let n = 0; n < LEARNING_LIVE_CORRECTIONS_MAX; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    fullState(world);
    expect(await captureCorrection(world.deps, world.scope, capture(5000))).toMatchObject({ ok: false, reason: "store_full" });
    const afterFirst = queries(world);
    expect(afterFirst).toBeGreaterThan(0);
    world.clock.ms += 60_000;
    expect(await captureCorrection(world.deps, world.scope, capture(5001, { sourceKey: "other-source" }))).toMatchObject({ ok: false, reason: "store_full" });
    expect(queries(world)).toBe(afterFirst);
    world.clock.ms += 20 * 60_000;
    await captureCorrection(world.deps, world.scope, capture(5002, { sourceKey: "third-source" }));
    expect(queries(world)).toBeGreaterThan(afterFirst);
  });

  it("repairs the counter from the real number of corrections that exist, expired ones included, so it never reads low", async () => {
    const world = makeWorld();
    for (let n = 0; n < LEARNING_LIVE_CORRECTIONS_MAX; n += 1) seedCorrection(world.db, TEST_ORG, "web", n, n < 100 ? { expiresAtSeconds: epochSeconds(NOW_MS) - 1 } : {});
    fullState(world);
    // 100 of the 2,000 are past their time but not yet swept: they are still stored, so they still count until the sweep deletes them.
    expect(await captureCorrection(world.deps, world.scope, capture(7000))).toMatchObject({ ok: false, reason: "store_full" });
    expect((await stateOf(world)).liveCorrections).toBe(LEARNING_LIVE_CORRECTIONS_MAX);
  });
});

describe("a project created again under the same name sees nothing old", () => {
  const LATER = "2026-10-20T00:00:00.000Z";
  it("ignores items of an earlier project on every read, and the first write starts a fresh STATE", async () => {
    const world = makeWorld();
    await captureCorrection(world.deps, world.scope, capture(1));
    await openSuggestion(world.deps, world.scope, suggestionInput(1));
    expect((await stateOf(world))).toMatchObject({ liveCorrections: 1, openSuggestions: 1 });

    const again = makeWorld({ db: world.db, projectCreatedAt: LATER });
    expect(await readLearningState(again.deps, again.scope)).toBeUndefined();
    expect((await readLearningPartition(again.deps, again.scope, {})).items).toEqual([]);
    expect(await getLearningItem(again.deps, again.scope, "SUGGESTION#s1")).toBeUndefined();

    expect(await captureCorrection(again.deps, again.scope, capture(2))).toMatchObject({ ok: true, created: true });
    expect(await readLearningState(again.deps, again.scope)).toMatchObject({ projectCreatedAt: LATER, liveCorrections: 1, openSuggestions: 0 });
    const visible = (await readLearningPartition(again.deps, again.scope, {})).items.map((item) => String(item.sk).split("#")[0]).sort();
    expect(visible).toEqual(["CORRECTION", "RATE", "SOURCE", "STATE"]);
    // Counters of the old project did not carry over: the old day and rate items are not the new project's.
    expect(world.db.find((item) => String(item.sk).startsWith("RATE#"))).toHaveLength(2);
    // The old project's own scope is now the stale one.
    expect(await captureCorrection(world.deps, world.scope, capture(3))).toMatchObject({ ok: false, reason: "stale" });
  });

  it("lets the new project capture a source key the old project still holds", async () => {
    const world = makeWorld();
    await captureCorrection(world.deps, world.scope, capture(1, { sourceKey: "comment-shared" }));
    const again = makeWorld({ db: world.db, projectCreatedAt: LATER });
    expect(await captureCorrection(again.deps, again.scope, capture(2, { sourceKey: "comment-shared" }))).toMatchObject({ ok: true, created: true });
    // And a repeat inside the new project is still a repeat.
    expect(await captureCorrection(again.deps, again.scope, capture(3, { sourceKey: "comment-shared" }))).toMatchObject({ ok: true, created: false, correctionId: "c2" });
  });

  it("starts a fresh STATE over one that has no projectCreatedAt (or no revision)", async () => {
    const world = makeWorld();
    seedItem(world.db, TEST_ORG, "web", "STATE", { entityType: "LEARNING_STATE", openSuggestions: 3, liveCorrections: 9, pendingRules: 0 });
    expect(await captureCorrection(world.deps, world.scope, capture(1))).toMatchObject({ ok: true, created: true });
    expect(await readLearningState(world.deps, world.scope)).toMatchObject({ projectCreatedAt: PROJECT_CREATED, liveCorrections: 1, openSuggestions: 0 });
  });

  it("keeps two projects and two companies apart (I9)", async () => {
    const world = makeWorld();
    await captureCorrection(world.deps, world.scope, capture(1));
    const api = makeWorld({ db: world.db, project: "api" });
    const other = makeWorld({ db: world.db, orgId: ORG_B });
    expect((await readLearningPartition(api.deps, api.scope, {})).items).toEqual([]);
    expect((await readLearningPartition(other.deps, other.scope, {})).items).toEqual([]);
    expect(await captureCorrection(other.deps, other.scope, capture(1))).toMatchObject({ created: true });
    expect((await readLearningState(world.deps, world.scope))!.liveCorrections).toBe(1);
  });
});

describe("partition reads page with a budget and a resume cursor (for closeOrg and person erase)", () => {
  it("stops at the item budget with a cursor, and a resume reads every item exactly once", async () => {
    const world = makeWorld();
    for (let n = 0; n < 250; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await readLearningPartition(world.deps, world.scope, { prefix: "CORRECTION#", ...(cursor === undefined ? {} : { cursor }), maxItems: 100, pageSize: 40 });
      expect(page.scanned).toBeLessThanOrEqual(100);
      seen.push(...page.items.map((item) => String(item.sk)));
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
  });

  it("limits the pages read in one call", async () => {
    const world = makeWorld();
    for (let n = 0; n < 250; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    const page = await readLearningPartition(world.deps, world.scope, { maxPages: 2, pageSize: 30, maxItems: 1000 });
    expect(page.scanned).toBe(60);
    expect(page.cursor).toBeDefined();
  });

  it("hides expired and earlier-project items but still advances the cursor over them, and shows everything raw (for the cleanup jobs)", async () => {
    const world = makeWorld();
    // Sort keys run oldest first: n=3 is the oldest correction, n=1 the newest.
    seedCorrection(world.db, TEST_ORG, "web", 3, { expiresAtSeconds: epochSeconds(NOW_MS) - 10 });
    seedCorrection(world.db, TEST_ORG, "web", 2, { projectCreatedAt: "2026-01-01T00:00:00.000Z" });
    const live = seedCorrection(world.db, TEST_ORG, "web", 1);
    const first = await readLearningPartition(world.deps, world.scope, { pageSize: 1, maxItems: 1 });
    expect(first.items).toEqual([]);
    expect(first.cursor).toBeDefined();
    const all = await readLearningPartition(world.deps, world.scope, {});
    expect(all.items.map((item) => item.sk)).toEqual([live]);
    const raw = await readLearningPartition(world.deps, { orgId: TEST_ORG, project: "web" }, {});
    expect(raw.items).toHaveLength(3);
  });
});

describe("the fake table enforces DynamoDB's transaction limits for learning writes", () => {
  const put = (project: string, n: number, bytes = 10) => ({ Put: { TableName: "state", Item: { ...projectLearningKey(TEST_ORG, project, `X#${n}`), blob: "x".repeat(bytes) } } });
  it("refuses more than 100 items, or more than 4 MB, in a transaction on a learning partition", async () => {
    const { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
    const db = new FakeDynamoDb();
    await expect(db.send(new TransactWriteCommand({ TransactItems: Array.from({ length: 100 }, (_, n) => put("web", n)) }) as never)).resolves.toBeDefined();
    await expect(db.send(new TransactWriteCommand({ TransactItems: Array.from({ length: 101 }, (_, n) => put("web", 1000 + n)) }) as never)).rejects.toMatchObject({ name: "ValidationException" });
    await expect(db.send(new TransactWriteCommand({ TransactItems: Array.from({ length: 11 }, (_, n) => put("web", 2000 + n, 399_000)) }) as never)).rejects.toMatchObject({ name: "ValidationException" });
    expect(db.find((item) => String(item.sk).startsWith("X#2000"))).toEqual([]);
  });
  it("does not change a transaction elsewhere (the limit is scoped to learning partitions)", async () => {
    const { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
    const db = new FakeDynamoDb();
    await expect(db.send(new TransactWriteCommand({ TransactItems: Array.from({ length: 101 }, (_, n) => ({ Put: { TableName: "state", Item: { pk: "ELSEWHERE", sk: `S#${n}` } } })) }) as never)).resolves.toBeDefined();
  });
});
