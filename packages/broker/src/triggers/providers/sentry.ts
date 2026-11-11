// Sentry (Plan 4 Task 23): an integration platform webhook is signed in `Sentry-Hook-Signature`, the hex HMAC-SHA256 of the request body under the integration's client secret; the
// resource that sent it is in `Sentry-Hook-Resource` (Sentry's "Webhooks" pages). The secret is Sentry's, pasted in by the person. A body is believed only for the hook's own
// installation (`installation.uuid`, present on every resource); only an `issue` created and an `event_alert` triggered become events.
// Differences from the documentation, on purpose: Sentry's example hashes `JSON.stringify(request.body)`, which says nothing of whether the sender signs the bytes it sends; the
// raw bytes are what is signed here, as the plan says, and a body re-serialised by anyone is refused. `Sentry-Hook-Timestamp` is not used: the documentation does not say it is signed,
// so the event's own time and the event key stop a replay. The issue payload documents no environment, so an issue event's `environment` is empty (an environment filter
// does not match an issue); an alert's comes from the event's `environment` field or its `environment` tag. The documentation names no host for a self-hosted Sentry and the hook has
// none, so a link is kept only when it is on sentry.io or one of its subdomains.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@rovara-code/contracts";
import { hmacHexEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, httpsLinkOnDomain, isoOfText, titleOf, valuesOf } from "./shared.js";

/** A rule's name goes into the event key as it is up to this long and with no control or invisible characters; otherwise as a hash, so the key stays within what a run may carry. */
const RULE_KEY_CHARS_MAX = 100;

const Installation = z.object({ installation: z.object({ uuid: z.string().max(100) }).passthrough() }).passthrough();
const Identifier = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/);
const IssueCreated = z.object({
  data: z.object({
    issue: z.object({
      id: z.union([Identifier, z.number().int().nonnegative()]),
      firstSeen: z.unknown(),
      title: z.unknown().optional(),
      level: z.unknown().optional(),
      web_url: z.unknown().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();
const AlertTriggered = z.object({
  data: z.object({
    triggered_rule: z.string().min(1),
    event: z.object({
      event_id: Identifier,
      datetime: z.unknown(),
      title: z.unknown().optional(),
      level: z.unknown().optional(),
      environment: z.unknown().optional(),
      tags: z.unknown().optional(),
      web_url: z.unknown().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function verify(raw: Buffer, headers: HookHeaders, secret: string): boolean {
  return hmacHexEquals("sha256", raw, secret, headerOf(headers, "sentry-hook-signature") ?? "");
}

/** The environment of an alert's event: its own `environment` text, else the value of its `environment` tag (`[key, value]` pairs). */
function environmentOf(event: { environment?: unknown; tags?: unknown }): string[] {
  if (typeof event.environment === "string") return valuesOf([event.environment]);
  if (!Array.isArray(event.tags)) return [];
  const pair = event.tags.find((tag: unknown) => Array.isArray(tag) && tag[0] === "environment" && typeof tag[1] === "string") as [string, string] | undefined;
  return valuesOf([pair?.[1]]);
}

const ruleKeyPart = (rule: string): string =>
  [...rule].length <= RULE_KEY_CHARS_MAX && !/[\p{Cc}\p{Cf}]/u.test(rule) ? rule : `sha256-${createHash("sha256").update(rule).digest("hex").slice(0, 16)}`;

function normalize(body: unknown, headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "sentry") return { tenantMismatch: true };
  const tenant = hook.tenant as { installationUuid: string };
  // The installation is read first, from every kind of body: a delivery that is not the hook's own installation is refused whatever it says it is.
  const installation = Installation.safeParse(body);
  if (!installation.success || !same(installation.data.installation.uuid, tenant.installationUuid)) return { tenantMismatch: true };
  const resource = headerOf(headers, "sentry-hook-resource");
  const action = (body as { action?: unknown }).action;
  if (resource === "issue" && action === "created") {
    const issue = IssueCreated.safeParse(body);
    const occurredAt = issue.success ? isoOfText(issue.data.data.issue.firstSeen) : undefined;
    if (!issue.success || occurredAt === undefined) return { ignored: "an issue that can't be read" };
    const { id, title, level, web_url: webUrl } = issue.data.data.issue;
    const url = httpsLinkOnDomain(webUrl, "sentry.io");
    const event: TriggerEvent = {
      source: "sentry", type: "issue.created", eventKey: `sentry:issue:${String(id)}:created`, occurredAt, project: hook.project,
      subject: { kind: "issue", id: String(id), title: titleOf(title, String(id)), ...(url === undefined ? {} : { url }) },
      fields: { level: valuesOf([level]), environment: [] },
      // Rovara only reads Sentry (its connection is read-only), so no issue is Rovara's doing and there is no actor to guard against.
      actor: { kind: "unknown" },
    };
    return { events: [event] };
  }
  if (resource === "event_alert" && action === "triggered") {
    const alert = AlertTriggered.safeParse(body);
    const occurredAt = alert.success ? isoOfText(alert.data.data.event.datetime) : undefined;
    if (!alert.success || occurredAt === undefined) return { ignored: "an alert that can't be read" };
    const rule = alert.data.data.triggered_rule;
    const { event_id: eventId, title, level, web_url: webUrl } = alert.data.data.event;
    const url = httpsLinkOnDomain(webUrl, "sentry.io");
    const words = typeof title === "string" && title !== "" ? `${rule}: ${title}` : rule;
    const event: TriggerEvent = {
      source: "sentry", type: "alert.triggered", eventKey: `sentry:alert:${eventId}:${ruleKeyPart(rule)}`, occurredAt, project: hook.project,
      subject: { kind: "alert", id: eventId, title: titleOf(words, eventId), ...(url === undefined ? {} : { url }) },
      fields: { level: valuesOf([level]), environment: environmentOf(alert.data.data.event) },
      actor: { kind: "unknown" },
    };
    return { events: [event] };
  }
  return { ignored: "not an issue created or an alert triggered" };
}

export const sentryProvider: HookProvider = { source: "sentry", secretOrigin: "vendor", auth: "hmac", verify, normalize };
