// Lane cr-settings: the evidence writers. The replay run and the verdict are written ONLY through the admin pool (Rovara staff in Public, the install's administrator in Enterprise), never by a company's admin, member or
// project; the broker counts the shadow window itself from the company's track record and stores evidence, never a pass; `holds` is recomputed on every read; an admin can only WITHDRAW a verdict.
import { afterEach, describe, expect, it } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
import { secondReviewModelKey } from "@rovara-code/contracts";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { replayRun, seedPassingShadow, seedTrackRow, verdictFor } from "../support/second-review-evidence.js";
import { readSecondReviewSettings, secondReviewReplayKey, secondReviewVerdictKey } from "../../packages/broker/src/org/second-review-settings.js";
import { INSTALL_OPERATOR_ROUTES, requireStaffRouteAllowed } from "../../packages/broker/src/aws/broker/staff-routes.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.SECOND_REVIEW_ENABLED; });
const PATH = "/v1/app/org/second-review";
const QUERY = `${PATH}?builder=openai:gpt-5.5`;
const REPLAY = "/v1/admin/org/second-review/replay";
const VERDICT = "/v1/admin/org/second-review/verdict";
const STAFF = { subject: "staff-subject", admin: true };
const NOT_STAFF = { subject: "someone", admin: false };
const on = () => { process.env.SECOND_REVIEW_ENABLED = "1"; };
async function bench(options: { cloud?: boolean } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit, ...options });
  await t.person(MAYA, "admin");
  on();
  const model = ((await t.web(OMAR, "GET", QUERY)).body as { models: Array<{ model: { provider: string; modelId: string } }> }).models[0]!.model;
  return { t, audit, model };
}
const staff = (t: Bench, path: string, body: unknown, user: { subject: string; admin: boolean } = STAFF) => call(t.handler, { method: "POST", path, user, body });
const evidenceEvents = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => /second_review_(replay|verdict)/u.test(event.action));
const settingsOf = async (t: Bench) => (await t.web(OMAR, "GET", QUERY)).body as { evidence: { holds: boolean; verdict: { withdrawn: boolean; shadowFindings: number; shadowAgreed: number; shadowDays: number } | null; replay: { passed: boolean } | null } | null; trackRecord: { reviews: number } | null };
const window = { startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-10-20T00:00:00.000Z" };

describe("who writes the evidence", () => {
  it("is not found while cr is off; refused for a caller without the admin claim; and no company route can write it", async () => {
    const { t, model } = await bench();
    delete process.env.SECOND_REVIEW_ENABLED;
    // Exactly what any unknown admin path answers.
    const unknown = await staff(t, "/v1/admin/org/second-review/nothing", { orgId: TEST_ORG });
    const shape = (reply: { status: number; body: Record<string, unknown> }) => ({ status: reply.status, error: (reply.body.error as { code?: string } | undefined)?.code });
    expect(shape(await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) }))).toEqual(shape(unknown));
    expect(shape(await staff(t, VERDICT, { orgId: TEST_ORG }))).toEqual(shape(unknown));
    expect(t.db.get(secondReviewReplayKey(TEST_ORG, "run-1"))).toBeUndefined();
    on();
    expect((await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) }, NOT_STAFF)).status).toBe(403);
    expect(t.db.get(secondReviewReplayKey(TEST_ORG, "run-1"))).toBeUndefined();
    // A company's owner, in a browser or with a token, has no path or action that writes evidence.
    expect((await t.web(OMAR, "POST", PATH.replace("/v1/app", "/v1/app") + "/replay", { run: replayRun(model) })).status).toBeGreaterThanOrEqual(404);
    expect((await t.web(OMAR, "POST", PATH, { action: "verdict", model, replayRunId: "run-1" })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "replay", run: replayRun(model) })).status).toBe(400);
    expect(t.db.get(secondReviewReplayKey(TEST_ORG, "run-1"))).toBeUndefined();
  });

  it("Enterprise's own administrator is served: both paths are on the closed list of operator routes, and no other path under them is", () => {
    const enterprise = editionPolicy("enterprise");
    for (const path of [REPLAY, VERDICT]) expect(() => requireStaffRouteAllowed(enterprise, path), path).not.toThrow();
    for (const path of ["/v1/admin/org/second-review", "/v1/admin/org/second-review/replay/x", "/v1/admin/org/second-review/withdraw", "/v1/admin/org/second-review/verdict/"]) expect(() => requireStaffRouteAllowed(enterprise, path), path).toThrow();
    for (const route of INSTALL_OPERATOR_ROUTES) { expect(route.source.startsWith("^")).toBe(true); expect(route.source.endsWith("$")).toBe(true); }
  });
});

describe("the replay run", () => {
  it("is stored once, audited, and carries no pass: the summary returned is scored when asked", async () => {
    const { t, audit, model } = await bench();
    const stored = await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) });
    expect(stored).toMatchObject({ status: 201, body: { status: "stored", summary: { passed: true, tasks: 50 } } });
    const item = t.db.get(secondReviewReplayKey(TEST_ORG, "run-1")) as Record<string, unknown>;
    expect(JSON.stringify(item)).not.toMatch(/"passed"|"holds"/u);
    expect(evidenceEvents(audit)[0]).toMatchObject({ action: "company.second_review_replay_recorded", actor: { kind: "operator", id: expect.not.stringContaining("staff-subject") as string }, facts: { runId: "run-1", cases: 50, passed: true } });
    // A run is never changed under a verdict that names it.
    expect((await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model, { cases: [] }) })).status).toBe(409);
    expect((t.db.get(secondReviewReplayKey(TEST_ORG, "run-1")) as { run: { cases: unknown[] } }).run.cases).toHaveLength(50);
  });

  it("a run that does not parse, an unknown field, and an org that does not exist are refused and store nothing", async () => {
    const { t, model } = await bench();
    expect((await staff(t, REPLAY, { orgId: TEST_ORG, run: { runId: "x" } })).status).toBe(400);
    expect((await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model), passed: true })).status).toBe(400);
    expect((await staff(t, REPLAY, { run: replayRun(model) })).status).toBe(400);
    expect((await staff(t, REPLAY, { orgId: "org_zzzzzzzzzzzzzzzzzzzz", run: replayRun(model) })).status).toBe(404);
    expect(t.db.get(secondReviewReplayKey(TEST_ORG, "run-1"))).toBeUndefined();
  });
});

describe("the verdict", () => {
  it("stores evidence only: the broker counts the shadow window from the company's track record, and a writer cannot type the counts or a pass", async () => {
    const { t, audit, model } = await bench();
    await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) });
    seedPassingShadow(t.db, model);
    expect((await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window, shadow: { findings: 99, agreed: 99 } })).status).toBe(400);
    expect((await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window, holds: true })).status).toBe(400);
    const stored = await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window });
    expect(stored, JSON.stringify(stored.body)).toMatchObject({ status: 201, body: { holds: true, replay: { passed: true }, shadow: { days: 16, findings: 10, agreed: 5, passed: true } } });
    const row = t.db.get(secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(model))) as { verdict: Record<string, unknown> };
    // The window stored is the span of the rows counted (first to last), not the typed one.
    expect(row.verdict).toMatchObject({ model: secondReviewModelKey(model), replayRunId: "run-1", shadow: { startedAt: "2026-10-02T12:00:00.000Z", endedAt: "2026-10-18T12:00:00.000Z", findings: 10, agreed: 5 }, createdBy: expect.stringMatching(/./u) as string });
    expect(JSON.stringify(row)).not.toMatch(/"passed"|"holds"/u);
    expect(evidenceEvents(audit).at(-1)).toMatchObject({ action: "company.second_review_verdict_recorded", facts: { runId: "run-1", days: 16, findings: 10, agreed: 5 } });
    expect(await settingsOf(t)).toMatchObject({ evidence: { holds: true, verdict: { withdrawn: false, shadowFindings: 10, shadowAgreed: 5 } } });
  });

  it("whether it holds is recomputed on every read: change the stored run or the track and the answer changes", async () => {
    const { t, model } = await bench();
    await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) });
    seedPassingShadow(t.db, model);
    await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window });
    expect((await settingsOf(t)).evidence?.holds).toBe(true);
    t.db.set({ ...secondReviewReplayKey(TEST_ORG, "run-1"), entityType: "SECOND_REVIEW_REPLAY", run: replayRun(model, { cases: replayRun(model).cases.map((entry) => ({ ...entry, candidateCaught: false })) }) });
    expect(await settingsOf(t)).toMatchObject({ evidence: { holds: false, replay: { passed: false } } });
  });

  it("is refused for a run that is missing or another model's, a window that starts before the run or ends in the future, and a window with no second opinions", async () => {
    const { t, model } = await bench();
    seedPassingShadow(t.db, model);
    expect((await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window })).status).toBe(404);
    await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) });
    // The other model has a full shadow window of its own, so only the run being another model's refuses it.
    const other = { provider: "openrouter", modelId: "x/other" };
    seedPassingShadow(t.db, other);
    const mismatch = await staff(t, VERDICT, { orgId: TEST_ORG, model: other, replayRunId: "run-1", ...window });
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(mismatch.body)).toContain("another model");
    expect((await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-10-20T00:00:00.000Z" })).status).toBe(400);
    expect((await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2099-01-01T00:00:00.000Z" })).status).toBe(400);
    expect((await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", startedAt: "2026-10-19T00:00:00.000Z", endedAt: "2026-10-20T00:00:00.000Z" })).status).toBe(400);
    expect(t.db.get(secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(model)))).toBeUndefined();
  });

  it("the shadow days are the span of the rows counted: rows from one day under a typed 14-day (or longer) window fail the bar", async () => {
    const { t, model } = await bench();
    await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) });
    // Plenty of findings and agreement, all on one day.
    for (let n = 0; n < 6; n += 1) seedTrackRow(t.db, model, { at: `2026-10-10T${String(8 + n).padStart(2, "0")}:00:00.000Z`, task: `d${String(n)}`, fixed: 2, wrong: 1 });
    const stored = await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window });
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({ holds: false, shadow: { days: 0, findings: 18, agreed: 12, passed: false } });
    const row = t.db.get(secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(model))) as { verdict: { shadow: { startedAt: string; endedAt: string } } };
    expect(row.verdict.shadow).toMatchObject({ startedAt: "2026-10-10T08:00:00.000Z", endedAt: "2026-10-10T13:00:00.000Z" });
    expect((await settingsOf(t)).evidence).toMatchObject({ holds: false, verdict: { shadowDays: 0, shadowPassed: false } });
  });

  it("needs at least 10 counted reviews: nine over a long window with plenty of agreement do not hold, ten do", async () => {
    const { t, model } = await bench();
    await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) });
    for (let n = 0; n < 9; n += 1) seedTrackRow(t.db, model, { at: `2026-10-${String(3 + 2 * n).padStart(2, "0")}T12:00:00.000Z`, task: `r${String(n)}`, fixed: 2, wrong: 1 });
    const nine = await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window });
    expect(nine.body).toMatchObject({ holds: false, shadow: { reviews: 9, days: 16, findings: 27, agreed: 18, passed: false } });
    expect((await settingsOf(t)).evidence).toMatchObject({ holds: false, verdict: { shadowPassed: false } });
    seedTrackRow(t.db, model, { at: "2026-10-19T12:00:00.000Z", task: "r9", fixed: 1 });
    const ten = await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window });
    expect(ten.body).toMatchObject({ holds: true, shadow: { reviews: 10, passed: true } });
    // A verdict written before the count existed cannot pass the bar.
    t.db.set({ ...secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(model)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model, { shadow: { startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-10-20T00:00:00.000Z", findings: 10, agreed: 5 } }) });
    expect((await settingsOf(t)).evidence?.holds).toBe(false);
  });

  it("a short or disagreeing window is stored as it is and does NOT hold (the bar decides, not the writer)", async () => {
    const { t, model } = await bench();
    await staff(t, REPLAY, { orgId: TEST_ORG, run: replayRun(model) });
    seedTrackRow(t.db, model, { at: "2026-10-02T12:00:00.000Z", task: "a", wrong: 5 });
    seedTrackRow(t.db, model, { at: "2026-10-20T12:00:00.000Z", task: "b", fixed: 1 });
    const stored = await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window, endedAt: "2026-10-21T00:00:00.000Z" });
    expect(stored).toMatchObject({ status: 201, body: { holds: false, shadow: { findings: 6, agreed: 1, passed: false } } });
    expect((await settingsOf(t)).evidence?.holds).toBe(false);
  });
});

describe("reading the verdicts of a company", () => {
  it("pages through all of them: a verdict past the first page still counts", async () => {
    const { t, model } = await bench();
    for (let n = 0; n < 60; n += 1) {
      const other = { provider: "openrouter", modelId: `a/m${String(n).padStart(3, "0")}` };
      t.db.set({ ...secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(other)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(other) });
    }
    // Sorts last: only a read that goes past the first page of 50 sees it.
    const last = { provider: "openrouter", modelId: "z/last" };
    t.db.set({ ...secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(last)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(last) });
    const settings = await readSecondReviewSettings({ documentClient: t.db, tableName: "state" }, TEST_ORG, "");
    expect(settings.verdicts).toHaveLength(61);
    expect(settings.verdicts.map((entry) => entry.model)).toContain(secondReviewModelKey(last));
    void model;
  });
});

describe("a company admin may only withdraw", () => {
  async function held() {
    const made = await bench();
    await staff(made.t, REPLAY, { orgId: TEST_ORG, run: replayRun(made.model) });
    seedPassingShadow(made.t.db, made.model);
    await staff(made.t, VERDICT, { orgId: TEST_ORG, model: made.model, replayRunId: "run-1", ...window });
    return made;
  }

  it("withdrawing stops it holding at once, is audited, and `on` is then refused", async () => {
    const { t, audit, model } = await held();
    await t.web(OMAR, "POST", PATH, { action: "choose", primary: model });
    expect(await t.web(OMAR, "POST", PATH, { action: "withdraw", model })).toMatchObject({ status: 200, body: { status: "applied", evidence: { holds: false, verdict: { withdrawn: true } } } });
    expect(evidenceEvents(audit).at(-1)).toMatchObject({ action: "company.second_review_verdict_withdrawn", actor: { id: OMAR.developerId } });
    expect((await t.web(OMAR, "POST", PATH, { action: "mode", scope: "company", mode: "on" })).status).toBe(403);
    // Twice is refused, and there is no verdict to withdraw for another model.
    expect((await t.web(OMAR, "POST", PATH, { action: "withdraw", model })).status).toBe(409);
    expect((await t.web(OMAR, "POST", PATH, { action: "withdraw", model: { provider: "openrouter", modelId: "x/none" } })).status).toBe(404);
  });

  it("is refused from a token and from a member, and withdraws nothing", async () => {
    const { t, model } = await held();
    await t.person(MAYA, "member");
    expect((await t.dev(OMAR, "POST", PATH, { action: "withdraw", model })).status).toBe(403);
    expect((await t.web(MAYA, "POST", PATH, { action: "withdraw", model })).status).toBe(403);
    expect((await settingsOf(t)).evidence?.holds).toBe(true);
  });

  it("an admin cannot bring a withdrawn verdict back; a new verdict comes from staff, who can", async () => {
    const { t, model } = await held();
    await t.web(OMAR, "POST", PATH, { action: "withdraw", model });
    expect((await t.web(OMAR, "POST", PATH, { action: "verdict", model, replayRunId: "run-1" })).status).toBe(400);
    expect((await settingsOf(t)).evidence?.holds).toBe(false);
    expect((await staff(t, VERDICT, { orgId: TEST_ORG, model, replayRunId: "run-1", ...window })).status).toBe(201);
    expect((await settingsOf(t)).evidence?.holds).toBe(true);
  });
});

describe("on a single-company install (Enterprise)", () => {
  it("the install's administrator writes for the install's company without naming it; naming another company is refused", async () => {
    const { t, model } = await bench({ cloud: false });
    expect((await staff(t, REPLAY, { run: replayRun(model) })).status).toBe(201);
    expect((await staff(t, REPLAY, { orgId: "org_zzzzzzzzzzzzzzzzzzzz", run: replayRun(model, { runId: "run-2" }) })).status).toBe(403);
    expect(t.db.get(secondReviewReplayKey(TEST_ORG, "run-1"))).toBeDefined();
    expect(t.db.get(secondReviewReplayKey("org_zzzzzzzzzzzzzzzzzzzz", "run-2"))).toBeUndefined();
  });
});

void NAME;
