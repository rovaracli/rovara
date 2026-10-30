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
  requestedMicrousd: z.unknown().optional(), chainMicrousd: z.unknown().optional(), testingMicrousd: z.unknown().optional(),
}).strict();
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
const missing = () => agentXError("TASK_STOP_CONFIG_MISSING", "Work can't start: a required spending setting is missing. Ask an admin to review Spending.");
const invalid = () => agentXError("TASK_STOP_CONFIG_INVALID", "Work can't start: a spending setting couldn't be read or is invalid. Ask an admin to review Spending.");
const forbidden = () => agentXError("FORBIDDEN", "Your company access changed. Reload and check your access before starting work.");
const responseSchema = z.object({ Responses: z.array(z.object({ Item: z.record(z.string(), z.unknown()).optional() })) });
const positiveRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function captureTaskStopAdmission(deps: TaskStopCaptureDependencies, value: unknown): Promise<CapturedTaskStop | { kind: "disabled" }> {
  const parsedIdentity = CaptureIdentity.safeParse(value);
  if (!parsedIdentity.success) throw forbidden();
  const identity = parsedIdentity.data;
  await deps.requireScopeAccess(identity);
  const { orgId, developerId, role, project, agentId } = identity;
  const builtin = isBuiltinAgentId(agentId);
  const keys = [orgMemberKey(orgId, developerId), developerOrgKey(developerId), orgMetaKey(orgId),
    orgSettingsKey(orgId, "TASK_STOP_POLICY"), agentGuardrailsKey(orgId), orgProjectCatalogKey(orgId, project),
    projectAiKey(orgId, project), builtin ? builtinSettingsKey(orgId, agentId) : agentKey(orgId, agentId, "META"),
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
  const member = row(0, true), pointer = row(1, true), org = row(2, true);
  if (member.developerId !== developerId || member.role !== role || pointer.role !== role || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
  // Immutable, non-TTL seed receipts distinguish a never-enrolled legacy org
  // from a seeded org whose canonical policy disappeared. Read them in the
  // SAME snapshot; absence is never translated into configured inheritance.
  const receipts = [8, 9].flatMap(index => {
    if (rows[index] === undefined) return [];
    const receipt = row(index);
    if (receipt.entityType !== "TASK_STOP_SEED" || receipt.version !== 1
      || receipt.source !== (index === 8 ? "bootstrap" : "upgrade")
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
  if (enrollment.state === "disabled" || enrollment.state === "ready") return { kind: "disabled" };
  if (enrollment.state !== "enabled") throw invalid();
  if (receipts.length === 0) throw missing();
  if (receipts.some(receipt => Number(receipt.policyRevision) > Number(company.revision))) throw invalid();
  const ceiling = row(4), catalog = row(5), settings = row(6), agent = row(7);
  if (ceiling.entityType !== "AGENT_GUARDRAILS" || !positiveRevision(ceiling.revision)
    || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(ceiling, field))) throw invalid();
  const guardrails = AgentGuardrailsSchema.safeParse(ceiling.guardrails);
  if (!guardrails.success) throw invalid();
  const ceilingMicrousd = usdToWholeMicrodollars(guardrails.data.maxPerRunCeilingUsd);
  if (ceilingMicrousd === undefined) throw invalid();
  if (catalog.entityType !== "PROJECT_CATALOG" || catalog.name !== project || !positiveRevision(catalog.latestRevision)
    || settings.entityType !== "PROJECT_AI" || settings.project !== project || !positiveRevision(settings.revision)) throw invalid();
  if (agent.entityType !== (builtin ? "BUILTIN_AGENT_SETTINGS" : "AGENT") || agent.agentId !== agentId
    || !positiveRevision(agent.revision) || (!builtin && agent.status !== "active")) throw invalid();
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
  let agentStop: unknown;
  if (Object.hasOwn(agent, "maxPerRunUsd")) {
    const stopMicrousd = usdToWholeMicrodollars(agent.maxPerRunUsd);
    if (stopMicrousd === undefined || (agent.stopKind !== undefined && agent.stopKind !== "limited")) throw invalid();
    agentStop = { kind: "limited", stopMicrousd };
  } else {
    if (agent.stopKind !== "inherit") throw invalid();
    agentStop = { kind: "inherit" };
  }
  const data = TaskStopAdmissionInputSchema.safeParse({ schemaVersion: 2, companyDefault, ceilingMicrousd, projectStop, agentStop,
    pathLimitMicrousd: identity.pathLimitMicrousd,
    ...(identity.approvedRunLimitMicrousd === undefined ? {} : { approvedRunLimitMicrousd: identity.approvedRunLimitMicrousd }),
    ...(identity.requestedMicrousd === undefined ? {} : { requestedMicrousd: identity.requestedMicrousd }),
    ...(identity.chainMicrousd === undefined ? {} : { chainMicrousd: identity.chainMicrousd }),
    ...(identity.testingMicrousd === undefined ? {} : { testingMicrousd: identity.testingMicrousd }),
  });
  if (!data.success) throw invalid();
  const calculation = calculateTaskStop(data.data);
  if (calculation.kind === "refused") throw agentXError(calculation.reason, "This approval is above the company ceiling. Ask an admin to raise the ceiling first; that change needs a second person.");
  if (calculation.kind !== "resolved" || !("approvalCapMicrousd" in calculation)) throw invalid();
  const sourceRevisions = { company: company.revision, ceiling: ceiling.revision, projectCatalog: catalog.latestRevision, project: settings.revision, agent: agent.revision };
  const policyDigest = createHash("sha256").update(JSON.stringify([orgId, project, agentId, sourceRevisions, data.data])).digest("hex");
  return { kind: "captured", schemaVersion: 2, orgId, project, agentId, capturedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    policyDigest, effectiveStopMicrousd: calculation.effectiveStopMicrousd, approvalCapMicrousd: calculation.approvalCapMicrousd,
    bindingScopes: calculation.bindingScopes, calculationInput: data.data, sourceRevisions };
}
