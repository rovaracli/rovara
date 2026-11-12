// Customer test AWS account, lane TA2 ("session v2"; customer-test-account.md sections 2, 3 and 11): a session on a connected account for one run. This replaces `test-env/aws-test-account.ts`'s session (deleted by TA10):
// that one built a session policy from approved actions and resources and handed the keys to the sandbox. Here the role's own boundary and the run tag are the fence, the keys go only to the signer (TA5 delivers them; this
// returns them to its caller and nothing else), and what moved over from the old file is the session name, the 2,048-character check, the Region condition, the regional hosts and the probe.
//
// ALWAYS FROM THE STORED CONNECTION. The role, the external id, the account and the Region come from the connection record of the organization the caller proves, never from the request: a caller names a connection and a run, and
// cannot name a role. The external id sent is the one stored, and must also equal the one `connectionExternalId` makes for this organization and connection (a record that disagrees is refused before anything is sent), so one
// company's request can never carry another's id. Nothing opens unless the connection is `connected` (an admin confirmed the account and the test passed), the `ta` switch is on, the account is not Rovara's own and the
// company's production list (read now) does not name it.
//
// THE SESSION. `AssumeRole` with: the run tag `rovara-run=<run8>` (the one tag the role's trust policy allows, and the key every run-scoped condition reads); a session name `rovara-<task>-<account>` (CloudTrail names the task and
// the account; letters, digits and `_+=,.@-`, at most 64 characters, nothing a person typed); one hour; and a session policy that only narrows: it allows what the role allows and denies every Regional call outside the
// connection's Region (global IAM and STS reads exempt). The policy is checked against the 2,048 characters STS allows and refused, never cut. No `SourceIdentity` (the role's trust policy has no room for it) and no transitive
// tags. Credentials that come back are checked (all parts present, not already over, not longer than the hour asked for) and are never stored, logged or put in an error.
import { DEFAULT_TEST_ACCESS_SERVICES, RUN_TAG_KEY, TEST_ACCESS_GLOBAL_ACTIONS, TestAccessRegionSchema, connectionExternalId, parseConnectionExternalId, testAccessRoleName, testAccessCleanupRoleName, testAccessRoleArn } from "@agentx/cloud-contracts";
import { agentXError, arnAccountId, prodDenyMatchesArn, type TestEnvProdDeny } from "@rovara-code/contracts";
import { AssumeFailureError, type AssumedCredentials, type TestAccessAws } from "./aws-port.js";
import { connectionUsable, type ConnectionRecord, type TestAccessStore } from "./store.js";

export const TEST_ACCESS_SESSION_SECONDS = 3_600;
/** The most characters STS accepts in a session policy. */
export const SESSION_POLICY_MAX_CHARS = 2_048;
export const RUN_ID_PATTERN = /^[0-9a-z]{8}$/u;
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/u;

/** Fixed reasons, safe to show. Never a role ARN, an account id, a message from AWS, or a credential. */
export const SESSION_CODES = ["not_usable", "own_account", "production", "bad_role", "external_id", "bad_run", "bad_service", "too_large", "refused", "unreachable", "bad_session"] as const;
export type SessionCode = (typeof SESSION_CODES)[number];
const WORDS: Record<SessionCode, string> = {
  not_usable: "this test account is not connected",
  own_account: "the test account's role must be in your own AWS account, not Rovara's",
  production: "this test account names production, or the production list could not be read",
  bad_role: "this test account's role is not valid",
  external_id: "this test account's external id is not the one Rovara makes for this company and connection",
  bad_run: "a run id is 8 lower-case letters and digits",
  bad_service: "this service cannot be used with a test account yet",
  too_large: "the session policy does not fit in one AWS session",
  refused: "AWS refused to let Rovara assume the test account's role; check that the stack still exists",
  unreachable: "AWS could not be reached to assume the test account's role",
  bad_session: "AWS did not return a usable test account session",
};

export class TestAccessSessionError extends Error {
  constructor(readonly code: SessionCode, readonly retryable = code === "unreachable") {
    super(WORDS[code]);
    this.name = "TestAccessSessionError";
  }
}

export const sessionErrorMessage = (error: unknown): string => (error instanceof TestAccessSessionError ? error.message : WORDS.unreachable);

// ---- the session policy and the hosts

/**
 * The session policy: it allows what the role allows and denies a Regional call outside the connection's Region, so a boundary a customer later edits still cannot let a run leave the Region. Checked against 2,048 characters.
 * Throws `bad_role` for a Region that is not one, `too_large` for a text that does not fit.
 */
export function connectionSessionPolicy(region: string): string {
  if (!TestAccessRegionSchema.safeParse(region).success) throw new TestAccessSessionError("bad_role");
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "AllowWhatTheRoleAllows", Effect: "Allow", Action: "*", Resource: "*" },
      { Sid: "OnlyThisRegion", Effect: "Deny", NotAction: TEST_ACCESS_GLOBAL_ACTIONS, Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": region } } },
    ],
  });
  if (policy.length > SESSION_POLICY_MAX_CHARS) throw new TestAccessSessionError("too_large");
  return policy;
}

const HOST_OVERRIDES: Readonly<Record<string, (region: string) => string>> = {
  iam: () => "iam.amazonaws.com",
  tag: (region) => `tagging.${region}.amazonaws.com`,
};
const KNOWN_SERVICES: ReadonlySet<string> = new Set([...DEFAULT_TEST_ACCESS_SERVICES, "tag"]);

/**
 * The signer's host list for a connection: the regional endpoint of each planned service in the connection's Region, and STS in it, and no other name (never `*.amazonaws.com`). IAM is the one global endpoint. A service outside
 * the default list is refused (`bad_service`) until a template version allows it.
 */
export function connectionHosts(region: string, services: readonly string[]): string[] {
  if (!TestAccessRegionSchema.safeParse(region).success) throw new TestAccessSessionError("bad_role");
  const hosts = new Set<string>([`sts.${region}.amazonaws.com`]);
  for (const service of services) {
    if (!KNOWN_SERVICES.has(service)) throw new TestAccessSessionError("bad_service");
    hosts.add(HOST_OVERRIDES[service]?.(region) ?? `${service}.${region}.amazonaws.com`);
  }
  return [...hosts].sort();
}

const idPart = (text: string, max: number, fallback: string): string => text.replace(/[^A-Za-z0-9]/gu, "").slice(0, max) || fallback;
/** `rovara-<task>-<account>`: two stripped identifiers, so CloudTrail shows which task and which account without any text a person typed. */
export function sessionNameOf(taskId: string, accountId: string): string {
  const name = `rovara-${idPart(taskId, 16, "task")}-${idPart(accountId, 12, "account")}`;
  if (!SESSION_NAME.test(name)) throw new TestAccessSessionError("bad_session", false);
  return name;
}

// ---- opening

export interface SessionDeps {
  /** The `ta` switch, read at every call: while it is off nothing is opened and AWS is not called. */
  enabled: () => boolean;
  store: Pick<TestAccessStore, "getConnection">;
  aws: Pick<TestAccessAws, "assumeRole">;
  now: () => number;
  /** Rovara's own AWS accounts; a role in one is refused. */
  rovaraAccountIds: readonly string[];
  prodDeny: (orgId: string, projectId: string) => Promise<TestEnvProdDeny>;
}

export interface TestAccessSession {
  credentials: AssumedCredentials;
  expiresAtMs: number;
  /** The signer's host list: the regional endpoints of exactly the planned services, and STS. */
  hosts: string[];
  region: string;
  accountId: string;
  runId: string;
  sessionName: string;
}

/** Everything the stored connection must satisfy before AWS is called. Returns the facts the call uses, all from the record. */
export async function checkedConnection(deps: Pick<SessionDeps, "rovaraAccountIds" | "prodDeny">, record: ConnectionRecord, purpose: "run" | "cleanup"): Promise<{ roleArn: string; accountId: string }> {
  const accountId = record.accountId;
  const roleArn = purpose === "run" ? record.roleArn : record.cleanupRoleArn;
  if (accountId === undefined || roleArn === undefined || !/^\d{12}$/u.test(accountId) || arnAccountId(roleArn) !== accountId) throw new TestAccessSessionError("bad_role");
  // The role is the one the template names for this connection, in the connected account, and no other.
  let expectedRole: string;
  try {
    expectedRole = testAccessRoleArn(accountId, purpose === "run" ? testAccessRoleName(record.connectionId) : testAccessCleanupRoleName(record.connectionId));
  } catch {
    // A connection id that is not one Rovara makes cannot name a role.
    throw new TestAccessSessionError("bad_role");
  }
  if (roleArn !== expectedRole) throw new TestAccessSessionError("bad_role");
  const derived = parseConnectionExternalId(record.externalId);
  if (derived === undefined || derived.orgId !== record.orgId || derived.connectionId !== record.connectionId || record.externalId !== connectionExternalId(record.orgId, record.connectionId)) throw new TestAccessSessionError("external_id");
  if (deps.rovaraAccountIds.length === 0 || deps.rovaraAccountIds.includes(accountId)) throw new TestAccessSessionError("own_account");
  let deny: TestEnvProdDeny;
  try {
    deny = await deps.prodDeny(record.orgId, record.projectId);
  } catch {
    throw new TestAccessSessionError("production");
  }
  if (deny.accountIds.includes(accountId) || prodDenyMatchesArn(deny, roleArn) !== undefined) throw new TestAccessSessionError("production");
  return { roleArn, accountId };
}

/** Validates what AssumeRole returned: all parts present, not already over, not longer than the hour asked for (plus a minute of skew). */
export function checkedCredentials(credentials: AssumedCredentials | undefined, nowMs: number): { credentials: AssumedCredentials; expiresAtMs: number } {
  const expiresAtMs = credentials?.expiration instanceof Date ? credentials.expiration.getTime() : Number.NaN;
  if (credentials === undefined || typeof credentials.accessKeyId !== "string" || credentials.accessKeyId === "" || typeof credentials.secretAccessKey !== "string" || credentials.secretAccessKey === "" || typeof credentials.sessionToken !== "string" || credentials.sessionToken === ""
    || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + TEST_ACCESS_SESSION_SECONDS * 1_000 + 60_000) throw new TestAccessSessionError("bad_session", false);
  return { credentials, expiresAtMs };
}

/**
 * Assumes the role of an already loaded, already status-gated connection record, for one run. The record is the stored one: nothing in `input` can name a role, an external id or a Region. `purpose: "cleanup"` assumes the
 * delete-only cleanup role instead.
 */
export async function assumeForRecord(deps: Pick<SessionDeps, "aws" | "now" | "rovaraAccountIds" | "prodDeny">, record: ConnectionRecord, input: { taskId: string; runId: string; services: readonly string[]; purpose?: "run" | "cleanup" }): Promise<TestAccessSession> {
  const purpose = input.purpose ?? "run";
  if (!RUN_ID_PATTERN.test(input.runId)) throw new TestAccessSessionError("bad_run", false);
  const { roleArn, accountId } = await checkedConnection(deps, record, purpose);
  const policy = connectionSessionPolicy(record.region);
  const hosts = connectionHosts(record.region, input.services);
  const sessionName = sessionNameOf(input.taskId, accountId);
  let assumed;
  try {
    assumed = await deps.aws.assumeRole({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      // Right before the call: what is sent is the stored id, and the record held exactly the derived one (checked above).
      ExternalId: record.externalId,
      DurationSeconds: TEST_ACCESS_SESSION_SECONDS,
      Policy: policy,
      Tags: [{ Key: RUN_TAG_KEY, Value: input.runId }],
    });
  } catch (error) {
    throw new TestAccessSessionError(error instanceof AssumeFailureError && error.failure === "refused" ? "refused" : "unreachable");
  }
  const checked = checkedCredentials(assumed?.credentials, deps.now());
  return { credentials: checked.credentials, expiresAtMs: checked.expiresAtMs, hosts, region: record.region, accountId, runId: input.runId, sessionName };
}

/** Opens a session on a connected account for one run. `purpose: "cleanup"` is allowed while the connection is suspended or needs attention (TA6 must still be able to delete what a run made). */
export async function openTestAccessSession(deps: SessionDeps, input: { orgId: string; connectionId: string; taskId: string; runId: string; services: readonly string[]; purpose?: "run" | "cleanup" }): Promise<TestAccessSession> {
  if (!deps.enabled()) throw agentXError("NOT_FOUND", "Not found");
  const purpose = input.purpose ?? "run";
  // The connection is read under the organization the caller proves: another organization's connection id is not found, the same as a missing one.
  const record = await deps.store.getConnection(input.orgId, input.connectionId);
  if (record === undefined || record.orgId !== input.orgId) throw new TestAccessSessionError("not_usable", false);
  const cleanupAllowed = record.status === "connected" || record.status === "needs_attention" || record.status === "suspended";
  if (purpose === "run" ? !connectionUsable(record) : !cleanupAllowed) throw new TestAccessSessionError("not_usable", false);
  return assumeForRecord(deps, record, { taskId: input.taskId, runId: input.runId, services: input.services, purpose });
}
