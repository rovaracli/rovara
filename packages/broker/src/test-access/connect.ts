// Customer test AWS account, lane TA2: the connect API's logic (customer-test-account.md section 1; decisions 121, 122, 124). Routes are `aws/developer-routes/test-access.ts`; this file decides.
//
//   startConnection      "Connect in AWS": mint the connection id and a one-use token (30 minutes), store the token's HASH, and return the CloudFormation quick-create link. Admin, fresh sign-in, a project the admin can edit.
//   getConnection        the page's live read (Screen 3 polls it): the state, never the token.
//   submitAccountId      the polling fallback ("typed the account id"): opens a 30-minute poll for the role the template names.
//   confirmConnection    the admin saw the account id, Region and role the stack reported, and says it is theirs. Fresh sign-in. Only then does anything assume the role; the connection test runs at once.
//   testConnection       reruns the checks.   acknowledgeNotProduction   the tick for a `prod` alias.   suspendConnection / disconnectConnection   safety actions: a live admin, nothing else.
//
// WHO. Every function takes the caller the route authenticated (organization, developer, session) and re-reads the admin role now (`requireAdmin`); a state-changing step that grants trust (start, account id, confirm, tick) also needs
// a stored session of the SAME person whose interactive sign-in is fresh. Every key is built from the caller's organization: another organization's connection id is `not found`, the same as a missing one, and no answer reveals whether it exists.
//
// NOTHING SECRET LEAVES. The token is in the link of the response that minted it (and nowhere else: not the store, not a log, not an audit event, not the view). The view holds the external id (not a secret: the Terraform path shows it) and the
// state; an account id and a role ARN only after the stack reported them, and only to an admin.
import { createHash } from "node:crypto";
import { buildTestAccessLink, connectionExternalId, TEST_ACCESS_TOKEN_TTL_SECONDS, TestAccessRegionSchema, testAccessRoleArn, testAccessRoleName, testAccessCleanupRoleName } from "@agentx/cloud-contracts";
import { AGENTX_NAME_PATTERN, OrgIdSchema, agentXError, type TestEnvProdDeny } from "@rovara-code/contracts";
import { connectionAudit, type ConnectionActor } from "./audit.js";
import type { TestAccessAws } from "./aws-port.js";
import { runConnectionTest, type ConnectionTestDeps } from "./connection-test.js";
import { connectTokenHash, mintConnectToken, newConnectionId } from "./token.js";
import type { ConnectionRecord, ConnectionTestResult, TestAccessStore } from "./store.js";
import { isFreshSignIn, type SessionRecord } from "../developer/store.js";

export const POLL_WINDOW_MS = 30 * 60_000;
export const POLL_INTERVAL_MS = 10_000;
/** A company may have this many links waiting at once. */
export const LIVE_LINKS_MAX = 5;
/** And this many connections in all, whatever their state. */
export const CONNECTIONS_MAX_PER_ORG = 50;
const CAS_ATTEMPTS = 3;

export interface ConnectCaller { orgId: string; developerId: string; sessionId: string }

export interface ConnectConfig {
  /** The versioned template in S3. */
  templateUrl: string;
  /** The broker's role: the only principal the customer's role trusts. */
  rovaraPrincipalArn: string;
  /** Rovara's callback topic in a Region, or undefined for a Region Rovara has none in. */
  topicArn: (region: string) => string | undefined;
  rovaraAccountIds: readonly string[];
}

export interface ConnectDeps {
  /** The `ta` switch, read at every call. Off: NOT_FOUND "Not found", before any store or AWS call. */
  enabled: () => boolean;
  store: TestAccessStore;
  now: () => Date;
  config: ConnectConfig;
  aws: TestAccessAws;
  requireAdmin: (caller: { orgId: string; developerId: string }) => Promise<void>;
  readSession: (sessionId: string) => Promise<Pick<SessionRecord, "authTime" | "developerId" | "revokedAt"> | undefined>;
  /** True when the caller may change this project's settings (read live). */
  canEditProject: (caller: ConnectCaller, projectId: string) => Promise<boolean>;
  prodDeny: (orgId: string, projectId: string) => Promise<TestEnvProdDeny>;
  /** Test seams. */
  newToken?: () => string;
  newConnectionId?: () => string;
  testDeps?: Partial<Pick<ConnectionTestDeps, "runId" | "otherName">>;
}

/** The deployment's own accounts must be known: an empty list would let a stack in Rovara's own account through, so every step that needs the list refuses until it is set. */
export function requireConnectConfig(config: ConnectConfig): void {
  if (config.rovaraAccountIds.length === 0 || !config.rovaraAccountIds.every((account) => /^\d{12}$/u.test(account))) throw agentXError("RUNTIME_UNAVAILABLE", "Test accounts are not set up on this install.");
}

const notFound = () => agentXError("NOT_FOUND", "Not found");
const connectionNotFound = () => agentXError("NOT_FOUND", "connection not found");
const reauth = () => agentXError("REAUTH_REQUIRED", "Sign in again to connect an AWS account.");

function validCaller(caller: ConnectCaller): void {
  if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/u.test(caller.developerId)) throw agentXError("FORBIDDEN", "Not allowed");
}

async function requireAdminOnly(deps: ConnectDeps, caller: ConnectCaller): Promise<void> {
  if (!deps.enabled()) throw notFound();
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
}

/** Admin now, then a stored session of the SAME person, not revoked, with a fresh interactive sign-in. Returns the sign-in time for the audit proof. */
async function requireFreshAdmin(deps: ConnectDeps, caller: ConnectCaller): Promise<string> {
  await requireAdminOnly(deps, caller);
  const session = typeof caller.sessionId === "string" && caller.sessionId.length > 0 && caller.sessionId.length <= 200 ? await deps.readSession(caller.sessionId) : undefined;
  if (session === undefined || session.developerId !== caller.developerId || session.revokedAt !== undefined || session.authTime === undefined || !isFreshSignIn(session, deps.now().getTime())) throw reauth();
  return session.authTime;
}

const actorOf = (caller: ConnectCaller, authTime: string | undefined): ConnectionActor => ({
  kind: "member",
  developerId: caller.developerId,
  ...(authTime === undefined ? {} : { proof: { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime, sessionRef: sessionRef(caller.sessionId) } }),
});
// A short, one-way reference of the session (never the session id): the audit proof format wants a 64-hex ref.
const sessionRef = (sessionId: string): string => createHash("sha256").update(sessionId, "utf8").digest("hex");

// ---- the view

export interface ConnectionView {
  connectionId: string;
  projectId: string;
  region: string;
  status: ConnectionRecord["status"];
  /** The link was made for this long: `awaiting` past it means the link expired (start again). */
  linkExpiresAt: string;
  linkExpired: boolean;
  externalId: string;
  accountId?: string;
  roleArn?: string;
  alias?: string;
  templateVersion?: string;
  reportedVia?: "callback" | "account_id";
  needsConfirmation: boolean;
  needsNotProductionTick: boolean;
  pollUntil?: string;
  lastTest?: ConnectionTestResult;
  endCause?: string;
}

export function connectionView(record: ConnectionRecord, nowMs: number): ConnectionView {
  const expired = record.status === "awaiting" && Date.parse(record.tokenExpiresAt) <= nowMs;
  const prodCheck = record.lastTest?.checks.find((check) => check.id === "not_production");
  return {
    connectionId: record.connectionId,
    projectId: record.projectId,
    region: record.region,
    status: record.status,
    linkExpiresAt: record.tokenExpiresAt,
    linkExpired: expired,
    externalId: record.externalId,
    ...(record.accountId === undefined ? {} : { accountId: record.accountId }),
    ...(record.roleArn === undefined ? {} : { roleArn: record.roleArn }),
    ...(record.alias === undefined ? {} : { alias: record.alias }),
    ...(record.templateVersion === undefined ? {} : { templateVersion: record.templateVersion }),
    ...(record.reportedVia === undefined ? {} : { reportedVia: record.reportedVia }),
    needsConfirmation: record.status === "reported",
    needsNotProductionTick: prodCheck?.status === "fail" && record.notProductionAck !== true,
    ...(record.pollUntil === undefined ? {} : { pollUntil: record.pollUntil }),
    ...(record.lastTest === undefined ? {} : { lastTest: record.lastTest }),
    ...(record.endCause === undefined ? {} : { endCause: record.endCause }),
  };
}

// ---- start

export async function startConnection(deps: ConnectDeps, caller: ConnectCaller, input: { projectId: string; region: string }): Promise<{ connection: ConnectionView; link: string }> {
  const authTime = await requireFreshAdmin(deps, caller);
  requireConnectConfig(deps.config);
  if (typeof input.projectId !== "string" || !AGENTX_NAME_PATTERN.test(input.projectId)) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  if (!(await deps.canEditProject(caller, input.projectId))) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const region = TestAccessRegionSchema.safeParse(input.region);
  const topicArn = region.success ? deps.config.topicArn(region.data) : undefined;
  if (!region.success || topicArn === undefined) throw agentXError("CONFIG_INVALID", "This Region is not supported for test accounts yet.");
  const now = deps.now();
  const existing = await deps.store.listConnections(caller.orgId, CONNECTIONS_MAX_PER_ORG + 1);
  const live = existing.filter((record) => (record.status === "awaiting" || record.status === "polling") && Date.parse(record.tokenExpiresAt) > now.getTime()).length;
  if (existing.length > CONNECTIONS_MAX_PER_ORG || live >= LIVE_LINKS_MAX) throw agentXError("CONFIG_INVALID", "Too many connections are waiting. Finish or delete one first.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const connectionId = deps.newConnectionId?.() ?? newConnectionId();
    const token = deps.newToken?.() ?? mintConnectToken();
    const tokenHash = connectTokenHash(token);
    if (tokenHash === undefined) throw new Error("the minted token has the wrong shape");
    const expiresAtMs = now.getTime() + TEST_ACCESS_TOKEN_TTL_SECONDS * 1_000;
    const record: ConnectionRecord = {
      orgId: caller.orgId,
      connectionId,
      projectId: input.projectId,
      region: region.data,
      status: "awaiting",
      version: 1,
      externalId: connectionExternalId(caller.orgId, connectionId),
      createdBy: caller.developerId,
      createdAt: now.toISOString(),
      tokenExpiresAt: new Date(expiresAtMs).toISOString(),
    };
    const audit = connectionAudit({ record, action: "test_access.connection_started", actor: actorOf(caller, authTime), occurredAt: now.toISOString(), facts: { region: region.data } });
    if (!(await deps.store.createConnection(record, { tokenHash, orgId: caller.orgId, projectId: input.projectId, connectionId, region: region.data, expiresAtMs }, audit))) continue;
    const link = buildTestAccessLink({ region: region.data, templateUrl: deps.config.templateUrl, orgId: caller.orgId, connectionId, connectToken: token, rovaraPrincipalArn: deps.config.rovaraPrincipalArn, callbackTopicArn: topicArn });
    return { connection: connectionView(record, now.getTime()), link };
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "Could not start the connection. Try again.");
}

// ---- reads and moves

async function load(deps: ConnectDeps, orgId: string, connectionId: string): Promise<ConnectionRecord> {
  if (!/^conn_[0-9a-z]{20}$/u.test(connectionId)) throw connectionNotFound();
  const record = await deps.store.getConnection(orgId, connectionId);
  if (record === undefined || record.orgId !== orgId) throw connectionNotFound();
  return record;
}

export async function getConnection(deps: ConnectDeps, caller: ConnectCaller, connectionId: string): Promise<ConnectionView> {
  await requireAdminOnly(deps, caller);
  return connectionView(await load(deps, caller.orgId, connectionId), deps.now().getTime());
}

export async function listConnections(deps: ConnectDeps, caller: ConnectCaller): Promise<ConnectionView[]> {
  await requireAdminOnly(deps, caller);
  return (await deps.store.listConnections(caller.orgId, CONNECTIONS_MAX_PER_ORG)).map((record) => connectionView(record, deps.now().getTime()));
}

/** Reads, changes and commits with the version read; a lost race re-reads and decides again (bounded). `change` returns undefined for "nothing to do" or throws a refusal. */
async function move(deps: ConnectDeps, orgId: string, connectionId: string, change: (record: ConnectionRecord) => { next: ConnectionRecord; audit?: ReturnType<typeof connectionAudit> } | undefined): Promise<ConnectionRecord> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const record = await load(deps, orgId, connectionId);
    const moved = change(record);
    if (moved === undefined) return record;
    if (await deps.store.commitConnection(moved.next, record.version, moved.audit)) return moved.next;
  }
  throw agentXError("CHANGE_STALE", "This connection changed. Reload and try again.");
}

export async function submitAccountId(deps: ConnectDeps, caller: ConnectCaller, connectionId: string, input: { accountId: string }): Promise<ConnectionView> {
  await requireFreshAdmin(deps, caller);
  requireConnectConfig(deps.config);
  if (typeof input.accountId !== "string" || !/^\d{12}$/u.test(input.accountId)) throw agentXError("CONFIG_INVALID", "An AWS account id is 12 digits.");
  const record = await load(deps, caller.orgId, connectionId);
  if (deps.config.rovaraAccountIds.includes(input.accountId)) throw agentXError("CONFIG_INVALID", "Rovara cannot use this account for tests. Use a test account of your own.");
  const deny = await deps.prodDeny(record.orgId, record.projectId);
  if (deny.accountIds.includes(input.accountId)) throw agentXError("CONFIG_INVALID", "Rovara cannot use this account for tests. Use a test account of your own.");
  const now = deps.now();
  const moved = await move(deps, caller.orgId, connectionId, (current) => {
    // Only a connection still waiting for its stack takes an account id; a typed id never replaces a reported account.
    if (current.status !== "awaiting" && current.status !== "polling") throw agentXError("CHANGE_STALE", "This connection is already past this step.");
    return { next: { ...current, status: "polling", version: current.version + 1, pollAccountId: input.accountId, pollSubmittedBy: caller.developerId, pollUntil: new Date(now.getTime() + POLL_WINDOW_MS).toISOString() } };
  });
  return connectionView(moved, now.getTime());
}

export async function confirmConnection(deps: ConnectDeps, caller: ConnectCaller, connectionId: string, input: { accountId: string }): Promise<ConnectionView> {
  const authTime = await requireFreshAdmin(deps, caller);
  const now = deps.now();
  const confirmed = await move(deps, caller.orgId, connectionId, (current) => {
    if (current.status !== "reported") throw agentXError("CHANGE_STALE", "There is nothing to confirm on this connection.");
    // The admin confirms the account id they were SHOWN: a connection that reported another account since (or a stale page) is refused.
    if (typeof input.accountId !== "string" || input.accountId !== current.accountId) throw agentXError("CHANGE_STALE", "The account changed. Reload and check it again.");
    const next: ConnectionRecord = { ...current, status: "confirmed", version: current.version + 1, confirmedBy: caller.developerId, confirmedAt: now.toISOString() };
    return { next, audit: connectionAudit({ record: next, action: "test_access.connection_confirmed", actor: actorOf(caller, authTime), occurredAt: now.toISOString(), facts: { via: current.reportedVia ?? "callback" } }) };
  });
  return runAndRecordTest(deps, caller.orgId, confirmed.connectionId, caller);
}

export async function acknowledgeNotProduction(deps: ConnectDeps, caller: ConnectCaller, connectionId: string): Promise<ConnectionView> {
  await requireFreshAdmin(deps, caller);
  const moved = await move(deps, caller.orgId, connectionId, (current) => {
    if (current.status !== "confirmed" && current.status !== "connected" && current.status !== "needs_attention") throw agentXError("CHANGE_STALE", "This connection is not ready for that.");
    return current.notProductionAck === true ? undefined : { next: { ...current, version: current.version + 1, notProductionAck: true } };
  });
  return runAndRecordTest(deps, caller.orgId, moved.connectionId, caller);
}

export async function testConnection(deps: ConnectDeps, caller: ConnectCaller, connectionId: string): Promise<ConnectionView> {
  await requireAdminOnly(deps, caller);
  return runAndRecordTest(deps, caller.orgId, connectionId, caller);
}

/** Runs the checks for a connection that may be tested (confirmed, connected or needs attention) and records the result. Never for `reported` (an admin has not said it is theirs), `awaiting`, `suspended` or ended ones. */
export async function runAndRecordTest(deps: ConnectDeps, orgId: string, connectionId: string, actor: ConnectCaller | "system"): Promise<ConnectionView> {
  requireConnectConfig(deps.config);
  const before = await load(deps, orgId, connectionId);
  if (before.status !== "confirmed" && before.status !== "connected" && before.status !== "needs_attention") throw agentXError("CHANGE_STALE", "This connection cannot be tested now.");
  const outcome = await runConnectionTest({ aws: deps.aws, now: () => deps.now().getTime(), rovaraAccountIds: deps.config.rovaraAccountIds, prodDeny: deps.prodDeny, ...deps.testDeps }, before);
  const now = deps.now();
  const moved = await move(deps, orgId, connectionId, (current) => {
    // A connection suspended or ended while the test ran discards the result: it was about something else.
    if (current.status !== "confirmed" && current.status !== "connected" && current.status !== "needs_attention") return undefined;
    const next: ConnectionRecord = { ...current, status: outcome.result.passed ? "connected" : "needs_attention", version: current.version + 1, lastTest: outcome.result, ...(outcome.alias === undefined ? {} : { alias: outcome.alias }) };
    const failed = outcome.result.checks.filter((check) => check.status === "fail").length;
    return { next, audit: connectionAudit({ record: next, action: "test_access.connection_tested", actor: actor === "system" ? { kind: "system" } : { kind: "member", developerId: actor.developerId }, occurredAt: now.toISOString(), facts: { outcome: outcome.result.passed ? "passed" : "needs_attention", failed } }) };
  });
  return connectionView(moved, now.getTime());
}

async function end(deps: ConnectDeps, caller: ConnectCaller, connectionId: string, status: "suspended" | "disconnected", cause: string): Promise<ConnectionView> {
  await requireAdminOnly(deps, caller);
  const now = deps.now();
  const moved = await move(deps, caller.orgId, connectionId, (current) => {
    if (current.status === status || current.status === "disconnected") return undefined;
    const next: ConnectionRecord = { ...current, status, version: current.version + 1, endedAt: now.toISOString(), endCause: cause };
    delete next.pollAccountId; delete next.pollSubmittedBy; delete next.pollUntil;
    return { next, audit: connectionAudit({ record: next, action: "test_access.connection_ended", actor: { kind: "member", developerId: caller.developerId }, occurredAt: now.toISOString(), facts: { cause } }) };
  });
  return connectionView(moved, now.getTime());
}

/** Stops new sessions at once. Safety actions stay easy: a live admin, no fresh sign-in. What a run already made is cleaned up by the cleanup role (TA6). */
export const suspendConnection = (deps: ConnectDeps, caller: ConnectCaller, connectionId: string): Promise<ConnectionView> => end(deps, caller, connectionId, "suspended", "suspended");
/** Disconnects in Rovara. Deleting the customer's stack is theirs to do (and its Delete event disconnects too). */
export const disconnectConnection = (deps: ConnectDeps, caller: ConnectCaller, connectionId: string): Promise<ConnectionView> => end(deps, caller, connectionId, "disconnected", "disconnected");

/** The role ARNs the template names for a connection in an account: what a poll tries, and what the callback must report. */
export function conventionalRoles(accountId: string, connectionId: string): { roleArn: string; cleanupRoleArn: string } {
  return { roleArn: testAccessRoleArn(accountId, testAccessRoleName(connectionId)), cleanupRoleArn: testAccessRoleArn(accountId, testAccessCleanupRoleName(connectionId)) };
}

