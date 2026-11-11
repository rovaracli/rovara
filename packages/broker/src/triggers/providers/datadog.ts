// Datadog (Plan 4 Task 24): Datadog's webhooks are not signed. Its documentation ("Webhooks integration") offers HTTP basic auth in the URL, OAuth 2.0, and custom headers (JSON), and
// names no signature, so the proof is a secret Rovara makes (`secretOrigin: "rovara"`), sent in the custom header `X-Rovara-Hook-Token` and compared as digests in constant time
// (`tokenEquals`). The payload is whatever the person pastes into the webhook's Payload box, so hook creation hands over the exact template (`DATADOG_PAYLOAD_TEMPLATE`).
// What the documentation says of the variables: `$DATE` is the event time in epoch MILLISECONDS (the plan says only "from `date`"; an ISO time is read too), `$ALERT_TRANSITION` is
// `Triggered`, `Re-Triggered`, `Recovered`, `No Data`, `Re-No Data`, `Warn`, `Re-Warn` or `Renotify` (only `Triggered` starts work), `$PRIORITY` is `normal` or `low`, `$TAGS` is a
// comma-separated list (`monitor, name:myService`; each is trimmed), `$ORG_ID` is the Datadog organisation. The documentation does not say how a variable holding a quote is escaped in
// a JSON payload, so the template holds none of the free-text ones; a body that still is not JSON answers 400 after its token verified (check against a live alert in the staging round).
// A body is believed only for the hook's own Datadog organisation (`orgId`), read first from every kind of body. Rovara's Datadog connection is read-only, so no monitor is Rovara's
// doing and there is no actor to guard against.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@rovara-code/contracts";
import { tokenEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, httpsLinkOnAnyDomain, isoOfInstant, titleOf, valuesOf } from "./shared.js";

export const DATADOG_TOKEN_HEADER = "X-Rovara-Hook-Token";
/** The payload the person pastes into Datadog's webhook, exactly. Datadog puts a variable into the JSON as it is, with no escaping, so no variable that holds text a person wrote (`$EVENT_TITLE`, `$EVENT_MSG`) is
 * in it: a quote or backslash in a monitor's name would break the body and the event would be lost. The title of the run is the alert id (a body from the older template that still carries `title` keeps it),
 * and `$LINK` leads to the monitor. A tag is limited by Datadog to letters, digits and `_ - : . /`, so `$TAGS` can't hold a quote or backslash. */
export const DATADOG_PAYLOAD_TEMPLATE = '{"id":"$ID","date":"$DATE","transition":"$ALERT_TRANSITION","alertId":"$ALERT_ID","priority":"$PRIORITY","tags":"$TAGS","link":"$LINK","orgId":"$ORG_ID"}';
/** The domains of Datadog's sites (the connection's own list: datadoghq.com and its regions, datadoghq.eu, and the government sites). */
const DATADOG_DOMAINS = ["datadoghq.com", "datadoghq.eu", "ddog-gov.com"] as const;

const OrgOf = z.object({ orgId: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]) }).passthrough();
const Monitor = z.object({
  id: z.string().min(1).max(100),
  date: z.unknown(),
  transition: z.unknown(),
  alertId: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
  title: z.unknown().optional(),
  priority: z.unknown().optional(),
  tags: z.unknown().optional(),
  link: z.unknown().optional(),
}).passthrough();

function verify(_raw: Buffer, headers: HookHeaders, secret: string): boolean {
  return tokenEquals(headerOf(headers, DATADOG_TOKEN_HEADER) ?? "", secret);
}

function normalize(body: unknown, _headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "datadog") return { tenantMismatch: true };
  const tenant = hook.tenant as { datadogOrgId: string };
  const org = OrgOf.safeParse(body);
  if (!org.success || String(org.data.orgId) !== tenant.datadogOrgId) return { tenantMismatch: true };
  const monitor = Monitor.safeParse(body);
  if (!monitor.success || monitor.data.transition !== "Triggered") return { ignored: "not a monitor triggered" };
  const occurredAt = isoOfInstant(monitor.data.date);
  if (occurredAt === undefined) return { ignored: "a monitor that can't be read" };
  const { id, title, priority, tags, link } = monitor.data;
  const alertId = String(monitor.data.alertId);
  const url = httpsLinkOnAnyDomain(link, DATADOG_DOMAINS);
  const event: TriggerEvent = {
    source: "datadog", type: "monitor.triggered", eventKey: `dd:${id}`, occurredAt, project: hook.project,
    subject: { kind: "alert", id: alertId, title: titleOf(title, alertId), ...(url === undefined ? {} : { url }) },
    fields: { priority: valuesOf([priority]), tag: valuesOf(typeof tags === "string" ? tags.split(",").map((tag) => tag.trim()) : []) },
    actor: { kind: "unknown" },
  };
  return { events: [event] };
}

export const datadogProvider: HookProvider = {
  source: "datadog", secretOrigin: "rovara", auth: "token", verify, normalize,
  setup: {
    steps: [
      "In Datadog, open Integrations, Webhooks and add a webhook with the address above as its URL.",
      "Under Custom Variables, add a variable named ROVARA_HOOK_TOKEN whose value is the secret, and mark it hidden, so the token is not shown in Datadog's webhook settings.",
      `Set Custom Headers to {"${DATADOG_TOKEN_HEADER}": "$ROVARA_HOOK_TOKEN"}. Datadog does not sign webhooks, so this token is the proof of the sender.`,
      "Leave Encode as form off, and set the Payload to exactly the template below.",
      "Add the webhook as @webhook-<its name> to the monitors that should start work.",
    ],
    payloadTemplate: DATADOG_PAYLOAD_TEMPLATE,
  },
};
