// Proof and evidence B3 (and fix round 1, Opus review C1 and I3): run-scoped accounts. Expiry is at most round end + 15 minutes. A revocation counts as confirmed only when the account's sessions were ended,
// it was revoked, an existence probe says it is gone AND replaying a credential the round really held is refused; where the replay cannot run, publication is held for the token lifetime. Leases are durable
// before the account exists, and a sweeper revokes what a crash left behind.
import { describe, expect, it } from "vitest";
import { RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS, RUN_SCOPED_GRACE_MS, RUN_SCOPED_MAX_ROUND_MS, RUN_SCOPED_REVOKE_ATTEMPTS, cognitoTestPoolProvisioner, evidenceAccountsOf, httpHookProvisioner, maxTokenTtlOf, provisionRunScopedAccounts, revocationSettledAt,
  revokeRunScopedAccounts, runScopedExpiry, seedCommandProvisioner, sessionStateOfStatus, sweepRunScopedLeases,
  type AccountPresence, type AccountProvisionerPort, type AccountProvisionerPorts, type LeaseRecord, type LeaseStore, type RunScopedAccount, type RunScopedLease, type SessionCredential, type SessionState } from "../../packages/broker/src/e2e/run-scoped-accounts.js";
import { TestEnvAccountSchema, type TestEnvAccount } from "../../packages/contracts/src/index.js";

const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const ENDS = "2026-11-03T10:30:00.000Z";
const seed: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "buyer", provisioner: "seed_command", command: { cwd: "app", executable: "python", args: ["seed.py"], timeoutSeconds: 60 } });
const cognito: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "admin", provisioner: "cognito_test_pool", userPoolId: "us-west-2_AbC123xyz", region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/test-accounts" });
const hook: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "partner", provisioner: "http_hook", createUrl: "https://tests.example.com/accounts", deleteUrl: "https://tests.example.com/accounts/delete", tokenSecretName: "TEST_HOOK_TOKEN" });
const registered: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "old", provisioner: "registered", registryProfileId: "orders-owner" });
const COOKIE: SessionCredential = { kind: "cookie", value: "round-session-cookie-value-1" };
const BEARER: SessionCredential = { kind: "bearer", value: "round-bearer-token-value-2" };

function memoryStore(failPut = false): LeaseStore & { records: Map<string, LeaseRecord>; log: string[] } {
  const records = new Map<string, LeaseRecord>(); const log: string[] = [];
  return { records, log,
    async put(record) { if (failPut) throw new Error("table down"); log.push(`put ${record.state}`); records.set(record.leaseId, structuredClone(record)); },
    async update(leaseId, patch) { log.push(`update ${JSON.stringify(patch)}`); const current = records.get(leaseId); if (current) records.set(leaseId, { ...current, ...patch }); },
    async listOutstanding() { return [...records.values()].filter((record) => record.state !== "revoked").map((record) => structuredClone(record)); } };
}
let counter = 0;
const newLeaseId = () => `rvl-test-${String((counter += 1)).padStart(8, "0")}`;

interface Fake extends AccountProvisionerPort { calls: string[]; sessionsOf: Map<string, "live" | "ended">; accounts: Set<string> }
function fake(over: { failCreateFor?: string; createdBeforeFailing?: boolean; answer?: unknown; endFails?: number; revokeFails?: number; presence?: AccountPresence; replay?: SessionState | ((c: SessionCredential) => SessionState); noReplay?: boolean; replayThrows?: boolean; secrets?: string[] } = {}): Fake {
  let endCalls = 0; let revokeCalls = 0;
  const port: Fake = {
    calls: [], sessionsOf: new Map(), accounts: new Set(),
    async create({ account, leaseId }) {
      port.calls.push(`create ${account.profileId} ${leaseId}`);
      if (over.failCreateFor === account.profileId) { if (over.createdBeforeFailing) port.accounts.add(leaseId); throw new Error("boom with a secret hunter2"); }
      port.accounts.add(leaseId); port.sessionsOf.set(leaseId, "live");
      return (over.answer ?? { loginRef: `login-${account.profileId}`, revokeHandle: leaseId, secrets: over.secrets ?? [`pw-${account.profileId}`] }) as never;
    },
    async endSessions({ revokeHandle }) {
      endCalls += 1; port.calls.push(`end ${revokeHandle}`);
      if (over.endFails !== undefined && endCalls <= over.endFails) throw new Error("end failed");
      port.sessionsOf.set(revokeHandle, "ended");
    },
    async revoke({ revokeHandle }) {
      revokeCalls += 1; port.calls.push(`revoke ${revokeHandle}`);
      if (over.revokeFails !== undefined && revokeCalls <= over.revokeFails) throw new Error("revoke failed");
      port.accounts.delete(revokeHandle);
    },
    async accountExists({ revokeHandle }) { port.calls.push(`exists ${revokeHandle}`); return over.presence ?? (port.accounts.has(revokeHandle) ? "present" : "gone"); },
  };
  if (!over.noReplay) {
    port.sessionState = async ({ credential }) => {
      port.calls.push(`replay ${credential.kind}`);
      if (over.replayThrows) throw new Error("network");
      const answer = over.replay ?? "dead";
      return typeof answer === "function" ? answer(credential) : answer;
    };
  }
  return port;
}
const ports = (port: AccountProvisionerPort): AccountProvisionerPorts => ({ seed_command: port, cognito_test_pool: port, http_hook: port });
const provision = (accounts: TestEnvAccount[], port: AccountProvisionerPort, over: Partial<Parameters<typeof provisionRunScopedAccounts>[0]> = {}) => provisionRunScopedAccounts({ accounts, roundId: "round-1", roundEndsAt: ENDS, now: NOW, ports: ports(port), store: memoryStore(), newLeaseId, ...over });

describe("provisioning", () => {
  it("expires every lease at most 15 minutes after the round ends", async () => {
    const result = await provision([seed, cognito, hook], fake());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(RUN_SCOPED_GRACE_MS).toBe(15 * 60_000);
    expect(runScopedExpiry(ENDS)).toBe("2026-11-03T10:45:00.000Z");
    expect(result.leases.map((lease) => [lease.profileId, lease.expiresAt])).toEqual([["buyer", "2026-11-03T10:45:00.000Z"], ["admin", "2026-11-03T10:45:00.000Z"], ["partner", "2026-11-03T10:45:00.000Z"]]);
    expect(result.leases.every((lease) => Date.parse(lease.expiresAt) - Date.parse(ENDS) <= RUN_SCOPED_GRACE_MS)).toBe(true);
  });
  it("tells the provisioner the expiry it must honour and the lease id to use as the account's handle", async () => {
    const seen: Array<{ profile: string; expiresAt: string; leaseId: string }> = [];
    const port: AccountProvisionerPort = { ...fake(), async create({ account, expiresAt, leaseId }) { seen.push({ profile: account.profileId, expiresAt, leaseId }); return { loginRef: `l-${account.profileId}`, revokeHandle: `h-${account.profileId}` }; } };
    const result = await provision([seed, hook], port);
    expect(seen.map((item) => [item.profile, item.expiresAt])).toEqual([["buyer", "2026-11-03T10:45:00.000Z"], ["partner", "2026-11-03T10:45:00.000Z"]]);
    expect(seen.every((item) => /^rvl-/u.test(item.leaseId))).toBe(true);
    expect(result.ok && result.leases.map((lease) => [lease.profileId, lease.loginRef, lease.revokeHandle])).toEqual([["buyer", "l-buyer", "h-buyer"], ["partner", "l-partner", "h-partner"]]);
  });
  it("returns the secrets for the redactor and keeps none on a lease or a record", async () => {
    const store = memoryStore();
    const result = await provision([seed], fake({ secrets: ["s3cret-Password-value"] }), { store });
    expect(result.ok && result.secrets).toEqual(["s3cret-Password-value"]);
    expect(JSON.stringify(result.ok && result.leases)).not.toContain("s3cret-Password-value");
    expect(JSON.stringify([...store.records.values()])).not.toContain("s3cret-Password-value");
  });
  it("leaves registered accounts alone and says they are not run-scoped", async () => {
    const port = fake();
    const result = await provision([seed, registered], port);
    expect(port.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    expect(result.ok && evidenceAccountsOf(result)).toEqual([{ profileId: "buyer", kind: "run_scoped" }, { profileId: "old", kind: "registered" }]);
  });
  it("refuses an environment with no run-scoped account", async () => {
    expect(await provision([registered], fake())).toEqual({ ok: false, code: "no_run_scoped_accounts", cleanedUp: true });
  });
  it("refuses a round window that has ended, is not a date, or is longer than four hours", async () => {
    for (const roundEndsAt of ["2026-11-03T09:59:00.000Z", "not a date", new Date(NOW + RUN_SCOPED_MAX_ROUND_MS + 1).toISOString()]) {
      const port = fake();
      expect(await provision([seed], port, { roundEndsAt })).toEqual({ ok: false, code: "round_window_invalid", cleanedUp: true });
      expect(port.calls).toEqual([]);
    }
  });
  it("refuses when a kind in use has no provisioner, before making anything", async () => {
    const port = fake();
    expect(await provisionRunScopedAccounts({ accounts: [seed, cognito], roundId: "r", roundEndsAt: ENDS, now: NOW, ports: { seed_command: port, cognito_test_pool: undefined, http_hook: undefined }, store: memoryStore(), newLeaseId }))
      .toEqual({ ok: false, code: "no_provisioner", cleanedUp: true });
    expect(port.calls).toEqual([]);
  });
  it("refuses a profile named twice", async () => {
    expect(await provision([seed, { ...hook, profileId: "buyer" }], fake())).toMatchObject({ ok: false, code: "duplicate_profile" });
  });
  it("revokes the accounts already made when a later one fails, ending their sessions and proving them gone", async () => {
    const port = fake({ failCreateFor: "admin" });
    const result = await provision([seed, cognito, hook], port);
    expect(result).toEqual({ ok: false, code: "provision_failed", cleanedUp: true });
    expect(port.calls.filter((call) => call.startsWith("create"))).toHaveLength(2);
    expect([...port.accounts]).toEqual([]);
    expect(port.calls.filter((call) => call.startsWith("end"))).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
  it("revokes by the lease id an account that was made before its create call failed (a timeout)", async () => {
    const port = fake({ failCreateFor: "admin", createdBeforeFailing: true });
    const result = await provision([cognito], port);
    expect(result).toEqual({ ok: false, code: "provision_failed", cleanedUp: true });
    expect([...port.accounts]).toEqual([]);
    expect(port.calls.some((call) => /^revoke rvl-/u.test(call))).toBe(true);
  });
  it("says the cleanup was not confirmed when it could not be", async () => {
    const port = fake({ failCreateFor: "admin", revokeFails: 99 });
    expect(await provision([seed, cognito], port)).toEqual({ ok: false, code: "provision_failed", cleanedUp: false });
  });
  it("refuses an answer of the wrong shape and still revokes the handle it did get", async () => {
    for (const answer of [{ loginRef: "has space", revokeHandle: "h" }, { loginRef: "l" }, { loginRef: "l", revokeHandle: "h", token: "x" }, { loginRef: "l", revokeHandle: "h", secrets: Array(9).fill("x") }]) {
      expect(await provision([seed], fake({ answer }))).toMatchObject({ ok: false, code: "provisioner_answer_invalid" });
    }
    const port = fake({ answer: { loginRef: "has space", revokeHandle: "h-ok" } });
    await provision([seed], port);
    expect(port.calls).toContain("revoke h-ok");
  });
  it("is cancelled by the caller's signal", async () => {
    const stuck: AccountProvisionerPort = { ...fake(), create: () => new Promise(() => undefined) };
    const controller = new AbortController();
    const pending = provision([seed], stuck, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "provision_failed" });
  });
});

describe("durable leases (I3)", () => {
  it("writes the lease record BEFORE the account exists, and marks it active once it does", async () => {
    const store = memoryStore();
    const order: string[] = [];
    const port: AccountProvisionerPort = { ...fake(), async create({ leaseId }) { order.push(`create saw ${store.records.get(leaseId)?.state}`); return { loginRef: "l", revokeHandle: "h" }; } };
    await provision([seed], port, { store });
    expect(order).toEqual(["create saw creating"]);
    expect([...store.records.values()][0]).toMatchObject({ state: "active", revokeHandle: "h", loginRef: "l", profileId: "buyer", provisioner: "seed_command", roundId: "round-1", expiresAt: "2026-11-03T10:45:00.000Z" });
    expect(store.log[0]).toBe("put creating");
  });
  it("creates nothing when the lease cannot be written, and cleans up what an earlier account made", async () => {
    const port = fake();
    expect(await provision([seed], port, { store: memoryStore(true) })).toEqual({ ok: false, code: "lease_store_failed", cleanedUp: true });
    expect(port.calls).toEqual([]);
    const store = memoryStore();
    let puts = 0;
    const flaky: LeaseStore = { ...store, put: async (record) => { puts += 1; if (puts === 2) throw new Error("table down"); await store.put(record); } };
    const port2 = fake();
    expect(await provision([seed, hook], port2, { store: flaky })).toEqual({ ok: false, code: "lease_store_failed", cleanedUp: true });
    expect([...port2.accounts]).toEqual([]);
  });
  it("refuses a lease id of the wrong shape (it becomes a remote handle)", async () => {
    expect(await provision([seed], fake(), { newLeaseId: () => "not a lease id" })).toMatchObject({ ok: false, code: "lease_store_failed" });
  });
  it("marks a fully revoked lease revoked", async () => {
    const store = memoryStore(); const port = fake();
    const result = await provision([seed], port, { store });
    if (!result.ok) throw new Error("provision");
    await revokeRunScopedAccounts({ leases: result.leases, accounts: [seed], ports: ports(port), store, now: NOW, sessions: new Map([["buyer", [COOKIE]]]) });
    expect([...store.records.values()][0]?.state).toBe("revoked");
  });
  it("sweeps expired leases a crash left behind, and leaves a round that may still be running alone", async () => {
    const store = memoryStore(); const port = fake();
    const first = await provision([seed], port, { store });
    const second = await provision([hook], port, { store, roundEndsAt: "2026-11-03T12:00:00.000Z" });
    if (!first.ok || !second.ok) throw new Error("provision");
    // the first round's broker died; a sweep after its expiry revokes it, and not the second round's
    const result = await sweepRunScopedLeases({ store, ports: ports(port), now: Date.parse("2026-11-03T10:46:00.000Z") });
    expect(result).toEqual({ swept: [first.leases[0]!.leaseId], stuck: [] });
    expect(port.accounts.has(first.leases[0]!.revokeHandle)).toBe(false);
    expect(port.accounts.has(second.leases[0]!.revokeHandle)).toBe(true);
    expect(port.sessionsOf.get(first.leases[0]!.revokeHandle)).toBe("ended");
    const later = await sweepRunScopedLeases({ store, ports: ports(port), now: Date.parse("2026-11-03T12:20:00.000Z") });
    expect(later.swept).toEqual([second.leases[0]!.leaseId]);
    expect((await store.listOutstanding())).toEqual([]);
  });
  it("sweeps a lease still in `creating` (the create call never returned) by the lease id", async () => {
    const store = memoryStore(); const port = fake({ failCreateFor: "buyer", createdBeforeFailing: true });
    const record: LeaseRecord = { leaseId: "rvl-orphan-0001", roundId: "r", profileId: "buyer", provisioner: "seed_command", account: seed as RunScopedAccount, state: "creating", revokeHandle: "rvl-orphan-0001", createdAt: ENDS, expiresAt: "2026-11-03T10:45:00.000Z" };
    await store.put(record); port.accounts.add("rvl-orphan-0001");
    expect(await sweepRunScopedLeases({ store, ports: ports(port), now: NOW + 3_600_000 })).toEqual({ swept: ["rvl-orphan-0001"], stuck: [] });
    expect(port.accounts.size).toBe(0);
  });
  it("reports a lease it cannot clear as stuck (for the alarm), and tries it again next sweep", async () => {
    const store = memoryStore();
    const failing = fake({ revokeFails: 99 });
    const result = await provision([seed], fake(), { store });
    if (!result.ok) throw new Error("provision");
    const sweep = await sweepRunScopedLeases({ store, ports: ports(failing), now: NOW + 3_600_000 });
    expect(sweep).toEqual({ swept: [], stuck: [result.leases[0]!.leaseId] });
    expect((await store.listOutstanding())).toHaveLength(1);
    expect((await sweepRunScopedLeases({ store, ports: { seed_command: undefined, cognito_test_pool: undefined, http_hook: undefined }, now: NOW + 3_600_000 })).stuck).toHaveLength(1);
  });
  it("does not clear a lease whose account still exists after the revoke", async () => {
    const store = memoryStore();
    const result = await provision([seed], fake(), { store });
    if (!result.ok) throw new Error("provision");
    expect((await sweepRunScopedLeases({ store, ports: ports(fake({ presence: "present" })), now: NOW + 3_600_000 })).stuck).toHaveLength(1);
  });
  it("survives a store that cannot list", async () => {
    const store: LeaseStore = { put: async () => undefined, update: async () => undefined, listOutstanding: async () => { throw new Error("down"); } };
    expect(await sweepRunScopedLeases({ store, ports: ports(fake()), now: NOW })).toEqual({ swept: [], stuck: [] });
  });
});

describe("revocation and its proof (C1)", () => {
  const all = [seed, cognito, hook];
  const lease = (profileId: string, provisioner: RunScopedLease["provisioner"]): RunScopedLease => ({ leaseId: `rvl-${profileId}-0001`, profileId, provisioner, loginRef: `login-${profileId}`, revokeHandle: `rvl-${profileId}-0001`, expiresAt: "2026-11-03T10:45:00.000Z" });
  const leases = [lease("buyer", "seed_command"), lease("admin", "cognito_test_pool"), lease("partner", "http_hook")];
  const sessions = new Map<string, SessionCredential[]>([["buyer", [COOKIE]], ["admin", [BEARER]], ["partner", [COOKIE, BEARER]]]);
  const live = (port: Fake) => { for (const item of leases) { port.accounts.add(item.revokeHandle); port.sessionsOf.set(item.revokeHandle, "live"); } return port; };

  it("is confirmed when sessions were ended, every account revoked and gone, and every replayed credential was refused", async () => {
    const port = live(fake());
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.confirmed).toBe(true);
    expect(report.heldUntil).toBeUndefined();
    expect(report.accounts).toEqual(["buyer", "admin", "partner"].map((profileId) => ({ profileId, sessionsEnded: true, revoked: true, accountGone: true, sessionProof: "dead" })));
    expect(port.calls.filter((call) => call.startsWith("replay"))).toHaveLength(4);
  });
  it("ends the sessions BEFORE the account is deleted, and replays only after it is gone", async () => {
    const port = live(fake());
    await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(port), now: NOW, sessions });
    expect(port.calls).toEqual(["end rvl-buyer-0001", "revoke rvl-buyer-0001", "exists rvl-buyer-0001", "replay cookie"]);
  });
  it("is NOT confirmed when a replayed credential still works, and waiting never settles it", async () => {
    const port = live(fake({ replay: (credential) => (credential.kind === "bearer" ? "alive" : "dead") }));
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.confirmed).toBe(false);
    expect(report.accounts.map((item) => item.sessionProof)).toEqual(["dead", "alive", "alive"]);
    expect(revocationSettledAt(report, NOW + 10 * RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS)).toBe(false);
  });
  it("a replayed credential that works blocks the whole report even when another account earns a hold, and waiting out that hold never settles it", async () => {
    const port = live(fake({ replay: (credential) => (credential.kind === "bearer" ? "alive" : "dead") }));
    // buyer: dead; admin: alive (bearer); partner has no credential kept, so a hold is earned
    const mixed = new Map<string, SessionCredential[]>([["buyer", [COOKIE]], ["admin", [BEARER]]]);
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions: mixed, maxTokenTtlMs: 600_000 });
    expect(report.accounts.map((item) => item.sessionProof)).toEqual(["dead", "alive", "not_possible"]);
    expect(report.heldUntil).toBe("2026-11-03T10:10:00.000Z");
    expect(report.confirmed).toBe(false);
    expect(revocationSettledAt(report, NOW + 600_000)).toBe(false);
  });
  it("is NOT confirmed when the existence probe says the account is still there or cannot say", async () => {
    for (const presence of ["present", "unclear"] as const) {
      const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(live(fake({ presence }))), now: NOW, sessions });
      expect(report.confirmed, presence).toBe(false);
      expect(report.accounts.every((item) => item.revoked && !item.accountGone)).toBe(true);
    }
  });
  it("is NOT confirmed when the sessions could not be ended, however the rest went, and is not held (waiting does not end a server-side session)", async () => {
    const port = live(fake({ endFails: 99 }));
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.confirmed).toBe(false);
    expect(report.accounts.every((item) => !item.sessionsEnded)).toBe(true);
    expect(report.heldUntil).toBeUndefined();
    expect(revocationSettledAt(report, NOW + 10 * RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS)).toBe(false);
  });
  it("holds publication until the longest token lifetime has passed when the session probe cannot run", async () => {
    const cases: Array<[string, Fake, ReadonlyMap<string, SessionCredential[]>]> = [
      ["no replay endpoint", live(fake({ noReplay: true })), sessions],
      ["no credential kept", live(fake()), new Map()],
      ["the probe cannot say", live(fake({ replay: "unclear" })), sessions],
      ["the probe throws", live(fake({ replayThrows: true })), sessions],
    ];
    for (const [name, port, kept] of cases) {
      const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions: kept, maxTokenTtlMs: 3_600_000 });
      expect(report.confirmed, name).toBe(false);
      expect(report.heldUntil, name).toBe("2026-11-03T11:00:00.000Z");
      expect(revocationSettledAt(report, Date.parse("2026-11-03T10:59:59.000Z")), name).toBe(false);
      expect(revocationSettledAt(report, Date.parse("2026-11-03T11:00:00.000Z")), name).toBe(true);
    }
  });
  it("holds for the longest token lifetime of the DAY when the environment does not say, and clamps what it does say", async () => {
    const report = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake({ noReplay: true }))), now: NOW });
    expect(report.heldUntil).toBe(new Date(NOW + RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS).toISOString());
    expect(maxTokenTtlOf(undefined)).toBe(RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS);
    expect(maxTokenTtlOf(Number.NaN)).toBe(RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS);
    expect(maxTokenTtlOf(10)).toBe(60_000);
    expect(maxTokenTtlOf(10 * RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS)).toBe(RUN_SCOPED_DEFAULT_MAX_TOKEN_TTL_MS);
  });
  it("only asks for a hold when everything else is proven, and a mixed report holds for the accounts it could not replay", async () => {
    const partial = new Map<string, SessionCredential[]>([["buyer", [COOKIE]]]);
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(live(fake())), now: NOW, sessions: partial, maxTokenTtlMs: 600_000 });
    expect(report.accounts.map((item) => item.sessionProof)).toEqual(["dead", "not_possible", "not_possible"]);
    expect(report.confirmed).toBe(false);
    expect(report.heldUntil).toBe("2026-11-03T10:10:00.000Z");
    expect(revocationSettledAt(report, NOW + 600_000)).toBe(true);
  });
  it("retries a failing revoke a bounded number of times, then gives up on that account only", async () => {
    const recovering = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(live(fake({ revokeFails: RUN_SCOPED_REVOKE_ATTEMPTS - 1 }))), now: NOW, sessions });
    expect(recovering.confirmed).toBe(true);
    const port = live(fake({ revokeFails: RUN_SCOPED_REVOKE_ATTEMPTS }));
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port), now: NOW, sessions });
    expect(report.accounts.map((item) => item.revoked)).toEqual([false, true, true]);
    expect(report.confirmed).toBe(false);
    // the account that could not be revoked is neither probed for existence nor replayed
    expect(port.calls.filter((call) => call.startsWith("exists")).length).toBe(2);
    expect(report.accounts[0]?.sessionProof).toBe("not_possible");
  });
  it("is not confirmed with nothing to prove, and for a lease whose account or port is unknown, and a registered account is never revocable", async () => {
    expect((await revokeRunScopedAccounts({ leases: [], accounts: all, ports: ports(fake()), now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [lease("ghost", "seed_command")], accounts: all, ports: ports(fake()), now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [leases[0]!], accounts: all, ports: { seed_command: undefined, cognito_test_pool: undefined, http_hook: undefined }, now: NOW })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [lease("old", "seed_command")], accounts: [registered], ports: ports(fake()), now: NOW })).confirmed).toBe(false);
  });
  it("replays each account's OWN credentials (per-case attribution) and at most three of them", async () => {
    const replayed: Array<[string, string]> = [];
    const port = live(fake());
    port.sessionState = async ({ account, credential }) => { replayed.push([account.profileId, credential.value]); return "dead"; };
    const many = new Map<string, SessionCredential[]>([["buyer", [COOKIE, BEARER, { kind: "cookie", value: "third-value-3" }, { kind: "cookie", value: "fourth-value-4" }]], ["admin", [BEARER]]]);
    await revokeRunScopedAccounts({ leases: leases.slice(0, 2), accounts: all, ports: ports(port), now: NOW, sessions: many });
    expect(replayed).toEqual([["buyer", COOKIE.value], ["buyer", BEARER.value], ["buyer", "third-value-3"], ["admin", BEARER.value]]);
  });
  it("reads an HTTP status from a replayed credential: 401 and 403 are dead, 2xx and 3xx alive, the rest proves nothing", () => {
    expect([401, 403].map(sessionStateOfStatus)).toEqual(["dead", "dead"]);
    expect([200, 204, 302].map(sessionStateOfStatus)).toEqual(["alive", "alive", "alive"]);
    expect([404, 429, 500, 503, undefined].map(sessionStateOfStatus)).toEqual(["unclear", "unclear", "unclear", "unclear", "unclear"]);
  });
  it("does not settle a report with no account, one with an account missing a part, or a malformed hold", () => {
    expect(revocationSettledAt({ confirmed: false, accounts: [] }, NOW)).toBe(false);
    const part = { profileId: "a", sessionsEnded: true, revoked: true, accountGone: true };
    expect(revocationSettledAt({ confirmed: false, accounts: [{ ...part, sessionProof: "not_possible" }], heldUntil: "garbage" }, NOW + 1e12)).toBe(false);
    expect(revocationSettledAt({ confirmed: false, accounts: [{ ...part, sessionProof: "not_possible" }] }, NOW + 1e12)).toBe(false);
    expect(revocationSettledAt({ confirmed: false, accounts: [{ ...part, accountGone: false, sessionProof: "dead" }] }, NOW)).toBe(false);
  });
});

describe("the three provisioner kinds", () => {
  const signal = new AbortController().signal;
  it("seed_command runs the approved command with the profile, the lease id and the expiry, and reads one JSON line", async () => {
    const calls: unknown[] = [];
    const port = seedCommandProvisioner({
      runSeed: async (input) => { calls.push(input.env); return { exitCode: 0, stdout: `noise\n${JSON.stringify({ loginRef: "u-1", revokeHandle: "u-1", secrets: ["pw-1-secret"] })}\n` }; },
      endSessions: async () => undefined, removeAccount: async () => undefined, accountExists: async () => "gone",
    });
    expect(await port.create({ account: seed as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "2026-11-03T10:45:00.000Z", signal })).toEqual({ loginRef: "u-1", revokeHandle: "u-1", secrets: ["pw-1-secret"] });
    expect(calls).toEqual([{ ROVARA_ACCOUNT_PROFILE: "buyer", ROVARA_ACCOUNT_LEASE: "rvl-aaaaaaaa", ROVARA_ACCOUNT_EXPIRES_AT: "2026-11-03T10:45:00.000Z" }]);
    await expect(port.create({ account: cognito as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "x", signal })).rejects.toThrow();
    expect("sessionState" in port).toBe(false);
  });
  it("seed_command refuses a failed command and output that is not the answer", async () => {
    const base = { endSessions: async () => undefined, removeAccount: async () => undefined, accountExists: async () => "gone" as const };
    await expect(seedCommandProvisioner({ ...base, runSeed: async () => ({ exitCode: 1, stdout: "" }) }).create({ account: seed as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "x", signal })).rejects.toThrow();
    await expect(seedCommandProvisioner({ ...base, runSeed: async () => ({ exitCode: 0, stdout: "not json" }) }).create({ account: seed as RunScopedAccount, leaseId: "rvl-aaaaaaaa", expiresAt: "x", signal })).rejects.toThrow();
  });
  it("gives a port a session probe only when the environment supplied a replay", () => {
    const base = { runSeed: async () => ({ exitCode: 0, stdout: "{}" }), endSessions: async () => undefined, removeAccount: async () => undefined, accountExists: async () => "gone" as const };
    expect("sessionState" in seedCommandProvisioner({ ...base, replaySession: async () => "dead" })).toBe(true);
    expect("sessionState" in seedCommandProvisioner(base)).toBe(false);
  });
  it("cognito_test_pool uses the lease id as the username, signs the user out everywhere before deleting, and proves with AdminGetUser", async () => {
    const calls: string[] = [];
    const port = cognitoTestPoolProvisioner({
      adminCreateUser: async (input) => { calls.push(`create ${input.userPoolId} ${input.roleArn} ${input.username}`); return { password: "Pw-from-cognito-1" }; },
      adminUserGlobalSignOut: async (input) => { calls.push(`signout ${input.username}`); },
      adminDeleteUser: async (input) => { calls.push(`delete ${input.userPoolId} ${input.username}`); },
      adminGetUser: async (input) => { calls.push(`get ${input.username}`); return "not_found"; },
      replaySession: async () => "dead",
    });
    const created = await port.create({ account: cognito as RunScopedAccount, leaseId: "rvl-cognito-1", expiresAt: "2026-11-03T10:45:00.000Z", signal });
    expect(created).toEqual({ loginRef: "rvl-cognito-1", revokeHandle: "rvl-cognito-1", secrets: ["Pw-from-cognito-1", "rvl-cognito-1"] });
    await port.endSessions({ account: cognito as RunScopedAccount, revokeHandle: created.revokeHandle, signal });
    await port.revoke({ account: cognito as RunScopedAccount, revokeHandle: created.revokeHandle, signal });
    expect(await port.accountExists({ account: cognito as RunScopedAccount, revokeHandle: created.revokeHandle, signal })).toBe("gone");
    expect(calls).toEqual(["create us-west-2_AbC123xyz arn:aws:iam::123456789012:role/test-accounts rvl-cognito-1", "signout rvl-cognito-1", "delete us-west-2_AbC123xyz rvl-cognito-1", "get rvl-cognito-1"]);
  });
  it("cognito_test_pool reads AdminGetUser honestly: an existing user is present, an unclear answer is unclear", async () => {
    const answer = (value: "exists" | "unclear") => cognitoTestPoolProvisioner({ adminCreateUser: async () => ({ password: "x" }), adminUserGlobalSignOut: async () => undefined, adminDeleteUser: async () => undefined, adminGetUser: async () => value });
    expect(await answer("exists").accountExists({ account: cognito as RunScopedAccount, revokeHandle: "h", signal })).toBe("present");
    expect(await answer("unclear").accountExists({ account: cognito as RunScopedAccount, revokeHandle: "h", signal })).toBe("unclear");
  });
  it("http_hook follows its protocol: create with the lease id, end sessions, delete, and a 404 on GET is the existence proof", async () => {
    const calls: Array<[string, string, string, unknown]> = [];
    const status = new Map<string, number>([["GET", 404]]);
    const port = httpHookProvisioner({
      readToken: async () => "tok-123",
      call: async ({ method, url, token, body }) => { calls.push([method, url, token, body]); return method === "POST" && url.endsWith("/accounts") ? { status: 201, json: { loginRef: "p-1", revokeHandle: "p-1" } } : { status: status.get(method) ?? 200, json: {} }; },
    });
    const account = hook as RunScopedAccount;
    expect(await port.create({ account, leaseId: "rvl-hook-0001", expiresAt: "2026-11-03T10:45:00.000Z", signal })).toEqual({ loginRef: "p-1", revokeHandle: "p-1" });
    await port.endSessions({ account, revokeHandle: "p-1", signal });
    await port.revoke({ account, revokeHandle: "p-1", signal });
    expect(await port.accountExists({ account, revokeHandle: "p-1", signal })).toBe("gone");
    expect(calls).toEqual([
      ["POST", "https://tests.example.com/accounts", "tok-123", { profile: "partner", leaseId: "rvl-hook-0001", expiresAt: "2026-11-03T10:45:00.000Z" }],
      ["POST", "https://tests.example.com/accounts/delete", "tok-123", { action: "end_sessions", revokeHandle: "p-1" }],
      ["DELETE", "https://tests.example.com/accounts/delete", "tok-123", { revokeHandle: "p-1" }],
      ["GET", "https://tests.example.com/accounts/p-1", "tok-123", undefined],
    ]);
  });
  it("http_hook treats a 404 on end-sessions and delete as already gone, reads a 2xx GET as present, and anything else as unclear", async () => {
    const respond = (code: number) => httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: code, json: {} }) });
    const account = hook as RunScopedAccount;
    await expect(respond(404).endSessions({ account, revokeHandle: "h", signal })).resolves.toBeUndefined();
    await expect(respond(404).revoke({ account, revokeHandle: "h", signal })).resolves.toBeUndefined();
    expect(await respond(200).accountExists({ account, revokeHandle: "h", signal })).toBe("present");
    expect(await respond(500).accountExists({ account, revokeHandle: "h", signal })).toBe("unclear");
  });
  it("http_hook refuses an error status and an answer of the wrong shape", async () => {
    const account = hook as RunScopedAccount;
    const status = httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: 500, json: {} }) });
    await expect(status.create({ account, leaseId: "rvl-hook-0001", expiresAt: "x", signal })).rejects.toThrow();
    await expect(status.revoke({ account, revokeHandle: "h", signal })).rejects.toThrow();
    await expect(status.endSessions({ account, revokeHandle: "h", signal })).rejects.toThrow();
    const shape = httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: 200, json: { loginRef: "p", revokeHandle: "p", password: "leak" } }) });
    await expect(shape.create({ account, leaseId: "rvl-hook-0001", expiresAt: "x", signal })).rejects.toThrow();
  });
});
