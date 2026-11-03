// Test services TS26 (design test-services.md, sections 4.3, 6.1 and 6.4; owner decisions Q7, Q8 and Q3 of 2026-11-02): the customer test accounts of a company, from adding one to a sealed round using it.
//
// WHAT AN ACCOUNT IS HERE. A `TestAccount` record (contracts/src/test-account.ts) holds a REFERENCE to an org-tagged Secrets Manager secret, never a value. The value goes in once, through `TestAccountSecrets`
// (test-account-secrets.ts), which the broker can write and never read. Nothing in this module returns, logs or stores a value; a failure carries a fixed message and, where useful, the NAMES of the fields at fault.
//
// WHO MAY DO WHAT (6.4, Q7):
//   - Adding, WIDENING (more hosts, actions, resources, variables, projects or higher limits: `testAccountWidened`) or re-enabling an account is a less-safe change. The person makes it with a fresh sign-in (that is
//     their own approval of the exact record, stamped with its digest), and a DIFFERENT eligible admin approves it with a fresh sign-in (10 minutes). The sole-owner exception of `second-person-approval.ts` applies
//     (the only eligible person, nobody eligible lost in 24 hours) unless the company has turned it off. Each approval carries the digest of what it approved (`testAccountApprovalDigest`), so an approval of one
//     record never counts for another.
//   - NARROWING (DC-TS-2: a change `testAccountWidened` proves is smaller) applies at once. The approvals are re-stamped with the new digest (`restampApprovals`) and the change is audited. Anything this function
//     cannot prove smaller is a widening: the account waits as `pending` (unusable) until it is approved again.
//   - SUSPENDING and DELETING apply at once (a live admin; no second person, no fresh sign-in: a safety action stays easy).
//   - ROTATING the value needs a fresh admin and the key-shape check; it does not change the record, so it does not need a second person (the reference, hosts and reach are what a second person approves). The new
//     value goes in as AWSPENDING, the row and audit are committed naming that version, and only then is it promoted to AWSCURRENT; any failure in between leaves the old value serving (and a failed promotion is audited
//     as `test_account.rotation_failed`). Notifying the company's owners of an approval or a rotation is TS-ACC-3.
//   - THE SECOND PERSON must have held the admin role for 24 hours (`adminSince`): a freshly added admin is not a check on the person who added the account. (Made platform-wide by TS-ACC-3.)
//   - DELETING commits an audited `deleting` row (unusable) before the secret's deletion is scheduled, then removes the row.
//   - The AWS external id is Rovara's (`testAccountExternalId`), never the customer's.
//   - EXPIRY: 90 days from the last qualifying approval at most (a company may set fewer). `expireDueAccounts` ends an account that has passed it; `remindersDue` says which are 14 days away.
//
// WHERE IT MAY BE USED (6.3, Q3, Q8): only by a sealed check round. `resolveAccountsForRound` refuses every other place (the setup run, the working sandbox, a team runner), an account that is not active, one past its expiry, one
// not open to the project, one whose hosts or roles are on the production deny list NOW (checked at every run, not only at save), and one over its day's request cap. `mintRoundGrants` then asks the secrets role for a
// session the worker can read ONE secret with; the broker never holds the value.
//
// NOTHING IS REACHABLE WHILE `ta` IS OFF. Every function starts with `deps.enabled()`; when it is false the answer is the one an unknown path gets (NOT_FOUND "Not found"), before any store, secrets or session call.
//
// Not wired: no route, no table, no switch reader (TS36 pages and the DynamoDB adapter are wiring). `TestAccountStore` is an interface; the in-memory store in tests/support has none of the adapter's races (see its notes).
import {
  OrgIdSchema, TEST_ACCOUNT_EXPIRY_DAYS, TEST_ACCOUNT_LIMIT_DEFAULTS, agentXError, parseTestAccountSecretGrant, parseTestAccountSecretRef, restampApprovals, testAccountApprovalDigest,
  testAccountApprovalsSatisfied, testAccountAwsEndpointHosts, testAccountExternalId, testAccountProdProblems, testAccountQualifyingApprovals, testAccountSchemaFor, testAccountSecretRef, testAccountWidened, checkTestAccountKeyShape,
  isTestAccountUsableAt,
  type AuditEventInput, type OrgId, type TestAccount, type TestAccountApproval, type TestAccountSecretGrant, type TestEnvProdDeny,
} from "@agentx/contracts";
import { createHash } from "node:crypto";
import type { TransactItem } from "../audit/outbox.js";
import { auditOccurrence, auditTestAccountChange, type AuditBuilderBase, type TestAccountAuditAction } from "../audit/events.js";
import { isFreshSignIn, type SessionRecord } from "../developer/store.js";
import { decideSecondPersonApproval, type ApprovalDecisionInput } from "../org/second-person-approval.js";
import type { ResolveGrant } from "./test-account-secrets.js";

// ---- bounds
/** A company holds this many test accounts at most, in any status. */
export const TEST_ACCOUNTS_MAX_PER_ORG = 100;
const DAY_MS = 86_400_000;
const DEFAULT_SECRET_KEY = "value";
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ---- records
export interface StoredTestAccount {
  account: TestAccount;
  /** Starts at 1; every change adds one. A write names the version it read. */
  version: number;
  /** Who made the change the account waits on (an add, a widening or a re-enable). A different admin approves it, unless the sole-owner exception applies. */
  proposedBy: string;
  proposedAt: string;
  /** The `expiresAt` a reminder was already sent for, so a reminder goes out once. */
  reminderSentFor?: string;
  /** The version id Secrets Manager gave the current value. A fact for support, not a value. */
  secretVersionId?: string;
}

/** A day's use of one account: rounds, tunnels the proxy opened, and bytes through them (both directions). */
export interface DayUsage { rounds: number; connections: number; bytes: number }

/**
 * The store. A DynamoDB adapter must: (1) make `commit` write the row, the audit event (the outbox) and `conditions` in ONE transaction, conditional on the stored version being `expectedVersion` (null: no row yet),
 * returning false when the condition fails; (2) enforce the per-company count with a counter item in the same transaction as an add (a count-then-write races); (3) make `addUsage` an atomic counter per
 * (account, day) that ALSO writes the daily `test_account.used` audit event once; (4) keep every key under the company id the caller proves. The in-memory store used in tests has none of these races.
 */
export interface TestAccountStore {
  get(orgId: OrgId, id: string): Promise<StoredTestAccount | undefined>;
  /** The company's accounts, at most `limit`. */
  list(orgId: OrgId, limit: number): Promise<StoredTestAccount[]>;
  /** `audit` is absent only for a change that is not an event (a new label). */
  commit(next: StoredTestAccount, expectedVersion: number | null, audit: AuditEventInput | undefined, conditions: readonly TransactItem[]): Promise<boolean>;
  remove(orgId: OrgId, id: string, expectedVersion: number, audit: AuditEventInput): Promise<boolean>;
  usageOn(orgId: OrgId, id: string, day: string): Promise<DayUsage>;
  addUsage(orgId: OrgId, id: string, projectId: string, day: string, add: DayUsage, audit: AuditEventInput): Promise<DayUsage>;
}

/** The secrets half the lifecycle needs (the class `TestAccountSecrets` is the real one): write a value, schedule its deletion, mint a session to read it. No method returns a value. */
export interface TestAccountSecretsPort {
  put(orgId: string, accountId: string, key: string, value: string): Promise<string>;
  /** Rotation: the new value as a version staged AWSPENDING (AWSCURRENT does not move), then `promote` after the row naming it is committed, or `discardPending` when it will not be. */
  putPending(orgId: string, accountId: string, key: string, value: string): Promise<string>;
  promote(orgId: string, accountId: string, versionId: string): Promise<void>;
  /** The version id AWSCURRENT points at now (read fresh), or undefined when it cannot be told. */
  currentVersionId(orgId: string, accountId: string): Promise<string | undefined>;
  discardPending(orgId: string, accountId: string, versionId: string): Promise<void>;
  scheduleDelete(orgId: string, accountId: string): Promise<void>;
  mintResolveGrant(orgId: string, accountId: string): Promise<ResolveGrant>;
}

export interface TestAccountCaller {
  orgId: OrgId;
  developerId: string;
  /** The caller's session (the route's authenticated `DeveloperCaller.sessionId`). Freshness is read from the stored session, never from the request. */
  sessionId: string;
}

export interface TestAccountDeps {
  /** The install's environment name: a secret reference must point into it. */
  env: string;
  /** The `ta` switch (`testAccountsEnabled`). Evaluated at every call. */
  enabled(): boolean;
  store: TestAccountStore;
  secrets: TestAccountSecretsPort;
  /** Live company owner or admin, read now (wire `requireLiveCompanyAdmin`). Throws FORBIDDEN. */
  requireAdmin(caller: { orgId: OrgId; developerId: string }): Promise<void>;
  /** The stored session record of the caller (`SESSION#<id>`), or undefined. */
  readSession(sessionId: string): Promise<Pick<SessionRecord, "authTime" | "developerId" | "revokedAt"> | undefined>;
  /**
   * The server-side evidence `decideSecondPersonApproval` needs, with the conditions that fence it at commit: wire `readSecondPersonApprovalEvidence` (org/second-person-evidence.ts) with `{ orgId, proposerId,
   * approverId }`. The decision input must name these two people, or the approval is refused.
   */
  approvalEvidence(scope: { orgId: OrgId; proposerId: string; approverId: string }): Promise<{ decisionInput: ApprovalDecisionInput; conditions: TransactItem[] }>;
  /**
   * The company's sole-owner setting, read now: whether the exception is allowed (its own switch; on unless the company turned it off) and the conditions that fence the setting's version, which commit with the
   * approval (a setting turned off between the read and the write refuses the write).
   */
  soleOwnerSetting(orgId: OrgId): Promise<{ allowed: boolean; conditions: TransactItem[] }>;
  /**
   * When this person's admin (or owner) role began, from the live role record; undefined when unknown. A second person whose role is under 24 hours old does not count as the second person (a freshly added
   * account is not a check on the person who added it). Read now. TS-ACC-1 makes this platform-wide.
   */
  adminSince(scope: { orgId: OrgId; developerId: string }): Promise<string | undefined>;
  /** The company's production deny list, read now. An empty list refuses every account (an account reaches a real remote, so the list must exist first). */
  prodDeny(orgId: OrgId): Promise<TestEnvProdDeny>;
  /** The AWS account ids that are Rovara's own: a role in one is refused. */
  rovaraAccountIds(): readonly string[];
  /** The company's expiry setting in whole days, 1 to 90. */
  maxExpiryDays(orgId: OrgId): Promise<number>;
  now(): Date;
  /** 16 random lower-case hex characters. */
  newSuffix(): string;
}

// ---- the gate and the fixed refusals

const off = () => agentXError("NOT_FOUND", "Not found");
const forbidden = () => agentXError("FORBIDDEN", "Live company owner or admin access is required.");
const reauth = () => agentXError("REAUTH_REQUIRED", "Sign in again to confirm this test account change.");
const stale = () => agentXError("CHANGE_STALE", "That test account changed. Refresh before continuing.");
const missing = () => agentXError("NOT_FOUND", "There is no such test account.");
const invalid = (message: string, extra: Record<string, unknown> = {}) => Object.assign(agentXError("CONFIG_INVALID", message), extra);

function gate(deps: Pick<TestAccountDeps, "enabled">): void {
  if (!deps.enabled()) throw off();
}

function validCaller(caller: TestAccountCaller): void {
  if (!OrgIdSchema.safeParse(caller.orgId).success || !DEVELOPER_ID.test(caller.developerId)) throw forbidden();
}

/** Admin now, then a stored session of the SAME person, not revoked, whose interactive sign-in is fresh by the platform's one rule. Returns the sign-in time for the audit proof. */
async function requireFreshAdmin(deps: TestAccountDeps, caller: TestAccountCaller): Promise<string> {
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
  const session = typeof caller.sessionId === "string" && caller.sessionId.length > 0 && caller.sessionId.length <= 200 ? await deps.readSession(caller.sessionId) : undefined;
  if (session === undefined || session.developerId !== caller.developerId || session.revokedAt !== undefined || session.authTime === undefined || !isFreshSignIn(session, deps.now().getTime())) throw reauth();
  return session.authTime;
}

async function requireAdminOnly(deps: TestAccountDeps, caller: TestAccountCaller): Promise<void> {
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
}

/** The least time a person has held the admin role before their approval counts as the second person's. */
export const SECOND_PERSON_MIN_ADMIN_MS = DAY_MS;

/** M2: an approver whose admin role began less than 24 hours ago (or whose start is unknown) is not the second person. */
async function requireSeasonedAdmin(deps: TestAccountDeps, caller: TestAccountCaller): Promise<void> {
  const since = await deps.adminSince({ orgId: caller.orgId, developerId: caller.developerId });
  const began = since === undefined ? Number.NaN : Date.parse(since);
  const availableAt = Number.isFinite(began) ? new Date(began + SECOND_PERSON_MIN_ADMIN_MS).toISOString() : null;
  if (!Number.isFinite(began) || began > deps.now().getTime() || deps.now().getTime() - began < SECOND_PERSON_MIN_ADMIN_MS) {
    throw Object.assign(agentXError("FORBIDDEN", "An admin counts as the second person after holding the role for 24 hours."), { availableAt });
  }
}

// ---- audit

interface Who { developerId: string; authTime?: string; sessionId?: string }

function auditBase(deps: TestAccountDeps, orgId: OrgId, who: Who | "system", occurrence: string, account: TestAccount): AuditBuilderBase {
  return {
    orgId,
    actor: who === "system" ? { kind: "system", id: "rovara" } : { kind: "member", id: who.developerId },
    occurredAt: deps.now().toISOString(),
    occurrence,
    ...(who !== "system" && who.authTime !== undefined && who.sessionId !== undefined
      ? { proof: { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: who.authTime, sessionRef: sha256Hex(who.sessionId) } }
      : {}),
    // The label and the family name the customer's own systems: personal data goes in details, never in a fact.
    details: [{ subject: "org", fields: { label: account.label, family: account.family } }],
  };
}

function auditOf(deps: TestAccountDeps, who: Who | "system", action: TestAccountAuditAction, stored: StoredTestAccount, facts: Record<string, string | number | boolean>): AuditEventInput {
  return auditTestAccountChange({ ...auditBase(deps, stored.account.orgId, who, auditOccurrence(stored.account.id, String(stored.version), action), stored.account), action, accountId: stored.account.id, facts });
}

const digestOf = (account: TestAccount): string => testAccountApprovalDigest(account);
const projectScope = (account: TestAccount): "all" | "list" => (account.projectIds === "all" ? "all" : "list");
const iso = (deps: Pick<TestAccountDeps, "now">): string => deps.now().toISOString();

// ---- drafts and checking

/** What a person gives to add an account. The id, the secret reference, the status and the approvals are Rovara's. */
export interface TestAccountDraft {
  label: string;
  kind: TestAccount["kind"];
  family: string;
  /** For an AWS role account the hosts are derived from the approved services; for any other, the account's own host is the family's. */
  hosts?: readonly string[];
  envNames?: readonly string[];
  projectIds: TestAccount["projectIds"];
  limits?: Partial<TestAccount["limits"]>;
  /** The role, region, actions and resources. The external id is Rovara's (`testAccountExternalId`): a value that differs from it is refused. */
  aws?: AwsInput;
  /** The JSON key the value is stored under (default `value`); part of the reference. */
  secretKey?: string;
}

/** The changes `updateTestAccount` accepts. The id, kind, family and secret reference never change: that is a different account (delete it and add a new one). */
export interface TestAccountChanges {
  label?: string;
  hosts?: readonly string[];
  envNames?: readonly string[];
  projectIds?: TestAccount["projectIds"];
  limits?: Partial<TestAccount["limits"]>;
  aws?: AwsInput;
}

/** The AWS block as a person gives it: no external id (Rovara derives it). */
export type AwsInput = Omit<NonNullable<TestAccount["aws"]>, "externalId"> & { externalId?: string };

/** The AWS block with Rovara's external id for this company and account. A customer-supplied id that is not that one is refused, never used. */
function withExternalId(orgId: OrgId, accountId: string, input: AwsInput): NonNullable<TestAccount["aws"]> {
  const derived = testAccountExternalId(orgId, accountId);
  if (input.externalId !== undefined && input.externalId !== derived) throw invalid("The external id is set by Rovara; leave it out.", { fields: ["aws.externalId"] });
  return { ...input, externalId: derived };
}

/** The names of the fields a schema refused, never the values. */
function fieldsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string[] {
  return [...new Set(issues.map((issue) => issue.path.map(String).join(".")).filter((path) => path !== ""))].slice(0, 12);
}

function checkedAccount(deps: TestAccountDeps, maxDays: number, candidate: unknown): TestAccount {
  const parsed = testAccountSchemaFor({ env: deps.env, maxExpiryDays: maxDays }).safeParse(candidate);
  if (!parsed.success) {
    const fields = fieldsOf(parsed.error.issues);
    throw invalid(`That test account is not valid. Check: ${fields.join(", ") || "its fields"}.`, { fields });
  }
  return parsed.data;
}

async function requireNotProduction(deps: TestAccountDeps, account: TestAccount): Promise<void> {
  const problems = testAccountProdProblems(account, await deps.prodDeny(account.orgId), { rovaraAccountIds: deps.rovaraAccountIds() });
  if (problems.length > 0) throw invalid("That test account names production or Rovara's own account.", { problems: problems.slice(0, 12) });
}

const ownApproval = (deps: TestAccountDeps, developerId: string, account: TestAccount, kind: TestAccountApproval["kind"] = "approver"): TestAccountApproval => ({
  by: developerId, at: iso(deps), freshSignIn: true, kind, approvedDigest: digestOf(account),
});

function ensureAccountId(suffix: string): string {
  return `ta-${suffix}`;
}

// ---- add

export interface AddInput {
  draft: TestAccountDraft;
  /** The secret's value, for a kind that has one. It is checked, stored, and not kept anywhere else. */
  secretValue?: string;
}

/**
 * Adds an account as `pending`: it counts the adding person's fresh-sign-in approval of the exact record, and waits for a second person (`approveTestAccount`). Order: the shape of the record, the production deny
 * list, the key shape of the value, the company's count, then the secret is written, then the row. A row that cannot be written takes the secret back (scheduled for deletion).
 */
export async function addTestAccount(deps: TestAccountDeps, caller: TestAccountCaller, input: AddInput): Promise<StoredTestAccount> {
  gate(deps);
  const authTime = await requireFreshAdmin(deps, caller);
  const maxDays = await deps.maxExpiryDays(caller.orgId);
  const id = ensureAccountId(deps.newSuffix());
  const draft = input.draft;
  const key = draft.secretKey ?? DEFAULT_SECRET_KEY;
  const needsSecret = draft.kind === "api_key" || draft.kind === "oauth_client" || draft.kind === "basic";
  const hasValue = input.secretValue !== undefined;
  if (needsSecret && !hasValue) throw invalid("This kind of test account needs its secret value.", { fields: ["secretValue"] });
  if (draft.kind === "aws_role" && hasValue) throw invalid("An AWS role account stores no secret.", { fields: ["secretValue"] });
  if (draft.kind === "aws_role" && draft.aws === undefined) throw invalid("An AWS role account needs its role, actions and resources.", { fields: ["aws"] });
  const withSecret = hasValue && draft.kind !== "aws_role";
  const candidate = {
    id, orgId: caller.orgId, projectIds: draft.projectIds, family: draft.family, label: draft.label, kind: draft.kind,
    ...(withSecret ? { secretRef: testAccountSecretRef(deps.env, caller.orgId, id, key) } : {}),
    ...(draft.aws === undefined ? {} : { aws: withExternalId(caller.orgId, id, draft.aws) }),
    hosts: draft.hosts !== undefined ? [...draft.hosts] : draft.aws !== undefined ? testAccountAwsEndpointHosts(draft.aws) : draft.family.startsWith("http:") ? [draft.family.slice(5)] : [],
    envNames: draft.kind === "aws_role" ? [] : [...(draft.envNames ?? [])],
    limits: { ...TEST_ACCOUNT_LIMIT_DEFAULTS, ...draft.limits },
    approvals: [], status: "pending",
  };
  let account = checkedAccount(deps, maxDays, candidate);
  account = { ...account, approvals: [ownApproval(deps, caller.developerId, account)] };
  await requireNotProduction(deps, account);
  if (withSecret) {
    const verdict = checkTestAccountKeyShape(account.family, input.secretValue as string);
    if (!verdict.ok) throw invalid("That value does not look like a test key.", { reason: verdict.code, fields: ["secretValue"] });
  }
  if ((await deps.store.list(caller.orgId, TEST_ACCOUNTS_MAX_PER_ORG + 1)).length >= TEST_ACCOUNTS_MAX_PER_ORG) throw invalid("This company has the most test accounts it can hold. Delete one first.");
  let secretVersionId: string | undefined;
  if (withSecret) secretVersionId = await deps.secrets.put(caller.orgId, id, key, input.secretValue as string);
  const stored: StoredTestAccount = { account, version: 1, proposedBy: caller.developerId, proposedAt: iso(deps), ...(secretVersionId === undefined ? {} : { secretVersionId }) };
  const audit = auditOf(deps, { developerId: caller.developerId, authTime, sessionId: caller.sessionId }, "test_account.added", stored, { kind: account.kind, digest: digestOf(account), hostCount: account.hosts.length, projectScope: projectScope(account) });
  let committed = false;
  try {
    committed = await deps.store.commit(stored, null, audit, []);
  } finally {
    // A row that did not get written leaves no account, so its secret goes (best effort: the row's failure is the answer, and a retry of the delete is safe).
    if (!committed && withSecret) await deps.secrets.scheduleDelete(caller.orgId, id).catch(() => undefined);
  }
  if (!committed) throw stale();
  return stored;
}

// ---- approve

export interface ApproveInput { id: string; expectedVersion: number; expectedDigest: string }

/**
 * A second person's approval of the exact record they saw (version and digest). Fresh sign-in, live admin; the approver is a DIFFERENT eligible admin than the one who made the change, EXCEPT through the sole-owner
 * exception (`decideSecondPersonApproval`; unavailable when the company turned it off). The production deny list is checked again now. When the approvals are enough the account becomes `active` and expires within the
 * company's days of this approval.
 */
export async function approveTestAccount(deps: TestAccountDeps, caller: TestAccountCaller, input: ApproveInput): Promise<StoredTestAccount> {
  gate(deps);
  const authTime = await requireFreshAdmin(deps, caller);
  const current = await deps.store.get(caller.orgId, input.id);
  if (current === undefined || current.account.orgId !== caller.orgId) throw missing();
  const account = current.account;
  if (account.status !== "pending") throw agentXError("CHANGE_STALE", "That test account is not waiting for approval.");
  if (current.version !== input.expectedVersion || digestOf(account) !== input.expectedDigest) throw stale();
  const proposerId = current.proposedBy;
  const soleOwner = await deps.soleOwnerSetting(caller.orgId);
  if (proposerId === caller.developerId && !soleOwner.allowed) {
    throw Object.assign(agentXError("FORBIDDEN", "Another admin must approve this test account."), { soleOwner: { available: false, availableAt: null, reasonCode: "SOLE_OWNER_OFF" } });
  }
  const evidence = await deps.approvalEvidence({ orgId: caller.orgId, proposerId, approverId: caller.developerId });
  if (evidence.decisionInput.proposerId !== proposerId || evidence.decisionInput.approverId !== caller.developerId || evidence.conditions.length === 0) throw stale();
  const decision = decideSecondPersonApproval(evidence.decisionInput);
  if (decision.mode === "second_person") await requireSeasonedAdmin(deps, caller);
  await requireNotProduction(deps, account);
  const maxDays = await deps.maxExpiryDays(caller.orgId);
  const kind = decision.mode === "sole_owner_exception" ? "sole_owner_exception" : "approver";
  const approvals = [...testAccountQualifyingApprovals(account), ownApproval(deps, caller.developerId, account, kind)];
  if (!testAccountApprovalsSatisfied(testAccountQualifyingApprovals({ ...account, approvals }, deps.now().getTime()))) throw agentXError("CHANGE_STALE", "That test account still needs a second person.");
  const approvedAt = deps.now().getTime();
  const next = checkedAccount(deps, maxDays, { ...account, approvals: approvals.slice(-10), status: "active", expiresAt: new Date(approvedAt + maxDays * DAY_MS).toISOString() });
  const stored: StoredTestAccount = { ...current, account: next, version: current.version + 1 };
  const audit = auditOf(deps, { developerId: caller.developerId, authTime, sessionId: caller.sessionId }, "test_account.approved", stored, {
    digest: digestOf(next), approvalMode: decision.mode, approvals: testAccountQualifyingApprovals(next).length, expiresInDays: maxDays,
  });
  // The evidence conditions commit with the write: a second admin added, or either person changed, since the read refuses it.
  if (!await deps.store.commit(stored, current.version, audit, [...evidence.conditions, ...soleOwner.conditions])) throw stale();
  return stored;
}

// ---- update: narrow at once, widen and wait

export interface UpdateInput { id: string; expectedVersion: number; changes: TestAccountChanges }

/**
 * Changes an account. A pure NARROWING (`testAccountWidened` false) applies at once: the approvals are re-stamped with the new digest and the status stays as it was. A change this function cannot prove smaller is a
 * WIDENING: the account becomes `pending` with the editing person's fresh approval of the new record, loses its expiry, and is unusable until a second person approves it (an active account is not left running on the
 * wider record). A change that leaves the digest as it was (a new label) is stored and not audited.
 */
export async function updateTestAccount(deps: TestAccountDeps, caller: TestAccountCaller, input: UpdateInput): Promise<StoredTestAccount> {
  gate(deps);
  const authTime = await requireFreshAdmin(deps, caller);
  const current = await deps.store.get(caller.orgId, input.id);
  if (current === undefined || current.account.orgId !== caller.orgId) throw missing();
  if (current.version !== input.expectedVersion) throw stale();
  const previous = current.account;
  if (previous.status === "deleting") throw stale();
  const maxDays = await deps.maxExpiryDays(caller.orgId);
  const changes = input.changes;
  const changedAws = changes.aws === undefined ? undefined : withExternalId(previous.orgId, previous.id, changes.aws);
  const hosts = changes.hosts !== undefined ? [...changes.hosts] : changedAws !== undefined ? testAccountAwsEndpointHosts(changedAws) : previous.hosts;
  const shaped = {
    ...previous,
    ...(changes.label === undefined ? {} : { label: changes.label }),
    hosts,
    ...(changes.envNames === undefined ? {} : { envNames: [...changes.envNames] }),
    ...(changes.projectIds === undefined ? {} : { projectIds: changes.projectIds }),
    ...(changes.limits === undefined ? {} : { limits: { ...previous.limits, ...changes.limits } }),
    ...(changedAws === undefined ? {} : { aws: changedAws }),
  };
  // The schema checks the new record as a record; whether it is active is decided below, so it is checked as pending with the approvals it will have.
  const widened = testAccountWidened(previous, shaped);
  const unchanged = digestOf(previous) === digestOf(shaped);
  let next: TestAccount;
  let action: TestAccountAuditAction | undefined;
  if (unchanged) {
    next = checkedAccount(deps, maxDays, shaped);
  } else if (!widened) {
    next = checkedAccount(deps, maxDays, { ...shaped, approvals: restampApprovals(previous, shaped) });
    action = "test_account.narrowed";
  } else {
    const draft = checkedAccount(deps, maxDays, { ...shaped, approvals: [], status: "pending", expiresAt: undefined });
    next = { ...draft, approvals: [ownApproval(deps, caller.developerId, draft)] };
    action = "test_account.widened";
  }
  await requireNotProduction(deps, next);
  const stored: StoredTestAccount = {
    ...current, account: next, version: current.version + 1,
    ...(action === "test_account.widened" ? { proposedBy: caller.developerId, proposedAt: iso(deps) } : {}),
  };
  // Only a label changed (no action): no audit event, since the label is cosmetic and not part of any approval.
  const audit = action === undefined ? undefined : auditOf(deps, { developerId: caller.developerId, authTime, sessionId: caller.sessionId }, action, stored, { digest: digestOf(next), fromDigest: digestOf(previous) });
  if (!await deps.store.commit(stored, current.version, audit, [])) throw stale();
  return stored;
}

// ---- rotate, suspend, re-enable, delete

/** Stores a new value for the same reference. The key-shape check applies; the record and its approvals do not change. */
export async function rotateTestAccountSecret(deps: TestAccountDeps, caller: TestAccountCaller, input: { id: string; expectedVersion: number; secretValue: string }): Promise<StoredTestAccount> {
  gate(deps);
  const authTime = await requireFreshAdmin(deps, caller);
  const current = await deps.store.get(caller.orgId, input.id);
  if (current === undefined || current.account.orgId !== caller.orgId) throw missing();
  if (current.version !== input.expectedVersion) throw stale();
  const account = current.account;
  const ref = account.secretRef === undefined ? undefined : parseTestAccountSecretRef(account.secretRef);
  if (ref === undefined) throw invalid("This test account stores no secret.");
  const verdict = checkTestAccountKeyShape(account.family, input.secretValue);
  if (!verdict.ok) throw invalid("That value does not look like a test key.", { reason: verdict.code, fields: ["secretValue"] });
  if (account.status === "deleting") throw stale();
  const who = { developerId: caller.developerId, authTime, sessionId: caller.sessionId };
  // 1. The new value goes in as AWSPENDING: nothing that reads the secret sees it, so a failure from here on leaves the old value serving.
  const pendingId = await deps.secrets.putPending(caller.orgId, account.id, ref.key, input.secretValue);
  const stored: StoredTestAccount = { ...current, account: { ...account, rotatedAt: iso(deps) }, version: current.version + 1, secretVersionId: pendingId };
  const audit = auditOf(deps, who, "test_account.rotated", stored, { digest: digestOf(account) });
  // 2. The row and the audit name that version.
  let committed = false;
  let commitError: unknown;
  try {
    committed = await deps.store.commit(stored, current.version, audit, []);
  } catch (error) {
    commitError = error;
  }
  if (!committed) {
    // Not committed: the pending version will not be promoted. Best effort to take its label off; AWSCURRENT was never touched.
    await deps.secrets.discardPending(caller.orgId, account.id, pendingId).catch(() => undefined);
    if (commitError !== undefined) throw commitError instanceof Error ? commitError : agentXError("RUNTIME_UNAVAILABLE", "The test account store failed.");
    throw stale();
  }
  // 3. Only now does the new value become the one that is read.
  try {
    await deps.secrets.promote(caller.orgId, account.id, pendingId);
  } catch (error) {
    // The promotion may have taken effect even though the call failed (a lost answer): look at the stages before undoing anything.
    const serving = await deps.secrets.currentVersionId(caller.orgId, account.id).catch(() => undefined);
    await deps.secrets.discardPending(caller.orgId, account.id, pendingId).catch(() => undefined);
    // AWSCURRENT already points at the new version: the rotation is done, and the row that names it is already committed.
    if (serving === pendingId) return stored;
    // Otherwise the row goes back to the version that still serves, and the failed rotation is audited (best effort: the failure itself is the answer).
    const reverted: StoredTestAccount = { ...stored, account, version: stored.version + 1, ...(current.secretVersionId === undefined ? {} : { secretVersionId: current.secretVersionId }) };
    if (current.secretVersionId === undefined) delete reverted.secretVersionId;
    const putBack = await deps.store.commit(reverted, stored.version, auditOf(deps, who, "test_account.rotation_failed", reverted, { cause: "promote" }), []).catch(() => false);
    // Neither the secret nor the row could be settled: the row names a version that does not serve. The account is suspended (unusable) and the failure audited with a fixed reason.
    if (!putBack) await suspendAfterFailedRotation(deps, caller.orgId, account.id, who);
    throw error;
  }
  return stored;
}

/** Last resort of a rotation whose promotion failed and whose row could not be put back: suspend the account from its latest row and audit `rotation_failed` with the fixed reason `revert_failed`. Best effort; never throws. */
async function suspendAfterFailedRotation(deps: TestAccountDeps, orgId: OrgId, accountId: string, who: Who): Promise<void> {
  try {
    const latest = await deps.store.get(orgId, accountId);
    if (latest === undefined || latest.account.status === "suspended") return;
    const { expiresAt: _expiresAt, ...rest } = latest.account;
    void _expiresAt;
    const suspended: StoredTestAccount = { ...latest, account: { ...rest, status: "suspended" }, version: latest.version + 1 };
    await deps.store.commit(suspended, latest.version, auditOf(deps, who, "test_account.rotation_failed", suspended, { cause: "revert_failed" }), []);
  } catch {
    // Nothing more can be done from here; the original failure is the answer.
  }
}

/** Suspends an account at once (a live admin, no second person). Anything not already suspended can be suspended; the account is unusable from this commit. */
export async function suspendTestAccount(deps: TestAccountDeps, caller: TestAccountCaller, input: { id: string; expectedVersion: number }): Promise<StoredTestAccount> {
  gate(deps);
  await requireAdminOnly(deps, caller);
  const current = await deps.store.get(caller.orgId, input.id);
  if (current === undefined || current.account.orgId !== caller.orgId) throw missing();
  if (current.version !== input.expectedVersion) throw stale();
  if (current.account.status === "suspended") return current;
  if (current.account.status === "deleting") throw stale();
  const { expiresAt: _expiresAt, ...rest } = current.account;
  void _expiresAt;
  const stored: StoredTestAccount = { ...current, account: { ...rest, status: "suspended" }, version: current.version + 1 };
  if (!await deps.store.commit(stored, current.version, auditOf(deps, { developerId: caller.developerId }, "test_account.suspended", stored, { cause: "manual" }), [])) throw stale();
  return stored;
}

/** Re-enabling is a less-safe change: the account goes back to `pending` with the re-enabling person's fresh approval and waits for a second person. Its earlier approvals do not count. */
export async function reenableTestAccount(deps: TestAccountDeps, caller: TestAccountCaller, input: { id: string; expectedVersion: number }): Promise<StoredTestAccount> {
  gate(deps);
  const authTime = await requireFreshAdmin(deps, caller);
  const current = await deps.store.get(caller.orgId, input.id);
  if (current === undefined || current.account.orgId !== caller.orgId) throw missing();
  if (current.version !== input.expectedVersion) throw stale();
  const previous = current.account;
  if (previous.status !== "suspended" && previous.status !== "expired") throw agentXError("CHANGE_STALE", "Only a suspended or expired test account is re-enabled.");
  const maxDays = await deps.maxExpiryDays(caller.orgId);
  const { expiresAt: _expiresAt, ...rest } = previous;
  void _expiresAt;
  const draft = checkedAccount(deps, maxDays, { ...rest, approvals: [], status: "pending" });
  await requireNotProduction(deps, draft);
  const next: TestAccount = { ...draft, approvals: [ownApproval(deps, caller.developerId, draft)] };
  const stored: StoredTestAccount = { ...current, account: next, version: current.version + 1, proposedBy: caller.developerId, proposedAt: iso(deps) };
  const audit = auditOf(deps, { developerId: caller.developerId, authTime, sessionId: caller.sessionId }, "test_account.reenable_requested", stored, { digest: digestOf(next), fromStatus: previous.status });
  if (!await deps.store.commit(stored, current.version, audit, [])) throw stale();
  return stored;
}

/** Deletes an account at once (a live admin). The row is first committed as `deleting` (audited, unusable), then the secret is scheduled for deletion (7-day recovery window), then the row goes, so a failure in between leaves a row that says a deletion was under way, never a live account whose secret is going and never a secret without an owner. Deleting the same account again finishes it. */
export async function deleteTestAccount(deps: TestAccountDeps, caller: TestAccountCaller, input: { id: string; expectedVersion: number }): Promise<void> {
  gate(deps);
  await requireAdminOnly(deps, caller);
  const current = await deps.store.get(caller.orgId, input.id);
  if (current === undefined || current.account.orgId !== caller.orgId) throw missing();
  if (current.version !== input.expectedVersion) throw stale();
  let latest = current;
  if (current.account.secretRef !== undefined) {
    // The row says "deleting" (audited, unusable) BEFORE the secret's deletion is scheduled: a crash in between leaves a row that says what was under way, never a live account whose secret is going.
    if (current.account.status !== "deleting") {
      const { expiresAt: _expiresAt, ...rest } = current.account;
      void _expiresAt;
      const deleting: StoredTestAccount = { ...current, account: { ...rest, status: "deleting" }, version: current.version + 1 };
      const marked = auditOf(deps, { developerId: caller.developerId }, "test_account.deleting", deleting, { kind: current.account.kind, cause: "manual" });
      if (!await deps.store.commit(deleting, current.version, marked, [])) throw stale();
      latest = deleting;
    }
    await deps.secrets.scheduleDelete(caller.orgId, current.account.id);
  }
  const audit = auditOf(deps, { developerId: caller.developerId }, "test_account.deleted", latest, { kind: current.account.kind, cause: "manual" });
  if (!await deps.store.remove(caller.orgId, current.account.id, latest.version, audit)) throw stale();
}

// ---- expiry

/** Ends every active account of the company that has passed its expiry (status `expired`, audited by the system). Returns how many ended. A change that lost a race is left for the next sweep. */
export async function expireDueAccounts(deps: TestAccountDeps, orgId: OrgId): Promise<number> {
  gate(deps);
  const now = deps.now().getTime();
  let ended = 0;
  for (const current of await deps.store.list(orgId, TEST_ACCOUNTS_MAX_PER_ORG)) {
    const { account } = current;
    if (account.status !== "active") continue;
    const expires = account.expiresAt === undefined ? Number.NaN : Date.parse(account.expiresAt);
    if (Number.isFinite(expires) && expires > now) continue;
    const stored: StoredTestAccount = { ...current, account: { ...account, status: "expired" }, version: current.version + 1 };
    if (await deps.store.commit(stored, current.version, auditOf(deps, "system", "test_account.expired", stored, { digest: digestOf(account) }), [])) ended += 1;
  }
  return ended;
}

/** The active accounts whose expiry is within the reminder window (14 days) and that were not reminded for that expiry yet. Pure. */
export function remindersDue(accounts: readonly StoredTestAccount[], now: Date): StoredTestAccount[] {
  const at = now.getTime();
  return accounts.filter(({ account, reminderSentFor }) => {
    if (account.status !== "active" || account.expiresAt === undefined) return false;
    const expires = Date.parse(account.expiresAt);
    return Number.isFinite(expires) && expires > at && expires - at <= TEST_ACCOUNT_EXPIRY_DAYS.reminder * DAY_MS && reminderSentFor !== account.expiresAt;
  });
}

// ---- use in a sealed round

/** Where a round runs. Only a sealed check round may use an account (6.3): not the setup run, the working sandbox or a team runner (Q8). */
export type RoundPlace = "sealed_round" | "setup_run" | "working_sandbox" | "team_runner";

export type RoundRefusal = "not_sealed" | "not_found" | "not_active" | "expired" | "project_not_allowed" | "production" | "day_cap";

export type RoundAccount = { id: string; ok: true; account: TestAccount } | { id: string; ok: false; refusal: RoundRefusal };

export interface RoundInput { orgId: OrgId; projectId: string; place: RoundPlace; accountIds: readonly string[] }

const dayOf = (deps: Pick<TestAccountDeps, "now">): string => deps.now().toISOString().slice(0, 10);

/**
 * Which of the named accounts this round may use, each with a fixed reason when not. Checked now, at every run: the place, the status, the expiry (a record that did not come through the schema is checked again by
 * `isTestAccountUsableAt`), the project, the production deny list (so an entry added after the account was approved stops it), and the day's request cap.
 */
export async function resolveAccountsForRound(deps: TestAccountDeps, input: RoundInput): Promise<RoundAccount[]> {
  gate(deps);
  if (input.place !== "sealed_round") return input.accountIds.map((id) => ({ id, ok: false as const, refusal: "not_sealed" as const }));
  const now = deps.now();
  const deny = await deps.prodDeny(input.orgId);
  const maxDays = await deps.maxExpiryDays(input.orgId);
  const results: RoundAccount[] = [];
  for (const id of new Set(input.accountIds)) {
    const stored = await deps.store.get(input.orgId, id);
    // A record under another company's id is not this company's account.
    if (stored === undefined || stored.account.orgId !== input.orgId || stored.account.id !== id) { results.push({ id, ok: false, refusal: "not_found" }); continue; }
    const account = stored.account;
    if (account.status === "expired") { results.push({ id, ok: false, refusal: "expired" }); continue; }
    if (account.status !== "active") { results.push({ id, ok: false, refusal: "not_active" }); continue; }
    if (!isTestAccountUsableAt(account, now, { maxExpiryDays: maxDays })) { results.push({ id, ok: false, refusal: account.expiresAt !== undefined && Date.parse(account.expiresAt) <= now.getTime() ? "expired" : "not_active" }); continue; }
    if (account.projectIds !== "all" && !account.projectIds.includes(input.projectId)) { results.push({ id, ok: false, refusal: "project_not_allowed" }); continue; }
    if (testAccountProdProblems(account, deny, { rovaraAccountIds: deps.rovaraAccountIds() }).length > 0) { results.push({ id, ok: false, refusal: "production" }); continue; }
    const used = await deps.store.usageOn(input.orgId, id, dayOf(deps));
    if (used.connections >= account.limits.maxConnectionsPerDay) { results.push({ id, ok: false, refusal: "day_cap" }); continue; }
    results.push({ id, ok: true, account });
  }
  return results;
}

/**
 * For each account the round may use and that has a secret and variables to put it in, a grant the worker reads the one secret with. The broker mints a session for it (`mintResolveGrant`) and never reads the
 * value. The result is checked against the grant contract before it is returned. Nothing is minted for an account the round may not use, or for any place but a sealed round.
 */
export async function mintRoundGrants(deps: TestAccountDeps, input: RoundInput): Promise<{ accounts: RoundAccount[]; grants: TestAccountSecretGrant[] }> {
  const accounts = await resolveAccountsForRound(deps, input);
  const grants: TestAccountSecretGrant[] = [];
  for (const entry of accounts) {
    if (!entry.ok) continue;
    const { account } = entry;
    const parts = account.secretRef === undefined ? undefined : parseTestAccountSecretRef(account.secretRef);
    if (parts === undefined || account.envNames.length === 0) continue;
    const minted = await deps.secrets.mintResolveGrant(input.orgId, account.id);
    const grant = parseTestAccountSecretGrant({
      orgId: account.orgId, accountId: account.id, family: account.family, secretName: minted.secretName, key: parts.key, region: minted.region, envNames: account.envNames, credentials: minted.credentials, expiresAt: minted.expiresAt,
    });
    if (grant === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the test account grant was not usable");
    grants.push(grant);
  }
  return { accounts, grants };
}

/** Adds one round's use to the account's day (and, once a day, its audit roll-up). Returns the day's totals. */
export async function recordTestAccountUse(deps: TestAccountDeps, input: { orgId: OrgId; accountId: string; projectId: string; rounds: number; connections: number; bytes: number }): Promise<DayUsage> {
  gate(deps);
  const stored = await deps.store.get(input.orgId, input.accountId);
  if (stored === undefined || stored.account.orgId !== input.orgId) throw missing();
  if (![input.rounds, input.connections, input.bytes].every((count) => Number.isSafeInteger(count) && count >= 0)) throw invalid("not a usage count");
  const day = dayOf(deps);
  const audit = auditTestAccountChange({
    ...auditBase(deps, input.orgId, "system", auditOccurrence(input.accountId, sha256Hex(input.projectId).slice(0, 16), day, "used"), stored.account),
    action: "test_account.used", accountId: input.accountId, facts: { day, rounds: input.rounds, connections: input.connections, bytes: input.bytes },
  });
  return deps.store.addUsage(input.orgId, input.accountId, input.projectId, day, { rounds: input.rounds, connections: input.connections, bytes: input.bytes }, audit);
}
