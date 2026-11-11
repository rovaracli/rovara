// Linear (Plan 4 Task 22): `Linear-Signature` is the hex HMAC-SHA256 of the raw body under the webhook's signing secret (Linear's webhook documentation: "Securing webhooks"). The
// secret is Linear's, pasted in by the person. A body is believed only for the hook's own Linear organization and team; only an `Issue` created becomes an event.
// Difference from the documentation, on purpose: Linear advises refusing a `webhookTimestamp` more than a minute old. Linear retries a failed delivery after a minute, an hour and six
// hours, and a signed replay is already stopped by the event key (kept for 72 hours) and the 24-hour age window of ingress, so a retry is not refused for being late.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@rovara-code/contracts";
import { hmacHexEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, httpsLinkOn, isoOfMillis, titleOf, valuesOf } from "./shared.js";
import { linearWorkspaceOfLink, parseLinearIssue } from "../../rovara-code/linear-close.js";

const Envelope = z.object({ type: z.string().max(64), action: z.string().max(64), organizationId: z.string().min(1).max(100) }).passthrough();
const TeamOf = z.object({ data: z.object({ teamId: z.string().min(1).max(100).optional(), team: z.object({ id: z.string().min(1).max(100).optional() }).passthrough().optional() }).passthrough() }).passthrough();
const Issue = z.object({
  webhookTimestamp: z.unknown(),
  url: z.unknown().optional(),
  actor: z.object({ id: z.string().min(1).max(200) }).passthrough().nullish(),
  data: z.object({
    id: z.string().min(1).max(100),
    identifier: z.string().min(1).max(100).optional(),
    number: z.number().int().positive().optional(),
    team: z.object({ key: z.string().min(1).max(50).optional() }).passthrough().optional(),
    title: z.unknown().optional(),
    url: z.unknown().optional(),
    labels: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function verify(raw: Buffer, headers: HookHeaders, secret: string): boolean {
  return hmacHexEquals("sha256", raw, secret, headerOf(headers, "linear-signature") ?? "");
}

function normalize(body: unknown, _headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "linear") return { tenantMismatch: true };
  const tenant = hook.tenant as { organizationId: string; teamId: string };
  // The organization is read first, from every kind of body: a delivery that is not the hook's Linear organization is refused whatever it says it is.
  const envelope = Envelope.safeParse(body);
  if (!envelope.success || !same(envelope.data.organizationId, tenant.organizationId)) return { tenantMismatch: true };
  if (envelope.data.type !== "Issue" || envelope.data.action !== "create") return { ignored: "not an issue created" };
  const team = TeamOf.safeParse(body);
  const teamId = team.success ? (team.data.data.teamId ?? team.data.data.team?.id) : undefined;
  if (teamId === undefined || !same(teamId, tenant.teamId)) return { tenantMismatch: true };
  const issue = Issue.safeParse(body);
  const occurredAt = issue.success ? isoOfMillis(issue.data.webhookTimestamp) : undefined;
  if (!issue.success || occurredAt === undefined) return { ignored: "an issue that can't be read" };
  const { data } = issue.data;
  const identifier = data.identifier ?? (data.team?.key !== undefined && data.number !== undefined ? `${data.team.key}-${String(data.number)}` : data.id);
  const labels = Array.isArray(data.labels) ? data.labels.map((label: unknown) => (label !== null && typeof label === "object" ? (label as { name?: unknown }).name : undefined)) : [];
  const url = httpsLinkOn(data.url ?? issue.data.url, "linear.app");
  const event: TriggerEvent = {
    source: "linear", type: "issue.created", eventKey: `linear:issue:${data.id}:create`, occurredAt, project: hook.project,
    subject: { kind: "issue", id: identifier, title: titleOf(data.title, identifier), ...(url === undefined ? {} : { url }) },
    fields: { label: valuesOf(labels) },
    // Whether the actor is Rovara's own account is not the provider's to say: dispatch compares this id with the org's connection, as it is now.
    actor: issue.data.actor === null || issue.data.actor === undefined ? { kind: "unknown" } : { kind: "external", id: issue.data.actor.id },
  };
  return { events: [event] };
}

export const linearProvider: HookProvider = { source: "linear", secretOrigin: "vendor", auth: "hmac", verify, normalize };

/** A comment a person wrote on a Linear issue, as a verified delivery carries it (live interaction L1). Nothing in it is believed until `handleLinearComment` has checked the issue is bound. */
export interface LinearComment {
  /** Linear's id of the comment: what makes a redelivery the same comment. */
  commentId: string;
  /** The comment's Markdown. */
  text: string;
  /** The issue's key (`ENG-142`), read from the comment's own link on linear.app (https only), never from free text. */
  issueKey: string;
  /** Who wrote it: Linear's user id. A person who is not a Rovara member is an outsider, whatever they say they are. */
  authorId: string;
  /** The workspace url key in the comment's own link (`acme`), when the link has one. A key such as `ENG-142` exists in every workspace, so this is what tells them apart (M8). */
  workspace?: string;
  /** The team the comment's issue is in, when the delivery says. */
  teamId?: string;
}

const CommentBody = z.object({
  type: z.literal("Comment"), action: z.literal("create"), organizationId: z.string().min(1).max(100),
  url: z.unknown().optional(),
  actor: z.object({ id: z.string().min(1).max(200), type: z.string().max(40).optional() }).passthrough().nullish(),
  data: z.object({
    id: z.string().min(1).max(100), body: z.string().max(100_000), userId: z.string().min(1).max(200).optional(), teamId: z.string().min(1).max(100).optional(),
    issue: z.object({ team: z.object({ id: z.string().min(1).max(100).optional() }).passthrough().optional(), teamId: z.string().min(1).max(100).optional() }).passthrough().optional(),
    user: z.object({ id: z.string().min(1).max(200).optional(), type: z.string().max(40).optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

/**
 * The comment a verified Linear delivery carries, or undefined: not a created Comment, another Linear organization, a comment written by an application or integration (Rovara's own replies among
 * them), no author, or no link to a Linear issue. Only the hook's organization is believed; the team is checked when the delivery names one (the binding and the hook's project decide the rest).
 */
export function linearCommentOf(body: unknown, hook: HookRecord): LinearComment | undefined {
  if (hook.source !== "linear") return undefined;
  const tenant = hook.tenant as { organizationId: string; teamId: string };
  const parsed = CommentBody.safeParse(body);
  if (!parsed.success || !same(parsed.data.organizationId, tenant.organizationId)) return undefined;
  const { data, actor } = parsed.data;
  // Only a comment the delivery SAYS a person wrote is an Ask: an application or integration (a bot, Rovara's own account) is not, and a delivery that names no kind is not believed to be a person
  // (fail closed): Rovara must not answer itself.
  const kind = actor?.type ?? data.user?.type;
  if (kind !== "user") return undefined;
  const authorId = actor?.id ?? data.userId ?? data.user?.id;
  const link = httpsLinkOn(parsed.data.url, "linear.app");
  const issue = link === undefined ? undefined : parseLinearIssue(link);
  if (authorId === undefined || issue === undefined) return undefined;
  const teamId = data.teamId ?? data.issue?.teamId ?? data.issue?.team?.id;
  if (teamId !== undefined && !same(teamId, tenant.teamId)) return undefined;
  const workspace = link === undefined ? undefined : linearWorkspaceOfLink(link);
  return { commentId: data.id, text: data.body, issueKey: issue.issueId, authorId, ...(teamId === undefined ? {} : { teamId }), ...(workspace === undefined ? {} : { workspace }) };
}
