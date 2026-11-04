// Design review (DR-FU4): the company's design review policy (allowed, default mode, lock) on the DESIGNREVIEW#LOCK item, who may change it, the switch that reads it, and the one-time move of the old `dp` list into it.
// A project runs design review only when `dr` is on AND the company allows it AND the project's effective mode (its own setting, or the company's default, held to the lock) is not Off.
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgMetaKey, projectMetaKey, projectPlaybookKey } from "../../packages/contracts/src/index.js";
import { DESIGN_REVIEW_LOCK_SK, readDesignReviewCompany, type DesignReviewLock } from "../../packages/broker/src/design-review/lock.js";
import { designReviewAvailableFor, designReviewEnabledFor, designReviewStillOn } from "../../packages/broker/src/design-review/switch.js";
import { DESIGN_REVIEW_DP_MIGRATION_SK, approveDesignReviewAllowed, requestDesignReviewAllowed, saveDesignReviewCompany, type DesignReviewCompanyDeps } from "../../packages/broker/src/design-review/company.js";
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
const own = (mode: string, extra: Record<string, unknown> = {}) => ({ revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode, tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" }, ...extra } });

describe("the card's route", () => {
  it("is not found while `dr` is off (any value but exactly 1): GET and POST, as any unknown path", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) vi.unstubAllEnvs(); else dr(value);
      expect((await get(t)).status, String(value)).toBe(404);
      expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, defaultMode: "auto" })).status, String(value)).toBe(404);
    }
  });

  it("is for company owners and admins only, on GET and POST: a member, a project maintainer and a token are refused, and nothing is written or audited", async () => {
    const { t, audit } = await bench({ maya: "maintainer" });
    dr();
    expect(await get(t)).toMatchObject({ status: 200, body: { revision: 0, allowed: false, defaultMode: "never", lock: {}, unreadable: false } });
    for (const body of [{ action: "save", expectedRevision: 0, defaultMode: "auto" }, { action: "allow", expectedRevision: 0, allowed: true }, { action: "approve", changeId: "abc" }]) {
      const maintainer = await t.web(MAYA, "POST", PATH, body);
      expect(maintainer.status, JSON.stringify(body)).toBe(403);
      expect(JSON.stringify(maintainer.body)).toContain("Only a company owner or admin");
      const token = await t.dev(OMAR, "POST", PATH, body);
      expect(token.status, JSON.stringify(body)).toBe(403);
      expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    }
    expect((await get(t, MAYA)).status).toBe(403);
    await t.person(MAYA, "member");
    expect((await t.web(MAYA, "POST", PATH, { action: "save", expectedRevision: 0, defaultMode: "always" })).status).toBe(403);
    expect(await get(t)).toMatchObject({ body: { revision: 0, defaultMode: "never" } });
    expect(events(audit)).toEqual([]);
  });

  it("another company's item is never read: a second company starts from the defaults whatever the first one set", async () => {
    const { t } = await bench();
    dr();
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, defaultMode: "always" })).status).toBe(200);
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, "org_zzzzzzzzzzzzzzzzzzzz")).policy).toEqual({ allowed: false, defaultMode: "never" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy).toEqual({ allowed: false, defaultMode: "always" });
  });

  it("saves the default mode and the lock at once, audited with fixed words, on the revision read; a stale revision is POLICY_STALE and changes nothing", async () => {
    const { t, audit } = await bench();
    dr();
    const saved = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, defaultMode: "auto", lock: { mode: "auto", tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } });
    expect(saved, JSON.stringify(saved.body)).toMatchObject({ status: 200, body: { status: "applied", revision: 1, allowed: false, defaultMode: "auto", lock: { mode: "auto", tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } } });
    expect(events(audit).map((event) => event.facts)).toEqual([
      { field: "defaultMode", from: "never", to: "auto", mode: "direct", revision: 1 },
      { field: "lock", from: "0", to: "4", mode: "direct", revision: 1 },
    ]);
    expect(events(audit)[0]).toMatchObject({ actor: { kind: "member", id: OMAR.developerId }, target: { kind: "org" } });
    const stale = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, defaultMode: "always" });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain("POLICY_STALE");
    expect(await get(t)).toMatchObject({ body: { revision: 1, defaultMode: "auto" } });
    // Nothing changed, so nothing is written or audited.
    const same = await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, defaultMode: "auto" });
    expect(same).toMatchObject({ status: 200, body: { revision: 1 } });
    expect(events(audit)).toHaveLength(2);
  });

  it("refuses a body that is not one of the actions, a lock value outside its range and a group lock where the edition has no groups, with field names only", async () => {
    const { t } = await bench();
    dr();
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 0, defaultMode: "sometimes" })).status).toBe(400);
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
    expect((await t.web(OMAR, "POST", PATH, { action: "save", expectedRevision: 1, defaultMode: "auto" })).status).toBe(400);
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

  it("a company with one eligible admin has nobody to ask: that admin allows it alone, audited as sole_admin", async () => {
    const { t, audit } = await bench();
    dr();
    const reply = await t.web(OMAR, "POST", PATH, { action: "allow", expectedRevision: 0, allowed: true });
    expect(reply, JSON.stringify(reply.body)).toMatchObject({ status: 200, body: { status: "applied", allowed: true, revision: 1 } });
    expect(events(audit)).toHaveLength(1);
    expect(events(audit)[0]).toMatchObject({ actor: { id: OMAR.developerId }, facts: { field: "allowed", from: "off", to: "on", mode: "sole_admin", revision: 1 } });
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
    const deps = (ids: string[]): DesignReviewCompanyDeps => ({ documentClient: t.db, tableName: "state", now: Date.now, audit: audit.audit, authority: { eligibility: async () => ({ complete: true, membershipVersion: 1, ownerIds: ids, eligibleIds: ids, lastEligibleLossAtMs: null }) } });
    expect(await requestDesignReviewAllowed(deps(["someone-else"]), { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 0 })).toEqual({ ok: false, code: "not_eligible" });
    expect(await requestDesignReviewAllowed({ ...deps([OMAR.developerId]), authority: undefined }, { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 0 })).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect(await requestDesignReviewAllowed(deps([OMAR.developerId]), { orgId: ORG, by: OMAR.developerId, allowed: true, expectedRevision: 4 })).toEqual({ ok: false, code: "stale" });
    expect(await approveDesignReviewAllowed(deps([OMAR.developerId, "b"]), { orgId: ORG, changeId: "nope", approverId: "b" })).toEqual({ ok: false, code: "not_found" });
    expect(await saveDesignReviewCompany(deps([OMAR.developerId]), { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, lock: { surprise: 1 } as never })).toEqual({ ok: false, code: "invalid" });
    // The default mode and the lock need the same live authority as "allowed": a name the route's role check let through is still refused when the live records do not list it.
    expect(await saveDesignReviewCompany(deps(["someone-else"]), { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, defaultMode: "auto" })).toEqual({ ok: false, code: "not_eligible" });
    expect(await saveDesignReviewCompany({ ...deps([OMAR.developerId]), authority: undefined }, { orgId: ORG, by: OMAR.developerId, expectedRevision: 0, defaultMode: "auto" })).toEqual({ ok: false, code: "eligibility_unavailable" });
    expect((await readDesignReviewCompany({ documentClient: t.db, tableName: "state" }, ORG)).policy.defaultMode).toBe("never");
    expect(events(audit)).toEqual([]);
  });
});

describe("the switch: dr AND the company allows it AND the project is not Off", () => {
  const table = (t: Bench) => ({ documentClient: t.db, tableName: "state" });
  const setProject = (t: Bench, mode: string | undefined, extra: Record<string, unknown> = {}) => { if (mode !== undefined) t.db.set({ ...projectPlaybookKey(ORG, "web"), entityType: "PROJECT_PLAYBOOK", orgId: ORG, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAYA.developerId, ...own(mode, extra) }); };
  const cases: Array<{ name: string; dr: string | undefined; company: CompanyPolicySeed | null; project?: string; extra?: Record<string, unknown>; enabled: boolean }> = [
    { name: "dr off: nothing, even for a company that allows it and a project at Always", dr: "0", company: { allowed: true, defaultMode: "always" }, project: "always", enabled: false },
    { name: "dr unset", dr: undefined, company: { allowed: true }, enabled: false },
    { name: "dr on, the company has no policy", dr: "1", company: null, project: "always", enabled: false },
    { name: "the company has not allowed it: nothing, even if the project says Always", dr: "1", company: { allowed: false, defaultMode: "always" }, project: "always", enabled: false },
    { name: "allowed, the project has no setting: the company default Off", dr: "1", company: { allowed: true, defaultMode: "never" }, enabled: false },
    { name: "allowed, the project has no setting: the company default Auto", dr: "1", company: { allowed: true, defaultMode: "auto" }, enabled: true },
    { name: "allowed, the project has no setting: the company default Always", dr: "1", company: { allowed: true, defaultMode: "always" }, enabled: true },
    { name: "allowed, the project says Off (the default says Always): nothing", dr: "1", company: { allowed: true, defaultMode: "always" }, project: "never", enabled: false },
    { name: "allowed, the project says Auto (the default says Off): it runs", dr: "1", company: { allowed: true, defaultMode: "never" }, project: "auto", enabled: true },
    { name: "allowed, the project says Always: it runs", dr: "1", company: { allowed: true, defaultMode: "never" }, project: "always", enabled: true },
    { name: "the lock clamps: a project at Off under a lock of at least Auto runs", dr: "1", company: { allowed: true, defaultMode: "never", lock: { mode: "auto" } }, project: "never", enabled: true },
    { name: "the lock clamps the default too: a project with no setting under a lock of at least Auto runs", dr: "1", company: { allowed: true, defaultMode: "never", lock: { mode: "auto" } }, enabled: true },
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
    expect(await designReviewEnabledFor(client, ORG, "web")).toBe(true);
    expect(reads({ send }).some((input) => input.includes("PLAYBOOK"))).toBe(true);
  });

  it("a review the person asked for goes on while design review is allowed, even in a project that is Off; any other review ends when the project is Off or the company stops allowing it (B2-m3)", async () => {
    const { t } = await bench();
    dr();
    seedDesignReviewCompany(t.db, ORG, { allowed: true, defaultMode: "auto" });
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
    const ports: DpMigrationPorts = { playbook: base, company: base, listOrgs: async (after) => (after === undefined ? [ORG] : []), installOrg: () => ORG, now: Date.now, log: () => undefined };
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
    expect(after.company).toEqual({ allowed: true, defaultMode: "never" });
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
