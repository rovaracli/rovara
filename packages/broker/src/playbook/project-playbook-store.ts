// "How we work" (H2): the project playbook document, read and written the way a project's code settings are (rovara-code/code-settings.ts): one item per org and project, a
// revision the writer must have read, and the audit event in the same transaction as the write. A project with no document has the built-in default.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_PROJECT_PLAYBOOK,
  PLAYBOOK_STALE_MESSAGE,
  PROCESS_UNAVAILABLE_MESSAGE,
  ProjectPlaybookSchema,
  agentKey,
  agentXError,
  projectPlaybookKey,
  type AgentId,
  type DefaultProcess,
  type OrgId,
  type ProjectPlaybook,
} from "@agentx/contracts";
import { auditOccurrence, auditPlaybookDefaultProcessChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps, type AuditRuntime } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";

export interface ProjectPlaybookReader {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

export interface ProjectPlaybookWriter extends ProjectPlaybookReader {
  now: () => number;
  /** The Audit Ledger's outbox; absent on a legacy install, where nothing is audited. */
  audit?: AuditRuntime | undefined;
}

async function readItem(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<Record<string, unknown> | undefined> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectPlaybookKey(orgId, project), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return found.Item;
}

function playbookOf(item: Record<string, unknown> | undefined): ProjectPlaybook | undefined {
  if (item === undefined) return DEFAULT_PROJECT_PLAYBOOK;
  const parsed = ProjectPlaybookSchema.safeParse({ revision: item["revision"], defaultProcess: item["defaultProcess"] });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The project's playbook, read fresh. A project with no document has the built-in default. A document that is there but cannot be read is `PROCESS_UNAVAILABLE`, never the built-in:
 * the project chose something, and running something else would be a silent switch. (`lenient` is for the settings page and the PUT, which must still be able to show and replace it:
 * the built-in is shown at the revision the item holds.)
 */
export async function readProjectPlaybook(deps: ProjectPlaybookReader, orgId: OrgId, project: string, options: { lenient?: boolean } = {}): Promise<ProjectPlaybook> {
  const item = await readItem(deps, orgId, project);
  const playbook = playbookOf(item);
  if (playbook !== undefined) return playbook;
  const revision = item?.["revision"];
  if (options.lenient === true && typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return { revision, defaultProcess: { kind: "builtin" } };
  throw agentXError("PROCESS_UNAVAILABLE", PROCESS_UNAVAILABLE_MESSAGE);
}

/**
 * The same read as `lenient`, with what the document is: `exists` (an item is there) and `unreadable` (it is there but is not a playbook). A switch to the built-in and an archive of a
 * process layer must not take an unreadable document for the built-in: the project chose something and we can't tell what (F2). A missing document is the built-in, as ever.
 */
export async function readProjectPlaybookState(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<{ playbook: ProjectPlaybook; exists: boolean; unreadable: boolean }> {
  const item = await readItem(deps, orgId, project);
  const parsed = playbookOf(item);
  if (parsed !== undefined) return { playbook: parsed, exists: item !== undefined, unreadable: false };
  const revision = item?.["revision"];
  if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return { playbook: { revision, defaultProcess: { kind: "builtin" } }, exists: true, unreadable: true };
  throw agentXError("PROCESS_UNAVAILABLE", PROCESS_UNAVAILABLE_MESSAGE);
}

/**
 * When the playbook document was last written: `exists: false` for a project with no document. The first-version repair (process-layer.ts) uses it to tell a lost write from a
 * maintainer's choice made since.
 */
export async function readProjectPlaybookWrittenAt(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<{ exists: false } | { exists: true; updatedAt: string | undefined }> {
  const item = await readItem(deps, orgId, project);
  if (item === undefined) return { exists: false };
  const updatedAt = item["updatedAt"];
  return { exists: true, updatedAt: typeof updatedAt === "string" ? updatedAt : undefined };
}

const conditionFailed = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException"
  || (error.name === "TransactionCanceledException" && ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")));

/**
 * Sets the project's default process under the revision the caller read (`PLAYBOOK_STALE` for another), bumps the revision, and records `playbook.default_process_changed` in the same
 * transaction. The caller has already checked that a `project_process` is usable (`requireProcessLayer`).
 * `ifLayer` ties the write to a decision made about a process layer: it applies only while that layer is still at the version that was compared (a switch to the built-in compared the
 * layer's published version; one published since makes the write `PLAYBOOK_STALE`, F2). The check is in the same transaction.
 */
export async function writeProjectPlaybook(
  deps: ProjectPlaybookWriter, input: { orgId: OrgId; project: string; developerId: string; expectedRevision: number; defaultProcess: DefaultProcess; ifLayer?: { agentId: AgentId; version: number } },
): Promise<ProjectPlaybook> {
  const { orgId, project } = input;
  const item = await readItem(deps, orgId, project);
  const current = await readProjectPlaybook(deps, orgId, project, { lenient: true });
  if (input.expectedRevision !== current.revision) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  const applied: ProjectPlaybook = { revision: current.revision + 1, defaultProcess: input.defaultProcess };
  const at = new Date(deps.now()).toISOString();
  const auditDeps: AuditDeps = deps.audit === undefined ? {} : { audit: deps.audit };
  const events = await tryAuditEvents(auditDeps, () => [auditPlaybookDefaultProcessChanged({
    orgId, actor: auditActorOf(input.developerId), occurredAt: at, occurrence: auditOccurrence(project, String(applied.revision)),
    projectName: project, revision: applied.revision, processKind: applied.defaultProcess.kind,
  })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      {
        Put: {
          TableName: deps.tableName,
          Item: { ...projectPlaybookKey(orgId, project), entityType: "PROJECT_PLAYBOOK", orgId, ...applied, updatedAt: at, updatedBy: input.developerId },
          ConditionExpression: item === undefined ? "attribute_not_exists(pk)" : "#revision = :expected",
          ...(item === undefined ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": current.revision } }),
        },
      },
      ...(input.ifLayer === undefined ? [] : [{
        ConditionCheck: {
          TableName: deps.tableName, Key: agentKey(orgId, input.ifLayer.agentId, "META"), ConditionExpression: "#currentVersion = :layerVersion",
          ExpressionAttributeNames: { "#currentVersion": "currentVersion" }, ExpressionAttributeValues: { ":layerVersion": input.ifLayer.version },
        },
      }]),
      ...events.flatMap((event) => auditPending(auditDeps, event)),
    ] }));
  } catch (error) {
    if (conditionFailed(error)) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
    throw error;
  }
  await flushAuditEvents(auditDeps, events);
  return applied;
}
