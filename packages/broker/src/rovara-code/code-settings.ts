// Rovara Code (Plan 6 Tasks 14 and 19): a project's code settings (self-approval, the merge method, the reviewers Rovara asks). A project with none has the defaults (self-approval off,
// squash, no reviewers); an item that does not parse is read as the defaults too, which is the cautious reading of every setting.
//
// `GET /v1/app/projects/{p}/code-settings` is for anyone who can see the project. `PUT` needs `edit_settings` (a maintainer) and the revision the caller read. Everything applies at once
// except turning self-approval ON, which answers `202 NEEDS_CONFIRMATION`: an organization owner or admin decides it on the confirmation page (R66), never the maintainer who asked
// unless they are an admin themselves. The other settings in the same request still apply at once, and the change is bound to the revision they leave.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { CHANGES_FEED_DAYS, CODE_SETTINGS_STALE_MESSAGE, CodeSettingsBodySchema, CodeSettingsSchema, DEFAULT_CODE_SETTINGS, INDEX_EXPIRY_ATTRIBUTE, agentXError, changesKey, codeSettingsKey, projectAllows, type CodeSettings, type CodeSettingsBody, type CodeSettingsResponse, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import { confirmationReply } from "../agent-sessions/shares.js";
import { createPendingChange, registerApprovalSubjectHandler, type ApprovalDependencies } from "../agents/approvals.js";
import type { AnyApprovalRecord } from "../agents/approvals-store.js";
import { orgAdminApprovers } from "../agents/changes.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import { auditCodeSettingsChanged, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";

export interface CodeSettingsReader {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

export interface CodeSettingsDependencies extends CodeSettingsReader {
  now: () => number;
  /** The caller's role in the project: the project's name, or the one `PROJECT_NOT_FOUND` for no access, no such project and another org's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
}

async function readItem(deps: CodeSettingsReader, orgId: OrgId, project: string): Promise<Record<string, unknown> | undefined> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: codeSettingsKey(orgId, project), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return found.Item;
}

function settingsOf(item: Record<string, unknown> | undefined): CodeSettings {
  if (item === undefined) return DEFAULT_CODE_SETTINGS;
  const parsed = CodeSettingsSchema.safeParse({
    allowSelfApproval: item["allowSelfApproval"], mergeMethod: item["mergeMethod"], codeReviewers: item["codeReviewers"], revision: item["revision"],
  });
  return parsed.success ? parsed.data : DEFAULT_CODE_SETTINGS;
}

/** The project's code settings, read fresh (never cached: a changed setting applies to the next decision). */
export async function readCodeSettings(deps: CodeSettingsReader, orgId: OrgId, project: string): Promise<CodeSettings> {
  return settingsOf(await readItem(deps, orgId, project));
}

/** `GET /v1/app/projects/{p}/code-settings`: to anyone who can see the project. */
export async function getCodeSettings(deps: CodeSettingsDependencies, caller: DeveloperCaller, rawProject: string): Promise<CodeSettingsResponse> {
  const { name } = await deps.projectFor(caller, rawProject);
  return { settings: await readCodeSettings(deps, caller.orgId, name) };
}

const MAINTAINERS_ONLY = "only a project maintainer can change its code settings";
const SELF_APPROVAL_UNAVAILABLE = "Turning self-approval on isn't available right now.";
const SELF_APPROVAL_TEXT = (project: string): string => `Let a person approve a pull request that Rovara made for them, in project ${project}`;

function parseBody(raw: unknown): CodeSettingsBody {
  const parsed = CodeSettingsBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
    throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  if (parsed.data.allowSelfApproval === undefined && parsed.data.mergeMethod === undefined && parsed.data.codeReviewers === undefined) {
    throw agentXError("CONFIG_INVALID", "body: name at least one setting to change");
  }
  return parsed.data;
}

/** What the request asks for, without its id and revision: the same request again has the same digest, another request with the same id does not. */
const digestOf = (body: CodeSettingsBody): string => {
  const { requestId: _requestId, expectedRevision: _expectedRevision, ...rest } = body; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
  return createHash("sha256").update(JSON.stringify([rest.allowSelfApproval ?? null, rest.mergeMethod ?? null, rest.codeReviewers ?? null]), "utf8").digest("hex");
};

/** The fixed names of what differs between two settings, in a fixed order. */
function changedNames(before: CodeSettings, after: CodeSettings): string {
  return [
    ...(before.allowSelfApproval === after.allowSelfApproval ? [] : ["selfApproval"]),
    ...(before.mergeMethod === after.mergeMethod ? [] : ["mergeMethod"]),
    ...(sameList(before.codeReviewers, after.codeReviewers) ? [] : ["codeReviewers"]),
  ].join(",");
}

const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * `PUT /v1/app/projects/{p}/code-settings`. A maintainer changes the merge method, the reviewers and self-approval OFF at once, under the revision they read (a stale one is
 * `CONFIG_INVALID`, `CODE_SETTINGS_STALE_MESSAGE`). Self-approval ON answers `202 NEEDS_CONFIRMATION` with the link where an organization owner or admin decides it. A repeat of the
 * same request answers the same outcome and changes nothing twice.
 */
export async function putCodeSettings(
  deps: CodeSettingsDependencies, caller: DeveloperCaller, rawProject: string, rawBody: unknown, approvals: ApprovalDependencies | undefined,
): Promise<StatusReply> {
  const found = await deps.projectFor(caller, rawProject);
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", MAINTAINERS_ONLY);
  const body = parseBody(rawBody);
  const project = found.name;
  const item = await readItem(deps, caller.orgId, project);
  const current = settingsOf(item);
  const digest = digestOf(body);

  const replay = item?.["lastRequestId"] === body.requestId;
  if (replay && item?.["lastRequestDigest"] !== digest) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  if (!replay && body.expectedRevision !== current.revision) throw agentXError("CONFIG_INVALID", CODE_SETTINGS_STALE_MESSAGE);

  const wantsOn = body.allowSelfApproval === true && !current.allowSelfApproval;
  if (wantsOn && (approvals === undefined)) throw agentXError("RUNTIME_UNAVAILABLE", SELF_APPROVAL_UNAVAILABLE);
  const next: CodeSettings = {
    allowSelfApproval: body.allowSelfApproval === false ? false : current.allowSelfApproval,
    mergeMethod: body.mergeMethod ?? current.mergeMethod,
    codeReviewers: body.codeReviewers ?? current.codeReviewers,
    revision: current.revision,
  };
  const changes = !replay && (next.allowSelfApproval !== current.allowSelfApproval || next.mergeMethod !== current.mergeMethod || !sameList(next.codeReviewers, current.codeReviewers));
  let applied = current;
  if (changes) {
    applied = { ...next, revision: current.revision + 1 };
    const events = await tryAuditEvents(approvals ?? {}, () => [auditCodeSettingsChanged({
      orgId: caller.orgId, actor: auditActorOf(caller.developerId), occurredAt: new Date(deps.now()).toISOString(), occurrence: auditOccurrence(project, String(applied.revision)),
      projectName: project, revision: applied.revision, changed: changedNames(current, applied), selfApproval: applied.allowSelfApproval, mergeMethod: applied.mergeMethod, reviewers: applied.codeReviewers.length,
    })]);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        {
          Put: {
            TableName: deps.tableName,
            Item: {
              ...codeSettingsKey(caller.orgId, project), entityType: "CODE_SETTINGS", orgId: caller.orgId, ...applied, lastRequestId: body.requestId, lastRequestDigest: digest,
              updatedAt: new Date(deps.now()).toISOString(), updatedBy: caller.developerId,
            },
            ConditionExpression: current.revision === 0 && item === undefined ? "attribute_not_exists(pk)" : "#revision = :expected",
            ...(current.revision === 0 && item === undefined ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": current.revision } }),
          },
        },
        ...(approvals === undefined ? [] : events.flatMap((event) => auditPending(approvals as AuditDeps, event))),
      ] }));
      if (approvals !== undefined) await flushAuditEvents(approvals, events);
    } catch (error) {
      if (error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")) throw agentXError("CONFIG_INVALID", CODE_SETTINGS_STALE_MESSAGE);
      throw error;
    }
  }
  if (!wantsOn) return new StatusReply(200, { settings: applied } satisfies CodeSettingsResponse);

  // Self-approval ON waits for an organization owner or admin; the change is bound to the revision the other settings of this request left.
  const record = await createPendingChange(approvals!, {
    orgId: caller.orgId, requestId: body.requestId, requestedBy: caller.developerId,
    subject: { kind: "code_settings", project, settingsRevision: applied.revision, changes: { allowSelfApproval: true } },
    changes: [SELF_APPROVAL_TEXT(project)],
    approvers: await orgAdminApprovers(approvals!, caller.orgId),
  });
  // A replay of a request that was decided since is not waiting any more.
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  const reply = await confirmationReply(approvals!, caller, record);
  return new StatusReply(reply.status, reply.body);
}

// ---- what confirming it does

/** The most maintainers one confirmation tells (a transaction holds 100 items). */
const NOTICES_MAX = 80;
const noticeNumber = (seed: string): number => Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 1_000_000;

const isChange = (record: AnyApprovalRecord): record is Extract<AnyApprovalRecord, { kind: "change" }> => record.kind === "change";

/** Registers what confirming a `code_settings` change does. The approver rule is the `org_admin` rule (changes.ts), read when the decision is made. Safe to call more than once. */
export function registerCodeSettingsApprovals(): void {
  registerApprovalSubjectHandler("code_settings", async (deps, record, decision) => {
    if (!isChange(record) || record.subject.kind !== "code_settings") return;
    // A record nobody has decided is never applied: self-approval would be credited to a request, not to an administrator.
    if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
    const subject = record.subject;
    const item = await readItem(deps, record.orgId, subject.project);
    const current = settingsOf(item);
    if (current.revision !== subject.settingsRevision) throw agentXError("CONFIG_INVALID", CODE_SETTINGS_STALE_MESSAGE);
    if (current.allowSelfApproval) return;
    const applied: CodeSettings = { ...current, allowSelfApproval: true, revision: current.revision + 1 };
    const at = new Date(deps.now()).toISOString();
    const events = await tryAuditEvents(deps, () => [auditCodeSettingsChanged({
      orgId: record.orgId, actor: auditActorOf(record.decidedBy!), occurredAt: at, occurrence: auditOccurrence(subject.project, String(applied.revision)), related: [record.approvalId],
      ...(decision?.proof === undefined ? {} : { proof: decision.proof }),
      projectName: subject.project, revision: applied.revision, changed: changedNames(current, applied), selfApproval: true, mergeMethod: applied.mergeMethod, reviewers: applied.codeReviewers.length,
    })]);
    // The project's other maintainers are told once it applies (not the administrator who decided it): a notice of ids and a revision, kept in each one's feed.
    const told = [...new Set([
      ...(await deps.projectMembers.list(record.orgId, subject.project)).filter((member) => projectAllows(member.role, "edit_settings")).map((member) => member.developerId),
      record.requestedBy,
    ])].filter((developerId) => developerId !== record.decidedBy).sort().slice(0, NOTICES_MAX);
    const expires = Math.floor(deps.now() / 1000) + CHANGES_FEED_DAYS * 86_400;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        {
          Put: {
            TableName: deps.tableName,
            Item: {
              ...codeSettingsKey(record.orgId, subject.project), entityType: "CODE_SETTINGS", orgId: record.orgId, ...applied,
              updatedAt: at, updatedBy: record.decidedBy, selfApprovalConfirmedBy: record.decidedBy,
            },
            ConditionExpression: item === undefined ? "attribute_not_exists(pk)" : "#revision = :expected",
            ...(item === undefined ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": current.revision } }),
          },
        },
        ...events.flatMap((event) => auditPending(deps, event)),
        ...told.map((developerId) => ({ Put: { TableName: deps.tableName, Item: {
          ...changesKey(record.orgId, developerId, at, noticeNumber(`${record.approvalId}|${developerId}`)), entityType: "CHANGE_NOTICE", orgId: record.orgId, type: "code_settings.changed",
          project: subject.project, revision: applied.revision, by: record.decidedBy, at, [INDEX_EXPIRY_ATTRIBUTE]: expires,
        } } })),
      ] }));
    } catch (error) {
      if (error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")) throw agentXError("CONFIG_INVALID", CODE_SETTINGS_STALE_MESSAGE);
      throw error;
    }
    await flushAuditEvents(deps, events);
  });
}
