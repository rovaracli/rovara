// Plan 3 Task 14b (R3-1, R66): the org's opt-outs of the repository-level comment rule. A repository whose workflows act on comments, issues or
// labels makes every agent comment there need a person (comment-trigger-scan.ts). An org owner or admin who has read those workflows can opt a
// repository out of that one rule, for one project. The opt-out is a pending record that an org admin confirms on the confirmation page; it stores the
// digest of the files that were reviewed, and it lapses by itself, in the run that finds a different digest. Text, slash-command, label and
// `extraCommandWords` checks still apply after an opt-out.
//
// Everything here reads live (an opt-out, the role of whoever decides, the project's repositories): nothing is trusted from an earlier request.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXNameSchema, COMMENT_TRIGGER_STALE_TEXT, CommentTriggerOptOutRequestSchema, CommentTriggerRepositorySchema, COMMENT_TRIGGER_UNREADABLE_TEXT, INDEX_EXPIRY_ATTRIBUTE, StoredCommentTriggerOptOutSchema, agentXError, commentTriggerEventKey, commentTriggerEventsPk, commentTriggerLapseNotice, commentTriggerOptOutKey, commentTriggerOptOutRepositoryPrefix, commentTriggerOptOutsPk, projectAllows, type CommentTriggerOptOut, type OrgId, type StoredCommentTriggerOptOut } from "@rovara-code/contracts";
import { flushAuditEvents } from "../audit/flush.js";
import { auditOccurrence, auditOptOutApplied, auditOptOutLapsed } from "../audit/events.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { confirmUrlFor, createPendingChange, registerApprovalSubjectHandler, type ApprovalDependencies, type ApprovalRecord, type OptOutChangeSubject } from "./approvals.js";
import { orgAdminApprovers } from "./changes.js";
import { repoCommandTriggers, type RepoCommandTriggers } from "./comment-trigger-scan.js";
import { cacheNameOf, type RunCache } from "./run-cache.js";
import { strip, type Item, type TransactItem } from "./table-writes.js";
import type { AgentCaller } from "./access.js";

/** What reading or writing an opt-out needs: the State table, the clock and, on an install with a ledger, the audit outbox. */
export type OptOutDependencies = Pick<ApprovalDependencies, "documentClient" | "tableName" | "now" | "audit">;

const EVENT_MEMORY_DAYS = 365;
const NOTICE_DAYS = 30;
const MAX_CHANGED_FILES = 50;
const MAX_NOTICES = 100;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const iso = (deps: Pick<OptOutDependencies, "now">): string => new Date(deps.now()).toISOString();
const expiry = (deps: Pick<OptOutDependencies, "now">, days: number): number => Math.floor(deps.now() / 1000) + days * 86_400;

// ---- reading

function parseStored(deps: OptOutDependencies, orgId: OrgId, item: Item): StoredCommentTriggerOptOut | undefined {
  // The partition is the org's; an item that names another org is still not handed on.
  const parsed = StoredCommentTriggerOptOutSchema.safeParse(strip(item));
  if (!parsed.success || parsed.data.orgId !== orgId) {
    console.error(JSON.stringify({ component: "broker", level: "error", event: "comment_trigger_opt_out_invalid", orgId, problem: parsed.success ? "org" : parsed.error.issues[0]?.path.join(".") ?? "record" }));
    return undefined;
  }
  return parsed.data;
}

/** The project's opt-out for the repository, or undefined. A stored item that can't be read is no opt-out (the rule then applies). */
export async function readOptOut(deps: OptOutDependencies, orgId: OrgId, repository: string, project: string): Promise<StoredCommentTriggerOptOut | undefined> {
  // Names that are not a repository or a project are no opt-out (and never reach a key).
  if (!CommentTriggerRepositorySchema.safeParse(repository).success || !AgentXNameSchema.safeParse(project).success) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: commentTriggerOptOutKey(orgId, repository, project), ConsistentRead: true })) as { Item?: Item };
  return response.Item === undefined ? undefined : parseStored(deps, orgId, response.Item);
}

/** Every opt-out of the org, or of one repository (every project's). */
export async function listOptOuts(deps: OptOutDependencies, orgId: OrgId, repository?: string): Promise<StoredCommentTriggerOptOut[]> {
  const found: StoredCommentTriggerOptOut[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: repository === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: repository === undefined ? { ":pk": commentTriggerOptOutsPk(orgId) } : { ":pk": commentTriggerOptOutsPk(orgId), ":prefix": commentTriggerOptOutRepositoryPrefix(repository) },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const stored = parseStored(deps, orgId, item);
      if (stored !== undefined) found.push(stored);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

/** An opt-out as `GET /v1/app/org/agent-guardrails` lists it. */
export function optOutView(stored: StoredCommentTriggerOptOut): CommentTriggerOptOut {
  return { project: stored.project, repository: stored.repository, digest: stored.digest, files: stored.files, reviewedBy: stored.reviewedBy, reviewedAt: stored.reviewedAt, reason: stored.reason };
}

/** The active opt-outs of the org, by project and repository. */
export async function listOptOutViews(deps: OptOutDependencies, orgId: OrgId): Promise<CommentTriggerOptOut[]> {
  return (await listOptOuts(deps, orgId)).map(optOutView).sort((left, right) => (left.project + left.repository).localeCompare(right.project + right.repository));
}

// ---- the lapse

/** The paths whose blob changed, appeared or went away between two scans, in order. */
function changedPaths(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

/**
 * Deletes one opt-out whose digest is no longer the repository's, in one transaction with the event that says so (the old and new digests, the files
 * that changed and the notice maintainers and admins are shown) and the audit item (`by: "system"`). It applies only while the opt-out is the one
 * that was read; if it was lapsed or replaced meanwhile, nothing more is done.
 */
async function lapse(deps: OptOutDependencies, stored: StoredCommentTriggerOptOut, scan: RepoCommandTriggers, taskId: string | undefined): Promise<boolean> {
  const orgId = stored.orgId;
  const at = iso(deps);
  const changed = changedPaths(stored.fileShas, scan.fileShas);
  const eventId = sha256(`${stored.approvalId}|${stored.digest}|${scan.digest}`).slice(0, 32);
  const events = await tryAuditEvents(deps, () => [auditOptOutLapsed({
    orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: auditOccurrence(stored.repository, stored.project, stored.digest, scan.digest, stored.approvalId),
    repositoryName: stored.repository, scope: "repository", details: [{ subject: "org", fields: { project: stored.project } }],
  })]);
  const items: TransactItem[] = [
    {
      Delete: {
        TableName: deps.tableName, Key: commentTriggerOptOutKey(orgId, stored.repository, stored.project),
        ConditionExpression: "#digest = :old AND #approval = :approval", ExpressionAttributeNames: { "#digest": "digest", "#approval": "approvalId" },
        ExpressionAttributeValues: { ":old": stored.digest, ":approval": stored.approvalId },
      },
    },
    {
      Put: {
        TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
        Item: {
          ...commentTriggerEventKey(orgId, "lapsed", at, eventId), entityType: "COMMENT_TRIGGER_EVENT", orgId, kind: "lapsed", project: stored.project, repository: stored.repository,
          oldDigest: stored.digest, newDigest: scan.digest, changedFiles: changed.slice(0, MAX_CHANGED_FILES), notice: commentTriggerLapseNotice(stored.repository, changed), at, by: "system",
          ...(taskId === undefined || !/^[A-Za-z0-9_-]{1,100}$/u.test(taskId) ? {} : { taskId }), [INDEX_EXPIRY_ATTRIBUTE]: expiry(deps, EVENT_MEMORY_DAYS),
        },
      },
    },
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
    // The write may have lost to another run's identical lapse, or to a new opt-out: read again before deciding it did not happen.
    const now = await readOptOut(deps, orgId, stored.repository, stored.project);
    if (now !== undefined && now.digest === stored.digest && now.approvalId === stored.approvalId) throw error;
    return false;
  }
  await flushAuditEvents(deps, events);
  return true;
}

/**
 * Lapses every project's opt-out of the repository whose digest is not the scan's. A scan that failed closed lapses nothing: it says nothing about
 * the files, and a blip must not undo what an admin reviewed (the write is consequential meanwhile, because a failed scan triggers).
 */
export async function lapseStaleOptOuts(deps: OptOutDependencies, input: { orgId: OrgId; repository: string; scan: RepoCommandTriggers; taskId?: string }): Promise<number> {
  if (input.scan.failedClosed) return 0;
  let lapsed = 0;
  for (const stored of await listOptOuts(deps, input.orgId, input.repository)) {
    if (stored.digest !== input.scan.digest && await lapse(deps, stored, input.scan, input.taskId)) lapsed += 1;
  }
  return lapsed;
}

export interface CommentTriggerRule {
  /** Whether the repository-level rule makes every comment, review, label write and issue create or edit there consequential. */
  consequential: boolean;
  scan: RepoCommandTriggers;
  /** Whether this project has an opt-out that matches the files as they are now. */
  optedOut: boolean;
}

/**
 * What Task 20b's `classifyWrite` asks for a `github` write: the repository rule for this project. It scans the repository (once per run, in
 * `cache`), lapses any opt-out whose digest differs (with its event, notice and audit item), then reads the project's opt-out again and decides. The
 * opt-out is read now, never cached. A scan that failed closed is consequential, opt-out or not.
 */
export async function commentTriggerRule(
  deps: OptOutDependencies & { repositoryReader: Parameters<typeof repoCommandTriggers>[0]["repositoryReader"] },
  input: { orgId: OrgId; project: string; repository: string; taskId?: string; cache?: RunCache; /** The installation the project pinned for the repository: the scan is held to it. */ installationId?: number },
): Promise<CommentTriggerRule> {
  const scan = await repoCommandTriggers({ repositoryReader: deps.repositoryReader, now: deps.now, ...(input.cache === undefined ? {} : { cache: input.cache }) }, { orgId: input.orgId, repository: input.repository, ...(input.installationId === undefined ? {} : { installationId: input.installationId }) });
  if (scan.failedClosed) return { consequential: true, scan, optedOut: false };
  await lapseStaleOptOuts(deps, { orgId: input.orgId, repository: input.repository, scan, ...(input.taskId === undefined ? {} : { taskId: input.taskId }) });
  const stored = await readOptOut(deps, input.orgId, input.repository, input.project);
  const optedOut = stored !== undefined && stored.digest === scan.digest;
  return { consequential: scan.triggers && !optedOut, scan, optedOut };
}

// ---- who is told

export interface CommentTriggerNotice { at: string; project: string; repository: string; notice: string }

/**
 * The notices of opt-outs that lapsed in the last 30 days that this person is shown: an org owner or admin sees every project's; a maintainer of a
 * project sees that project's. The role is read now. (Task 21's approvals inbox lists these; Plan 9 sends them by Slack and email.)
 */
export async function listCommentTriggerNotices(
  deps: OptOutDependencies & Pick<ApprovalDependencies, "projectMembers">,
  caller: Pick<AgentCaller, "orgId" | "developerId" | "orgRole">,
): Promise<CommentTriggerNotice[]> {
  const since = commentTriggerEventKey(caller.orgId, "lapsed", new Date(deps.now() - NOTICE_DAYS * 86_400_000).toISOString(), "").sk;
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: { ":pk": commentTriggerEventsPk(caller.orgId), ":from": since, ":to": "EVENT#lapsed#~" },
    ScanIndexForward: false,
    Limit: MAX_NOTICES,
    ConsistentRead: true,
  })) as { Items?: Item[] };
  const admin = caller.orgRole === "owner" || caller.orgRole === "admin";
  const roles = new Map<string, boolean>();
  const maintains = async (project: string): Promise<boolean> => {
    if (admin) return true;
    if (!roles.has(project)) {
      const role = await deps.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: caller.orgRole });
      roles.set(project, role !== undefined && projectAllows(role, "manage_agents"));
    }
    return roles.get(project)!;
  };
  const shown: CommentTriggerNotice[] = [];
  for (const item of page.Items ?? []) {
    if (item["orgId"] !== caller.orgId || item["kind"] !== "lapsed" || typeof item["project"] !== "string" || typeof item["repository"] !== "string" || typeof item["notice"] !== "string" || typeof item["at"] !== "string") continue;
    if (await maintains(item["project"])) shown.push({ at: item["at"], project: item["project"], repository: item["repository"], notice: item["notice"] });
  }
  return shown;
}

// ---- asking for an opt-out

const repositoryUrlName = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parts.length !== 2) return undefined;
    return `${parts[0]!}/${parts[1]!.replace(/\.git$/u, "")}`.toLowerCase();
  } catch {
    return undefined;
  }
};

/** The repository as the project registers it (`owner/name`) with the installation the project pinned for it, or undefined when it is not one of the project's. */
export async function projectRepositoryEntry(deps: Pick<ApprovalDependencies, "projectRepositories">, orgId: OrgId, project: string, repository: string): Promise<{ repository: string; installationId?: number } | undefined> {
  if (deps.projectRepositories === undefined) throw agentXError("NOT_FOUND", "comment-triggered workflows are not set up in this deployment");
  const repositories = await deps.projectRepositories(orgId, project);
  if (repositories === undefined) return undefined;
  const wanted = repository.toLowerCase();
  for (const candidate of repositories) {
    if (repositoryUrlName(candidate.url) === wanted) return { repository: wanted, ...(candidate.installationId === undefined ? {} : { installationId: candidate.installationId }) };
  }
  return undefined;
}

/** The repository as the project registers it (`owner/name`), or undefined when it is not one of the project's. */
export async function projectRepository(deps: Pick<ApprovalDependencies, "projectRepositories">, orgId: OrgId, project: string, repository: string): Promise<string | undefined> {
  return (await projectRepositoryEntry(deps, orgId, project, repository))?.repository;
}

/** What the page and the routes say about one repository's workflows: the scan, and the project's opt-out when it matches. */
export interface RepositoryTriggerView {
  repository: string;
  triggers: boolean;
  failedClosed: boolean;
  digest: string;
  files: string[];
  /** Why the scan failed closed, in one fixed sentence, when it knows. Never text from the repository. */
  hint?: string;
  optOut?: CommentTriggerOptOut;
}

/** A fresh scan (never the run cache's) of one repository for an admin to review, with the project's opt-out when there is one. */
export async function reviewRepository(deps: OptOutDependencies & Pick<ApprovalDependencies, "repositoryReader" | "projectRepositories">, input: { orgId: OrgId; project: string; repository: string }): Promise<RepositoryTriggerView> {
  if (deps.repositoryReader === undefined) throw agentXError("NOT_FOUND", "comment-triggered workflows are not set up in this deployment");
  // The scan is held to the installation the project pinned for the repository.
  const entry = await projectRepositoryEntry(deps, input.orgId, input.project, input.repository);
  if (entry === undefined) throw agentXError("CONFIG_INVALID", "repository: that is not one of this project's repositories");
  const scan = await repoCommandTriggers({ repositoryReader: deps.repositoryReader, now: deps.now }, { orgId: input.orgId, repository: input.repository, ...(entry.installationId === undefined ? {} : { installationId: entry.installationId }) });
  const stored = await readOptOut(deps, input.orgId, input.repository, input.project);
  return {
    repository: input.repository, triggers: scan.triggers, failedClosed: scan.failedClosed, digest: scan.digest, files: scan.files,
    ...(scan.hint === undefined ? {} : { hint: scan.hint }),
    ...(stored === undefined ? {} : { optOut: optOutView(stored) }),
  };
}

export type OptOutRequestResult = { confirmUrl: string; changes: string[] };

/**
 * Records a pending opt-out for an org admin to confirm. Nothing is applied. The record stores what the admin asked: the project, the repository, the
 * digest they looked at, the files and the reason. A scan that fails closed can't be reviewed, so nothing is asked of anyone; a digest that is
 * already out of date is refused now (it is checked again when the opt-out is confirmed).
 */
export async function requestOptOut(
  deps: ApprovalDependencies,
  caller: AgentCaller,
  input: { requestId: string; project: string; repository: string; expectedDigest: string; reason: string },
): Promise<OptOutRequestResult> {
  // The route validates the body; the function does too, whoever calls it.
  const checked = CommentTriggerOptOutRequestSchema.safeParse({ requestId: input.requestId, repository: input.repository, expectedDigest: input.expectedDigest, reason: input.reason });
  if (!checked.success || !AgentXNameSchema.safeParse(input.project).success) {
    const issue = checked.success ? undefined : checked.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue === undefined ? "project" : issue.path.join(".") || "body"}: ${issue === undefined ? "is not a project name" : "is not valid"}`);
  }
  const repository = await projectRepository(deps, caller.orgId, input.project, input.repository);
  if (repository === undefined) throw agentXError("CONFIG_INVALID", "repository: that is not one of this project's repositories");
  const view = await reviewRepository(deps, { orgId: caller.orgId, project: input.project, repository });
  if (view.failedClosed) throw agentXError("CONFIG_INVALID", COMMENT_TRIGGER_UNREADABLE_TEXT);
  if (view.digest !== input.expectedDigest) throw agentXError("CONFIG_INVALID", COMMENT_TRIGGER_STALE_TEXT);
  const subject: OptOutChangeSubject = { kind: "opt_out", project: input.project, repository, expectedDigest: input.expectedDigest, files: view.files, reason: checked.data.reason };
  const changes = [
    `Lets agents comment, review and label in ${repository} on ${input.project} without waiting for a person, although workflows there act on comments or labels`,
    `Covers ${String(view.files.length)} files, digest ${input.expectedDigest.slice(0, 12)}`,
  ];
  const record = await createPendingChange(deps, { orgId: caller.orgId, requestId: input.requestId, requestedBy: caller.developerId, subject, changes, approvers: await orgAdminApprovers(deps, caller.orgId) });
  // A repeat of a request that was decided since is not waiting any more.
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return { confirmUrl: confirmUrlFor(deps, record), changes: record.changes };
}

// ---- confirming

function decidedBy(record: ApprovalRecord): string {
  if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
  return record.decidedBy;
}

/**
 * Applies a confirmed opt-out exactly as stored, after looking at the repository again: the project must still have the repository, the workflows must
 * be readable, and their digest must still be the one that was reviewed. The opt-out, its event and its audit item are written in one transaction. A
 * repeat of the same confirmation changes nothing.
 */
async function confirmOptOut(deps: ApprovalDependencies, record: ApprovalRecord): Promise<void> {
  const by = decidedBy(record);
  const subject = record.subject as OptOutChangeSubject;
  const entry = await projectRepositoryEntry(deps, record.orgId, subject.project, subject.repository);
  if (entry === undefined) throw agentXError("CONFIG_INVALID", "this repository is no longer one of the project's, so the opt-out can't be applied");
  const repository = entry.repository;
  if (deps.repositoryReader === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "comment-triggered workflows are not set up in this deployment");
  const scan = await repoCommandTriggers({ repositoryReader: deps.repositoryReader, now: deps.now }, { orgId: record.orgId, repository, ...(entry.installationId === undefined ? {} : { installationId: entry.installationId }) });
  if (scan.failedClosed) throw agentXError("CONFIG_INVALID", COMMENT_TRIGGER_UNREADABLE_TEXT);
  if (scan.digest !== subject.expectedDigest) throw agentXError("CONFIG_INVALID", COMMENT_TRIGGER_STALE_TEXT);

  // A confirmation that already landed (the caller died before it recorded the outcome) changes nothing.
  if ((await readOptOut(deps, record.orgId, repository, subject.project))?.approvalId === record.approvalId) return;
  const at = iso(deps);
  const stored: StoredCommentTriggerOptOut = {
    orgId: record.orgId, project: subject.project, repository, digest: scan.digest, files: scan.files, reviewedBy: by, reviewedAt: at, reason: subject.reason,
    fileShas: scan.fileShas, approvalId: record.approvalId,
  };
  const events = await tryAuditEvents(deps, () => [auditOptOutApplied({
    orgId: record.orgId, actor: auditActorOf(by), occurredAt: at, occurrence: record.approvalId, repositoryName: repository, scope: "repository",
    details: [{ subject: "org", fields: { project: subject.project } }],
  })]);
  const items: TransactItem[] = [
    { Put: { TableName: deps.tableName, Item: { ...commentTriggerOptOutKey(record.orgId, repository, subject.project), entityType: "COMMENT_TRIGGER_OPT_OUT", ...stored } } },
    {
      Put: {
        TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
        Item: {
          ...commentTriggerEventKey(record.orgId, "applied", at, cacheNameOf(record.approvalId)), entityType: "COMMENT_TRIGGER_EVENT", orgId: record.orgId, kind: "applied",
          project: subject.project, repository, digest: scan.digest, files: scan.files.slice(0, 400), by, at, approvalId: record.approvalId, [INDEX_EXPIRY_ATTRIBUTE]: expiry(deps, EVENT_MEMORY_DAYS),
        },
      },
    },
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  await flushAuditEvents(deps, events);
}

/** Registers what confirming an `opt_out` record does. The approver rule is the `org_admin` rule (changes.ts), evaluated when the decision is made. Safe to call more than once. */
export function registerCommentTriggerApprovals(): void {
  registerApprovalSubjectHandler("opt_out", confirmOptOut);
}
