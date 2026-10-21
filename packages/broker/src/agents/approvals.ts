// Plan 3 Task 7 (PF18, PF19): the approvals core. A change that needs a person's confirmation (a less-safe publish, rollback or
// adoption, a company-wide share; later the guardrail relaxations, connector widenings and opt-outs) is stored as one APPROVAL#
// record with `kind: "change"`, listed through the global OPEN_APPROVALS index and one APPROVER# item per person who may be asked.
// Nothing is applied when the record is made. Deciding it is Task 21's `decideApproval` and Task 21a's confirmation page: they check
// the registered rule against the caller now (R68), then call the registered handler for the subject, which applies exactly what the
// record stores or throws the reason it can no longer be applied (the record then ends `APPROVED_FAILED` with that reason).
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentGuardrailsSchema,
  AgentIdSchema,
  AgentPrincipalSchema,
  ApprovalIdSchema,
  CHANGE_APPROVAL_TTL_DAYS,
  OrgIdSchema,
  agentXError,
  approvalKey,
  approverIndexKey,
  canonicalJson,
  newPrefixedId,
  openApprovalKey,
  type AgentGuardrails,
  type AgentId,
  type ApprovalId,
  type OrgId,
} from "@agentx/contracts";
import type { AgentAccessDeps, AgentCaller, AgentShare } from "./access.js";
import type { ServableModels } from "./guardrails.js";
import type { ResolveOptions } from "./store.js";

/** What an agent's routes and the approvals that act on agents need: access checks, the store and where the page lives. */
export interface ApprovalDependencies extends AgentAccessDeps {
  now: () => number;
  /** The cell's origin, where `/v1/app/approve/<id>` is served. */
  confirmOrigin: string;
  /** Looks up an added skill's name and digest (Task 9); without it, a recipe that adds a skill can't be resolved. */
  resolveSkill?: ResolveOptions["resolveSkill"];
  /** The models some source the company can use serves (Task 26); without it, the models Rovara's own AI serves. */
  servableModels?: ServableModels;
}

/** The part of the dependencies the record's own writes need. */
export type ApprovalStoreDependencies = Pick<ApprovalDependencies, "documentClient" | "tableName" | "now">;

/** Who must decide: the people named, or a rule evaluated when the decision is made (R64, R68), whose `candidates` only see it listed. */
export type ApproverSpec =
  | { kind: "ids"; ids: readonly string[] }
  | { kind: "rule"; rule: string; candidates: readonly string[] };

export type ApprovalStatus = "PENDING" | "EXECUTING" | "APPROVED_DONE" | "APPROVED_FAILED" | "DECLINED" | "EXPIRED";

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

/** The other kinds of change (connector widenings, opt-outs) carry their own details, typed by the task that makes them. */
export type OtherChangeSubject = { kind: "connector_widen" | "opt_out" } & Record<string, unknown>;
export type ChangeSubject = AgentChangeSubject | OtherChangeSubject;

export interface ChangeApprovalRecord {
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

/** Task 21 widens this with step and write approvals. */
export type ApprovalRecord = ChangeApprovalRecord;

export type ApprovalCaller = AgentCaller;

/** Whether `caller` may decide `record` now. Evaluated live each time, so a person demoted since it was asked can't decide it. */
export type ApproverRuleCheck = (deps: ApprovalDependencies, record: ApprovalRecord, caller: ApprovalCaller) => Promise<boolean>;
/** Applies a confirmed record exactly as stored, or throws why it can't. `decidedBy` is set on the record when it runs. */
export type ApprovalSubjectHandler = (deps: ApprovalDependencies, record: ApprovalRecord) => Promise<void>;

const rules = new Map<string, ApproverRuleCheck>();
const handlers = new Map<ChangeSubject["kind"], ApprovalSubjectHandler>();

/** Registers (or replaces) the rule a record's `approvers` can name. */
export function registerApproverRule(rule: string, eligible: ApproverRuleCheck): void {
  rules.set(rule, eligible);
}

/** Registers (or replaces) what confirming a record of this subject kind does. */
export function registerApprovalSubjectHandler(kind: ChangeSubject["kind"], handler: ApprovalSubjectHandler): void {
  handlers.set(kind, handler);
}

export const getApproverRule = (rule: string): ApproverRuleCheck | undefined => rules.get(rule);
export const getApprovalSubjectHandler = (kind: ChangeSubject["kind"]): ApprovalSubjectHandler | undefined => handlers.get(kind);

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
  // The other kinds carry details their own tasks type; only the kind is checked here.
  z.object({ kind: z.enum(["connector_widen", "opt_out"]) }).passthrough(),
]);
/** What a stored change record must look like to be read; `passthrough`, so a field a later task adds is kept. */
const ChangeApprovalRecordSchema = z.object({
  orgId: OrgIdSchema,
  approvalId: ApprovalIdSchema,
  kind: z.literal("change"),
  subject: ChangeSubjectSchema,
  changes: z.array(z.string()),
  approvers: ApproverSpecSchema,
  status: z.enum(["PENDING", "EXECUTING", "APPROVED_DONE", "APPROVED_FAILED", "DECLINED", "EXPIRED"]),
  requestedBy: z.string(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  failure: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
}).passthrough();

/** The record, or undefined when there is none in this org or what is stored is not a record (reported, never handed on). */
export async function getApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, approvalId: ApprovalId): Promise<ApprovalRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(orgId, approvalId), ConsistentRead: true })) as { Item?: Item };
  const item = response.Item;
  // Records are looked up by an id the caller names; one that belongs to another org reads as missing.
  if (item === undefined || item["orgId"] !== orgId) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...record } = item;
  const parsed = ChangeApprovalRecordSchema.safeParse(record);
  if (!parsed.success) {
    console.error(JSON.stringify({ component: "broker", level: "error", event: "approval_record_invalid", orgId, approvalId, problem: parsed.error.issues[0]?.path.join(".") ?? "record" }));
    return undefined;
  }
  return parsed.data as unknown as ApprovalRecord;
}

const listedPeople = (approvers: ApproverSpec): string[] => [...new Set(approvers.kind === "ids" ? approvers.ids : approvers.candidates)].sort().slice(0, MAX_LISTED_APPROVERS);

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
