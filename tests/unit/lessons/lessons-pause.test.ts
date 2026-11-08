// Lessons in production, lane 1b: learning is never silent. The reflector and the curator's judge record ONE current "lessons paused" reason (a fixed code and a time) when learning cannot run, and clear it
// when a call succeeds; the model's hold is sized by its own quote; a failed call counts toward the nightly budget (R6); a CI failure from the subject source's CI path is a measured outcome (R2).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LESSONS_PAUSE_CODES, lessonsPauseText, teamRecordPk } from "../../../packages/contracts/src/index.js";
import { lessonSubjectSource } from "../../../packages/broker/src/aws/broker/lesson-subject-source.js";
import { taskKey, taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { LearningRefusal, dynamoPauseStore, pauseScopeOf, type CurrentPause, type LessonsPauseStore } from "../../../packages/broker/src/lessons/pause.js";
import type { PipelineModel } from "../../../packages/broker/src/lessons/ports.js";
import { buildReflectorInput } from "../../../packages/broker/src/lessons/reflect-input.js";
import { curateDraft, type CurateDeps } from "../../../packages/broker/src/lessons/curate.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { reflectSubject, type ReflectDeps } from "../../../packages/broker/src/lessons/reflect.js";
import { buildTaskReflectSubject } from "../../../packages/broker/src/lessons/task-subject.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, draft, embedder, memberSpan, reply, settings, subject, verifier } from "./lesson-helpers.js";

class MemoryPause implements LessonsPauseStore {
  current = new Map<string, CurrentPause>();
  log: string[] = [];
  private key(ws: string, project: string | undefined): string { return `${ws}/${project ?? "*"}`; }
  async record(ws: string, project: string, code: CurrentPause["code"]): Promise<void> { this.log.push(`record:${code}`); this.current.set(this.key(ws, pauseScopeOf(code) === "company" ? undefined : project), { code, at: 1, scope: pauseScopeOf(code) }); }
  async clear(ws: string, project: string): Promise<void> { this.log.push("clear"); this.current.delete(this.key(ws, project)); this.current.delete(this.key(ws, undefined)); }
  async read(ws: string, project: string): Promise<CurrentPause | undefined> { return this.current.get(this.key(ws, project)) ?? this.current.get(this.key(ws, undefined)); }
}

/** A model that can quote: the hold it names is what `admit` is asked about and what `complete` is given as its ceiling. */
class QuotingModel extends ScriptedModel implements PipelineModel {
  quotes: Array<Record<string, unknown>> = [];
  constructor(replies: ConstructorParameters<typeof ScriptedModel>[0], public answer: Awaited<ReturnType<NonNullable<PipelineModel["quote"]>>>) { super(replies); }
  async quote(request: Parameters<NonNullable<PipelineModel["quote"]>>[0]) { this.quotes.push({ ...request }); return this.answer; }
}

function deps(model: PipelineModel, over: Partial<ReflectDeps> = {}) {
  const pause = new MemoryPause(), spend = new Spend(), clock = new Clock();
  const d: ReflectDeps = { model, spend, audit: new Audit(), settings: settings(), edition: "public", now: clock.now, newId: () => "run-1", pause, ...over };
  return { d, pause, spend };
}
const one = () => subject([memberSpan("Use withRetry for retries in api.")]);

describe("every code has its one line, and the scope it belongs to", () => {
  it("each code has fixed words that start with 'Lessons paused', and only the monthly limit is the company's", () => {
    for (const code of LESSONS_PAUSE_CODES) { expect(lessonsPauseText(code)).toMatch(/^Lessons paused: /u); expect(pauseScopeOf(code)).toBe(code === "monthly_limit" ? "company" : "project"); }
    expect(lessonsPauseText("monthly_limit")).toBe("Lessons paused: monthly learning limit reached");
    expect(lessonsPauseText("something_new")).toBe("Lessons paused");
  });
});

describe("the reflector records why learning cannot run, and clears it when a call succeeds", () => {
  it("a quote that refuses (no provider, every model forbidden, over budget) records its code, makes no call and says learning_paused", async () => {
    for (const code of ["no_provider", "all_models_forbidden", "no_suitable_model", "no_budget", "cost_too_high"] as const) {
      const model = new QuotingModel([], { ok: false, code });
      const { d, pause, spend } = deps(model);
      expect(await reflectSubject(d, one())).toMatchObject({ status: "skipped", reason: "learning_paused" });
      expect(model.calls).toHaveLength(0);
      expect(spend.asked).toEqual([]);
      expect(await pause.read(WS, PROJECT)).toMatchObject({ code, scope: "project" });
    }
  });

  it("the monthly learning limit (the cheap look refuses) is recorded for the company", async () => {
    const model = new QuotingModel([], { ok: true, usd: 0.03 });
    const { d, pause, spend } = deps(model);
    spend.admitted = false;
    expect(await reflectSubject(d, one())).toMatchObject({ status: "skipped", reason: "spend_refused" });
    expect(await pause.read(WS, "another-project")).toMatchObject({ code: "monthly_limit", scope: "company" });
  });

  it("a refusal thrown by the model's own call (the month filled up meanwhile) is recorded and nothing is spent", async () => {
    const model = new QuotingModel([new LearningRefusal("monthly_limit", "learning's monthly limit is used up")], { ok: true, usd: 0.03 });
    const { d, pause } = deps(model);
    const budget = { spentUsd: 0, capUsd: 2 };
    expect(await reflectSubject(d, one(), budget)).toMatchObject({ status: "skipped", reason: "learning_paused" });
    expect(budget.spentUsd).toBe(0);
    expect((await pause.read(WS, PROJECT))?.code).toBe("monthly_limit");
  });

  it("the hold is sized by the model's quote: the look and the call are given that figure, not a fixed one", async () => {
    const model = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.0123 });
    const { d, spend } = deps(model);
    await reflectSubject(d, one());
    expect(model.quotes).toHaveLength(1);
    expect(spend.asked).toEqual([0.0123]);
    expect(model.calls[0]).toMatchObject({ budgetUsd: 0.0123, purpose: "reflect", project: PROJECT });
  });

  it("a call that succeeds clears the project's reason and the company's", async () => {
    const model = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.03 });
    const { d, pause } = deps(model);
    await pause.record(WS, PROJECT, "no_provider");
    await pause.record(WS, PROJECT, "monthly_limit");
    expect(pause.current.size).toBe(2);
    expect((await reflectSubject(d, one())).status).toBe("ok");
    expect(pause.current.size).toBe(0);
  });

  it("a pause store that throws never breaks learning", async () => {
    const model = new QuotingModel([reply(candidateJson())], { ok: true, usd: 0.03 });
    const broken: LessonsPauseStore = { record: async () => { throw new Error("down"); }, clear: async () => { throw new Error("down"); }, read: async () => { throw new Error("down"); } };
    const { d } = deps(model, { pause: broken });
    expect((await reflectSubject(d, one())).status).toBe("ok");
    const refused = new QuotingModel([], { ok: false, code: "no_provider" });
    expect((await reflectSubject(deps(refused, { pause: broken }).d, one())).reason).toBe("learning_paused");
  });

  it("a model that cannot quote keeps the edition's fixed estimate (the old behaviour)", async () => {
    const model = new ScriptedModel([reply(candidateJson())]);
    const { d, spend } = deps(model);
    await reflectSubject(d, one());
    expect(spend.asked).toEqual([0.15]);
  });

  it("a per-task cap somebody set on purpose still binds a sized call", async () => {
    const model = new QuotingModel([], { ok: true, usd: 0.5 });
    const { d, pause } = deps(model, { capsOverride: { perTaskUsd: 0.2 } });
    expect(await reflectSubject(d, one())).toMatchObject({ reason: "learning_paused" });
    expect((await pause.read(WS, PROJECT))?.code).toBe("cost_too_high");
  });
});

describe("R6: a failed call counts toward the nightly budget; a call refused before it started does not", () => {
  it("adds the hold of a failed call to what the night has spent, so a provider that keeps failing stops the night", async () => {
    const model = new QuotingModel([new Error("provider down"), new Error("provider down"), new Error("provider down")], { ok: true, usd: 0.6 });
    const { d } = deps(model);
    const budget = { spentUsd: 0, capUsd: 1 };
    expect((await reflectSubject(d, one(), budget)).reason).toBe("model_error");
    expect(budget.spentUsd).toBeCloseTo(0.6, 6);
    // The second would pass the night's cap (0.6 + 0.6 > 1), so it is not made.
    expect((await reflectSubject(d, one(), budget)).reason).toBe("night_cap");
    expect(model.calls).toHaveLength(1);
  });
});

describe("the pause store", () => {
  const table = () => { const db = new FakeDynamoDb(); return { db, store: dynamoPauseStore({ documentClient: db, tableName: "team" }, () => 1234) }; };

  it("keeps one reason per project and one for the company; reads the project's own first, then the company's", async () => {
    const { store } = table();
    await store.record(WS, "web", "no_provider");
    await store.record(WS, "web", "monthly_limit");
    await store.record(WS, "api", "all_models_forbidden");
    expect(await store.read(WS, "web")).toEqual({ code: "no_provider", at: 1234, scope: "project" });
    expect(await store.read(WS, "api")).toMatchObject({ code: "all_models_forbidden" });
    expect(await store.read(WS, "docs")).toEqual({ code: "monthly_limit", at: 1234, scope: "company" });
    // Another company sees nothing.
    expect(await store.read("org_bbbbbbbbbbbbbbbbbbbb", "web")).toBeUndefined();
  });

  it("a later reason replaces the earlier one, and a success clears the project's and the company's", async () => {
    const { store } = table();
    await store.record(WS, "web", "no_provider");
    await store.record(WS, "web", "no_budget");
    expect((await store.read(WS, "web"))?.code).toBe("no_budget");
    await store.record(WS, "web", "monthly_limit");
    await store.clear(WS, "web");
    expect(await store.read(WS, "web")).toBeUndefined();
  });

  it("holds only a fixed code and a time, and an item with another code reads as nothing", async () => {
    const { db, store } = table();
    await store.record(WS, "web", "no_provider");
    const stored = db.get({ pk: teamRecordPk(WS, "web"), sk: "LESSONSET#PAUSED" }) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["at", "code", "entityType", "pk", "sk"]);
    expect(stored).toMatchObject({ code: "no_provider", at: 1234 });
    db.set({ pk: `WS#${WS}#P#web`, sk: "LESSONSET#PAUSED", code: "something with a model name claude-opus", at: 5 });
    expect(await store.read(WS, "web")).toBeUndefined();
  });

  it("a table that fails is never an error for learning", async () => {
    const failing = dynamoPauseStore({ documentClient: { send: async () => { throw new Error("down"); } }, tableName: "team" }, () => 1);
    await expect(failing.record(WS, "web", "no_provider")).resolves.toBeUndefined();
    await expect(failing.clear(WS, "web")).resolves.toBeUndefined();
    await expect(failing.read(WS, "web")).resolves.toBeUndefined();
  });
});

describe("R2: a CI failure from the subject source's CI path is a measured outcome", () => {
  const TASK = randomUUID();
  const CREATOR = "creator-1", STARTER = "starter-1";
  function sourceSubject() {
    const db = new FakeDynamoDb();
    db.set({
      ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: WS, project: PROJECT, developerId: CREATOR, developerName: "Creator", provider: "oidc", client: "web",
      requestText: "Make the retries use withRetry", title: "Retries", agent: { agentId: "a" }, startedBy: { developerId: STARTER }, ownerKey: taskOwnerKey(CREATOR, TASK),
      workflow: {
        schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK, ownerId: taskOwnerKey(CREATOR, TASK), revision: 3, stage: "WAIT_FOR_MERGE", state: "COMPLETE", outcome: "MERGED",
        createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", artifacts: [], decisions: [],
        reviewBase: [{ repositoryId: "api", baseCommitSha: "a".repeat(40) }], fixSource: "ci", fixProblems: ["unit tests"],
        pullRequests: [{ repositoryId: "api", number: 7, url: "https://github.com/acme/api/pull/7", candidateDigest: "b".repeat(64), required: true, state: "MERGED" }],
      },
    });
    const source = lessonSubjectSource({ documentClient: db, tableName: "state", repositoriesOf: async () => ["api"], standing: async () => "member", isErased: async () => false, visibility: async () => ({ kind: "shared" }), now: () => 1_800_000_000_000 });
    return source;
  }
  const measuredOf = async (mutate: (spans: Array<Record<string, unknown>>) => void = () => undefined) => {
    const base = (await sourceSubject().read({ workspaceId: WS, taskId: TASK }))!;
    const built = buildTaskReflectSubject({ ...base.facts, sendBacks: [] });
    mutate(built.spans as unknown as Array<Record<string, unknown>>);
    const input = buildReflectorInput(built);
    if (!input.eligible) throw new Error("expected eligible");
    // The model cites the creator's own request only; the CI failure is read, not cited.
    const intent = [...input.spans.values()].find((span) => span.kind === "intent")!;
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: [intent.id] }))]);
    const result = await reflectSubject(deps(model, { settings: settings() }).d, built);
    return { measured: result.drafts[0]?.provenance.measured, ci: [...input.spans.values()].filter((span) => span.kind === "ci_failure") };
  };

  it("through the real subject source: the CI span carries the worker-text trust 'system' and the CI source key, and the lesson is measured (a person stands behind it and the check is independent of them)", async () => {
    const out = await measuredOf();
    expect(out.ci).toHaveLength(1);
    expect(out.ci[0]).toMatchObject({ trust: "system", sourceKey: "ci" });
    expect(out.measured).toBe(true);
  });

  it("a CI-shaped span that did not come through the CI path (no CI source key) is still not measured", async () => {
    const out = await measuredOf((spans) => { for (const span of spans) if (span.kind === "ci_failure") delete span.sourceKey; });
    expect(out.measured).toBe(false);
  });

  it("a CI failure the source attributes to the lesson's own author is not independent evidence", async () => {
    const out = await measuredOf((spans) => { for (const span of spans) if (span.kind === "ci_failure") span.authorId = CREATOR; });
    expect(out.measured).toBe(false);
  });
});

describe("the curator's judge is sized by the same quote and pauses the same way", () => {
  const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
  const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
  const text = (title: string, body: string) => draft({ title, description: "", body });
  function curation(model: PipelineModel) {
    const pause = new MemoryPause(), spend = new Spend();
    let n = 0;
    const d: CurateDeps & { verifier: unknown; settings: unknown } = {
      store: new InMemoryLessonStore(), embedder, vectors: new MemoryVectors(), judgeModel: model, spend, audit: new Audit(), alerts: new Alerts(), now: new Clock().now,
      verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`, pause,
    };
    return { d, pause, spend };
  }

  it("asks the model for the hold of the judge call, looks at the month with it, and clears an old reason when the judge answers", async () => {
    const model = new QuotingModel([JSON.stringify({ verdict: "different" })], { ok: true, usd: 0.004 });
    const { d, pause, spend } = curation(model);
    await pause.record(WS, PROJECT, "no_provider");
    await curateDraft(d, KEY, text("Retries", a));
    await curateDraft(d, KEY, text("Retries", b));
    expect(model.quotes[0]).toMatchObject({ purpose: "judge", project: PROJECT, maxOutputTokens: 120 });
    expect(spend.asked).toEqual([0.004]);
    expect(model.calls[0]).toMatchObject({ budgetUsd: 0.004 });
    expect(await pause.read(WS, PROJECT)).toBeUndefined();
  });

  it("a refused quote records its code and no judge call is made (the lesson goes to a person)", async () => {
    const model = new QuotingModel([], { ok: false, code: "all_models_forbidden" });
    const { d, pause } = curation(model);
    await curateDraft(d, KEY, text("Retries", a));
    const out = await curateDraft(d, KEY, text("Retries", b));
    expect(out).toBeDefined();
    expect(model.calls).toHaveLength(0);
    expect((await pause.read(WS, PROJECT))?.code).toBe("all_models_forbidden");
  });

  it("the month's limit refusing the look is recorded for the company", async () => {
    const model = new QuotingModel([], { ok: true, usd: 0.004 });
    const { d, pause, spend } = curation(model);
    await curateDraft(d, KEY, text("Retries", a));
    spend.admitted = false;
    await curateDraft(d, KEY, text("Retries", b));
    expect(model.calls).toHaveLength(0);
    expect(await pause.read(WS, "any")).toMatchObject({ code: "monthly_limit", scope: "company" });
  });
});
