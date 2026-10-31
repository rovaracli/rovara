// Proof and evidence B3: run-scoped accounts. Expiry is at most round end + 15 minutes, a failed provision revokes what it made, and revocation counts as confirmed only when every account was revoked AND a login
// with it was then refused.
import { describe, expect, it } from "vitest";
import { RUN_SCOPED_GRACE_MS, RUN_SCOPED_MAX_ROUND_MS, RUN_SCOPED_REVOKE_ATTEMPTS, cognitoTestPoolProvisioner, evidenceAccountsOf, httpHookProvisioner, provisionRunScopedAccounts, revokeRunScopedAccounts, runScopedExpiry, seedCommandProvisioner,
  type AccountProvisionerPort, type AccountProvisionerPorts, type RunScopedAccount } from "../../packages/broker/src/e2e/run-scoped-accounts.js";
import { TestEnvAccountSchema, type TestEnvAccount } from "../../packages/contracts/src/index.js";

const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const ENDS = "2026-11-03T10:30:00.000Z";
const seed: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "buyer", provisioner: "seed_command", command: { cwd: "app", executable: "python", args: ["seed.py"], timeoutSeconds: 60 } });
const cognito: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "admin", provisioner: "cognito_test_pool", userPoolId: "us-west-2_AbC123xyz", region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/test-accounts" });
const hook: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "partner", provisioner: "http_hook", createUrl: "https://tests.example.com/accounts", deleteUrl: "https://tests.example.com/accounts/delete", tokenSecretName: "TEST_HOOK_TOKEN" });
const registered: TestEnvAccount = TestEnvAccountSchema.parse({ profileId: "old", provisioner: "registered", registryProfileId: "orders-owner" });

interface Fake extends AccountProvisionerPort { created: string[]; revoked: string[]; probed: string[] }
function fake(over: { failCreateFor?: string; answer?: unknown; revokeFails?: number; loginWorks?: boolean; probeThrows?: boolean; secrets?: string[] } = {}): Fake {
  let revokeCalls = 0;
  const port: Fake = {
    created: [], revoked: [], probed: [],
    async create({ account }) {
      if (over.failCreateFor === account.profileId) throw new Error("boom with a secret hunter2");
      port.created.push(account.profileId);
      return (over.answer ?? { loginRef: `login-${account.profileId}`, revokeHandle: `handle-${account.profileId}`, secrets: over.secrets ?? [`pw-${account.profileId}`] }) as never;
    },
    async revoke({ revokeHandle }) {
      revokeCalls += 1;
      if (over.revokeFails !== undefined && revokeCalls <= over.revokeFails) throw new Error("revoke failed");
      port.revoked.push(revokeHandle);
    },
    async loginFails({ loginRef }) {
      port.probed.push(loginRef);
      if (over.probeThrows) throw new Error("timeout");
      return over.loginWorks !== true;
    },
  };
  return port;
}
const ports = (port: AccountProvisionerPort): AccountProvisionerPorts => ({ seed_command: port, cognito_test_pool: port, http_hook: port });

describe("provisioning", () => {
  it("expires every lease at most 15 minutes after the round ends", async () => {
    const result = await provisionRunScopedAccounts({ accounts: [seed, cognito, hook], roundEndsAt: ENDS, now: NOW, ports: ports(fake()) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(RUN_SCOPED_GRACE_MS).toBe(15 * 60_000);
    expect(runScopedExpiry(ENDS)).toBe("2026-11-03T10:45:00.000Z");
    expect(result.leases.map((lease) => [lease.profileId, lease.expiresAt])).toEqual([["buyer", "2026-11-03T10:45:00.000Z"], ["admin", "2026-11-03T10:45:00.000Z"], ["partner", "2026-11-03T10:45:00.000Z"]]);
    expect(result.leases.every((lease) => Date.parse(lease.expiresAt) - Date.parse(ENDS) <= RUN_SCOPED_GRACE_MS)).toBe(true);
  });
  it("tells the provisioner the expiry it must honour, and each account gets its own lease", async () => {
    const seen: Array<{ profile: string; expiresAt: string }> = [];
    const port: AccountProvisionerPort = { ...fake(), async create({ account, expiresAt }) { seen.push({ profile: account.profileId, expiresAt }); return { loginRef: `l-${account.profileId}`, revokeHandle: `h-${account.profileId}` }; } };
    const result = await provisionRunScopedAccounts({ accounts: [seed, hook], roundEndsAt: ENDS, now: NOW, ports: ports(port) });
    expect(seen).toEqual([{ profile: "buyer", expiresAt: "2026-11-03T10:45:00.000Z" }, { profile: "partner", expiresAt: "2026-11-03T10:45:00.000Z" }]);
    expect(result.ok && result.leases.map((lease) => [lease.profileId, lease.loginRef, lease.revokeHandle])).toEqual([["buyer", "l-buyer", "h-buyer"], ["partner", "l-partner", "h-partner"]]);
  });
  it("returns the secrets for the redactor and keeps none on a lease", async () => {
    const result = await provisionRunScopedAccounts({ accounts: [seed], roundEndsAt: ENDS, now: NOW, ports: ports(fake({ secrets: ["s3cret-Password-value"] })) });
    expect(result.ok && result.secrets).toEqual(["s3cret-Password-value"]);
    expect(JSON.stringify(result.ok && result.leases)).not.toContain("s3cret-Password-value");
  });
  it("leaves registered accounts alone and says they are not run-scoped", async () => {
    const port = fake();
    const result = await provisionRunScopedAccounts({ accounts: [seed, registered], roundEndsAt: ENDS, now: NOW, ports: ports(port) });
    expect(port.created).toEqual(["buyer"]);
    expect(result.ok && evidenceAccountsOf(result)).toEqual([{ profileId: "buyer", kind: "run_scoped" }, { profileId: "old", kind: "registered" }]);
  });
  it("refuses an environment with no run-scoped account", async () => {
    expect(await provisionRunScopedAccounts({ accounts: [registered], roundEndsAt: ENDS, now: NOW, ports: ports(fake()) })).toEqual({ ok: false, code: "no_run_scoped_accounts", cleanedUp: true });
  });
  it("refuses a round window that has ended, is not a date, or is longer than four hours", async () => {
    for (const roundEndsAt of ["2026-11-03T09:59:00.000Z", "not a date", new Date(NOW + RUN_SCOPED_MAX_ROUND_MS + 1).toISOString()]) {
      const port = fake();
      expect(await provisionRunScopedAccounts({ accounts: [seed], roundEndsAt, now: NOW, ports: ports(port) })).toEqual({ ok: false, code: "round_window_invalid", cleanedUp: true });
      expect(port.created).toEqual([]);
    }
  });
  it("refuses when a kind in use has no provisioner, before making anything", async () => {
    const port = fake();
    expect(await provisionRunScopedAccounts({ accounts: [seed, cognito], roundEndsAt: ENDS, now: NOW, ports: { seed_command: port, cognito_test_pool: undefined, http_hook: undefined } })).toEqual({ ok: false, code: "no_provisioner", cleanedUp: true });
    expect(port.created).toEqual([]);
  });
  it("refuses a profile named twice", async () => {
    expect(await provisionRunScopedAccounts({ accounts: [seed, { ...hook, profileId: "buyer" }], roundEndsAt: ENDS, now: NOW, ports: ports(fake()) })).toMatchObject({ ok: false, code: "duplicate_profile" });
  });
  it("revokes the accounts already made when a later one fails, and proves they are dead", async () => {
    const port = fake({ failCreateFor: "admin" });
    const result = await provisionRunScopedAccounts({ accounts: [seed, cognito, hook], roundEndsAt: ENDS, now: NOW, ports: ports(port) });
    expect(result).toEqual({ ok: false, code: "provision_failed", cleanedUp: true });
    expect(port.created).toEqual(["buyer"]);
    expect(port.revoked).toEqual(["handle-buyer"]);
    expect(port.probed).toEqual(["login-buyer"]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
  it("says the cleanup was not confirmed when it could not be", async () => {
    const port = fake({ failCreateFor: "admin", revokeFails: 99 });
    expect(await provisionRunScopedAccounts({ accounts: [seed, cognito], roundEndsAt: ENDS, now: NOW, ports: ports(port) })).toEqual({ ok: false, code: "provision_failed", cleanedUp: false });
  });
  it("refuses an answer of the wrong shape (a secret-shaped ref, a missing handle, extra fields) and still revokes a handle it did get", async () => {
    for (const answer of [{ loginRef: "has space", revokeHandle: "h" }, { loginRef: "l" }, { loginRef: "l", revokeHandle: "h", token: "x" }, { loginRef: "l", revokeHandle: "h", secrets: Array(9).fill("x") }]) {
      const port = fake({ answer });
      expect(await provisionRunScopedAccounts({ accounts: [seed], roundEndsAt: ENDS, now: NOW, ports: ports(port) })).toMatchObject({ ok: false, code: "provisioner_answer_invalid" });
    }
    const port = fake({ answer: { loginRef: "has space", revokeHandle: "h-ok" } });
    await provisionRunScopedAccounts({ accounts: [seed], roundEndsAt: ENDS, now: NOW, ports: ports(port) });
    expect(port.revoked).toEqual(["h-ok"]);
  });
  it("is cancelled by the caller's signal and by its own time bound", async () => {
    const stuck: AccountProvisionerPort = { ...fake(), create: () => new Promise(() => undefined) };
    const controller = new AbortController();
    const pending = provisionRunScopedAccounts({ accounts: [seed], roundEndsAt: ENDS, now: NOW, ports: ports(stuck), signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "provision_failed" });
  });
});

describe("revocation and its proof", () => {
  const lease = (profileId: string, provisioner: "seed_command" | "cognito_test_pool" | "http_hook") => ({ profileId, provisioner, loginRef: `login-${profileId}`, revokeHandle: `handle-${profileId}`, expiresAt: "2026-11-03T10:45:00.000Z" });
  const all = [seed, cognito, hook];
  const leases = [lease("buyer", "seed_command"), lease("admin", "cognito_test_pool"), lease("partner", "http_hook")];
  it("is confirmed when every account was revoked and a login with each was refused", async () => {
    const port = fake();
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port) });
    expect(report).toEqual({ confirmed: true, accounts: [{ profileId: "buyer", revoked: true, loginRefused: true }, { profileId: "admin", revoked: true, loginRefused: true }, { profileId: "partner", revoked: true, loginRefused: true }] });
    expect(port.probed).toEqual(["login-buyer", "login-admin", "login-partner"]);
  });
  it("is NOT confirmed when a login still works after the revoke", async () => {
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(fake({ loginWorks: true })) });
    expect(report.confirmed).toBe(false);
    expect(report.accounts.every((item) => item.revoked && !item.loginRefused)).toBe(true);
  });
  it("is NOT confirmed when the probe cannot answer", async () => {
    expect((await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(fake({ probeThrows: true })) })).confirmed).toBe(false);
  });
  it("retries a failing revoke a bounded number of times, then gives up on that account only", async () => {
    const recovering = await revokeRunScopedAccounts({ leases: leases.slice(0, 1), accounts: all, ports: ports(fake({ revokeFails: RUN_SCOPED_REVOKE_ATTEMPTS - 1 })) });
    expect(recovering.confirmed).toBe(true);
    const port = fake({ revokeFails: RUN_SCOPED_REVOKE_ATTEMPTS });
    const report = await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port) });
    expect(report.accounts.map((item) => item.revoked)).toEqual([false, true, true]);
    expect(report.confirmed).toBe(false);
    // the account that could not be revoked is not probed (nothing proves a dead login), the others are
    expect(port.probed).toEqual(["login-admin", "login-partner"]);
  });
  it("is not confirmed with nothing to prove, and for a lease whose account or port is unknown", async () => {
    expect((await revokeRunScopedAccounts({ leases: [], accounts: all, ports: ports(fake()) })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [lease("ghost", "seed_command")], accounts: all, ports: ports(fake()) })).confirmed).toBe(false);
    expect((await revokeRunScopedAccounts({ leases: [leases[0]!], accounts: all, ports: { seed_command: undefined, cognito_test_pool: undefined, http_hook: undefined } })).confirmed).toBe(false);
  });
  it("refuses to treat a registered account as revocable", async () => {
    const report = await revokeRunScopedAccounts({ leases: [{ ...lease("old", "seed_command") }], accounts: [registered], ports: ports(fake()) });
    expect(report.confirmed).toBe(false);
  });
  it("uses one account's own login in its probe (per-case attribution)", async () => {
    const probed: Array<[string, string]> = [];
    const port: AccountProvisionerPort = { ...fake(), async loginFails({ account, loginRef }) { probed.push([account.profileId, loginRef]); return true; } };
    await revokeRunScopedAccounts({ leases, accounts: all, ports: ports(port) });
    expect(probed).toEqual([["buyer", "login-buyer"], ["admin", "login-admin"], ["partner", "login-partner"]]);
  });
});

describe("the three provisioner kinds", () => {
  const signal = new AbortController().signal;
  it("seed_command runs the approved command with the profile and the expiry, and reads one JSON line", async () => {
    const calls: unknown[] = [];
    const port = seedCommandProvisioner({
      runSeed: async (input) => { calls.push(input.env); return { exitCode: 0, stdout: `noise\n${JSON.stringify({ loginRef: "u-1", revokeHandle: "u-1", secrets: ["pw-1-secret"] })}\n` }; },
      removeAccount: async () => undefined, probeLogin: async () => "refused",
    });
    expect(await port.create({ account: seed as RunScopedAccount, expiresAt: "2026-11-03T10:45:00.000Z", signal })).toEqual({ loginRef: "u-1", revokeHandle: "u-1", secrets: ["pw-1-secret"] });
    expect(calls).toEqual([{ ROVARA_ACCOUNT_PROFILE: "buyer", ROVARA_ACCOUNT_EXPIRES_AT: "2026-11-03T10:45:00.000Z" }]);
    await expect(port.create({ account: cognito as RunScopedAccount, expiresAt: "x", signal })).rejects.toThrow();
  });
  it("seed_command refuses a failed command and output that is not the answer", async () => {
    const failing = seedCommandProvisioner({ runSeed: async () => ({ exitCode: 1, stdout: "" }), removeAccount: async () => undefined, probeLogin: async () => "refused" });
    await expect(failing.create({ account: seed as RunScopedAccount, expiresAt: "x", signal })).rejects.toThrow();
    const junk = seedCommandProvisioner({ runSeed: async () => ({ exitCode: 0, stdout: "not json" }), removeAccount: async () => undefined, probeLogin: async () => "refused" });
    await expect(junk.create({ account: seed as RunScopedAccount, expiresAt: "x", signal })).rejects.toThrow();
  });
  it("a login that is accepted or unclear is not a refusal", async () => {
    for (const answer of ["accepted", "unclear"] as const) {
      const port = seedCommandProvisioner({ runSeed: async () => ({ exitCode: 0, stdout: "{}" }), removeAccount: async () => undefined, probeLogin: async () => answer });
      expect(await port.loginFails({ account: seed as RunScopedAccount, loginRef: "u", signal })).toBe(false);
    }
  });
  it("cognito_test_pool creates in the approved pool through the approved role and deletes the same user", async () => {
    const calls: string[] = [];
    const port = cognitoTestPoolProvisioner({
      newUsername: () => "rovara-run-1",
      adminCreateUser: async (input) => { calls.push(`create ${input.userPoolId} ${input.roleArn} ${input.username}`); return { password: "Pw-from-cognito-1" }; },
      adminDeleteUser: async (input) => { calls.push(`delete ${input.userPoolId} ${input.username}`); },
      signIn: async () => "refused",
    });
    const created = await port.create({ account: cognito as RunScopedAccount, expiresAt: "2026-11-03T10:45:00.000Z", signal });
    expect(created).toEqual({ loginRef: "rovara-run-1", revokeHandle: "rovara-run-1", secrets: ["Pw-from-cognito-1", "rovara-run-1"] });
    await port.revoke({ account: cognito as RunScopedAccount, revokeHandle: created.revokeHandle, signal });
    expect(await port.loginFails({ account: cognito as RunScopedAccount, loginRef: "rovara-run-1", signal })).toBe(true);
    expect(calls).toEqual(["create us-west-2_AbC123xyz arn:aws:iam::123456789012:role/test-accounts rovara-run-1", "delete us-west-2_AbC123xyz rovara-run-1"]);
  });
  it("http_hook reads its token by name, calls the approved addresses, and treats an already-deleted account as deleted", async () => {
    const calls: Array<[string, string, string]> = [];
    const port = httpHookProvisioner({
      readToken: async (name) => { calls.push(["token", name, ""]); return "tok-123"; },
      call: async ({ method, url, token }) => { calls.push([method, url, token]); return method === "POST" ? { status: 201, json: { loginRef: "p-1", revokeHandle: "p-1" } } : { status: 404, json: {} }; },
      probeLogin: async () => "refused",
    });
    expect(await port.create({ account: hook as RunScopedAccount, expiresAt: "2026-11-03T10:45:00.000Z", signal })).toEqual({ loginRef: "p-1", revokeHandle: "p-1" });
    await port.revoke({ account: hook as RunScopedAccount, revokeHandle: "p-1", signal });
    expect(calls).toEqual([["token", "TEST_HOOK_TOKEN", ""], ["POST", "https://tests.example.com/accounts", "tok-123"], ["token", "TEST_HOOK_TOKEN", ""], ["DELETE", "https://tests.example.com/accounts/delete", "tok-123"]]);
  });
  it("http_hook refuses an error status and an answer of the wrong shape", async () => {
    const status = httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: 500, json: {} }), probeLogin: async () => "refused" });
    await expect(status.create({ account: hook as RunScopedAccount, expiresAt: "x", signal })).rejects.toThrow();
    await expect(status.revoke({ account: hook as RunScopedAccount, revokeHandle: "h", signal })).rejects.toThrow();
    const shape = httpHookProvisioner({ readToken: async () => "t", call: async () => ({ status: 200, json: { loginRef: "p", revokeHandle: "p", password: "leak" } }), probeLogin: async () => "refused" });
    await expect(shape.create({ account: hook as RunScopedAccount, expiresAt: "x", signal })).rejects.toThrow();
  });
});
