// Lane srv/trial-reads: the read-only trial and billing routes (design doc briefs/trial-billing-api.md), through the real dispatcher. Covers the roles, the company scoping, the real figures from the
// existing allowance sources (spend counters and the machine-hour counters), the billing switch, that nothing is written and nothing about a provider or a card is returned, and the contract schemas.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROKER_SETTINGS, BillingActionBodySchema, BillingAnswerReaderSchema, BillingStateReaderSchema, BillingStateSchema, InvoiceListReaderSchema, InvoiceSchema, TrialViewReaderSchema, TrialViewSchema, type BillingState, type TrialView, developerOrgKey, editionPolicy, machineTimeMonthKey, openComputeKey, orgMemberKey, orgMetaKey, orgSettingsKey, scopeKey, spendCounterKey } from "@agentx/cloud-contracts";
import { AgentXError, errorStatus, workspaceSessionKey } from "@rovara-code/contracts";
import { MINIMUM_REMAINING_USD } from "../../packages/broker/src/org/budget.js";
import { TASK_START_FLOOR_USD } from "../../packages/broker/src/org/trial-view.js";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { billingEnabled } from "../../packages/broker/src/org/billing-switch.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const who = "a".repeat(64), other = "b".repeat(64), bPerson = "c".repeat(64);
const NAMES: Record<string, string> = { [who]: "Wanda Writer", [other]: "Ada Admin", ["d".repeat(64)]: "Olive Owner", ["e".repeat(64)]: "Mo Member", [bPerson]: "Beta Boss" };
const NOW = Date.parse("2026-11-11T12:00:00Z");
const MONTH = "2026-11";

type Role = "owner" | "admin" | "member";
type Plan = "trial" | "team";
interface Options { role?: Role; cloud?: boolean; plan?: Plan; trial?: "unlocked" | "locked" | "github_used"; system?: boolean; edition?: "enterprise" | "public"; now?: number }

function fixture(options: Options = {}) {
  const { role = "owner", cloud = true, plan = "trial", trial = "unlocked", system = false, edition, now = NOW } = options;
  const db = new FakeDynamoDb();
  const orgRow = (orgId: string, planOf: Plan = plan) => ({
    ...orgMetaKey(orgId), orgId, name: orgId === A ? "Alpha" : "Beta", plan: planOf, ...(system ? { createdBy: "system" } : {}),
    ...(trial === "unlocked" ? { trialUnlockedAt: 1 } : trial === "github_used" ? { trialGithubUsedAt: 1 } : {}),
  });
  db.set(orgRow(A));
  db.set(orgRow(B));
  function member(orgId = A, person = who, current: string = role) {
    db.set({ ...orgMemberKey(orgId, person), orgId, developerId: person, role: current });
    db.set({ ...developerOrgKey(person), orgId, role: current });
    db.set({ pk: `DEVELOPER#${person}`, sk: "META", developerId: person, displayName: NAMES[person] ?? "Person " + person.slice(0, 4), provider: "cloud" });
  }
  member();
  member(B, bPerson, "owner");
  const deps = {
    documentClient: db, tableName: "state", cloud, now: () => now,
    ...(edition === undefined ? {} : { editionPolicy: editionPolicy(edition) }),
    orgs: {
      listMembers: async (orgId: string) => db.find((row) => row.pk === orgMemberKey(orgId as never, who).pk && typeof row.developerId === "string").map((row) => ({ developerId: row.developerId as string, role: row.role as string, joinedAt: "2026-01-01T00:00:00Z" })),
      getOrg: async (orgId: string) => { const row = db.get(orgMetaKey(orgId)); return row === undefined ? undefined : { orgId, name: row.name, plan: row.plan, createdBy: row.createdBy, trialUnlockedAt: row.trialUnlockedAt, trialGithubUsedAt: row.trialGithubUsedAt }; },
    },
    developer: { issuer: "https://cell.example/v1/auth", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) },
  } as unknown as DeveloperRouteDependencies;
  const caller = (orgRole: string = role, orgId = A, developerId = who): DeveloperCaller => ({ orgId, developerId, orgRole, name: "Person", amr: "cloud", sessionId: "fixture" } as unknown as DeveloperCaller);
  async function call(path: string, as: DeveloperCaller = caller(), method = "GET", headers: Record<string, string> = {}) {
    try {
      const body = await routeDeveloperRequest(deps, { method, path, headers, requestId: "trial-billing" }, new URL(path, "https://cell.example"), { caller: as, csrf: "" });
      return { status: body === undefined ? 404 : (body as { status?: number }).status ?? 200, body: (body as { body?: unknown }).body ?? body, code: undefined as string | undefined };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: errorStatus(error.code), body: undefined, code: error.code as string | undefined };
    }
  }
  const spend = (orgId: string, scope: string, spentUsd: number, committedUsd: number, month = MONTH) => db.set({ ...spendCounterKey(orgId, month, scope), spentUsd, committedUsd });
  const machine = (orgId: string, seconds: number, month = MONTH) => db.set({ ...machineTimeMonthKey(orgId, month), seconds });
  return { db, deps, caller, call, member, spend, machine };
}

const tv = (r: { body: unknown }): TrialView => TrialViewSchema.parse(r.body);
const bs = (r: { body: unknown }): BillingState => BillingStateSchema.parse(r.body);
const withBilling = () => vi.stubEnv(BROKER_SETTINGS.billing.variable, "1");
afterEach(() => vi.unstubAllEnvs());

const TRIAL = "/v1/app/trial", BILLING = "/v1/app/org/billing", INVOICES = "/v1/app/org/billing/invoices";

describe("GET /v1/app/trial: the real figures", () => {
  it("shows the monthly models allowance from the spend counters and the machine hours from the machine-time counters", async () => {
    const f = fixture();
    f.spend(A, "ORG", 142.5, 154.5);
    f.spend(A, scopeKey({ kind: "member", developerId: who }), 3.1, 4);
    f.machine(A, 7200);
    // One workspace has been running for an hour: it counts, as the admission check counts it.
    const started = NOW - 3600_000;
    f.db.set({ ...openComputeKey(A, "ws-1"), workspaceId: "ws-1", startedAt: started });
    f.db.set({ ...workspaceSessionKey("ws-1"), instanceId: "i-1", launchedAt: new Date(started).toISOString() });
    const r = await f.call(TRIAL);
    expect(r.status).toBe(200);
    expect(TrialViewSchema.parse(r.body)).toEqual(r.body);
    expect(r.body).toMatchObject({ phase: "active", plan: "trial" });
    expect(tv(r).allowances).toEqual([
      { kind: "models", unit: "usd", refresh: "monthly", period: { month: MONTH }, granted: 500, used: 142.5, held: 12, left: 345.5, state: "ok", source: "rovara" },
      { kind: "machine", unit: "hours", refresh: "monthly", period: { month: MONTH }, granted: 20, used: 3, left: 17, state: "ok" },
    ]);
    expect(tv(r).you).toEqual({ member: { limitUsd: 29, spentUsd: 3.1, committedUsd: 4 }, hitLimit: false, canChoose: true, notice: null });
    expect(tv(r).ends.when).toBe("monthly_refresh");
    expect(tv(r).ends.text).toContain("renews");
    expect(tv(r).choices).toBeNull();
  });

  it("never claims the allowance is one-time: every meter says it refreshes monthly, and a new month starts from nothing", async () => {
    const f = fixture({ now: Date.parse("2026-12-01T00:00:01Z") });
    f.spend(A, "ORG", 400, 400);
    f.machine(A, 99999);
    const r = await f.call(TRIAL);
    expect(tv(r).allowances.map((meter) => meter.refresh)).toEqual(["monthly", "monthly"]);
    expect(tv(r).allowances[0]).toMatchObject({ period: { month: "2026-12" }, used: 0, left: 500, state: "ok" });
    expect(tv(r).allowances[1]).toMatchObject({ period: { month: "2026-12" }, used: 0, left: 20 });
    expect(JSON.stringify(r.body)).not.toMatch(/never|one-time/i);
  });

  it("is used up at the machine limit and the models limit, and a held amount counts against what is left", async () => {
    const f = fixture();
    f.spend(A, "ORG", 100, 500);
    f.machine(A, 20 * 3600);
    const r = await f.call(TRIAL);
    expect(tv(r).allowances[0]).toMatchObject({ used: 100, held: 400, left: 0, state: "used_up" });
    expect(tv(r).allowances[1]).toMatchObject({ used: 20, left: 0, state: "used_up" });
    expect(tv(r).you.hitLimit).toBe(true);
  });

  it("is low from 80% of what is committed", async () => {
    const f = fixture();
    f.spend(A, "ORG", 400, 400);
    expect(tv(await f.call(TRIAL)).allowances[0]).toMatchObject({ state: "low", left: 100 });
    f.spend(A, "ORG", 399, 399);
    expect(tv(await f.call(TRIAL)).allowances[0]).toMatchObject({ state: "ok" });
  });

  it("gives a team its 400 machine hours, and a company the system created (or an install with no limit) no meter it has no allowance for", async () => {
    expect((await fixture({ plan: "team" }).call(TRIAL)).body).toMatchObject({ phase: "active", plan: "team", allowances: [{ kind: "models" }, { kind: "machine", granted: 400 }] });
    const sys = await fixture({ plan: "team", system: true, cloud: false }).call(TRIAL);
    expect(sys.status).toBe(200);
    expect(sys.body).toMatchObject({ phase: "active", plan: "team", allowances: [], you: { member: null } });
  });

  it("reports a locked trial and one whose GitHub account was used elsewhere, with no allowance and no choices", async () => {
    for (const trial of ["locked", "github_used"] as const) {
      const f = fixture({ trial });
      f.spend(A, "ORG", 480, 480);
      const r = await f.call(TRIAL);
      expect(r.body).toMatchObject({ phase: trial, allowances: [], choices: null, you: { hitLimit: false } });
      expect(tv(r).ends.text.length).toBeGreaterThan(0);
    }
  });
});

describe("GET /v1/app/trial: roles and the trial-end choices", () => {
  const short = (f: ReturnType<typeof fixture>, committed = 450) => f.spend(A, "ORG", committed, committed);

  for (const role of ["owner", "admin"] as const) it(`an ${role} may choose and is told the choices when an allowance is low`, async () => {
    const f = fixture({ role });
    short(f);
    const r = await f.call(TRIAL);
    expect(r.status).toBe(200);
    expect(tv(r).you.canChoose).toBe(true);
    expect(tv(r).choices).toMatchObject({ audience: "admins", decided: null });
    expect(tv(r).choices?.options).toEqual([
      expect.objectContaining({ id: "stop", available: false, unavailableReason: "not_built_yet" }),
      expect.objectContaining({ id: "auto_bill", available: false, unavailableReason: "billing_not_available" }),
      expect.objectContaining({ id: "own_key", available: true, unavailableReason: null, next: { href: "/app/admin/models" } }),
    ]);
  });

  it("a member (and so a project maintainer, who is an org member) cannot choose and sees no choices until they hit the limit", async () => {
    const f = fixture({ role: "member" });
    short(f);
    const low = await f.call(TRIAL);
    expect(low.status).toBe(200);
    expect(low.body).toMatchObject({ you: { canChoose: false, hitLimit: false }, choices: null });
    short(f, 500);
    const out = await f.call(TRIAL);
    expect(out.body).toMatchObject({ you: { canChoose: false, hitLimit: true }, choices: { audience: "you", decided: null } });
  });

  it("an owner sees no choices while both allowances are fine", async () => {
    const f = fixture();
    f.spend(A, "ORG", 10, 10);
    expect(tv(await f.call(TRIAL)).choices).toBeNull();
  });

  it("the Auditor and a role this release does not know are refused", async () => {
    const f = fixture();
    for (const role of ["auditor", "maintainer", "viewer"]) {
      const r = await f.call(TRIAL, f.caller(role));
      expect(r.status, role).toBe(403);
      expect(r.code).toBe("FORBIDDEN");
    }
  });

  it("answers not found where the edition has no trial (Enterprise), and for any method but GET", async () => {
    expect((await fixture({ edition: "enterprise" }).call(TRIAL)).status).toBe(404);
    expect((await fixture({ edition: "public" }).call(TRIAL)).status).toBe(200);
    expect((await fixture().call(TRIAL, undefined, "POST")).status).toBe(404);
  });
});

describe("company scoping: the company is the session's, never the request's", () => {
  it("/trial shows only the caller's company; a second company's figures never appear, whatever the request names", async () => {
    const f = fixture();
    f.spend(A, "ORG", 10, 10);
    f.spend(B, "ORG", 333, 333);
    f.spend(A, scopeKey({ kind: "member", developerId: who }), 1, 1);
    f.spend(A, scopeKey({ kind: "member", developerId: other }), 28, 28);
    f.spend(B, scopeKey({ kind: "member", developerId: who }), 17, 17);
    f.machine(A, 3600);
    f.machine(B, 18 * 3600);
    const mine = await f.call(TRIAL + "?orgId=" + B, f.caller(), "GET", { "x-org-id": B, "x-agentx-org": B });
    expect(tv(mine).allowances[0]).toMatchObject({ used: 10 });
    expect(tv(mine).allowances[1]).toMatchObject({ used: 1 });
    expect(tv(mine).you.member).toMatchObject({ spentUsd: 1 });
    expect(JSON.stringify(mine.body)).not.toMatch(/333|28\b|17\b/);
    // Positive control: the same routes do read company B for a caller of company B, so the numbers above are not zeros by accident.
    const theirs = await f.call(TRIAL, f.caller("owner", B, bPerson));
    expect(tv(theirs).allowances[0]).toMatchObject({ used: 333 });
    expect(tv(theirs).allowances[1]).toMatchObject({ used: 18 });
  });

  it("/org/billing reads the caller's company limit and plan only", async () => {
    withBilling();
    const f = fixture();
    f.db.set({ pk: `ORG#${B}`, sk: "x" });
    f.db.set({ ...orgMetaKey(B), orgId: B, name: "Beta", plan: "team", trialUnlockedAt: 1 });
    expect((await f.call(BILLING + "?orgId=" + B)).body).toMatchObject({ plan: "trial", phase: "active" });
    expect((await f.call(BILLING, f.caller("owner", B, bPerson))).body).toMatchObject({ plan: "team", phase: "active" });
  });

  it("/org/billing shows the caller's own monthly limit, never another company's (and /trial grants the same limit)", async () => {
    withBilling();
    const f = fixture();
    f.db.set({ ...orgSettingsKey(A, "BUDGET"), entityType: "ORG_BUDGET", memberOverrides: {}, orgMonthlyUsd: 123 });
    f.db.set({ ...orgSettingsKey(B, "BUDGET"), entityType: "ORG_BUDGET", memberOverrides: {}, orgMonthlyUsd: 777 });
    expect(bs(await f.call(BILLING)).autoBill.monthlyCeilingUsd).toBe(123);
    expect(tv(await f.call(TRIAL)).allowances[0]).toMatchObject({ kind: "models", granted: 123 });
    // Positive control: company B's own owner reads company B's limit.
    expect(bs(await f.call(BILLING, f.caller("owner", B, bPerson))).autoBill.monthlyCeilingUsd).toBe(777);
  });

  it("an owner of company B cannot read company A's billing by having a stale company id in the session", async () => {
    withBilling();
    const f = fixture();
    // The person's membership and pointer are company B's, but the session says company A: the live authority check refuses.
    const r = await f.call(BILLING, f.caller("owner", A, bPerson));
    expect(r.status).toBe(403);
  });
});

describe("billing routes: the switch, the roles and the answer", () => {
  it("are not found for everyone while the switch is off (owner included), and the trial read is unaffected", async () => {
    const f = fixture();
    for (const role of ["owner", "admin", "member"] as const) {
      expect((await f.call(BILLING, f.caller(role))).status, role).toBe(404);
      expect((await f.call(INVOICES, f.caller(role))).status, role).toBe(404);
    }
    expect((await f.call(TRIAL)).status).toBe(200);
  });

  it.each(["0", "true", " 1", "", "yes"])("treats %j as off", async (value) => {
    vi.stubEnv(BROKER_SETTINGS.billing.variable, value);
    expect((await fixture().call(BILLING)).status).toBe(404);
  });

  it("answers available: false with the plan, the phase and the monthly limit, and nothing from a provider", async () => {
    withBilling();
    const f = fixture();
    const r = await f.call(BILLING);
    expect(r.status).toBe(200);
    expect(BillingStateSchema.parse(r.body)).toEqual(r.body);
    expect(r.body).toEqual({
      available: false, provider: { configured: false }, plan: "trial", phase: "active",
      autoBill: { enabled: false, available: false, unavailableReason: "billing_not_available", monthlyCeilingUsd: 500 },
      paymentMethod: null, billingContact: null, pastDue: null, invoices: { count: 0, latest: null }, portal: { available: false }, lastEventAt: null,
    });
  });

  it("has no monthly ceiling to show where the install sets no limit", async () => {
    withBilling();
    const r = await fixture({ cloud: false, plan: "team", system: true }).call(BILLING);
    expect(bs(r).autoBill.monthlyCeilingUsd).toBeNull();
  });

  it("lists no invoices, checks the query, and reads no other method", async () => {
    withBilling();
    const f = fixture();
    expect((await f.call(INVOICES)).body).toEqual({ invoices: [] });
    expect((await f.call(INVOICES + "?limit=10&cursor=abc")).status).toBe(200);
    for (const bad of ["?limit=0", "?limit=51", "?limit=x", "?limit=1.5", "?cursor=", "?month=2026-11"]) expect((await f.call(INVOICES + bad)).code, bad).toBe("CONFIG_INVALID");
    expect((await f.call(BILLING, undefined, "POST")).status).toBe(404);
    expect((await f.call(BILLING, undefined, "PUT")).status).toBe(404);
    expect((await f.call(INVOICES, undefined, "DELETE")).status).toBe(404);
  });

  for (const role of ["owner", "admin"] as const) it(`an ${role} may read billing and invoices`, async () => {
    withBilling();
    const f = fixture({ role });
    expect((await f.call(BILLING)).status).toBe(200);
    expect((await f.call(INVOICES)).status).toBe(200);
  });

  it("a member, the Auditor and a role this release does not know are refused", async () => {
    withBilling();
    const f = fixture({ role: "member" });
    for (const path of [BILLING, INVOICES]) {
      const member = await f.call(path);
      expect(member.status, path).toBe(403);
      expect(member.code).toBe("FORBIDDEN");
      for (const role of ["auditor", "maintainer", "viewer"]) expect((await f.call(path, f.caller(role))).code, role + path).toBe("FORBIDDEN");
    }
  });

  it("reads the role now: a token that says owner does not help a person who is a member in the store (or removed, or in a closing company)", async () => {
    withBilling();
    const f = fixture({ role: "member" });
    for (const path of [BILLING, INVOICES]) expect((await f.call(path, f.caller("owner"))).status, path).toBe(403);
    const g = fixture({ role: "owner" });
    expect((await g.call(BILLING)).status).toBe(200);
    g.db.set({ ...g.db.get(orgMetaKey(A))!, closingAt: 1 });
    expect((await g.call(BILLING)).status).toBe(403);
    const h = fixture({ role: "owner" });
    h.db.delete(orgMemberKey(A, who));
    expect((await h.call(INVOICES)).status).toBe(403);
  });

  it("is not found on an edition with no trial or billing, even with the switch on", async () => {
    withBilling();
    expect((await fixture({ edition: "enterprise" }).call(BILLING)).status).toBe(404);
  });
});

describe("what the reads never do or return", () => {
  it("writes nothing, and reads consistently", async () => {
    withBilling();
    const f = fixture();
    f.spend(A, "ORG", 10, 10);
    f.machine(A, 60);
    const commands: string[] = [];
    const send = f.db.send.bind(f.db);
    f.db.send = (async (command: { constructor: { name: string }; input?: { ConsistentRead?: boolean } }) => { commands.push(command.constructor.name); return send(command as never); });
    for (const path of [TRIAL, BILLING, INVOICES]) expect((await f.call(path)).status).toBe(200);
    // Positive control: reads did run.
    expect(commands.length).toBeGreaterThan(5);
    expect(commands.filter((name) => !["GetCommand", "QueryCommand"].includes(name))).toEqual([]);
  });

  it("returns no card, provider id, token or contact on any path, for any phase", async () => {
    withBilling();
    for (const trial of ["unlocked", "locked", "github_used"] as const) {
      const f = fixture({ trial });
      f.spend(A, "ORG", 480, 480);
      for (const path of [TRIAL, BILLING, INVOICES]) {
        const text = JSON.stringify((await f.call(path)).body);
        expect(text, path).not.toMatch(/last4|cus_|pm_|sk_|tok_|token|secret|stripe|email|@/i);
      }
    }
  });

  it("fails closed when the store fails (a retryable error, not a plausible answer)", async () => {
    withBilling();
    const f = fixture();
    f.db.injectFault({ command: "GetCommand", error: { name: "ServiceUnavailable", message: "private fixture text" } });
    const r = await f.call(TRIAL);
    expect(r.code).toBe("RUNTIME_UNAVAILABLE");
    expect(r.status).toBe(503);
  });
});

describe("the browser path", () => {
  it("reads /v1/web/trial with GET only, and /v1/web/org/billing", () => {
    expect(webRouteAllowed("GET", "/v1/web/trial")).toBe(true);
    for (const method of ["POST", "PUT", "DELETE"]) expect(webRouteAllowed(method, "/v1/web/trial"), method).toBe(false);
    expect(webRouteAllowed("GET", "/v1/web/trial/extra")).toBe(false);
    expect(webRouteAllowed("GET", "/v1/web/org/billing")).toBe(true);
    expect(webRouteAllowed("GET", "/v1/web/org/billing/invoices")).toBe(true);
  });
});

describe("the billing switch", () => {
  it("is the packed setting `bl`, on only when exactly 1", () => {
    expect(BROKER_SETTINGS.billing).toEqual({ code: "bl", variable: "BILLING_ENABLED" });
    expect(billingEnabled({ BILLING_ENABLED: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", " 1", "1 ", "on"]) expect(billingEnabled({ BILLING_ENABLED: value }), String(value)).toBe(false);
  });
});

describe("the contract schemas", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const invoice = {
    invoiceId: "inv-1", number: "RV-2026-0012", period: { start: "2026-11-01", end: "2026-11-30" }, status: "paid", currency: "USD", totalMinor: 12345, issuedAt: "2026-12-01T00:00:00Z", dueAt: null, paidAt: null,
    lines: [{ kind: "models", description: "Rovara-provided models, November", quantity: 142.5, unit: "usd_at_cost", amountMinor: 14250 }], hostedUrl: "https://pay.example/i/1", pdfUrl: null,
  };

  it("reads what the server sends, and a word a newer server adds reads as unknown", async () => {
    const f = fixture();
    f.spend(A, "ORG", 450, 450);
    const view = tv(await f.call(TRIAL));
    expect(TrialViewReaderSchema.parse(view)).toEqual(view);
    const future = { ...view, phase: "paused_for_review", extra: 1, choices: { ...view.choices, options: [...(view.choices?.options ?? []), { id: "invoice_me", available: false, unavailableReason: "legal", summary: "x" }] } };
    const read = TrialViewReaderSchema.parse(future);
    expect(read.phase).toBe("unknown");
    expect(read.choices?.options.at(-1)).toMatchObject({ id: "unknown", unavailableReason: "unknown" });
    expect(() => TrialViewSchema.parse(future)).toThrow();
    withBilling();
    const state = bs(await f.call(BILLING));
    expect(BillingStateReaderSchema.parse(state)).toEqual(state);
    expect(BillingStateReaderSchema.parse({ ...state, phase: "frozen" }).phase).toBe("unknown");
    expect(InvoiceListReaderSchema.parse({ invoices: [invoice], next: "c" })).toMatchObject({ invoices: [{ status: "paid" }] });
    expect(InvoiceListReaderSchema.parse({ invoices: [{ ...invoice, status: "refunded" }] })).toMatchObject({ invoices: [{ status: "unknown" }] });
  });

  it("is strict about what the server may send: no extra field, no http address, no float invoice money, no bad last digits", () => {
    expect(() => InvoiceSchema.parse(invoice)).not.toThrow();
    for (const bad of [{ cardNumber: "x" }, { hostedUrl: "http://pay.example/i/1" }, { hostedUrl: "javascript:alert(1)" }, { totalMinor: 123.45 }, { currency: "usd" }, { invoiceId: "x".repeat(121) }]) expect(() => InvoiceSchema.parse({ ...invoice, ...bad }), JSON.stringify(bad)).toThrow();
    const state = { available: false, provider: { configured: false }, plan: "trial", phase: "active", autoBill: { enabled: false, available: false, unavailableReason: null, monthlyCeilingUsd: null }, paymentMethod: null, billingContact: null, pastDue: null, invoices: { count: 0, latest: null }, portal: { available: false }, lastEventAt: null };
    expect(() => BillingStateSchema.parse(state)).not.toThrow();
    const card = { kind: "card", brand: "visa", last4: "4242", expMonth: 12, expYear: 2028, status: "valid", updatedAt: "2026-11-01T00:00:00Z" };
    expect(() => BillingStateSchema.parse({ ...state, paymentMethod: card })).not.toThrow();
    for (const bad of [{ last4: "424242" }, { pan: "4242424242424242" }, { providerId: "pm_x" }]) expect(() => BillingStateSchema.parse({ ...state, paymentMethod: { ...card, ...bad } }), JSON.stringify(bad)).toThrow();
    expect(() => BillingStateSchema.parse({ ...state, provider: { configured: false, name: "x" } })).toThrow();
  });

  it("checks the action bodies programme M will take: strict, a uuid request id, and a return path inside the app", () => {
    const ok = (body: unknown) => BillingActionBodySchema.safeParse(body).success;
    expect(ok({ action: "choose-trial-end", requestId: uuid, choice: "own_key" })).toBe(true);
    expect(ok({ action: "auto-bill", requestId: uuid, enabled: true })).toBe(true);
    expect(ok({ action: "payment-method-setup", requestId: uuid, returnPath: "/app/admin/billing" })).toBe(true);
    expect(ok({ action: "choose-trial-end", requestId: "nope", choice: "stop" })).toBe(false);
    expect(ok({ action: "choose-trial-end", requestId: uuid, choice: "free_forever" })).toBe(false);
    expect(ok({ action: "choose-trial-end", requestId: uuid, choice: "stop", extra: 1 })).toBe(false);
    for (const returnPath of ["https://evil.example/app", "//evil.example", "/app/../admin", "/other", "/app//x", "/app/a?x=1", "javascript:alert(1)", "/app/\u0000"]) expect(ok({ action: "portal", requestId: uuid, returnPath }), returnPath).toBe(false);
    expect(ok({ action: "unknown-action", requestId: uuid })).toBe(false);
  });

  it("reads one answer shape for every action: the new state and a redirect or an in-app next page", () => {
    const state = { available: false, provider: { configured: false }, plan: "trial", phase: "active", autoBill: { enabled: false, available: false, unavailableReason: null, monthlyCeilingUsd: null }, paymentMethod: null, billingContact: null, pastDue: null, invoices: { count: 0, latest: null }, portal: { available: false }, lastEventAt: null };
    const read = (answer: unknown) => BillingAnswerReaderSchema.safeParse(answer);
    expect(read({ status: "needs_action", state, action: { kind: "redirect", url: "https://pay.example/setup", expiresAt: "2026-11-11T12:10:00Z" } }).success).toBe(true);
    expect(read({ status: "needs_action", state, action: { kind: "navigate", href: "/app/admin/models" } }).success).toBe(true);
    expect(read({ status: "done", state }).success).toBe(true);
    const teleport = read({ status: "done", state, action: { kind: "teleport" } });
    expect(teleport.success && teleport.data.action?.kind).toBe("unknown");
  });
});

describe("used up means what admission refuses on (M1)", () => {
  it("is used up when less than a task start needs is left: 499.80 of 500", async () => {
    const f = fixture();
    f.spend(A, "ORG", 499.8, 499.8);
    const view = tv(await f.call(TRIAL));
    expect(view.allowances[0]).toMatchObject({ granted: 500, used: 499.8, left: 0.2, state: "used_up" });
    expect(view.you.hitLimit).toBe(true);
    expect(view.choices).toMatchObject({ audience: "admins" });
    // A member sees the prompt too, as the next start is refused.
    const m = fixture({ role: "member" });
    m.spend(A, "ORG", 499.8, 499.8);
    expect(tv(await m.call(TRIAL))).toMatchObject({ you: { hitLimit: true }, choices: { audience: "you" } });
  });

  it("takes its floor from the shared admission constant, and is not used up at exactly the floor", async () => {
    expect(TASK_START_FLOOR_USD).toBe(MINIMUM_REMAINING_USD.TASK);
    const f = fixture();
    f.spend(A, "ORG", 500 - MINIMUM_REMAINING_USD.TASK, 500 - MINIMUM_REMAINING_USD.TASK);
    expect(tv(await f.call(TRIAL)).allowances[0]).toMatchObject({ state: "low" });
    f.spend(A, "ORG", 500 - MINIMUM_REMAINING_USD.TASK + 0.01, 500 - MINIMUM_REMAINING_USD.TASK + 0.01);
    expect(tv(await f.call(TRIAL)).allowances[0]).toMatchObject({ state: "used_up" });
  });
});

describe("a person's own monthly limit (M2, decision 95)", () => {
  const OWNER = "d".repeat(64), MEMBER2 = "e".repeat(64);
  function withPeople(f: ReturnType<typeof fixture>) {
    f.member(A, other, "admin");
    f.member(A, OWNER, "owner");
    f.member(A, MEMBER2, "member");
    f.member(B, "f".repeat(64), "admin");
    f.db.set({ pk: `DEVELOPER#${"f".repeat(64)}`, sk: "META", developerId: "f".repeat(64), displayName: "Other Company Admin", provider: "cloud" });
  }

  it("says the personal limit is used up while the company has room, offers Ask an admin, and names the admins", async () => {
    const f = fixture({ role: "member" });
    withPeople(f);
    f.spend(A, "ORG", 20, 20);
    f.spend(A, scopeKey({ kind: "member", developerId: who }), 28.8, 28.8);
    const view = tv(await f.call(TRIAL));
    expect(view.allowances[0]).toMatchObject({ state: "ok" });
    expect(view.you).toMatchObject({ hitLimit: true, canChoose: false, notice: { kind: "personal_limit_used_up", text: "Your personal limit is used up for this month." } });
    expect(view.choices).toMatchObject({ audience: "you" });
    expect(view.admins.map((admin) => admin.name).sort()).toEqual(["Ada Admin", "Olive Owner"]);
    expect(view.admins.every((admin) => /^[a-f0-9]{64}$/u.test(admin.id))).toBe(true);
    // No member, no writer of another company, appears.
    expect(JSON.stringify(view)).not.toMatch(/Mo Member|Other Company Admin|Wanda/);
  });

  it("says nothing while the person has room, and names no one", async () => {
    const f = fixture({ role: "member" });
    withPeople(f);
    f.spend(A, scopeKey({ kind: "member", developerId: who }), 20, 20);
    const view = tv(await f.call(TRIAL));
    expect(view.you).toMatchObject({ hitLimit: false, notice: null });
    expect(view.choices).toBeNull();
    expect(view.admins).toEqual([]);
  });

  it("an admin whose own limit is used up sees the notice and the choices, and needs no names", async () => {
    const f = fixture({ role: "admin" });
    withPeople(f);
    f.spend(A, scopeKey({ kind: "member", developerId: who }), 29, 29);
    const view = tv(await f.call(TRIAL));
    expect(view.you).toMatchObject({ hitLimit: true, canChoose: true, notice: { kind: "personal_limit_used_up" } });
    expect(view.choices).toMatchObject({ audience: "admins" });
    expect(view.admins).toEqual([]);
  });

  it("uses the same floor as admission: 28.60 of 29 is used up, 28.40 is not", async () => {
    const f = fixture({ role: "member" });
    f.spend(A, scopeKey({ kind: "member", developerId: who }), 28.4, 28.4);
    expect(tv(await f.call(TRIAL)).you.hitLimit).toBe(false);
    f.spend(A, scopeKey({ kind: "member", developerId: who }), 28.6, 28.6);
    expect(tv(await f.call(TRIAL)).you.hitLimit).toBe(true);
  });

  it("reads only the caller's own member counter: another person's used-up limit is not the caller's", async () => {
    const f = fixture({ role: "member" });
    withPeople(f);
    f.spend(A, scopeKey({ kind: "member", developerId: MEMBER2 }), 29, 29);
    expect(tv(await f.call(TRIAL)).you).toMatchObject({ hitLimit: false, notice: null });
  });

  it("is in the contract: the admins list is strict and bounded", () => {
    const base = { phase: "active", plan: "trial", allowances: [], you: { member: null, hitLimit: false, canChoose: false, notice: null }, ends: { when: "monthly_refresh", text: "x" }, choices: null };
    expect(TrialViewSchema.safeParse({ ...base, admins: [{ id: "a".repeat(64), name: "Ada" }] }).success).toBe(true);
    expect(TrialViewSchema.safeParse({ ...base, admins: [{ id: "a".repeat(64), name: "Ada", email: "a@b.c" }] }).success).toBe(false);
    expect(TrialViewSchema.safeParse({ ...base, admins: Array.from({ length: 21 }, () => ({ id: "a".repeat(64), name: "Ada" })) }).success).toBe(false);
    expect(TrialViewSchema.safeParse({ ...base }).success).toBe(false);
  });
});

describe("a non-cloud install (L2)", () => {
  it("shows no machine meter and no locked phase: admission enforces neither there", async () => {
    const f = fixture({ cloud: false, trial: "locked" });
    f.db.set({ ...orgSettingsKey(A, "BUDGET"), entityType: "ORG_BUDGET", memberOverrides: {}, orgMonthlyUsd: 50 });
    f.machine(A, 99 * 3600);
    const view = tv(await f.call(TRIAL));
    expect(view.phase).toBe("active");
    expect(view.allowances.map((meter) => meter.kind)).toEqual(["models"]);
    // Positive control: the same company on a cloud install is locked and has the machine meter's input.
    const cloud = fixture({ cloud: true, trial: "locked" });
    expect(tv(await cloud.call(TRIAL)).phase).toBe("locked");
    const unlocked = fixture({ cloud: true });
    expect(tv(await unlocked.call(TRIAL)).allowances.map((meter) => meter.kind)).toEqual(["models", "machine"]);
    withBilling();
    expect(bs(await f.call(BILLING)).phase).toBe("active");
  });
});
