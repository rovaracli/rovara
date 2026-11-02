// Setup run limits, stored (sh-su-musts). The project's own setting (a maintainer, a browser) and the company's lock (an admin with a fresh sign-in; a loosening waits for a second admin), the units between them,
// and that a run starts with the smaller of the two. The decider for company locks is SH29's (tests/unit/broker-setup-recipes.test.ts); these tests are about what this adds: the stored rows, the audit, the project
// rule "only stricter than the lock", and who may call it.
import { describe, expect, it } from "vitest";
import {
  AgentXError, SETUP_AGENT_LIMITS_DEFAULT, SETUP_AGENT_LIMITS_MAX, effectiveSetupAgentLimits, orgMemberKey, orgMetaKey, setupLimitsKey, setupLocksKey, type OrgId, type ProjectRole,
} from "@agentx/contracts";
import { secondPersonMembershipCondition } from "../../packages/broker/src/org/second-person-approval.js";
import { SETUP_LIMIT_MAXIMA, isLoosening, readCompanyLocks } from "../../packages/broker/src/org/setup-recipes.js";
import {
  LOCK_MAXIMA_AS_RUN, approveCompanyLockSettings, getCompanyLocksView, getProjectLimits, limitSettingsOf, lockToRunSetting, repairUnreadableLocks, runSettingToLockLimits, setCompanyLockSettings, splitLoosening, setProjectLimits, type SetupLimitsDeps,
} from "../../packages/broker/src/rovara-code/setup-limits.js";
import { companySetupOff, dynamoSetupLocksStore, getCompanySetupLocks, repairedLocksOf, writeRepairedLocks } from "../../packages/broker/src/rovara-code/setup-locks-store.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes/types.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ADMIN = "a".repeat(64);
const SECOND = "d".repeat(64);
const MAINT = "b".repeat(64);
const NOW = new Date("2026-11-02T12:00:00.000Z");
const FRESH = "2026-11-02T11:58:00.000Z";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const who = (developerId: string, over: Partial<DeveloperCaller> = {}): DeveloperCaller => ({ orgId: ORG, developerId, name: "x", orgRole: "member", sessionId: `s-${developerId.slice(0, 1)}`, amr: "oidc", browserSession: true, ...over }) as unknown as DeveloperCaller;
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? "OTHER"; }
  return "NO_ERROR";
};

function harness(options: { audit?: boolean; admins?: string[]; eligible?: string[] } = {}) {
  const db = new FakeDynamoDb();
  db.set({ ...orgMetaKey(ORG), approvalMembershipVersion: 7 });
  db.set({ ...orgMemberKey(ORG, ADMIN), role: "owner" });
  db.set({ ...orgMemberKey(ORG, SECOND), role: "admin" });
  const capture = capturingAuditDeps({ db });
  const admins = new Set(options.admins ?? [ADMIN, SECOND]);
  const sessions = new Map<string, { developerId: string; authTime?: string; revokedAt?: string }>([["s-a", { developerId: ADMIN, authTime: FRESH }], ["s-d", { developerId: SECOND, authTime: FRESH }]]);
  const clock = { now: NOW };
  const hooks: { afterEvidence?: (() => void) | undefined } = {};
  const evidence = { complete: true, membershipVersion: 7, ownerIds: [ADMIN], eligibleIds: options.eligible ?? [ADMIN, SECOND], lastEligibleLossAtMs: null as number | null };
  const audit = options.audit === false ? {} : { audit: capture.audit };
  const deps: SetupLimitsDeps = {
    documentClient: db, tableName: "state", ...audit,
    store: dynamoSetupLocksStore({ documentClient: db, tableName: "state", now: () => clock.now.getTime(), ...audit }),
    requireAdmin: (caller) => (admins.has(caller.developerId) ? Promise.resolve() : Promise.reject(new AgentXError("FORBIDDEN", "Live company owner or admin access is required.", 403))),
    readSession: (id) => Promise.resolve(sessions.get(id)),
    approvalEvidence: (scope) => {
      const version = Number(db.get(orgMetaKey(ORG))?.approvalMembershipVersion);
      const person = (id: string) => ({ ConditionCheck: { TableName: "state", Key: orgMemberKey(ORG, id), ConditionExpression: "attribute_exists(pk)" } });
      const result = {
        decisionInput: { ...evidence, membershipVersion: version, proposerId: scope.proposerId, approverId: scope.approverId, nowMs: clock.now.getTime() },
        conditions: [{ ConditionCheck: { TableName: "state", Key: orgMetaKey(ORG), ...secondPersonMembershipCondition(version) } }, ...[...new Set([scope.proposerId, scope.approverId])].map(person)],
      };
      hooks.afterEvidence?.();
      return Promise.resolve(result);
    },
    now: () => clock.now,
  };
  const maintainer = { name: "web", role: "maintainer" as ProjectRole };
  return { db, deps, capture, sessions, clock, evidence, maintainer, hooks };
}
type H = ReturnType<typeof harness>;
const body = (h: H, over: Record<string, unknown> = {}) => ({ requestId: A, expectedRevision: 0, limits: { commands: 60 }, ...over });
const events = (h: H, action: Parameters<H["capture"]["recordedBy"]>[0]) => h.capture.recordedBy(action);

describe("units: the lock counts minutes and dollars, a run counts minutes and cents", () => {
  it("the lock's maxima are the run's maxima, in the other unit", () => {
    expect(LOCK_MAXIMA_AS_RUN).toEqual(SETUP_AGENT_LIMITS_MAX);
    expect(SETUP_LIMIT_MAXIMA).toEqual({ commands: 120, sameStepTries: 5, wallClockMinutes: 120, spendUsd: 20, hostAsks: 10 });
  });
  it("maps a lock to a run setting and back; a spend that is not whole cents rounds down (stricter)", () => {
    expect(lockToRunSetting({ limits: { commands: 30, sameStepTries: 2, wallClockMinutes: 20, spendUsd: 2.5, hostAsks: 3 } })).toEqual({ commands: 30, sameStepTries: 2, wallClockMin: 20, budgetCents: 250, hostAsks: 3 });
    expect(lockToRunSetting({ limits: { spendUsd: 1.239 } })).toEqual({ budgetCents: 123 });
    expect(lockToRunSetting({ limits: { commands: 2.9 } })).toEqual({ commands: 2 });
    expect(lockToRunSetting(undefined)).toEqual({});
    expect(lockToRunSetting({ setupAgentOff: true })).toEqual({});
    expect(runSettingToLockLimits({ commands: 30, wallClockMin: 20, budgetCents: 250 })).toEqual({ commands: 30, wallClockMinutes: 20, spendUsd: 2.5 });
    expect(runSettingToLockLimits({})).toBeUndefined();
  });
});

describe("a project's own limits", () => {
  it("are set by a maintainer from a browser, read back with the lock and what a run would use, and audited", async () => {
    const h = harness();
    const reply = await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { limits: { commands: 60, budgetCents: 800 } }));
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toMatchObject({ revision: 1, limits: { commands: 60, budgetCents: 800 }, companyLock: {}, effective: { ...SETUP_AGENT_LIMITS_DEFAULT, commands: 60, budgetCents: 800 } });
    expect(h.db.get(setupLimitsKey(ORG, "web").pk, "LIMITS")).toMatchObject({ revision: 1, limits: { commands: 60, budgetCents: 800 }, updatedBy: MAINT, project: "web" });
    const [event] = events(h, "setup.limits_changed");
    expect(event).toMatchObject({ action: "setup.limits_changed", actor: { kind: "member", id: MAINT }, target: { kind: "project", name: "web" }, facts: { revision: 1, commands: 60, budgetCents: 800 } });
    expect(event?.facts?.["previousDigest"]).toMatch(/^[a-f0-9]{64}$/u);
    const read = await getProjectLimits(h.deps, who(MAINT), h.maintainer);
    expect(read.body).toMatchObject({ revision: 1, limits: { commands: 60, budgetCents: 800 }, defaults: SETUP_AGENT_LIMITS_DEFAULT, maxima: SETUP_AGENT_LIMITS_MAX });
  });

  it("can be raised above the default, up to the maximum, and no further", async () => {
    const h = harness();
    expect((await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { limits: { commands: 120, budgetCents: 2000 } }))).statusCode).toBe(200);
    for (const bad of [{ commands: 121 }, { budgetCents: 2001 }, { commands: 0 }, { commands: 1.5 }, { hostAsks: 11 }, { wallClockMin: 121 }, { sameStepTries: 6 }, { speed: 3 }, { commands: "9" }]) {
      expect(await code(setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { requestId: B, expectedRevision: 1, limits: bad }))), JSON.stringify(bad)).toBe("CONFIG_INVALID");
    }
    expect(h.db.get(setupLimitsKey(ORG, "web").pk, "LIMITS")).toMatchObject({ revision: 1 });
  });

  it("is a maintainer's, from a signed-in browser: a viewer, a contributor, a token and an unknown field are refused and nothing is written", async () => {
    const h = harness();
    for (const role of ["viewer", "contributor"] as const) expect(await code(setProjectLimits(h.deps, who(MAINT), { name: "web", role }, body(h))), role).toBe("FORBIDDEN");
    expect(await code(getProjectLimits(h.deps, who(MAINT), { name: "web", role: "contributor" }))).toBe("FORBIDDEN");
    expect(await code(setProjectLimits(h.deps, who(MAINT, { browserSession: undefined } as never), h.maintainer, body(h)))).toBe("FORBIDDEN");
    for (const bad of [{ ...body(h), payer: "x" }, { ...body(h), requestId: "nope" }, { requestId: A, limits: {} }, null, "text"]) expect(await code(setProjectLimits(h.deps, who(MAINT), h.maintainer, bad)), JSON.stringify(bad)).toBe("CONFIG_INVALID");
    expect(h.db.find((item) => item.entityType === "SETUP_LIMITS")).toEqual([]);
    expect(events(h, "setup.limits_changed")).toEqual([]);
  });

  it("is written against the revision the person saw; a repeat of the request answers the same and writes nothing; no change writes nothing", async () => {
    const h = harness();
    await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h));
    expect(await code(setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { requestId: B, limits: { commands: 70 } })))).toBe("CHANGE_STALE");
    const again = await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h));
    expect(again.body).toMatchObject({ revision: 1, limits: { commands: 60 } });
    const same = await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { requestId: B, expectedRevision: 1 }));
    expect(same.body).toMatchObject({ revision: 1 });
    expect(events(h, "setup.limits_changed")).toHaveLength(1);
    const next = await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { requestId: C, expectedRevision: 1, limits: { commands: 20 } }));
    expect(next.body).toMatchObject({ revision: 2, limits: { commands: 20 } });
    expect(events(h, "setup.limits_changed")).toHaveLength(2);
  });

  it("an empty setting removes the project's own limits", async () => {
    const h = harness();
    await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h));
    const cleared = await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { requestId: B, expectedRevision: 1, limits: {} }));
    expect(cleared.body).toMatchObject({ revision: 2, limits: {}, effective: SETUP_AGENT_LIMITS_DEFAULT });
  });

  it("needs the audit ledger like every lock write: exactly one audit item rides with the row, else nothing is written", async () => {
    const h = harness({ audit: false });
    expect(await code(setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h)))).toBe("AUDIT_UNAVAILABLE");
    expect(h.db.find((item) => item.entityType === "SETUP_LIMITS")).toEqual([]);
  });
});

describe("a project may only be stricter than the company's lock", () => {
  const lockCommits = async (h: H, limits: Record<string, number>) => {
    const reply = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits });
    expect(reply.statusCode).toBe(200);
  };
  it("refuses a value above the lock when it is saved, accepts one at or below it, and names the limit", async () => {
    const h = harness();
    await lockCommits(h, { commands: 50, budgetCents: 300 });
    expect(await code(setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { limits: { commands: 51 } })))).toBe("CONFIG_INVALID");
    expect(await code(setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { limits: { budgetCents: 301 } })))).toBe("CONFIG_INVALID");
    await expect(setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { limits: { commands: 50, budgetCents: 300 } }))).resolves.toMatchObject({ statusCode: 200 });
    const view = await getProjectLimits(h.deps, who(MAINT), h.maintainer);
    expect(view.body).toMatchObject({ companyLock: { commands: 50, budgetCents: 300 }, effective: { commands: 50, budgetCents: 300 } });
  });
  it("a lock set (or lowered) after the project's value cuts it down when the run starts, never the other way", async () => {
    const h = harness();
    await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { limits: { commands: 100, hostAsks: 8 } }));
    await lockCommits(h, { commands: 30 });
    const settings = await limitSettingsOf(h.deps)(ORG, "web");
    expect(settings).toEqual({ project: { commands: 100, hostAsks: 8 }, companyLock: { commands: 30 } });
    expect(effectiveSetupAgentLimits(settings.project, settings.companyLock)).toMatchObject({ commands: 30, hostAsks: 8, budgetCents: 400 });
    // A lock above the project's value changes nothing.
    const other = harness();
    await setProjectLimits(other.deps, who(MAINT), other.maintainer, body(other, { limits: { commands: 10 } }));
    await setCompanyLockSettings(other.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 90 } });
    const read = await limitSettingsOf(other.deps)(ORG, "web");
    expect(effectiveSetupAgentLimits(read.project, read.companyLock).commands).toBe(10);
  });
  it("no setting at all gives no project value and no lock: a run uses the defaults", async () => {
    const h = harness();
    expect(await limitSettingsOf(h.deps)(ORG, "web")).toEqual({ companyLock: {} });
  });
  it("another company's or another project's rows are never read", async () => {
    const h = harness();
    await setProjectLimits(h.deps, who(MAINT), h.maintainer, body(h, { limits: { commands: 10 } }));
    expect(await limitSettingsOf(h.deps)(ORG, "api")).toEqual({ companyLock: {} });
    expect(await limitSettingsOf(h.deps)("org_bbbbbbbbbbbbbbbbbbbb", "web")).toEqual({ companyLock: {} });
  });
});

describe("the locks row", () => {
  it("is written against the revision read: a second writer with the same read is refused, and a first write needs no row", async () => {
    const h = harness();
    const entry = { action: "locks_changed" as const, orgId: ORG, actor: ADMIN, at: NOW.toISOString(), proof: "fresh_sign_in" as const, revision: 1, previousDigest: "0".repeat(64), nextDigest: "1".repeat(64), loosened: false };
    const next = (revision: number, commands: number) => ({ orgId: ORG, revision, locks: { limits: { commands } }, updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    expect(await h.deps.store.commitLocks(next(1, 50), null, entry, [])).toBe(true);
    expect(await h.deps.store.commitLocks(next(1, 60), null, entry, [])).toBe(false);
    expect(await h.deps.store.commitLocks(next(2, 40), 1, { ...entry, revision: 2 }, [])).toBe(true);
    expect(await h.deps.store.commitLocks(next(2, 30), 1, { ...entry, revision: 2 }, [])).toBe(false);
    expect((await h.deps.store.getLocks(ORG))?.locks.limits?.commands).toBe(40);
  });
  it("is refused with its evidence when a condition fails, and writes nothing", async () => {
    const h = harness();
    const entry = { action: "locks_changed" as const, orgId: ORG, actor: ADMIN, at: NOW.toISOString(), proof: "fresh_sign_in" as const, revision: 1, previousDigest: "0".repeat(64), nextDigest: "1".repeat(64), loosened: false };
    const failing = { ConditionCheck: { TableName: "state", Key: orgMemberKey(ORG, "9".repeat(64)), ConditionExpression: "attribute_exists(pk)" } };
    expect(await h.deps.store.commitLocks({ orgId: ORG, revision: 1, locks: {}, updatedBy: ADMIN, updatedAt: NOW.toISOString() }, null, entry, [failing])).toBe(false);
    expect(await h.deps.store.getLocks(ORG)).toBeUndefined();
    expect(events(h, "setup.locks_changed")).toEqual([]);
  });
  it("never reads across companies", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 50 } });
    expect(await h.deps.store.getLocks("org_bbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
  });
});

describe("the company's limits (a lock)", () => {
  it("are set by a live admin from a browser with a fresh sign-in; a stricter limit applies at once and is audited", async () => {
    const h = harness();
    const reply = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 50, wallClockMin: 30, budgetCents: 250 } });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toMatchObject({ status: "applied", revision: 1, limits: { commands: 50, wallClockMin: 30, budgetCents: 250 }, maxima: SETUP_AGENT_LIMITS_MAX });
    expect(h.db.get(setupLocksKey(ORG).pk, "META")).toMatchObject({ revision: 1, locks: { limits: { commands: 50, wallClockMinutes: 30, spendUsd: 2.5 } }, updatedBy: ADMIN });
    expect((await readCompanyLocks(h.deps, ORG))?.locks.limits).toEqual({ commands: 50, wallClockMinutes: 30, spendUsd: 2.5 });
    const [event] = events(h, "setup.locks_changed");
    expect(event).toMatchObject({ action: "setup.locks_changed", actor: { kind: "member", id: ADMIN }, target: { kind: "org", id: ORG }, facts: { revision: 1, loosened: false } });
    // Lowering it further applies at once too.
    const lower = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, limits: { commands: 40, wallClockMin: 30, budgetCents: 250 } });
    expect(lower.body).toMatchObject({ status: "applied", revision: 2, limits: { commands: 40 } });
    expect(events(h, "setup.locks_changed")).toHaveLength(2);
  });

  it("keeps the company's other locks as they were", async () => {
    const h = harness();
    await h.deps.store.commitLocks({ orgId: ORG, revision: 1, locks: { setupAgentOff: true, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"], limits: { commands: 80 } }, updatedBy: ADMIN, updatedAt: NOW.toISOString() }, null,
      { action: "locks_changed", orgId: ORG, actor: ADMIN, at: NOW.toISOString(), proof: "fresh_sign_in", revision: 1, previousDigest: "0".repeat(64), nextDigest: "1".repeat(64), loosened: false }, []);
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: 1, limits: { commands: 60 } });
    expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual({ setupAgentOff: true, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"], limits: { commands: 60 } });
  });

  it("is for a live company admin, from a browser, with a fresh sign-in: a member, a token, an old sign-in and a revoked session are refused and nothing is stored", async () => {
    const h = harness();
    const request = { requestId: A, expectedRevision: null, limits: { commands: 50 } };
    expect(await code(setCompanyLockSettings(h.deps, who(MAINT), request))).toBe("FORBIDDEN");
    expect(await code(getCompanyLocksView(h.deps, who(MAINT)))).toBe("FORBIDDEN");
    expect(await code(setCompanyLockSettings(h.deps, who(ADMIN, { browserSession: undefined } as never), request))).toBe("FORBIDDEN");
    expect(await code(getCompanyLocksView(h.deps, who(ADMIN, { browserSession: undefined } as never)))).toBe("FORBIDDEN");
    for (const session of [undefined, { developerId: ADMIN }, { developerId: ADMIN, authTime: "2026-11-02T11:40:00.000Z" }, { developerId: SECOND, authTime: FRESH }, { developerId: ADMIN, authTime: FRESH, revokedAt: "2026-11-02T11:59:00.000Z" }]) {
      if (session === undefined) h.sessions.delete("s-a"); else h.sessions.set("s-a", session);
      expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), request)), JSON.stringify(session)).toBe("REAUTH_REQUIRED");
    }
    expect(h.db.find((item) => item.entityType === "SETUP_LOCKS")).toEqual([]);
    expect(events(h, "setup.locks_changed")).toEqual([]);
  });

  it("reads its body strictly and refuses a limit past the maximum", async () => {
    const h = harness();
    for (const bad of [{ requestId: A, expectedRevision: null, limits: { commands: 121 } }, { requestId: A, expectedRevision: null, limits: { budgetCents: 2001 } }, { requestId: A, limits: {} }, { requestId: A, expectedRevision: null, limits: {}, extra: 1 }, { requestId: "x", expectedRevision: null, limits: {} }]) {
      expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), bad)), JSON.stringify(bad)).toBe("CONFIG_INVALID");
    }
  });

  it("is written against the revision the admin saw", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 50 } });
    expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: null, limits: { commands: 40 } }))).toBe("CHANGE_STALE");
    expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 5, limits: { commands: 40 } }))).toBe("CHANGE_STALE");
  });

  it("a loosening (a limit raised or removed) changes nothing until a DIFFERENT admin approves it; the proposal and the approval are audited", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 40, hostAsks: 2 } });
    const loosen = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, limits: { commands: 80, hostAsks: 2 } });
    expect(loosen.statusCode).toBe(202);
    expect(loosen.body).toMatchObject({ status: "needs_second_admin", revision: 2, limits: { commands: 40, hostAsks: 2 }, pending: { limits: { commands: 80, hostAsks: 2 }, byYou: true } });
    // Nothing loosened yet: a run still starts with the lock.
    expect((await limitSettingsOf(h.deps)(ORG, "web")).companyLock).toEqual({ commands: 40, hostAsks: 2 });
    const digest = (loosen.body as { pending: { digest: string } }).pending.digest;
    // The proposer cannot approve their own (a second admin is eligible).
    expect(await code(approveCompanyLockSettings(h.deps, who(ADMIN), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).not.toBe("NO_ERROR");
    expect((await limitSettingsOf(h.deps)(ORG, "web")).companyLock).toEqual({ commands: 40, hostAsks: 2 });
    const seen = await getCompanyLocksView(h.deps, who(SECOND));
    expect(seen.body).toMatchObject({ pending: { limits: { commands: 80, hostAsks: 2 }, digest, byYou: false } });
    const approved = await approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 2, expectedDigest: digest });
    expect(approved.body).toMatchObject({ status: "applied", revision: 3, limits: { commands: 80, hostAsks: 2 } });
    expect((await limitSettingsOf(h.deps)(ORG, "web")).companyLock).toEqual({ commands: 80, hostAsks: 2 });
    const proposed = events(h, "setup.locks_change_proposed");
    const decided = events(h, "setup.locks_change_approved");
    expect(proposed).toMatchObject([{ actor: { id: ADMIN }, facts: { loosened: true, revision: 2 } }]);
    expect(decided).toMatchObject([{ actor: { id: SECOND }, facts: { loosened: true, revision: 3, approvalMode: "second_person" } }]);
  });

  it("removing the company's limits is a loosening too", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 40 } });
    const remove = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, limits: {} });
    expect(remove.statusCode).toBe(202);
    expect((await readCompanyLocks(h.deps, ORG))?.locks.limits).toEqual({ commands: 40 });
  });

  it("approval is pinned to the revision and the digest the second admin saw, needs their fresh sign-in and a live admin, and a stricter change in between clears the waiting one", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 40 } });
    const loosen = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, limits: { commands: 80 } });
    const digest = (loosen.body as { pending: { digest: string } }).pending.digest;
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 1, expectedDigest: digest }))).toBe("CHANGE_STALE");
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 2, expectedDigest: "f".repeat(64) }))).toBe("CHANGE_STALE");
    expect(await code(approveCompanyLockSettings(h.deps, who(MAINT), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).toBe("FORBIDDEN");
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND, { browserSession: undefined } as never), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).toBe("FORBIDDEN");
    h.sessions.set("s-d", { developerId: SECOND, authTime: "2026-11-02T11:00:00.000Z" });
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).toBe("REAUTH_REQUIRED");
    h.sessions.set("s-d", { developerId: SECOND, authTime: FRESH });
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 2, expectedDigest: digest, extra: 1 }))).toBe("CONFIG_INVALID");
    // The membership the decision rested on changed: refused, the waiting change stays.
    h.hooks.afterEvidence = () => { h.db.set({ ...orgMetaKey(ORG), approvalMembershipVersion: 8 }); };
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).toBe("CHANGE_STALE");
    expect((await readCompanyLocks(h.deps, ORG))?.locks.limits).toEqual({ commands: 40 });
    // A stricter change made meanwhile applies at once and clears the waiting loosening.
    h.hooks.afterEvidence = undefined;
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: C, expectedRevision: 2, limits: { commands: 30 } });
    const after = await readCompanyLocks(h.deps, ORG);
    expect(after?.locks.limits).toEqual({ commands: 30 });
    expect(after?.pending).toBeUndefined();
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 3, expectedDigest: digest }))).toBe("CHANGE_STALE");
  });

  it("a one-admin company: the only admin approves their own loosening through the sole-owner exception, after the cool-off, audited as such", async () => {
    const h = harness({ admins: [ADMIN], eligible: [ADMIN] });
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 40 } });
    const loosen = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, limits: { commands: 80 } });
    const digest = (loosen.body as { pending: { digest: string } }).pending.digest;
    // Within 24 hours of the last change to who is eligible, or with an eligible person lost: the exception is on, and its own rule decides.
    h.evidence.lastEligibleLossAtMs = NOW.getTime() - 3_600_000;
    expect(await code(approveCompanyLockSettings(h.deps, who(ADMIN), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).not.toBe("NO_ERROR");
    h.evidence.lastEligibleLossAtMs = null;
    const approved = await approveCompanyLockSettings(h.deps, who(ADMIN), { requestId: C, expectedRevision: 2, expectedDigest: digest });
    expect(approved.body).toMatchObject({ status: "applied", limits: { commands: 80 } });
    expect(events(h, "setup.locks_change_approved")).toMatchObject([{ facts: { approvalMode: "sole_owner_exception" } }]);
  });

  it("every write needs the audit ledger: without it nothing is stored, a stricter change included", async () => {
    const h = harness({ audit: false });
    expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 40 } }))).toBe("AUDIT_UNAVAILABLE");
    expect(await readCompanyLocks(h.deps, ORG)).toBeUndefined();
  });

  it("every write is audited: a stricter change, a proposal and an approval each leave one event", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, setupAgentOff: true });
    const loosen = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, setupAgentOff: false });
    await approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 2, expectedDigest: (loosen.body as { pending: { digest: string } }).pending.digest });
    expect(h.capture.recorded().map((event) => event.action)).toEqual(["setup.locks_changed", "setup.locks_change_proposed", "setup.locks_change_approved"]);
  });

  it("sets only the enforced locks: setupAgentOff, devcontainerImages and noSoleOwnerException, keeping what is not given; the other locks are 'not available yet'", async () => {
    const h = harness();
    const first = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 50 }, setupAgentOff: true, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"], noSoleOwnerException: true });
    expect(first.body).toMatchObject({ status: "applied", limits: { commands: 50 }, setupAgentOff: true, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"], noSoleOwnerException: true });
    // A stricter change to one lock keeps the others.
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, limits: { commands: 40 } });
    expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual({ limits: { commands: 40 }, setupAgentOff: true, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"], noSoleOwnerException: true });
    for (const bad of [{ hostsOnlyFromCompanyList: true }, { hostApprover: "admin" }, { nightlyHealthOn: true }, {}, { devcontainerImages: ["not an image"] }]) {
      expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), { requestId: C, expectedRevision: 2, ...bad })), JSON.stringify(bad)).toBe("CONFIG_INVALID");
    }
    expect((await readCompanyLocks(h.deps, ORG))?.revision).toBe(2);
  });

  it("loosening ANY lock waits for a second admin: turning setupAgentOff off, removing the image list, or turning the one-admin exception off", async () => {
    for (const [first, loosen] of [
      [{ setupAgentOff: true }, { setupAgentOff: false }],
      [{ devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] }, { devcontainerImages: null }],
      [{ noSoleOwnerException: true }, { noSoleOwnerException: false }],
      [{ devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] }, { devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23", "mcr.microsoft.com/devcontainers/python:3.12"] }],
    ] as const) {
      const h = harness();
      await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, ...first });
      const reply = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, ...loosen });
      expect(reply.statusCode, JSON.stringify(loosen)).toBe(202);
      expect(reply.body).toMatchObject({ status: "needs_second_admin", pending: { byYou: true } });
    }
  });

  it("with noSoleOwnerException set, even a one-admin company cannot approve its own loosening", async () => {
    const h = harness({ admins: [ADMIN], eligible: [ADMIN] });
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, setupAgentOff: true, noSoleOwnerException: true });
    const loosen = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, setupAgentOff: false });
    const digest = (loosen.body as { pending: { digest: string } }).pending.digest;
    expect(await code(approveCompanyLockSettings(h.deps, who(ADMIN), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).toBe("FORBIDDEN");
    expect((await readCompanyLocks(h.deps, ORG))?.locks.setupAgentOff).toBe(true);
  });

  it("another lane can read the locks: getCompanySetupLocks answers the stored locks, nothing for another company, and throws for a row that does not read", async () => {
    const h = harness();
    expect(await getCompanySetupLocks(h.deps, ORG)).toBeUndefined();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] });
    expect(await getCompanySetupLocks(h.deps, ORG)).toEqual({ devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] });
    expect(await getCompanySetupLocks(h.deps, "org_bbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    h.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: 2, locks: { devcontainerImages: "x" }, updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    expect(await code(getCompanySetupLocks(h.deps, ORG))).toBe("CONFIG_INVALID");
  });

  it("L12: a run is stopped by a readable 'off' or a row that is positively damaged, never by a read that merely fails (it is tried twice, then the run goes on)", async () => {
    const h = harness();
    expect(await companySetupOff(h.deps, ORG)).toBe(false);
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, setupAgentOff: true });
    expect(await companySetupOff(h.deps, ORG)).toBe(true);
    // A throttle once: the second try answers.
    let reads = 0;
    const flaky = (failures: number) => ({ tableName: "state", documentClient: { send: (command: unknown) => { reads += 1; return reads <= failures ? Promise.reject(Object.assign(new Error("ThrottlingException"), { name: "ThrottlingException" })) : h.db.send(command as never); } } });
    reads = 0;
    expect(await companySetupOff(flaky(1), ORG)).toBe(true);
    expect(reads).toBe(2);
    // Throttled both times: the run is not stopped (it asks again at its next poll), and a healthy company is not stopped either.
    reads = 0;
    expect(await companySetupOff(flaky(5), ORG)).toBe(false);
    expect(reads).toBe(2);
    const other = harness();
    reads = 0;
    expect(await companySetupOff({ tableName: "state", documentClient: { send: () => Promise.reject(new Error("timeout")) } }, ORG)).toBe(false);
    expect(await companySetupOff(other.deps, ORG)).toBe(false);
    // A row that is positively damaged stops it.
    other.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: 1, locks: "broken", updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    expect(await companySetupOff(other.deps, ORG)).toBe(true);
  });

  it("the setup start reads setupAgentOff with the limits", async () => {
    const h = harness();
    expect((await limitSettingsOf(h.deps)(ORG, "web")).setupOff).toBeUndefined();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, setupAgentOff: true });
    expect((await limitSettingsOf(h.deps)(ORG, "web")).setupOff).toBe(true);
  });

  it("M3: a stored lock that does not read holds every start (never reads as no lock) but does not break the pages that read it", async () => {
    const h = harness();
    h.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: 4, locks: { limits: { commands: "many" } }, updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    expect(await limitSettingsOf(h.deps)(ORG, "web")).toMatchObject({ locksUnreadable: true, setupOff: true });
    const view = await getCompanyLocksView(h.deps, who(ADMIN));
    expect(view.body).toMatchObject({ unreadable: true, revision: 4, message: expect.stringContaining("Company locks unreadable, runs held") as string });
    expect((await getProjectLimits(h.deps, who(MAINT), h.maintainer)).statusCode).toBe(200);
    // An ordinary change is refused until it is repaired.
    expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: 4, setupAgentOff: true }))).toBe("CONFIG_INVALID");
  });

  it("M3: an admin with a fresh sign-in repairs it, keeping every lock that reads and tightening the one that does not, against the stored revision, audited", async () => {
    const h = harness();
    h.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: 4, locks: { limits: { commands: "many" }, hostApprover: "admin" }, updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    const body = { requestId: A, expectedRevision: 4 };
    expect(await code(repairUnreadableLocks(h.deps, who(MAINT), body))).toBe("FORBIDDEN");
    expect(await code(repairUnreadableLocks(h.deps, who(ADMIN, { browserSession: undefined } as never), body))).toBe("FORBIDDEN");
    expect(await code(repairUnreadableLocks(h.deps, who(ADMIN), { ...body, expectedRevision: 3 }))).toBe("CHANGE_STALE");
    expect(await code(repairUnreadableLocks(h.deps, who(ADMIN), { ...body, extra: 1 }))).toBe("CONFIG_INVALID");
    h.sessions.set("s-a", { developerId: ADMIN, authTime: "2026-11-02T11:00:00.000Z" });
    expect(await code(repairUnreadableLocks(h.deps, who(ADMIN), body))).toBe("REAUTH_REQUIRED");
    h.sessions.set("s-a", { developerId: ADMIN, authTime: FRESH });
    const repaired = await repairUnreadableLocks(h.deps, who(ADMIN), body);
    expect(repaired.body).toMatchObject({ status: "repaired", revision: 5, limits: { commands: SETUP_AGENT_LIMITS_DEFAULT.commands }, setupAgentOff: false, noSoleOwnerException: true });
    expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual({ limits: { commands: 40 }, hostApprover: "admin", noSoleOwnerException: true });
    expect(events(h, "setup.locks_changed")).toMatchObject([{ actor: { id: ADMIN }, facts: { revision: 5, loosened: false, defaulted: "limits.commands,noSoleOwnerException" } }]);
    expect((await limitSettingsOf(h.deps)(ORG, "web")).locksUnreadable).toBeUndefined();
    // A row that reads is not repaired, and a repeat is stale.
    expect(await code(repairUnreadableLocks(h.deps, who(ADMIN), { requestId: B, expectedRevision: 5 }))).toBe("CHANGE_STALE");
  });

  it("M3: a repair never loosens: a row whose locks read but whose updatedBy is damaged keeps setupAgentOff and gets noSoleOwnerException", async () => {
    const h = harness();
    h.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: 2, locks: { setupAgentOff: true, limits: { commands: 10, spendUsd: 1 }, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] }, updatedBy: { not: "a string" }, updatedAt: NOW.toISOString() });
    expect((await getCompanyLocksView(h.deps, who(ADMIN))).body).toMatchObject({ unreadable: true });
    const repaired = await repairUnreadableLocks(h.deps, who(ADMIN), { requestId: A, expectedRevision: 2 });
    expect(repaired.body).toMatchObject({ status: "repaired", setupAgentOff: true, noSoleOwnerException: true, limits: { commands: 10, budgetCents: 100 } });
    expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual({ setupAgentOff: true, limits: { commands: 10, spendUsd: 1 }, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"], noSoleOwnerException: true });
    expect(events(h, "setup.locks_changed")).toMatchObject([{ facts: { loosened: false, defaulted: "noSoleOwnerException" } }]);
  });

  it("M3: what cannot be read gets its strictest value; what reads is never dropped; nothing is looser than the row's own readable locks", () => {
    const readable = { setupAgentOff: true as const, hostsOnlyFromCompanyList: true as const, hostApprover: "admin" as const, devcontainerImages: ["a/b:1"], limits: { commands: 7, hostAsks: 2 } };
    // Each case: the damaged row, and the locks of it that DO read. The repair is never looser than those.
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["setupAgentOff damaged", { ...readable, setupAgentOff: "yes" }, { ...readable, setupAgentOff: undefined }],
      ["images damaged", { ...readable, devcontainerImages: "x" }, { ...readable, devcontainerImages: undefined }],
      ["a limit damaged", { ...readable, limits: { commands: 7, hostAsks: -1 } }, { ...readable, limits: { commands: 7 } }],
      ["limits damaged", { ...readable, limits: "none" }, { ...readable, limits: undefined }],
      ["an unknown key", { ...readable, speed: 3 }, readable],
      ["hostApprover damaged", { ...readable, hostApprover: "maintainer" }, { ...readable, hostApprover: undefined }],
    ];
    for (const [name, locks, known] of cases) {
      const { locks: repaired } = repairedLocksOf({ locks, revision: 1 });
      expect(isLoosening(known as never, repaired), name).toBe(false);
      expect(repaired.noSoleOwnerException, name).toBe(true);
      for (const key of ["hostsOnlyFromCompanyList"] as const) expect(repaired[key], name).toBe(true);
    }
    expect(repairedLocksOf({ locks: { ...readable, setupAgentOff: "yes" } }).locks.setupAgentOff).toBe(true);
    expect(repairedLocksOf({ locks: { ...readable, devcontainerImages: "x" } }).locks.devcontainerImages).toEqual([]);
    expect(repairedLocksOf({ locks: { ...readable, limits: { commands: 7, hostAsks: -1 } } }).locks.limits).toEqual({ commands: 7, hostAsks: SETUP_AGENT_LIMITS_DEFAULT.hostAsks });
    expect(repairedLocksOf({ locks: { ...readable, limits: "none" } }).locks.limits).toEqual({ commands: 40, sameStepTries: 3, wallClockMinutes: 45, spendUsd: 4, hostAsks: 5 });
    // Nothing readable is dropped.
    expect(repairedLocksOf({ locks: { ...readable, speed: 3 } })).toEqual({ locks: { ...readable, noSoleOwnerException: true }, defaulted: ["noSoleOwnerException", "speed"] });
    // Locks that are not an object at all: every enforced lock at its strictest.
    for (const locks of ["broken", null, [], 5, undefined]) {
      expect(repairedLocksOf({ locks }).locks, JSON.stringify(locks)).toEqual({
        setupAgentOff: true, hostsOnlyFromCompanyList: true, nightlyHealthOn: true, hostApprover: "admin", devcontainerImages: [], noSoleOwnerException: true, limits: { commands: 40, sameStepTries: 3, wallClockMinutes: 45, spendUsd: 4, hostAsks: 5 },
      });
    }
  });

  it("M3: the repair write itself is conditional on the stored revision: a row rewritten between the read and the write is not overwritten", async () => {
    const h = harness();
    h.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: 4, locks: "broken", updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    const deps = { documentClient: h.db, tableName: "state", now: () => NOW.getTime(), audit: h.capture.audit };
    expect(await writeRepairedLocks(deps, { orgId: ORG, actor: ADMIN, expectedRevision: 3, previousDigest: "", locks: { noSoleOwnerException: true }, defaulted: [] })).toBe(false);
    expect(h.db.get(setupLocksKey(ORG).pk, "META")).toMatchObject({ revision: 4, locks: "broken" });
    expect(await writeRepairedLocks(deps, { orgId: ORG, actor: ADMIN, expectedRevision: 4, previousDigest: "", locks: { noSoleOwnerException: true }, defaulted: [] })).toBe(true);
  });

  it("M3: the repair is refused without the audit ledger and writes nothing", async () => {
    const h = harness({ audit: false });
    h.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: 1, locks: "broken", updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    expect(await code(repairUnreadableLocks(h.deps, who(ADMIN), { requestId: A, expectedRevision: 1 }))).toBe("AUDIT_UNAVAILABLE");
    expect(h.db.get(setupLocksKey(ORG).pk, "META")).toMatchObject({ revision: 1, locks: "broken" });
  });

  it("M3: a row whose revision is not a number is repaired against the row as stored", async () => {
    const h = harness();
    h.db.set({ ...setupLocksKey(ORG), entityType: "SETUP_LOCKS", orgId: ORG, revision: "x", locks: {}, updatedBy: ADMIN, updatedAt: NOW.toISOString() });
    expect((await getCompanyLocksView(h.deps, who(ADMIN))).body).toMatchObject({ unreadable: true, revision: null });
    expect((await repairUnreadableLocks(h.deps, who(ADMIN), { requestId: A, expectedRevision: null })).body).toMatchObject({ status: "repaired", revision: 1 });
  });

  it("L5: a request made against another revision than the current one is stale before anything is merged", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 50 } });
    for (const expectedRevision of [null, 0, 2]) expect(await code(setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision, limits: { commands: 40 } })), String(expectedRevision)).toBe("CHANGE_STALE");
    expect((await readCompanyLocks(h.deps, ORG))?.revision).toBe(1);
  });

  it("L6: a request that tightens one lock and loosens another applies the stricter part at once and parks the looser part", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { commands: 40, hostAsks: 3 }, setupAgentOff: true });
    // commands lowered (stricter), hostAsks raised (looser), setupAgentOff turned off (looser), devcontainerImages added (stricter).
    const mixed = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, limits: { commands: 30, hostAsks: 6 }, setupAgentOff: false, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] });
    expect(mixed.statusCode).toBe(202);
    expect(mixed.body).toMatchObject({ status: "needs_second_admin", appliedNow: true, limits: { commands: 30, hostAsks: 3 }, setupAgentOff: true, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"], pending: { limits: { commands: 30, hostAsks: 6 }, setupAgentOff: false } });
    expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual({ limits: { commands: 30, hostAsks: 3 }, setupAgentOff: true, devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] });
    expect(h.capture.recorded().map((event) => event.action)).toEqual(["setup.locks_changed", "setup.locks_changed", "setup.locks_change_proposed"]);
    // A request that only loosens applies nothing now.
    const only = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: C, expectedRevision: 3, setupAgentOff: false });
    expect(only.body).toMatchObject({ status: "needs_second_admin", appliedNow: false });
  });

  it("L6: splitting is field by field and limit by limit", () => {
    const current = { limits: { commands: 40, hostAsks: 3, spendUsd: 2 }, setupAgentOff: true as const, devcontainerImages: ["a/b:1"] };
    const next = { limits: { commands: 30, hostAsks: 6 }, devcontainerImages: ["a/b:1", "c/d:2"] };
    expect(splitLoosening(current, next)).toEqual({ loosen: true, tighten: { limits: { commands: 30, hostAsks: 3, spendUsd: 2 }, setupAgentOff: true, devcontainerImages: ["a/b:1"] } });
    expect(splitLoosening(current, { ...current, limits: { commands: 30, hostAsks: 3, spendUsd: 2 } })).toEqual({ loosen: false, tighten: { ...current, limits: { commands: 30, hostAsks: 3, spendUsd: 2 } } });
    expect(splitLoosening(undefined, next)).toEqual({ loosen: false, tighten: next });
  });

  it("L7: a waiting loosening expires after 24 hours: it is not offered and cannot be approved", async () => {
    const h = harness();
    await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, setupAgentOff: true });
    const loosen = await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: B, expectedRevision: 1, setupAgentOff: false });
    const digest = (loosen.body as { pending: { digest: string } }).pending.digest;
    h.clock.now = new Date(NOW.getTime() + 24 * 3_600_000 - 1000);
    h.sessions.set("s-d", { developerId: SECOND, authTime: new Date(h.clock.now.getTime() - 60_000).toISOString() });
    expect((await getCompanyLocksView(h.deps, who(SECOND))).body).toHaveProperty("pending");
    h.clock.now = new Date(NOW.getTime() + 24 * 3_600_000 + 1000);
    h.sessions.set("s-d", { developerId: SECOND, authTime: new Date(h.clock.now.getTime() - 60_000).toISOString() });
    expect((await getCompanyLocksView(h.deps, who(SECOND))).body).not.toHaveProperty("pending");
    expect(await code(approveCompanyLockSettings(h.deps, who(SECOND), { requestId: C, expectedRevision: 2, expectedDigest: digest }))).toBe("CHANGE_STALE");
    expect((await readCompanyLocks(h.deps, ORG))?.locks.setupAgentOff).toBe(true);
  });

  it("L8: a lock write whose event does not make exactly one audit item writes nothing", async () => {
    const h = harness();
    const bad = { action: "locks_changed" as const, orgId: ORG, actor: "not a person id with\nnewline", at: NOW.toISOString(), proof: "fresh_sign_in" as const, revision: 1, previousDigest: "0".repeat(64), nextDigest: "1".repeat(64), loosened: false };
    expect(await code(h.deps.store.commitLocks({ orgId: ORG, revision: 1, locks: {}, updatedBy: ADMIN, updatedAt: NOW.toISOString() }, null, { ...bad, actor: "x".repeat(300) }, []))).toBe("AUDIT_UNAVAILABLE");
    expect(await h.deps.store.getLocks(ORG)).toBeUndefined();
  });

  it("L9: the spend lock goes down to one cent, in whole cents, with a message that says so", async () => {
    const h = harness();
    expect((await setCompanyLockSettings(h.deps, who(ADMIN), { requestId: A, expectedRevision: null, limits: { budgetCents: 1 } })).body).toMatchObject({ limits: { budgetCents: 1 } });
    expect((await readCompanyLocks(h.deps, ORG))?.locks.limits).toEqual({ spendUsd: 0.01 });
    const direct = (await import("../../packages/broker/src/org/setup-recipes.js")).CompanySetupLocksSchema;
    expect(direct.safeParse({ limits: { spendUsd: 0.01 } }).success).toBe(true);
    expect(direct.safeParse({ limits: { spendUsd: 0.005 } }).success).toBe(false);
    expect(direct.safeParse({ limits: { spendUsd: 0 } }).success).toBe(false);
    let message = "";
    try { await h.deps.store.getLocks(ORG); const { setCompanyLocks } = await import("../../packages/broker/src/org/setup-recipes.js"); await setCompanyLocks(h.deps, { orgId: ORG, developerId: ADMIN, sessionId: "s-a" }, { locks: { limits: { spendUsd: 0.005 } }, expectedRevision: 1 }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("The spend limit must be from $0.01 to $20, in whole cents.");
  });

});
