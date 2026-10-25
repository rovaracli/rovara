// Linear (Plan 4 Task 22): `Linear-Signature` is the hex HMAC-SHA256 of the raw body under the webhook's signing secret (Linear's webhook documentation: "Securing webhooks"). The
// secret is Linear's, pasted in by the person. A body is believed only for the hook's own Linear organization and team; only an `Issue` created becomes an event.
// Difference from the documentation, on purpose: Linear advises refusing a `webhookTimestamp` more than a minute old. Linear retries a failed delivery after a minute, an hour and six
// hours, and a signed replay is already stopped by the event key (kept for 72 hours) and the 24-hour age window of ingress, so a retry is not refused for being late.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@agentx/contracts";
import { hmacHexEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, httpsLinkOn, isoOfMillis, titleOf, valuesOf } from "./shared.js";

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
