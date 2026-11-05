// Design review (DR-FU4): the company's design review policy (allowed, default mode, lock) on the DESIGNREVIEW#LOCK item, who may change it, the switch that reads it, and the one-time move of the old `dp` list into it.
// A project runs design review only when `dr` is on AND the company allows it AND the project's effective mode (its own setting, or the company's default, held to the lock) is not Off.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_REVIEW_DEFAULT_SETTING, WORKSPACE_PROJECT_INDEX, agentXError, orgMetaKey, projectMetaKey, projectPlaybookKey, workspaceProjectIndexValue, type OrgId } from "../../packages/contracts/src/index.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { DESIGN_REVIEW_LOCK_SK, DesignReviewLockSchema, readDesignReviewCompany, type DesignReviewLock } from "../../packages/broker/src/design-review/lock.js";
import { designReviewAvailableFor, designReviewEnabledFor, designReviewStillOn } from "../../packages/broker/src/design-review/switch.js";
import { DESIGN_REVIEW_CHANGE_TTL_MS, DESIGN_REVIEW_DP_MIGRATION_SK, approveDesignReviewChange, cancelDesignReviewChange, lockLoosens, requestDesignReviewAllowed, saveDesignReviewCompany, type DesignReviewCompanyDeps } from "../../packages/broker/src/design-review/company.js";
import { designDpMigrationOf, projectHadDesignReviewOf } from "../../packages/broker/src/design-review/wait-wiring.js";
import { MODEL_SOURCES_DIRECTORY_PK } from "../../packages/broker/src/model-sources/store.js";
import { migrateDesignReviewOrg, runDesignReviewDpMigration, type DpMigrationPorts } from "../../packages/broker/src/design-review/dp-migration.js";
import { readProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { seedDesignReviewCompany, type CompanyPolicySeed } from "../support/design-review-company.js";
import { TEST_ORG } from "../support/orgs.js";
import { setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

afterEach(() => { vi.unstubAllEnvs(); });
const PATH = "/v1/app/org/design-review";
const ORG = TEST_ORG;
const dr = (value = "1") => vi.stubEnv("DESIGN_REVIEW_ENABLED", value);

async function bench(options: { maya?: "admin" | "member" | "maintainer" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya === "maintainer") await t.person(MAYA, "member", "maintainer");
  else if (options.maya !== undefined) await t.person(MAYA, options.maya);
  return { t, audit };
}
const events = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => event.action.startsWith("company.design_review_policy_"));
const get = (t: Bench, who = OMAR) => t.web(who, "GET", PATH);
const setProject = (t: Bench, mode: string | undefined, extra: Record<string, unknown> = {}) => { if (mode !== undefined) t.db.set({ ...projectPlaybookKey(ORG, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAYA.developerId, ...own(mode, extra) }); };
const own = (mode: string, extra: Record<string, unknown> = {}) => ({ revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode, tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" }, ...extra } });

describe("the card's route", () => {
  it("is not found while `dr` is off (any value but exactly 1): GET and POST, as any unknown path", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) vi.unstubAllEnvs(); else dr(value);
      expect((await get(t)).status, String(value)).toBe(404);
      expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { allowSkip: false } })).status, String(value)).toBe(404);
    }
  });

  it("is for company owners and admins only, on GET and POST: a member, a project maintainer and a token are refused, and nothing is written or audited", async () => {
    const { t, audit } = await bench({ maya: "maintainer" });
    dr();
    expect(await get(t)).toMatchObject({ status: 200, body: { revision: 0, allowed: false, lock: {}, unreadable: false } });
    expect((await get(t)).body).not.toHaveProperty("defaultMode");
    for (const body of [{ action: "save", expectedRevision: 0, lock: { allowSkip: false } }, { action: "allow", expectedRevision: 0, allowed: true }, { action: "approve", changeId: "abc" }]) {
      const maintainer = await t.web(MAYA, "POST", PATH, body);
      expect(maintainer.status, JSON.stringify(body)).toBe(403);
      expect(JSON.stringify(maintainer.body)).toContain("Only a company owner or admin");
      const token = await t.dev(OMAR, "POST", PATH, body);
      expect(token.status, JSON.stringify(body)).toBe(403);
      expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    }
    expect((await get(t, MAYA)).status).toBe(403);
    await t.person(MAYA, "member");
    expect((await t.web(MAYA, "POST", PATH, { action: "save", expectedRevision: 0, lock: { allowSkip: false } })).status).toBe(403);
    expect(await get(t)).toMatchObject({ body: { revision: 0, lock: {} } });
    expect(events(audit)).toEqual([]);
  });

  it("another company's item is never read: a second company starts from the defaults whatever the first one set", async () => {
    const { t } = await bench();
    dr();
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { allowSkip: false } })).status).toBe(200);
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, "org_zzzzzzzzzzzzzzzzzzzz")).lock).toEqual({ kind: "none" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).lock).toMatchObject({ kind: "lock", lock: { allowSkip: false } });
  });

  it("saves a lock that only tightens at once, audited with fixed words, on the revision read; a stale revision is POLICY_STALE and changes nothing", async () => {
    const { t, audit } = await bench();
    dr();
    const saved = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } });
    expect(saved, JSON.stringify(saved.body)).toMatchObject({ status: 200, body: { status: "applied", revision: 1, allowed: false, lock: { tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } } });
    expect(events(audit).map((event) => event.facts)).toEqual([{ field: "lock", from: "0", to: "3", mode: "direct", revision: 1 }]);
    expect(events(audit)[0]).toMatchObject({ actor: { kind: "member", id: OMAR.developerId }, target: { kind: "org" } });
    const stale = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { allowSkip: false } });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain("POLICY_STALE");
    expect(await get(t)).toMatchObject({ body: { revision: 1, lock: { tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } } });
    // Nothing changed, so nothing is written or audited.
    const same = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, lock: { tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } });
    expect(same).toMatchObject({ status: 200, body: { revision: 1 } });
    expect(events(audit)).toHaveLength(1);
  });

  it("refuses a body that is not one of the actions, a lock value outside its range and a group lock where the edition has no groups, with field names only", async () => {
    const { t } = await bench();
    dr();
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, defaultMode: "auto", lock: {} })).status).toBe(400);
    // There is no company default mode and no mode floor: neither is a field of the card.
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { mode: "auto" } })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0 })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { capCeilingUsd: 1000 } })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { surprise: true } })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0 })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { approverGroupId: "leads" } })).status).toBe(400);
    expect(await get(t)).toMatchObject({ body: { revision: 0 } });
  });

  it("an item that cannot be read is said so and nothing can be changed over it", async () => {
    const { t } = await bench();
    dr();
    t.db.set({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", revision: 1, lock: { surprise: true }, policy: { allowed: true } });
    expect(await get(t)).toMatchObject({ status: 200, body: { unreadable: true } });
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, lock: { allowSkip: false } })).status).toBe(400);
  });

  it("an item written before the mode floor and the default mode were removed still reads: lock.mode and defaultMode are ignored, never shown and never written back", async () => {
    const { t } = await bench();
    dr();
    t.db.set({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", revision: 2, lock: { mode: "always", allowSkip: false }, policy: { allowed: true, defaultMode: "always" } });
    const read = await get(t);
    expect(read).toMatchObject({ status: 200, body: { revision: 2, allowed: true, lock: { allowSkip: false }, unreadable: false } });
    expect(read.body.lock).not.toHaveProperty("mode");
    expect(read.body).not.toHaveProperty("defaultMode");
    // A tightening writes the new item without either field.
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 2, lock: { allowSkip: false, capCeilingUsd: 6 } })).status).toBe(200);
    const stored = t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK }) as { lock: Record<string, unknown>; policy: Record<string, unknown> };
    expect(stored.lock).toEqual({ allowSkip: false, capCeilingUsd: 6 });
    expect(stored.policy).toEqual({ allowed: true });
  });
});

describe("DR-UI-2: a refused change is logged", () => {
  it("logs one line with the action and the error code, and no person id", async () => {
    const { t } = await bench({ maya: "admin" });
    dr();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
    t.ageSignIn(OMAR, 11);
    const old = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    expect(old.status).toBe(403);
    const refused = logs.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } }).filter((entry) => entry?.event === "developer.design_review_company_refused");
    expect(refused).toEqual([{ component: "broker", event: "developer.design_review_company_refused", orgId: ORG, action: "allow", code: "REAUTH_REQUIRED" }]);
    expect(JSON.stringify(refused)).not.toContain(OMAR.developerId);
    vi.restoreAllMocks();
  });
});

describe("allowing design review is a loosening", () => {
  it("with another admin it opens a request that changes nothing; the one who asked cannot confirm it; a different admin confirms it within 10 minutes of signing in; all of it audited", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    dr();
    const asked = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const changeId = (asked.body as { changeId: string }).changeId;
    expect(await get(t)).toMatchObject({ body: { allowed: false, pending: { changeId, proposedByYou: true } } });
    expect((await get(t, MAYA)).body).toMatchObject({ allowed: false, pending: { proposedByYou: false } });
    const self = await t.web(OMAR, "POST", PATH, { action: "approve", changeId });
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toContain("A different admin has to approve");
    expect((await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true })).status).toBe(409);
    t.ageSignIn(MAYA, 11);
    const old = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(old.status).toBe(403);
    expect(JSON.stringify(old.body)).toContain("REAUTH_REQUIRED");
    expect(await get(t)).toMatchObject({ body: { allowed: false } });
    t.ageSignIn(MAYA, 5);
    const approved = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { status: "applied", allowed: true } });
    expect(await get(t)).toMatchObject({ body: { allowed: true } });
    expect(events(audit).map((event) => [event.action, (event.facts as Record<string, unknown>).field, (event.facts as Record<string, unknown>).from, (event.facts as Record<string, unknown>).to, (event.facts as Record<string, unknown>).mode])).toEqual([
      ["company.design_review_policy_proposed", "allowed", "off", "on", undefined],
      ["company.design_review_policy_changed", "allowed", "off", "on", "second_person"],
    ]);
    expect(events(audit).at(-1)).toMatchObject({ actor: { id: MAYA.developerId } });
    // Approving the same request again changes nothing.
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(409);
  });

  it("a member cannot confirm, and not allowing applies at once (the stricter side), audited", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    dr();
    const asked = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    const changeId = (asked.body as { changeId: string }).changeId;
    await t.person(MAYA, "member");
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(403);
    await t.person(MAYA, "admin");
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(200);
    const revision = (await get(t)).body.revision as number;
    const off = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: revision, allowed: false });
    expect(off).toMatchObject({ status: 200, body: { status: "applied", allowed: false } });
    expect(events(audit).at(-1)).toMatchObject({ facts: { field: "allowed", from: "on", to: "off", mode: "direct" } });
  });

  it("the only owner of a company of one has nobody to ask: allowing it alone is the shared sole-owner exception, audited", async () => {
    const { t, audit } = await bench();
    dr();
    const reply = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    expect(reply, JSON.stringify(reply.body)).toMatchObject({ status: 200, body: { status: "applied", allowed: true, revision: 1 } });
    expect(events(audit)).toHaveLength(1);
    expect(events(audit)[0]).toMatchObject({ actor: { id: OMAR.developerId }, facts: { field: "allowed", from: "off", to: "on", mode: "sole_owner_exception", revision: 1 } });
  });

  it("needs the audit ledger: with none, allowing is refused and nothing changes (a loosening is never unaudited)", async () => {
    const t = await setupWizardBench({});
    dr();
    const reply = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    expect(reply.status).toBe(503);
    expect(await get(t)).toMatchObject({ body: { allowed: false, revision: 0 } });
  });

  it("the function refuses a person who is not an eligible admin, and a lost race is stale", async () => {
    const { t, audit } = await bench();
    const deps = (ids: string[]): DesignReviewCompanyDeps => ({
      documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit, authority: { eligibility: async () => ({ complete: true, membershipVersion: 1, ownerIds: ids.slice(0, 1), eligibleIds: ids, lastEligibleLossAtMs: null }) },
      actor: async (_org, by) => { if (!ids.includes(by)) throw agentXError("FORBIDDEN", "no"); return []; },
    });
    expect(await requestDesignReviewAllowed(deps(["someone-else"]), { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 0 })).toEqual({ ok: false, code: "not_eligible" });
    expect(await requestDesignReviewAllowed({ ...deps([OMAR.developerId]), authority: undefined }, { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 0 })).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect(await requestDesignReviewAllowed({ ...deps([OMAR.developerId]), actor: undefined }, { orgId: ORG, by: OMAR.developerId, allowed: false, expectedRevision: 0 })).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect(await requestDesignReviewAllowed(deps([OMAR.developerId]), { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 4 })).toEqual({ ok: false, code: "stale" });
    expect(await approveDesignReviewChange(deps([OMAR.developerId, "b"]), { orgId: ORG, changeId: "nope", approverId: "b" })).toEqual({ ok: false, code: "not_found" });
    expect(await saveDesignReviewCompany(deps([OMAR.developerId]), { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, lock: { surprise: 1 } as never })).toEqual({ ok: false, code: "invalid" });
    // The default mode and the lock need the same live authority as "allowed": a name the route's role check let through is still refused when the live records do not list it.
    expect(await saveDesignReviewCompany(deps(["someone-else"]), { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, lock: { allowSkip: false } })).toEqual({ ok: false, code: "not_eligible" });
    expect(await saveDesignReviewCompany({ ...deps([OMAR.developerId]), actor: undefined }, { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, lock: { allowSkip: false } })).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).lock).toEqual({ kind: "none" });
    expect(events(audit)).toEqual([]);
  });
});

describe("the switch: dr AND the company allows it AND the project is not Off", () => {
  const table = (t: Bench) => ({ documentClient: t.db, tableName: "state" });
  const cases: Array<{ name: string; dr: string | undefined; company: CompanyPolicySeed | null; project?: string; extra?: Record<string, unknown>; enabled: boolean }> = [
    { name: "dr off: nothing, even for a company that allows it and a project at Always", dr: "0", company: { allowed: true }, project: "always", enabled: false },
    { name: "dr unset", dr: undefined, company: { allowed: true }, enabled: false },
    { name: "dr on, the company has no policy", dr: "1", company: null, project: "always", enabled: false },
    { name: "the company has not allowed it: nothing, even if the project says Always", dr: "1", company: { allowed: false }, project: "always", enabled: false },
    { name: "allowed, the project has no setting: Off, nothing runs", dr: "1", company: { allowed: true }, enabled: false },
    { name: "allowed, the project says Off: nothing", dr: "1", company: { allowed: true }, project: "never", enabled: false },
    { name: "allowed, the project says Auto: it runs", dr: "1", company: { allowed: true }, project: "auto", enabled: true },
    { name: "allowed, the project says Always: it runs", dr: "1", company: { allowed: true }, project: "always", enabled: true },
    { name: "the company's rules never turn a project on: a project at Off stays Off under every lock field", dr: "1", company: { allowed: true, lock: { allowSkip: false, tierAtLeast: "thorough", capCeilingUsd: 2 } }, project: "never", enabled: false },
    { name: "the company's rules never turn off a project that chose Auto", dr: "1", company: { allowed: true, lock: { allowSkip: false, tierAtLeast: "thorough", capCeilingUsd: 2 } }, project: "auto", enabled: true },
    { name: "an old item whose lock still carries a mode floor does not turn an Off project on", dr: "1", company: { allowed: true, lock: { mode: "always" } as never }, project: "never", enabled: false },
    { name: "a lock that cannot be read runs the strictest posture, but only where the company allows it", dr: "1", company: { allowed: false, lock: { surprise: true } as DesignReviewLock }, project: "never", enabled: false },
  ];
  for (const entry of cases) {
    it(entry.name, async () => {
      const { t } = await bench();
      if (entry.dr === undefined) vi.unstubAllEnvs(); else dr(entry.dr);
      if (entry.company !== null) seedDesignReviewCompany(t.db, ORG, entry.company);
      setProject(t, entry.project, entry.extra);
      expect(await designReviewEnabledFor(table(t), ORG, "web")).toBe(entry.enabled);
    });
  }

  it("dr off: zero table reads, from every function the callers use", async () => {
    const { t } = await bench();
    seedDesignReviewCompany(t.db, ORG, { allowed: true });
    for (const value of ["0", "", "true"]) {
      dr(value);
      const send = vi.fn(async (command: unknown) => t.db.send(command as never));
      const client = { documentClient: { send } as never, tableName: "state" };
      expect(await designReviewEnabledFor(client, ORG, "web")).toBe(false);
      expect(await designReviewAvailableFor(client, ORG)).toBe(false);
      expect(await designReviewStillOn(client, ORG, "web", "person")).toBe(false);
      expect(await designReviewStillOn(client, ORG, "web", "auto")).toBe(false);
      expect(send, value).not.toHaveBeenCalled();
    }
  });

  it("dr on: the company is read first, and the project's playbook only when the company allows it", async () => {
    const { t } = await bench();
    dr();
    const reads = (client: { send: ReturnType<typeof vi.fn> }) => client.send.mock.calls.map(([command]) => JSON.stringify((command as { input?: unknown }).input ?? {}));
    const send = vi.fn(async (command: unknown) => t.db.send(command as never));
    const client = { documentClient: { send } as never, tableName: "state" };
    expect(await designReviewEnabledFor(client, ORG, "web")).toBe(false);
    expect(reads({ send })).toHaveLength(1);
    expect(reads({ send })[0]).toContain(DESIGN_REVIEW_LOCK_SK);
    send.mockClear();
    seedDesignReviewCompany(t.db, ORG, { allowed: true });
    setProject(t, "auto");
    expect(await designReviewEnabledFor(client, ORG, "web")).toBe(true);
    expect(reads({ send }).some((input) => input.includes("PLAYBOOK"))).toBe(true);
  });

  it("a review the person asked for goes on while design review is allowed, even in a project that is Off; any other review ends when the project is Off or the company stops allowing it (B2-m3)", async () => {
    const { t } = await bench();
    dr();
    seedDesignReviewCompany(t.db, ORG, { allowed: true });
    setProject(t, "auto");
    expect(await designReviewStillOn(table(t), ORG, "web", "auto")).toBe(true);
    setProject(t, "never");
    expect(await designReviewStillOn(table(t), ORG, "web", "auto")).toBe(false);
    expect(await designReviewStillOn(table(t), ORG, "web", "always")).toBe(false);
    expect(await designReviewStillOn(table(t), ORG, "web", "person")).toBe(true);
    setProject(t, "auto");
    expect(await designReviewStillOn(table(t), ORG, "web", "auto")).toBe(true);
    seedDesignReviewCompany(t.db, ORG, { allowed: false, revision: 2 });
    expect(await designReviewStillOn(table(t), ORG, "web", "auto")).toBe(false);
    expect(await designReviewStillOn(table(t), ORG, "web", "person")).toBe(false);
  });

  it("a read that fails is OFF (fail closed), never on", async () => {
    dr();
    const failing = { documentClient: { send: async () => { throw new Error("throttled"); } } as never, tableName: "state" };
    expect(await designReviewEnabledFor(failing, ORG, "web")).toBe(false);
    expect(await designReviewAvailableFor(failing, ORG)).toBe(false);
  });
});

describe("the one-time move of the old `dp` list into stored settings", () => {
  const ENV = { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "demo-tasklog" } as NodeJS.ProcessEnv;
  async function staging() {
    const made = await bench();
    const { t, audit } = made;
    t.db.set({ ...projectMetaKey(ORG, "demo-tasklog"), entityType: "PROJECT_META", name: "demo-tasklog", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    const base = { documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit };
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async (after) => (after === undefined ? [ORG] : []), installOrg: () => ORG, projectHadDesignReview: async () => false, now: Date.now, log: () => undefined };
    return { ...made, ports };
  }
  const playbookOf = (t: Bench, project = "demo-tasklog") => readProjectPlaybook({ documentClient: t.db, tableName: "state" }, ORG, project, { lenient: true });

  it("a project that ran design review through `dp` still runs it afterwards through stored settings; running it again changes nothing", async () => {
    const { t, audit, ports } = await staging();
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    // Before: the old release's world. Nothing stored; with `dp` gone from the gate the stage would be off.
    expect(await designReviewEnabledFor({ documentClient: t.db, tableName: "state" }, ORG, "demo-tasklog")).toBe(false);
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    const after = { company: (await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy, project: (await playbookOf(t)).designReview };
    expect(after.company).toEqual({ allowed: true });
    expect(after.project).toMatchObject({ mode: "auto", tier: "standard", allowSkip: true, capUsdPerTask: 10 });
    // The env no longer holds the list: dr alone, and the stored settings decide.
    expect(await designReviewEnabledFor({ documentClient: t.db, tableName: "state" }, ORG, "demo-tasklog", { DESIGN_REVIEW_ENABLED: "1" })).toBe(true);
    // Audited as the system.
    expect(events(audit)).toHaveLength(1);
    expect(events(audit)[0]).toMatchObject({ actor: { kind: "system" }, facts: { field: "allowed", from: "off", to: "on", mode: "migration" } });
    expect(audit.recordedBy("playbook.design_review_changed")).toHaveLength(1);
    expect(audit.recordedBy("playbook.design_review_changed")[0]).toMatchObject({ actor: { kind: "system" }, facts: { mode: "auto" } });
    // Idempotent: the same run (the walk marked done, then with the walk forgotten) writes nothing new.
    const snapshot = JSON.stringify([t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK }), t.db.get(projectPlaybookKey(ORG, "demo-tasklog")), t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_DP_MIGRATION_SK })]);
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    t.db.delete("DESIGN_REVIEW_DP_MIGRATION", "STATE");
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    expect(await migrateDesignReviewOrg(ports, ORG, ["demo-tasklog"])).toBe("ran");
    expect(JSON.stringify([t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK }), t.db.get(projectPlaybookKey(ORG, "demo-tasklog")), t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_DP_MIGRATION_SK })])).toBe(snapshot);
    expect(events(audit)).toHaveLength(1);
    expect(audit.recordedBy("playbook.design_review_changed")).toHaveLength(1);
  });

  it("never overrides an admin afterwards: allowed turned off, or a project set to Off, stays so when the move is run again", async () => {
    const { t, ports } = await staging();
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    await runDesignReviewDpMigration(ports, ENV);
    const current = await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG);
    seedDesignReviewCompany(t.db, ORG, { allowed: false, revision: (current.revision ?? 0) + 1 });
    t.db.delete("DESIGN_REVIEW_DP_MIGRATION", "STATE");
    await runDesignReviewDpMigration(ports, ENV);
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
  });

  it("leaves a project that already has a stored mode alone, still allows the company, and skips a name that is no project of the company", async () => {
    const { t, ports } = await staging();
    t.db.set({ ...projectPlaybookKey(ORG, "demo-tasklog"), entityType: "PROJECT_PLAYBOOK", orgId: ORG, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAYA.developerId, ...own("always") });
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    expect(await runDesignReviewDpMigration(ports, { ...ENV, DESIGN_REVIEW_PROJECTS: "demo-tasklog:ghost" })).toBe("done");
    expect((await playbookOf(t)).designReview).toMatchObject({ mode: "always" });
    expect(t.db.get(projectPlaybookKey(ORG, "ghost"))).toBeUndefined();
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(true);
    // Nothing named exists in a company: it is left exactly as it was.
    const other = await staging();
    expect(await migrateDesignReviewOrg(other.ports, ORG, ["ghost"])).toBe(0);
    expect((await readDesignReviewCompany({ documentClient: other.t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
  });

  it("reads nothing at all while `dr` is off or `dp` is empty or malformed", async () => {
    const { t, ports } = await staging();
    const send = vi.fn(async (command: unknown) => t.db.send(command as never));
    const counted: DpMigrationPorts = { ...ports, playbook: { ...(ports.playbook as object), documentClient: { send } } as never, company: { ...ports.company, documentClient: { send } } };
    for (const env of [{ DESIGN_REVIEW_ENABLED: "0", DESIGN_REVIEW_PROJECTS: "demo-tasklog" }, { DESIGN_REVIEW_ENABLED: "1" }, { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "Bad:Name" }, {}]) {
      expect(await runDesignReviewDpMigration(counted, env as NodeJS.ProcessEnv), JSON.stringify(env)).toBe("off");
    }
    expect(send).not.toHaveBeenCalled();
  });
});

// ---- the fix round (review DR-FU4-REVIEW.md) ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const HOUR = 3_600_000;

describe("H1: the sole-owner exception is the shared rule, not 'the only admin I can see'", () => {
  const demote = async (t: Bench, lostHoursAgo: number) => {
    await t.person(MAYA, "member");
    t.db.set({ ...(t.db.get(orgMetaKey(ORG)) as Record<string, unknown>), approvalLastCompanyEligibleLossAt: new Date(Date.now() - lostHoursAgo * HOUR).toISOString() });
  };

  it("demoting the other admin and then allowing is refused inside the 24-hour cool-off, with the time it opens; after it the only owner may", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    dr();
    await demote(t, 1);
    const refused = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("in the last 24 hours");
    expect(await get(t)).toMatchObject({ body: { allowed: false, revision: 0 } });
    expect(events(audit)).toEqual([]);
    // The same for a lock that loosens.
    t.db.set({ ...(t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK }) ?? {}), pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", revision: 1, lock: { allowSkip: false }, policy: { allowed: false, defaultMode: "never" } });
    const loosen = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, lock: {} });
    expect(loosen.status).toBe(403);
    expect(JSON.stringify(loosen.body)).toContain("in the last 24 hours");
    expect(await get(t)).toMatchObject({ body: { lock: { allowSkip: false } } });
    // 25 hours later nobody was lost in the last day: the only owner decides alone.
    t.db.set({ ...(t.db.get(orgMetaKey(ORG)) as Record<string, unknown>), approvalLastCompanyEligibleLossAt: new Date(Date.now() - 25 * HOUR).toISOString() });
    expect((await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 1, allowed: true })).status).toBe(200);
  });

  it("a sole admin who is not the owner cannot allow it alone, and no request is left behind for nobody to confirm", async () => {
    const { t } = await bench();
    dr();
    await t.person(OMAR, "admin");
    const refused = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("only the company owner can do it alone");
    expect(await get(t)).toMatchObject({ body: { allowed: false } });
    expect((await get(t)).body).not.toHaveProperty("pending");
  });
});

describe("H1: a lock change that loosens goes through the same flow as allowing; a tightening applies at once", () => {
  it("lockLoosens: removed or lowered fields, a raised ceiling, skipping allowed again and a changed group loosen; additions and tightenings do not", () => {
    expect(lockLoosens({}, { allowSkip: false, capCeilingUsd: 5, tierAtLeast: "standard" })).toBe(false);
    expect(lockLoosens({ capCeilingUsd: 8 }, { capCeilingUsd: 5 })).toBe(false);
    expect(lockLoosens({ tierAtLeast: "standard" }, { tierAtLeast: "thorough" })).toBe(false);
    expect(lockLoosens({ tierAtLeast: "thorough" }, { tierAtLeast: "standard" })).toBe(true);
    expect(lockLoosens({ tierAtLeast: "light" }, {})).toBe(true);
    expect(lockLoosens({ allowSkip: false }, {})).toBe(true);
    expect(lockLoosens({ capCeilingUsd: 5 }, { capCeilingUsd: 8 })).toBe(true);
    expect(lockLoosens({ capCeilingUsd: 5 }, {})).toBe(true);
    expect(lockLoosens({ approverGroupId: "a" }, { approverGroupId: "b" })).toBe(true);
    expect(lockLoosens({ approverGroupId: "a" }, {})).toBe(true);
    expect(lockLoosens({ allowSkip: false, capCeilingUsd: 5 }, { allowSkip: false, capCeilingUsd: 8 })).toBe(true);
    expect(lockLoosens({ tierAtLeast: "thorough", allowSkip: false }, { tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 3 })).toBe(true);
  });

  it("guard: every field of the lock schema is classified by lockLoosens, so a field added later cannot be loosened by one admin unseen", () => {
    // For each field, a value that appears (a tightening), and the same field removed (a loosening): a field `lockLoosens` does not know fails here, and so does one it treats as free.
    const sample: Record<string, unknown> = { tierAtLeast: "thorough", allowSkip: false, capCeilingUsd: 5, approverGroupId: "leads" };
    const fields = Object.keys(DesignReviewLockSchema.shape);
    expect(fields.sort()).toEqual(Object.keys(sample).sort());
    for (const field of fields) {
      const withField = { [field]: sample[field] } as DesignReviewLock;
      expect(lockLoosens({}, withField), `adding ${field}`).toBe(false);
      expect(lockLoosens(withField, {}), `removing ${field}`).toBe(true);
    }
    expect(DesignReviewLockSchema.shape).not.toHaveProperty("mode");
  });

  it("with another admin a loosening waits, a different admin confirms it, and a tightening needs nobody", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    dr();
    const tight = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { allowSkip: false, capCeilingUsd: 5 } });
    expect(tight, JSON.stringify(tight.body)).toMatchObject({ status: 200, body: { status: "applied", revision: 1, lock: { allowSkip: false, capCeilingUsd: 5 } } });
    const loose = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, lock: { allowSkip: false } });
    expect(loose, JSON.stringify(loose.body)).toMatchObject({ status: 202, body: { status: "needs_approval", lock: { allowSkip: false, capCeilingUsd: 5 }, pending: { kind: "lock", proposedByYou: true } } });
    const changeId = (loose.body as { changeId: string }).changeId;
    expect((await t.web(OMAR, "POST", PATH, { action: "approve", changeId })).status).toBe(403);
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(200);
    expect(await get(t)).toMatchObject({ body: { lock: { allowSkip: false } } });
    expect((await get(t)).body.lock).not.toHaveProperty("capCeilingUsd");
    expect(events(audit).map((event) => [event.action, (event.facts as Record<string, unknown>).field, (event.facts as Record<string, unknown>).mode])).toEqual([
      ["company.design_review_policy_changed", "lock", "direct"],
      ["company.design_review_policy_proposed", "lock", undefined],
      ["company.design_review_policy_changed", "lock", "second_person"],
    ]);
  });

  it("the only owner loosens alone (the shared exception); a loosening made by a member is refused before anything is read", async () => {
    const { t, audit } = await bench();
    dr();
    await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { capCeilingUsd: 5 } });
    const alone = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, lock: {} });
    expect(alone, JSON.stringify(alone.body)).toMatchObject({ status: 200, body: { status: "applied", lock: {} } });
    expect(events(audit).at(-1)).toMatchObject({ facts: { field: "lock", mode: "sole_owner_exception" } });
  });
});

describe("M1: the company's off switch and every tightening work without a complete roster", () => {
  it("a legacy company (no approval membership record) can tighten the lock and turn allowed off; allowing still needs the roster", async () => {
    const { t, audit } = await bench();
    dr();
    seedDesignReviewCompany(t.db, ORG, { allowed: true, revision: 1 });
    const { approvalMembershipVersion: _version, approvalTrackingSince: _since, ...legacy } = t.db.get(orgMetaKey(ORG)) as Record<string, unknown>;
    void _version; void _since;
    t.db.set(legacy);
    const mode = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, lock: { allowSkip: false } });
    expect(mode, JSON.stringify(mode.body)).toMatchObject({ status: 200, body: { lock: { allowSkip: false } } });
    const off = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 2, allowed: false });
    expect(off, JSON.stringify(off.body)).toMatchObject({ status: 200, body: { status: "applied", allowed: false } });
    expect(events(audit).map((event) => (event.facts as Record<string, unknown>).field)).toEqual(["lock", "allowed"]);
    // Allowing is a loosening and needs the complete roster: unavailable here, and nothing changes.
    const on = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 3, allowed: true });
    expect(on.status).toBe(503);
    expect(await get(t)).toMatchObject({ body: { allowed: false } });
  });

  it("still needs the caller's own live authority: a member, or someone who is not in the company, changes nothing", async () => {
    const { t } = await bench({ maya: "member" });
    dr();
    seedDesignReviewCompany(t.db, ORG, { allowed: true });
    const deps: DesignReviewCompanyDeps = { documentClient: t.db, tableName: "state", now: Date.now, actor: async () => { throw agentXError("FORBIDDEN", "no"); } };
    expect(await requestDesignReviewAllowed(deps, { orgId: ORG, by: MAYA.developerId, allowed: false, expectedRevision: 1 })).toEqual({ ok: false, code: "not_eligible" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(true);
  });
});

describe("M2: an unreadable lock while allowed is true means design review is NOT available", () => {
  it("is off, never Always: for the switch, the stage, the playbook answer and the first steps of a task; the card says it cannot read the settings", async () => {
    const { t } = await bench();
    dr();
    // A newer release added a lock field this broker does not know: the lock is unreadable, the policy still says allowed.
    t.db.set({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", revision: 3, lock: { allowSkip: false, futureField: true }, policy: { allowed: true } });
    const client = { documentClient: t.db, tableName: "state" };
    setProject(t, "never");
    expect(await designReviewEnabledFor(client, ORG, "web")).toBe(false);
    expect(await designReviewEnabledFor(client, ORG, "other-project")).toBe(false);
    expect(await designReviewAvailableFor(client, ORG)).toBe(false);
    expect(await designReviewStillOn(client, ORG, "web", "auto")).toBe(false);
    expect(await designReviewStillOn(client, ORG, "web", "person")).toBe(false);
    expect(await get(t)).toMatchObject({ body: { unreadable: true } });
  });
});

describe("M4: the one waiting request can be withdrawn, and turning allowed off withdraws it", () => {
  it("its proposer withdraws it (audited); a settled request cannot be confirmed; a new one can then be asked; a member cannot withdraw", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    dr();
    const asked = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    const changeId = (asked.body as { changeId: string }).changeId;
    // At most one waits at a time, whatever it is for.
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, lock: { allowSkip: false } })).status).toBe(200);
    expect((await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 1, allowed: true })).status).toBe(409);
    await t.person(MAYA, "member");
    expect((await t.web(MAYA, "POST", PATH, { action: "cancel", changeId })).status).toBe(403);
    await t.person(MAYA, "admin");
    const withdrawn = await t.web(OMAR, "POST", PATH, { action: "cancel", changeId });
    expect(withdrawn, JSON.stringify(withdrawn.body)).toMatchObject({ status: 200, body: { status: "applied" } });
    expect((await get(t)).body).not.toHaveProperty("pending");
    expect(events(audit).at(-1)).toMatchObject({ facts: { field: "allowed", from: "requested", to: "withdrawn", mode: "cancelled" } });
    const late = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(late.status).toBe(409);
    expect(await get(t)).toMatchObject({ body: { allowed: false } });
    expect((await t.web(OMAR, "POST", PATH, { action: "cancel", changeId })).status).toBe(404);
    expect((await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 1, allowed: true })).status).toBe(202);
  });

  it("turning allowed off clears the waiting request in the same step, even when it was never on", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    dr();
    const asked = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    const changeId = (asked.body as { changeId: string }).changeId;
    const off = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: false });
    expect(off, JSON.stringify(off.body)).toMatchObject({ status: 200, body: { status: "applied", allowed: false } });
    expect((await get(t)).body).not.toHaveProperty("pending");
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(409);
    expect(await get(t)).toMatchObject({ body: { allowed: false } });
    expect(events(audit).at(-1)).toMatchObject({ facts: { to: "withdrawn", mode: "cancelled" } });
  });
});

describe("the 7-day expiry", () => {
  it("a request can be confirmed up to 7 days after it was asked and not a moment later; an expired one can be asked again", async () => {
    const { t, audit } = await bench();
    const ids = [OMAR.developerId, MAYA.developerId];
    let clock = Date.now();
    const deps: DesignReviewCompanyDeps = {
      documentClient: t.db, tableName: "state", now: () => clock, audit: audit.audit,
      authority: { eligibility: async () => ({ complete: true, membershipVersion: 1, ownerIds: ids, eligibleIds: ids, lastEligibleLossAtMs: null }) },
      actor: async () => [],
    };
    const asked = await requestDesignReviewAllowed(deps, { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 0 });
    expect(asked).toMatchObject({ ok: true, status: "needs_approval" });
    const changeId = (asked as { changeId: string }).changeId;
    const start = clock;
    clock = start + DESIGN_REVIEW_CHANGE_TTL_MS;
    expect(await approveDesignReviewChange(deps, { orgId: ORG, changeId, approverId: MAYA.developerId })).toEqual({ ok: false, code: "expired" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
    // Expired, so a new request may be asked, and it is the one that waits now.
    const again = await requestDesignReviewAllowed(deps, { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 0 });
    expect(again).toMatchObject({ ok: true, status: "needs_approval" });
    expect((again as { changeId: string }).changeId).not.toBe(changeId);
    expect(await approveDesignReviewChange(deps, { orgId: ORG, changeId, approverId: MAYA.developerId })).toEqual({ ok: false, code: "not_found" });
    clock += DESIGN_REVIEW_CHANGE_TTL_MS - 1;
    expect(await approveDesignReviewChange(deps, { orgId: ORG, changeId: (again as { changeId: string }).changeId, approverId: MAYA.developerId })).toMatchObject({ ok: true, status: "applied" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(true);
    // The proposer withdrawing at the function level needs only their own authority.
    expect(await cancelDesignReviewChange(deps, { orgId: ORG, by: OMAR.developerId, changeId })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("H2: a bare project-name match never turns a company on", () => {
  async function twoCompanies() {
    const made = await bench();
    const { t, audit } = made;
    for (const org of [ORG, ORG_B]) t.db.set({ ...projectMetaKey(org, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    const base = { documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit };
    return { ...made, base };
  }
  const withReview = (t: Bench, org: OrgId, id: string) => {
    t.db.set({ pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE", id, orgId: org, [WORKSPACE_PROJECT_INDEX.partitionKey]: workspaceProjectIndexValue(org, "web"), [WORKSPACE_PROJECT_INDEX.sortKey]: "2026-10-20T00:00:00.000Z" });
    t.db.set({ ...taskPointerKey(id), entityType: "TASK_POINTER", taskId: `task-${id}` });
    t.db.set({ ...taskKey(`task-${id}`), entityType: "DEVELOPER_TASK", taskId: `task-${id}`, orgId: org, project: "web", workflow: { designReview: { status: "done", rounds: [] } } });
  };
  const policyOf = async (t: Bench, org: OrgId) => (await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, org)).policy.allowed;

  it("a single-tenant install moves only its own company, whatever other companies have a project of that name", async () => {
    const { t, base } = await twoCompanies();
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    const log: Array<Record<string, unknown>> = [];
    const listed: string[] = [];
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async () => { listed.push("walked"); return [ORG, ORG_B]; }, installOrg: () => ORG, projectHadDesignReview: async () => true, now: Date.now, log: (entry) => log.push(entry) };
    expect(await runDesignReviewDpMigration(ports, { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "web" })).toBe("done");
    expect(await policyOf(t, ORG)).toBe(true);
    expect(await policyOf(t, ORG_B)).toBe(false);
    expect((await readProjectPlaybook({ documentClient: t.db, tableName: "state" }, ORG, "web", { lenient: true })).designReview).toMatchObject({ mode: "auto" });
    expect(t.db.get(projectPlaybookKey(ORG_B, "web"))).toBeUndefined();
    expect(listed).toEqual([]);
  });

  it("with several companies, only the one where the project has a task that already carries a design review qualifies; the others are named in a log line and left untouched", async () => {
    const { t, base } = await twoCompanies();
    withReview(t, ORG_B, "wsb");
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    const log: Array<Record<string, unknown>> = [];
    const evidence = projectHadDesignReviewOf({ documentClient: t.db, tableName: "state" });
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async (after) => (after === undefined ? [ORG, ORG_B] : []), installOrg: () => undefined, projectHadDesignReview: evidence, now: Date.now, log: (entry) => log.push(entry) };
    expect(await runDesignReviewDpMigration(ports, { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "web" })).toBe("done");
    expect(await policyOf(t, ORG_B)).toBe(true);
    expect(await policyOf(t, ORG)).toBe(false);
    expect(t.db.get(projectPlaybookKey(ORG, "web"))).toBeUndefined();
    expect((await readProjectPlaybook({ documentClient: t.db, tableName: "state" }, ORG_B, "web", { lenient: true })).designReview).toMatchObject({ mode: "auto" });
    expect(log).toContainEqual({ event: "design_review.dp_migration_not_enabled", project: "web", reason: "no_design_review_task" });
  });

  it("the real evidence read: a task in another company, or in another project, is no proof for this one", async () => {
    const { t } = await twoCompanies();
    withReview(t, ORG_B, "wsb");
    const had = projectHadDesignReviewOf({ documentClient: t.db, tableName: "state" });
    expect(await had(ORG_B, "web")).toBe(true);
    expect(await had(ORG, "web")).toBe(false);
    expect(await had(ORG_B, "billing")).toBe(false);
    // A task whose record says another company is no proof either, whatever its workspace says.
    t.db.set({ ...taskKey("task-wsb"), entityType: "DEVELOPER_TASK", taskId: "task-wsb", orgId: ORG, project: "web", workflow: { designReview: { status: "done", rounds: [] } } });
    expect(await had(ORG_B, "web")).toBe(false);
  });
});

describe("M3: the move under a lock, a failure, and partial ticks", () => {
  const ENV = { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "web" } as NodeJS.ProcessEnv;
  async function staged(lock?: unknown) {
    const made = await bench();
    const { t, audit } = made;
    const base = { documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit };
    const log: Array<Record<string, unknown>> = [];
    if (lock !== undefined) t.db.set({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", revision: 2, lock, policy: { allowed: false } });
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async (after) => (after === undefined ? [ORG] : []), installOrg: () => ORG, projectHadDesignReview: async () => true, now: Date.now, log: (entry) => log.push(entry) };
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    return { ...made, base, ports, log };
  }
  const playbookWrites = (t: Bench) => t.db.transactions().filter((items) => JSON.stringify(items).includes("PROJECT_PLAYBOOK")).length;

  it("a lock that forbids the defaults does not refuse the move: the project is set to Auto held to the lock, and the company is recorded", async () => {
    const { t, ports } = await staged({ allowSkip: false, tierAtLeast: "thorough", capCeilingUsd: 5 });
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    expect((await readProjectPlaybook({ documentClient: t.db, tableName: "state" }, ORG, "web", { lenient: true })).designReview).toMatchObject({ mode: "auto", allowSkip: false, tier: "thorough", capUsdPerTask: 5 });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(true);
  });

  it("a write the company refuses is recorded as skipped once, logged with the project's name, and never tried again", async () => {
    // A group approver in an edition without groups cannot be written for the project.
    const { t, ports, log } = await staged({ approverGroupId: "leads" });
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    expect(log).toContainEqual({ event: "design_review.dp_migration_not_enabled", project: "web", reason: "refused" });
    expect(await migrateDesignReviewOrg(ports, ORG, ["web"])).toBe("ran");
    expect(t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_DP_MIGRATION_SK })).toMatchObject({ outcome: "skipped", reason: "refused" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
    const writes = playbookWrites(t);
    t.db.delete("DESIGN_REVIEW_DP_MIGRATION", "STATE");
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    expect(playbookWrites(t)).toBe(writes);
  });

  it("a transient fault is kept in the state and only that company is tried at the next tick", async () => {
    const { t, ports } = await staged();
    t.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("PROJECT_PLAYBOOK"), error: { name: "InternalServerError" }, times: 1 });
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("failed");
    expect(t.db.get("DESIGN_REVIEW_DP_MIGRATION", "STATE")).toMatchObject({ done: false, retry: [ORG] });
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    expect(t.db.get("DESIGN_REVIEW_DP_MIGRATION", "STATE")).toMatchObject({ done: true });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(true);
  });

  it("the progress of a time-limited tick is kept: the next tick goes on from the last company and does not start over", async () => {
    const { t, base, log } = await staged();
    const orgs = [ORG, ORG_B, "org_cccccccccccccccccccc" as OrgId];
    for (const org of orgs.slice(1)) t.db.set({ ...projectMetaKey(org, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    const seen: string[] = [];
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async (after) => orgs.filter((org) => after === undefined || org > after), installOrg: () => undefined, projectHadDesignReview: async (org) => { seen.push(org); return true; }, now: Date.now, log: (entry) => log.push(entry) };
    let ticks = 0;
    const clock = () => (ticks++ < 2 ? 0 : 10_000);
    expect(await runDesignReviewDpMigration(ports, ENV, { budgetMs: 5_000, clock })).toBe("partial");
    const first = [...seen];
    expect(first.length).toBeGreaterThan(0);
    expect(await runDesignReviewDpMigration(ports, ENV)).toBe("done");
    expect([...new Set(seen)].sort()).toEqual([...orgs].sort());
    expect(seen.filter((org) => org === first[0])).toHaveLength(1);
  });
});

describe("L2: an admin's choice made before the move reached the company stands", () => {
  it("a company an admin has already written (allowed off) is not switched on by the move; the record is written and the project is still moved", async () => {
    const { t, audit } = await bench();
    seedDesignReviewCompany(t.db, ORG, { allowed: false, revision: 4 });
    t.db.set({ ...(t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK }) as Record<string, unknown>), updatedBy: OMAR.developerId });
    t.db.set({ ...projectMetaKey(ORG, "demo-tasklog"), entityType: "PROJECT_META", name: "demo-tasklog", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    const base = { documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit };
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async () => [], installOrg: () => ORG, projectHadDesignReview: async () => false, now: Date.now, log: () => undefined };
    expect(await migrateDesignReviewOrg(ports, ORG, ["demo-tasklog"])).toBe(1);
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
    expect(t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_DP_MIGRATION_SK })).toMatchObject({ outcome: "moved" });
    expect(audit.recordedBy("playbook.default_process_changed")).toEqual([]);
  });
});

describe("R1: on a cloud install the evidence walk runs through the real wiring", () => {
  it("designDpMigrationOf with a cloud config: the company whose project already had a design review is moved, the company with only the same name is not, and both are named in the logs", async () => {
    const { t, audit } = await bench();
    for (const org of [ORG, ORG_B]) {
      t.db.set({ ...projectMetaKey(org, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
      t.db.set({ pk: MODEL_SOURCES_DIRECTORY_PK, sk: org, entityType: "MODEL_SOURCES_ORG", updatedAt: "2026-10-01T00:00:00.000Z" });
    }
    const id = "wsb";
    t.db.set({ pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE", id, orgId: ORG_B, [WORKSPACE_PROJECT_INDEX.partitionKey]: workspaceProjectIndexValue(ORG_B, "web"), [WORKSPACE_PROJECT_INDEX.sortKey]: "2026-10-20T00:00:00.000Z" });
    t.db.set({ ...taskPointerKey(id), entityType: "TASK_POINTER", taskId: `task-${id}` });
    t.db.set({ ...taskKey(`task-${id}`), entityType: "DEVELOPER_TASK", taskId: `task-${id}`, orgId: ORG_B, project: "web", workflow: { designReview: { status: "done", rounds: [] } } });
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    vi.stubEnv("DESIGN_REVIEW_PROJECTS", "web");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
    const cloud = { documentClient: t.db, tableName: "state", audit: audit.audit, cloud: true } as never;
    expect(await designDpMigrationOf(cloud)).toBe("done");
    spy.mockRestore();
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG_B)).policy.allowed).toBe(true);
    expect((await readProjectPlaybook({ documentClient: t.db, tableName: "state" }, ORG_B, "web", { lenient: true })).designReview).toMatchObject({ mode: "auto" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
    expect(t.db.get(projectPlaybookKey(ORG, "web"))).toBeUndefined();
    expect(logs.some((line) => line.includes("design_review.dp_migration_not_enabled") && line.includes('"project":"web"') && line.includes("no_design_review_task"))).toBe(true);
  });

  it("without the cloud flag the install's own company is the only one, and the directory is never walked", async () => {
    const { t, audit } = await bench();
    t.db.set({ ...projectMetaKey(ORG, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    t.db.set({ ...projectMetaKey(ORG_B, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    t.db.set({ pk: MODEL_SOURCES_DIRECTORY_PK, sk: ORG_B, entityType: "MODEL_SOURCES_ORG", updatedAt: "2026-10-01T00:00:00.000Z" });
    vi.stubEnv("AGENTX_ENV", "staging");
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    vi.stubEnv("DESIGN_REVIEW_PROJECTS", "web");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await designDpMigrationOf({ documentClient: t.db, tableName: "state", audit: audit.audit } as never)).toBe("done");
    vi.restoreAllMocks();
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(true);
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG_B)).policy.allowed).toBe(false);
  });

  it("the install's own company says so when it has none of the projects, and when nothing qualified (no silent return)", async () => {
    const { t, audit } = await bench();
    const base = { documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit };
    const log: Array<Record<string, unknown>> = [];
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async () => [], installOrg: () => ORG, projectHadDesignReview: async () => false, now: Date.now, log: (entry) => log.push(entry) };
    expect(await migrateDesignReviewOrg(ports, ORG, ["ghost"], "install")).toBe(0);
    expect(log).toEqual([{ event: "design_review.dp_migration_not_enabled", project: "ghost", reason: "no_such_project" }, { event: "design_review.dp_migration_nothing_qualified", projectCount: 1 }]);
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
  });
});

describe("R2: with several projects in dp, one refused project does not undo the others", () => {
  it("dp = a:b where b is refused: a keeps its stored Auto, the company is allowed so a keeps running, and b is logged by name", async () => {
    const { t, audit } = await bench();
    for (const name of ["alpha", "beta"]) t.db.set({ ...projectMetaKey(ORG, name), entityType: "PROJECT_META", name, status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    // A group approver in an edition without groups is refused for any project that has no setting yet; alpha already chose, beta did not.
    t.db.set({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_LOCK_SK, entityType: "DESIGN_REVIEW_COMPANY", revision: 2, lock: { approverGroupId: "leads" }, policy: { allowed: false } });
    t.db.set({ ...projectPlaybookKey(ORG, "alpha"), entityType: "PROJECT_PLAYBOOK", orgId: ORG, revision: 1, defaultProcess: { kind: "builtin" }, designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "auto" }, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAYA.developerId });
    const base = { documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit };
    const log: Array<Record<string, unknown>> = [];
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async () => [], installOrg: () => ORG, projectHadDesignReview: async () => true, now: Date.now, log: (entry) => log.push(entry) };
    expect(await migrateDesignReviewOrg(ports, ORG, ["alpha", "beta"], "install")).toBe(1);
    expect(log).toContainEqual({ event: "design_review.dp_migration_not_enabled", project: "beta", reason: "refused" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(true);
    expect(t.db.get(projectPlaybookKey(ORG, "beta"))).toBeUndefined();
    expect(t.db.get({ pk: orgMetaKey(ORG).pk, sk: DESIGN_REVIEW_DP_MIGRATION_SK })).toMatchObject({ outcome: "moved", projectCount: 1 });
  });
});

describe("R4: a lost race on an allow request is stale, not 'already open'", () => {
  it("the membership fence moving between the roster read and the commit answers stale", async () => {
    const { t, audit } = await bench();
    const ids = [OMAR.developerId, MAYA.developerId];
    const deps: DesignReviewCompanyDeps = {
      documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit, actor: async () => [],
      authority: { eligibility: async () => ({ complete: true, membershipVersion: 1, ownerIds: ids, eligibleIds: ids, lastEligibleLossAtMs: null, fence: [{ ConditionCheck: { TableName: "state", Key: { pk: "NO", sk: "SUCH" }, ConditionExpression: "attribute_exists(pk)" } }] }) },
    };
    expect(await requestDesignReviewAllowed(deps, { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 0 })).toEqual({ ok: false, code: "stale" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.allowed).toBe(false);
  });
});
