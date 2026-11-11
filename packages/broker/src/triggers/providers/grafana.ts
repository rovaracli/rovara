// Grafana (Plan 4 Task 24): a webhook contact point sends `Authorization: <scheme> <credentials>` (Grafana's webhook notifier documentation: "Scheme for the Authorization Request Header.
// Default is Bearer"). The secret is one Rovara makes (`secretOrigin: "rovara"`), set as the credentials, and compared as digests in constant time (`tokenEquals`).
// Option added because the documentation shows it: Grafana's current webhook notifier also signs the body, HMAC-SHA256 in hex, in `X-Grafana-Alerting-Signature` (the header name is
// configurable there; the default is read). Its optional timestamp header changes what is signed (`timestamp:body`), and the page names no default header for it, so only the
// body-only form is accepted: leave the Timestamp Header empty. The same secret proves either way, so accepting both is no weaker than the token alone. The page names no Grafana
// version for the option.
// A body is believed only for the hook's own Grafana (the host of `externalURL`, https and no port, equals the hook's `host`), read first from every kind of body. Every alert with
// `status: "firing"` is one `alert.firing` event, keyed by its fingerprint and start (`grafana:<fingerprint>:<startsAt>`): a repeat notification of the same firing is a duplicate,
// and its `occurredAt` is that start, so a repeat of an alert that started more than 24 hours ago is dropped as stale by ingress, as the plan intends. An alert that can't be read is
// skipped, the others of the group are not. Rovara's Grafana connection is read-only, so there is no actor to guard against.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@rovara-code/contracts";
import { hmacHexEquals, tokenEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, httpsLinkOn, isoOfText, titleOf, valuesOf } from "./shared.js";

const BEARER = /^bearer +(\S.*)$/i;
const FINGERPRINT = /^[0-9A-Za-z_-]{1,64}$/;

const Group = z.object({ externalURL: z.string().max(2048), alerts: z.array(z.unknown()) }).passthrough();
const Alert = z.object({
  status: z.string(),
  fingerprint: z.string().regex(FINGERPRINT),
  startsAt: z.string(),
  labels: z.unknown().optional(),
  annotations: z.unknown().optional(),
  generatorURL: z.unknown().optional(),
}).passthrough();

function verify(raw: Buffer, headers: HookHeaders, secret: string): boolean {
  const bearer = BEARER.exec((headerOf(headers, "authorization") ?? "").trim())?.[1] ?? "";
  // Both are always worked out, so the work done does not say which of them a request used.
  const token = tokenEquals(bearer, secret);
  const signed = hmacHexEquals("sha256", raw, secret, headerOf(headers, "x-grafana-alerting-signature") ?? "");
  return token || signed;
}

const textMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

function normalize(body: unknown, _headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "grafana") return { tenantMismatch: true };
  const tenant = hook.tenant as { host: string };
  const group = Group.safeParse(body);
  const host = tenant.host.toLowerCase();
  if (!group.success || httpsLinkOn(group.data.externalURL, host) === undefined) return { tenantMismatch: true };
  const events: TriggerEvent[] = [];
  for (const candidate of group.data.alerts) {
    const alert = Alert.safeParse(candidate);
    if (!alert.success || alert.data.status !== "firing") continue;
    const occurredAt = isoOfText(alert.data.startsAt);
    if (occurredAt === undefined) continue;
    const labels = textMap(alert.data.labels);
    const summary = textMap(alert.data.annotations)["summary"];
    const name = labels["alertname"];
    const { fingerprint } = alert.data;
    const words = name !== undefined && summary !== undefined ? `${name}: ${summary}` : (summary ?? name);
    const url = httpsLinkOn(alert.data.generatorURL, host);
    events.push({
      source: "grafana", type: "alert.firing", eventKey: `grafana:${fingerprint}:${alert.data.startsAt}`, occurredAt, project: hook.project,
      subject: { kind: "alert", id: fingerprint, title: titleOf(words, fingerprint), ...(url === undefined ? {} : { url }) },
      fields: { label: valuesOf(Object.keys(labels).sort().map((key) => `${key}=${labels[key]!}`)) },
      actor: { kind: "unknown" },
    });
  }
  return events.length === 0 ? { ignored: "no alert is firing" } : { events };
}

export const grafanaProvider: HookProvider = {
  source: "grafana", secretOrigin: "rovara", auth: "token", verify, normalize,
  setup: {
    steps: [
      "In Grafana, open Alerting, Contact points and add a Webhook contact point with the address above as its URL.",
      "Under Optional Webhook settings, set the Authorization Header scheme to Bearer and its credentials to the secret.",
      "Or set the HMAC signature secret to the secret instead (SHA-256, the default header) and leave the Timestamp Header empty.",
      "Route the alert rules that should start work to this contact point.",
    ],
  },
};
