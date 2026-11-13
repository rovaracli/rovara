import { describe, expect, it } from "vitest";
import { AuditEventInputSchema, ROLLOUT_FEATURE_CATALOG, ROLLOUT_FEATURE_NAMES, orgFeatureRolloutKey } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { FEATURE_ROLLOUT_PER_MINUTE, routeFeatureRollout } from "../../packages/broker/src/aws/developer-routes/feature-rollout.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes/types.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { companyGatedEnv } from "../../packages/broker/src/org/feature-rollout.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// TE-A1 authorization: who may read and change a company's rollout gates, what a change needs first, that nothing of another company is seen or touched, and that a change reaches the readers at once.

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PATH = "/v1/app/org/feature-rollout";
const START = Date.UTC(2026, 10, 13, 9, 0, 0);
type Env = Record<string, string | undefined>;
interface Row { name: string; label: string; enabled: boolean; installOn: boolean; wired: boolean }
interface Answer { revision: number; features: Row[]; changedAt?: string }
interface Stored { revision: number; gates: Record<string, boolean>; changedBy?: string }

function world(options: { ledger?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db });
  const clock = { at: START };
  const deps = { documentClient: db, tableName: "state", now: () => clock.at, developer: { signInTableName: "state" }, ...(options.ledger === false ? {} : { audit: capture.audit }) } as unknown as DeveloperRouteDependencies;
  const caller = (orgId: OrgId, role: DeveloperCaller["orgRole"] = "owner", extra: { browser?: boolean } = {}): DeveloperCaller => ({
    developerId: (role === "owner" ? "a" : role === "admin" ? "b" : "c").repeat(64), sessionId: `session-${orgId}-${role}`, amr: "oidc", name: "Maya", orgId, orgRole: role,
    ...(extra.browser === false ? {} : { browserSession: true as const }),
  });
  const signIn = (who: DeveloperCaller, minutesAgo: number | undefined) => db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", ...(minutesAgo === undefined ? {} : { authTime: new Date(clock.at - minutesAgo * 60_000).toISOString() }) });
  const call = (who: DeveloperCaller, method: string, body?: unknown, env: Env = {}, path = PATH) => {
    const request: AdaptedHttpRequest = { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    return routeFeatureRollout(deps, who, request, path, env) as Promise<Answer>;
  };
  const stored = (orgId: OrgId) => db.get(orgFeatureRolloutKey(orgId)) as Stored | undefined;
  return { db, capture, clock, deps, caller, signIn, call, stored };
}
const rowOf = (answer: Answer, name: string): Row => answer.features.find((row) => row.name === name)!;
const EVENT = "company.feature_rollout_changed";

describe("who may use the route", () => {
  it("refuses a member on both methods, and changes nothing", async () => {
    const w = world();
    const member = w.caller(ORG_A, "member");
    w.signIn(member, 0);
    await expect(w.call(member, "GET")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call(member, "PUT", { expectedRevision: 0, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.stored(ORG_A)).toBeUndefined();
    expect(w.capture.recordedBy(EVENT)).toEqual([]);
  });

  it("answers an owner and an admin", async () => {
    const w = world();
    for (const role of ["owner", "admin"] as const) {
      const who = w.caller(ORG_A, role);
      w.signIn(who, 0);
      expect(await w.call(who, "GET")).toMatchObject({ revision: 0 });
    }
  });

  it("refuses a caller that is not a live browser session, on both methods", async () => {
    const w = world();
    const token = w.caller(ORG_A, "owner", { browser: false });
    w.signIn(token, 0);
    await expect(w.call(token, "GET")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call(token, "PUT", { expectedRevision: 0, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.stored(ORG_A)).toBeUndefined();
  });

  it("ignores another path and refuses a method it does not take", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    expect(await w.call(owner, "GET", undefined, {}, "/v1/app/org/other")).toBeUndefined();
    for (const method of ["POST", "DELETE", "PATCH"]) await expect(w.call(owner, method, { expectedRevision: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET", () => {
  it("is each gate at its catalog default (the four existing features on, the three new ones off), all in catalog order, and says whether the install lets each take effect", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const answer = await w.call(owner, "GET", undefined, { PROOF_EVIDENCE_ENABLED: "1", VERIFY_RESULTS_ENABLED: "true" });
    expect(answer.revision).toBe(0);
    expect(answer.changedAt).toBeUndefined();
    expect(answer.features.map((row) => row.name)).toEqual([...ROLLOUT_FEATURE_NAMES]);
    expect(ROLLOUT_FEATURE_CATALOG.map((entry) => entry.name)).toEqual([...ROLLOUT_FEATURE_NAMES]);
    expect(answer.features.filter((row) => row.enabled).map((row) => row.name)).toEqual(["proofEvidence", "verifyResults", "testEnvironment", "testServices"]);
    expect(rowOf(answer, "proofEvidence").installOn).toBe(true);
    expect(rowOf(answer, "verifyResults").installOn).toBe(false);
    expect(rowOf(answer, "testEnvironment").installOn).toBe(false);
  });
});

describe("PUT", () => {
  it("needs a fresh sign-in, and changes nothing without one", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const body = { expectedRevision: 0, features: { proofEvidence: true } };
    for (const age of [11, 60, undefined]) {
      w.signIn(owner, age);
      await expect(w.call(owner, "PUT", body), String(age)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    w.db.delete(`SESSION#${owner.sessionId}`, "META");
    await expect(w.call(owner, "PUT", body)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(w.stored(ORG_A)).toBeUndefined();
    expect(w.capture.recordedBy(EVENT)).toEqual([]);
    w.signIn(owner, 9);
    expect(await w.call(owner, "PUT", body)).toMatchObject({ revision: 1 });
  });

  it("turns gates on and off again, merges what it names, stores only what was pressed, and writes one audit event per change", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 1);
    const first = await w.call(owner, "PUT", { expectedRevision: 0, features: { sealedChecks: true, verifyResults: false } });
    expect(first.revision).toBe(1);
    expect(rowOf(first, "sealedChecks").enabled).toBe(true);
    expect(rowOf(first, "verifyResults").enabled).toBe(false);
    expect(rowOf(first, "testServices").enabled).toBe(true);
    const second = await w.call(owner, "PUT", { expectedRevision: 1, features: { verifyResults: true, honestCi: true, sealedChecks: false } });
    expect(second.revision).toBe(2);
    expect(second.features.filter((row) => row.enabled).map((row) => row.name)).toEqual(["proofEvidence", "verifyResults", "testEnvironment", "testServices", "honestCi"]);
    expect(w.stored(ORG_A)).toMatchObject({ revision: 2, changedBy: owner.developerId });
    expect(w.stored(ORG_A)?.gates).toEqual({ sealedChecks: false, verifyResults: true, honestCi: true });
    const events = w.capture.recordedBy(EVENT);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ orgId: ORG_A, actor: { id: owner.developerId }, target: { kind: "org", id: ORG_A }, facts: { revision: 1, turnedOn: "sealedChecks", turnedOff: "verifyResults" } });
    expect(events[1]).toMatchObject({ facts: { revision: 2, turnedOn: "verifyResults+honestCi", turnedOff: "sealedChecks" } });
    for (const event of events) expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
    expect(await w.call(owner, "GET")).toEqual(second);
  });

  it("salts the audit occurrence with the time of the change: a row deleted and started again at revision 1 is a new event, not an old one", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, features: { sealedChecks: true } });
    w.db.delete(orgFeatureRolloutKey(ORG_A).pk, orgFeatureRolloutKey(ORG_A).sk);
    w.clock.at += 5_000;
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, features: { sealedChecks: true } });
    const events = w.capture.recordedBy(EVENT);
    expect(events).toHaveLength(2);
    expect(events[0]!.eventId).not.toBe(events[1]!.eventId);
  });

  it("writes the audit event in the same transaction as the change: no ledger, no change", async () => {
    const w = world({ ledger: false });
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await expect(w.call(owner, "PUT", { expectedRevision: 0, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(w.stored(ORG_A)).toBeUndefined();
  });

  it("refuses a gate name outside the closed list, and any other field, without storing anything or repeating what was sent", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    const bodies: unknown[] = [
      { expectedRevision: 0, features: { secretInput: true } }, { expectedRevision: 0, features: { proofEvidence: true, billing: true } }, { expectedRevision: 0, features: { __proto__x: true } },
      { expectedRevision: 0, features: { proofEvidence: "yes" } }, { expectedRevision: 0, features: { proofEvidence: 1 } }, { expectedRevision: 0, features: [] }, { expectedRevision: 0, features: null },
      { expectedRevision: 0, features: { proofEvidence: true }, orgId: ORG_B }, { expectedRevision: 0, features: { proofEvidence: true }, previews: true },
      { features: { proofEvidence: true } }, { expectedRevision: -1, features: { proofEvidence: true } }, { expectedRevision: 0.5, features: { proofEvidence: true } },
      { expectedRevision: 0 }, { expectedRevision: 0, features: {} }, { expectedRevision: 0, features: { proofEvidence: undefined } }, [], "all", null,
    ];
    for (const body of bodies) {
      const error = await w.call(owner, "PUT", body).catch((caught: unknown) => caught as Error);
      expect(error, JSON.stringify(body)).toMatchObject({ code: "CONFIG_INVALID" });
      expect((error as Error).message).not.toContain("secretInput");
    }
    expect(w.stored(ORG_A)).toBeUndefined();
    expect(w.capture.recordedBy(EVENT)).toEqual([]);
  });

  it("takes null for a name: the stored choice is removed (back to the default), and audited as the change people get", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, features: { proofEvidence: false, verifyResults: true } });
    const back = await w.call(owner, "PUT", { expectedRevision: 1, features: { proofEvidence: null } });
    expect(rowOf(back, "proofEvidence").enabled).toBe(true);
    expect(w.stored(ORG_A)?.gates).toEqual({ verifyResults: true });
    expect(w.capture.recordedBy(EVENT)[1]).toMatchObject({ facts: { revision: 2, turnedOn: "proofEvidence", turnedOff: "none" } });
  });

  it("is fenced by the revision: a stale write is CHANGE_STALE and changes nothing", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    const admin = w.caller(ORG_A, "admin");
    w.signIn(owner, 0); w.signIn(admin, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, features: { proofEvidence: false } });
    await expect(w.call(admin, "PUT", { expectedRevision: 0, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(w.call(admin, "PUT", { expectedRevision: 5, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.stored(ORG_A)).toMatchObject({ revision: 1, gates: { proofEvidence: false } });
    expect(w.capture.recordedBy(EVENT)).toHaveLength(1);
    expect(await w.call(admin, "PUT", { expectedRevision: 1, features: { proofEvidence: true } })).toMatchObject({ revision: 2 });
  });

  it("lets only one of two racing writes win", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    const results = await Promise.allSettled([w.call(owner, "PUT", { expectedRevision: 0, features: { proofEvidence: true } }), w.call(owner, "PUT", { expectedRevision: 0, features: { testServices: true } })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(w.stored(ORG_A)).toMatchObject({ revision: 1 });
    expect(w.capture.recordedBy(EVENT)).toHaveLength(1);
  });

  it("writing the value already in force still moves the revision and is audited", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    await w.call(owner, "PUT", { expectedRevision: 0, features: { proofEvidence: true } });
    expect((await w.call(owner, "PUT", { expectedRevision: 1, features: { proofEvidence: true } })).revision).toBe(2);
    expect(w.capture.recordedBy(EVENT)[1]).toMatchObject({ facts: { revision: 2, turnedOn: "none", turnedOff: "none" } });
  });

  it("is rate limited for the whole company", async () => {
    const w = world();
    const owner = w.caller(ORG_A);
    w.signIn(owner, 0);
    for (let i = 0; i < FEATURE_ROLLOUT_PER_MINUTE; i += 1) await w.call(owner, "PUT", { expectedRevision: i, features: { proofEvidence: i % 2 === 0 } });
    await expect(w.call(owner, "PUT", { expectedRevision: FEATURE_ROLLOUT_PER_MINUTE, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    w.clock.at += 61_000;
    w.signIn(owner, 0);
    expect(await w.call(owner, "PUT", { expectedRevision: FEATURE_ROLLOUT_PER_MINUTE, features: { proofEvidence: true } })).toMatchObject({ revision: FEATURE_ROLLOUT_PER_MINUTE + 1 });
  });
});

describe("tenancy", () => {
  it("never reads or touches another company's gates, whatever the caller sends", async () => {
    const w = world();
    const a = w.caller(ORG_A), b = w.caller(ORG_B);
    w.signIn(a, 0); w.signIn(b, 0);
    await w.call(a, "PUT", { expectedRevision: 0, features: { proofEvidence: false, sealedChecks: true } });
    // A sees its own choice, and B sees none of it.
    expect(await w.call(a, "GET")).toMatchObject({ revision: 1 });
    expect(rowOf(await w.call(a, "GET"), "proofEvidence").enabled).toBe(false);
    expect(await w.call(b, "GET")).toMatchObject({ revision: 0 });
    expect(rowOf(await w.call(b, "GET"), "proofEvidence").enabled).toBe(true);
    expect(rowOf(await w.call(b, "GET"), "sealedChecks").enabled).toBe(false);
    // B naming A in the body is refused (no company field is accepted); naming a revision of A's row writes B's row, never A's.
    await expect(w.call(b, "PUT", { expectedRevision: 1, orgId: ORG_A, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.call(b, "PUT", { expectedRevision: 1, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await w.call(b, "PUT", { expectedRevision: 0, features: { verifyResults: false } })).toMatchObject({ revision: 1 });
    expect(w.stored(ORG_A)).toMatchObject({ revision: 1, gates: { proofEvidence: false, sealedChecks: true }, changedBy: a.developerId });
    expect(w.stored(ORG_B)?.gates).toEqual({ verifyResults: false });
    expect(w.capture.recordedBy(EVENT).map((event) => event.orgId)).toEqual([ORG_A, ORG_B]);
  });

  it("an admin of one company who is a member of another gets only the company the caller is acting in", async () => {
    const w = world();
    const adminA = w.caller(ORG_A, "admin"), memberB = w.caller(ORG_B, "member");
    w.signIn(adminA, 0); w.signIn(memberB, 0);
    await w.call(adminA, "PUT", { expectedRevision: 0, features: { proofEvidence: false } });
    await expect(w.call(memberB, "GET")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.call(memberB, "PUT", { expectedRevision: 0, features: { proofEvidence: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.stored(ORG_B)).toBeUndefined();
  });
});

describe("a change reaches the readers at once", () => {
  const ON = { PROOF_EVIDENCE_ENABLED: "1", VERIFY_RESULTS_ENABLED: "1", TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
  it("turning a gate off, then back, changes the next read for that company only", async () => {
    const w = world();
    const a = w.caller(ORG_A);
    w.signIn(a, 0);
    const store = { documentClient: w.db, tableName: "state", now: () => w.clock.at };
    expect((await companyGatedEnv(store, ORG_A, ON)).PROOF_EVIDENCE_ENABLED).toBe("1");
    await w.call(a, "PUT", { expectedRevision: 0, features: { proofEvidence: false } });
    expect((await companyGatedEnv(store, ORG_A, ON)).PROOF_EVIDENCE_ENABLED).toBe("0");
    expect((await companyGatedEnv(store, ORG_B, ON)).PROOF_EVIDENCE_ENABLED).toBe("1");
    expect((await companyGatedEnv(store, ORG_A, ON)).VERIFY_RESULTS_ENABLED).toBe("1");
    await w.call(a, "PUT", { expectedRevision: 1, features: { proofEvidence: true } });
    expect((await companyGatedEnv(store, ORG_A, ON)).PROOF_EVIDENCE_ENABLED).toBe("1");
  });
});

describe("a row that cannot be read", () => {
  const seed = (w: ReturnType<typeof world>, revision: unknown) => w.db.set({ ...orgFeatureRolloutKey(ORG_A), entityType: "FEATURE_ROLLOUT", orgId: ORG_A, gates: { proofEvidence: true, testServices: true }, ...(revision === undefined ? {} : { revision }) });

  it("reads every gate as off and lets the admin replace it with their next change", async () => {
    for (const revision of [undefined, 0, "3", 1.5, null]) {
      const w = world();
      const owner = w.caller(ORG_A);
      w.signIn(owner, 0);
      seed(w, revision);
      expect((await w.call(owner, "GET")).features.filter((row) => row.enabled), String(revision)).toEqual([]);
      const written = await w.call(owner, "PUT", { expectedRevision: 0, features: { verifyResults: true } });
      expect(written, String(revision)).toMatchObject({ revision: 1 });
      expect(w.stored(ORG_A)?.gates, String(revision)).toEqual({ verifyResults: true });
    }
  });
});
