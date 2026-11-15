// The app's company routes on Cloud's own data (company-routes.ts), through the real handler and a fake Code that issues JWT access tokens
// carrying Code's step-up claims. Covers: the company comes from Code's access check (never the request), company isolation, admin-only
// routes checked against Code live, the fresh step-up on every settings change (refused when stale, missing, of a factor Code doesn't own,
// or past the company's own window), a second admin for a loosening change, invites told to Code first (501 while Code lacks the route),
// the app's reader schemas, and the policy hook answering from the same store with its install allow-list.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CodeClient, LocalCloudAuditStore, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, PRE_APPROVED_EMAILS_PATH, POLICY_HOOK_PATH, StoreCompanyRules, StoreHookInstalls, createCloudHandler,
  createPolicyHookRoute, defaultCompanySettings, type CloudRequest, type CompanySettings, type CompanyStore,
} from "../../packages/cloud-server/src/index.js";
import { AdminBudgetSettingsSchema } from "../../packages/contracts/src/admin-budget.js";
import { AppOrgInvitesResponseSchema, AppOrgInviteStatusSchema } from "../../packages/contracts/src/developer-web.js";
import { ReviewedInviteCreateResponseSchema } from "../../packages/contracts/src/invite-creation.js";
import { OrganizationInviteResponseSchema, RenameOrganizationResponseSchema, RevokeOrganizationInviteResponseSchema } from "../../packages/contracts/src/onboarding.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-15T12:00:00.000Z");

interface Person { developerId: string; name: string; administrator: boolean; companyId?: unknown }
const PEOPLE: Record<string, Person> = {
  ada: { developerId: "a".repeat(64), name: "Ada", administrator: true, companyId: A },
  bea: { developerId: "b".repeat(64), name: "Bea", administrator: true, companyId: A },
  cal: { developerId: "c".repeat(64), name: "Cal", administrator: false, companyId: A },
  dan: { developerId: "d".repeat(64), name: "Dan", administrator: true, companyId: B },
  eve: { developerId: "e".repeat(64), name: "Eve", administrator: false, companyId: B },
  solo: { developerId: "f".repeat(64), name: "Solo", administrator: true },
  odd: { developerId: "9".repeat(64), name: "Odd", administrator: true, companyId: "acme" },
};

/** An answer body as the tests read it: whichever of these the route sent. */
interface Answer { error: { code: string; message: string }; pending: { changeId: string }; invites: Array<{ inviteId: string }>; [key: string]: unknown }
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
let tokens = 0;

function world(options: { deploymentCompany?: string; codeHasPreApprovals?: boolean; audit?: LocalCloudAuditStore } = {}) {
  let clock = START;
  const nowS = () => Math.floor(clock / 1000);
  const byToken = new Map<string, Person>();
  const preApproved: Array<{ token: string; emails: string[] }> = [];
  const demoted = new Set<string>();
  let codeHasPreApprovals = options.codeHasPreApprovals ?? true;
  let codeFails = false;
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const person = byToken.get(auth.replace(/^Bearer /u, ""));
    if (person === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") {
      return respond(200, { developerId: person.developerId, displayName: person.name, administrator: person.administrator && !demoted.has(person.developerId), projects: [], notices: [], ...(person.companyId === undefined ? {} : { companyId: person.companyId }) });
    }
    if (url.pathname === PRE_APPROVED_EMAILS_PATH && init?.method === "PUT") {
      if (!codeHasPreApprovals) return respond(404, { message: "Not Found" });
      if (codeFails) return respond(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Code is down" } });
      const body = JSON.parse(init.body as string) as { requestId: string; emails: string[] };
      preApproved.push({ token: auth, emails: body.emails });
      return respond(200, { emails: body.emails, revision: preApproved.length });
    }
    return respond(404, { error: { code: "NOT_FOUND" } });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock, environment: {} });
  const store: CompanyStore = new LocalCompanyStore();
  const log: Array<Record<string, unknown>> = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN,
    company: { store, ...(options.deploymentCompany === undefined ? {} : { companyId: options.deploymentCompany }), log: (event) => { log.push(event); } },
    now: () => new Date(clock), log: () => undefined, ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
  /** Signs a person in. `stepUpAge` seconds ago they stepped up with `method`; undefined: no step-up in this sign-in. */
  const signIn = async (who: string, stepUpAge?: number, method = "passkey") => {
    const person = PEOPLE[who]!;
    tokens += 1;
    const payload = { sub: person.developerId, iat: nowS(), exp: nowS() + 3600, jti: String(tokens), ...(stepUpAge === undefined ? {} : { step_up_at: nowS() - stepUpAge, step_up_amr: method }) };
    const token = `${b64({ alg: "RS256", typ: "JWT", kid: "code" })}.${b64(payload)}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    // What Cloud saw at sign-in: routes ask Code again, so this can go stale.
    await sessions.create(cookie, { accessToken: token, access: { developerId: person.developerId, displayName: person.name, administrator: person.administrator, projects: [], notices: [] }, csrf: `csrf-${cookie}`, signedInAt: new Date(clock).toISOString() });
    return { cookie, token };
  };
  const call = async (as: { cookie: string }, method: string, path: string, body?: unknown) => {
    const request: CloudRequest = {
      method, path: `/v1/web${path.split("?")[0]!}`, query: new URLSearchParams(path.split("?")[1] ?? ""),
      headers: { cookie: `rovara_cloud_session=${as.cookie}`, "x-rovara-csrf": `csrf-${as.cookie}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const answer = await handler(request);
    return { status: answer!.status, body: JSON.parse(answer!.body) as Answer };
  };
  return {
    handler, store, signIn, call, preApproved, demoted, log,
    advance: (ms: number) => { clock += ms; }, now: () => clock,
    setCode: (state: { preApprovals?: boolean; fails?: boolean }) => { if (state.preApprovals !== undefined) codeHasPreApprovals = state.preApprovals; if (state.fails !== undefined) codeFails = state.fails; },
  };
}

const tightened = (): CompanySettings => ({ ...defaultCompanySettings(), featureGates: { auto_merge: false }, websiteCeiling: { mode: "listed", hosts: ["github.com", "npmjs.org"] }, evalBudgetUsdMicros: 2_000_000 });

describe("company settings", () => {
  it("shows an admin the defaults before anything is saved, and the members' own data isn't theirs to read", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const read = await w.call(ada, "GET", "/org/settings");
    expect(read).toEqual({ status: 200, body: { companyId: A, settings: defaultCompanySettings(), version: 0, modelGateway: { ready: false, reason: "company_monthly_cap_unset", message: "Set a monthly cap to use the model gateway." } } });
    const cal = await w.signIn("cal", 10);
    expect((await w.call(cal, "GET", "/org/settings")).status).toBe(403);
    expect((await w.call(cal, "PUT", "/org/settings", { expectedVersion: 0, settings: tightened() })).body.error.code).toBe("FORBIDDEN");
    expect((await w.call(cal, "GET", "/org/budget-settings")).status).toBe(403);
  });

  it("saves a tightening change straight away with a fresh step-up, and only for the admin's own company", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    const saved = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: tightened() });
    expect(saved).toEqual({ status: 200, body: { companyId: A, version: 1, settings: tightened() } });
    expect((await w.call(ada, "GET", "/org/settings")).body).toMatchObject({ companyId: A, version: 1, settings: tightened(), updatedBy: PEOPLE.ada!.developerId });
    const dan = await w.signIn("dan", 30);
    expect((await w.call(dan, "GET", "/org/settings")).body).toEqual({ companyId: B, settings: defaultCompanySettings(), version: 0, modelGateway: { ready: false, reason: "company_monthly_cap_unset", message: "Set a monthly cap to use the model gateway." } });
    expect(w.log).toContainEqual(expect.objectContaining({ event: "cloud.company_settings_changed", companyId: A, version: 1, loosening: false }));
  });

  it("never takes the company from the request", async () => {
    const w = world();
    const dan = await w.signIn("dan", 30);
    expect((await w.call(dan, "PUT", "/org/settings", { expectedVersion: 0, settings: tightened(), companyId: A })).status).toBe(400);
    expect((await w.call(dan, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...tightened(), companyId: A } })).status).toBe(400);
    expect((await w.call(dan, "PUT", "/org/settings?companyId=" + A, { expectedVersion: 0, settings: tightened() })).body.companyId).toBe(B);
    expect(await w.store.settings(A)).toBeUndefined();
    expect((await w.store.settings(B))!.version).toBe(1);
  });

  const refusedStepUps: Array<[string, number | undefined, string?]> = [
    ["no step-up in this sign-in", undefined],
    ["a step-up older than Code's window", 601],
    ["a factor Code doesn't own (a Slack round trip)", 10, "slack"],
    ["a step-up time from the future", -120],
  ];
  for (const [name, age, method] of refusedStepUps) {
    it(`refuses a settings change with ${name}, and saves nothing`, async () => {
      const w = world();
      const ada = await w.signIn("ada", age, method);
      const answer = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: tightened() });
      expect(answer).toEqual({ status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "Confirm it's you again, then try once more." } } });
      expect(await w.store.settings(A)).toBeUndefined();
    });
  }

  it("goes stale as time passes, and follows the company's own shorter window", async () => {
    const w = world();
    const ada = await w.signIn("ada", 0);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...tightened(), freshSignInSeconds: 120 } })).status).toBe(200);
    w.advance(121_000);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...tightened(), freshSignInSeconds: 120, evalBudgetUsdMicros: 1 } })).body.error.code).toBe("STEP_UP_REQUIRED");
    const again = await w.signIn("ada", 119);
    expect((await w.call(again, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...tightened(), freshSignInSeconds: 120, evalBudgetUsdMicros: 1 } })).status).toBe(200);
  });

  it("asks Code afresh: an admin Code has demoted since sign-in is refused", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    w.demoted.add(PEOPLE.ada!.developerId);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: tightened() })).body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a stale version and a body that does not read, in fixed words", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 3, settings: tightened() })).status).toBe(409);
    const bad = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...tightened(), featureGates: { "<script>SECRET": true } } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("SECRET");
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: -1, settings: tightened() })).status).toBe(400);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...tightened(), instructions: Array.from({ length: 30 }, () => ({ text: "x".repeat(4000), priority: "required" })) } })).status).toBe(413);
  });

  it("holds a loosening change for a different admin, each with a fresh step-up", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: tightened() });
    const looser = { ...tightened(), websiteCeiling: { mode: "any" as const } };
    const proposed = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: looser });
    expect(proposed.status).toBe(202);
    const changeId = proposed.body.pending.changeId;
    expect(changeId).toMatch(/^chg_[0-9a-z]{20}$/u);
    expect((await w.call(ada, "GET", "/org/settings")).body).toMatchObject({ version: 1, settings: tightened(), pending: { changeId, settings: looser, proposedBy: PEOPLE.ada!.developerId } });
    // A second change can't be proposed while one waits.
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...looser, evalBudgetUsdMicros: null } })).status).toBe(409);
    // The proposer can't approve their own change.
    expect((await w.call(ada, "POST", `/org/settings/pending/${changeId}/approve`, {})).body.error.code).toBe("SECOND_PERSON_REQUIRED");
    // Another company's admin can't see it.
    const dan = await w.signIn("dan", 10);
    expect((await w.call(dan, "POST", `/org/settings/pending/${changeId}/approve`, {})).status).toBe(404);
    expect((await w.call(dan, "POST", `/org/settings/pending/${changeId}/withdraw`, {})).status).toBe(404);
    // A member can't approve.
    const cal = await w.signIn("cal", 10);
    expect((await w.call(cal, "POST", `/org/settings/pending/${changeId}/approve`, {})).status).toBe(403);
    // The second admin needs a fresh step-up of their own.
    const staleBea = await w.signIn("bea", 700);
    expect((await w.call(staleBea, "POST", `/org/settings/pending/${changeId}/approve`, {})).body.error.code).toBe("STEP_UP_REQUIRED");
    const bea = await w.signIn("bea", 5);
    expect(await w.call(bea, "POST", `/org/settings/pending/${changeId}/approve`, {})).toEqual({ status: 200, body: { companyId: A, version: 2, settings: looser } });
    expect((await w.call(ada, "GET", "/org/settings")).body).toMatchObject({ version: 2, settings: looser });
    expect((await w.call(ada, "GET", "/org/settings")).body.pending).toBeUndefined();
    expect(w.log).toContainEqual(expect.objectContaining({ event: "cloud.company_settings_approved", companyId: A, developerId: PEOPLE.bea!.developerId, proposedBy: PEOPLE.ada!.developerId }));
  });

  it("treats removing the second-person rule as loosening, judged by the rules in force", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    const answer = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), decisions: [] } });
    expect(answer.status).toBe(202);
    expect(await w.store.settings(A)).toBeUndefined();
  });

  it("drops a waiting change that the settings moved past, and lets any admin withdraw one", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    const bea = await w.signIn("bea", 10);
    const first = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), start: { allow: true, maxEstimateUsdMicros: null }, evalBudgetUsdMicros: null, featureGates: { x: true } } });
    expect(first.status).toBe(202);
    // A tightening change goes through meanwhile, so the waiting one can never apply.
    expect((await w.call(bea, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), evalBudgetUsdMicros: 1 } })).status).toBe(200);
    expect((await w.call(bea, "POST", `/org/settings/pending/${first.body.pending.changeId}/approve`, {})).status).toBe(409);
    expect((await w.call(ada, "GET", "/org/settings")).body.pending).toBeUndefined();
    const second = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), evalBudgetUsdMicros: 2 } });
    expect(second.status).toBe(202);
    const stale = await w.signIn("bea");
    expect(await w.call(stale, "POST", `/org/settings/pending/${second.body.pending.changeId}/withdraw`, {})).toEqual({ status: 200, body: { withdrawn: true } });
    expect((await w.call(ada, "GET", "/org/settings")).body.pending).toBeUndefined();
  });

  it("applies a loosening change at once when the company's rules ask no second person", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    const bea = await w.signIn("bea", 10);
    const proposal = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), decisions: [] } });
    await w.call(bea, "POST", `/org/settings/pending/${proposal.body.pending.changeId}/approve`, {});
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), decisions: [], featureGates: { beta: true } } })).status).toBe(200);
  });

  it("follows deciders and refusals in the company's rules", async () => {
    const w = world();
    const deciders = [{ what: "setting.*", deciders: [PEOPLE.bea!.developerId, PEOPLE.cal!.developerId] }];
    await w.store.putSettings(A, { ...defaultCompanySettings(), decisions: deciders }, 0, "seed", new Date(START).toISOString());
    const ada = await w.signIn("ada", 10);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), decisions: deciders, evalBudgetUsdMicros: 1 } })).body.error.code).toBe("FORBIDDEN");
    const bea = await w.signIn("bea", 10);
    expect((await w.call(bea, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), decisions: deciders, evalBudgetUsdMicros: 1 } })).status).toBe(200);
    // Company B's rules name other deciders: B's own admin is not one of them.
    await w.store.putSettings(B, { ...defaultCompanySettings(), decisions: [{ what: "setting.change", deciders: [PEOPLE.ada!.developerId, PEOPLE.bea!.developerId] }] }, 0, "seed", new Date(START).toISOString());
    const dan = await w.signIn("dan", 10);
    expect((await w.call(dan, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), decisions: [{ what: "setting.change", deciders: [PEOPLE.ada!.developerId, PEOPLE.bea!.developerId] }], evalBudgetUsdMicros: 1 } })).body.error.code).toBe("FORBIDDEN");
  });

  it("refuses every loosening change when the company forbids loosening, and still lets it tighten", async () => {
    const w = world();
    await w.store.putSettings(B, { ...defaultCompanySettings(), decisions: [{ what: "setting.loosen", allow: false }] }, 0, "seed", new Date(START).toISOString());
    const dan = await w.signIn("dan", 10);
    const forbid = [{ what: "setting.loosen", allow: false }];
    // Loosening: dropping the rule itself, lifting a cap. Refused outright, not even proposed.
    expect((await w.call(dan, "PUT", "/org/settings", { expectedVersion: 1, settings: defaultCompanySettings() })).body.error.code).toBe("FORBIDDEN");
    expect((await w.call(dan, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), decisions: forbid, featureGates: { beta: true } } })).body.error.code).toBe("FORBIDDEN");
    expect(await w.store.pendingChange(B, w.now())).toBeUndefined();
    // Tightening still works, so the settings are never frozen.
    expect((await w.call(dan, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), decisions: forbid, evalBudgetUsdMicros: 1 } })).status).toBe(200);
    // Through the app, too: the rule saves with a fresh step-up (a second admin agrees, as for any new rule on settings).
    const ada = await w.signIn("ada", 10);
    const bea = await w.signIn("bea", 10);
    const proposed = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), decisions: [...defaultCompanySettings().decisions, ...forbid] } });
    expect(proposed.status).toBe(202);
    expect((await w.call(bea, "POST", `/org/settings/pending/${proposed.body.pending.changeId}/approve`, {})).status).toBe(200);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: defaultCompanySettings() })).body.error.code).toBe("FORBIDDEN");
  });

  it("judges a change by the rules in force, never by the rules it proposes", async () => {
    const w = world();
    // In force: loosening needs a second admin, and only Bea or Cal may decide one.
    const rules = [{ what: "setting.loosen", secondPerson: true }, { what: "setting.loosen", deciders: [PEOPLE.bea!.developerId, PEOPLE.cal!.developerId] }];
    await w.store.putSettings(A, { ...defaultCompanySettings(), decisions: rules }, 0, "seed", new Date(START).toISOString());
    const ada = await w.signIn("ada", 10);
    // Ada proposes dropping every rule: under the rules in force it waits for a second admin (judged by the proposal, it would apply at once).
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), decisions: [] } })).status).toBe(202);
    expect((await w.store.settings(A))!.version).toBe(1);
  });

  it("lets no admin take the settings over alone: a new rule on settings changes waits for a second admin", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    const mine = { ...defaultCompanySettings(), decisions: [...defaultCompanySettings().decisions, { what: "setting.*", deciders: [PEOPLE.ada!.developerId, PEOPLE.cal!.developerId] }] };
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: mine })).status).toBe(202);
    expect(await w.store.settings(A)).toBeUndefined();
    // A rule that would freeze EVERY settings change (no way out, not even removing it) is refused outright.
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), decisions: [{ what: "setting.*", allow: false }] } })).status).toBe(400);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), decisions: [{ what: "setting.change", allow: false }] } })).status).toBe(400);
  });

  it("answers settings that do not read as unavailable, never as defaults", async () => {
    const w = world();
    await w.store.putSettings(A, { ...defaultCompanySettings(), locks: { nope: 1 } }, 0, "seed", new Date(START).toISOString());
    const ada = await w.signIn("ada", 10);
    expect((await w.call(ada, "GET", "/org/settings")).status).toBe(503);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: tightened() })).status).toBe(503);
  });
});

describe("Cloud's audit records", () => {
  it("records each saved company change in Cloud's audit, in the admin's own company", async () => {
    const audit = new LocalCloudAuditStore(undefined, {});
    const w = world({ audit });
    const ada = await w.signIn("ada", 10);
    await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: tightened() });
    await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...tightened(), budgets: { companyMonthlyUsdMicros: 1, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    const made = await w.call(ada, "POST", "/org/invites/reviewed", { requestId: randomUUID(), role: "member", email: "a@example.com" });
    const inviteId = ReviewedInviteCreateResponseSchema.parse(made.body).receipt.inviteId;
    await w.call(ada, "POST", `/org/invites/${inviteId}/revoke`, { requestId: randomUUID(), expectedRevision: 0 });
    // A change waiting for a second admin is not yet a change.
    await w.call(ada, "PUT", "/org/settings", { expectedVersion: 2, settings: defaultCompanySettings() });
    const { rows } = await audit.read(A, { max: 50 });
    expect(rows.map((row) => row.action).sort()).toEqual(["company.budget.changed", "company.invite.created", "company.invite.revoked", "company.rules.changed"]);
    expect(rows.every((row) => row.actor.developerId === PEOPLE.ada!.developerId && row.via === "web" && JSON.stringify(row).indexOf("a@example.com") === -1)).toBe(true);
    expect((await audit.read(B, { max: 50 })).rows).toEqual([]);
  });
});

describe("which company", () => {
  it("uses the deployment's one company only when Code names none, and never when Code names a company that does not read", async () => {
    const single = world({ deploymentCompany: A });
    const solo = await single.signIn("solo", 10);
    expect((await single.call(solo, "GET", "/org/settings")).body.companyId).toBe(A);
    const odd = await single.signIn("odd", 10);
    expect((await single.call(odd, "GET", "/org/settings")).body.error.code).toBe("FORBIDDEN");
    // Code names company B: B, whatever the deployment says.
    const dan = await single.signIn("dan", 10);
    expect((await single.call(dan, "GET", "/org/settings")).body.companyId).toBe(B);
    const none = world();
    const soloNone = await none.signIn("solo", 10);
    expect((await none.call(soloNone, "GET", "/org/settings")).body).toEqual({ error: { code: "FORBIDDEN", message: "Your sign-in doesn't belong to a company Cloud knows." } });
    const badDeployment = world({ deploymentCompany: "rovara" });
    const soloBad = await badDeployment.signIn("solo", 10);
    expect((await badDeployment.call(soloBad, "GET", "/org/settings")).status).toBe(403);
  });

  it("leaves members, roles and removal on Code: those routes still answer 501", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    for (const [method, path] of [["GET", "/org/members"], ["PUT", `/org/members/${"b".repeat(64)}/role`], ["POST", `/org/members/${"b".repeat(64)}/removal`]] as const) {
      expect((await w.call(ada, method, path, method === "GET" ? undefined : {})).body.error.code).toBe("NOT_ON_CODE_YET");
    }
  });

  it("serves no company routes on a Cloud without company data", async () => {
    const sessions = new LocalSessionStore(undefined, { environment: {} });
    const handler = createCloudHandler({
      client: new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "s", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: async () => new Response("{}") }),
      store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN, log: () => undefined,
    });
    await sessions.create("c", { accessToken: "t", access: { developerId: "a".repeat(64), displayName: "A", administrator: true, projects: [], notices: [] }, csrf: "x", signedInAt: new Date().toISOString() });
    const answer = await handler({ method: "GET", path: "/v1/web/org/settings", query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=c" } });
    expect(answer!.status).toBe(501);
  });
});

describe("budgets and profile", () => {
  it("reads the budgets as the app's Budgets screen does", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    const before = await w.call(ada, "GET", "/org/budget-settings");
    expect(AdminBudgetSettingsSchema.parse(before.body)).toMatchObject({ orgId: A, orgMonthly: { kind: "unlimited", source: "unset" } });
    await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: 50_000_000, projectMonthlyUsdMicros: null, taskUsdMicros: null } } });
    expect(AdminBudgetSettingsSchema.parse((await w.call(ada, "GET", "/org/budget-settings")).body)).toMatchObject({
      orgMonthly: { kind: "limited", microdollars: 500_000_000, source: "configured" }, memberDefaultMonthly: { kind: "limited", microdollars: 50_000_000 },
    });
    // Raising a cap is loosening.
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), budgets: { companyMonthlyUsdMicros: 600_000_000, memberMonthlyUsdMicros: 50_000_000, projectMonthlyUsdMicros: null, taskUsdMicros: null } } })).status).toBe(202);
  });

  it("holds clearing or raising any budget cap for a second admin, under the rules in force", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    const bea = await w.signIn("bea", 10);
    const capped = { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: 50_000_000, projectMonthlyUsdMicros: 20_000_000, taskUsdMicros: 5_000_000 };
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), budgets: capped } })).status).toBe(200);
    for (const name of ["companyMonthlyUsdMicros", "memberMonthlyUsdMicros", "projectMonthlyUsdMicros", "taskUsdMicros"] as const) {
      for (const value of [null, capped[name] + 1]) {
        const answer = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), budgets: { ...capped, [name]: value } } });
        expect(answer.status, `${name} -> ${String(value)}`).toBe(202);
        expect(await w.call(ada, "POST", `/org/settings/pending/${answer.body.pending.changeId}/withdraw`, {})).toMatchObject({ status: 200 });
      }
    }
    expect((await w.store.settings(A))!.version).toBe(1);
    // Lowering a cap is tightening: straight away.
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), budgets: { ...capped, taskUsdMicros: 1 } } })).status).toBe(200);
    // Clearing the company cap, once a second admin approves, leaves the gateway not ready.
    const clear = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 2, settings: { ...defaultCompanySettings(), budgets: { ...capped, taskUsdMicros: 1, companyMonthlyUsdMicros: null } } });
    expect((await w.call(bea, "POST", `/org/settings/pending/${clear.body.pending.changeId}/approve`, {})).status).toBe(200);
    expect((await w.call(ada, "GET", "/org/settings")).body.modelGateway).toEqual({ ready: false, reason: "company_monthly_cap_unset", message: "Set a monthly cap to use the model gateway." });
  });

  it("keeps a learning cap of $20 by default; raising it needs a second admin, lowering it does not, and it never passes the company cap", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    const bea = await w.signIn("bea", 10);
    expect((await w.call(ada, "GET", "/org/settings")).body.settings.budgets.learningMonthlyUsdMicros).toBe(20_000_000);
    const capped = { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null };
    // A client that does not know the field (the older app) saves the default.
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), budgets: capped } })).status).toBe(200);
    expect((await w.store.settings(A))!.settings.budgets.learningMonthlyUsdMicros).toBe(20_000_000);
    // Raising it: held for a different admin, then it applies.
    const raise = await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), budgets: { ...capped, learningMonthlyUsdMicros: 20_000_001 } } });
    expect(raise.status).toBe(202);
    expect((await w.store.settings(A))!.settings.budgets.learningMonthlyUsdMicros).toBe(20_000_000);
    expect((await w.call(bea, "POST", `/org/settings/pending/${raise.body.pending.changeId}/approve`, {})).status).toBe(200);
    expect((await w.store.settings(A))!.settings.budgets.learningMonthlyUsdMicros).toBe(20_000_001);
    // Lowering it: straight away. Above the company cap: refused, whoever asks.
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 2, settings: { ...defaultCompanySettings(), budgets: { ...capped, learningMonthlyUsdMicros: 1_000 } } })).status).toBe(200);
    expect((await w.call(ada, "PUT", "/org/settings", { expectedVersion: 3, settings: { ...defaultCompanySettings(), budgets: { ...capped, learningMonthlyUsdMicros: 500_000_001 } } })).status).toBe(400);
  });

  it("says the model gateway is ready only once a company monthly cap is set, with no default amount", async () => {
    const w = world();
    const ada = await w.signIn("ada", 10);
    expect((await w.call(ada, "GET", "/org/settings")).body.modelGateway).toMatchObject({ ready: false, reason: "company_monthly_cap_unset" });
    expect(defaultCompanySettings().budgets.companyMonthlyUsdMicros).toBeNull();
    // Other caps alone don't make it ready.
    await w.call(ada, "PUT", "/org/settings", { expectedVersion: 0, settings: { ...defaultCompanySettings(), budgets: { companyMonthlyUsdMicros: null, memberMonthlyUsdMicros: 1, projectMonthlyUsdMicros: 1, taskUsdMicros: 1 } } });
    expect((await w.call(ada, "GET", "/org/settings")).body.modelGateway).toMatchObject({ ready: false });
    await w.call(ada, "PUT", "/org/settings", { expectedVersion: 1, settings: { ...defaultCompanySettings(), budgets: { companyMonthlyUsdMicros: 0, memberMonthlyUsdMicros: 1, projectMonthlyUsdMicros: 1, taskUsdMicros: 1 } } });
    expect((await w.call(ada, "GET", "/org/settings")).body.modelGateway).toEqual({ ready: true });
  });

  it("shows the profile to the company's people and lets an admin rename it", async () => {
    const w = world();
    const cal = await w.signIn("cal");
    expect((await w.call(cal, "GET", "/org/profile")).body).toEqual({ orgId: A, name: "Rovara", plan: "cloud", version: 0 });
    expect((await w.call(cal, "PATCH", "/org", { requestId: randomUUID(), name: "Acme" })).status).toBe(403);
    const ada = await w.signIn("ada");
    const renamed = await w.call(ada, "PATCH", "/org", { requestId: randomUUID(), name: "  Acme \t Corp " });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(RenameOrganizationResponseSchema.parse(renamed.body)).toEqual({ org: { orgId: A, name: "Acme Corp", plan: "cloud" }, role: "owner" });
    expect((await w.call(cal, "GET", "/org/profile")).body).toMatchObject({ name: "Acme Corp", version: 1 });
    const dan = await w.signIn("dan");
    expect((await w.call(dan, "GET", "/org/profile")).body.name).toBe("Rovara");
    expect((await w.call(ada, "PATCH", "/org", { requestId: randomUUID(), name: "‮evil" })).status).toBe(400);
    expect((await w.call(ada, "PATCH", "/org", { requestId: randomUUID(), name: "x".repeat(81) })).status).toBe(400);
  });
});

describe("invites", () => {
  const create = (w: ReturnType<typeof world>, as: { cookie: string }, role: "admin" | "member", email: string, requestId = randomUUID()) =>
    w.call(as, "POST", "/org/invites/reviewed", { requestId, role, email });

  it("answers 501 while Code doesn't take pre-approved emails, and keeps nothing", async () => {
    const w = world({ codeHasPreApprovals: false });
    const ada = await w.signIn("ada", 10);
    expect(await create(w, ada, "member", "new@example.com")).toEqual({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Company invites aren't connected to Rovara Code yet." } } });
    expect((await w.store.invites(A)).invites).toEqual([]);
    expect((await w.call(ada, "GET", "/org/invites")).body.invites).toEqual([]);
  });

  it("tells Code first, as the admin, then shows the invite masked, only to its company", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const requestId = randomUUID();
    const made = await create(w, ada, "member", " New.Person@Example.com ", requestId);
    expect(made.status).toBe(200);
    const parsed = ReviewedInviteCreateResponseSchema.parse(made.body);
    expect(parsed.receipt).toMatchObject({ orgId: A, requestId, role: "member" });
    expect(parsed.inviteUrl).toMatch(/^https:\/\/cloud\.example\.test\/app\/join#invite=[A-Za-z0-9_-]{43}$/u);
    // Told as the inviting admin, with the admin's own token.
    expect(w.preApproved).toEqual([{ token: `Bearer ${ada.token}`, emails: ["new.person@example.com"] }]);
    const list = AppOrgInvitesResponseSchema.parse((await w.call(ada, "GET", "/org/invites")).body);
    expect(list.invites).toHaveLength(1);
    expect(list.invites[0]).toMatchObject({ inviteId: parsed.receipt.inviteId, role: "member", destination: { kind: "email", label: "n***@example.com" } });
    expect(JSON.stringify(list)).not.toContain("new.person");
    expect(AppOrgInviteStatusSchema.parse((await w.call(ada, "GET", `/org/invites/${parsed.receipt.inviteId}`)).body)).toMatchObject({ status: "pending", revision: 0 });
    expect((await w.call(ada, "GET", `/org/invites/requests/${requestId}`)).body).toEqual({ receipt: parsed.receipt });
    // A replay of the same request makes no second invite.
    expect((await create(w, ada, "member", "new.person@example.com", requestId)).status).toBe(409);
    // Another company sees none of it.
    const dan = await w.signIn("dan");
    expect((await w.call(dan, "GET", "/org/invites")).body.invites).toEqual([]);
    expect((await w.call(dan, "GET", `/org/invites/${parsed.receipt.inviteId}`)).status).toBe(404);
    expect((await w.call(dan, "GET", `/org/invites/requests/${requestId}`)).status).toBe(404);
    expect((await w.call(dan, "POST", `/org/invites/${parsed.receipt.inviteId}/revoke`, { requestId: randomUUID(), expectedRevision: 0 })).status).toBe(404);
    // A member can't invite or list.
    const cal = await w.signIn("cal");
    expect((await create(w, cal, "member", "x@example.com")).status).toBe(403);
    expect((await w.call(cal, "GET", "/org/invites")).status).toBe(403);
  });

  it("needs a fresh step-up to invite an admin, and an email for every invite", async () => {
    const w = world();
    const stale = await w.signIn("ada", 900);
    expect((await create(w, stale, "admin", "boss@example.com")).body.error.code).toBe("STEP_UP_REQUIRED");
    expect(w.preApproved).toEqual([]);
    expect((await create(w, stale, "member", "fine@example.com")).status).toBe(200);
    const fresh = await w.signIn("ada", 10);
    expect((await create(w, fresh, "admin", "boss@example.com")).status).toBe(200);
    expect(w.preApproved.at(-1)!.emails).toEqual(["boss@example.com", "fine@example.com"]);
    expect((await w.call(fresh, "POST", "/org/invites/reviewed", { requestId: randomUUID(), role: "member" })).status).toBe(400);
    expect((await w.call(fresh, "POST", "/org/invites/reviewed", { requestId: randomUUID(), role: "member", email: "two@a.com,three@b.com" })).status).toBe(400);
    expect(OrganizationInviteResponseSchema.parse((await w.call(fresh, "POST", "/org/invites", { requestId: randomUUID(), role: "member", email: "onboard@example.com" })).body).inviteUrl).toContain("#invite=");
  });

  it("is accepted once, by a person Code put in the invite's company", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const url = ReviewedInviteCreateResponseSchema.parse((await create(w, ada, "member", "cal@example.com")).body).inviteUrl!;
    const token = url.split("#invite=")[1]!;
    const eve = await w.signIn("eve");
    expect((await w.call(eve, "POST", "/org/invites/accept", { invite: token })).status).toBe(404);
    const cal = await w.signIn("cal");
    expect((await w.call(cal, "POST", "/org/invites/accept", { invite: "x".repeat(43) })).status).toBe(404);
    const accepted = await w.call(cal, "POST", "/org/invites/accept", { invite: token });
    expect(accepted).toMatchObject({ status: 200, body: { accepted: true, orgId: A } });
    expect((await w.call(cal, "POST", "/org/invites/accept", { invite: token })).status).toBe(404);
    const inviteId = accepted.body.inviteId as string;
    expect((await w.call(ada, "GET", `/org/invites/${inviteId}`)).body).toMatchObject({ status: "accepted" });
    // The next update to Code leaves it out.
    await create(w, ada, "member", "later@example.com");
    expect(w.preApproved.at(-1)!.emails).toEqual(["later@example.com"]);
  });

  it("can't be accepted once expired", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const token = ReviewedInviteCreateResponseSchema.parse((await create(w, ada, "member", "cal@example.com")).body).inviteUrl!.split("#invite=")[1]!;
    w.advance(7 * 86_400_000);
    const cal = await w.signIn("cal");
    expect((await w.call(cal, "POST", "/org/invites/accept", { invite: token })).status).toBe(404);
    const later = await w.signIn("ada");
    expect((await w.call(later, "GET", "/org/invites")).body.invites).toEqual([]);
  });

  it("is withdrawn only after Code drops the pre-approval", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const keep = ReviewedInviteCreateResponseSchema.parse((await create(w, ada, "member", "keep@example.com")).body).receipt;
    const drop = ReviewedInviteCreateResponseSchema.parse((await create(w, ada, "member", "drop@example.com")).body).receipt;
    w.setCode({ preApprovals: false });
    expect((await w.call(ada, "POST", `/org/invites/${drop.inviteId}/revoke`, { requestId: randomUUID(), expectedRevision: 0 })).status).toBe(501);
    expect((await w.call(ada, "GET", `/org/invites/${drop.inviteId}`)).body).toMatchObject({ status: "pending", revision: 0 });
    w.setCode({ preApprovals: true, fails: true });
    expect((await w.call(ada, "POST", `/org/invites/${drop.inviteId}/revoke`, { requestId: randomUUID(), expectedRevision: 0 })).status).toBe(503);
    expect((await w.call(ada, "GET", `/org/invites/${drop.inviteId}`)).body).toMatchObject({ status: "pending", revision: 0 });
    w.setCode({ fails: false });
    expect((await w.call(ada, "POST", `/org/invites/${drop.inviteId}/revoke`, { requestId: randomUUID(), expectedRevision: 5 })).status).toBe(409);
    const revoked = await w.call(ada, "POST", `/org/invites/${drop.inviteId}/revoke`, { requestId: randomUUID(), expectedRevision: 0 });
    expect(RevokeOrganizationInviteResponseSchema.parse(revoked.body)).toMatchObject({ inviteId: drop.inviteId, revision: 1 });
    expect(w.preApproved.at(-1)!.emails).toEqual(["keep@example.com"]);
    expect(AppOrgInviteStatusSchema.parse((await w.call(ada, "GET", `/org/invites/${drop.inviteId}`)).body)).toMatchObject({ status: "revoked" });
    expect((await w.call(ada, "GET", "/org/invites")).body.invites.map((each) => each.inviteId)).toEqual([keep.inviteId]);
    const cal = await w.signIn("cal");
    // A withdrawn invite's link does nothing.
    expect((await w.call(cal, "POST", "/org/invites/accept", { invite: "y".repeat(43) })).status).toBe(404);
  });

  it("hides an invite Code hasn't confirmed: no status, no receipt", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const inviteId = "00000000-0000-4000-8000-0000000000aa", requestId = "00000000-0000-4000-8000-0000000000bb";
    await w.store.createInvite({
      companyId: A, inviteId, requestId, role: "member", email: "half@example.com", tokenHash: "0".repeat(64), createdBy: PEOPLE.ada!.developerId,
      createdAt: new Date(w.now()).toISOString(), expiresAt: new Date(w.now() + 86_400_000).toISOString(), state: "unconfirmed", revision: 0,
    });
    expect((await w.call(ada, "GET", `/org/invites/${inviteId}`)).status).toBe(404);
    expect((await w.call(ada, "GET", `/org/invites/requests/${requestId}`)).status).toBe(404);
    expect((await w.call(ada, "POST", `/org/invites/${inviteId}/revoke`, { requestId: randomUUID(), expectedRevision: 0 })).status).toBe(404);
    expect((await w.call(ada, "GET", "/org/invites")).body.invites).toEqual([]);
  });

  it("never sends Code a list built from part of the invites", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const store = w.store as LocalCompanyStore;
    const real = store.invites.bind(store);
    store.invites = async (companyId: string) => ({ ...(await real(companyId)), partial: true });
    expect((await create(w, ada, "member", "x@example.com")).body.error.code).toBe("RUNTIME_UNAVAILABLE");
    expect(w.preApproved).toEqual([]);
    expect((await real(A)).invites).toEqual([]);
  });

  it("takes back an invite Code refused, so it is never shown or sent again", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    w.setCode({ fails: true });
    expect((await create(w, ada, "member", "gone@example.com")).status).toBe(503);
    w.setCode({ fails: false });
    expect((await w.store.invites(A)).invites).toEqual([]);
    await create(w, ada, "member", "next@example.com");
    expect(w.preApproved.at(-1)!.emails).toEqual(["next@example.com"]);
  });
});

describe("the step-up sign-in", () => {
  it("asks Code for a step-up only when the app asks for one", async () => {
    const w = world();
    const plain = await w.handler({ method: "GET", path: "/v1/auth/browser/authorize", query: new URLSearchParams("return_to=/app"), headers: {} });
    expect(new URL(plain!.headers.location!).searchParams.get("acr_values")).toBeNull();
    const stepUp = await w.handler({ method: "GET", path: "/v1/auth/browser/authorize", query: new URLSearchParams("return_to=/app&step_up=1"), headers: {} });
    expect(new URL(stepUp!.headers.location!).searchParams.get("acr_values")).toBe("step-up");
  });
});

describe("the policy hook on the same store", () => {
  const installKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const hookKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = installKey.publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const ISSUER = "https://code.example.test/v1/auth";
  const question = (cid: string, at: number) => {
    const iat = Math.floor(at / 1000);
    const input = `${b64({ alg: "RS256", typ: "rovara-policy-question+jwt", kid: "install-1" })}.${b64({ v: 1, iss: ISSUER, rid: randomUUID(), iat, exp: iat + 360, kind: "values", q: { cid } })}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), installKey.privateKey).toString("base64url")}`;
  };

  it("answers an allow-listed install about its own companies from the saved settings, and refuses the rest", async () => {
    const w = world();
    // A lock change counts as loosening, so it is seeded here as an approved change would leave it.
    await w.store.putSettings(A, { ...defaultCompanySettings(), locks: { extra_review: true, ci_fix_rounds: 1 } }, 0, "seed", new Date(w.now()).toISOString());
    const route = createPolicyHookRoute({
      signer: { kid: async () => "hook-1", sign: async (input) => sign("RSA-SHA256", input, hookKey.privateKey) },
      installs: new StoreHookInstalls(w.store), rules: new StoreCompanyRules(w.store), audit: new LocalCloudAuditStore(undefined, {}), now: w.now, log: () => undefined,
    });
    const ask = async (cid: string) => route({ method: "POST", path: POLICY_HOOK_PATH, query: new URLSearchParams(), headers: { "content-type": "application/jose" }, body: question(cid, w.now()) });
    // Not on the allow-list yet: refused.
    expect((await ask(A)).status).toBe(401);
    await w.store.putHookInstall({ issuer: ISSUER, keys: [{ kty: "RSA", n: exported.n, e: exported.e, kid: "install-1" }], companyIds: [A], updatedAt: new Date(w.now()).toISOString() });
    const answer = await ask(A);
    expect(answer.status).toBe(200);
    const claims = JSON.parse(Buffer.from(answer.body.split(".")[1]!, "base64url").toString()) as { a: unknown };
    expect(claims.a).toEqual({ locks: { extra_review: true, ci_fix_rounds: 1 } });
    // Company B is not this install's to ask about.
    expect((await ask(B)).status).toBe(401);
  });
});
