// Proof and test environment E1 (design proof-test-env, sections 4.1 and 4.2): the project's test environment as a project setting. Rovara PROPOSES it, a Prove run checks it, a maintainer approves it
// once, and each approved change is a new immutable revision. A task keeps the revision it started with (`readApprovedTestEnvironment` with a revision).
//
// What is stored, all under the project's partition in the State table:
//   TESTENV#PROPOSAL#<digest>  the proposed body (bounded life, 7 days), so an approval names a digest and never carries a body of its own;
//   TESTENV#PROVE#<digest>     the worker's Prove report for exactly that digest (`recordTestEnvProveReport`);
//   TESTENV#REV#<revision>     the approved environment, immutable;
//   TESTENV#LATEST             the pointer to the newest revision (the only item an approval updates).
//
// What the approval refuses, in this order (each is its own fixed message, none repeats a value):
//   the caller cannot edit settings; the proposal is missing or has expired; the Prove run did not pass for this digest; the environment names production (or reaches a remote while the company has not listed
//   production); the revision the person looked at is not the newest; a less-safe change without a second person who signed in just now.
// The less-safe check is deliberately the blunt one `testEnvLessSafeChanges` gives (pre-prod, shared env, preview, video, traces, schema-synth mocks, a raised round budget). A change that turns on none of them
// is an ordinary approval. The caller (the confirmation page route) fences the two people's live authority in its own transaction; this module checks only what it is handed.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  TestEnvProveReportSchema,
  TestEnvironmentBodySchema,
  TestEnvironmentSchema,
  agentXError,
  projectAllows,
  projectMetaKey,
  projectPk,
  testEnvApprovalRisk,
  testEnvDigest,
  testEnvIsProved,
  testEnvLessSafeChanges,
  testEnvProdDenyViolations,
  type DecisionRisk,
  type OrgId,
  type ProjectRole,
  type TestEnvLessSafeField,
  type TestEnvironment,
  type TestEnvironmentBody,
} from "@agentx/contracts";
import { auditOccurrence, auditProjectTestEnvChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent, type AuditDeps, type TransactItem } from "../audit/outbox.js";
import { readSecondPersonApprovalEvidence, type SecondPersonEvidenceDependencies } from "./second-person-evidence.js";
import { decideSecondPersonApproval } from "./second-person-approval.js";

/** What the second-person check answers: the mode the COMPANY'S RECORDS allow, and the conditions that pin both people's live authority so they commit with the approval. */
export interface SecondPersonCheck { mode: "second_person" | "sole_owner_exception"; membershipVersion: number; conditions: TransactItem[] }
export type SecondPersonPort = (scope: { orgId: OrgId; project: string; proposerId: string; approverId: string }) => Promise<SecondPersonCheck>;

export interface TestEnvDeps extends AuditDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  /**
   * The server-side second-person check. Required for any less-safe approval (absent: refused). Bind it with `secondPersonFromRecords`: it reads the live roles of both people (an owner or admin, or a project
   * maintainer), whether the company has a sole owner, and refuses otherwise. The caller's claims about either person are never used.
   */
  secondPerson?: SecondPersonPort;
}

/** The real second-person check over the company's records (the same evidence and decision every other less-safe approval uses). */
export function secondPersonFromRecords(deps: SecondPersonEvidenceDependencies): SecondPersonPort {
  return async (scope) => {
    const { decisionInput, conditions } = await readSecondPersonApprovalEvidence(deps, scope);
    const decision = decideSecondPersonApproval(decisionInput);
    return { mode: decision.mode, membershipVersion: decision.membershipVersion, conditions };
  };
}

type Item = Record<string, unknown>;

/** How long a proposal stays approvable. A later change to the repositories makes an old proposal wrong, so it is not kept long. */
export const TEST_ENV_PROPOSAL_TTL_MS = 7 * 86_400_000;
/** A less-safe approval needs the second person to have signed in this recently, as the confirmation page asks. */
export const TEST_ENV_FRESH_SIGN_IN_MS = 10 * 60_000;
const REVISION_WIDTH = 8;

const REVISION_PREFIX = "TESTENV#REV#";
const keyOf = (orgId: OrgId, project: string, sk: string) => ({ pk: projectPk(orgId, project), sk });
const revisionKey = (orgId: OrgId, project: string, revision: number) => keyOf(orgId, project, `${REVISION_PREFIX}${String(revision).padStart(REVISION_WIDTH, "0")}`);
const latestKey = (orgId: OrgId, project: string) => keyOf(orgId, project, "TESTENV#LATEST");
const proposalKey = (orgId: OrgId, project: string, digest: string) => keyOf(orgId, project, `TESTENV#PROPOSAL#${digest}`);
const proveKey = (orgId: OrgId, project: string, digest: string) => keyOf(orgId, project, `TESTENV#PROVE#${digest}`);

const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const stale = (message: string) => agentXError("CHANGE_STALE", message);
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "the project's test environment could not be read");
const DIGEST = /^[a-f0-9]{64}$/;

async function read(deps: TestEnvDeps, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
}

/** The body, or CONFIG_INVALID naming the field and what is wrong with it, never the value. */
function parseBody(body: unknown): TestEnvironmentBody {
  const parsed = TestEnvironmentBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`${issue?.path.join(".") || "environment"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const PROD_WORDS: Record<string, string> = {
  prod_host: "names a production address",
  prod_arn: "names a production resource",
  prod_account: "is in a production account",
  prod_deny_missing: "reaches a real service, but the company has not listed what production is: list it first",
};

/** Refuses an environment that names production. The message names the field and a fixed reason, never the value. */
function refuseProduction(body: TestEnvironmentBody, previous?: TestEnvironmentBody): void {
  const found = testEnvProdDenyViolations(body, previous?.prodDeny)[0];
  if (found !== undefined) throw invalid(`${found.field} ${PROD_WORDS[found.kind] ?? "names production"}`);
}

/** The contract's less-safe fields (pre-prod, shared, preview, video, traces, schema-synth, a raised budget, a moved target, a shortened deny list): any of them needs a second person. */
export type TestEnvChangeFlag = TestEnvLessSafeField;

const changeFlags = (previous: TestEnvironmentBody | undefined, next: TestEnvironmentBody): TestEnvChangeFlag[] => testEnvLessSafeChanges(previous, next);


export interface ProposedTestEnvironment { digest: string; risk: DecisionRisk; lessSafe: TestEnvChangeFlag[] }

/**
 * Stores a proposal so it can be proved and approved by its digest. Needs `edit_settings`. Production is refused here, not only at approval, so a person never approves a card that could not be applied.
 * Proposing the same body again is the same proposal (the digest is the id), and renews its life.
 */
export async function proposeTestEnvironment(
  deps: TestEnvDeps,
  input: { orgId: OrgId; project: string; proposedBy: string; role: ProjectRole | undefined; body: unknown; valueSources?: unknown },
): Promise<ProposedTestEnvironment> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can propose a test environment");
  const body = parseBody(input.body);
  const previous = await readApprovedTestEnvironment(deps, input.orgId, input.project);
  refuseProduction(body, previous?.environment);
  const digest = testEnvDigest(body);
  const now = deps.now();
  await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: [{
      Put: {
        TableName: deps.tableName,
        Item: {
          ...proposalKey(input.orgId, input.project, digest), entityType: "TEST_ENV_PROPOSAL", orgId: input.orgId, project: input.project, digest, proposedBy: input.proposedBy,
          proposedAt: new Date(now).toISOString(), environment: body, ...(input.valueSources === undefined ? {} : { valueSources: input.valueSources }),
          [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + TEST_ENV_PROPOSAL_TTL_MS) / 1000),
        },
      },
    }],
  }));
  const lessSafe = changeFlags(previous?.environment, body);
  return { digest, risk: lessSafe.length > 0 ? "high" : testEnvApprovalRisk(body), lessSafe };
}

/** Reads a stored proposal's body, checking that it still hashes to its own key. Undefined when there is none or it has expired. */
async function readProposal(deps: TestEnvDeps, orgId: OrgId, project: string, digest: string): Promise<TestEnvironmentBody | undefined> {
  const item = await read(deps, proposalKey(orgId, project, digest));
  if (item === undefined) return undefined;
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires * 1000 <= deps.now()) return undefined;
  const body = TestEnvironmentBodySchema.safeParse(item.environment);
  if (!body.success || testEnvDigest(body.data) !== digest || item.orgId !== orgId || item.project !== project) throw unavailable();
  return body.data;
}

/**
 * Stores the worker's Prove report for a proposal. A report is accepted only for a proposal that exists (so a worker cannot invent a digest), and the latest report for a digest replaces the earlier one.
 * Whether it passed is read again at approval (`testEnvIsProved`), never trusted from here.
 */
export async function recordTestEnvProveReport(deps: TestEnvDeps, input: { orgId: OrgId; project: string; report: unknown }): Promise<{ proved: boolean }> {
  const report = TestEnvProveReportSchema.safeParse(input.report);
  if (!report.success) throw invalid("the Prove report could not be read");
  const digest = report.data.proposalDigest;
  const now = deps.now();
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { ConditionCheck: { TableName: deps.tableName, Key: proposalKey(input.orgId, input.project, digest), ConditionExpression: "attribute_exists(pk)" } },
        { Put: { TableName: deps.tableName, Item: { ...proveKey(input.orgId, input.project, digest), entityType: "TEST_ENV_PROVE", orgId: input.orgId, project: input.project, digest, report: report.data, recordedAt: new Date(now).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + TEST_ENV_PROPOSAL_TTL_MS) / 1000) } } },
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") throw stale("there is no such proposal to prove; propose the environment again");
    throw error;
  }
  return { proved: testEnvIsProved(report.data, digest) };
}

/** The newest approved environment, or the one at `revision`. Undefined when the project has none. A stored item that does not read back as what was approved throws: a damaged approval is never read as "none". */
export async function readApprovedTestEnvironment(deps: TestEnvDeps, orgId: OrgId, project: string, revision?: number): Promise<TestEnvironment | undefined> {
  let wanted = revision;
  if (wanted === undefined) {
    const pointer = await read(deps, latestKey(orgId, project));
    if (pointer === undefined) return undefined;
    if (typeof pointer.revision !== "number" || !Number.isSafeInteger(pointer.revision) || pointer.revision < 1) throw unavailable();
    wanted = pointer.revision;
  }
  const item = await read(deps, revisionKey(orgId, project, wanted));
  if (item === undefined) {
    if (revision === undefined) throw unavailable();
    return undefined;
  }
  const parsed = TestEnvironmentSchema.safeParse({ revision: item.revision, approvedAt: item.approvedAt, environment: item.environment });
  if (!parsed.success || parsed.data.revision !== wanted || item.orgId !== orgId || item.project !== project || item.digest !== testEnvDigest(parsed.data.environment)) throw unavailable();
  return parsed.data;
}

export interface LessSafeApproval {
  /** The second person, as the confirmation page authenticated them. Their role and whether a sole-owner exception applies are read from the company's records, not from here. */
  approverId: string;
  /** When they last signed in (ms). Older than `TEST_ENV_FRESH_SIGN_IN_MS` is refused. */
  signedInAtMs: number;
  /** The sha256 of their confirmation session's key, recorded in the audit event as the proof. */
  sessionRef: string;
}

export interface ApprovedTestEnvironment { revision: number; digest: string; lessSafe: TestEnvChangeFlag[]; replayed: boolean }

/**
 * Approves a proposed, proved environment as the project's next revision. The only inputs from the client are the digest, the revision it looked at and a request id: the body comes from the stored
 * proposal and the report from the stored Prove run. Replaying the same request returns the same result. Commits the revision, the pointer and the audit item in one transaction, and only while the
 * project is active.
 */
export async function approveTestEnvironment(
  deps: TestEnvDeps,
  input: { orgId: OrgId; project: string; digest: string; expectedRevision: number; requestId: string; approvedBy: string; role: ProjectRole | undefined; approval?: LessSafeApproval; approvedBySignedInAtMs?: number },
): Promise<ApprovedTestEnvironment> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can approve a test environment");
  if (!DIGEST.test(input.digest) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.requestId.length < 8 || input.requestId.length > 100) throw invalid("the approval is not well formed");
  const current = await readApprovedTestEnvironment(deps, input.orgId, input.project);
  const currentDigest = current === undefined ? undefined : testEnvDigest(current.environment);
  // A replay: the newest revision is this digest, approved under this request id.
  if (current !== undefined && currentDigest === input.digest) {
    const stored = await read(deps, revisionKey(input.orgId, input.project, current.revision));
    if (stored?.requestId === input.requestId) return { revision: current.revision, digest: input.digest, lessSafe: Array.isArray(stored.lessSafe) ? stored.lessSafe as TestEnvChangeFlag[] : [], replayed: true };
  }
  const body = await readProposal(deps, input.orgId, input.project, input.digest);
  if (body === undefined) throw stale("this proposal is gone or has expired; propose the environment again");
  const proveItem = await read(deps, proveKey(input.orgId, input.project, input.digest));
  const prove = proveItem === undefined ? undefined : TestEnvProveReportSchema.safeParse(proveItem.report);
  if (!testEnvIsProved(prove?.success === true ? prove.data : undefined, input.digest)) throw invalid("prove this environment (boot, smoke test and a full run) before approving it");
  refuseProduction(body, current?.environment);
  if ((current?.revision ?? 0) !== input.expectedRevision) throw stale("someone changed the test environment; reload and review again");

  const lessSafe = changeFlags(current?.environment, body);
  const now = deps.now();
  const fresh = (at: number | undefined): boolean => at !== undefined && Number.isFinite(at) && at <= now && now - at <= TEST_ENV_FRESH_SIGN_IN_MS;
  // A high-risk card (anything less safe, or a tier above the sandbox) needs the person pressing approve to have signed in just now too.
  if ((lessSafe.length > 0 || testEnvApprovalRisk(body) === "high") && !fresh(input.approvedBySignedInAtMs)) throw agentXError("REAUTH_REQUIRED", "sign in again to approve this change");
  let second: { check: SecondPersonCheck; approverId: string; signedInAtMs: number; sessionRef: string } | undefined;
  if (lessSafe.length > 0) {
    const approval = input.approval;
    const needSecond = () => agentXError("FORBIDDEN", "this change needs a second person to approve it on the confirmation page");
    if (approval === undefined || deps.secondPerson === undefined || !/^[0-9a-f]{64}$/u.test(approval.sessionRef)) throw needSecond();
    if (!fresh(approval.signedInAtMs)) throw agentXError("REAUTH_REQUIRED", "sign in again to approve this change");
    // Both people's live authority and the sole-owner exception come from the company's records. The same person is accepted only when the records say the company has exactly one eligible owner.
    let check: SecondPersonCheck;
    try {
      check = await deps.secondPerson({ orgId: input.orgId, project: input.project, proposerId: input.approvedBy, approverId: approval.approverId });
    } catch {
      throw needSecond();
    }
    const samePerson = approval.approverId === input.approvedBy;
    if (check.mode === "second_person" ? samePerson : !samePerson) throw needSecond();
    second = { check, approverId: approval.approverId, signedInAtMs: approval.signedInAtMs, sessionRef: approval.sessionRef };
  }

  const revision = (current?.revision ?? 0) + 1;
  const approvedAt = new Date(now).toISOString();
  const event = await tryAuditEvent(deps, () => auditProjectTestEnvChanged({
    orgId: input.orgId, actor: { kind: "member", id: input.approvedBy }, occurredAt: approvedAt, occurrence: input.requestId, projectName: input.project, revision, tier: body.tier, lessSafeCount: lessSafe.length,
    // Who the second person was and how they proved it: related ids and the fresh sign-in proof (their session, hashed).
    ...(second === undefined ? {} : { related: [second.approverId], proof: { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date(second.signedInAtMs).toISOString(), sessionRef: second.sessionRef } }),
  }));
  const items: TransactItem[] = [
    // The project is active. (With a second person, the evidence's own snapshot of the project record, status included, does this: two actions on one item cannot share a transaction.)
    ...(second === undefined ? [{ ConditionCheck: { TableName: deps.tableName, Key: projectMetaKey(input.orgId, input.project), ConditionExpression: "attribute_exists(pk) AND #status = :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "active" } } }] : []),
    {
      Put: {
        TableName: deps.tableName,
        Item: {
          ...revisionKey(input.orgId, input.project, revision), entityType: "TEST_ENV_REVISION", orgId: input.orgId, project: input.project, revision, approvedAt, approvedBy: input.approvedBy,
          digest: input.digest, requestId: input.requestId, lessSafe, environment: body,
          ...(second === undefined ? {} : { secondApprover: { id: second.approverId, mode: second.check.mode, signedInAt: new Date(second.signedInAtMs).toISOString(), membershipVersion: second.check.membershipVersion } }),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    current === undefined
      ? { Put: { TableName: deps.tableName, Item: { ...latestKey(input.orgId, input.project), entityType: "TEST_ENV_LATEST", orgId: input.orgId, project: input.project, revision, digest: input.digest }, ConditionExpression: "attribute_not_exists(pk)" } }
      : { Update: { TableName: deps.tableName, Key: latestKey(input.orgId, input.project), UpdateExpression: "SET #revision = :next, #digest = :digest", ConditionExpression: "#revision = :current", ExpressionAttributeNames: { "#revision": "revision", "#digest": "digest" }, ExpressionAttributeValues: { ":next": revision, ":current": current.revision, ":digest": input.digest } } },
    // Both people's live authority, pinned to the moment of commit.
    ...(second === undefined ? [] : second.check.conditions),
    ...(event === undefined ? [] : auditPending(deps, event)),
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") throw stale("someone changed the test environment, or the project is archived; reload and review again");
    throw error;
  }
  if (event !== undefined) await flushAuditEvents(deps, [event]);
  return { revision, digest: input.digest, lessSafe, replayed: false };
}

/** A short stable id for a request that has none of its own (a card's approve button): the digest, the revision it looked at and who pressed it. */
export function testEnvRequestId(digest: string, expectedRevision: number, approvedBy: string): string {
  return createHash("sha256").update(auditOccurrence(digest, String(expectedRevision), approvedBy)).digest("hex").slice(0, 32);
}
