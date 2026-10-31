// Proof and evidence B3: run-scoped test accounts. For each browser/API round the environment's account provisioner makes FRESH accounts that die with the round, so a trace or a video kept as evidence
// holds only credentials that no longer work (design 3.4). This module is the lifecycle and nothing else: it provisions, bounds the expiry, revokes, and PROVES the revocation by one failed login per
// account. The result of that proof (`confirmed`) is what lets the evidence pack publish a video or a trace; a pack never gets it from the worker.
//
// Everything that touches the outside world (the sandbox, a Cognito test pool, the customer's hook) is an injected port, so this file has no network, no AWS SDK and no clock of its own. A real
// binding to a customer's account is deployed and called through the deploy lane's staging wrapper only.
//
// Rules, all fail closed:
//   - a lease expires at most `RUN_SCOPED_GRACE_MS` after the round ends, and never in the past;
//   - one account failing to provision revokes the ones already made and refuses the round's media;
//   - revocation is confirmed only when the revoke call returned AND a login with the dead account was then refused. A probe that cannot say (it threw, timed out) is "not confirmed";
//   - nothing secret is kept on a lease: the secrets a provisioner returns go to the caller's redactor list and nowhere else; refs are short plain identifiers.
import { z } from "zod";
import { provisionerIsRunScoped, TestEnvAccountSchema, type TestEnvAccount } from "@agentx/contracts";

/** A lease may outlive its round by at most this long (design 3.4: round end + 15 minutes). */
export const RUN_SCOPED_GRACE_MS = 15 * 60_000;
/** A round longer than this is refused: an account that lives longer than a working session is not run-scoped. */
export const RUN_SCOPED_MAX_ROUND_MS = 4 * 3_600_000;
/** Each port call is given this long. */
export const RUN_SCOPED_CALL_MS = 30_000;
/** A revoke is tried this many times before it counts as failed. */
export const RUN_SCOPED_REVOKE_ATTEMPTS = 3;
const SECRETS_MAX = 8;
const SECRET_MAX_LENGTH = 512;

export type RunScopedProvisioner = "seed_command" | "cognito_test_pool" | "http_hook";
export type RunScopedAccount = Exclude<TestEnvAccount, { provisioner: "registered" }>;

/** The ports one provisioner kind needs. All three kinds share this shape. */
export interface AccountProvisionerPort {
  /** Makes a fresh account that must not be usable after `expiresAt`. `secrets` are the values the account's login holds (password, token): they are handed to the redactor, never kept. */
  create(input: { account: RunScopedAccount; expiresAt: string; signal: AbortSignal }): Promise<Created>;
  /** Deletes or disables the account. Resolves when the provisioner says it is gone. */
  revoke(input: { account: RunScopedAccount; revokeHandle: string; signal: AbortSignal }): Promise<void>;
  /** One login attempt with the account. True only when the login was REFUSED; anything else (it worked, or the answer is unclear) is false. */
  loginFails(input: { account: RunScopedAccount; loginRef: string; signal: AbortSignal }): Promise<boolean>;
}
export type AccountProvisionerPorts = Readonly<Record<RunScopedProvisioner, AccountProvisionerPort | undefined>>;

const REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/u;
type Created = { loginRef: string; revokeHandle: string; secrets?: string[] | undefined };
const CreatedSchema = z.object({ loginRef: z.string().regex(REF), revokeHandle: z.string().regex(REF), secrets: z.array(z.string().min(1).max(SECRET_MAX_LENGTH)).max(SECRETS_MAX).optional() }).strict();

export interface RunScopedLease {
  profileId: string;
  provisioner: RunScopedProvisioner;
  loginRef: string;
  revokeHandle: string;
  expiresAt: string;
}

/** Fixed reasons, never a provisioner's or an error's own words. */
export const RUN_SCOPED_FAILURES = ["no_run_scoped_accounts", "round_window_invalid", "no_provisioner", "provision_failed", "provisioner_answer_invalid", "duplicate_profile"] as const;
export type RunScopedFailure = (typeof RUN_SCOPED_FAILURES)[number];

export type ProvisionResult =
  | { ok: true; leases: RunScopedLease[]; secrets: string[]; /** Profiles that are long-lived registry accounts: not run-scoped, so no video or trace. */ registered: string[] }
  | { ok: false; code: RunScopedFailure; /** The accounts made before the failure were revoked and their dead logins proved. */ cleanedUp: boolean };

async function bounded<T>(call: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const signal = outer === undefined ? AbortSignal.timeout(RUN_SCOPED_CALL_MS) : AbortSignal.any([outer, AbortSignal.timeout(RUN_SCOPED_CALL_MS)]);
  if (signal.aborted) throw new Error("aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error("aborted")); signal.addEventListener("abort", onAbort, { once: true }); });
  try {
    return await Promise.race([call(signal), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** The latest moment a lease for a round ending at `roundEndsAt` may expire. */
export function runScopedExpiry(roundEndsAt: string): string {
  return new Date(Date.parse(roundEndsAt) + RUN_SCOPED_GRACE_MS).toISOString();
}

/**
 * Provisions every run-scoped account of the approved environment for one round. `registered` accounts are listed and left alone. Refuses a round window that is not in the future or is longer than
 * `RUN_SCOPED_MAX_ROUND_MS`, a missing provisioner for a kind in use, a port answer of the wrong shape, and a profile named twice. If one account fails, the ones already made are revoked first.
 */
export async function provisionRunScopedAccounts(input: { accounts: readonly TestEnvAccount[]; roundEndsAt: string; now: number; ports: AccountProvisionerPorts; signal?: AbortSignal }): Promise<ProvisionResult> {
  const accounts = input.accounts.map((account) => TestEnvAccountSchema.parse(account));
  const registered = accounts.filter((account) => !provisionerIsRunScoped(account.provisioner)).map((account) => account.profileId);
  const scoped = accounts.filter((account): account is RunScopedAccount => provisionerIsRunScoped(account.provisioner));
  if (scoped.length === 0) return { ok: false, code: "no_run_scoped_accounts", cleanedUp: true };
  if (new Set(accounts.map((account) => account.profileId)).size !== accounts.length) return { ok: false, code: "duplicate_profile", cleanedUp: true };
  const endsAt = Date.parse(input.roundEndsAt);
  if (!Number.isFinite(endsAt) || endsAt <= input.now || endsAt - input.now > RUN_SCOPED_MAX_ROUND_MS) return { ok: false, code: "round_window_invalid", cleanedUp: true };
  if (scoped.some((account) => input.ports[account.provisioner] === undefined)) return { ok: false, code: "no_provisioner", cleanedUp: true };

  const expiresAt = runScopedExpiry(input.roundEndsAt);
  const leases: RunScopedLease[] = [];
  const secrets: string[] = [];
  for (const account of scoped) {
    const port = input.ports[account.provisioner]!;
    let failure: RunScopedFailure | undefined;
    try {
      const created = await bounded((signal) => port.create({ account, expiresAt, signal }), input.signal);
      const parsed = CreatedSchema.safeParse(created);
      if (!parsed.success) {
        failure = "provisioner_answer_invalid";
        // An account was made but its answer cannot be used: its handle, if there is one, is still revoked.
        const handle = (created as { revokeHandle?: unknown } | undefined)?.revokeHandle;
        if (typeof handle === "string" && REF.test(handle)) leases.push({ profileId: account.profileId, provisioner: account.provisioner, loginRef: "unknown", revokeHandle: handle, expiresAt });
      } else {
        leases.push({ profileId: account.profileId, provisioner: account.provisioner, loginRef: parsed.data.loginRef, revokeHandle: parsed.data.revokeHandle, expiresAt });
        secrets.push(...(parsed.data.secrets ?? []));
      }
    } catch {
      failure = "provision_failed";
    }
    if (failure !== undefined) {
      const cleanup = await revokeRunScopedAccounts({ leases, accounts, ports: input.ports });
      return { ok: false, code: failure, cleanedUp: leases.length === 0 || cleanup.confirmed };
    }
  }
  return { ok: true, leases, secrets, registered };
}

export interface RevocationReport {
  /** True only when every lease was revoked and a login with each was then refused. This is the proof the evidence pack requires before it keeps a video or a trace. */
  confirmed: boolean;
  accounts: Array<{ profileId: string; revoked: boolean; loginRefused: boolean }>;
}

/**
 * Revokes every lease and proves it: revoke (retried, bounded), then one login probe per account. A revoke that never succeeds, a probe that says the login still works, and a probe that cannot
 * say are all "not confirmed". Never throws, and keeps going after a failure so one stuck account does not leave the others alive.
 */
export async function revokeRunScopedAccounts(input: { leases: readonly RunScopedLease[]; accounts: readonly TestEnvAccount[]; ports: AccountProvisionerPorts; signal?: AbortSignal }): Promise<RevocationReport> {
  const report: RevocationReport["accounts"] = [];
  for (const lease of input.leases) {
    const account = input.accounts.find((item) => item.profileId === lease.profileId && item.provisioner === lease.provisioner);
    const port = input.ports[lease.provisioner];
    if (account === undefined || !provisionerIsRunScoped(account.provisioner) || port === undefined) { report.push({ profileId: lease.profileId, revoked: false, loginRefused: false }); continue; }
    const scoped = account as RunScopedAccount;
    let revoked = false;
    for (let attempt = 0; attempt < RUN_SCOPED_REVOKE_ATTEMPTS && !revoked; attempt += 1) {
      try { await bounded((signal) => port.revoke({ account: scoped, revokeHandle: lease.revokeHandle, signal }), input.signal); revoked = true; } catch { /* tried again, then counted as failed */ }
    }
    let loginRefused = false;
    if (revoked && lease.loginRef !== "unknown") {
      try { loginRefused = (await bounded((signal) => port.loginFails({ account: scoped, loginRef: lease.loginRef, signal }), input.signal)) === true; } catch { loginRefused = false; }
    }
    report.push({ profileId: lease.profileId, revoked, loginRefused });
  }
  return { confirmed: report.length > 0 && report.every((item) => item.revoked && item.loginRefused), accounts: report };
}

/** The pack's `environment.accounts` for a round: run-scoped for each lease, registered for the rest. */
export function evidenceAccountsOf(result: Extract<ProvisionResult, { ok: true }>): Array<{ profileId: string; kind: "run_scoped" | "registered" }> {
  return [...result.leases.map((lease) => ({ profileId: lease.profileId, kind: "run_scoped" as const })), ...result.registered.map((profileId) => ({ profileId, kind: "registered" as const }))];
}

// ---- the three provisioner kinds, each over injected clients

/**
 * `seed_command`: the approved command creates a user in the sandbox's synthetic database and prints one JSON line `{loginRef, revokeHandle, secrets?}`. The account dies with the sandbox; revoking it
 * removes it from the database now so the proof does not wait for teardown.
 */
export function seedCommandProvisioner(clients: {
  runSeed(input: { command: Extract<RunScopedAccount, { provisioner: "seed_command" }>["command"]; env: Readonly<Record<string, string>>; signal: AbortSignal }): Promise<{ exitCode: number; stdout: string }>;
  removeAccount(input: { revokeHandle: string; signal: AbortSignal }): Promise<void>;
  probeLogin(input: { loginRef: string; signal: AbortSignal }): Promise<"refused" | "accepted" | "unclear">;
}): AccountProvisionerPort {
  return {
    async create({ account, expiresAt, signal }) {
      if (account.provisioner !== "seed_command") throw new Error("wrong provisioner");
      const out = await clients.runSeed({ command: account.command, env: { ROVARA_ACCOUNT_PROFILE: account.profileId, ROVARA_ACCOUNT_EXPIRES_AT: expiresAt }, signal });
      if (out.exitCode !== 0 || out.stdout.length > 8_192) throw new Error("seed failed");
      const line = out.stdout.trim().split("\n").filter((item) => item.trim() !== "").at(-1) ?? "";
      return CreatedSchema.parse(JSON.parse(line));
    },
    async revoke({ revokeHandle, signal }) { await clients.removeAccount({ revokeHandle, signal }); },
    async loginFails({ loginRef, signal }) { return (await clients.probeLogin({ loginRef, signal })) === "refused"; },
  };
}

/** `cognito_test_pool`: AdminCreateUser in a test-only user pool through the customer's role, AdminDeleteUser after the round. The pool and role come from the approved account entry, never from a model. */
export function cognitoTestPoolProvisioner(clients: {
  newUsername(): string;
  adminCreateUser(input: { userPoolId: string; region: string; roleArn: string; username: string; expiresAt: string; signal: AbortSignal }): Promise<{ password: string }>;
  adminDeleteUser(input: { userPoolId: string; region: string; roleArn: string; username: string; signal: AbortSignal }): Promise<void>;
  signIn(input: { userPoolId: string; region: string; username: string; signal: AbortSignal }): Promise<"refused" | "accepted" | "unclear">;
}): AccountProvisionerPort {
  const find = (account: RunScopedAccount) => { if (account.provisioner !== "cognito_test_pool") throw new Error("wrong provisioner"); return account; };
  return {
    async create({ account, expiresAt, signal }) {
      const pool = find(account);
      const username = clients.newUsername();
      const { password } = await clients.adminCreateUser({ userPoolId: pool.userPoolId, region: pool.region, roleArn: pool.roleArn, username, expiresAt, signal });
      return CreatedSchema.parse({ loginRef: username, revokeHandle: username, secrets: [password, username] });
    },
    async revoke({ account, revokeHandle, signal }) {
      const pool = find(account);
      await clients.adminDeleteUser({ userPoolId: pool.userPoolId, region: pool.region, roleArn: pool.roleArn, username: revokeHandle, signal });
    },
    async loginFails({ account, loginRef, signal }) {
      const pool = find(account);
      return (await clients.signIn({ userPoolId: pool.userPoolId, region: pool.region, username: loginRef, signal })) === "refused";
    },
  };
}

/** `http_hook`: the customer's own create and delete endpoints, called with a short-lived token read by NAME from the project's secrets (the token itself is only ever in the client's header). */
export function httpHookProvisioner(clients: {
  readToken(name: string): Promise<string>;
  call(input: { method: "POST" | "DELETE"; url: string; token: string; body: unknown; signal: AbortSignal }): Promise<{ status: number; json: unknown }>;
  probeLogin(input: { loginRef: string; signal: AbortSignal }): Promise<"refused" | "accepted" | "unclear">;
}): AccountProvisionerPort {
  const hook = (account: RunScopedAccount) => { if (account.provisioner !== "http_hook") throw new Error("wrong provisioner"); return account; };
  return {
    async create({ account, expiresAt, signal }) {
      const config = hook(account);
      const token = await clients.readToken(config.tokenSecretName);
      const answer = await clients.call({ method: "POST", url: config.createUrl, token, body: { profile: account.profileId, expiresAt }, signal });
      if (answer.status < 200 || answer.status > 299) throw new Error("hook refused");
      return CreatedSchema.parse(answer.json);
    },
    async revoke({ account, revokeHandle, signal }) {
      const config = hook(account);
      const token = await clients.readToken(config.tokenSecretName);
      const answer = await clients.call({ method: "DELETE", url: config.deleteUrl, token, body: { revokeHandle }, signal });
      // A delete of an account that is already gone is a success: the proof is the refused login.
      if ((answer.status < 200 || answer.status > 299) && answer.status !== 404) throw new Error("hook refused");
    },
    async loginFails({ loginRef, signal }) { return (await clients.probeLogin({ loginRef, signal })) === "refused"; },
  };
}
