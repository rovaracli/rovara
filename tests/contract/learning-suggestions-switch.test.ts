// v1.2 learning loop: the company's master "suggestions" switch (contract 2026-10-30). Off keeps capture running and stops everything that makes or shows a suggestion; the value in force is the
// company's own record, else the install default (deployment config, off). The test environment's install default is ON (tests/support/vitest-shared-config.ts), so a test that wants the
// production default passes an empty environment or stubs it.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LearningCompanySettingsAnswerReaderSchema, LearningCompanySettingsAnswerSchema, LearningCorrectionSchema, LearningSuggestionSchema, orgLearningSettingsKey, projectLearningKey,
  type LearningCompanySettingsAnswer, type OrgId,
} from "../../packages/contracts/src/index.js";
import { groupCorrections } from "../../packages/broker/src/learning/grouping.js";
import { metricMonth, readMetric } from "../../packages/broker/src/learning/metric.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { captureCorrection, openSuggestion } from "../../packages/broker/src/learning/store.js";
import { effectiveFromItem, effectiveSuggestions, installSuggestionsDefault, suggestionsOff } from "../../packages/broker/src/learning/suggestions-switch.js";
import { LEARNING_SETTINGS_PATH, routeLearningSettings } from "../../packages/broker/src/learning/settings-routes.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DAY_MS, NOW_MS, PROJECT_CREATED, makeWorld, seedItem, type World } from "../support/learning-world.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { vi.unstubAllEnvs(); });

const ORG = TEST_ORG;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MEMBER = "c".repeat(64);
const SALT = "project-salt-one";
const LINT_A = "Always run the linter before committing changes to the repository.";
const LINT_B = "Run the linter before you commit any changes to the repository.";
const recordOf = (suggestions: "on" | "off" | "auto", revision = 1) => ({ ...orgLearningSettingsKey(ORG), entityType: "LEARNING_COMPANY_SETTINGS", orgId: ORG, revision, suggestions, changedBy: OWNER, changedAt: new Date(NOW_MS).toISOString() });
const setSwitch = (world: World, suggestions: "on" | "off" | "auto", revision = 1) => world.db.set(recordOf(suggestions, revision));
const callerOf = (developerId: string, orgRole: "owner" | "admin" | "member"): DeveloperCaller => ({ developerId, sessionId: "s", amr: "oidc", name: "x", orgId: ORG, orgRole, browserSession: true });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string; status?: number }) => ({ code: error.code, message: error.message }));

describe("the value in force", () => {
  it("is off with no company record and no install default", async () => {
    const world = makeWorld();
    expect(installSuggestionsDefault({})).toBe("off");
    expect(await effectiveSuggestions(world.deps, ORG, {})).toEqual({ suggestions: "off", source: "install_default", revision: 0 });
  });

  it("follows the install default when the company never chose: only the exact word on turns it on", async () => {
    const world = makeWorld();
    for (const value of ["", "ON", "true", "1", "enabled", "off"]) expect(installSuggestionsDefault({ LEARNING_SUGGESTIONS_DEFAULT: value }), value).toBe("off");
    expect(await effectiveSuggestions(world.deps, ORG, { LEARNING_SUGGESTIONS_DEFAULT: "on" })).toEqual({ suggestions: "on", source: "install_default", revision: 0 });
  });

  it("is the company's own record when there is one, in both directions, whatever the install default says", async () => {
    const world = makeWorld();
    setSwitch(world, "off", 3);
    expect(await effectiveSuggestions(world.deps, ORG, { LEARNING_SUGGESTIONS_DEFAULT: "on" })).toEqual({ suggestions: "off", source: "company", revision: 3 });
    setSwitch(world, "on", 4);
    expect(await effectiveSuggestions(world.deps, ORG, { LEARNING_SUGGESTIONS_DEFAULT: "off" })).toEqual({ suggestions: "on", source: "company", revision: 4 });
  });

  it("skips a record it cannot read (an unknown value from a newer writer) and falls back to the install default, without throwing", async () => {
    const world = makeWorld();
    setSwitch(world, "auto", 2);
    expect(effectiveFromItem(world.db.get(orgLearningSettingsKey(ORG)) as Record<string, unknown>, { LEARNING_SUGGESTIONS_DEFAULT: "on" })).toEqual({ suggestions: "on", source: "install_default", revision: 0 });
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "off");
    expect(await suggestionsOff(world.deps, world.scope)).toBe(true);
  });

  it("keeps a company's choice apart from another company's", async () => {
    const world = makeWorld();
    setSwitch(world, "off", 1);
    const other = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
    expect((await effectiveSuggestions(world.deps, other, { LEARNING_SUGGESTIONS_DEFAULT: "on" })).source).toBe("install_default");
  });
});

describe("the install default is deployment config", () => {
  it("is a packed broker setting: AGENTX_SETTINGS code lg hydrates LEARNING_SUGGESTIONS_DEFAULT, which the switch reads (off unless exactly on)", async () => {
    const { BROKER_SETTINGS } = await import("../../packages/contracts/src/index.js");
    const { hydrateBrokerEnvironment } = await import("../../packages/broker/src/aws/broker-environment.js");
    expect(BROKER_SETTINGS.learningSuggestionsDefault).toEqual({ code: "lg", variable: "LEARNING_SUGGESTIONS_DEFAULT" });
    for (const [packed, expected] of [["lg=on", "on"], ["lg=off", "off"], ["", "off"]] as const) {
      const env: Record<string, string | undefined> = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging", AGENTX_SETTINGS: packed };
      hydrateBrokerEnvironment(env);
      expect(installSuggestionsDefault(env), packed).toBe(expected);
    }
  });
});

describe("GET and PUT /v1/app/org/learning-settings", () => {
  function setup(extra: { limits?: { person?: number; company?: number } } = {}) {
    const db = new FakeDynamoDb();
    const clock = { ms: NOW_MS };
    const audit = capturingAuditDeps({ db, now: () => clock.ms });
    const deps = { documentClient: db, tableName: "state", now: () => clock.ms, audit: audit.audit, ...extra };
    const get = (caller: DeveloperCaller) => routeLearningSettings(deps, caller, "GET", () => undefined);
    const put = (caller: DeveloperCaller, body: unknown) => routeLearningSettings(deps, caller, "PUT", () => body);
    return { db, clock, audit, deps, get, put };
  }

  it("answers any company member with the install default first: source install_default, revision 0, canChange only for owner and admin", async () => {
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "off");
    const s = setup();
    const member = await s.get(callerOf(MEMBER, "member"));
    expect(member).toEqual({ suggestions: "off", source: "install_default", revision: 0, canChange: false });
    expect(LearningCompanySettingsAnswerSchema.safeParse(member).success).toBe(true);
    expect(LearningCompanySettingsAnswerReaderSchema.safeParse({ ...member, somethingNew: 1 }).success).toBe(true);
    expect((await s.get(callerOf(ADMIN, "admin"))).canChange).toBe(true);
    expect((await s.get(callerOf(OWNER, "owner"))).canChange).toBe(true);
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "on");
    expect(await s.get(callerOf(MEMBER, "member"))).toMatchObject({ suggestions: "on", source: "install_default" });
  });

  it("lets an owner and an admin turn it on and off at once, with the revision moving by one each time", async () => {
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "off");
    const s = setup();
    expect(await s.put(callerOf(OWNER, "owner"), { expectedRevision: 0, suggestions: "on" })).toEqual({ suggestions: "on", source: "company", revision: 1, canChange: true });
    expect(await s.get(callerOf(MEMBER, "member"))).toEqual({ suggestions: "on", source: "company", revision: 1, canChange: false });
    expect(await s.put(callerOf(ADMIN, "admin"), { expectedRevision: 1, suggestions: "off" })).toEqual({ suggestions: "off", source: "company", revision: 2, canChange: true });
    expect(s.db.get(orgLearningSettingsKey(ORG))).toMatchObject({ suggestions: "off", revision: 2, changedBy: ADMIN, orgId: ORG });
  });

  it("refuses a member (FORBIDDEN), writes nothing and audits nothing", async () => {
    const s = setup();
    expect(await failure(s.put(callerOf(MEMBER, "member"), { expectedRevision: 0, suggestions: "on" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(s.db.get(orgLearningSettingsKey(ORG))).toBeUndefined();
    expect(s.audit.recorded()).toEqual([]);
  });

  it("answers a stale revision with 409 LEARNING_SETTINGS_CHANGED, and changes nothing", async () => {
    const s = setup();
    await s.put(callerOf(OWNER, "owner"), { expectedRevision: 0, suggestions: "on" });
    expect(await failure(s.put(callerOf(ADMIN, "admin"), { expectedRevision: 0, suggestions: "off" }))).toMatchObject({ code: "LEARNING_SETTINGS_CHANGED" });
    expect(await failure(s.put(callerOf(ADMIN, "admin"), { expectedRevision: 5, suggestions: "off" }))).toMatchObject({ code: "LEARNING_SETTINGS_CHANGED" });
    expect(s.db.get(orgLearningSettingsKey(ORG))).toMatchObject({ suggestions: "on", revision: 1 });
    const { errorStatus } = await import("../../packages/contracts/src/index.js");
    expect(errorStatus("LEARNING_SETTINGS_CHANGED")).toBe(409);
    expect(errorStatus("LEARNING_SUGGESTIONS_OFF")).toBe(409);
  });

  it("creates the company record only once from the install default: a second first-write is a conflict, even when the race left the same value", async () => {
    const s = setup();
    const first = s.put(callerOf(OWNER, "owner"), { expectedRevision: 0, suggestions: "on" });
    expect(await first).toMatchObject({ revision: 1 });
    expect(await failure(s.put(callerOf(ADMIN, "admin"), { expectedRevision: 0, suggestions: "on" }))).toMatchObject({ code: "LEARNING_SETTINGS_CHANGED" });
  });

  it("reads a record with a value and a revision but no changedBy or changedAt as the company's, so the next write is not stuck (review M5)", async () => {
    const s = setup();
    const { changedBy: _by, changedAt: _at, ...bare } = recordOf("on", 3);
    void _by; void _at;
    s.db.set(bare);
    expect(await s.get(callerOf(OWNER, "owner"))).toMatchObject({ suggestions: "on", source: "company", revision: 3 });
    expect(await s.put(callerOf(OWNER, "owner"), { expectedRevision: 3, suggestions: "off" })).toMatchObject({ suggestions: "off", source: "company", revision: 4 });
  });

  it("replaces a record it cannot read at the first write instead of being stuck behind it", async () => {
    const s = setup();
    s.db.set(recordOf("auto", 7));
    expect(await s.get(callerOf(OWNER, "owner"))).toMatchObject({ source: "install_default", revision: 0 });
    expect(await s.put(callerOf(OWNER, "owner"), { expectedRevision: 0, suggestions: "off" })).toMatchObject({ suggestions: "off", source: "company", revision: 1 });
  });

  it("audits both directions as rule.suggestions_set with the setting, the previous value and the source, by the person who changed it", async () => {
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "off");
    const s = setup();
    await s.put(callerOf(OWNER, "owner"), { expectedRevision: 0, suggestions: "on" });
    await s.put(callerOf(ADMIN, "admin"), { expectedRevision: 1, suggestions: "off" });
    const events = s.audit.recordedBy("rule.suggestions_set");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ facts: { setting: "on", previous: "off", source: "company", previousSource: "install_default" }, target: { kind: "org", id: ORG }, actor: { kind: "member", id: OWNER } });
    expect(events[1]).toMatchObject({ facts: { setting: "off", previous: "on", source: "company", previousSource: "company" }, actor: { kind: "member", id: ADMIN } });
    // The previous value of a first change from an install default of ON is on.
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "on");
    const second = setup();
    await second.put(callerOf(OWNER, "owner"), { expectedRevision: 0, suggestions: "off" });
    expect(second.audit.recordedBy("rule.suggestions_set")[0]).toMatchObject({ facts: { setting: "off", previous: "on", source: "company", previousSource: "install_default" } });
  });

  it("has strict bodies: an extra field, a bad value or a missing revision is CONFIG_INVALID", async () => {
    const s = setup();
    for (const body of [{ expectedRevision: 0, suggestions: "on", extra: 1 }, { expectedRevision: 0, suggestions: "maybe" }, { suggestions: "on" }, { expectedRevision: -1, suggestions: "on" }, null]) {
      expect(await failure(s.put(callerOf(OWNER, "owner"), body)), JSON.stringify(body)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(s.db.get(orgLearningSettingsKey(ORG))).toBeUndefined();
  });

  it("throttles changes: per person and per company, TOO_MANY_REQUESTS", async () => {
    const s = setup({ limits: { person: 2, company: 3 } });
    await s.put(callerOf(OWNER, "owner"), { expectedRevision: 0, suggestions: "on" });
    await s.put(callerOf(OWNER, "owner"), { expectedRevision: 1, suggestions: "off" });
    expect(await failure(s.put(callerOf(OWNER, "owner"), { expectedRevision: 2, suggestions: "on" }))).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await s.put(callerOf(ADMIN, "admin"), { expectedRevision: 2, suggestions: "on" });
    expect(await failure(s.put(callerOf(ADMIN, "admin"), { expectedRevision: 3, suggestions: "off" }))).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(s.db.get(orgLearningSettingsKey(ORG))).toMatchObject({ revision: 3 });
  });

  it("is browser-only: a bearer-token call is refused by the dispatcher before any table read, for the read and the write", async () => {
    const { loadSlackBroker } = await import("../support/slack-broker.js");
    await loadSlackBroker();
    const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
    const db = new FakeDynamoDb();
    for (const method of ["GET", "PUT"]) {
      const request = { method, headers: { authorization: "Bearer never-authenticate-this" }, body: "{}" };
      await expect(routeDeveloperRequest({ documentClient: db } as never, request as never, new URL(LEARNING_SETTINGS_PATH, "https://app.example.test"))).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("live browser session") as string });
    }
    expect(db.commandNames()).toEqual([]);
    // A live browser session passes the guard and reaches the route.
    const request = { method: "GET", headers: {}, body: "" };
    const answer = await routeDeveloperRequest({ documentClient: db, tableName: "state", now: () => NOW_MS } as never, request as never, new URL(LEARNING_SETTINGS_PATH, "https://app.example.test"), { caller: callerOf(MEMBER, "member"), csrf: "x" }) as LearningCompanySettingsAnswer;
    expect(answer).toMatchObject({ source: "install_default", revision: 0, canChange: false });
  });
});

let counter = 0;
/** Captures one correction the way B3/B4 do. */
async function add(world: World, text: string, options: { task?: string; source?: "comment" | "send_back" | "pr_comment"; author?: string } = {}): Promise<string> {
  world.clock.ms += 1000;
  counter += 1;
  const id = `c${counter}`;
  const source = options.source ?? "comment";
  const result = await captureCorrection(world.deps, world.scope, {
    id, stage: "build", source, sourceKey: `key-${counter}`, sourceRef: { taskId: options.task ?? `t${counter}` }, taskId: options.task ?? `t${counter}`, text,
    signature: [...signatureOf(text, SALT)], author: options.author ?? `dev${counter}`, standing: "member", limit: source === "pr_comment" ? "automatic_pr" : "automatic",
  });
  expect(result).toMatchObject({ ok: true, created: true });
  return id;
}
const partition = (world: World) => world.db.find((item) => item.pk === projectLearningKey(world.scope.orgId, world.scope.project, "STATE").pk);
const suggestionsOf = (world: World) => partition(world).filter((item) => String(item.sk).startsWith("SUGGESTION#"));
const correctionsOf = (world: World) => partition(world).filter((item) => String(item.sk).startsWith("CORRECTION#"));
const prSetting = (world: World, prComments: "on" | "off") => seedItem(world.db, world.scope.orgId, world.scope.project, "SETTINGS", {
  entityType: "LEARNING_SETTINGS", revision: 1, prComments, changedBy: "dev9", changedAt: new Date(NOW_MS).toISOString(), projectCreatedAt: PROJECT_CREATED,
});

describe("grouping while the switch is off", () => {
  it("only judges: the corrections are counted, but nothing is opened or joined and there is no rule.suggested; turning it on groups the judged corrections", async () => {
    const world = makeWorld();
    const audit = capturingAuditDeps({ db: world.db, now: () => world.clock.ms });
    const deps = { ...world.deps, audit: audit.audit };
    setSwitch(world, "off");
    await add(world, LINT_A, { task: "t1" });
    await add(world, LINT_B, { task: "t2" });
    expect(await groupCorrections(deps, world.scope)).toEqual({ judged: 2, opened: [], joined: [], withdrawn: [], capped: false });
    expect(suggestionsOf(world)).toEqual([]);
    expect(correctionsOf(world).every((item) => item.groupedAt !== undefined)).toBe(true);
    expect(audit.recordedBy("rule.suggested")).toEqual([]);
    // Turned on later: the same corrections group (they are inside the window); they are not judged, or counted, twice.
    setSwitch(world, "on", 2);
    const result = await groupCorrections(deps, world.scope);
    expect(result.opened).toHaveLength(1);
    expect(result.judged).toBe(0);
    expect(suggestionsOf(world)).toHaveLength(1);
    expect(audit.recordedBy("rule.suggested")).toHaveLength(1);
  });

  it("keeps the month's metric counting (review I1): two members give the same correction while it is off, and \"Same correction given twice\" goes up", async () => {
    const world = makeWorld();
    setSwitch(world, "off");
    const month = metricMonth(new Date(world.clock.ms).toISOString());
    const before = await readMetric(world.deps, world.scope, month, { prCaptureOff: true });
    expect(before).toMatchObject({ memberCorrections: 0, repeats: 0 });
    const first = await add(world, LINT_A, { task: "t1", author: "dev-maya" });
    await groupCorrections(world.deps, world.scope);
    const second = await add(world, LINT_B, { task: "t2", author: "dev-omar" });
    await groupCorrections(world.deps, world.scope);
    expect(await readMetric(world.deps, world.scope, month, { prCaptureOff: true })).toMatchObject({ memberCorrections: 2, repeats: 1 });
    expect(correctionsOf(world).find((item) => item.id === second)).toMatchObject({ repeatOf: first });
    expect(suggestionsOf(world)).toEqual([]);
  });

  it("opens nothing when the switch is turned off after the run read it (review M3): the open commit is held to the switch", async () => {
    const world = makeWorld();
    const audit = capturingAuditDeps({ db: world.db, now: () => world.clock.ms });
    setSwitch(world, "on");
    await add(world, LINT_A, { task: "t1" });
    await add(world, LINT_B, { task: "t2" });
    // newId is called just before the open commit: someone turns the switch off at that moment.
    const result = await groupCorrections({ ...world.deps, audit: audit.audit }, world.scope, { newId: () => { setSwitch(world, "off", 2); return "s-late"; } });
    expect(result.opened).toEqual([]);
    expect(suggestionsOf(world)).toEqual([]);
    expect(audit.recordedBy("rule.suggested")).toEqual([]);
  });

  it("reads the setting by default (the install default when the company never chose) and checks it before anything else", async () => {
    const world = makeWorld();
    await add(world, LINT_A, { task: "t1" });
    await add(world, LINT_B, { task: "t2" });
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "off");
    const before = world.db.commandNames().length;
    expect((await groupCorrections(world.deps, world.scope)).opened).toEqual([]);
    expect(world.db.commandNames()[before]).toBe("GetCommand");
    expect(suggestionsOf(world)).toEqual([]);
    vi.stubEnv("LEARNING_SUGGESTIONS_DEFAULT", "on");
    expect((await groupCorrections(world.deps, world.scope)).opened).toHaveLength(1);
  });

  it("takes an injected suggestionsOff (the option) ahead of the stored setting", async () => {
    const world = makeWorld();
    await add(world, LINT_A, { task: "t1" });
    await add(world, LINT_B, { task: "t2" });
    setSwitch(world, "on");
    expect((await groupCorrections(world.deps, world.scope, { suggestionsOff: async () => true })).opened).toEqual([]);
    expect((await groupCorrections(world.deps, world.scope, { suggestionsOff: async () => false })).opened).toHaveLength(1);
  });

  it("withdraws nothing while off, even when PR capture was turned off since: the suggestion stays open until the switch is on", async () => {
    const world = makeWorld();
    prSetting(world, "on");
    await add(world, LINT_A, { task: "t1", source: "pr_comment" });
    await add(world, LINT_B, { task: "t2", source: "pr_comment" });
    const [id] = (await groupCorrections(world.deps, world.scope)).opened;
    expect(id).toBeDefined();
    prSetting(world, "off");
    setSwitch(world, "off");
    expect((await groupCorrections(world.deps, world.scope)).withdrawn).toEqual([]);
    expect(suggestionsOf(world)[0]).toMatchObject({ status: "open" });
    setSwitch(world, "on", 2);
    expect((await groupCorrections(world.deps, world.scope)).withdrawn).toEqual([id]);
  });
});

describe("B8: the master switch wins over the project's PR-comment toggle", () => {
  it("with the project toggle on and the switch off, PR corrections are captured and counted but no suggestion is made; the toggle is untouched when the switch goes on", async () => {
    const world = makeWorld();
    prSetting(world, "on");
    setSwitch(world, "off");
    await add(world, LINT_A, { task: "t1", source: "pr_comment" });
    await add(world, LINT_B, { task: "t2", source: "pr_comment" });
    expect(correctionsOf(world).filter((item) => item.source === "pr_comment")).toHaveLength(2);
    expect(await groupCorrections(world.deps, world.scope)).toMatchObject({ opened: [], judged: 2 });
    expect(suggestionsOf(world)).toEqual([]);
    expect(partition(world).find((item) => item.sk === "STATE")).toMatchObject({ liveCorrections: 2 });
    setSwitch(world, "on", 2);
    expect((await groupCorrections(world.deps, world.scope)).opened).toHaveLength(1);
    expect(partition(world).find((item) => item.sk === "SETTINGS")).toMatchObject({ prComments: "on", revision: 1 });
  });

  it("with the project toggle off and the switch on, PR corrections are still not grouped (the toggle decides what counts)", async () => {
    const world = makeWorld();
    prSetting(world, "off");
    setSwitch(world, "on");
    await add(world, LINT_A, { task: "t1", source: "pr_comment" });
    await add(world, LINT_B, { task: "t2", source: "pr_comment" });
    expect((await groupCorrections(world.deps, world.scope)).opened).toEqual([]);
  });
});

describe("stored items tolerate what a newer writer adds (v2 extensibility)", () => {
  const baseCorrection = (world: World, id: string) => ({
    entityType: "LEARNING_CORRECTION", id, stage: "build", source: "comment", sourceRef: { taskId: `t-${id}` }, taskId: `t-${id}`, text: LINT_A, signature: [...signatureOf(LINT_A, SALT)], author: "dev1", standing: "member",
    createdAt: new Date(world.clock.ms - 1000).toISOString(), projectCreatedAt: PROJECT_CREATED, indexExpiresAt: Math.floor(world.clock.ms / 1000) + 180 * 86400,
  });

  it("reads a stored correction with an extra field and an extra sourceRef field, and a suggestion with an extra field", () => {
    const world = makeWorld();
    const correction = { ...baseCorrection(world, "c1"), lessonId: "l1", citations: [{ commentId: "x" }], sourceRef: { taskId: "t1", futureField: "x" } };
    const parsed = LearningCorrectionSchema.safeParse(correction);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.sourceRef).toEqual({ taskId: "t1" });
    const suggestion = {
      id: "s1", stage: "build", status: "open", correctionIds: ["c1", "c2"], allFromOnePerson: false, proposedText: LINT_A, signature: ["h"], lessSafe: false, kinds: [], overlaps: [], revision: 0,
      createdAt: new Date(NOW_MS).toISOString(), projectCreatedAt: PROJECT_CREATED, scope: "project", helpful: 3, harmful: 0,
    };
    expect(LearningSuggestionSchema.safeParse(suggestion).success).toBe(true);
  });

  it("keeps the request side strict: a source ref with an unknown field is still refused in a body", async () => {
    const { LearningSourceRefSchema } = await import("../../packages/contracts/src/index.js");
    expect(LearningSourceRefSchema.safeParse({ taskId: "t1", futureField: "x" }).success).toBe(false);
  });

  it("groups past a stored correction with an unknown source and stage value (the reader skips it, it does not throw), and a suggestion of the future status stays unread", async () => {
    const world = makeWorld();
    const first = await add(world, LINT_A, { task: "t1" });
    const second = await add(world, LINT_B, { task: "t2" });
    seedItem(world.db, world.scope.orgId, world.scope.project, `CORRECTION#${new Date(world.clock.ms - 500).toISOString()}#cX`, { ...baseCorrection(world, "cX"), source: "lesson_import", extraField: 1 });
    seedItem(world.db, world.scope.orgId, world.scope.project, "SUGGESTION#future", { id: "future", stage: "build", status: "scheduled", extraField: 1 });
    // The correction with an extra field is read like any other.
    seedItem(world.db, world.scope.orgId, world.scope.project, `CORRECTION#${new Date(world.clock.ms - 400).toISOString()}#cY`, { ...baseCorrection(world, "cY"), text: "Unrelated words about naming database tables.", signature: [...signatureOf("Unrelated words about naming database tables.", SALT)], extraField: 1, sourceRef: { taskId: "tY", futureField: 1 } });
    setSwitch(world, "on");
    const result = await groupCorrections(world.deps, world.scope);
    expect(result.opened).toHaveLength(1);
    const opened = suggestionsOf(world).find((item) => item.status === "open")!;
    expect([...(opened.correctionIds as string[])].sort()).toEqual([first, second].sort());
    expect(partition(world).find((item) => item.id === "cX")?.groupedAt).toBeUndefined();
    void DAY_MS; void openSuggestion;
  });
});
