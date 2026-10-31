// Jira Cloud (Plan 4 Task 22): a webhook registered with a secret sends `X-Hub-Signature: sha256=<hex>`, the HMAC of the raw body under that secret (Atlassian's webhook
// documentation, "Secure admin webhooks"; the method is named in the header and only sha256 is accepted). The secret is Rovara's: it is shown once when the hook is made and
// pasted into Jira. A body is believed only for the hook's own site (the host of `issue.self`) and, when the hook names one, its project; only `jira:issue_created` and, for Rovara Code
// (meta repo lane F), `jira:issue_updated` becomes an event: a label ADDED to the issue is an `issue.labeled` event and an assignment is an `issue.assigned` event (read from the
// changelog's items; an update that changed neither is ignored). The label and the assignee are routing hints only: who did it (`user`) decides whether work starts, in intake.
// Atlassian's page gives `timestamp` as a 13-digit number without naming the unit; it is read as milliseconds. Its sample spells the user's key `accoundId`; the key Jira sends,
// and the one the connection check records, is `accountId`. The delivery's `X-Atlassian-Webhook-Identifier` is not used: the event key is the issue's id.
import { z } from "zod";
import { TRIGGER_SUBJECT_BODY_MAX, type HookRecord, type TriggerEvent } from "@agentx/contracts";
import { hmacHexEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, isoOfMillis, titleOf, valuesOf } from "./shared.js";

const SIGNATURE = /^sha256=([0-9a-f]+)$/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/;

const Envelope = z.object({ webhookEvent: z.string().max(100) }).passthrough();
const TenantOf = z.object({ issue: z.object({ self: z.string().max(2048), fields: z.object({ project: z.object({ key: z.string().max(100).optional() }).passthrough().optional() }).passthrough().optional() }).passthrough() }).passthrough();
const Created = z.object({
  timestamp: z.unknown(),
  user: z.object({ accountId: z.string().min(1).max(200).optional() }).passthrough().nullish(),
  issue: z.object({
    id: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
    key: z.string().max(100).optional(),
    fields: z.object({ summary: z.unknown().optional(), labels: z.unknown().optional(), issuetype: z.object({ name: z.unknown().optional() }).passthrough().nullish() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

const Updated = Created.extend({
  user: z.object({ accountId: z.string().min(1).max(200).optional(), accountType: z.string().max(40).optional() }).passthrough().nullish(),
  changelog: z.object({
    id: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]).optional(),
    // Plain records, read with `textOf`: an item may leave out `toString`, and a schema key of that name would read the inherited method of every object instead.
    items: z.array(z.record(z.string(), z.unknown())).max(200),
  }).passthrough(),
});

/** The most label events one update makes (someone who adds fifty labels at once does not start fifty events). */
const LABELS_PER_UPDATE_MAX = 5;
/** A label longer than this is not one a person set to ask for work; it also keeps the event key inside its limit. */
const LABEL_MAX = 100;
/** An own, text value of a changelog item, cut off at `max`; nothing for anything else (a missing key, a method, a number, a null). */
const textOf = (item: Record<string, unknown>, key: string, max: number): string | undefined => {
  const value = Object.hasOwn(item, key) ? item[key] : undefined;
  return typeof value === "string" && value.length <= max ? value : undefined;
};
const hasHiddenCharacters = (text: string): boolean => /[\p{Cc}\p{Cf}]/u.test(text);

function verify(raw: Buffer, headers: HookHeaders, secret: string): boolean {
  const match = SIGNATURE.exec((headerOf(headers, "x-hub-signature") ?? "").trim());
  return match !== null && hmacHexEquals("sha256", raw, secret, match[1]!);
}

/** Whether `self` is a plain https link on exactly the hook's site: no other scheme, user name, password or port, and the whole host, not a prefix of one. */
function onSite(self: string, siteHost: string): boolean {
  try {
    const url = new URL(self);
    return url.protocol === "https:" && url.hostname === siteHost && url.port === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function normalize(body: unknown, _headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "jira") return { tenantMismatch: true };
  const tenant = hook.tenant as { siteHost: string; projectKey?: string };
  const envelope = Envelope.safeParse(body);
  if (!envelope.success) return { tenantMismatch: true };
  const updated = envelope.data.webhookEvent === "jira:issue_updated";
  if (envelope.data.webhookEvent !== "jira:issue_created" && !updated) return { ignored: "not an issue created" };
  const site = TenantOf.safeParse(body);
  if (!site.success || !onSite(site.data.issue.self, tenant.siteHost)) return { tenantMismatch: true };
  if (tenant.projectKey !== undefined && site.data.issue.fields?.project?.key !== tenant.projectKey) return { tenantMismatch: true };
  if (updated) return normalizeUpdated(body, hook, tenant);
  const created = Created.safeParse(body);
  const occurredAt = created.success ? isoOfMillis(created.data.timestamp) : undefined;
  if (!created.success || occurredAt === undefined) return { ignored: "an issue that can't be read" };
  const { issue } = created.data;
  const id = String(issue.id);
  const key = issue.key !== undefined && ISSUE_KEY.test(issue.key) ? issue.key : undefined;
  const type = issue.fields?.issuetype?.name;
  const accountId = created.data.user?.accountId;
  const event: TriggerEvent = {
    source: "jira", type: "issue.created", eventKey: `jira:issue:${id}:created`, occurredAt, project: hook.project,
    subject: { kind: "issue", id: key ?? id, title: titleOf(issue.fields?.summary, key ?? id), ...(key === undefined ? {} : { url: `https://${tenant.siteHost}/browse/${key}` }) },
    fields: { label: valuesOf(issue.fields?.labels), issueType: valuesOf([type]) },
    actor: accountId === undefined ? { kind: "unknown" } : { kind: "external", id: accountId },
  };
  return { events: [event] };
}

/**
 * `jira:issue_updated`: the labels the update added and the assignee it set, each its own event. The description is carried (as text, cut) so an issue that asks for work can be handed to a
 * session; it is untrusted and is made safe where it is used. An update that changed neither a label nor the assignee is ignored.
 */
function normalizeUpdated(body: unknown, hook: HookRecord, tenant: { siteHost: string }): Normalized {
  const parsed = Updated.safeParse(body);
  const occurredAt = parsed.success ? isoOfMillis(parsed.data.timestamp) : undefined;
  if (!parsed.success || occurredAt === undefined) return { ignored: "an issue that can't be read" };
  const { issue, changelog } = parsed.data;
  const id = String(issue.id);
  const key = issue.key !== undefined && ISSUE_KEY.test(issue.key) ? issue.key : undefined;
  const change = String(changelog.id ?? parsed.data.timestamp);
  const accountId = parsed.data.user?.accountId;
  const description = issue.fields?.["description"];
  const subject: TriggerEvent["subject"] = {
    kind: "issue", id: key ?? id, title: titleOf(issue.fields?.summary, key ?? id), ...(key === undefined ? {} : { url: `https://${tenant.siteHost}/browse/${key}` }),
    ...(typeof description === "string" && description !== "" ? { body: description.slice(0, TRIGGER_SUBJECT_BODY_MAX) } : {}),
  };
  const actor: TriggerEvent["actor"] = accountId === undefined ? { kind: "unknown" } : { kind: "external", id: accountId, accountId, ...(parsed.data.user?.accountType === "app" ? { bot: true as const } : {}) };
  const events: TriggerEvent[] = [];
  for (const item of changelog.items) {
    const field = textOf(item, "field", 100);
    if (field === "labels") {
      const before = new Set((textOf(item, "fromString", 10_000) ?? "").split(/\s+/u).filter((label) => label !== ""));
      const added = [...new Set((textOf(item, "toString", 10_000) ?? "").split(/\s+/u).filter((label) => label !== "" && label.length <= LABEL_MAX && !before.has(label) && !hasHiddenCharacters(label)))];
      for (const label of added.slice(0, LABELS_PER_UPDATE_MAX)) {
        events.push({ source: "jira", type: "issue.labeled", eventKey: `jira:issue:${id}:labeled:${label}:${change}`, occurredAt, project: hook.project, subject, fields: { label: valuesOf([label]) }, actor });
      }
    } else if (field === "assignee") {
      const to = textOf(item, "to", LABEL_MAX);
      if (to === undefined || to === "" || hasHiddenCharacters(to)) continue;
      events.push({ source: "jira", type: "issue.assigned", eventKey: `jira:issue:${id}:assigned:${to}:${change}`, occurredAt, project: hook.project, subject, fields: { assignee: valuesOf([to]) }, actor });
    }
  }
  return events.length === 0 ? { ignored: "an update that asks for nothing" } : { events };
}

export const jiraProvider: HookProvider = { source: "jira", secretOrigin: "rovara", auth: "hmac", verify, normalize };
