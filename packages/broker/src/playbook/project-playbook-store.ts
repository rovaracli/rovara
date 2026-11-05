// "How we work" (H2): the project playbook document, read and written the way a project's code settings are (rovara-code/code-settings.ts): one item per org and project, a
// revision the writer must have read, and the audit event in the same transaction as the write. A project with no document has the built-in default.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_PROJECT_PLAYBOOK,
  DESIGN_REVIEW_MODES,
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
import { checkDesignReviewWrite, lockRevisionCheck, readDesignReviewLock } from "../design-review/lock.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";

/** What a refused design review setting says. Field names only; the company's lock values and the project's are never echoed. */
export const DESIGN_REVIEW_LOCKED = "your company has set a stricter rule for design review";
/** A group is refused as the high-risk approver until groups have a member store (ON-12): a group named now would leave every high-risk design with nobody who can approve or skip it. */
export const DESIGN_REVIEW_GROUP_EDITION = "a group can't be the high-risk approver yet; name people instead";
export const DESIGN_REVIEW_LOCK_UNREADABLE = "your company's design review rules can't be read right now, so this can't be saved";
/** What a design review setting that fails the strict schema says (the field is named before it; the value never is). */
export const DESIGN_REVIEW_INVALID = "is not a valid design review setting";
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

/** Why a stored project design review setting could not be read: fixed words, never the value. */
export const DESIGN_REVIEW_UNREADABLE_REASONS = ["wrong_type", "unknown_mode", "invalid_shape"] as const;
export type DesignReviewUnreadableReason = (typeof DESIGN_REVIEW_UNREADABLE_REASONS)[number];
/** What the item holds for the project's design review setting: nothing, a setting that parses, or something that is there and does not (never the same as nothing). */
export type StoredDesignReview = { kind: "missing" } | { kind: "ok"; setting: DesignReviewSetting } | { kind: "unreadable"; reason: DesignReviewUnreadableReason };

const isPlainMap = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Classifies a stored value that did not parse, by shape only (a fixed word; the value is never kept). */
function unreadableReasonOf(stored: unknown): DesignReviewUnreadableReason {
  if (!isPlainMap(stored)) return "wrong_type";
  const mode = stored["mode"];
  if (mode !== undefined && typeof mode !== "string") return "wrong_type";
  if (typeof mode === "string" && !(DESIGN_REVIEW_MODES as readonly string[]).includes(mode)) return "unknown_mode";
  return "invalid_shape";
}

/** Reads the `designReview` attribute with the one strict schema every writer uses. */
export function readStoredDesignReview(stored: unknown): StoredDesignReview {
  if (stored === undefined) return { kind: "missing" };
  const setting = DesignReviewSettingSchema.safeParse(stored);
  return setting.success ? { kind: "ok", setting: setting.data } : { kind: "unreadable", reason: unreadableReasonOf(stored) };
}

/**
 * The design review setting an item holds, for every read (DR-FU4 L4, owner decision 2026-11-05: "in worst case scenarios default should be off"). None stored: none, which is Off. One that parses: itself. One that
 * is there but does not parse (wrong type, unknown mode, not a map, missing or extra fields): ALSO Off, never Always or Auto, with `designReviewUnreadable` so the page can say so and the log says so once. It is
 * never turned into a looser setting than the project could have chosen, and a maintainer choosing again replaces it (writeProjectPlaybook). The log line carries a fixed reason and the org and project, nothing else.
 */
function storedDesignReview(item: Record<string, unknown> | undefined, orgId: OrgId, project: string): { designReview?: DesignReviewSetting; designReviewUnreadable: boolean } {
  const read = readStoredDesignReview(item?.["designReview"]);
  if (read.kind === "ok") return { designReview: read.setting, designReviewUnreadable: false };
  if (read.kind === "unreadable") {
    console.log(JSON.stringify({ component: "broker", event: "design_review.project_setting_unreadable", orgId, project, reason: read.reason }));
    return { designReviewUnreadable: true };
  }
  return { designReviewUnreadable: false };
}

/** A playbook with what its design review setting read as: `designReviewUnreadable` is true only for a stored value that could not be read (which reads as no setting, so Off). */
export interface ProjectPlaybookDetail { playbook: ProjectPlaybook; designReviewUnreadable: boolean }

function lenientPlaybook(item: Record<string, unknown> | undefined, revision: number, orgId: OrgId, project: string): ProjectPlaybookDetail {
  const { designReview, designReviewUnreadable } = storedDesignReview(item, orgId, project);
  return { playbook: { revision, defaultProcess: { kind: "builtin" }, ...(designReview === undefined ? {} : { designReview }) }, designReviewUnreadable };
}

function playbookOf(item: Record<string, unknown> | undefined, orgId: OrgId, project: string): ProjectPlaybookDetail | undefined {
  if (item === undefined) return { playbook: DEFAULT_PROJECT_PLAYBOOK, designReviewUnreadable: false };
  // A document written before the design review stage has no `designReview`: it reads as the owner's defaults (`designReviewSettingOf`), never as an error.
  const parsed = ProjectPlaybookSchema.safeParse({ revision: item["revision"], defaultProcess: item["defaultProcess"] });
  if (!parsed.success) return undefined;
  // A setting that is there but cannot be read does not make the whole process unavailable (the process is unaffected), and it reads as Off, never as anything looser, until a maintainer saves it again.
  const { designReview, designReviewUnreadable } = storedDesignReview(item, orgId, project);
  return { playbook: designReview === undefined ? parsed.data : { ...parsed.data, designReview }, designReviewUnreadable };
}

/** The playbook an item holds (see `readProjectPlaybook` for `lenient`). Pure over the item, so a writer can decide from the very item it pins. */
function detailOfItem(item: Record<string, unknown> | undefined, orgId: OrgId, project: string, options: { lenient?: boolean }): ProjectPlaybookDetail {
  const found = playbookOf(item, orgId, project);
  if (found !== undefined) return found;
  const revision = item?.["revision"];
  if (options.lenient === true && typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return lenientPlaybook(item, revision, orgId, project);
  throw agentXError("PROCESS_UNAVAILABLE", PROCESS_UNAVAILABLE_MESSAGE);
}

/**
 * The project's playbook, read fresh. A project with no document has the built-in default. A document that is there but cannot be read is `PROCESS_UNAVAILABLE`, never the built-in:
 * the project chose something, and running something else would be a silent switch. (`lenient` is for the settings page and the PUT, which must still be able to show and replace it:
 * the built-in is shown at the revision the item holds.)
 */
export async function readProjectPlaybook(deps: ProjectPlaybookReader, orgId: OrgId, project: string, options: { lenient?: boolean } = {}): Promise<ProjectPlaybook> {
  return (await readProjectPlaybookDetail(deps, orgId, project, options)).playbook;
}

/** The same read, with whether the stored design review setting could not be read (it then reads as Off). The effective-setting readers and the playbook GET use this. */
export async function readProjectPlaybookDetail(deps: ProjectPlaybookReader, orgId: OrgId, project: string, options: { lenient?: boolean } = {}): Promise<ProjectPlaybookDetail> {
  return detailOfItem(await readItem(deps, orgId, project), orgId, project, options);
}

/**
 * The same read as `lenient`, with what the document is: `exists` (an item is there) and `unreadable` (it is there but is not a playbook). A switch to the built-in and an archive of a
 * process layer must not take an unreadable document for the built-in: the project chose something and we can't tell what (F2). A missing document is the built-in, as ever.
 */
export async function readProjectPlaybookState(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<{ playbook: ProjectPlaybook; exists: boolean; unreadable: boolean }> {
  const item = await readItem(deps, orgId, project);
  const parsed = playbookOf(item, orgId, project);
  if (parsed !== undefined) return { playbook: parsed.playbook, exists: item !== undefined, unreadable: false };
  const revision = item?.["revision"];
  if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return { playbook: lenientPlaybook(item, revision, orgId, project).playbook, exists: true, unreadable: true };
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

/**
 * The condition on the playbook Put. A Put's condition is checked against the item that is stored NOW, never against the new one, so it cannot validate the new value (the strict schema does that, above, before any write).
 * What it can do, and does: tie the write to what this writer READ. The revision (every writer bumps it) refuses a write on a stale revision; the stored `designReview` is pinned too, exactly as read, so a raw write that
 * changed the setting without bumping the revision, or between our read and our commit, makes this write `PLAYBOOK_STALE` instead of being silently replaced (checklist 4: conditions on what you read).
 * It pins the VALUE READ, whatever it is, and never "a valid value": an item whose setting is corrupt is pinned as that same corrupt value, so a maintainer choosing again replaces it (a condition that demanded a valid
 * stored mode would lock the item forever). No item yet: it must still not exist.
 */
function conditionOf(item: Record<string, unknown> | undefined, revision: number): { ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
  if (item === undefined) return { ConditionExpression: "attribute_not_exists(pk)" };
  const stored = item["designReview"];
  return stored === undefined
    ? { ConditionExpression: "#revision = :expected AND attribute_not_exists(#designReview)", ExpressionAttributeNames: { "#revision": "revision", "#designReview": "designReview" }, ExpressionAttributeValues: { ":expected": revision } }
    : { ConditionExpression: "#revision = :expected AND #designReview = :storedDesignReview", ExpressionAttributeNames: { "#revision": "revision", "#designReview": "designReview" }, ExpressionAttributeValues: { ":expected": revision, ":storedDesignReview": stored } };
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
  deps: ProjectPlaybookWriter, input: { orgId: OrgId; project: string; developerId: string; expectedRevision: number; defaultProcess: DefaultProcess; designReview?: DesignReviewSetting | undefined; ifLayer?: { agentId: AgentId; version: number }; guards?: readonly TransactItem[]; /** The one-time `dp` move writes a setting, not a process change: it records only the design review event. */ skipProcessEvent?: true },
): Promise<ProjectPlaybook> {
  const { orgId, project } = input;
  // ONE read: what the writer decides from (the playbook, the setting) and what it pins in the condition below are the same item, so nothing can change between the two.
  const item = await readItem(deps, orgId, project);
  const current = detailOfItem(item, orgId, project, { lenient: true }).playbook;
  if (input.expectedRevision !== current.revision) throw agentXError("PLAYBOOK_STALE", PLAYBOOK_STALE_MESSAGE);
  // Every setting this write carries is checked with the same strict schema the readers use, before anything else: a value that would read back as unreadable is never stored. Only field names are said, never values.
  let carried: DesignReviewSetting | undefined;
  if (input.designReview !== undefined) {
    const valid = DesignReviewSettingSchema.safeParse(input.designReview);
    if (!valid.success) throw agentXError("CONFIG_INVALID", `designReview${valid.error.issues[0] === undefined || valid.error.issues[0].path.length === 0 ? "" : "." + valid.error.issues[0].path.join(".")}: ${DESIGN_REVIEW_INVALID}`);
    carried = valid.data;
  }
  // The design review setting is kept across every write: a change of process (which has no setting in its body) must not drop it. A body that carries one replaces it. (A stored value that could not be read reads as
  // no setting, so a write that carries none leaves the item without one: it keeps reading as Off, and nothing unreadable is written back.)
  const designReview = carried ?? current.designReview;
  // A setting this write carries is held to the company's lock HERE, in the writer, and the lock item is read into the same transaction as a condition (M3): a lock set between this read and the commit
  // refuses the write (`PLAYBOOK_STALE`), so a looser value is never stored behind a newer lock. The route's check is the early, friendly one; this is the one that cannot race.
  let lockCheck: ReturnType<typeof lockRevisionCheck>;
  if (carried !== undefined) {
    const lock = await readDesignReviewLock(deps, orgId);
    const check = checkDesignReviewWrite(carried, lock, deps.edition);
    if (!check.ok) {
      if (check.reason === "locked") throw agentXError("CONFIG_INVALID", `${check.fields.join(", ")}: ${DESIGN_REVIEW_LOCKED}`);
      throw agentXError("CONFIG_INVALID", `designReview: ${check.reason === "group_not_available" ? DESIGN_REVIEW_GROUP_EDITION : DESIGN_REVIEW_LOCK_UNREADABLE}`);
    }
    lockCheck = lockRevisionCheck(deps, orgId, lock);
    // Named people must be people who can approve in this project (L4): maintainers and members whose role can approve, never an Auditor or a viewer. Only counted, never echoed.
    const approver = carried.highRiskApprover;
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
  // `playbook.design_review_changed` only when the setting really changed. A project with no setting is Off (DR-FU4), so saving any setting over none is a change (the mode it will run with is now its own).
  const designChanged = canonicalJson(current.designReview ?? null) !== canonicalJson(applied.designReview ?? null);
  const events = await tryAuditEvents(auditDeps, () => [
    ...(input.skipProcessEvent === true ? [] : [auditPlaybookDefaultProcessChanged({
      orgId, actor: auditActorOf(input.developerId), occurredAt: at, occurrence: auditOccurrence(project, String(applied.revision)),
      projectName: project, revision: applied.revision, processKind: applied.defaultProcess.kind,
    })]),
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
          ...conditionOf(item, current.revision),
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
