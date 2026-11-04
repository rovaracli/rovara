// "How we work" (H2): the project playbook document, read and written the way a project's code settings are (rovara-code/code-settings.ts): one item per org and project, a
// revision the writer must have read, and the audit event in the same transaction as the write. A project with no document has the built-in default.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_PROJECT_PLAYBOOK,
  DesignReviewSettingSchema,
  PLAYBOOK_STALE_MESSAGE,
  PROCESS_UNAVAILABLE_MESSAGE,
  ProjectPlaybookSchema,
  agentKey,
  agentXError,
  canonicalJson,
  designReviewSettingOf,
  projectPlaybookKey,
  type AgentId,
  type DefaultProcess,
  type DesignReviewSetting,
  type EditionPolicy,
  type OrgId,
  type ProjectPlaybook,
} from "@agentx/contracts";
import { auditOccurrence, auditPlaybookDefaultProcessChanged, auditPlaybookDesignReviewChanged } from "../audit/events.js";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING } from "../design-review/effective-setting.js";
import { checkDesignReviewWrite, lockRevisionCheck, readDesignReviewLock } from "../design-review/lock.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";

/** What a refused design review setting says. Field names only; the company's lock values and the project's are never echoed. */
export const DESIGN_REVIEW_LOCKED = "your company has set a stricter rule for design review";
/** A group is refused as the high-risk approver until groups have a member store (ON-12): a group named now would leave every high-risk design with nobody who can approve or skip it. */
export const DESIGN_REVIEW_GROUP_EDITION = "a group can't be the high-risk approver yet; name people instead";
export const DESIGN_REVIEW_LOCK_UNREADABLE = "your company's design review rules can't be read right now, so this can't be saved";
export const DESIGN_REVIEW_NAMED_PEOPLE = "name only project maintainers or members who can approve";
/** Naming people is refused when who may approve cannot be worked out right now (the candidates were not given): fail closed, never "anyone". */
export const DESIGN_REVIEW_NAMED_PEOPLE_UNCHECKED = "who can approve can't be checked right now, so people can't be named";

export interface ProjectPlaybookReader {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

export interface ProjectPlaybookWriter extends ProjectPlaybookReader {
  now: () => number;
  /** The Audit Ledger's outbox; absent on a legacy install, where nothing is audited. */
  audit?: AuditRuntime | undefined;
  /** The install's edition policy: a design review setting may name a group only where the edition has groups. Absent: groups are refused (fail closed). */
  edition?: EditionPolicy | undefined;
  /**
   * Who may be NAMED as the high-risk approver in this project: its maintainers and the members whose role can approve (never an Auditor or a viewer). When present, a setting that names anyone else is
   * refused at the write (L4). Absent: not checked here; the decision still counts only members who are not Auditors or viewers. Wiring pending: the dependency builder passes it.
   */
  namedApproverCandidates?: ((orgId: OrgId, project: string) => Promise<readonly string[]>) | undefined;
}

async function readItem(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<Record<string, unknown> | undefined> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectPlaybookKey(orgId, project), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return found.Item;
}

/**
 * The design review setting an item holds, for a read that cannot read the rest of the item (M2). None stored: none. One that parses: itself. One that is there but does not parse: the strictest posture,
 * never a looser one. Reading the playbook leniently must not drop a strict setting: a later write would carry the defaults over it, with no event, and the project would silently loosen.
 */
function storedDesignReview(item: Record<string, unknown> | undefined): DesignReviewSetting | undefined {
  const stored = item?.["designReview"];
  if (stored === undefined) return undefined;
  const setting = DesignReviewSettingSchema.safeParse(stored);
  return setting.success ? setting.data : { ...DESIGN_REVIEW_FAIL_CLOSED_SETTING };
}

function lenientPlaybook(item: Record<string, unknown> | undefined, revision: number): ProjectPlaybook {
  const designReview = storedDesignReview(item);
  return { revision, defaultProcess: { kind: "builtin" }, ...(designReview === undefined ? {} : { designReview }) };
}

function playbookOf(item: Record<string, unknown> | undefined): ProjectPlaybook | undefined {
  if (item === undefined) return DEFAULT_PROJECT_PLAYBOOK;
  // A document written before the design review stage has no `designReview`: it reads as the owner's defaults (`designReviewSettingOf`), never as an error.
  const parsed = ProjectPlaybookSchema.safeParse({ revision: item["revision"], defaultProcess: item["defaultProcess"] });
  if (!parsed.success) return undefined;
  // A setting that is there but cannot be read does not make the whole process unavailable (the process is unaffected), and it is never read as a LOOSER setting than the project chose: it reads as the
  // strictest posture (always, no skipping) until a maintainer saves it again.
  const designReview = storedDesignReview(item);
  return designReview === undefined ? parsed.data : { ...parsed.data, designReview };
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
  if (options.lenient === true && typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return lenientPlaybook(item, revision);
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
  if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return { playbook: lenientPlaybook(item, revision), exists: true, unreadable: true };
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

/** The facts of `playbook.design_review_changed`: fixed words and counts. The people or the group named as the approver are never in the event. */
export function designReviewAuditFacts(setting: DesignReviewSetting): { mode: DesignReviewSetting["mode"]; tier: DesignReviewSetting["tier"]; allowSkip: boolean; capCents: number; approverKind: DesignReviewSetting["highRiskApprover"]["kind"]; approverCount: number } {
  const approver = setting.highRiskApprover;
  return { mode: setting.mode, tier: setting.tier, allowSkip: setting.allowSkip, capCents: Math.round(setting.capUsdPerTask * 100), approverKind: approver.kind, approverCount: approver.kind === "people" ? approver.memberIds.length : approver.kind === "group" ? 1 : 0 };
}

const conditionFailed = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException"
  || (error.name === "TransactionCanceledException" && ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed")));

/**
 * Sets the project's default process under the revision the caller read (`PLAYBOOK_STALE` for another), bumps the revision, and records `playbook.default_process_changed` in the same
 * transaction. The caller has already checked that a `project_process` is usable (`requireProcessLayer`).
 * `ifLayer` ties the write to a decision made about a process layer: it applies only while that layer is still at the version that was compared (a switch to the built-in compared the
 * layer's published version; one published since makes the write `PLAYBOOK_STALE`, F2). The check is in the same transaction.
 * `guards` are ConditionChecks the caller's model check read (the company model policy and sources revisions, the authority fences): the write applies only while they still hold,
 * else `PLAYBOOK_STALE` (C53).
 */
export async function writeProjectPlaybook(
  deps: ProjectPlaybookWriter, input: { orgId: OrgId; project: string; developerId: string; expectedRevision: number; defaultProcess: DefaultProcess; designReview?: DesignReviewSetting | undefined; ifLayer?: { agentId: AgentId; version: number }; guards?: readonly TransactItem[] },
): Promise<ProjectPlaybook> {
  const { orgId, project } = input;
  const item = await readItem(deps, orgId, project);
  const current = await readProjectPlaybook(deps, orgId, project, { lenient: true });
  if (input.expectedRevision !== current.revision) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  // The design review setting is kept across every write: a change of process (which has no setting in its body) must not drop it. A body that carries one replaces it.
  const designReview = input.designReview ?? current.designReview;
  // A setting this write carries is held to the company's lock HERE, in the writer, and the lock item is read into the same transaction as a condition (M3): a lock set between this read and the commit
  // refuses the write (`PLAYBOOK_STALE`), so a looser value is never stored behind a newer lock. The route's check is the early, friendly one; this is the one that cannot race.
  let lockCheck: ReturnType<typeof lockRevisionCheck>;
  if (input.designReview !== undefined) {
    const lock = await readDesignReviewLock(deps, orgId);
    const check = checkDesignReviewWrite(input.designReview, lock, deps.edition);
    if (!check.ok) {
      if (check.reason === "locked") throw agentXError("CONFIG_INVALID", `${check.fields.join(", ")}: ${DESIGN_REVIEW_LOCKED}`);
      throw agentXError("CONFIG_INVALID", `designReview: ${check.reason === "group_not_available" ? DESIGN_REVIEW_GROUP_EDITION : DESIGN_REVIEW_LOCK_UNREADABLE}`);
    }
    lockCheck = lockRevisionCheck(deps, orgId, lock);
    // Named people must be people who can approve in this project (L4): maintainers and members whose role can approve, never an Auditor or a viewer. Only counted, never echoed.
    const approver = input.designReview.highRiskApprover;
    // Fail closed (L4): with no way to list the candidates, naming people is refused. Ids are compared as the approval rules compare them (NFC, trimmed, case-folded).
    if (approver.kind === "people") {
      if (deps.namedApproverCandidates === undefined) throw agentXError("CONFIG_INVALID", `designReview: ${DESIGN_REVIEW_NAMED_PEOPLE_UNCHECKED}`);
      const fold = (id: string): string => id.normalize("NFC").trim().toLowerCase();
      const allowed = new Set((await deps.namedApproverCandidates(orgId, project)).map(fold));
      if (approver.memberIds.some((id) => !allowed.has(fold(id)))) throw agentXError("CONFIG_INVALID", `designReview: ${DESIGN_REVIEW_NAMED_PEOPLE}`);
    }
  }
  const applied: ProjectPlaybook = { revision: current.revision + 1, defaultProcess: input.defaultProcess, ...(designReview === undefined ? {} : { designReview }) };
  const at = new Date(deps.now()).toISOString();
  const auditDeps: AuditDeps = deps.audit === undefined ? {} : { audit: deps.audit };
  // `playbook.design_review_changed` only when the setting really changed (a missing setting is the owner's defaults, so saving the defaults over nothing is no change).
  const designChanged = canonicalJson(designReviewSettingOf(current)) !== canonicalJson(designReviewSettingOf(applied));
  const events = await tryAuditEvents(auditDeps, () => [
    auditPlaybookDefaultProcessChanged({
      orgId, actor: auditActorOf(input.developerId), occurredAt: at, occurrence: auditOccurrence(project, String(applied.revision)),
      projectName: project, revision: applied.revision, processKind: applied.defaultProcess.kind,
    }),
    ...(!designChanged ? [] : [auditPlaybookDesignReviewChanged({
      orgId, actor: auditActorOf(input.developerId), occurredAt: at, occurrence: auditOccurrence(project, "design_review", String(applied.revision)),
      projectName: project, revision: applied.revision, ...designReviewAuditFacts(designReviewSettingOf(applied)),
    })]),
  ]);
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
      ...(lockCheck === undefined ? [] : [lockCheck]),
      ...(input.ifLayer === undefined ? [] : [{
        ConditionCheck: {
          TableName: deps.tableName, Key: agentKey(orgId, input.ifLayer.agentId, "META"), ConditionExpression: "#currentVersion = :layerVersion",
          ExpressionAttributeNames: { "#currentVersion": "currentVersion" }, ExpressionAttributeValues: { ":layerVersion": input.ifLayer.version },
        },
      }]),
      ...(input.guards ?? []),
      ...events.flatMap((event) => auditPending(auditDeps, event)),
    ] }));
  } catch (error) {
    if (conditionFailed(error)) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
    throw error;
  }
  await flushAuditEvents(auditDeps, events);
  return applied;
}
