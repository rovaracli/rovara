// v1.2 learning loop, B5: grouping, dismissed sets, forget and the metric counters (design 4, 7.2 W1, W2, W4-W7, W9-W11). Texts are real sentences: similarity is B2's, tested there; these tests
// pin what grouping does with it. Preconditions on chains are asserted from B2's own comparison so a change in the thresholds shows up here as a clear failure.
import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissedSetKey, forgetCorrection, groupCorrections, prCaptureOff, recordDismissal, stageFamily, withdrawPrDependentSuggestions,
} from "../../packages/broker/src/learning/grouping.js";
import { metricMonth, readMetric } from "../../packages/broker/src/learning/metric.js";
import { compareSignatures, signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { captureCorrection, closeSuggestion, openSuggestion, readLearningState } from "../../packages/broker/src/learning/store.js";
import { LEARNING_OPEN_SUGGESTIONS_MAX, LearningCorrectionSchema, LearningSuggestionSchema } from "../../packages/contracts/src/project-learning.js";
import { projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { DAY_MS, NOW_MS, PROJECT_CREATED, makeWorld, seedItem, type World } from "../support/learning-world.js";

const SALT = "project-salt-one";
const LINT_A = "Always run the linter before committing changes to the repository.";
const LINT_B = "Run the linter before you commit any changes to the repository.";
const ZOD_A = "Validate every request body with the zod schema before using it.";
const ZOD_B = "Validate request bodies with the zod schema before using them in handlers.";
const MIG_A = "Name database migrations with the date prefix and a short description.";
const MIG_B = "Database migrations need a date prefix in the name and a short description.";
// A chain: RETRY_A ~ RETRY_B ~ RETRY_C, but RETRY_A is not similar to RETRY_C (single-link grouping joins all three).
const RETRY_A = "Use the shared retry helper for network calls, with exponential backoff.";
const RETRY_B = "Use the shared retry helper for network calls, with exponential backoff and jitter on every attempt.";
const RETRY_C = "Retry network calls with exponential backoff and jitter on every attempt, and cap the attempts.";
const RETRY_NEGATED = "Never use the shared retry helper for network calls, with exponential backoff.";

let counter = 0;
beforeEach(() => { counter = 0; });

interface AddOptions { task?: string; author?: string; stage?: string; standing?: "member" | "outsider"; source?: "comment" | "send_back" | "pr_comment"; advanceMs?: number }
/** Captures one correction the way B3/B4 do, then returns its id. Each call moves the clock on so corrections have distinct times. */
async function add(world: World, text: string, options: AddOptions = {}): Promise<string> {
  world.clock.ms += options.advanceMs ?? 1000;
  counter += 1;
  const id = `c${counter}`;
  const source = options.source ?? "comment";
  const author = options.author ?? "dev1";
  const result = await captureCorrection(world.deps, world.scope, {
    id, stage: options.stage ?? "build", source, sourceKey: `key-${counter}`, sourceRef: { taskId: options.task ?? `t${counter}` }, taskId: options.task ?? `t${counter}`, text,
    signature: [...signatureOf(text, SALT)], author, standing: options.standing ?? "member", limit: source === "pr_comment" ? "automatic_pr" : "automatic",
  });
  expect(result).toMatchObject({ ok: true, created: true });
  return id;
}
const group = (world: World, options = {}) => groupCorrections(world.deps, world.scope, options);
const partition = (world: World) => world.db.find((item) => item.pk === projectLearningKey(world.scope.orgId, world.scope.project, "STATE").pk);
const suggestions = (world: World) => partition(world).filter((item) => String(item.sk).startsWith("SUGGESTION#"));
const openOnes = (world: World) => suggestions(world).filter((item) => item.status === "open");
const correction = (world: World, id: string) => partition(world).find((item) => item.id === id && String(item.sk).startsWith("CORRECTION#"));
const correctionSkOf = (world: World, id: string) => correction(world, id)!.sk as string;
const monthOf = (world: World) => metricMonth(new Date(world.clock.ms).toISOString());
const metricItem = (world: World, month = monthOf(world)) => partition(world).find((item) => item.sk === `METRIC#${month}`);
const idsOf = (suggestion: Record<string, unknown>) => [...(suggestion.correctionIds as string[])].sort();
const settings = (world: World, prComments: "on" | "off", revision: number) => seedItem(world.db, world.scope.orgId, world.scope.project, "SETTINGS", {
  entityType: "LEARNING_SETTINGS", revision, prComments, changedBy: "dev9", changedAt: new Date(NOW_MS).toISOString(), projectCreatedAt: PROJECT_CREATED,
});
const settingsOn = (world: World) => settings(world, "on", 1);
const settingsOff = (world: World) => settings(world, "off", 2);

describe("the fixtures chain the way these tests say they do", () => {
  it("RETRY_A ~ RETRY_B ~ RETRY_C, RETRY_A is not similar to RETRY_C, and a negated text is never similar", () => {
    const [a, b, c, n] = [RETRY_A, RETRY_B, RETRY_C, RETRY_NEGATED].map((text) => signatureOf(text, SALT));
    expect(compareSignatures(a!, b!).similar).toBe(true);
    expect(compareSignatures(b!, c!).similar).toBe(true);
    expect(compareSignatures(a!, c!).similar).toBe(false);
    expect(compareSignatures(a!, n!).similar).toBe(false);
  });
});

describe("W1 and W2: what forms a suggestion", () => {
  it("W1: two similar corrections on the same task never form a suggestion alone", async () => {
    const world = makeWorld();
    await add(world, LINT_A, { task: "t-same" });
    await add(world, LINT_B, { task: "t-same" });
    const result = await group(world);
    expect(suggestions(world)).toEqual([]);
    expect(result.opened).toEqual([]);
    // The same task twice is not a repeat either: both are counted, neither is a repeat.
    expect(await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: false })).toMatchObject({ memberCorrections: 2, repeats: 0 });
    // A third, from another task, is what makes it a repeat.
    await add(world, LINT_B, { task: "t-other" });
    await group(world);
    expect(openOnes(world)).toHaveLength(1);
  });

  it("W2: opposite instructions do not group (the polarity of a negation keeps them apart)", async () => {
    const world = makeWorld();
    await add(world, RETRY_A);
    await add(world, RETRY_NEGATED);
    await group(world);
    expect(suggestions(world)).toEqual([]);
  });

  it("opens one suggestion for two similar corrections on two tasks, with every member id and the proposed wording of the latest", async () => {
    const world = makeWorld();
    const a = await add(world, LINT_A);
    const b = await add(world, LINT_B);
    const result = await group(world);
    expect(result.opened).toHaveLength(1);
    const [stored] = openOnes(world);
    const parsed = LearningSuggestionSchema.parse(stored);
    expect(idsOf(stored!)).toEqual([a, b]);
    expect(parsed).toMatchObject({ stage: "build", status: "open", allFromOnePerson: true, lessSafe: false });
    expect(parsed.proposedText).toBe("Run the linter before you commit any changes to the repository.");
    expect(correction(world, a)).toMatchObject({ suggestionId: stored!.id });
    expect(correction(world, b)).toMatchObject({ suggestionId: stored!.id });
    expect((await readLearningState(world.deps, world.scope))!.openSuggestions).toBe(1);
  });

  it("leaves unrelated corrections, outsider corrections and a single correction alone", async () => {
    const world = makeWorld();
    await add(world, LINT_A);
    await add(world, ZOD_A);
    await add(world, MIG_A, { standing: "outsider" });
    await add(world, MIG_B, { standing: "outsider" });
    await group(world);
    expect(suggestions(world)).toEqual([]);
    // Outsiders do not make a member correction either.
    await add(world, MIG_A);
    await group(world);
    expect(suggestions(world)).toEqual([]);
  });

  it("chaining: A~B~C with A not similar to C keeps every member's correction id, in one run and over two runs", async () => {
    const oneRun = makeWorld();
    const ids = [await add(oneRun, RETRY_A), await add(oneRun, RETRY_B), await add(oneRun, RETRY_C)];
    await group(oneRun);
    expect(openOnes(oneRun)).toHaveLength(1);
    expect(idsOf(openOnes(oneRun)[0]!)).toEqual(ids);
    expect(LearningSuggestionSchema.parse(openOnes(oneRun)[0]).proposedText).toContain("cap the attempts");

    counter = 0;
    const stepwise = makeWorld();
    const first = [await add(stepwise, RETRY_A), await add(stepwise, RETRY_B)];
    await group(stepwise);
    expect(idsOf(openOnes(stepwise)[0]!)).toEqual(first);
    const third = await add(stepwise, RETRY_C, { author: "dev2" });
    const result = await group(stepwise);
    expect(result.joined).toHaveLength(1);
    expect(openOnes(stepwise)).toHaveLength(1);
    expect(idsOf(openOnes(stepwise)[0]!)).toEqual([...first, third]);
    expect(openOnes(stepwise)[0]).toMatchObject({ allFromOnePerson: false, revision: 1 });
    expect(correction(stepwise, third)).toMatchObject({ suggestionId: openOnes(stepwise)[0]!.id });
  });

  it("holds at most 10 members in a suggestion", async () => {
    const world = makeWorld();
    for (let n = 0; n < 12; n += 1) await add(world, n % 2 === 0 ? LINT_A : LINT_B, { advanceMs: 60_000 });
    await group(world);
    expect(openOnes(world)).toHaveLength(1);
    expect((openOnes(world)[0]!.correctionIds as string[]).length).toBe(10);
  });
});

describe("W11: all from one person", () => {
  it("corrections from one person form a suggestion with allFromOnePerson; from two people they do not carry it", async () => {
    const one = makeWorld();
    await add(one, ZOD_A, { author: "dev1" });
    await add(one, ZOD_B, { author: "dev1" });
    await group(one);
    expect(openOnes(one)[0]).toMatchObject({ allFromOnePerson: true });

    counter = 0;
    const two = makeWorld();
    await add(two, ZOD_A, { author: "dev1" });
    await add(two, ZOD_B, { author: "dev2" });
    await group(two);
    expect(openOnes(two)[0]).toMatchObject({ allFromOnePerson: false });
  });
});

describe("W5: window and stage family", () => {
  it("does not group corrections more than 30 days apart, and does group ones 29 days apart", async () => {
    const far = makeWorld();
    await add(far, MIG_A);
    await add(far, MIG_B, { advanceMs: 31 * DAY_MS });
    await group(far);
    expect(suggestions(far)).toEqual([]);

    counter = 0;
    const near = makeWorld();
    await add(near, MIG_A);
    await add(near, MIG_B, { advanceMs: 29 * DAY_MS });
    await group(near);
    expect(openOnes(near)).toHaveLength(1);
  });

  it("does not group across stages, but Plan with Plan check is one family and Review is its own", async () => {
    const world = makeWorld();
    await add(world, LINT_A, { stage: "build" });
    await add(world, LINT_B, { stage: "plan" });
    await group(world);
    expect(suggestions(world)).toEqual([]);

    counter = 0;
    const plan = makeWorld();
    await add(plan, ZOD_A, { stage: "plan" });
    await add(plan, ZOD_B, { stage: "plan_critic" });
    await group(plan);
    expect(openOnes(plan)).toHaveLength(1);

    counter = 0;
    const review = makeWorld();
    await add(review, MIG_A, { stage: "review" });
    await add(review, MIG_B, { stage: "review" });
    await group(review);
    expect(openOnes(review)).toHaveLength(1);

    counter = 0;
    const cross = makeWorld();
    await add(cross, MIG_A, { stage: "plan" });
    await add(cross, MIG_B, { stage: "review" });
    await group(cross);
    expect(suggestions(cross)).toEqual([]);
  });

  it("uses only real step kinds for families: code_review and security_review are stage ids, so they are not grouped with review or with each other", async () => {
    expect(stageFamily("plan_critic")).toBe("plan");
    expect(stageFamily("review")).toBe("review");
    expect(stageFamily("code_review")).toBe("code_review");
    expect(stageFamily("security_review")).toBe("security_review");
    const world = makeWorld();
    await add(world, MIG_A, { stage: "code_review" });
    await add(world, MIG_B, { stage: "security_review" });
    await group(world);
    expect(suggestions(world)).toEqual([]);
  });
});

describe("W4: a dismissal suppresses only that exact member set", () => {
  async function dismissedPair(world: World) {
    const a = await add(world, RETRY_A);
    const b = await add(world, RETRY_B);
    await group(world);
    const suggestion = LearningSuggestionSchema.parse(openOnes(world)[0]);
    await recordDismissal(world.deps, world.scope, suggestion);
    const closed = await closeSuggestion(world.deps, world.scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "dismissed", decidedBy: "dev1", dismissKind: "wrong" });
    expect(closed).toMatchObject({ ok: true });
    return { a, b, suggestion };
  }

  it("records the dismissal under the hash of the sorted member ids, whatever their order", async () => {
    const world = makeWorld();
    const { a, b, suggestion } = await dismissedPair(world);
    expect(dismissedSetKey([a, b])).toBe(dismissedSetKey([b, a]));
    expect(dismissedSetKey([a, b])).not.toBe(dismissedSetKey([a]));
    const stored = partition(world).find((item) => item.sk === `DISMISSED#${dismissedSetKey([a, b])}`);
    expect(stored).toMatchObject({ suggestionId: suggestion.id });
    expect(JSON.stringify(stored)).not.toContain("retry helper");
  });

  it("the same two corrections do not come back, even when grouping runs again over them and over unrelated captures", async () => {
    const world = makeWorld();
    const { a, b } = await dismissedPair(world);
    // Grouping failed once for B in the real world: it has no groupedAt and is judged again.
    const key = projectLearningKey(world.scope.orgId, world.scope.project, correctionSkOf(world, b));
    const raw = world.db.get(key)!;
    delete raw.groupedAt;
    world.db.set(raw);
    await add(world, ZOD_A);
    await group(world);
    await group(world);
    expect(openOnes(world)).toEqual([]);
    expect(correction(world, a)).toBeDefined();
  });

  it("a similar future correction forms a new suggestion with the old ones, because the member set is new", async () => {
    const world = makeWorld();
    const { a, b } = await dismissedPair(world);
    // A confusable-letter variant (Cyrillic e and a) of RETRY_B, on another task.
    const variant = "Usе thе shаred rеtry hеlpеr for nеtwork calls, with еxponеntial bаckoff and jittеr on еvеry аttеmpt.";
    expect(compareSignatures(signatureOf(variant, SALT), signatureOf(RETRY_B, SALT)).similar).toBe(true);
    const c = await add(world, variant);
    const result = await group(world);
    expect(result.opened).toHaveLength(1);
    expect(idsOf(openOnes(world)[0]!)).toEqual([a, b, c]);
  });

  it("a clearly different pattern can still form its own suggestion", async () => {
    const world = makeWorld();
    await dismissedPair(world);
    await add(world, ZOD_A);
    await add(world, ZOD_B);
    await group(world);
    expect(openOnes(world)).toHaveLength(1);
    expect(LearningSuggestionSchema.parse(openOnes(world)[0]).proposedText).toContain("zod");
  });

  it("forgetting the new correction leaves the old set, which is still dismissed", async () => {
    const world = makeWorld();
    const { a, b } = await dismissedPair(world);
    const c = await add(world, RETRY_C);
    await group(world);
    const wide = LearningSuggestionSchema.parse(openOnes(world)[0]);
    expect([...wide.correctionIds].sort()).toEqual([a, b, c]);
    await recordDismissal(world.deps, world.scope, wide);
    await closeSuggestion(world.deps, world.scope, { id: wide.id, expectedRevision: wide.revision, status: "dismissed", decidedBy: "dev1", dismissKind: "one_off" });
    expect(await forgetCorrection(world.deps, world.scope, { correctionSk: correctionSkOf(world, c) })).toEqual({ ok: true });
    await add(world, ZOD_A);
    await group(world);
    expect(openOnes(world)).toEqual([]);
  });
});

describe("W6: a match with an accepted rule sets repeatOf = rule", () => {
  async function acceptedRule(world: World) {
    await add(world, ZOD_A);
    await add(world, ZOD_B);
    await group(world);
    const suggestion = LearningSuggestionSchema.parse(openOnes(world)[0]);
    expect(await closeSuggestion(world.deps, world.scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "accepted", decidedBy: "dev1", ruleId: "rule-1" })).toMatchObject({ ok: true });
    seedItem(world.db, world.scope.orgId, world.scope.project, "RULE#rule-1", {
      entityType: "LEARNING_RULE", id: "rule-1", suggestionId: suggestion.id, stage: "build", text: "Validate request bodies with the zod schema.", processAgentId: "agent-1", requestId: "req-1",
      status: "active", processVersion: 3, projectCreatedAt: PROJECT_CREATED,
    });
    return suggestion;
  }

  it("marks a later similar correction as a repeat of the rule, forms no suggestion, and counts it as a repeat after a rule", async () => {
    const world = makeWorld();
    await acceptedRule(world);
    const c = await add(world, "Check every request body against the zod schema before you use it.");
    const d = await add(world, ZOD_A);
    const result = await group(world);
    expect(correction(world, c)).toMatchObject({ repeatOf: "rule-1" });
    expect(correction(world, d)).toMatchObject({ repeatOf: "rule-1" });
    expect(result.opened).toEqual([]);
    expect(openOnes(world)).toEqual([]);
    expect(await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: false })).toMatchObject({ memberCorrections: 4, repeatsOfAcceptedRules: 2 });
  });

  it("does not count a removed rule", async () => {
    const world = makeWorld();
    const suggestion = await acceptedRule(world);
    seedItem(world.db, world.scope.orgId, world.scope.project, "RULE#rule-1", {
      entityType: "LEARNING_RULE", id: "rule-1", suggestionId: suggestion.id, stage: "build", text: "Validate request bodies.", processAgentId: "agent-1", requestId: "req-1", status: "removed", projectCreatedAt: PROJECT_CREATED,
    });
    const c = await add(world, ZOD_A);
    await group(world);
    expect(correction(world, c)?.repeatOf).not.toBe("rule-1");
  });

  it("a repeat of an accepted rule never reopens a suggestion for it, even one judged before the rule was accepted; it only feeds the repeat counts", async () => {
    const world = makeWorld();
    await add(world, ZOD_A);
    await add(world, ZOD_B);
    await group(world);
    const suggestion = LearningSuggestionSchema.parse(openOnes(world)[0]);
    // The rule waits for a second person, so the suggestion is live (not open) while teammates give the same correction again.
    world.db.set({ ...suggestions(world)[0]!, status: "awaiting_approval" });
    const c = await add(world, "Check every request body against the zod schema before you use it.");
    const d = await add(world, "Validate request bodies against the zod schema before handlers use them.");
    await group(world);
    expect(openOnes(world)).toEqual([]);
    expect(suggestions(world)).toHaveLength(1);
    // The rule is published.
    expect(await closeSuggestion(world.deps, world.scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "accepted", decidedBy: "dev1", ruleId: "rule-1" })).toMatchObject({ ok: true });
    seedItem(world.db, world.scope.orgId, world.scope.project, "RULE#rule-1", {
      entityType: "LEARNING_RULE", id: "rule-1", suggestionId: suggestion.id, stage: "build", text: "Validate request bodies with the zod schema.", processAgentId: "agent-1", requestId: "req-1",
      status: "active", processVersion: 3, projectCreatedAt: PROJECT_CREATED,
    });
    const before = await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: false });
    await add(world, ZOD_A);
    const result = await group(world);
    expect(result.opened).toEqual([]);
    expect(openOnes(world)).toEqual([]);
    expect(suggestions(world)).toHaveLength(1);
    expect(correction(world, c)).toBeDefined();
    expect(correction(world, d)).toBeDefined();
    const after = await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: false });
    expect(after.repeatsOfAcceptedRules).toBe(before.repeatsOfAcceptedRules + 1);
    expect(after.suggestions).toBe(before.suggestions);
  });
});

describe("W7: forget", () => {
  it("removes the correction from every count, and a suggestion left with one source is withdrawn with its text cleared", async () => {
    const world = makeWorld();
    const a = await add(world, LINT_A);
    const b = await add(world, LINT_B);
    await group(world);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 2, repeats: 1, suggestions: 1 });
    const suggestionId = openOnes(world)[0]!.id as string;
    expect(await forgetCorrection(world.deps, world.scope, { correctionSk: correctionSkOf(world, b), sourceKey: "key-2" })).toEqual({ ok: true });
    expect(correction(world, b)).toBeUndefined();
    expect(partition(world).find((item) => item.sk === "SOURCE#key-2")).toBeUndefined();
    expect(correction(world, a)).toBeDefined();
    const stored = world.db.get(projectLearningKey(world.scope.orgId, world.scope.project, `SUGGESTION#${suggestionId}`))!;
    expect(stored).toMatchObject({ status: "withdrawn" });
    expect(stored).not.toHaveProperty("proposedText");
    expect(LearningSuggestionSchema.safeParse(stored).success).toBe(true);
    expect(await readLearningState(world.deps, world.scope)).toMatchObject({ liveCorrections: 1, openSuggestions: 0 });
    expect(await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: false })).toMatchObject({ memberCorrections: 1, repeats: 0 });
  });

  it("with three members, takes one out of the suggestion and keeps it open with fresh wording", async () => {
    const world = makeWorld();
    const [a, b] = [await add(world, RETRY_A), await add(world, RETRY_B)];
    await group(world);
    const c = await add(world, RETRY_C);
    await group(world);
    const before = openOnes(world)[0]!;
    expect(idsOf(before)).toEqual([a, b, c]);
    await forgetCorrection(world.deps, world.scope, { correctionSk: correctionSkOf(world, c) });
    const after = openOnes(world)[0]!;
    expect(idsOf(after)).toEqual([a, b]);
    expect(LearningSuggestionSchema.parse(after).proposedText).toContain("jitter");
    expect(after.revision as number).toBeGreaterThan(before.revision as number);
  });

  it("is refused once the correction is in an accepted rule, and for a correction that is gone", async () => {
    const world = makeWorld();
    const a = await add(world, LINT_A);
    await add(world, LINT_B);
    await group(world);
    const suggestion = LearningSuggestionSchema.parse(openOnes(world)[0]);
    await closeSuggestion(world.deps, world.scope, { id: suggestion.id, expectedRevision: suggestion.revision, status: "accepted", decidedBy: "dev1", ruleId: "rule-1" });
    expect(await forgetCorrection(world.deps, world.scope, { correctionSk: correctionSkOf(world, a) })).toEqual({ ok: false, reason: "in_accepted_rule" });
    expect(correction(world, a)).toBeDefined();
    expect(await forgetCorrection(world.deps, world.scope, { correctionSk: "CORRECTION#2026-01-01T00:00:00.000Z#nope" })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("W9: concurrent captures open one suggestion", () => {
  it("three grouping runs at once over the same corrections open exactly one suggestion and count each correction once", async () => {
    const world = makeWorld();
    const ids = [await add(world, LINT_A), await add(world, LINT_B), await add(world, LINT_A), await add(world, LINT_B)];
    await Promise.all([group(world), group(world), group(world)]);
    expect(suggestions(world)).toHaveLength(1);
    expect(idsOf(suggestions(world)[0]!)).toEqual([...ids].sort());
    expect((await readLearningState(world.deps, world.scope))!.openSuggestions).toBe(1);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 4, suggestions: 1 });
    for (const id of ids) expect(correction(world, id)).toMatchObject({ suggestionId: suggestions(world)[0]!.id });
  });

  it("a correction racing a grouping run joins the one suggestion; it is never in two", async () => {
    const world = makeWorld();
    await add(world, LINT_A);
    await add(world, LINT_B);
    await group(world);
    const c = await add(world, LINT_A);
    const d = await add(world, ZOD_A);
    const e = await add(world, ZOD_B);
    await Promise.all([group(world), group(world)]);
    expect(openOnes(world)).toHaveLength(2);
    expect(openOnes(world).filter((item) => (item.correctionIds as string[]).includes(c))).toHaveLength(1);
    expect(openOnes(world).some((item) => idsOf(item).join() === [d, e].sort().join())).toBe(true);
  });
});

describe("W10: the metric counts each correction once, even when grouping fails and runs again", () => {
  it("a failed suggestion write leaves the judgement counted once; the re-run opens the suggestion and counts nothing twice", async () => {
    const world = makeWorld();
    await add(world, LINT_A);
    await add(world, LINT_B);
    world.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("SUGGESTION#"), error: { name: "InternalServerError", message: "boom" } });
    await expect(group(world)).rejects.toBeDefined();
    expect(suggestions(world)).toEqual([]);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 2, repeats: 1 });
    await group(world);
    expect(openOnes(world)).toHaveLength(1);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 2, repeats: 1, suggestions: 1 });
    await group(world);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 2, repeats: 1, suggestions: 1 });
  });

  it("a failed judgement counts nothing and the re-run counts it once", async () => {
    const world = makeWorld();
    await add(world, ZOD_A);
    world.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("METRIC#"), error: { name: "InternalServerError", message: "boom" } });
    await expect(group(world)).rejects.toBeDefined();
    expect(metricItem(world)).toBeUndefined();
    await group(world);
    await group(world);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 1 });
  });

  it("does not depend on repeatOf being set earlier: repeatOf is worked out in the same transaction that counts", async () => {
    const world = makeWorld();
    const a = await add(world, RETRY_A);
    const b = await add(world, RETRY_B);
    const c = await add(world, RETRY_C);
    await group(world);
    expect(correction(world, a)?.repeatOf).toBeUndefined();
    expect(correction(world, b)?.repeatOf).toBe(a);
    expect(correction(world, c)?.repeatOf).toBe(b);
    expect(await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: false })).toMatchObject({ memberCorrections: 3, repeats: 2 });
    expect(LearningCorrectionSchema.safeParse(correction(world, b)).success).toBe(true);
  });

  it("counts only member corrections (outsider ones are judged but not counted)", async () => {
    const world = makeWorld();
    await add(world, LINT_A, { standing: "outsider" });
    await add(world, LINT_B);
    await group(world);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 1 });
    expect(metricItem(world)!.repeats ?? 0).toBe(0);
  });
});

describe("the cap of 20 open suggestions: the 21st group waits", () => {
  it("leaves the pair free, still counts it, and forms the suggestion once a slot frees", async () => {
    const world = makeWorld();
    for (let n = 0; n < LEARNING_OPEN_SUGGESTIONS_MAX; n += 1) {
      const opened = await openSuggestion(world.deps, world.scope, { id: `fill${n}`, stage: "build", correctionIds: [`x${n}`, `y${n}`], allFromOnePerson: false, proposedText: "Fill.", signature: ["h"], lessSafe: false, kinds: [], overlaps: [] });
      expect(opened).toMatchObject({ ok: true });
    }
    await add(world, LINT_A);
    await add(world, LINT_B);
    const result = await group(world);
    expect(result).toMatchObject({ opened: [], capped: true });
    expect(openOnes(world).filter((item) => !String(item.id).startsWith("fill"))).toEqual([]);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 2 });
    const filler = LearningSuggestionSchema.parse(openOnes(world)[0]);
    await closeSuggestion(world.deps, world.scope, { id: filler.id, expectedRevision: filler.revision, status: "withdrawn" });
    await group(world);
    expect(openOnes(world).filter((item) => !String(item.id).startsWith("fill"))).toHaveLength(1);
    expect(metricItem(world)).toMatchObject({ memberCorrections: 2 });
  });
});

describe("PR capture off: PR corrections are skipped, and suggestions left with fewer than 2 non-PR sources are withdrawn", () => {
  it("reads the project setting: absent or off is off, on is on, and a caller can plug in its own check", async () => {
    const world = makeWorld();
    expect(await prCaptureOff(world.deps, world.scope)).toBe(true);
    settingsOn(world);
    expect(await prCaptureOff(world.deps, world.scope)).toBe(false);
    settingsOff(world);
    expect(await prCaptureOff(world.deps, world.scope)).toBe(true);
    settingsOn(world);
    await add(world, LINT_A, { source: "pr_comment" });
    await add(world, LINT_B, { source: "pr_comment" });
    await group(world, { prCaptureOff: async () => true });
    expect(suggestions(world)).toEqual([]);
  });

  it("with capture off, PR corrections are not judged, not counted and not grouped (they keep their text)", async () => {
    const world = makeWorld();
    const a = await add(world, LINT_A, { source: "pr_comment" });
    await add(world, LINT_B, { source: "pr_comment" });
    await add(world, LINT_A);
    await group(world);
    expect(suggestions(world)).toEqual([]);
    expect(correction(world, a)).toMatchObject({ text: LINT_A });
    expect(correction(world, a)?.groupedAt).toBeUndefined();
    expect(metricItem(world)).toMatchObject({ memberCorrections: 1 });
  });

  it("with capture on they group; turning it off withdraws a suggestion left with one non-PR source and clears its text", async () => {
    const world = makeWorld();
    settingsOn(world);
    await add(world, LINT_A);
    await add(world, LINT_B, { source: "pr_comment" });
    await group(world);
    const id = openOnes(world)[0]!.id as string;
    settingsOff(world);
    expect(await withdrawPrDependentSuggestions(world.deps, world.scope)).toEqual([id]);
    const stored = world.db.get(projectLearningKey(world.scope.orgId, world.scope.project, `SUGGESTION#${id}`))!;
    expect(stored).toMatchObject({ status: "withdrawn" });
    expect(stored).not.toHaveProperty("proposedText");
    expect(LearningSuggestionSchema.safeParse(stored).success).toBe(true);
    expect((await readLearningState(world.deps, world.scope))!.openSuggestions).toBe(0);
  });

  it("grouping finds capture off by itself, and the PR member of a suggestion with two other sources is dropped from it", async () => {
    const world = makeWorld();
    settingsOn(world);
    const a = await add(world, LINT_A);
    const b = await add(world, LINT_B);
    const p = await add(world, LINT_A, { source: "pr_comment" });
    await group(world);
    expect(idsOf(openOnes(world)[0]!)).toEqual([a, b, p]);
    settingsOff(world);
    const result = await group(world);
    expect(result.withdrawn).toEqual([]);
    expect(idsOf(openOnes(world)[0]!)).toEqual([a, b]);
    expect(correction(world, p)?.suggestionId).toBeUndefined();
    expect(correction(world, p)).toMatchObject({ text: LINT_A });
  });

  it("the metric view leaves PR corrections out while capture is off and counts them again when it is on", async () => {
    const world = makeWorld();
    settingsOn(world);
    await add(world, LINT_A);
    await add(world, LINT_B, { source: "pr_comment" });
    await group(world);
    expect(await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: false })).toMatchObject({ memberCorrections: 2, repeats: 1 });
    expect(await readMetric(world.deps, world.scope, monthOf(world), { prCaptureOff: true })).toMatchObject({ memberCorrections: 1, repeats: 0 });
  });
});

describe("a project created again", () => {
  it("does not see the earlier project's corrections, suggestions or metric", async () => {
    const world = makeWorld();
    await add(world, LINT_A);
    await add(world, LINT_B);
    await group(world);
    const second = makeWorld({ db: world.db, projectCreatedAt: new Date(Date.parse(PROJECT_CREATED) + DAY_MS).toISOString() });
    second.clock.ms = world.clock.ms;
    await add(second, LINT_A);
    const result = await group(second);
    expect(result.opened).toEqual([]);
    expect(await readMetric(second.deps, second.scope, monthOf(second), { prCaptureOff: false })).toMatchObject({ memberCorrections: 1, repeats: 0, suggestions: 0 });
  });
});
