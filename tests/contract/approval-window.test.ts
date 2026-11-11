// Approval place (U4, decision 83, A-08): the company's recent sign-in window for approvals outside Rovara. Any member reads it; an owner or admin changes it from a live browser session. Shortening applies at once; lengthening
// needs a fresh sign-in and then a DIFFERENT admin (or the shared sole-owner exception). Each rule has a test that it does not widen anything: a token, a member, the proposer and a stale sign-in change nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgMetaKey } from "@agentx/cloud-contracts";
import { RECENT_SIGN_IN_DEFAULT_SECONDS, RECENT_SIGN_IN_MAX_SECONDS, RECENT_SIGN_IN_MIN_SECONDS } from "@agentx/cloud-contracts";
import { ApprovalWindowAnswerReaderSchema as ApprovalWindowAnswerSchema, ApprovalWindowStateReaderSchema as ApprovalWindowStateSchema } from "@agentx/cloud-contracts";
import { APPROVAL_WINDOW_SETTING_SK, readApprovalWindow, setApprovalWindow, type ApprovalWindowDeps } from "../../packages/broker/src/approval-place/window-setting.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { errorOf, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

// The window exists while the decision cards switch is on (the place rules sit under it).
beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; });
const PATH = "/v1/app/org/approval-window";
const ORG = TEST_ORG;
const HOURS = 3600;

async function bench(options: { maya?: "admin" | "member" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  return { t, audit };
}
const events = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => event.action.startsWith("company.approval_window_"));
const get = (t: Bench, who = OMAR) => t.web(who, "GET", PATH);
const set = (t: Bench, seconds: number, expectedRevision: number, who = OMAR) => t.web(who, "POST", PATH, { action: "set", expectedRevision, seconds });

describe("the route's shape decisions (UI lane)", () => {
  it("is not found while the decision cards switch is off (any value but exactly 1): GET and POST, as any unknown path, so the app's nav can probe it", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = value;
      const read = await get(t);
      expect(read.status, String(value)).toBe(404);
      expect(errorOf(read).code).toBe("NOT_FOUND");
      expect((await set(t, 4 * HOURS, 0)).status, String(value)).toBe(404);
      // A token's write is not found either (not "use a browser"): nothing about the route is told while it is off.
      expect((await t.dev(OMAR, "POST", PATH, { action: "set", expectedRevision: 0, seconds: 4 * HOURS })).status, String(value)).toBe(404);
    }
    process.env.DECISION_CARDS_ENABLED = "1";
    expect((await get(t)).status).toBe(200);
    expect(await readApprovalWindow({ documentClient: t.db, tableName: "state" }, ORG), "nothing was written while it was off").toMatchObject({ revision: 0 });
  });

  it("a lengthening or a confirmation with a stale sign-in is HTTP 403 with the code REAUTH_REQUIRED, never 401 (the web client redirects on any 401)", async () => {
    const { t } = await bench({ maya: "admin" });
    expect((await set(t, 4 * HOURS, 0)).status).toBe(200);
    t.ageSignIn(OMAR, 11);
    const stale = await set(t, 48 * HOURS, 1);
    expect(stale.status).toBe(403);
    expect(errorOf(stale).code).toBe("REAUTH_REQUIRED");
    t.ageSignIn(OMAR, 0);
    const changeId = ((await set(t, 48 * HOURS, 1)).body as { changeId: string }).changeId;
    t.ageSignIn(MAYA, 11);
    const approve = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(approve.status).toBe(403);
    expect(errorOf(approve).code).toBe("REAUTH_REQUIRED");
    // A shortening needs no recent sign-in, so it is never this refusal.
    expect((await set(t, 2 * HOURS, 1, OMAR)).status).not.toBe(401);
  });

  it("the state names who last changed the window (their display name) and when (ISO); neither while the default stands; an erased person reads as a former member", async () => {
    const { t } = await bench({ maya: "admin" });
    const fresh = (await get(t)).body;
    expect(fresh).not.toHaveProperty("changedBy");
    expect(fresh).not.toHaveProperty("changedAt");
    const before = Date.now();
    expect((await set(t, 4 * HOURS, 0, MAYA)).status).toBe(200);
    const body = (await get(t)).body as { changedBy: string; changedAt: string };
    expect(body.changedBy).toBe(MAYA.name);
    expect(new Date(body.changedAt).toISOString()).toBe(body.changedAt);
    expect(Date.parse(body.changedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(JSON.stringify(body)).not.toContain(MAYA.developerId);
    expect(ApprovalWindowStateSchema.safeParse(body).success).toBe(true);
    // A person who cannot be read is a fixed word, never an id and never a failure of the state.
    t.db.set({ pk: `DEVELOPER#${MAYA.developerId}`, sk: "META", developerId: MAYA.developerId, provider: "oidc", displayName: "x", firstSignInAt: "x", lastSignInAt: "x", revoked: false, nameErasedAt: new Date().toISOString() });
    const erased = (await get(t)).body as { changedBy: string };
    expect(erased.changedBy).not.toContain(MAYA.developerId);
    expect((await get(t)).status).toBe(200);
  });

  it("the plain, short sentences a stale or doubled request answers are the whole message (the app shows them as they are and re-reads)", async () => {
    const { t } = await bench({ maya: "admin" });
    expect((await set(t, 4 * HOURS, 0)).status).toBe(200);
    expect(errorOf(await set(t, 2 * HOURS, 0)).message).toMatch(/This changed while you were looking\. Reload and try again\.$/u);
    expect(errorOf(await set(t, 2 * HOURS, 0)).code).toBe("POLICY_STALE");
    await set(t, 48 * HOURS, 1);
    const doubled = errorOf(await set(t, 72 * HOURS, 1));
    expect(doubled.code).toBe("CHANGE_STALE");
    expect(doubled.message).toMatch(/A request is already waiting for a different admin\. Withdraw it first\.$/u);
    for (const reason of [doubled.message, "This changed while you were looking. Reload and try again."]) expect(reason.length).toBeLessThan(90);
  });
});

describe("reading the window", () => {
  it("a company that chose nothing has 24 hours, revision 0, and every member can read it (an owner is told they may change it, a member is not)", async () => {
    const { t } = await bench({ maya: "member" });
    const owner = await get(t);
    expect(owner).toMatchObject({ status: 200, body: { revision: 0, seconds: 86_400, isDefault: true, defaultSeconds: 86_400, minSeconds: 3_600, maxSeconds: 604_800, canChange: true, unreadable: false } });
    expect(ApprovalWindowStateSchema.safeParse(owner.body).success).toBe(true);
    const member = await get(t, MAYA);
    expect(member).toMatchObject({ status: 200, body: { seconds: 86_400, canChange: false } });
    expect(member.body).not.toHaveProperty("pending");
    expect(RECENT_SIGN_IN_DEFAULT_SECONDS).toBe(86_400);
  });

  it("another company's setting is never read: a second company starts from the default whatever the first one set", async () => {
    const { t } = await bench();
    expect((await set(t, 4 * HOURS, 0)).status).toBe(200);
    expect(await readApprovalWindow({ documentClient: t.db, tableName: "state" }, "org_zzzzzzzzzzzzzzzzzzzz")).toMatchObject({ seconds: 86_400, revision: 0, isDefault: true });
    expect(await readApprovalWindow({ documentClient: t.db, tableName: "state" }, ORG)).toMatchObject({ seconds: 4 * HOURS, revision: 1, isDefault: false });
  });

  it("a stored item that does not read is enforced as the 1-hour minimum (never the default, which may be looser) and nothing can be changed over it", async () => {
    const { t } = await bench();
    for (const bad of [{ seconds: "soon" }, { seconds: 10 }, { seconds: 10 ** 9 }, { seconds: 86_400.5 }, { seconds: undefined }]) {
      t.db.set({ pk: orgMetaKey(ORG).pk, sk: APPROVAL_WINDOW_SETTING_SK, entityType: "APPROVAL_WINDOW", orgId: ORG, revision: 3, ...bad });
      expect(await readApprovalWindow({ documentClient: t.db, tableName: "state" }, ORG), JSON.stringify(bad)).toMatchObject({ seconds: RECENT_SIGN_IN_MIN_SECONDS, unreadable: true });
      expect(await get(t)).toMatchObject({ status: 200, body: { unreadable: true, seconds: 3_600 } });
      expect((await set(t, 2 * HOURS, 3)).status).toBe(400);
    }
    // A row of another kind, or with no usable revision, is unreadable too.
    t.db.set({ pk: orgMetaKey(ORG).pk, sk: APPROVAL_WINDOW_SETTING_SK, entityType: "SOMETHING_ELSE", seconds: 7_200, revision: 1 });
    expect((await readApprovalWindow({ documentClient: t.db, tableName: "state" }, ORG)).unreadable).toBe(true);
    t.db.set({ pk: orgMetaKey(ORG).pk, sk: APPROVAL_WINDOW_SETTING_SK, entityType: "APPROVAL_WINDOW", seconds: 7_200 });
    expect((await readApprovalWindow({ documentClient: t.db, tableName: "state" }, ORG)).unreadable).toBe(true);
  });
});

describe("who may change it", () => {
  it("only an owner or admin, from a live browser session: a token, a member and a project-less stranger are refused, and nothing is written or audited", async () => {
    const { t, audit } = await bench({ maya: "member" });
    const body = { action: "set", expectedRevision: 0, seconds: 4 * HOURS };
    const token = await t.dev(OMAR, "POST", PATH, body);
    expect(token.status).toBe(403);
    expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    const member = await t.web(MAYA, "POST", PATH, body);
    expect(member.status).toBe(403);
    expect(JSON.stringify(member.body)).toContain("Only a company owner or admin");
    for (const other of [{ action: "approve", changeId: "abc" }, { action: "cancel", changeId: "abc" }]) expect((await t.web(MAYA, "POST", PATH, other)).status).toBe(403);
    expect(await get(t)).toMatchObject({ body: { revision: 0, seconds: 86_400 } });
    expect(events(audit)).toEqual([]);
  });

  it("refuses a body that is not one of the actions or a value outside 1 hour to 7 days, with the field name only, and writes nothing", async () => {
    const { t } = await bench();
    for (const seconds of [0, 59, RECENT_SIGN_IN_MIN_SECONDS - 1, RECENT_SIGN_IN_MAX_SECONDS + 1, 86_400.5, -3600, "86400"]) {
      const reply = await t.web(OMAR, "POST", PATH, { action: "set", expectedRevision: 0, seconds });
      expect(reply.status, String(seconds)).toBe(400);
      expect(JSON.stringify(reply.body)).toContain("seconds");
    }
    for (const body of [{ action: "set", expectedRevision: 0 }, { action: "set", seconds: 3600 }, { action: "set", expectedRevision: 0, seconds: 7200, extra: 1 }, { action: "grow", expectedRevision: 0, seconds: 7200 }, {}]) {
      expect((await t.web(OMAR, "POST", PATH, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await get(t)).toMatchObject({ body: { revision: 0, seconds: 86_400 } });
  });
});

describe("shortening applies at once", () => {
  it("on the admin's own authority, audited with fixed words and whole seconds, on the revision read; a stale revision is POLICY_STALE; the same value writes and audits nothing", async () => {
    const { t, audit } = await bench();
    const shortened = await set(t, 4 * HOURS, 0);
    expect(shortened, JSON.stringify(shortened.body)).toMatchObject({ status: 200, body: { status: "applied", revision: 1, seconds: 14_400, isDefault: false } });
    expect(ApprovalWindowAnswerSchema.safeParse(shortened.body).success).toBe(true);
    expect(events(audit).map((event) => [event.action, event.facts])).toEqual([["company.approval_window_changed", { from: 86_400, to: 14_400, mode: "direct", revision: 1 }]]);
    expect(events(audit)[0]).toMatchObject({ actor: { kind: "member", id: OMAR.developerId }, target: { kind: "org" } });
    const stale = await set(t, 2 * HOURS, 0);
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain("POLICY_STALE");
    expect(await get(t)).toMatchObject({ body: { revision: 1, seconds: 14_400 } });
    expect(await set(t, 4 * HOURS, 1)).toMatchObject({ status: 200, body: { revision: 1 } });
    expect(events(audit)).toHaveLength(1);
  });

  it("needs no recent sign-in: a company under attack can tighten at any time", async () => {
    const { t } = await bench();
    t.ageSignIn(OMAR, 600);
    expect((await set(t, 3_600, 0)).status).toBe(200);
  });

  it("a member who was demoted since reading is refused (the live authority is fenced), and a removed admin changes nothing", async () => {
    const { t } = await bench({ maya: "admin" });
    await t.person(MAYA, "member");
    expect((await set(t, 4 * HOURS, 0, MAYA)).status).toBe(403);
    expect(await get(t)).toMatchObject({ body: { revision: 0 } });
  });
});

describe("lengthening is a loosening: a fresh sign-in, then a different admin", () => {
  async function shortened(t: Bench) { expect((await set(t, 4 * HOURS, 0)).status).toBe(200); }

  it("needs a sign-in within the last 10 minutes before it even asks: a stale one is REAUTH_REQUIRED and changes nothing", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await shortened(t);
    t.ageSignIn(OMAR, 11);
    const stale = await set(t, 48 * HOURS, 1);
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("REAUTH_REQUIRED");
    expect(await get(t)).toMatchObject({ body: { revision: 1, seconds: 14_400 } });
    expect(events(audit)).toHaveLength(1);
  });

  it("with another admin it opens a request that changes nothing; the one who asked cannot confirm it; a different admin confirms it within 10 minutes of signing in; all of it audited", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await shortened(t);
    const asked = await set(t, 48 * HOURS, 1);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(ApprovalWindowAnswerSchema.safeParse(asked.body).success).toBe(true);
    const changeId = (asked.body as { changeId: string }).changeId;
    // Nothing changed yet; the window still enforced is the short one.
    expect(await get(t)).toMatchObject({ body: { revision: 1, seconds: 14_400, pending: { changeId, seconds: 172_800, proposedByYou: true } } });
    expect((await get(t, MAYA)).body).toMatchObject({ seconds: 14_400, pending: { proposedByYou: false } });
    expect(await readApprovalWindow({ documentClient: t.db, tableName: "state" }, ORG)).toMatchObject({ seconds: 14_400 });
    const self = await t.web(OMAR, "POST", PATH, { action: "approve", changeId });
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toContain("A different admin has to approve");
    // A second request while one waits is refused.
    expect((await set(t, 72 * HOURS, 1)).status).toBe(409);
    t.ageSignIn(MAYA, 11);
    const old = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(old.status).toBe(403);
    expect(JSON.stringify(old.body)).toContain("REAUTH_REQUIRED");
    expect(await get(t)).toMatchObject({ body: { seconds: 14_400 } });
    t.ageSignIn(MAYA, 5);
    const approved = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { status: "applied", seconds: 172_800, revision: 2 } });
    expect(await get(t)).toMatchObject({ body: { seconds: 172_800, revision: 2 } });
    expect((await get(t)).body).not.toHaveProperty("pending");
    expect(events(audit).map((event) => [event.action, (event.facts as Record<string, unknown>).from, (event.facts as Record<string, unknown>).to, (event.facts as Record<string, unknown>).mode])).toEqual([
      ["company.approval_window_changed", 86_400, 14_400, "direct"],
      ["company.approval_window_proposed", 14_400, 172_800, undefined],
      ["company.approval_window_changed", 14_400, 172_800, "second_person"],
    ]);
    expect(events(audit).at(-1)).toMatchObject({ actor: { id: MAYA.developerId } });
    // Confirming it again changes nothing.
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(409);
  });

  it("the maximum is 7 days: a longer window is refused whoever asks", async () => {
    const { t } = await bench({ maya: "admin" });
    const asked = await set(t, RECENT_SIGN_IN_MAX_SECONDS, 0);
    expect(asked.status).toBe(202);
    expect((await set(t, RECENT_SIGN_IN_MAX_SECONDS + 1, 0)).status).toBe(400);
  });

  it("a member cannot confirm; an admin who lost their role cannot either; a request whose window moved since is stale", async () => {
    const { t } = await bench({ maya: "admin" });
    await shortened(t);
    const changeId = ((await set(t, 48 * HOURS, 1)).body as { changeId: string }).changeId;
    await t.person(MAYA, "member");
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(403);
    await t.person(MAYA, "admin");
    // The proposer tightens again meanwhile: the request was made against a window that no longer stands.
    expect((await set(t, 2 * HOURS, 1)).status).toBe(200);
    const late = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect([404, 409]).toContain(late.status);
    expect(await get(t)).toMatchObject({ body: { seconds: 7_200 } });
  });

  it("a request made against a window that has since changed by another route is stale, not applied", async () => {
    const { t } = await bench({ maya: "admin" });
    await shortened(t);
    const changeId = ((await set(t, 48 * HOURS, 1)).body as { changeId: string }).changeId;
    // The window moves under the waiting request without settling it (a repair, a restore): 4 hours is now 2 hours.
    t.db.set({ pk: orgMetaKey(ORG).pk, sk: APPROVAL_WINDOW_SETTING_SK, entityType: "APPROVAL_WINDOW", orgId: ORG, revision: 2, seconds: 2 * HOURS });
    const late = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(late.status).toBe(409);
    expect(await get(t)).toMatchObject({ body: { seconds: 7_200, revision: 2 } });
  });

  it("a request expires after 7 days", async () => {
    const { t } = await bench({ maya: "admin" });
    await shortened(t);
    const changeId = ((await set(t, 48 * HOURS, 1)).body as { changeId: string }).changeId;
    const key = { pk: orgMetaKey(ORG).pk, sk: "APPROVALWINDOW#CHANGE" };
    const row = t.db.get(key) as Record<string, unknown>;
    expect(row.expiresAt as number - (row.at as number)).toBe(7 * 86_400_000);
    t.db.set({ ...row, expiresAt: Date.now() - 1 });
    const expired = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(expired.status).toBe(409);
    expect(JSON.stringify(expired.body)).toContain("expired");
    expect(await get(t)).toMatchObject({ body: { seconds: 14_400 } });
    expect((await get(t)).body).not.toHaveProperty("pending");
  });

  it("the proposer or any admin withdraws the request, audited; a member and an unknown id cannot", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await shortened(t);
    const changeId = ((await set(t, 48 * HOURS, 1)).body as { changeId: string }).changeId;
    expect((await t.web(OMAR, "POST", PATH, { action: "cancel", changeId: "nope" })).status).toBe(404);
    const withdrawn = await t.web(MAYA, "POST", PATH, { action: "cancel", changeId });
    expect(withdrawn).toMatchObject({ status: 200, body: { status: "applied", seconds: 14_400 } });
    expect((await get(t)).body).not.toHaveProperty("pending");
    expect(events(audit).at(-1)).toMatchObject({ actor: { id: MAYA.developerId }, facts: { mode: "cancelled" } });
    expect((await t.web(OMAR, "POST", PATH, { action: "approve", changeId })).status).toBe(409);
    // It can be asked again after it was withdrawn.
    expect((await set(t, 48 * HOURS, 1)).status).toBe(202);
  });

  it("the only owner of a company of one has nobody to ask: lengthening alone is the shared sole-owner exception, audited", async () => {
    const { t, audit } = await bench();
    await shortened(t);
    const reply = await set(t, 48 * HOURS, 1);
    expect(reply, JSON.stringify(reply.body)).toMatchObject({ status: 200, body: { status: "applied", seconds: 172_800, revision: 2 } });
    expect(events(audit).at(-1)).toMatchObject({ actor: { id: OMAR.developerId }, facts: { from: 14_400, to: 172_800, mode: "sole_owner_exception", revision: 2 } });
  });

  it("an admin who is not the only owner and has no one else eligible cannot lengthen alone", async () => {
    const { t } = await bench({ maya: "admin" });
    await shortened(t);
    // Maya asks as the lone eligible admin once Omar loses his place: nobody else could confirm, and she is not the only owner.
    await t.person(OMAR, "member");
    const alone = await set(t, 48 * HOURS, 1, MAYA);
    expect([403]).toContain(alone.status);
    expect(await get(t, MAYA)).toMatchObject({ body: { seconds: 14_400 } });
  });
});

describe("the route logs refusals with fixed words only", () => {
  it("one line with the action and the reason, and no person id", async () => {
    const { t } = await bench({ maya: "admin" });
    await t.web(OMAR, "POST", PATH, { action: "set", expectedRevision: 0, seconds: 4 * HOURS });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
    try {
      t.ageSignIn(OMAR, 30);
      expect((await set(t, 48 * HOURS, 1)).status).toBe(403);
      const refused = logs.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } }).filter((entry) => entry?.event === "developer.approval_window_refused");
      expect(refused).toEqual([{ component: "broker", event: "developer.approval_window_refused", orgId: ORG, action: "set", reason: "reauth_required" }]);
      expect(logs.join("\n")).not.toContain(OMAR.developerId);
    } finally { vi.restoreAllMocks(); }
  });
});

describe("the store, called directly", () => {
  it("refuses without audit for a lengthening and without actor authority for anything", async () => {
    const { t } = await bench();
    const base = { documentClient: t.db, tableName: "state", now: () => Date.now() } as unknown as ApprovalWindowDeps;
    expect(await setApprovalWindow(base, { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, seconds: 7_200 })).toEqual({ ok: false, code: "eligibility_unavailable" });
    const noAudit = { ...base, actor: async () => [] } as unknown as ApprovalWindowDeps;
    expect(await setApprovalWindow(noAudit, { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, seconds: 100 })).toEqual({ ok: false, code: "invalid" });
  });
});
