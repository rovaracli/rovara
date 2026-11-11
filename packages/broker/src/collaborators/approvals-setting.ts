// Collaborator role (W11, experience decision 36): the project's switch "collaborators may approve low-risk product decisions". On by default; a maintainer of the project (a company owner or admin is a
// maintainer of every project) turns it off or on again, under the revision they read, and every change is audited in the same transaction. Read live by every product decision approve and by the
// project read (`AppProjectDetail.collaboratorApprovals`), so the page and the rule cannot disagree.
//
// One item, in the project's own partition (keyed by the caller's checked org, so another company's project of the same name is never reached):
//   COLLABORATOR_APPROVALS#SETTINGS   enabled, revision (1 and up; none stored = revision 0, the default), who and when, and the last request ids with what each asked and answered (a replay changes nothing).
// A stored item that cannot be read is treated as OFF (fail closed: collaborators are refused, the owner and maintainers still decide) until a maintainer saves it again.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectPk, type OrgId } from "@rovara-code/contracts";
import { COLLABORATOR_APPROVALS_DEFAULT, CollaboratorApprovalsBodySchema, projectAllows, type CollaboratorApprovalsSetting, type ProjectRole } from "@agentx/cloud-contracts";
import { auditOccurrence, auditProjectCollaboratorApprovalsChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent, type AuditRuntime } from "../audit/outbox.js";
import { readProjectMeta } from "../developer/project-roles.js";

export const COLLABORATOR_APPROVALS_SK = "COLLABORATOR_APPROVALS#SETTINGS";
const REQUESTS_KEPT = 20;
const WRITE_ATTEMPTS = 3;

export const COLLABORATOR_APPROVALS_FORBIDDEN = "only a project maintainer can change whether collaborators approve product decisions";
export const COLLABORATOR_APPROVALS_STALE = "this setting was changed by someone else since you loaded it; reload and try again";
export const COLLABORATOR_APPROVALS_REQUEST_REUSED = "that request id was already used for a different change; use a new one";

export interface CollaboratorSettingDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  audit?: AuditRuntime;
}

type Item = Record<string, unknown>;
const key = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: COLLABORATOR_APPROVALS_SK });
const isRevision = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

async function readItem(deps: Pick<CollaboratorSettingDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key(orgId, project), ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** What an item holds: none (the default, on, revision 0), a readable setting, or an unreadable one (off). */
function stateOf(item: Item | undefined): { enabled: boolean; revision: number; isDefault: boolean; readable: boolean } {
  if (item === undefined) return { enabled: COLLABORATOR_APPROVALS_DEFAULT, revision: 0, isDefault: true, readable: true };
  if (typeof item["enabled"] === "boolean" && isRevision(item["revision"])) return { enabled: item["enabled"], revision: item["revision"], isDefault: false, readable: true };
  return { enabled: false, revision: isRevision(item["revision"]) ? item["revision"] : 0, isDefault: false, readable: false };
}

/** The switch now, read fresh. `canChange` is from the reader's live role: a maintainer (company owners and admins included). */
export async function readCollaboratorApprovals(deps: Pick<CollaboratorSettingDeps, "documentClient" | "tableName">, orgId: OrgId, project: string, role: ProjectRole | undefined): Promise<CollaboratorApprovalsSetting> {
  const state = stateOf(await readItem(deps, orgId, project));
  return { enabled: state.enabled, revision: state.revision, isDefault: state.isDefault, canChange: role !== undefined && projectAllows(role, "edit_settings") };
}

/** Just whether collaborators may approve now: what the product decision approve reads. */
export async function collaboratorApprovalsEnabled(deps: Pick<CollaboratorSettingDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<boolean> {
  return stateOf(await readItem(deps, orgId, project)).enabled;
}

interface StoredRequest { id: string; enabled: boolean; expectedRevision: number; answer: { enabled: boolean; revision: number } }
const storedRequests = (item: Item | undefined): StoredRequest[] => (Array.isArray(item?.["requests"]) ? (item["requests"] as unknown[]) : []).flatMap((entry): StoredRequest[] => {
  const e = entry as Partial<StoredRequest> | null;
  return e !== null && typeof e === "object" && typeof e.id === "string" && typeof e.enabled === "boolean" && typeof e.expectedRevision === "number" && typeof e.answer?.enabled === "boolean" && typeof e.answer.revision === "number"
    ? [{ id: e.id, enabled: e.enabled, expectedRevision: e.expectedRevision, answer: { enabled: e.answer.enabled, revision: e.answer.revision } }] : [];
});

/** The Put's condition: exactly the item that was read (none; a readable revision; or an unreadable one with that same shape). */
function conditionOf(item: Item | undefined): { ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
  if (item === undefined) return { ConditionExpression: "attribute_not_exists(pk)" };
  if (isRevision(item["revision"])) return { ConditionExpression: "#revision = :seen", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":seen": item["revision"] } };
  return { ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(#revision) OR NOT attribute_type(#revision, :number))", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":number": "N" } };
}

/**
 * `PUT /v1/app/projects/{name}/collaborator-approvals`, after the route resolved the project for the caller's org (404 otherwise) and their LIVE exact role. Only a maintainer (`edit_settings`) may; an
 * archived project takes no setting change. `expectedRevision` must be the revision the caller read (0 for the default): another is CHANGE_STALE, never a silent overwrite. The same request id again
 * answers what it answered and writes nothing; the same id with another body is CONFIG_INVALID. A save of the value it already has records the request and changes (and audits) nothing.
 */
export async function setCollaboratorApprovals(deps: CollaboratorSettingDeps, input: { orgId: OrgId; project: string; role: ProjectRole | undefined; developerId: string; body: unknown }): Promise<CollaboratorApprovalsSetting> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", COLLABORATOR_APPROVALS_FORBIDDEN);
  const parsed = CollaboratorApprovalsBodySchema.safeParse(input.body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: must be { requestId, enabled, expectedRevision }`);
  const body = parsed.data;
  const view = (answer: { enabled: boolean; revision: number }, isDefault = false): CollaboratorApprovalsSetting => ({ ...answer, isDefault, canChange: true });
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const item = await readItem(deps, input.orgId, input.project);
    const requests = storedRequests(item);
    const earlier = requests.find((request) => request.id === body.requestId);
    if (earlier !== undefined) {
      if (earlier.enabled !== body.enabled || earlier.expectedRevision !== body.expectedRevision) throw agentXError("CONFIG_INVALID", COLLABORATOR_APPROVALS_REQUEST_REUSED);
      return view(earlier.answer);
    }
    if ((await readProjectMeta(deps, input.orgId, input.project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", `\`${input.project}\` is archived; restore it to change its settings`);
    const current = stateOf(item);
    if (body.expectedRevision !== current.revision) throw agentXError("CHANGE_STALE", COLLABORATOR_APPROVALS_STALE);
    const changed = !current.readable || current.isDefault ? true : current.enabled !== body.enabled;
    const revision = changed ? current.revision + 1 : current.revision;
    const answer = { enabled: body.enabled, revision };
    const at = new Date(deps.now()).toISOString();
    const event = !changed ? undefined : await tryAuditEvent(deps, () => auditProjectCollaboratorApprovalsChanged({
      orgId: input.orgId, actor: { kind: "member", id: input.developerId }, occurredAt: at, occurrence: auditOccurrence(input.project, "collaborator_approvals", body.requestId),
      projectName: input.project, enabled: body.enabled, revision,
    }));
    const kept = [...requests, { id: body.requestId, enabled: body.enabled, expectedRevision: body.expectedRevision, answer }].slice(-REQUESTS_KEPT);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: deps.tableName, Item: { ...key(input.orgId, input.project), entityType: "COLLABORATOR_APPROVALS_SETTING", orgId: input.orgId, project: input.project, enabled: body.enabled, revision: Math.max(revision, 1), changedBy: input.developerId, changedAt: at, requests: kept }, ...conditionOf(item) } },
        ...(event === undefined ? [] : auditPending(deps, event)),
      ] }));
    } catch (error) {
      // Another write landed between the read and this one: read again (a replay of this id, or a stale revision, is then answered above).
      if (error instanceof Error && error.name === "TransactionCanceledException") continue;
      throw error;
    }
    if (event !== undefined) await flushAuditEvents(deps, [event]);
    return view({ enabled: body.enabled, revision: Math.max(revision, 1) });
  }
  throw agentXError("CHANGE_STALE", COLLABORATOR_APPROVALS_STALE);
}
