// PagerDuty (Plan 4 Task 23): a v3 webhook subscription signs each delivery with `X-PagerDuty-Signature`, one or more comma-separated `v1=<hex>` values, each the hex HMAC-SHA256 of the raw body
// under the subscription's secret; any one that matches proves the sender (PagerDuty's "Verifying webhook signatures": more than one value is sent during a secret rotation, the raw
// body must not be altered, and the comparison must be constant-time). The secret is PagerDuty's, pasted in by the person. A body is believed only for the hook's own account (the
// host of the incident's link is `<subdomain>.pagerduty.com`) and, when the hook names services, one of them; only `incident.triggered` becomes an event.
// The documentation gives no sample for `incident.triggered`; the fields read are the envelope's (`event.id`, `event_type`, `occurred_at`) and the shared incident schema's (`id`,
// `html_url`, `title`, `urgency`, `service`). PagerDuty's sample code splits the header on a bare comma, which leaves a space on the second value; each value is trimmed here.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@rovara-code/contracts";
import { hmacHexEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, httpsLinkOn, isoOfText, titleOf, valuesOf } from "./shared.js";

/** How many signatures of one header are tried: a rotation sends two, so a longer list is a hostile one, and each costs an HMAC. */
const SIGNATURES_MAX = 10;
const SIGNATURE = /^v1=([0-9a-f]+)$/i;

const Envelope = z.object({ event: z.object({ event_type: z.string().max(100) }).passthrough() }).passthrough();
const TenantOf = z.object({ event: z.object({ data: z.object({ html_url: z.string().max(2048), service: z.object({ id: z.unknown().optional() }).passthrough().nullish() }).passthrough() }).passthrough() }).passthrough();
const Incident = z.object({
  event: z.object({
    id: z.string().min(1).max(100),
    occurred_at: z.unknown(),
    data: z.object({
      id: z.string().min(1).max(100),
      title: z.unknown().optional(),
      urgency: z.unknown().optional(),
      service: z.object({ summary: z.unknown().optional() }).passthrough().nullish(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

function verify(raw: Buffer, headers: HookHeaders, secret: string): boolean {
  let proven = false;
  // Every value is checked, with no early exit, so the work done does not say which of them matched.
  for (const part of (headerOf(headers, "x-pagerduty-signature") ?? "").split(",").slice(0, SIGNATURES_MAX)) {
    const match = SIGNATURE.exec(part.trim());
    if (match !== null && hmacHexEquals("sha256", raw, secret, match[1]!)) proven = true;
  }
  return proven;
}

function normalize(body: unknown, _headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "pagerduty") return { tenantMismatch: true };
  const tenant = hook.tenant as { subdomain: string; serviceIds?: string[] };
  const envelope = Envelope.safeParse(body);
  if (!envelope.success) return { tenantMismatch: true };
  // Other events (resolved, acknowledged, the test ping) carry no account link of the same kind to check, and none starts work.
  if (envelope.data.event.event_type !== "incident.triggered") return { ignored: "not an incident triggered" };
  const account = TenantOf.safeParse(body);
  const link = account.success ? httpsLinkOn(account.data.event.data.html_url, `${tenant.subdomain}.pagerduty.com`) : undefined;
  if (!account.success || link === undefined) return { tenantMismatch: true };
  const serviceId = account.data.event.data.service?.id;
  if (tenant.serviceIds !== undefined && (typeof serviceId !== "string" || !tenant.serviceIds.includes(serviceId))) return { tenantMismatch: true };
  const incident = Incident.safeParse(body);
  const occurredAt = incident.success ? isoOfText(incident.data.event.occurred_at) : undefined;
  if (!incident.success || occurredAt === undefined) return { ignored: "an incident that can't be read" };
  const { event } = incident.data;
  const event_: TriggerEvent = {
    source: "pagerduty", type: "incident.triggered", eventKey: `pd:${event.id}`, occurredAt, project: hook.project,
    subject: { kind: "incident", id: event.data.id, title: titleOf(event.data.title, event.data.id), url: link },
    fields: { urgency: valuesOf([event.data.urgency]), service: valuesOf([event.data.service?.summary]) },
    // Rovara only reads PagerDuty (its connection is read-only), so no incident is Rovara's doing and there is no actor to guard against.
    actor: { kind: "unknown" },
  };
  return { events: [event_] };
}

export const pagerdutyProvider: HookProvider = { source: "pagerduty", secretOrigin: "vendor", auth: "hmac", verify, normalize };
