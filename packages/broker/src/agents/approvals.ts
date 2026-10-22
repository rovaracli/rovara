// Plan 3 Task 7 (PF18, PF19): the approvals core. A change that needs a person's confirmation (a less-safe publish, rollback or
// adoption, a company-wide share; later the guardrail relaxations, connector widenings and opt-outs) is stored as one APPROVAL#
// record with `kind: "change"`, listed through the global OPEN_APPROVALS index and one APPROVER# item per person who may be asked.
// Nothing is applied when the record is made. Deciding it is Task 21's `decideApproval` and Task 21a's confirmation page: they check
// the registered rule against the caller now (R68), then call the registered handler for the subject, which applies exactly what the
// record stores or throws the reason it can no longer be applied (the record then ends `APPROVED_FAILED` with that reason).
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentGuardrailsSchema,
  AgentIdSchema,
  AgentPrincipalSchema,
  ApprovalIdSchema,
  ConnectorConfigSchema,
  APPROVAL_EXECUTING_RETRY_MINUTES,
  AgentXError,
  CHANGE_APPROVAL_TTL_DAYS,
  OrgIdSchema,
  agentXError,
  approvalKey,
  approverIndexKey,
  canonicalInstant,
  canonicalJson,
  capText,
  newPrefixedId,
  openApprovalKey,
  orgScoped,
  projectAllows,
  redactText,
  type AgentGuardrails,
  type AgentId,
  type ApprovalId,
  type AuditProof,
  type ConnectorConfig,
  type OrgId,
} from "@agentx/contracts";
import type { ProjectConnectorDependencies } from "../connections/project-connectors.js";
import { WRITE_APPROVAL_TTL_MS } from "./approval-ttl.js";
import { auditApprovalDecided, auditApprovalExpired, auditWriteExecuted } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf, decisionProofOf } from "../audit/plan3-hooks.js";
import { orgRoleOf, type AgentAccessDeps, type AgentCaller, type AgentShare } from "./access.js";
import type { ServableModels } from "./guardrails.js";
import { checkTime, registerMemberMover, resolveMember, sameMember, type LifecycleDeps } from "./lifecycle.js";
import type { ResolveOptions } from "./store.js";
import type { AgentRepositoryReader } from "../github-app.js";
import type { WriteGateRuntime } from "./write-gate.js";

/** What an agent's routes and the approvals that act on agents need: access checks, the store and where the page lives. */
export interface ApprovalDependencies extends AgentAccessDeps {
  now: () => number;
  /** The cell's origin, where `/v1/app/approve/<id>` is served. */
  confirmOrigin: string;
  /** Looks up an added skill's name and digest (Task 9); without it, a recipe that adds a skill can't be resolved. */
  resolveSkill?: ResolveOptions["resolveSkill"];
  /** The models some source the company can use serves (Task 26); without it, the models Rovara's own AI serves. */
  servableModels?: ServableModels;
  /** What a project's connectors need (Task 13): the org's connections, the project revision write and the live connector status. Without it those routes answer 404 and a widening cannot be applied. */
  projectConnectors?: ProjectConnectorDependencies;
  /** Task 14b: a read-only reader of a repository's default branch for an org, for the comment-triggered workflow scan. Without it, nothing can be reviewed or opted out. */
  repositoryReader?: (input: { orgId: OrgId; repositoryUrl: string; installationId?: number }) => Promise<AgentRepositoryReader>;
  /** Task 14b: the repositories of a project as they are registered now (undefined when there is no such project in the org). */
  projectRepositories?: (orgId: OrgId, project: string) => Promise<ReadonlyArray<{ name: string; url: string; installationId?: number | undefined }> | undefined>;
  /** Task 21: what a write approval needs beyond the table (the connector call path, the agent's grant and the run owner's authority). Task 19 supplies it; without it a write approval can't be made or decided. */
  writeGate?: WriteGateRuntime;
}

/** The part of the dependencies the record's own writes need. */
export type ApprovalStoreDependencies = Pick<ApprovalDependencies, "documentClient" | "tableName" | "now">;

/** Who must decide: the people named, or a rule evaluated when the decision is made (R64, R68), whose `candidates` only see it listed. */
export type ApproverSpec =
  | { kind: "ids"; ids: readonly string[] }
  | { kind: "rule"; rule: string; candidates: readonly string[] };

/** `APPROVED` ends a step approval (a person said yes; the subject's handler goes on from there); a change or a write ends `APPROVED_DONE` or `APPROVED_FAILED`. */
export type ApprovalStatus = "PENDING" | "EXECUTING" | "APPROVED" | "APPROVED_DONE" | "APPROVED_FAILED" | "DECLINED" | "EXPIRED";
const APPROVAL_STATUSES = ["PENDING", "EXECUTING", "APPROVED", "APPROVED_DONE", "APPROVED_FAILED", "DECLINED", "EXPIRED"] as const;

/** What a change record applies when it is confirmed. Each is bound to the exact version, revision or digest that was shown. */
export type AgentChangeSubject =
  /** Publish `agentId`'s draft: only while the draft is still `draftRevision` with `digest`, and the current version is still `expectedCurrentVersion`. */
  | { kind: "agent_publish"; agentId: AgentId; draftRevision: number; digest: string; expectedCurrentVersion?: number; note?: string }
  /** Make `version` (whose recipe has `digest`) current, while the current version is still `expectedCurrentVersion`. */
  | { kind: "agent_rollback"; agentId: AgentId; version: number; digest: string; expectedCurrentVersion: number }
  /** Move the org's pin of a built-in to `version`, while it is still `expectedPinnedVersion`. */
  | { kind: "builtin_adopt"; agentId: AgentId; version: number; digest: string; expectedPinnedVersion: number }
  /** Make `shares` the agent's share set (it includes a company-wide share), while it is still at `expectedSharesRevision`. */
  | { kind: "agent_share"; agentId: AgentId; shares: AgentShare[]; expectedSharesRevision: number }
  /** Make `next` the company's agent guardrails, while they are still at `expectedRevision`. */
  | { kind: "guardrails"; next: AgentGuardrails; expectedRevision: number };

/**
 * Make `connector` the connector called `name` on `project`: a tool newly approved as `write` (Task 13). It applies only while the project is still
 * at `expectedRevision`, and writes exactly the connector stored here.
 */
export interface ConnectorWidenSubject { kind: "connector_widen"; project: string; name: string; expectedRevision: number; connector: ConnectorConfig }

/**
 * Task 14b: lets agents comment, review and label in a repository whose workflows act on comments, on one project, while the workflows still have
 * the digest that was reviewed. `files` is what the admin saw.
 */
export interface OptOutChangeSubject { kind: "opt_out"; project: string; repository: string; expectedDigest: string; files: string[]; reason: string }

/** The kinds of change that are not about an agent itself: connector widenings (Task 13) and comment-trigger opt-outs (Task 14b). */
export type OtherChangeSubject = ConnectorWidenSubject | OptOutChangeSubject;
export type ChangeSubject = AgentChangeSubject | ConnectorWidenSubject | OptOutChangeSubject;

export interface ChangeApprovalRecord extends DecidedFields {
  orgId: OrgId;
  approvalId: ApprovalId;
  kind: "change";
  subject: ChangeSubject;
  /** What the change does, in words, as the page lists it. */
  changes: string[];
  approvers: ApproverSpec;
  status: ApprovalStatus;
  /** The developer who asked. */
  requestedBy: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Why a confirmed change could not be applied (status `APPROVED_FAILED`). */
  failure?: string;
  createdAt: string;
  expiresAt: string;
}

/** The change records Plan 3's earlier tasks make; the step and write records below are Task 21's. Handlers that apply a change take this one. */
export type ApprovalRecord = ChangeApprovalRecord;

/** What an approval is about when it is a step of a run (`agent_run`) or of a chain (`chain_gate`, Plan 4); a test may register any other kind. */
export type ApprovalSubject = { kind: "agent_run"; taskId: string; stepId: string } | { kind: "chain_gate"; chainRunId: string; seq: number };

/** The person a run belongs to and the project it runs in: what the `write_approver` rule decides on. */
export interface ApprovalRun { project: string; owner: { developerId: string; name: string } }

/** Fields every record that is decided carries once it is. */
interface DecidedFields {
  decidedBy?: string;
  decidedAt?: string;
  /** The decision, kept so a retry after a crash finishes the same one. */
  decision?: "APPROVE" | "DECLINE";
  /** The request id of the decision: a repeat by the same person answers the stored outcome. */
  decisionRequestId?: string;
  /** How the decision was made (the decide session's proof), for the audit event of a retry. */
  decisionProof?: AuditProof;
  /** When the work after the decision (applying it, running the call) was last started, and how many times. */
  executingAt?: string;
  attempts?: number;
  /** Why it ended `APPROVED_FAILED`. */
  failure?: string;
  /** Whether the subject's handler has heard the outcome, who has the right to tell it now, and when the sweep looks again. */
  handlerDone?: boolean;
  handlerClaimedAt?: string;
  handlerDueAt?: string;
}

/** A step of a run that waits for a person (an `approval` step, or a chain gate). */
export interface StepApprovalRecord extends DecidedFields {
  orgId: OrgId;
  approvalId: ApprovalId;
  kind: "step";
  subject: ApprovalSubject;
  prompt: string;
  approvers: ApproverSpec;
  status: ApprovalStatus;
  /** The project and the run's owner, when the creator knew them: `write_approver` reads them (else from the task). */
  project?: string;
  owner?: { developerId: string; name: string };
  createdAt: string;
  expiresAt: string;
}

/** A consequential or merge call of an agent that waits for a person, holding exactly what will be sent (Task 21). */
export interface WriteApprovalRecord extends DecidedFields, ApprovalRun {
  orgId: OrgId;
  approvalId: ApprovalId;
  kind: "write";
  subject: { kind: "agent_run"; taskId: string; stepId: string };
  operationId: string;
  /** The project's name for the connector, its type, the tool's upstream name and what the project approved it for. */
  connector: string;
  connectorType: string;
  tool: string;
  toolAccess: "read" | "write";
  scope: string;
  schemaHash: string;
  /** The project revision it was asked under (for display; every check reads the current one). */
  projectRevision: number;
  credentialRef?: string;
  /** A digest of the connector's scope as it was stored when asked: a scope that changed since is not the one a person approved. */
  scopeDigest: string;
  /** The prepared arguments (Task 20b), exactly what will be sent. */
  arguments: Record<string, unknown>;
  argumentsHash: string;
  summary: string;
  class: "consequential" | "merge";
  approvers: ApproverSpec;
  status: ApprovalStatus;
  result?: { status: string; text: string; truncated: boolean; replayed: boolean };
  createdAt: string;
  expiresAt: string;
}

export type AnyApprovalRecord = ChangeApprovalRecord | StepApprovalRecord | WriteApprovalRecord;

export type ApprovalCaller = AgentCaller;

// Method syntax makes the parameter types bivariant, so a rule or handler written for the change record alone is still accepted.
/** Whether `caller` may decide `record` now. Evaluated live each time, so a person demoted since it was asked can't decide it. */
export type ApproverRuleCheck = { check(deps: ApprovalDependencies, record: AnyApprovalRecord, caller: ApprovalCaller): Promise<boolean> }["check"];
/**
 * Applies a confirmed record exactly as stored, or throws why it can't. `decidedBy` is set on the record when it runs. `decision.proof` is how the
 * decision was made (the decide session's, Task 21a): a handler whose own audit event should carry it reads it here. A step or write approval's
 * handler (`agent_run`, `chain_gate`) runs after the outcome is stored, whatever it was (`record.status`), and must be safe to run again.
 */
export type ApprovalSubjectHandler = { handle(deps: ApprovalDependencies, record: AnyApprovalRecord, decision?: { proof?: AuditProof }): Promise<void> }["handle"];

const rules = new Map<string, ApproverRuleCheck>();
const handlers = new Map<string, ApprovalSubjectHandler>();

/** Registers (or replaces) the rule a record's `approvers` can name. */
export function registerApproverRule(rule: string, eligible: ApproverRuleCheck): void {
  rules.set(rule, eligible);
}

/** Registers (or replaces) what confirming a record of this subject kind does. */
export function registerApprovalSubjectHandler(kind: ChangeSubject["kind"] | ApprovalSubject["kind"], handler: ApprovalSubjectHandler): void {
  handlers.set(kind, handler);
}

export const getApproverRule = (rule: string): ApproverRuleCheck | undefined => rules.get(rule);
export const getApprovalSubjectHandler = (kind: string): ApprovalSubjectHandler | undefined => handlers.get(kind);

/** The confirmation page for an approval: where a person decides it. */
export const confirmUrlFor = (deps: Pick<ApprovalDependencies, "confirmOrigin">, record: { approvalId: ApprovalId }): string => `${deps.confirmOrigin}/v1/app/approve/${record.approvalId}`;

/** A transaction holds 100 items: the record, its open index item and at most this many approver items. */
const MAX_LISTED_APPROVERS = 90;
const DAY_MS = 86_400_000;

type Item = Record<string, unknown>;

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const ApproverSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ids"), ids: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("rule"), rule: z.string(), candidates: z.array(z.string()) }).strict(),
]);
const ChangeSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent_publish"), agentId: AgentIdSchema, draftRevision: z.number().int(), digest: Hex64, expectedCurrentVersion: z.number().int().optional(), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal("agent_rollback"), agentId: AgentIdSchema, version: z.number().int(), digest: Hex64, expectedCurrentVersion: z.number().int() }).strict(),
  z.object({ kind: z.literal("builtin_adopt"), agentId: AgentIdSchema, version: z.number().int(), digest: Hex64, expectedPinnedVersion: z.number().int() }).strict(),
  z.object({
    kind: z.literal("agent_share"), agentId: AgentIdSchema, expectedSharesRevision: z.number().int(),
    shares: z.array(z.object({ principal: AgentPrincipalSchema, level: z.enum(["view", "use", "edit"]) }).strict()),
  }).strict(),
  z.object({ kind: z.literal("guardrails"), next: AgentGuardrailsSchema, expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("connector_widen"), project: z.string(), name: z.string(), expectedRevision: z.number().int().min(1), connector: ConnectorConfigSchema }).strict(),
  z.object({
    kind: z.literal("opt_out"), project: z.string(), repository: z.string(), expectedDigest: Hex64, files: z.array(z.string()), reason: z.string(),
  }).strict(),
]);
const StatusSchema = z.enum(APPROVAL_STATUSES);
const DecidedShape = {
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  decision: z.enum(["APPROVE", "DECLINE"]).optional(),
  decisionRequestId: z.string().optional(),
  decisionProof: z.unknown().optional(),
  executingAt: z.string().optional(),
  attempts: z.number().int().min(0).optional(),
  failure: z.string().optional(),
  handlerDone: z.boolean().optional(),
  handlerClaimedAt: z.string().optional(),
  handlerDueAt: z.string().optional(),
};
const RunOwnerSchema = z.object({ developerId: z.string(), name: z.string() }).strict();
/** What a stored change record must look like to be read; `passthrough`, so a field a later task adds is kept. */
const ChangeApprovalRecordSchema = z.object({
  orgId: OrgIdSchema,
  approvalId: ApprovalIdSchema,
  kind: z.literal("change"),
  subject: ChangeSubjectSchema,
  changes: z.array(z.string()),
  approvers: ApproverSpecSchema,
  status: StatusSchema,
  requestedBy: z.string(),
  ...DecidedShape,
  createdAt: z.string(),
  expiresAt: z.string(),
}).passthrough();
const StepApprovalRecordSchema = z.object({
  orgId: OrgIdSchema,
  approvalId: ApprovalIdSchema,
  kind: z.literal("step"),
  subject: z.object({ kind: z.string() }).passthrough(),
  prompt: z.string(),
  approvers: ApproverSpecSchema,
  status: StatusSchema,
  project: z.string().optional(),
  owner: RunOwnerSchema.optional(),
  ...DecidedShape,
  createdAt: z.string(),
  expiresAt: z.string(),
}).passthrough();
const WriteApprovalRecordSchema = z.object({
  orgId: OrgIdSchema,
  approvalId: ApprovalIdSchema,
  kind: z.literal("write"),
  subject: z.object({ kind: z.literal("agent_run"), taskId: z.string(), stepId: z.string() }).strict(),
  operationId: z.string(),
  connector: z.string(),
  connectorType: z.string(),
  tool: z.string(),
  toolAccess: z.enum(["read", "write"]),
  scope: z.string(),
  schemaHash: Hex64,
  projectRevision: z.number().int(),
  credentialRef: z.string().optional(),
  scopeDigest: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  argumentsHash: Hex64,
  summary: z.string(),
  class: z.enum(["consequential", "merge"]),
  approvers: ApproverSpecSchema,
  status: StatusSchema,
  project: z.string(),
  owner: RunOwnerSchema,
  result: z.object({ status: z.string(), text: z.string(), truncated: z.boolean(), replayed: z.boolean() }).optional(),
  ...DecidedShape,
  createdAt: z.string(),
  expiresAt: z.string(),
}).passthrough();

/** The record of any kind, or undefined when there is none in this org or what is stored is not a record (reported, never handed on). */
export async function getAnyApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, approvalId: ApprovalId): Promise<AnyApprovalRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(orgId, approvalId), ConsistentRead: true })) as { Item?: Item };
  const item = response.Item;
  // Records are looked up by an id the caller names; one that belongs to another org reads as missing.
  if (item === undefined || item["orgId"] !== orgId) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...record } = item;
  const schema = record["kind"] === "write" ? WriteApprovalRecordSchema : record["kind"] === "step" ? StepApprovalRecordSchema : ChangeApprovalRecordSchema;
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    console.error(JSON.stringify({ component: "broker", level: "error", event: "approval_record_invalid", orgId, approvalId, problem: parsed.error.issues[0]?.path.join(".") ?? "record" }));
    return undefined;
  }
  return parsed.data as unknown as AnyApprovalRecord;
}

/** The change record, or undefined when there is none in this org, what is stored is not a record, or it is a step or a write (those are read with `getAnyApproval`). */
export async function getApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, approvalId: ApprovalId): Promise<ApprovalRecord | undefined> {
  const record = await getAnyApproval(deps, orgId, approvalId);
  return record?.kind === "change" ? record : undefined;
}

const listedPeople = (approvers: ApproverSpec): string[] => [...new Set(approvers.kind === "ids" ? approvers.ids : approvers.candidates)].sort().slice(0, MAX_LISTED_APPROVERS);

/** The change a person's request made (a pending record), or undefined when that request made none: how a route tells a repeat from a new request. */
export function pendingChangeFor(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, requestedBy: string, requestId: string): Promise<ApprovalRecord | undefined> {
  return getApproval(deps, orgId, approvalIdFor(orgId, requestedBy, requestId));
}

/** The same request always names the same approval, so a replay finds the record it made (R18). */
function approvalIdFor(orgId: OrgId, requestedBy: string, requestId: string): ApprovalId {
  return newPrefixedId("apr", () => createHash("sha256").update(`${orgId}|${requestedBy}|${requestId}`, "utf8").digest());
}

/**
 * Records a change that waits for a person and applies nothing. The id comes from the request, so a replay of the same request
 * returns the record it made (another change under that request id is `CONFIG_INVALID`, as on the routes that apply at once). A rule or subject kind nobody
 * registered is refused here (`CONFIG_INVALID`), so no record is made that no one could ever decide.
 */
export async function createPendingChange(
  deps: ApprovalStoreDependencies,
  input: { orgId: OrgId; requestId: string; requestedBy: string; subject: ChangeSubject; changes: string[]; approvers: ApproverSpec; expiresAt?: string },
): Promise<ApprovalRecord> {
  if (input.approvers.kind === "rule" && getApproverRule(input.approvers.rule) === undefined) {
    throw agentXError("CONFIG_INVALID", `no one can decide this: the rule "${input.approvers.rule}" is not registered`);
  }
  if (getApprovalSubjectHandler(input.subject.kind) === undefined) {
    throw agentXError("CONFIG_INVALID", `no one can decide this: nothing is registered to apply a "${input.subject.kind}" change`);
  }
  const approvalId = approvalIdFor(input.orgId, input.requestedBy, input.requestId);
  const replay = async (): Promise<ApprovalRecord | undefined> => {
    const existing = await getApproval(deps, input.orgId, approvalId);
    if (existing === undefined) return undefined;
    if (canonicalJson(existing.subject) !== canonicalJson(input.subject)) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    return existing;
  };
  const before = await replay();
  if (before !== undefined) return before;

  const createdAt = new Date(deps.now()).toISOString();
  const expiresAt = input.expiresAt ?? new Date(deps.now() + CHANGE_APPROVAL_TTL_DAYS * DAY_MS).toISOString();
  const record: ApprovalRecord = {
    orgId: input.orgId, approvalId, kind: "change", subject: input.subject, changes: input.changes, approvers: input.approvers,
    status: "PENDING", requestedBy: input.requestedBy, createdAt, expiresAt,
  };
  const put = (key: { pk: string; sk: string }, entityType: string, fields: Item) => ({
    Put: { TableName: deps.tableName, Item: { ...key, entityType, ...fields }, ConditionExpression: "attribute_not_exists(pk)" },
  });
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        put(approvalKey(input.orgId, approvalId), "APPROVAL", record as unknown as Item),
        put(openApprovalKey(expiresAt, input.orgId, approvalId), "OPEN_APPROVAL", { orgId: input.orgId, approvalId }),
        ...listedPeople(input.approvers).map((developerId) => put(approverIndexKey(input.orgId, developerId, approvalId), "APPROVER_INDEX", { approvalId, expiresAt })),
      ],
    }));
  } catch (error) {
    // Two copies of one request racing: the one that lost returns what the winner wrote.
    const raced = error instanceof Error && error.name === "TransactionCanceledException" ? await replay() : undefined;
    if (raced === undefined) throw error;
    return raced;
  }
  return record;
}

// ---------------------------------------------------------------------------------------------
// Task 21: step and write approvals, deciding, the sweep, and the member movers
// ---------------------------------------------------------------------------------------------
//
// One state machine for every kind. A decision claims the record with ONE conditional transaction (`PENDING` to its next state, the audit item, the
// open-index items and the step's counter in it). What comes after the claim is repeatable and found again by the sweep:
//   - a change or a write that is approved goes `EXECUTING` (applying it, or running the call, is the work), then ends `APPROVED_DONE` or
//     `APPROVED_FAILED`; a crash leaves it `EXECUTING` with `executingAt`, and the sweep drives it again after APPROVAL_EXECUTING_RETRY_MINUTES;
//   - a step that is approved ends `APPROVED`, a decline ends `DECLINED`, an expiry ends `EXPIRED`; for a step or a write the subject's handler then
//     hears the outcome (`handlerDone` says whether it did), and a handler that did not hear is called again by the sweep.
// Every follow-up has a due item in the OPEN_APPROVALS index (`<due time>#<org>#<id>`), written in the transaction that makes it owed.

type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

const RETRY_MS = APPROVAL_EXECUTING_RETRY_MINUTES * 60_000;
/** A run of a write approval is driven at most this many times; after that it ends `APPROVED_FAILED`. */
export const MAX_APPROVAL_ATTEMPTS = 5;
const PAGE_LIMIT = 100;
const iso = (ms: number): string => new Date(ms).toISOString();
const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const DUE_SK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(org_[0-9a-z]{20})#(apr_[0-9a-z]{20})$/;

const stepCounterKey = (orgId: OrgId, taskId: string, stepId: string) => ({ pk: orgScoped(orgId, `STEP_APPROVALS#${taskId}`), sk: stepId });
/** The task event a write approval leaves (Task 22's task view reads `DEVTASK#<task>` items whose sort key starts `EVENT#`; a task partition is global, so a reader re-checks `orgId`). */
export const approvalTaskEventKey = (taskId: string, at: string, approvalId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `EVENT#${at}#${approvalId}` });

const log = (deps: Pick<ApprovalDependencies, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);

const stripCode = (error: { message: string; code?: string }): string => (error.code !== undefined && error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);

/** Words an agent or a vendor supplied, made safe to show: no control or format characters, secrets redacted, cut to `max`. */
export function shownText(text: string, max: number): string {
  const cleaned = redactText(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return capText(cleaned, max).text;
}

const DecideBodySchema = z.object({ requestId: z.string().uuid(), decision: z.enum(["APPROVE", "DECLINE"]) }).strict();
export type DecideBody = z.infer<typeof DecideBodySchema>;

function parseDecideBody(body: unknown): DecideBody {
  const parsed = DecideBodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

const hasHandlerPhase = (record: AnyApprovalRecord): boolean => record.kind !== "change";

// ---- who and what a record is about

export interface ApprovalRunView { project: string; owner: { developerId: string; name: string } }

/**
 * The project and the person a write or step approval is about. A step the creator didn't annotate takes them from its task. Undefined when they
 * can't be told (a change record, a chain gate without them): a rule that needs them then refuses.
 */
export async function runOfApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, record: AnyApprovalRecord): Promise<ApprovalRunView | undefined> {
  if (record.kind === "write") return { project: record.project, owner: record.owner };
  if (record.kind !== "step") return undefined;
  if (record.project !== undefined && record.owner !== undefined) return { project: record.project, owner: record.owner };
  if (record.subject.kind !== "agent_run") return undefined;
  const taskId = (record.subject as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string") return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: { orgId?: unknown; project?: unknown; developerId?: unknown; developerName?: unknown } };
  const task = response.Item;
  if (task?.orgId !== record.orgId || typeof task.project !== "string" || typeof task.developerId !== "string") return undefined;
  return { project: record.project ?? task.project, owner: record.owner ?? { developerId: task.developerId, name: typeof task.developerName === "string" ? task.developerName : "the task owner" } };
}

/** What the person who can't decide is told. */
function forbiddenText(record: AnyApprovalRecord): string {
  return record.kind === "write" ? `Only ${record.owner.name} or a project maintainer can decide this.` : "You can't decide this.";
}

/** Whether `caller` may decide `record` now: the registered rule says yes, or they are listed and still hold `start_tasks` on the project. Everything is read live. */
export async function mayDecideApproval(deps: ApprovalDependencies, caller: ApprovalCaller, record: AnyApprovalRecord): Promise<boolean> {
  const spec = record.approvers;
  if (spec.kind === "rule") {
    const rule = getApproverRule(spec.rule);
    return rule !== undefined && await rule(deps, record, caller);
  }
  let listed = false;
  for (const id of spec.ids) {
    if (await sameMember(deps, record.orgId, id, caller.developerId)) { listed = true; break; }
  }
  if (!listed) return false;
  const run = await runOfApproval(deps, record);
  if (run === undefined) return true;
  const orgRole = await orgRoleOf(deps, record.orgId, caller.developerId);
  if (orgRole === undefined) return false;
  const role = await deps.projectMembers.roleOf(record.orgId, run.project, { developerId: await resolveMember(deps, record.orgId, caller.developerId), orgRole });
  return role !== undefined && projectAllows(role, "start_tasks");
}

// ---- creating step and write records

/** The id a seed always makes: the same seed in the same org is the same approval, so a repeat finds the record it made. */
export function approvalIdFromSeed(orgId: OrgId, seed: string): ApprovalId {
  return newPrefixedId("apr", () => createHash("sha256").update(`${orgId}|${seed}`, "utf8").digest());
}

type NewRecord = StepApprovalRecord | WriteApprovalRecord;

/** Refuses (`CONFIG_INVALID`) approvers that name a rule nobody registered: no record is made that no one could decide. */
export function requireRegisteredApprovers(approvers: ApproverSpec): void {
  if (approvers.kind === "rule" && getApproverRule(approvers.rule) === undefined) {
    throw agentXError("CONFIG_INVALID", `no one can decide this: the rule "${approvers.rule}" is not registered`);
  }
}

/**
 * Writes a new record with its open index item, its approver items, the step's counter (a write approval only: refused when `max` are already pending)
 * and `extraItems`, in ONE transaction. Answers `exists` when the id is taken (the caller reads it) and `full` when the step has no room.
 */
async function createRecord(
  deps: ApprovalStoreDependencies,
  input: { record: NewRecord; counter?: { taskId: string; stepId: string; max: number }; extraItems?: TransactItem[] },
): Promise<"created" | "exists" | "full"> {
  const { record } = input;
  const items: TransactItem[] = [];
  if (input.counter !== undefined) {
    items.push({
      Update: {
        TableName: deps.tableName, Key: stepCounterKey(record.orgId, input.counter.taskId, input.counter.stepId),
        UpdateExpression: "ADD #pending :one", ConditionExpression: "attribute_not_exists(#pending) OR #pending < :max",
        ExpressionAttributeNames: { "#pending": "pending" }, ExpressionAttributeValues: { ":one": 1, ":max": input.counter.max },
      },
    });
  }
  const offset = items.length;
  items.push(
    { Put: { TableName: deps.tableName, Item: { ...approvalKey(record.orgId, record.approvalId), entityType: "APPROVAL", ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...openApprovalKey(record.expiresAt, record.orgId, record.approvalId), entityType: "OPEN_APPROVAL", orgId: record.orgId, approvalId: record.approvalId } } },
    ...listedPeople(record.approvers).map((developerId): TransactItem => ({
      Put: { TableName: deps.tableName, Item: { ...approverIndexKey(record.orgId, developerId, record.approvalId), entityType: "APPROVER_INDEX", approvalId: record.approvalId, expiresAt: record.expiresAt } },
    })),
    ...(input.extraItems ?? []),
  );
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return "created";
  } catch (error) {
    if (errorNameOf(error) !== "TransactionCanceledException") throw error;
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
    if (reasons?.[offset]?.Code === "ConditionalCheckFailed") return "exists";
    if (offset === 1 && reasons?.[0]?.Code === "ConditionalCheckFailed") return "full";
    throw error;
  }
}

/** Creates a write approval's record (Task 21's `decideWrite` calls this); see `createRecord`. */
export async function createWriteApprovalRecord(
  deps: ApprovalStoreDependencies,
  record: WriteApprovalRecord,
  extraItems: TransactItem[],
  max: number,
): Promise<"created" | "exists" | "full"> {
  return createRecord(deps, { record, counter: { taskId: record.subject.taskId, stepId: record.subject.stepId, max }, extraItems });
}

/**
 * Records a step of a run that waits for a person (an `approval` step of an agent, or a chain gate), PENDING and listed for its candidates. The id comes
 * from the subject, so asking again for the same step returns the record already made. A rule or subject kind nobody registered is refused
 * (`CONFIG_INVALID`), so no record is made that no one could decide. `expiresAt` defaults to the write approval TTL from now.
 */
export async function createStepApproval(
  deps: ApprovalStoreDependencies,
  input: { orgId: OrgId; subject: ApprovalSubject; prompt: string; approvers: ApproverSpec; expiresAt?: string; project?: string; owner?: { developerId: string; name: string } },
): Promise<StepApprovalRecord> {
  if (input.prompt.length < 1 || input.prompt.length > 300 || /[\p{Cc}\p{Cf}]/u.test(input.prompt)) throw agentXError("CONFIG_INVALID", "prompt: must be 1 to 300 characters of plain text");
  requireRegisteredApprovers(input.approvers);
  if (getApprovalSubjectHandler(input.subject.kind) === undefined) throw agentXError("CONFIG_INVALID", `no one can decide this: nothing is registered to continue a "${input.subject.kind}" step`);
  let expiresAt: string;
  try {
    expiresAt = input.expiresAt === undefined ? iso(deps.now() + WRITE_APPROVAL_TTL_MS) : iso(Date.parse(canonicalInstant(input.expiresAt)));
  } catch {
    throw agentXError("CONFIG_INVALID", "expiresAt: not a time");
  }
  const approvalId = approvalIdFromSeed(input.orgId, `step|${canonicalJson(input.subject)}`);
  const record: StepApprovalRecord = {
    orgId: input.orgId, approvalId, kind: "step", subject: input.subject, prompt: input.prompt, approvers: input.approvers, status: "PENDING",
    ...(input.project === undefined ? {} : { project: input.project }), ...(input.owner === undefined ? {} : { owner: input.owner }),
    attempts: 0, createdAt: iso(deps.now()), expiresAt,
  };
  const made = await createRecord(deps, { record });
  if (made === "created") return record;
  const existing = await getAnyApproval(deps, input.orgId, approvalId);
  if (existing?.kind !== "step") throw agentXError("CONFIG_INVALID", "this step already has an approval of another kind");
  return existing;
}

// ---- listing

/** Every record of `status` (default PENDING) that lists `caller` as an approver or a candidate, newest first. */
export async function listApprovalsFor(deps: ApprovalDependencies, caller: ApprovalCaller, status: ApprovalStatus = "PENDING"): Promise<AnyApprovalRecord[]> {
  const found: AnyApprovalRecord[] = [];
  let start: Record<string, unknown> | undefined;
  for (let pages = 0; pages < 5; pages += 1) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": approverIndexKey(caller.orgId, caller.developerId, "apr_00000000000000000000").pk },
      ConsistentRead: true, Limit: PAGE_LIMIT, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ approvalId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = ApprovalIdSchema.safeParse(item.approvalId);
      if (!parsed.success) continue;
      const record = await getAnyApproval(deps, caller.orgId, parsed.data);
      if (record?.status === status) found.push(record);
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return found.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

// ---- deciding

/** What driving a record's work came to. `unfinished` leaves it `EXECUTING` for the sweep. */
export type Execution = { outcome: "done"; result?: WriteApprovalRecord["result"] } | { outcome: "failed"; failure: string } | { outcome: "unfinished" };

/** Runs an approved write: the re-checks, then the connector call. Task 21's write-gate registers it when it loads. */
export interface WriteApprovalDriver {
  execute(deps: ApprovalDependencies, record: WriteApprovalRecord): Promise<Execution>;
}
let writeDriver: WriteApprovalDriver | undefined;
export function registerWriteApprovalDriver(driver: WriteApprovalDriver): void {
  writeDriver = driver;
}

type Executor = (deps: ApprovalDependencies, record: AnyApprovalRecord) => Promise<Execution>;

/** How an approved record of this kind is carried out; undefined when it needs a driver that isn't there (a write with none refuses before anything is claimed). */
function executorFor(record: AnyApprovalRecord): Executor | undefined {
  if (record.kind === "write") {
    const driver = writeDriver;
    return driver === undefined ? undefined : (deps, current) => driver.execute(deps, current as WriteApprovalRecord);
  }
  if (record.kind === "step") return async () => ({ outcome: "done" });
  return async (deps, current) => {
    const handler = getApprovalSubjectHandler(current.subject.kind);
    if (handler === undefined) return { outcome: "failed", failure: "Nothing can apply this change any more." };
    await handler(deps, current, current.decisionProof === undefined ? undefined : { proof: current.decisionProof });
    return { outcome: "done" };
  };
}

function unconfirmedMessage(record: AnyApprovalRecord): string {
  return record.kind === "write"
    ? `Rovara couldn't confirm that this ran. Check ${record.connector} before asking again.`
    : "Rovara couldn't confirm that this change was applied. Check it, then ask for it again.";
}

/** Runs the executor; a refusal in AgentX's own words ends the record, anything else (a crash, an outage) leaves it for the sweep. */
async function execute(deps: ApprovalDependencies, executor: Executor, record: AnyApprovalRecord): Promise<Execution> {
  try {
    return await executor(deps, record);
  } catch (error) {
    if (error instanceof AgentXError && error.code !== "RUNTIME_UNAVAILABLE") return { outcome: "failed", failure: shownText(stripCode(error), 400) };
    log(deps, "approval.execution_interrupted", { orgId: record.orgId, approvalId: record.approvalId, kind: record.kind, error: errorNameOf(error) });
    return { outcome: "unfinished" };
  }
}

const dueItem = (deps: Pick<ApprovalStoreDependencies, "tableName">, orgId: OrgId, approvalId: ApprovalId, at: string): TransactItem => ({
  Put: { TableName: deps.tableName, Item: { ...openApprovalKey(at, orgId, approvalId), entityType: "OPEN_APPROVAL", orgId, approvalId } },
});
const dropItem = (deps: Pick<ApprovalStoreDependencies, "tableName">, orgId: OrgId, approvalId: ApprovalId, at: string): TransactItem => ({
  Delete: { TableName: deps.tableName, Key: openApprovalKey(at, orgId, approvalId) },
});
/** Drops the due items at `drop` and puts one at `put` (never both on one key: a transaction can't hold two operations on an item). */
const dueItems = (deps: Pick<ApprovalStoreDependencies, "tableName">, record: AnyApprovalRecord, drop: readonly string[], put: string | undefined): TransactItem[] => [
  ...[...new Set(drop)].filter((at) => at !== put).map((at) => dropItem(deps, record.orgId, record.approvalId, at)),
  ...(put === undefined ? [] : [dueItem(deps, record.orgId, record.approvalId, put)]),
];
const counterDrop = (deps: Pick<ApprovalStoreDependencies, "tableName">, record: AnyApprovalRecord): TransactItem[] => (record.kind === "write"
  ? [{
    Update: {
      TableName: deps.tableName, Key: stepCounterKey(record.orgId, record.subject.taskId, record.subject.stepId),
      UpdateExpression: "SET #pending = if_not_exists(#pending, :one) - :one", ExpressionAttributeNames: { "#pending": "pending" }, ExpressionAttributeValues: { ":one": 1 },
    },
  }]
  : []);

/** An update of the record's fields, conditional on `when` (an expression over the aliases); undefined values are left out. */
function updateRecord(deps: Pick<ApprovalStoreDependencies, "tableName">, record: AnyApprovalRecord, set: Record<string, unknown>, when: Array<[attribute: string, value: unknown]> | "pending"): TransactItem {
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  Object.entries(set).filter(([, value]) => value !== undefined).forEach(([name, value], index) => {
    names[`#f${String(index)}`] = name;
    values[`:f${String(index)}`] = value;
    sets.push(`#f${String(index)} = :f${String(index)}`);
  });
  const conditions: string[] = [];
  if (when === "pending") {
    conditions.push("#status = :pending");
    values[":pending"] = "PENDING";
  } else {
    when.forEach(([attribute, value], index) => {
      const alias = attribute === "status" ? "#status" : `#w${String(index)}`;
      if (attribute !== "status") names[`#w${String(index)}`] = attribute;
      conditions.push(`${alias} = :w${String(index)}`);
      values[`:w${String(index)}`] = value;
    });
  }
  return {
    Update: {
      TableName: deps.tableName, Key: approvalKey(record.orgId, record.approvalId), UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    },
  };
}

/** Sends a transaction; false when the record's own condition (item `at`) failed, i.e. someone else changed it first. */
async function commitOrLost(deps: ApprovalStoreDependencies, items: TransactItem[], at = 0): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (errorNameOf(error) !== "TransactionCanceledException") throw error;
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
    if (reasons?.[at]?.Code === "ConditionalCheckFailed") return false;
    throw error;
  }
}

const withFields = <T extends AnyApprovalRecord>(record: T, fields: Record<string, unknown>): T => ({ ...record, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) });

/** Tells the subject's handler how the record ended, once: it takes the lease, runs, and marks the record handled and drops its due items. A failure leaves the lease to run out and the sweep calls again. */
async function tellHandler(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<boolean> {
  const handler = getApprovalSubjectHandler(record.subject.kind);
  if (handler === undefined) {
    log(deps, "approval.handler_missing", { orgId: record.orgId, approvalId: record.approvalId, kind: record.subject.kind });
    return false;
  }
  try {
    await handler(deps, record, record.decisionProof === undefined ? undefined : { proof: record.decisionProof });
  } catch (error) {
    log(deps, "approval.handler_failed", { orgId: record.orgId, approvalId: record.approvalId, kind: record.subject.kind, error: errorNameOf(error) });
    return false;
  }
  const items: TransactItem[] = [updateRecord(deps, record, { handlerDone: true }, [["status", record.status], ["handlerDone", false]])];
  for (const at of new Set([record.handlerDueAt, record.executingAt === undefined ? undefined : iso(Date.parse(record.executingAt) + RETRY_MS)])) {
    if (at !== undefined) items.push(dropItem(deps, record.orgId, record.approvalId, at));
  }
  await commitOrLost(deps, items);
  return true;
}

/** Takes the lease on telling the handler (the sweep's path): refused while another run holds it, taken again once it is older than the retry time. */
async function leaseHandler(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<AnyApprovalRecord | undefined> {
  const now = deps.now();
  // A lease younger than the retry time is someone else's.
  if (record.handlerClaimedAt !== undefined && record.handlerClaimedAt > iso(now - RETRY_MS)) return undefined;
  const names: Record<string, string> = { "#status": "status", "#done": "handlerDone", "#claimed": "handlerClaimedAt" };
  const values: Record<string, unknown> = { ":status": record.status, ":false": false, ":now": iso(now) };
  if (record.handlerClaimedAt !== undefined) values[":seen"] = record.handlerClaimedAt;
  const won = await commitOrLost(deps, [{
    Update: {
      TableName: deps.tableName, Key: approvalKey(record.orgId, record.approvalId), UpdateExpression: "SET #claimed = :now",
      ConditionExpression: `#status = :status AND #done = :false AND ${record.handlerClaimedAt === undefined ? "attribute_not_exists(#claimed)" : "#claimed = :seen"}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    },
  }]);
  return won ? withFields(record, { handlerClaimedAt: iso(now) }) : undefined;
}

/** Ends an EXECUTING record (conditional on the claim it was driven under), recording the outcome and what is owed after it. */
async function finish(deps: ApprovalDependencies, record: AnyApprovalRecord, stamp: string, outcome: { status: "APPROVED_DONE" | "APPROVED_FAILED"; failure?: string; result?: WriteApprovalRecord["result"] }): Promise<AnyApprovalRecord | undefined> {
  const now = deps.now();
  const handler = hasHandlerPhase(record);
  const dueAt = iso(now + RETRY_MS);
  const fields = {
    status: outcome.status, failure: outcome.failure, result: outcome.result,
    handlerDone: !handler, ...(handler ? { handlerClaimedAt: iso(now), handlerDueAt: dueAt } : {}),
  };
  const events = record.kind === "write"
    ? await tryAuditEvents(deps, () => [auditWriteExecuted({
      orgId: record.orgId, actor: auditActorOf("system"), occurredAt: iso(now), occurrence: record.approvalId, approvalId: record.approvalId,
      connectorType: record.connectorType, tool: record.tool, status: outcome.status, argumentsHash: record.argumentsHash,
    })])
    : [];
  const items: TransactItem[] = [
    updateRecord(deps, record, fields, [["status", "EXECUTING"], ["executingAt", stamp]]),
    ...dueItems(deps, record, [iso(Date.parse(stamp) + RETRY_MS)], handler ? dueAt : undefined),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (!await commitOrLost(deps, items)) return undefined;
  await flushAuditEvents(deps, events);
  return withFields(record, fields);
}

/** Drives an EXECUTING record (claimed under `record.executingAt`) to its end. */
async function drive(deps: ApprovalDependencies, record: AnyApprovalRecord, executor: Executor): Promise<{ status: ApprovalStatus }> {
  const stamp = record.executingAt!;
  const result = await execute(deps, executor, record);
  let ended: AnyApprovalRecord | undefined;
  if (result.outcome === "done") ended = await finish(deps, record, stamp, { status: "APPROVED_DONE", ...(result.result === undefined ? {} : { result: result.result }) });
  else if (result.outcome === "failed") ended = await finish(deps, record, stamp, { status: "APPROVED_FAILED", failure: result.failure });
  else if ((record.attempts ?? 1) >= MAX_APPROVAL_ATTEMPTS) ended = await finish(deps, record, stamp, { status: "APPROVED_FAILED", failure: unconfirmedMessage(record) });
  else return { status: "EXECUTING" };
  if (ended === undefined) return { status: (await getAnyApproval(deps, record.orgId, record.approvalId))?.status ?? "EXECUTING" };
  if (hasHandlerPhase(ended)) await tellHandler(deps, ended);
  return { status: ended.status };
}

/**
 * Decides `record` as `caller`, for any kind. A repeat of the decision's own request id by the same person answers the stored outcome; else the caller
 * must satisfy the record's approvers now (`FORBIDDEN`), and it must still be PENDING (`APPROVAL_CLOSED`). The claim is one conditional transaction,
 * so of two decisions at once exactly one wins.
 */
export async function runApprovalDecision(deps: ApprovalDependencies, caller: ApprovalCaller, record: AnyApprovalRecord, rawBody: unknown, executor?: Executor): Promise<{ status: ApprovalStatus }> {
  const body = parseDecideBody(rawBody);
  if (record.status !== "PENDING" && record.decisionRequestId === body.requestId && record.decidedBy !== undefined && await sameMember(deps, record.orgId, record.decidedBy, caller.developerId)) {
    return { status: record.status };
  }
  if (!await mayDecideApproval(deps, caller, record)) throw agentXError("FORBIDDEN", forbiddenText(record));
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  const run = executor ?? executorFor(record);
  if (record.kind === "write" && body.decision === "APPROVE" && deps.writeGate === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "writes by agents are not set up in this deployment");
  if (body.decision === "APPROVE" && run === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this kind of approval can't be decided in this deployment");

  const now = deps.now();
  const at = iso(now);
  const status: ApprovalStatus = body.decision === "DECLINE" ? "DECLINED" : record.kind === "step" ? "APPROVED" : "EXECUTING";
  const proof = decisionProofOf(caller);
  const handler = status !== "EXECUTING" && hasHandlerPhase(record);
  const fields = {
    status, decidedBy: caller.developerId, decidedAt: at, decision: body.decision, decisionRequestId: body.requestId, decisionProof: proof,
    ...(status === "EXECUTING" ? { executingAt: at, attempts: 1 } : {}),
    ...(status === "EXECUTING" ? {} : { handlerDone: !handler, ...(handler ? { handlerClaimedAt: at, handlerDueAt: iso(now + RETRY_MS) } : {}) }),
  };
  const events = await tryAuditEvents(deps, () => [auditApprovalDecided({
    orgId: record.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: record.approvalId, proof, approvalId: record.approvalId,
    kind: record.kind, decision: body.decision, subjectKind: record.subject.kind, ...(record.kind === "write" ? { class: record.class } : {}),
  })]);
  const items: TransactItem[] = [
    updateRecord(deps, record, fields, "pending"),
    ...dueItems(deps, record, [record.expiresAt], status === "EXECUTING" || handler ? iso(now + RETRY_MS) : undefined),
    ...counterDrop(deps, record),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (!await commitOrLost(deps, items)) throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  await flushAuditEvents(deps, events);

  const claimed = withFields(record, fields);
  if (status === "EXECUTING") return drive(deps, claimed, run!);
  if (handler) await tellHandler(deps, claimed);
  return { status };
}

/** Decides an approval of any kind as `caller` (a write goes through the write driver, a step through the rule or the id check and then its subject's handler, a change through its handler). */
export async function decideApproval(deps: ApprovalDependencies, caller: ApprovalCaller, approvalId: string, body: unknown): Promise<{ status: ApprovalStatus }> {
  const id = ApprovalIdSchema.safeParse(approvalId);
  const record = id.success ? await getAnyApproval(deps, caller.orgId, id.data) : undefined;
  if (record === undefined) throw agentXError("NOT_FOUND", "approval not found");
  return runApprovalDecision(deps, caller, record, body);
}

// ---- the sweep

export interface ApprovalSweepReport {
  /** Records that expired, stuck ones driven again, handlers told, and items left alone because they failed (they are tried again next run). */
  expired: number;
  redriven: number;
  handled: number;
  failed: number;
  next?: string;
  stopped?: true;
}

/** Ends a PENDING record whose time has run out (conditional on it still being PENDING), freeing its place in its step, then tells its handler. */
async function expireOne(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<AnyApprovalRecord | undefined> {
  const now = deps.now();
  const handler = hasHandlerPhase(record);
  const dueAt = iso(now + RETRY_MS);
  const fields = { status: "EXPIRED" as const, handlerDone: !handler, ...(handler ? { handlerClaimedAt: iso(now), handlerDueAt: dueAt } : {}) };
  const events = await tryAuditEvents(deps, () => [auditApprovalExpired({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: iso(now), occurrence: record.approvalId, approvalId: record.approvalId, kind: record.kind, subjectKind: record.subject.kind,
  })]);
  const items: TransactItem[] = [
    updateRecord(deps, record, fields, "pending"),
    ...dueItems(deps, record, [record.expiresAt], handler ? dueAt : undefined),
    ...counterDrop(deps, record),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (!await commitOrLost(deps, items)) return undefined;
  await flushAuditEvents(deps, events);
  return withFields(record, fields);
}

/** Drives a record that stayed EXECUTING past the retry time again: claimed by a conditional update of `executingAt`, so two sweeps never both run it. */
async function redrive(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<boolean> {
  const stamp = record.executingAt!;
  if ((record.attempts ?? 1) >= MAX_APPROVAL_ATTEMPTS) {
    const ended = await finish(deps, record, stamp, { status: "APPROVED_FAILED", failure: unconfirmedMessage(record) });
    if (ended !== undefined && hasHandlerPhase(ended)) await tellHandler(deps, ended);
    return ended !== undefined;
  }
  const executor = executorFor(record);
  if (executor === undefined) {
    log(deps, "approval.driver_missing", { orgId: record.orgId, approvalId: record.approvalId, kind: record.kind });
    return false;
  }
  const now = deps.now();
  const fields = { executingAt: iso(now), attempts: (record.attempts ?? 1) + 1 };
  const claimed = await commitOrLost(deps, [
    updateRecord(deps, record, fields, [["status", "EXECUTING"], ["executingAt", stamp]]),
    ...dueItems(deps, record, [iso(Date.parse(stamp) + RETRY_MS)], iso(now + RETRY_MS)),
  ]);
  if (!claimed) return false;
  await drive(deps, withFields(record, fields), executor);
  return true;
}

/**
 * One page of the open index (`OPEN_APPROVALS`: `<due time>#<org>#<id>`, ids only), up to `now`. For each due item the record decides what is owed:
 * a PENDING record past `expiresAt` becomes EXPIRED (its handler is told); an EXECUTING one more than APPROVAL_EXECUTING_RETRY_MINUTES past
 * `executingAt` is driven again (after 5 attempts it ends APPROVED_FAILED); a finished one whose handler never heard is told again. EXPIRY NEVER
 * TOUCHES AN EXECUTING RECORD. `cursor` is the sort key to start after; `options.deadline` stops the page before the next item once it has passed.
 */
export async function expireApprovals(deps: ApprovalDependencies, now: number, cursor?: string, options: { deadline?: number; limit?: number } = {}): Promise<ApprovalSweepReport> {
  const report: ApprovalSweepReport = { expired: 0, redriven: 0, handled: 0, failed: 0 };
  const until = iso(now);
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "OPEN_APPROVALS" }, ConsistentRead: true,
    Limit: options.limit ?? PAGE_LIMIT, ...(cursor === undefined ? {} : { ExclusiveStartKey: { pk: "OPEN_APPROVALS", sk: cursor } }),
  })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: { sk?: unknown } };
  let resumeAfter = cursor;
  const remove = (item: Record<string, unknown>) => deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } } }] }));
  for (const item of page.Items ?? []) {
    const sk = String(item["sk"]);
    const parts = DUE_SK.exec(sk);
    if (parts !== null && sk.slice(0, 24) > until) return report;
    if (options.deadline !== undefined && deps.now() >= options.deadline) return { ...report, ...(resumeAfter === undefined ? {} : { next: resumeAfter }), stopped: true };
    resumeAfter = sk;
    if (parts === null || item["orgId"] !== parts[2] || item["approvalId"] !== parts[3]) {
      log(deps, "approval.open_item_rejected", { reason: "malformed" });
      await remove(item);
      continue;
    }
    try {
      const record = await getAnyApproval(deps, parts[2] as OrgId, parts[3] as ApprovalId);
      if (record === undefined) { await remove(item); continue; }
      if (record.status === "PENDING") {
        // Not yet its time (this item is then the record's own expiry item, early by a clock's difference, or a stale one that the check below drops).
        if (Date.parse(record.expiresAt) <= now) {
          const ended = await expireOne(deps, record);
          if (ended !== undefined) {
            report.expired += 1;
            if (hasHandlerPhase(ended) && await tellHandler(deps, ended)) report.handled += 1;
          }
        }
      } else if (record.status === "EXECUTING") {
        if (record.executingAt !== undefined && Date.parse(record.executingAt) + RETRY_MS <= now) {
          if (await redrive(deps, record)) report.redriven += 1;
        }
      } else if (record.handlerDone !== true && hasHandlerPhase(record)) {
        const leased = await leaseHandler(deps, record);
        if (leased !== undefined && await tellHandler(deps, leased)) report.handled += 1;
      }
      // This item is kept only while it is still what the record is waiting on; a settled record, or one driven past this item's time, drops it.
      const after = await getAnyApproval(deps, parts[2] as OrgId, parts[3] as ApprovalId);
      const owed = after !== undefined && ((after.status === "PENDING" && iso(Date.parse(after.expiresAt)) === sk.slice(0, 24))
        || (after.status === "EXECUTING" && after.executingAt !== undefined && iso(Date.parse(after.executingAt) + RETRY_MS) === sk.slice(0, 24))
        || (hasHandlerPhase(after) && after.handlerDone !== true && after.status !== "EXECUTING" && after.status !== "PENDING"));
      if (!owed) await remove(item);
    } catch (error) {
      report.failed += 1;
      log(deps, "approval.sweep_item_failed", { orgId: parts[2], approvalId: parts[3], error: errorNameOf(error) });
    }
  }
  const next = page.LastEvaluatedKey?.sk;
  return typeof next === "string" ? { ...report, next } : report;
}

/** The settlement job: pages of `expireApprovals` until the open index is drained to now or `budgetMs` has passed. A page that stopped at its deadline resumes from its cursor on the next run's first page. */
export async function runApprovalSweep(deps: ApprovalDependencies, options: { budgetMs: number }): Promise<ApprovalSweepReport & { pages: number; complete: boolean }> {
  const deadline = deps.now() + options.budgetMs;
  const total = { expired: 0, redriven: 0, handled: 0, failed: 0, pages: 0, complete: false };
  let cursor: string | undefined;
  for (;;) {
    if (deps.now() >= deadline) return total;
    const page = await expireApprovals(deps, deps.now(), cursor, { deadline });
    total.pages += 1;
    total.expired += page.expired;
    total.redriven += page.redriven;
    total.handled += page.handled;
    total.failed += page.failed;
    if (page.stopped === true) return total;
    cursor = page.next;
    if (cursor === undefined) return { ...total, complete: true };
  }
}

// ---- the movers (Task 11's hand-off)

interface MoveContext { deps: LifecycleDeps; orgId: OrgId; from: string; to: string; mode: "merged" | "removed" }

const swapped = (ids: readonly string[], from: string, to: string | undefined): string[] => [...new Set(ids.flatMap((id) => (id === from ? (to === undefined ? [] : [to]) : [id])))];

/** Moves one approval's mentions of `from`. Conditional on the record still being PENDING and unmoved since it was read, so a repeat or a race changes nothing twice. */
async function moveOne(context: MoveContext, approvalId: ApprovalId): Promise<void> {
  const { deps, orgId, from, to, mode } = context;
  for (let tried = 0; tried < 3; tried += 1) {
    const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(orgId, approvalId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const record = await getAnyApproval(deps, orgId, approvalId);
    const indexDrop: TransactItem = { Delete: { TableName: deps.tableName, Key: approverIndexKey(orgId, from, approvalId) } };
    if (record === undefined || record.status !== "PENDING") {
      // A decided or missing record keeps no place in anyone's list.
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [indexDrop] }));
      return;
    }
    const spec = record.approvers;
    const currentOwner = record.kind === "change" ? undefined : record.owner;
    const ownerIsFrom = currentOwner !== undefined && currentOwner.developerId === from;
    const approvers: ApproverSpec = spec.kind === "ids"
      ? { kind: "ids", ids: swapped(spec.ids, from, to) }
      : { kind: "rule", rule: spec.rule, candidates: mode === "merged" || ownerIsFrom ? swapped(spec.candidates, from, to) : swapped(spec.candidates, from, undefined) };
    let owner: { developerId: string; name: string } | undefined;
    if (currentOwner !== undefined && ownerIsFrom) {
      const successor = mode === "removed" ? await deps.signInStore.getDeveloper(to) : undefined;
      owner = { developerId: to, name: mode === "merged" ? currentOwner.name : (successor as { displayName?: string } | undefined)?.displayName ?? "the organization owner" };
    }
    const changed = canonicalJson(approvers) !== canonicalJson(spec) || owner !== undefined;
    const moveRevision = stored.Item?.["moveRevision"];
    const names: Record<string, string> = { "#status": "status", "#rev": "moveRevision" };
    const values: Record<string, unknown> = { ":pending": "PENDING", ":zero": 0 };
    const sets = ["#rev = if_not_exists(#rev, :zero) + :one"];
    values[":one"] = changed ? 1 : 0;
    if (changed) {
      names["#approvers"] = "approvers";
      values[":approvers"] = approvers;
      sets.push("#approvers = :approvers");
      if (owner !== undefined) {
        names["#owner"] = "owner";
        values[":owner"] = owner;
        sets.push("#owner = :owner");
      }
    }
    if (typeof moveRevision === "number") values[":seen"] = moveRevision;
    const items: TransactItem[] = [
      {
        Update: {
          TableName: deps.tableName, Key: approvalKey(orgId, approvalId), UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: typeof moveRevision === "number" ? "#status = :pending AND #rev = :seen" : "#status = :pending AND attribute_not_exists(#rev)",
          ExpressionAttributeNames: names, ExpressionAttributeValues: values,
        },
      },
      indexDrop,
    ];
    // Only a person who is still listed after the move keeps a place in someone's list.
    if (listedPeople(approvers).includes(to)) {
      items.push({ Put: { TableName: deps.tableName, Item: { ...approverIndexKey(orgId, to, approvalId), entityType: "APPROVER_INDEX", approvalId, expiresAt: record.expiresAt } } });
    }
    if (await commitOrLost(deps, items)) return;
  }
  throw new Error("approval_move_conflict");
}

async function moveApprovals(deps: LifecycleDeps, orgId: OrgId, from: string, to: string, mode: "merged" | "removed"): Promise<void> {
  const pk = approverIndexKey(orgId, from, "apr_00000000000000000000").pk;
  const ids: ApprovalId[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ approvalId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = ApprovalIdSchema.safeParse(item.approvalId);
      if (parsed.success) ids.push(parsed.data);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  for (const approvalId of ids) {
    checkTime(deps);
    await moveOne({ deps, orgId, from, to, mode }, approvalId);
  }
}

registerMemberMover({
  name: "approvals",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveApprovals(deps, orgId, duplicateId, survivorId, "merged"),
  removed: (deps, { orgId, developerId, successorId }) => moveApprovals(deps, orgId, developerId, successorId, "removed"),
});
