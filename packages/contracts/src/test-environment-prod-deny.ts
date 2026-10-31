// Production deny list (design proof-test-env, section 4.7): a test environment refuses to point at anything the company has marked as production. The matchers here are pure and shared by the broker (which
// refuses an environment at approval) and the verifier (which refuses a fixture, a seed or a sample that names production at run time), so both read the list the same way.
//
// Fail closed:
//   - an environment that reaches a real remote (pre-prod, a shared environment, a preview stack, an account hook) with an EMPTY deny list is refused: "list production first";
//   - hosts are compared case-insensitively and a leading `*.` matches any subdomain (not the bare domain: list both to cover both);
//   - an ARN is production when it starts with a listed prefix or when its account field is a listed account.
// Nothing here is node-only.
import type { TestEnvironmentBody } from "./test-environment.js";

export interface TestEnvProdDeny {
  accountIds: readonly string[];
  hosts: readonly string[];
  arnPrefixes: readonly string[];
}

/** What a deny-list check found: a fixed code and the field it was found in (a path into the environment), never the value. */
export type TestEnvProdDenyViolation = { kind: "prod_host" | "prod_arn" | "prod_account" | "prod_deny_missing"; field: string };

export function prodDenyIsEmpty(deny: TestEnvProdDeny): boolean {
  return deny.accountIds.length === 0 && deny.hosts.length === 0 && deny.arnPrefixes.length === 0;
}

/** Whether a host is on the list. An empty or malformed host is treated as a match: when in doubt, it is production. */
export function prodDenyMatchesHost(deny: TestEnvProdDeny, host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/u, "");
  if (name === "" || !/^[a-z0-9.-]+$/u.test(name)) return true;
  return deny.hosts.some((entry) => {
    const pattern = entry.trim().toLowerCase().replace(/\.$/u, "");
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1;
    return name === pattern;
  });
}

export function prodDenyMatchesAccount(deny: TestEnvProdDeny, accountId: string): boolean {
  return deny.accountIds.includes(accountId);
}

/** The account field of an ARN (`arn:aws:iam::123456789012:role/x`), or undefined when the text is not an ARN with one. */
export function arnAccountId(arn: string): string | undefined {
  const parts = arn.split(":");
  const account = parts[4];
  return parts[0] === "arn" && parts.length >= 6 && account !== undefined && /^\d{12}$/u.test(account) ? account : undefined;
}

export function prodDenyMatchesArn(deny: TestEnvProdDeny, arn: string): "prod_arn" | "prod_account" | undefined {
  if (deny.arnPrefixes.some((prefix) => arn.startsWith(prefix))) return "prod_arn";
  const account = arnAccountId(arn);
  return account !== undefined && prodDenyMatchesAccount(deny, account) ? "prod_account" : undefined;
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Every address, ARN and account the environment would reach for real, with the field it is in. The sandbox's own mocks and local seeds are not here. */
function reachedRemotes(env: TestEnvironmentBody): Array<{ field: string; host?: string; arn?: string; pool?: string }> {
  const remotes: Array<{ field: string; host?: string; arn?: string; pool?: string }> = [];
  env.services.forEach((service, index) => {
    const preprod = service.preprod;
    if (preprod === undefined) return;
    const base = `services[${String(index)}].preprod`;
    if (preprod.url !== undefined) remotes.push({ field: `${base}.url`, host: hostOfUrl(preprod.url) });
    if (preprod.endpointArn !== undefined) remotes.push({ field: `${base}.endpointArn`, arn: preprod.endpointArn });
    if (preprod.roleArn !== undefined) remotes.push({ field: `${base}.roleArn`, arn: preprod.roleArn });
  });
  env.accounts.forEach((account, index) => {
    const base = `accounts[${String(index)}]`;
    if (account.provisioner === "cognito_test_pool") remotes.push({ field: `${base}.roleArn`, arn: account.roleArn });
    if (account.provisioner === "http_hook") {
      remotes.push({ field: `${base}.createUrl`, host: hostOfUrl(account.createUrl) }, { field: `${base}.deleteUrl`, host: hostOfUrl(account.deleteUrl) });
    }
  });
  env.accounts.forEach((account, index) => {
    // A pool id carries no account, so a pool is production when the deny list names its resource (`...:userpool/<id>`) in an ARN prefix.
    if (account.provisioner === "cognito_test_pool") remotes.push({ field: `accounts[${String(index)}].userPoolId`, arn: `arn:aws:cognito-idp:${account.region}::userpool/${account.userPoolId}`, pool: account.userPoolId });
  });
  if (env.preview !== undefined) remotes.push({ field: "preview.deployRoleArn", arn: env.preview.deployRoleArn });
  if (env.shared !== undefined) remotes.push({ field: "shared.baseUrl", host: hostOfUrl(env.shared.baseUrl) });
  return remotes;
}

/**
 * Everything in the environment that names production, or `prod_deny_missing` when the environment reaches a remote and the company has not listed production at all. An environment that touches
 * no remote (the sandbox with mocks only) needs no list. Empty array: the environment may be approved as far as this check goes.
 */
export function testEnvProdDenyViolations(env: TestEnvironmentBody, alsoDeny?: TestEnvProdDeny): TestEnvProdDenyViolation[] {
  const remotes = reachedRemotes(env);
  if (remotes.length === 0) return [];
  if (prodDenyIsEmpty(env.prodDeny)) return [{ kind: "prod_deny_missing", field: "prodDeny" }];
  // `alsoDeny` is the list the approved environment had: removing a production entry in the same change that points at it must not hide it.
  const lists = alsoDeny === undefined ? [env.prodDeny] : [env.prodDeny, alsoDeny];
  const found: TestEnvProdDenyViolation[] = [];
  for (const remote of remotes) {
    if (remote.host !== undefined && lists.some((deny) => prodDenyMatchesHost(deny, remote.host as string))) found.push({ kind: "prod_host", field: remote.field });
    if (remote.pool !== undefined) {
      const pool = remote.pool;
      if (lists.some((deny) => deny.arnPrefixes.some((prefix) => prefix.includes(`userpool/${pool}`) || prefix.endsWith(`:userpool/`) || prefix.endsWith(`:userpool/*`)))) found.push({ kind: "prod_arn", field: remote.field });
      continue;
    }
    if (remote.arn !== undefined) {
      const kind = lists.map((deny) => prodDenyMatchesArn(deny, remote.arn as string)).find((match) => match !== undefined);
      if (kind !== undefined) found.push({ kind, field: remote.field });
    }
  }
  return found;
}
