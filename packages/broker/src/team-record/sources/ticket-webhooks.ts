// R7: Linear and Jira webhook bodies as record items. The hook's signature was already verified by `triggers/ingress.ts`; the hook's tenant (the
// Linear organization and team, the Jira site and project) decides what is believed, and the workspace and project come from the hook record.
// The trigger providers only read "issue created"; this reads the changes and comments too, and deletions.
import { z } from "zod";
import { isoOrUndefined } from "./common.js";
import type { TicketContext, TicketItem, TicketRecorder } from "./tickets.js";

const text = (max: number) => z.string().max(max);

const LinearEnvelope = z.object({ type: text(64), action: text(64), organizationId: text(100), webhookTimestamp: z.unknown().optional(), createdAt: z.unknown().optional(), url: z.unknown().optional(), actor: z.object({ id: text(200) }).passthrough().nullish(), updatedFrom: z.record(z.string(), z.unknown()).nullish(), data: z.record(z.string(), z.unknown()) }).passthrough();

const JiraEnvelope = z.object({
  webhookEvent: text(100), timestamp: z.unknown().optional(), user: z.object({ accountId: text(200).optional() }).passthrough().nullish(), issue: z.record(z.string(), z.unknown()).optional(), comment: z.record(z.string(), z.unknown()).optional(),
  changelog: z.object({ items: z.array(z.record(z.string(), z.unknown())).max(100).optional() }).passthrough().nullish(),
}).passthrough();

export type TicketWebhookInput =
  | { source: "linear"; body: unknown; tenant: { organizationId: string; teamId: string } }
  | { source: "jira"; body: unknown; tenant: { siteHost: string; projectKey?: string } };

export type TicketWebhookResult = { changes: TicketItem[]; removed: string[]; system: string } | { ignored: string };

const idText = (value: unknown): string | undefined => (typeof value === "string" || typeof value === "number" ? String(value).slice(0, 100) : undefined);
const str = (value: unknown, max = 2000): string | undefined => (typeof value === "string" && value !== "" ? value.slice(0, max) : undefined);
/** Per-editor rows: the text an update's source says the field had before (null or missing is the empty text). */
/** A field of a changelog item by name (`toString` is also an Object method, so it is read through a key, not as a property). */
const changeValue = (entry: Record<string, unknown> | undefined, key: string): unknown => entry?.[key];
const before = (value: unknown): string => (typeof value === "string" ? value.slice(0, 70_000) : "");

/** Reads one verified delivery into items to record and ids to remove. Nothing of the body is believed past the hook's tenant. */
export function ticketsOfWebhook(input: TicketWebhookInput): TicketWebhookResult {
  return input.source === "linear" ? linearItems(input.body, input.tenant) : jiraItems(input.body, input.tenant);
}

function linearItems(body: unknown, tenant: { organizationId: string; teamId: string }): TicketWebhookResult {
  const parsed = LinearEnvelope.safeParse(body);
  if (!parsed.success || parsed.data.organizationId.toLowerCase() !== tenant.organizationId.toLowerCase()) return { ignored: "tenant" };
  const { type, action, data } = parsed.data;
  const issueOf = (data.issue ?? {}) as { teamId?: unknown; team?: { id?: unknown } };
  const bodyTeam = str(data.teamId, 100) ?? str((data.team as { id?: unknown } | undefined)?.id, 100) ?? str(issueOf.teamId, 100) ?? str(issueOf.team?.id, 100);
  // The hook is for one team. A body that names another team is not ours; a body that names none proves nothing about its team.
  if (bodyTeam !== undefined && bodyTeam.toLowerCase() !== tenant.teamId.toLowerCase()) return { ignored: "tenant" };
  const id = str(data.id, 100);
  if (id === undefined) return { ignored: "unreadable" };
  const scope = `linear:team/${tenant.teamId.toLowerCase()}`;
  const at = isoOrUndefined(data.updatedAt) ?? isoOrUndefined(parsed.data.webhookTimestamp) ?? isoOrUndefined(parsed.data.createdAt) ?? new Date().toISOString();
  const acl = { groups: [tenant.teamId.toLowerCase()], strict: false } as const;
  if (type === "Issue") {
    const key = `issue:${id}`;
    if (action === "remove") return { changes: [], removed: [key], system: "linear" };
    if (action !== "create" && action !== "update") return { ignored: "action" };
    // An issue must prove its team: an org-wide hook also carries other teams' issues, private teams included.
    if (bodyTeam === undefined) return { ignored: "tenant_unproven" };
    const creator = str(data.creatorId, 200) ?? str((data.creator as { id?: unknown } | undefined)?.id, 200);
    const actorId = str(parsed.data.actor?.id, 200);
    const state = str((data.state as { name?: unknown } | undefined)?.name, 100);
    const labels = Array.isArray(data.labels) ? data.labels.flatMap((label: unknown) => str((label as { name?: unknown } | null)?.name, 100) ?? []) : [];
    // Linear says which fields an update changed (`updatedFrom` holds their old values). Absent on an update: unknown, and no words of it are kept.
    const from = action === "update" ? parsed.data.updatedFrom ?? undefined : undefined;
    const changedOf = from === undefined ? undefined : { title: "title" in from, body: "description" in from, state: "stateId" in from || "state" in from, labels: "labelIds" in from || "labels" in from };
    return { system: "linear", removed: [], changes: [{
      source: "linear", system: "linear", id: key, kind: action === "create" ? "ticket.created" : "ticket.updated", scope,
      title: str(data.title, 500) ?? str(data.identifier, 100) ?? id, ...(str(data.description, 70_000) === undefined ? {} : { body: str(data.description, 70_000)! }),
      ...(state === undefined ? {} : { state }), labels, ...(str(data.url ?? parsed.data.url) === undefined ? {} : { url: str(data.url ?? parsed.data.url)! }),
      ...(creator === undefined ? {} : { authorId: creator }), ...(actorId === undefined ? {} : { updaterId: actorId }), nativeId: id, ...(action === "update" ? { edit: true } : {}),
      ...(changedOf === undefined ? {} : { changed: changedOf }), ...(from !== undefined && "description" in from ? { previousBody: before(from.description) } : {}), ...(from !== undefined && "title" in from ? { previousTitle: before(from.title) } : {}),
      occurredAt: at, version: `${action}:${at}`, acl,
    }] };
  }
  if (type === "Comment") {
    const key = `comment:${id}`;
    if (action === "remove") return { changes: [], removed: [key], system: "linear" };
    if (action !== "create" && action !== "update") return { ignored: "action" };
    const issueId = str(data.issueId, 100) ?? str((data.issue as { id?: unknown } | undefined)?.id, 100);
    // The comment's author is `userId`; whoever edited it is the webhook's actor.
    const commentAuthor = str(data.userId, 200);
    const commentUpdater = str(parsed.data.actor?.id, 200);
    return { system: "linear", removed: [], changes: [{
      source: "linear", system: "linear", id: key, kind: "ticket.comment", scope, ...(issueId === undefined ? {} : { parentId: `issue:${issueId}` }),
      ...(str(data.body, 70_000) === undefined ? {} : { body: str(data.body, 70_000)! }), ...(str(data.url ?? parsed.data.url) === undefined ? {} : { url: str(data.url ?? parsed.data.url)! }),
      ...(commentAuthor === undefined ? {} : { authorId: commentAuthor }), ...(commentUpdater === undefined ? {} : { updaterId: commentUpdater }), nativeId: id, ...(action === "update" ? { edit: true } : {}),
      ...(action === "update" && parsed.data.updatedFrom != null && "body" in parsed.data.updatedFrom ? { previousBody: before(parsed.data.updatedFrom.body) } : {}),
      // A comment that names no team is recorded only when its ticket is already recorded under this team.
      ...(bodyTeam === undefined ? { needsParentProof: true } : {}), occurredAt: at, version: `${action}:${at}`, acl,
    }] };
  }
  return { ignored: "type" };
}

/** Jira's description and comment bodies are plain text or Atlassian Document Format; the words of the latter are read out, bounded. */
export function adfText(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 70_000);
  const parts: string[] = [];
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    if (parts.join("").length > 70_000 || nodes++ > 5_000 || depth > 30 || node === null || typeof node !== "object") return;
    const record = node as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof record.text === "string") parts.push(record.text);
    if (Array.isArray(record.content)) for (const child of record.content) walk(child, depth + 1);
    if (record.type === "paragraph" || record.type === "heading" || record.type === "listItem") parts.push("\n");
  };
  walk(value, 0);
  const out = parts.join("").trim();
  return out === "" ? undefined : out.slice(0, 70_000);
}

function jiraItems(body: unknown, tenant: { siteHost: string; projectKey?: string }): TicketWebhookResult {
  const parsed = JiraEnvelope.safeParse(body);
  if (!parsed.success) return { ignored: "unreadable" };
  const { webhookEvent, issue, comment } = parsed.data;
  const self = str(issue?.self) ?? str(comment?.self);
  if (self === undefined || !onSite(self, tenant.siteHost)) return { ignored: "tenant" };
  const fields = (issue?.fields ?? {}) as Record<string, unknown>;
  const projectKey = str((fields.project as { key?: unknown } | undefined)?.key, 100);
  // A hook scoped to one project believes only a body that names that project: a comment event without its issue proves nothing.
  if (tenant.projectKey !== undefined && projectKey !== tenant.projectKey) return { ignored: "tenant" };
  const scopeKey = tenant.projectKey ?? projectKey;
  const scope = scopeKey === undefined ? `jira:site/${tenant.siteHost}` : `jira:project/${scopeKey}`;
  const system = `jira:${tenant.siteHost}`;
  const at = isoOrUndefined(comment?.updated) ?? isoOrUndefined(parsed.data.timestamp) ?? new Date().toISOString();
  const acl = { groups: [scopeKey ?? tenant.siteHost], strict: false } as const;
  const issueId = idText(issue?.id);
  const key = str(issue?.key, 100);
  const browse = key !== undefined && /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/.test(key) ? `https://${tenant.siteHost}/browse/${key}` : undefined;
  const triggeredBy = str(parsed.data.user?.accountId, 200);
  const creatorOf = (fields.creator ?? fields.reporter) as { accountId?: unknown } | null | undefined;
  const creator = str(creatorOf?.accountId, 200) ?? str((fields.reporter as { accountId?: unknown } | null | undefined)?.accountId, 200);
  // Jira issue security levels: a restricted issue is never given the project-wide audience. An issue whose fields are missing cannot be known to be open.
  const securityLevel = fields.security !== undefined && fields.security !== null;
  const restricted = securityLevel || issue?.fields === undefined;
  if (webhookEvent === "jira:issue_deleted") return issueId === undefined ? { ignored: "unreadable" } : { changes: [], removed: [`issue:${issueId}`], system };
  if (webhookEvent === "jira:issue_created" || webhookEvent === "jira:issue_updated") {
    if (issueId === undefined) return { ignored: "unreadable" };
    const state = str((fields.status as { name?: unknown } | undefined)?.name, 100);
    const description = adfText(fields.description);
    // Jira's changelog names the fields an update changed, with their old text. Absent on an update: unknown, and no words of it are kept.
    const changes = webhookEvent === "jira:issue_updated" ? parsed.data.changelog?.items : undefined;
    const changedField = (name: string): Record<string, unknown> | undefined => changes?.find((entry) => typeof entry.field === "string" && entry.field.toLowerCase() === name);
    const changedOf = changes === undefined ? undefined : { title: changedField("summary") !== undefined, body: changedField("description") !== undefined, state: changedField("status") !== undefined, labels: changedField("labels") !== undefined };
    const descriptionChange = changedField("description");
    const summaryChange = changedField("summary");
    // B1: an UPDATE's description and title come from the changelog item itself: its `fromString` and `toString` are in the SAME format (Jira's wiki markup), so the words the editor added are found by comparing
    // the two. The description in `fields` is Atlassian Document Format flattened to plain text, a different format, and is never compared with `fromString`. With no `toString` there is no text to compare: no words are kept.
    const isUpdate = webhookEvent === "jira:issue_updated";
    const bodyOf = isUpdate ? str(changeValue(descriptionChange, "toString"), 70_000) : description;
    const titleOf = isUpdate && summaryChange !== undefined ? str(changeValue(summaryChange, "toString"), 500) : undefined;
    return { system, removed: [], changes: [{
      source: "jira", system, id: `issue:${issueId}`, kind: webhookEvent === "jira:issue_created" ? "ticket.created" : "ticket.updated", scope,
      title: titleOf ?? str(fields.summary, 500) ?? key ?? issueId, ...(bodyOf === undefined ? {} : { body: bodyOf }), ...(state === undefined ? {} : { state }),
      labels: Array.isArray(fields.labels) ? fields.labels.flatMap((label: unknown) => str(label, 100) ?? []) : [], ...(browse === undefined ? {} : { url: browse }),
      ...(creator === undefined ? {} : { authorId: creator }), ...(triggeredBy === undefined ? {} : { updaterId: triggeredBy }), nativeId: issueId, ...(webhookEvent === "jira:issue_updated" ? { edit: true } : {}),
      ...(changedOf === undefined ? {} : { changed: changedOf }), ...(descriptionChange === undefined ? {} : { previousBody: before(descriptionChange.fromString) }), ...(summaryChange === undefined ? {} : { previousTitle: before(summaryChange.fromString) }),
      ...(restricted ? { restricted: true } : {}), occurredAt: at, version: `${webhookEvent}:${at}`, acl,
    }] };
  }
  if (webhookEvent === "comment_created" || webhookEvent === "comment_updated" || webhookEvent === "comment_deleted") {
    const commentId = idText(comment?.id);
    if (commentId === undefined) return { ignored: "unreadable" };
    if (webhookEvent === "comment_deleted") return { changes: [], removed: [`comment:${commentId}`], system };
    const commentAuthor = str((comment?.author as { accountId?: unknown } | undefined)?.accountId, 200);
    const commentUpdater = str((comment?.updateAuthor as { accountId?: unknown } | undefined)?.accountId, 200) ?? triggeredBy;
    const commentBody = adfText(comment?.body);
    const commentVisibility = comment?.visibility !== undefined && comment.visibility !== null;
    return { system, removed: [], changes: [{
      source: "jira", system, id: `comment:${commentId}`, kind: "ticket.comment", scope, ...(issueId === undefined ? {} : { parentId: `issue:${issueId}` }),
      ...(commentBody === undefined ? {} : { body: commentBody }), ...(browse === undefined ? {} : { url: browse }), ...(commentAuthor === undefined ? {} : { authorId: commentAuthor }), ...(commentUpdater === undefined ? {} : { updaterId: commentUpdater }), nativeId: commentId,
      ...(webhookEvent === "comment_updated" ? { edit: true } : {}),
      // The comment's own visibility (a role or group it is limited to) or the issue's security level restricts it; otherwise it takes the parent's.
      ...(securityLevel || commentVisibility ? { restricted: true } : {}), inheritsRestriction: true, occurredAt: at, version: `${webhookEvent}:${at}`, acl,
    }] };
  }
  return { ignored: "event" };
}

/** Whether `self` is a plain https link on exactly the hook's site (the same test the trigger provider uses). */
function onSite(self: string, siteHost: string): boolean {
  try {
    const url = new URL(self);
    return url.protocol === "https:" && url.hostname === siteHost && url.port === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export interface TicketWebhookTapDependencies {
  recorder: TicketRecorder;
  /** The workspace an org's hook records into. */
  workspaceOf?(orgId: string): string;
}

/** Called by the hook ingress after a delivery is verified. Never throws; the delivery is answered whatever happens here. */
export function createTicketWebhookTap(deps: TicketWebhookTapDependencies): (input: TicketWebhookInput & { orgId: string; project: string; removalStarted?: () => void }) => Promise<void> {
  return async (input) => {
    try {
      const result = ticketsOfWebhook(input);
      if ("ignored" in result) return;
      const context: TicketContext = { workspaceId: deps.workspaceOf?.(input.orgId) ?? input.orgId, project: input.project };
      if (result.removed.length > 0) {
        // A delete is the one thing that must not be lost (TRW-5 S2): the sink has already tried the table, the queue and an Event invoke of the broker. If it still failed, this is thrown so the hook
        // ingress answers 503 and the provider (Linear, Jira) sends the delivery again. The ingress is told first that a removal began, so a removal still running at its budget is answered 503 too.
        try { input.removalStarted?.(); } catch { /* a callback of the caller never fails the removal */ }
        try { await deps.recorder.remove(context, { source: input.source, system: result.system, ids: result.removed }); } catch { throw Object.assign(new Error("the record could not take the delete"), { name: "RecordRemovalNotAccepted" }); }
      }
      for (const item of result.changes) await deps.recorder.record(context, item);
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "RecordRemovalNotAccepted") throw error;
      // Recording anything else is never allowed to fail a delivery.
    }
  };
}

/** The adapter the hook ingress calls (`HookIngressDeps.recordTap`): only Linear and Jira hooks reach the record; every other source is left alone. */
export function createHookRecordTap(deps: TicketWebhookTapDependencies): (input: { orgId: string; hook: { source: string; project: string; tenant: unknown }; body: unknown; removalStarted?: () => void }) => Promise<void> {
  const tap = createTicketWebhookTap(deps);
  return async ({ orgId, hook, body, removalStarted }) => {
    const started = removalStarted === undefined ? {} : { removalStarted };
    const tenant = (hook.tenant ?? {}) as Record<string, unknown>;
    if (hook.source === "linear" && typeof tenant.organizationId === "string" && typeof tenant.teamId === "string") {
      await tap({ source: "linear", orgId, project: hook.project, body, tenant: { organizationId: tenant.organizationId, teamId: tenant.teamId }, ...started });
    } else if (hook.source === "jira" && typeof tenant.siteHost === "string") {
      await tap({ source: "jira", orgId, project: hook.project, body, tenant: { siteHost: tenant.siteHost, ...(typeof tenant.projectKey === "string" ? { projectKey: tenant.projectKey } : {}) }, ...started });
    }
  };
}
