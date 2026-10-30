import { nativeSnapshotConditions } from "./native-snapshot-conditions.js";
import type { TransactItem } from "../agents/table-writes.js";
// A captured numeric policy is not paid-work permission: callers still commit
// live authority, lifecycle, monthly admission, audit and their idempotent work.
import { createHash } from "node:crypto";
import { TransactGetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentGuardrailsSchema, AgentIdSchema, OrgIdSchema, OrgRoleSchema, TaskStopAdmissionInputSchema,
  agentGuardrailsKey, agentKey, agentXError, builtinSettingsKey, calculateTaskStop, developerOrgKey,
  isBuiltinAgentId, orgMemberKey, orgMetaKey, orgScoped, orgProjectCatalogKey, orgSettingsKey, projectAiKey,
  type TaskStopAdmissionInput, type TaskStopBindingScope,
} from "@agentx/contracts";
import { usdToWholeMicrodollars } from "./budget-amount.js";

const CaptureIdentity = z.object({
  orgId: OrgIdSchema, developerId: z.string().regex(/^[a-f0-9]{64}$/), role: OrgRoleSchema,
  project: z.string().min(1).max(256), agentId: AgentIdSchema,
  pathLimitMicrousd: z.unknown(), approvedRunLimitMicrousd: z.unknown().optional(),
  committedMaxPerRunMicrousd: z.unknown().optional(), requestedMicrousd: z.unknown().optional(), chainMicrousd: z.unknown().optional(), testingMicrousd: z.unknown().optional(),
}).strict();
const EvalCaptureIdentity = CaptureIdentity.omit({ agentId: true }).extend({ agentScope: z.literal("none_eval") }).strict();
export type TaskStopEvalCaptureRequest = z.infer<typeof EvalCaptureIdentity>;
export type TaskStopCaptureRequest = z.infer<typeof CaptureIdentity>;
export interface TaskStopCaptureDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now?: () => number;
  /** Must perform live org/project/agent visibility and start-authority checks.
   * No API body may provide this callback or the trusted caller identity. */
  requireScopeAccess(input: TaskStopCaptureRequest): Promise<void>;
}
export interface CapturedTaskStop {
  kind: "captured";
  schemaVersion: 2;
  orgId: string;
  project: string;
  agentId: string;
  capturedAt: string;
  policyDigest: string;
  effectiveStopMicrousd: number;
  approvalCapMicrousd: number;
  bindingScopes: TaskStopBindingScope[];
  calculationInput: TaskStopAdmissionInput;
  sourceRevisions: { company: number; ceiling: number; projectCatalog: number; project: number; agent: number };
}
export type CapturedTaskStopEval = Omit<CapturedTaskStop, "agentId" | "sourceRevisions"> & {
  agentScope: "none_eval";
  sourceRevisions: Omit<CapturedTaskStop["sourceRevisions"], "agent"> & { agent: null };
};
export type TaskStopEvalCaptureDependencies = Omit<TaskStopCaptureDependencies, "requireScopeAccess"> & {
  requireScopeAccess(input: TaskStopEvalCaptureRequest): Promise<void>;
};
type SnapshotDependencies = Omit<TaskStopCaptureDependencies, "requireScopeAccess"> & { requireScopeAccess(input: unknown): Promise<void> };
const agentCaptureDeps = (deps: TaskStopCaptureDependencies): SnapshotDependencies => ({ ...deps, requireScopeAccess: input => deps.requireScopeAccess(CaptureIdentity.parse(input)) });
const requireAgentSnapshot = (snapshot: CapturedTaskStop | CapturedTaskStopEval | { kind: "disabled" }): CapturedTaskStop | { kind: "disabled" } => {
  if (snapshot.kind === "captured" && !("agentId" in snapshot)) throw invalid();
  return snapshot;
};
export async function captureTaskStopEvalAdmission(deps: TaskStopEvalCaptureDependencies, value: unknown): Promise<CapturedTaskStopEval | { kind: "disabled" }> {
  const snapshot = await captureTaskStopSnapshot({ ...deps, requireScopeAccess: input => deps.requireScopeAccess(EvalCaptureIdentity.parse(input)) }, value, false, undefined, true);
  if (snapshot.kind === "captured" && !("agentScope" in snapshot)) throw invalid();
  return snapshot;
}
const missing = () => agentXError("TASK_STOP_CONFIG_MISSING", "Work can't start: a required spending setting is missing. Ask an admin to review Spending.");
const invalid = () => agentXError("TASK_STOP_CONFIG_INVALID", "Work can't start: a spending setting couldn't be read or is invalid. Ask an admin to review Spending.");
const forbidden = () => agentXError("FORBIDDEN", "Your company access changed. Reload and check your access before starting work.");
const responseSchema = z.object({ Responses: z.array(z.object({ Item: z.record(z.string(), z.unknown()).optional() })) });
const positiveRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function captureTaskStopAdmission(deps: TaskStopCaptureDependencies, value: unknown): Promise<CapturedTaskStop | { kind: "disabled" }> {
  return requireAgentSnapshot(await captureTaskStopSnapshot(agentCaptureDeps(deps), value, false));
}

/** Read-only cutover review. The preview wrapper is deliberately not an
 * admission envelope, changes no enrollment and grants no paid-work authority. */
export async function previewTaskStopCutover(deps: TaskStopCaptureDependencies, value: unknown): Promise<{ kind: "preview"; enrolled: false; snapshot: CapturedTaskStop }> {
  const snapshot = requireAgentSnapshot(await captureTaskStopSnapshot(agentCaptureDeps(deps), value, true));
  if (snapshot.kind !== "captured") throw missing();
  return { kind: "preview", enrolled: false, snapshot };
}

/** Internal transaction context. Never serialize these native source checks. */
export async function captureTaskStopCutoverReview(deps: TaskStopCaptureDependencies, value: unknown): Promise<{ kind: "preview"; enrolled: false; snapshot: CapturedTaskStop; sourceChecks: TransactItem[] }> {
  const sourceChecks: TransactItem[] = [], snapshot = requireAgentSnapshot(await captureTaskStopSnapshot(agentCaptureDeps(deps), value, true, sourceChecks));
  if (snapshot.kind !== "captured") throw missing();
  return { kind: "preview", enrolled: false, snapshot, sourceChecks };
}

async function captureTaskStopSnapshot(deps: SnapshotDependencies, value: unknown, cutoverPreview: boolean, nativeChecks?: TransactItem[], evalScope = false): Promise<CapturedTaskStop | CapturedTaskStopEval | { kind: "disabled" }> {
  const parsedIdentity = (evalScope ? EvalCaptureIdentity : CaptureIdentity).safeParse(value);
  if (!parsedIdentity.success) throw forbidden();
  const identity = parsedIdentity.data;
  await deps.requireScopeAccess(identity);
  const { orgId, developerId, role, project } = identity;
  const agentId = "agentId" in identity ? identity.agentId : undefined;
  const builtin = agentId !== undefined && isBuiltinAgentId(agentId);
  const keys = [orgMemberKey(orgId, developerId), developerOrgKey(developerId), orgMetaKey(orgId),
    orgSettingsKey(orgId, "TASK_STOP_POLICY"), agentGuardrailsKey(orgId), orgProjectCatalogKey(orgId, project),
    projectAiKey(orgId, project),
    ...(agentId === undefined ? [] : [builtin ? builtinSettingsKey(orgId, agentId) : agentKey(orgId, agentId, "META")]),
    { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap" },
    { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#upgrade" }];
  let response: z.infer<typeof responseSchema>;
  try {
    // A single serializable read: never split the four policies across Gets or
    // retry individual scopes into a mixture of old and new monetary settings.
    response = responseSchema.parse(await deps.documentClient.send(new TransactGetCommand({
      TransactItems: keys.map(Key => ({ Get: { TableName: deps.tableName, Key } })),
    })));
  } catch { throw invalid(); }
  if (response.Responses.length !== keys.length) throw invalid();
  const rows = response.Responses.map(entry => entry.Item);
  function row(index: number, authority = false): Record<string, unknown> {
    const found = rows[index], key = keys[index];
    if (found === undefined) throw authority ? forbidden() : missing();
    if (key === undefined || found.pk !== key.pk || found.sk !== key.sk || found.orgId !== orgId) throw authority ? forbidden() : invalid();
    return found;
  }
  const org = row(2, true);
  if (org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
  // Immutable, non-TTL seed receipts distinguish a never-enrolled legacy org
  // from a seeded org whose canonical policy disappeared. Read them in the
  // SAME snapshot; absence is never translated into configured inheritance.
  const seedIndex = agentId === undefined ? 7 : 8;
  const receipts = [seedIndex, seedIndex + 1].flatMap(index => {
    if (rows[index] === undefined) return [];
    const receipt = row(index);
    if (receipt.entityType !== "TASK_STOP_SEED" || receipt.version !== 1
      || receipt.source !== (index === seedIndex ? "bootstrap" : "upgrade")
      || !["created", "preserved"].includes(String(receipt.outcome))
      || !positiveRevision(receipt.policyRevision)) throw invalid();
    return [receipt];
  });
  if (rows[3] === undefined && receipts.length === 0) return { kind: "disabled" };
  const company = row(3);
  if (company.entityType !== "ORG_TASK_STOP_POLICY" || !positiveRevision(company.revision)
    || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(company, field))) throw invalid();
  const enrollment = company.enrollment;
  if (!object(enrollment) || enrollment.version !== 1) throw invalid();
  const disabled = enrollment.state === "disabled" || enrollment.state === "ready";
  if (disabled && !cutoverPreview) return { kind: "disabled" };
  if ((!disabled && enrollment.state !== "enabled") || (cutoverPreview && !disabled)) throw invalid();
  // Admission after enrollment and explicit read-only cutover review both
  // require migrated native identities. Ordinary disabled admission stays legacy.
  const member = row(0, true), pointer = row(1, true);
  if (member.developerId !== developerId || member.role !== role || pointer.role !== role) throw forbidden();
  if (receipts.length === 0) throw missing();
  if (receipts.some(receipt => Number(receipt.policyRevision) > Number(company.revision))) throw invalid();
  const ceiling = row(4), catalog = row(5), settings = row(6), agent = agentId === undefined ? undefined : row(7);
  if (ceiling.entityType !== "AGENT_GUARDRAILS" || !positiveRevision(ceiling.revision)
    || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(ceiling, field))) throw invalid();
  const guardrails = AgentGuardrailsSchema.safeParse(ceiling.guardrails);
  if (!guardrails.success) throw invalid();
  const ceilingMicrousd = usdToWholeMicrodollars(guardrails.data.maxPerRunCeilingUsd);
  if (ceilingMicrousd === undefined) throw invalid();
  if (catalog.entityType !== "PROJECT_CATALOG" || catalog.name !== project || !positiveRevision(catalog.latestRevision)
    || settings.entityType !== "PROJECT_AI" || settings.project !== project || !positiveRevision(settings.revision)) throw invalid();
  if (agent !== undefined && (agent.entityType !== (builtin ? "BUILTIN_AGENT_SETTINGS" : "AGENT") || agent.agentId !== agentId
    || !positiveRevision(agent.revision) || (!builtin && agent.status !== "active"))) throw invalid();
  const rawPolicy = company.policy;
  if (!object(rawPolicy)) throw invalid();
  // Version 1 is an explicitly configured numeric company default, not the
  // upgrade's estimate mode. Both representations remain strictly validated.
  const companySchema = z.union([
    z.object({ schemaVersion: z.literal(1), defaultStopMicrousd: z.unknown() }).strict(),
    z.object({ schemaVersion: z.literal(2), defaultPolicy: z.unknown() }).strict(),
  ]);
  const companyPolicy = companySchema.safeParse(rawPolicy);
  if (!companyPolicy.success) throw invalid();
  const companyDefault = companyPolicy.data.schemaVersion === 1
    ? { kind: "limited", stopMicrousd: companyPolicy.data.defaultStopMicrousd } : companyPolicy.data.defaultPolicy;
  const projectPolicy = settings.taskStopPolicy;
  if (!object(projectPolicy)) throw invalid();
  const projectSchema = z.union([
    z.object({ schemaVersion: z.literal(1), stopMicrousd: z.unknown() }).strict(),
    z.object({ schemaVersion: z.literal(2), kind: z.literal("inherit") }).strict(),
  ]);
  const projectParsed = projectSchema.safeParse(projectPolicy);
  if (!projectParsed.success) throw invalid();
  const projectStop = projectParsed.data.schemaVersion === 1 ? { kind: "limited", stopMicrousd: projectParsed.data.stopMicrousd } : { kind: "inherit" };
  let agentStop: unknown = { kind: "inherit" };
  if (agent !== undefined && Object.hasOwn(agent, "maxPerRunUsd")) {
    const stopMicrousd = usdToWholeMicrodollars(agent.maxPerRunUsd);
    if (stopMicrousd === undefined || (agent.stopKind !== undefined && agent.stopKind !== "limited")) throw invalid();
    agentStop = { kind: "limited", stopMicrousd };
  } else if (agent !== undefined) {
    if (agent.stopKind !== "inherit") throw invalid();
    agentStop = { kind: "inherit" };
  }
  const data = TaskStopAdmissionInputSchema.safeParse({ schemaVersion: 2, companyDefault, ceilingMicrousd, projectStop, agentStop,
    pathLimitMicrousd: identity.pathLimitMicrousd,
    ...(identity.committedMaxPerRunMicrousd === undefined ? {} : { committedMaxPerRunMicrousd: identity.committedMaxPerRunMicrousd }),
    ...(identity.approvedRunLimitMicrousd === undefined ? {} : { approvedRunLimitMicrousd: identity.approvedRunLimitMicrousd }),
    ...(identity.requestedMicrousd === undefined ? {} : { requestedMicrousd: identity.requestedMicrousd }),
    ...(identity.chainMicrousd === undefined ? {} : { chainMicrousd: identity.chainMicrousd }),
    ...(identity.testingMicrousd === undefined ? {} : { testingMicrousd: identity.testingMicrousd }),
  });
  if (!data.success) throw invalid();
  const calculation = calculateTaskStop(data.data);
  if (calculation.kind === "refused") throw agentXError(calculation.reason, "This approval is above the company ceiling. Ask an admin to raise the ceiling first; that change needs a second person.");
  if (calculation.kind !== "resolved" || !("approvalCapMicrousd" in calculation)) throw invalid();
  const sourceRevisions = { company: company.revision, ceiling: ceiling.revision, projectCatalog: catalog.latestRevision, project: settings.revision, agent: agent?.revision ?? null };
  const policyDigest = createHash("sha256").update(JSON.stringify([orgId, project, agentId, sourceRevisions, data.data])).digest("hex");
  if (nativeChecks !== undefined) {
    const presenceFields = ["orgId", "developerId", "role", "closingAt", "closedAt", "revision", "latestRevision", "policy", "enrollment", "guardrails", "taskStopPolicy", "stopKind", "stopMicrousd", "maxPerRunUsd", "status", "owner", "accountable", "shares", "pinnedVersion", "version", "source", "outcome", "policyRevision"];
    nativeChecks.push(...nativeSnapshotConditions(deps.tableName, keys, rows, presenceFields));
  }
  const captured = { kind: "captured" as const, schemaVersion: 2 as const, orgId, project, capturedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    policyDigest, effectiveStopMicrousd: calculation.effectiveStopMicrousd, approvalCapMicrousd: calculation.approvalCapMicrousd,
    bindingScopes: calculation.bindingScopes, calculationInput: data.data };
  if (agentId === undefined) return { ...captured, agentScope: "none_eval", sourceRevisions: { ...sourceRevisions, agent: null } };
  return { ...captured, agentId, sourceRevisions: { ...sourceRevisions, agent: Number(agent!.revision) } };
}

/** Reuses one already captured economic snapshot with a proposed approval. */
export function approveCapturedTaskStop(snapshot: CapturedTaskStop, approvedLimitMicrousd: unknown, operation: "run_limit" | "max_per_run" = "run_limit", purpose: "admission" | "approval_allowance" = "admission"): CapturedTaskStop {
  const { approvedRunLimitMicrousd: _oldRun, approvedMaxPerRunMicrousd: _oldMax, ...basis } = snapshot.calculationInput;
  void _oldRun; void _oldMax;
  const { committedMaxPerRunMicrousd: _committed, ...allowance } = basis; void _committed;
  const parsed = TaskStopAdmissionInputSchema.safeParse({ ...(purpose === "approval_allowance" ? allowance : basis), ...(operation === "max_per_run" ? { approvedMaxPerRunMicrousd: approvedLimitMicrousd } : { approvedRunLimitMicrousd: approvedLimitMicrousd }) });
  if (!parsed.success) throw invalid();
  const calculation = calculateTaskStop(parsed.data);
  if (calculation.kind === "refused") throw agentXError(calculation.reason, "This approval is above the company ceiling. Ask an admin to raise the ceiling first; that change needs a second person.");
  if (calculation.kind !== "resolved" || !("approvalCapMicrousd" in calculation)) throw invalid();
  const policyDigest = createHash("sha256").update(JSON.stringify([snapshot.orgId, snapshot.project, snapshot.agentId, snapshot.sourceRevisions, parsed.data])).digest("hex");
  return { ...snapshot, calculationInput: parsed.data, policyDigest, effectiveStopMicrousd: calculation.effectiveStopMicrousd,
    approvalCapMicrousd: calculation.approvalCapMicrousd, bindingScopes: calculation.bindingScopes };
}
