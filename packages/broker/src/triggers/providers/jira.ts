// Jira Cloud (Plan 4 Task 22): a webhook registered with a secret sends `X-Hub-Signature: sha256=<hex>`, the HMAC of the raw body under that secret (Atlassian's webhook
// documentation, "Secure admin webhooks"; the method is named in the header and only sha256 is accepted). The secret is Rovara's: it is shown once when the hook is made and
// pasted into Jira. A body is believed only for the hook's own site (the host of `issue.self`) and, when the hook names one, its project; only `jira:issue_created` becomes an event.
// Atlassian's page gives `timestamp` as a 13-digit number without naming the unit; it is read as milliseconds. Its sample spells the user's key `accoundId`; the key Jira sends,
// and the one the connection check records, is `accountId`. The delivery's `X-Atlassian-Webhook-Identifier` is not used: the event key is the issue's id.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@agentx/contracts";
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
  if (envelope.data.webhookEvent !== "jira:issue_created") return { ignored: "not an issue created" };
  const site = TenantOf.safeParse(body);
  if (!site.success || !onSite(site.data.issue.self, tenant.siteHost)) return { tenantMismatch: true };
  if (tenant.projectKey !== undefined && site.data.issue.fields?.project?.key !== tenant.projectKey) return { tenantMismatch: true };
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

export const jiraProvider: HookProvider = { source: "jira", secretOrigin: "rovara", auth: "hmac", verify, normalize };
