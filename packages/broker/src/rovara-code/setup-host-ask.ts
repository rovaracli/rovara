// Setup host asks (design setup-test-health 3.3, task SH12): the setup run hit a website its machines cannot resolve, and an admin decides once, per project and host, whether the project may reach it.
//
// What this module owns:
//   - which hosts are refused WITHOUT a card (an address literal, a name that carries an address, a private name, a name that is not plain ASCII host characters, paste, link-shortener, tunnel,
//     webhook-collector and open-hosting suffixes, anything on the company's production deny list, a name too long to be read whole on a card). The refusal list is fixed words and fixed suffixes; it is
//     not repository text and no run can change it. Every refusal is counted per run and kind;
//   - one ask per host per project: a second request for the same host JOINS the open ask (it only counts), and a refused host stays refused for a week. The ask says WHO asked, and that is the person the
//     BROKER recorded as the run's starter: `requestHostAsk` reads the run's own task record and takes nothing about a person from its caller (SH14 precondition: the worker's request only names the task
//     it authenticated as, never a person);
//   - the card item (`setup_host`) the decision-card projector turns into a card, and the performer handler that approves or refuses an ask;
//   - the approval. It adds NO authority of its own: it takes the project's existing website change (propose as the person who started the run, then the approver's commit with the second-person rule
//     and the sole-owner exception, which plans the egress change through `planProjectEgressChange`, writes the new project revision and the audit in ONE transaction). The audit shows who actually
//     pressed (`pressedBy`) and where the change came from (`origin=setup_host_ask`, the ask id). Cloud's staff step is that plan's own: the website stays pending until Rovara staff approve it.
//     A card press without a live browser session decides nothing (it answers the project's website page), and the press is rate limited with the website change's own buckets.
//
// A host list is never a grant. Nothing here reads a list of blocked names and allows any of them: the DNS watch's names only become asks (`requestHostAsk`), and an ask grants nothing until a person
// approves it (design SH-3). Command output is never parsed for host names; the only source of a name is the DNS watch.
//
// Stored (all in the project's own partition unless said): `SETUP_HOST_ASK#<host>` the ask; `SETUP_HOST_OPEN_COUNT` the number of open asks (the cap); `SETUP_HOST_REFUSED#<task>#<kind>` the per-run
// count of hosts refused without a card; and, in `SETUP_HOST_OPEN#<org>`, one index row per open ask so the cards of a whole company are one read, however many projects it has.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  DEFAULT_AGENT_ALLOW_DOMAINS, INDEX_EXPIRY_ATTRIBUTE, SetupHostSchema, agentXError, orgMemberKey, orgScoped, projectPk, prodDenyMatchesHost, type OrgId, type TestEnvProdDeny,
} from "@agentx/contracts";
import { auditPending, type AuditRuntime } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditOccurrence, auditSetupHostAsked, auditSetupHostRefused } from "../audit/events.js";
import { failedIndexes } from "../agents/table-writes.js";
import { commitReviewedProjectAllowedDomains, decideProjectAllowedDomainProposal, proposeProjectAllowedDomains, readProjectAllowedDomainsReview } from "../org/project-allowed-domains.js";
import { decideSecondPersonApproval } from "../org/second-person-approval.js";
import { readAllowedDomainActorConditions, readSecondPersonApprovalEvidence } from "../org/second-person-evidence.js";
import { takeRateAt } from "../developer/page-comments.js";
import { livePersonLabel } from "../agent-sessions/live-steer.js";
import { taskKey } from "../developer/task-records.js";
import type { DecisionItem } from "../decisions/project.js";
import { perform, type KindHandler } from "../decisions/performer.js";
import type { PerformInput, PerformOutcome } from "../decisions/routes.js";

type Row = Record<string, unknown>;
export interface HostAskTable {
  documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number;
  /** The Audit Ledger's outbox. Absent on a legacy install, where nothing is recorded (as every audited action there). */
  audit?: AuditRuntime;
}

/** How long a refused ask is remembered, so the same host does not come back as a new card every run. */
export const SETUP_HOST_REFUSED_MS = 7 * 86_400_000;
/** A host longer than this is refused: the card shows the whole name, and a long name can hide its end. */
export const SETUP_HOST_CARD_MAX = 70;
/** Open asks one project may hold at once, enforced by a counter row with a conditional write. */
export const SETUP_HOST_OPEN_MAX = 20;
/** The most a join counts: the counter is bounded by a conditional write, not by trust. */
export const SETUP_HOST_JOIN_MAX = 1_000;
/** The most index rows one company listing reads (five pages of 100). */
export const SETUP_HOST_INDEX_MAX = 500;
const STORE_TTL_S = 31 * 86_400;

/** The fixed sentence for an ask whose requester can no longer change the project's websites. */
export const SETUP_HOST_REQUESTER_GONE = "The person who asked can no longer change this project's websites.";

// ---- refusals

export const SETUP_HOST_REFUSALS = ["not_a_host", "address_literal", "ip_in_name", "private_name", "too_long", "paste_site", "link_shortener", "tunnel", "webhook_sink", "raw_storage", "production"] as const;
export type SetupHostRefusal = (typeof SETUP_HOST_REFUSALS)[number];

/** The fixed words a refusal is shown with (never a repository's or a model's words). */
export const SETUP_HOST_REFUSAL_WORDS: Record<SetupHostRefusal, string> = {
  not_a_host: "Not a plain website name.",
  address_literal: "An address, not a website name.",
  ip_in_name: "A name that stands for an address.",
  private_name: "A name that only means something inside one network.",
  too_long: "The name is too long to show whole.",
  paste_site: "A paste or file-drop website.",
  link_shortener: "A link-shortener website.",
  tunnel: "A tunnel to a machine outside the company.",
  webhook_sink: "A website that collects whatever is sent to it.",
  raw_storage: "Storage or hosting that anyone can upload to.",
  production: "On the company's production deny list.",
};

type SuffixKind = "paste_site" | "link_shortener" | "tunnel" | "webhook_sink" | "raw_storage" | "ip_in_name";
/** Suffixes by kind. A host matches when it IS the suffix or ends with `.<suffix>`. */
const SUFFIXES: ReadonlyArray<readonly [SuffixKind, readonly string[]]> = [
  ["paste_site", ["pastebin.com", "paste.ee", "hastebin.com", "dpaste.org", "dpaste.com", "0bin.net", "rentry.co", "ix.io", "termbin.com", "transfer.sh", "file.io", "anonfiles.com", "gofile.io", "catbox.moe", "temp.sh", "wetransfer.com", "ntfy.sh"]],
  ["link_shortener", ["bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "t.ly", "tiny.cc", "s.id", "rb.gy", "v.gd"]],
  ["tunnel", ["ngrok.io", "ngrok.app", "ngrok-free.app", "ngrok-free.dev", "ngrok.dev", "trycloudflare.com", "loca.lt", "localtunnel.me", "serveo.net", "pagekite.me", "tunnelmole.net", "lhr.life", "localhost.run", "playit.gg", "portmap.io", "devtunnels.ms", "bore.pub", "zrok.io", "ts.net", "pinggy.io", "ngrok.com", "duckdns.org", "ddns.net", "no-ip.org", "no-ip.biz", "no-ip.com", "hopto.org", "zapto.org", "sytes.net", "myftp.org"]],
  ["webhook_sink", ["webhook.site", "requestbin.com", "requestbin.net", "pipedream.net", "interact.sh", "oast.fun", "oast.live", "oast.me", "oast.online", "oast.pro", "oast.site", "oastify.com", "burpcollaborator.net", "canarytokens.com", "beeceptor.com", "hookbin.com", "mockbin.org", "requestcatcher.com", "dnslog.cn", "ceye.io", "requestrepo.com"]],
  ["raw_storage", [
    "blob.core.windows.net", "storage.googleapis.com", "r2.cloudflarestorage.com", "r2.dev", "digitaloceanspaces.com", "backblazeb2.com", "wasabisys.com", "s3.amazonaws.com", "amazonaws.com.cn", "firebasestorage.googleapis.com",
    "web.app", "firebaseapp.com", "workers.dev", "pages.dev", "netlify.app", "vercel.app", "herokuapp.com", "glitch.me", "repl.co", "replit.dev",
    "cloudfront.net", "github.io", "azurewebsites.net", "fly.dev", "onrender.com", "surge.sh", "ipfs.io", "gitlab.io", "bitbucket.io", "appspot.com", "azurestaticapps.net",
  ]],
  // A name that resolves to whatever address its first labels spell: a way to name any machine.
  ["ip_in_name", ["nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "vcap.me", "rbndr.us", "1u.ms"]],
];
/** `raw.` and `gist.` of GitHub's user-content host: anyone's file (the host itself is a regex so the outbound inventory keeps its one owner for the name). */
const GITHUB_USER_FILES = /^(?:raw|gist)\.githubusercontent\.com$/u;
/** `<id>.lambda-url.<region>.on.aws`: a function URL anyone can create. */
const LAMBDA_URL = /(?:^|\.)lambda-url\.[a-z0-9-]+\.on\.aws$/u;
/** Last labels that name no public website: they mean something only inside one network (or are reserved). */
const PRIVATE_LAST_LABELS: ReadonlySet<string> = new Set(["localhost", "local", "internal", "lan", "arpa", "onion", "test", "example", "invalid", "corp", "localdomain", "intranet", "home", "svc"]);
/** The cloud metadata name (the host itself and anything under it). */
const PRIVATE_SUFFIXES: readonly string[] = ["metadata.goog"];
/** Four numbers joined by dots or dashes anywhere in the name (`10-0-0-5.example.com`, `10.0.0.5.example.com`). */
const IP_IN_NAME = /(?:^|[.-])\d{1,3}([.-])\d{1,3}\1\d{1,3}\1\d{1,3}(?:$|[.-])/u;
const IPV4_ALL_DIGITS = /^[0-9.]+$/u;
/** Plain host characters only, checked on the text AS GIVEN (before it is lower-cased: `K` with a Kelvin sign lower-cases to `k`). */
const ASCII_HOST = /^[A-Za-z0-9.-]+$/u;

const coveredBySuffix = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`);

/**
 * Why a host is refused without a card, or undefined when it may be asked about. Pure and total: any text gives an answer. The checks, in order: a colon (an IPv6 address is an `address_literal`, a
 * `host:port` or a URL is `not_a_host`), anything but ASCII letters, digits, dots and hyphens in the text as given, an address in digits, a private last label, the contract's host shape, the length,
 * an address in the name, the fixed suffix lists, then the company's production deny list. A name that is not understood is refused, never passed on.
 */
export function refuseSetupHost(host: string, prodDeny?: TestEnvProdDeny): SetupHostRefusal | undefined {
  if (typeof host !== "string") return "not_a_host";
  const raw = host.endsWith(".") ? host.slice(0, -1) : host;
  if (raw === "") return "not_a_host";
  if (raw.startsWith("[") || (raw.match(/:/gu) ?? []).length >= 2) return "address_literal";
  if (raw.includes(":")) return IPV4_ALL_DIGITS.test(raw.slice(0, raw.indexOf(":"))) ? "address_literal" : "not_a_host";
  if (!ASCII_HOST.test(raw)) return "not_a_host";
  const lower = raw.toLowerCase();
  if (IPV4_ALL_DIGITS.test(lower) || /^0x[0-9a-f]+$/u.test(lower)) return "address_literal";
  const labels = lower.split(".");
  if (PRIVATE_LAST_LABELS.has(labels[labels.length - 1]!) || PRIVATE_SUFFIXES.some((suffix) => coveredBySuffix(lower, suffix))) return "private_name";
  // A dynamic-DNS name (`<name>.ddns.<anything>`) points wherever its owner says.
  if (labels.includes("ddns")) return "tunnel";
  if (!SetupHostSchema.safeParse(lower).success) return "not_a_host";
  if (lower.length > SETUP_HOST_CARD_MAX) return "too_long";
  if (IP_IN_NAME.test(lower)) return "ip_in_name";
  if (LAMBDA_URL.test(lower) || GITHUB_USER_FILES.test(lower)) return "raw_storage";
  for (const [kind, suffixes] of SUFFIXES) if (suffixes.some((suffix) => coveredBySuffix(lower, suffix))) return kind;
  if (prodDeny !== undefined && prodDenyMatchesHost(prodDeny, lower)) return "production";
  return undefined;
}

/** Whether any label is punycode (`xn--`): the card says "international name", because it may look like another name. */
export const isInternationalName = (host: string): boolean => host.split(".").some((label) => label.startsWith("xn--"));

/** A wildcard entry (`*.example.com`) covers subdomains only, as the DNS firewall reads it. */
function listCovers(list: readonly string[], host: string): boolean {
  return list.some((entry) => { const e = entry.toLowerCase(); return e.startsWith("*.") ? host.endsWith(e.slice(1)) && host.length > e.length - 1 : host === e; });
}
/** Whether the host is already reachable by default or by the project's own list (so no ask is needed). */
export function hostAlreadyAllowed(host: string, projectDomains: readonly string[]): boolean {
  return listCovers(DEFAULT_AGENT_ALLOW_DOMAINS, host) || listCovers(projectDomains, host);
}

// ---- the stored ask

export const SETUP_HOST_ASK_STATES = ["open", "approved", "refused"] as const;
const AskRowSchema = z.object({
  entityType: z.literal("SETUP_HOST_ASK"), orgId: z.string(), project: z.string(), host: SetupHostSchema,
  state: z.enum(SETUP_HOST_ASK_STATES), requestedBy: z.string().regex(/^[a-f0-9]{64}$/u), taskId: z.string().uuid(),
  journalN: z.number().int().min(1).max(400).optional(),
  from: z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
  askedAt: z.string().datetime(), joined: z.number().int().min(0).max(1_000_000),
  /** The person who typed the command (in a setup run's "Run a command" box) whose blocked website led to this ask. Set by the broker from its own record of that command, never from the worker. */
  typedBy: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  decidedAt: z.string().datetime().optional(), decidedBy: z.string().optional(), refusalWords: z.string().max(200).optional(), resultRevision: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
}).passthrough();
export type SetupHostAsk = z.infer<typeof AskRowSchema>;

const askKey = (orgId: OrgId, project: string, host: string): { pk: string; sk: string } => ({ pk: projectPk(orgId, project), sk: `SETUP_HOST_ASK#${host}` });
const countKey = (orgId: OrgId, project: string): { pk: string; sk: string } => ({ pk: projectPk(orgId, project), sk: "SETUP_HOST_OPEN_COUNT" });
const indexKey = (orgId: OrgId, project: string, host: string): { pk: string; sk: string } => ({ pk: orgScoped(orgId, "SETUP_HOST_OPEN"), sk: `${project}#${host}` });
const refusedCountKey = (orgId: OrgId, project: string, taskId: string, kind: SetupHostRefusal): { pk: string; sk: string } => ({ pk: projectPk(orgId, project), sk: `SETUP_HOST_REFUSED#${taskId}#${kind}` });
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The website ask could not be read.");
const isConditionalFailure = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** The id an ask has in the audit and on its card: a hash of the company, project and host (no dot, no repository text). */
export const hostAskSubjectId = (orgId: string, project: string, host: string): string => createHash("sha256").update(`${orgId}\n${project}\n${host}`).digest("hex").slice(0, 32);

async function readAsk(table: HostAskTable, orgId: OrgId, project: string, host: string): Promise<SetupHostAsk | undefined> {
  const raw = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: askKey(orgId, project, host), ConsistentRead: true })) as { Item?: Row }).Item;
  if (raw === undefined) return undefined;
  const parsed = AskRowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.project !== project || parsed.data.host !== host) throw unavailable();
  return parsed.data;
}

/** A row whose store lifetime has passed (the table deletes it some time later): it is no longer an ask, whatever its state says. */
const rowExpired = (row: Row, nowMs: number): boolean => typeof row[INDEX_EXPIRY_ATTRIBUTE] === "number" && row[INDEX_EXPIRY_ATTRIBUTE] <= nowMs / 1000;
const refusedAndExpired = (ask: SetupHostAsk, nowMs: number): boolean => ask.state === "refused" && ask.expiresAt !== undefined && Date.parse(ask.expiresAt) <= nowMs;

/** The asks of one project, newest first (a damaged row is skipped, never guessed at). */
export async function listHostAsks(table: HostAskTable, orgId: OrgId, project: string, states: readonly SetupHostAsk["state"][] = ["open"]): Promise<SetupHostAsk[]> {
  const out: SetupHostAsk[] = [];
  let start: Row | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": "SETUP_HOST_ASK#" },
      ConsistentRead: true, Limit: 100, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Row[]; LastEvaluatedKey?: Row };
    for (const raw of result.Items ?? []) {
      const parsed = AskRowSchema.safeParse(raw);
      if (parsed.success && parsed.data.orgId === orgId && parsed.data.project === project && states.includes(parsed.data.state) && !refusedAndExpired(parsed.data, table.now()) && !rowExpired(raw, table.now())) out.push(parsed.data);
    }
    start = result.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return out.sort((a, b) => b.askedAt.localeCompare(a.askedAt));
}

/** How many hosts a run was refused without a card, by kind (a fixed vocabulary: the run's summary shows counts, never names). */
export async function refusedCountsOf(table: HostAskTable, orgId: OrgId, project: string, taskId: string): Promise<Partial<Record<SetupHostRefusal, number>>> {
  const out: Partial<Record<SetupHostRefusal, number>> = {};
  const counts = await Promise.all(SETUP_HOST_REFUSALS.map(async (kind) => {
    const item = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: refusedCountKey(orgId, project, taskId, kind), ConsistentRead: true })) as { Item?: Row }).Item;
    return [kind, typeof item?.["count"] === "number" ? item["count"] : 0] as const;
  }));
  for (const [kind, count] of counts) if (count > 0) out[kind] = count;
  return out;
}

// ---- the run an ask belongs to

/**
 * The person the BROKER recorded as the run's starter, from the run's own task record: the setup-run task of this company and project, started by `startedBy` (a start on someone's behalf) or its
 * creator. Undefined for any task that is not such a run. This is the only source of an ask's requester: no worker, payload or request names a person.
 */
export async function setupRunStarterOf(table: Pick<HostAskTable, "documentClient" | "tableName">, orgId: OrgId, project: string, taskId: string, options: { requireRunning?: boolean } = {}): Promise<string | undefined> {
  if (!z.string().uuid().safeParse(taskId).success) return undefined;
  const task = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: Row }).Item;
  if (task === undefined || task["purpose"] !== "setup_agent" || task["orgId"] !== orgId || task["project"] !== project) return undefined;
  // A NEW ask comes from a run that is going: a closed or ended run asks nothing (an approval of an earlier ask does not need the run to be going).
  if (options.requireRunning === true && (task["closedAt"] !== undefined || task["agentRunEnd"] !== undefined || task["setupAgentResult"] !== undefined)) return undefined;
  const startedBy = (task["startedBy"] as { developerId?: unknown } | undefined)?.developerId;
  const starter = typeof startedBy === "string" ? startedBy : task["developerId"];
  return typeof starter === "string" && /^[a-f0-9]{64}$/u.test(starter) ? starter : undefined;
}

// ---- asking

export type HostAskOutcome =
  | { outcome: "refused"; reason: SetupHostRefusal; words: string }
  | { outcome: "no_run" }
  | { outcome: "already_allowed" }
  | { outcome: "created" | "joined"; ask: SetupHostAsk }
  | { outcome: "refused_before"; ask: SetupHostAsk }
  | { outcome: "too_many_open" };

/**
 * What a request to ask is. There is NO requester here: the person comes from the run's task record (`setupRunStarterOf`). `taskId` is the run the caller is authenticated as (SH14: the operation's
 * task, never a field of the worker's body).
 */
export interface HostAskInput {
  orgId: OrgId; project: string; host: string; taskId: string;
  journalN?: number | undefined; from?: { path: string; line: number } | undefined;
  /** The project's own allowed websites now (to say "already allowed"). */
  projectDomains: readonly string[];
  prodDeny?: TestEnvProdDeny | undefined;
  /** The person who typed the command that hit the blocked website, when one did: filled in by the broker from its own stored command (the worker names only the command's place), never from a payload. */
  typedBy?: string | undefined;
}

async function countRefusal(table: HostAskTable, input: HostAskInput, kind: SetupHostRefusal): Promise<void> {
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName, Key: refusedCountKey(input.orgId, input.project, input.taskId, kind), UpdateExpression: "ADD #count :one SET entityType = :type, #expires = :expires",
    ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":one": 1, ":type": "SETUP_HOST_REFUSED", ":expires": Math.floor(table.now() / 1000) + STORE_TTL_S },
  })).catch(() => undefined);
}

/**
 * The setup run saw `host` blocked. A task that is not this company's setup run asks nothing. Refused kinds make no card and no ask row, only a per-run count. A host that is already reachable needs
 * no ask. Otherwise the ask is created (with the open-asks counter, the company index row and the audit, in one transaction), or joined when one is open (the join only counts, up to a bound). Two runs
 * racing for a new host make one row; the 21st open ask of a project is `too_many_open`, by a conditional write on the counter.
 */
export async function requestHostAsk(table: HostAskTable, input: HostAskInput): Promise<HostAskOutcome> {
  const requestedBy = await setupRunStarterOf(table, input.orgId, input.project, input.taskId, { requireRunning: true });
  if (requestedBy === undefined) return { outcome: "no_run" };
  const host = typeof input.host === "string" ? (input.host.endsWith(".") ? input.host.slice(0, -1) : input.host) : "";
  const reason = refuseSetupHost(host, input.prodDeny);
  if (reason !== undefined) { await countRefusal(table, input, reason); return { outcome: "refused", reason, words: SETUP_HOST_REFUSAL_WORDS[reason] }; }
  const name = host.toLowerCase();
  if (hostAlreadyAllowed(name, input.projectDomains)) return { outcome: "already_allowed" };
  let recounted = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await readAsk(table, input.orgId, input.project, name);
    const nowMs = table.now();
    // An approved ask whose host is no longer covered (the project's list moved on) does not block a new ask; an expired refusal neither.
    const replaceable = existing === undefined || refusedAndExpired(existing, nowMs) || existing.state === "approved" || rowExpired(existing, nowMs);
    if (!replaceable && existing !== undefined) {
      if (existing.state === "refused") return { outcome: "refused_before", ask: existing };
      // Open: join. The count is bounded by a conditional write; at the bound the join is simply not counted.
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: askKey(input.orgId, input.project, name), UpdateExpression: "SET joined = joined + :one",
        ConditionExpression: "#state = :open AND joined < :max", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":one": 1, ":open": "open", ":max": SETUP_HOST_JOIN_MAX },
      })).catch((error: unknown) => { if (!isConditionalFailure(error)) throw error; });
      const current = await readAsk(table, input.orgId, input.project, name);
      return { outcome: "joined", ask: current ?? existing };
    }
    const row = AskRowSchema.parse({
      ...askKey(input.orgId, input.project, name), entityType: "SETUP_HOST_ASK", orgId: input.orgId, project: input.project, host: name, state: "open", requestedBy, taskId: input.taskId,
      ...(input.journalN === undefined ? {} : { journalN: input.journalN }), ...(input.from === undefined ? {} : { from: { path: input.from.path.slice(0, 500), line: input.from.line } }),
      ...(input.typedBy === undefined ? {} : { typedBy: input.typedBy }),
      askedAt: new Date(nowMs).toISOString(), joined: 0, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + STORE_TTL_S,
    });
    const event = auditSetupHostAsked({
      orgId: input.orgId, actor: { kind: "system", id: "rovara" }, occurredAt: row.askedAt, occurrence: auditOccurrence(input.project, hostAskSubjectId(input.orgId, input.project, name), row.askedAt),
      projectName: input.project, askId: hostAskSubjectId(input.orgId, input.project, name), taskId: input.taskId, journalN: input.journalN, host: name, onBehalfOf: requestedBy, ...(input.typedBy === undefined ? {} : { typedBy: input.typedBy }),
    });
    const pending = auditPending(table, event);
    try {
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: [
        // 0: the ask. A new row, an expired refusal, or an approved one whose host is not covered now. Never an open row.
        { Put: { TableName: table.tableName, Item: row, ConditionExpression: "attribute_not_exists(pk) OR (#state = :refused AND expiresAt <= :now) OR #state = :approved OR #ttl <= :nowSec", ExpressionAttributeNames: { "#state": "state", "#ttl": INDEX_EXPIRY_ATTRIBUTE },
          ExpressionAttributeValues: { ":refused": "refused", ":approved": "approved", ":now": new Date(nowMs).toISOString(), ":nowSec": Math.floor(nowMs / 1000) } } },
        // 1: the cap.
        { Update: { TableName: table.tableName, Key: countKey(input.orgId, input.project), UpdateExpression: "SET #open = if_not_exists(#open, :zero) + :one, entityType = :type, #ttl = :ttl",
          ConditionExpression: "attribute_not_exists(#open) OR #open < :max", ExpressionAttributeNames: { "#open": "open", "#ttl": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":max": SETUP_HOST_OPEN_MAX, ":type": "SETUP_HOST_OPEN_COUNT", ":ttl": Math.floor(nowMs / 1000) + STORE_TTL_S } } },
        // 2: the company index.
        { Put: { TableName: table.tableName, Item: { ...indexKey(input.orgId, input.project, name), entityType: "SETUP_HOST_OPEN", orgId: input.orgId, project: input.project, host: name, ask: row, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + STORE_TTL_S } } },
        ...pending,
      ] }));
    } catch (error) {
      const failed = failedIndexes(error);
      if (failed === undefined) throw error;
      if (failed.has(1)) {
        // The counter says full. Asks that expired from the table were never subtracted, so before refusing it is counted again from the asks that are really open; a counter that was too high is set right
        // (only if nobody moved it meanwhile) and the ask is tried again.
        if (!recounted && await recountOpenAsks(table, input.orgId, input.project)) { recounted = true; continue; }
        return { outcome: "too_many_open" };
      }
      if (failed.has(0)) continue; // raced: read again and join
      continue;
    }
    await flushAuditEvents(table, [event]);
    return { outcome: "created", ask: row };
  }
  throw unavailable();
}

/**
 * Sets the project's open-asks counter to the number of asks that are really open (rows still in the table and not expired), when that is LESS than the counter says. The write holds only while the counter
 * is what was read, so a concurrent create or settle wins. Answers whether the counter was lowered.
 */
async function recountOpenAsks(table: HostAskTable, orgId: OrgId, project: string): Promise<boolean> {
  const seen = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: countKey(orgId, project), ConsistentRead: true })) as { Item?: Row }).Item?.["open"];
  if (typeof seen !== "number") return false;
  const real = (await listHostAsks(table, orgId, project, ["open"])).length;
  if (real >= seen) return false;
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: countKey(orgId, project), UpdateExpression: "SET #open = :real, #ttl = :ttl", ConditionExpression: "#open = :seen",
      ExpressionAttributeNames: { "#open": "open", "#ttl": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":real": real, ":seen": seen, ":ttl": Math.floor(table.now() / 1000) + STORE_TTL_S },
    }));
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

// ---- the card item

export function hostAskItem(ask: SetupHostAsk, input: { staffStep: boolean; /** SH30: the company already approved this host through a recipe the project's setup used. A mark on the card; it grants nothing. */ companyApproved?: boolean }): Extract<DecisionItem, { kind: "setup_host" }> {
  const subjectId = hostAskSubjectId(ask.orgId, ask.project, ask.host);
  // The project page, which holds "Allowed websites" (there is no `/settings` page for a project in the app).
  const base = `/app/projects/${encodeURIComponent(ask.project)}`;
  return {
    kind: "setup_host", subjectId, project: ask.project, host: ask.host, staffStep: input.staffStep, international: isInternationalName(ask.host), ...(input.companyApproved === true ? { companyApproved: true as const } : {}), taskId: ask.taskId, ...(ask.typedBy === undefined ? {} : { typedBy: livePersonLabel(ask.typedBy) }),
    ...(ask.from === undefined ? {} : { from: ask.from }), ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }),
    title: `Allow ${ask.host}`, createdAt: ask.askedAt, openPath: base, contentVersion: `${ask.host}@${ask.askedAt}${input.companyApproved === true ? "+recipe" : ""}`,
  };
}

export interface HostItemPorts extends HostAskTable {
  /** The projects the caller may approve asks for. */
  approvableProjects(who: { orgId: string; developerId: string }): Promise<readonly string[]>;
  /** Whether Rovara staff also approve a project's websites (Cloud). */
  staffStep: boolean;
  /** SH30 (switch `sp`): the hosts of a project its company approved through a recipe the project's setup used (`companyApprovedHostMarks`). A mark for the card only. Errors are the port's to absorb. */
  companyApproved?: ((orgId: OrgId, project: string) => Promise<ReadonlyMap<string, unknown>>) | undefined;
  /** Decision journey slice 2: the page of the setup run's task (its session, so the card's link names the card there), or undefined to keep the project page. Errors are the port's to absorb. */
  taskPagePathOf?: ((taskId: string) => Promise<string | undefined>) | undefined;
}
/**
 * The open asks the caller may decide, as card items: ONE read of the company's index of open asks (however many projects it has), then the projects the caller may approve for. At most
 * `SETUP_HOST_INDEX_MAX` asks are read; a row that does not read back is skipped.
 */
export async function hostAskItemsFor(ports: HostItemPorts, who: { orgId: string; developerId: string }): Promise<DecisionItem[]> {
  const allowed = new Set(await ports.approvableProjects(who));
  if (allowed.size === 0) return [];
  const orgId = who.orgId;
  const out: DecisionItem[] = [];
  const marks = new Map<string, Promise<ReadonlyMap<string, unknown>>>();
  const marksOf = (project: string): Promise<ReadonlyMap<string, unknown>> => {
    if (ports.companyApproved === undefined) return Promise.resolve(new Map());
    if (!marks.has(project)) marks.set(project, ports.companyApproved(orgId, project).catch(() => new Map()));
    return marks.get(project)!;
  };
  let start: Row | undefined;
  let read = 0;
  for (let page = 0; page < SETUP_HOST_INDEX_MAX / 100; page += 1) {
    const result = await ports.documentClient.send(new QueryCommand({
      TableName: ports.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": orgScoped(orgId, "SETUP_HOST_OPEN") }, ConsistentRead: true, Limit: 100, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Row[]; LastEvaluatedKey?: Row };
    for (const item of result.Items ?? []) {
      read += 1;
      const parsed = AskRowSchema.safeParse(item["ask"]);
      if (rowExpired(item, ports.now()) || !parsed.success || parsed.data.orgId !== orgId || parsed.data.state !== "open" || !allowed.has(parsed.data.project) || item["project"] !== parsed.data.project || item["host"] !== parsed.data.host) continue;
      const ask = hostAskItem(parsed.data, { staffStep: ports.staffStep, companyApproved: (await marksOf(parsed.data.project)).has(parsed.data.host) });
      const page = ports.taskPagePathOf === undefined ? undefined : await ports.taskPagePathOf(parsed.data.taskId).catch(() => undefined);
      out.push(page === undefined ? ask : { ...ask, openPath: page });
    }
    start = result.LastEvaluatedKey;
    if (start === undefined || read >= SETUP_HOST_INDEX_MAX) break;
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- deciding

/** The company's rule for who approves a host: an admin (default) or a project maintainer. Locks can only move it to `admin` (SH29); this module reads the result. */
export type HostApprover = "admin" | "maintainer";
export interface HostDecisionDeps extends HostAskTable {
  signInTableName: string;
  hostApprover?: ((orgId: OrgId) => Promise<HostApprover>) | undefined;
  prodDeny?: ((orgId: OrgId, project: string) => Promise<TestEnvProdDeny | undefined>) | undefined;
}
export interface HostDecisionInput { orgId: OrgId; project: string; host: string; by: string; requestId: string }

async function requireApprover(deps: HostDecisionDeps, orgId: OrgId, by: string): Promise<void> {
  const setting = deps.hostApprover === undefined ? "admin" : await deps.hostApprover(orgId);
  if (setting === "maintainer") return; // the website change itself still demands a live project maintainer or company admin
  const member = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, by), ConsistentRead: true })) as { Item?: Row }).Item;
  if (member === undefined || (member.role !== "owner" && member.role !== "admin")) throw agentXError("FORBIDDEN", "A company admin approves new websites for setup.");
}

/** The website change's own request budget (the same buckets as `project-allowed-domains-http.ts`), taken for a host approval. */
async function takeWebsiteBudget(deps: HostDecisionDeps, orgId: OrgId, by: string): Promise<void> {
  const buckets = [{ key: "ALLOWED_WEBSITE_MUTATIONS", actor: by, limit: 10 }, { key: "ALLOWED_WEBSITE_ORG_MUTATIONS", actor: "ALL", limit: 60 }];
  for (const bucket of buckets) {
    let accepted: boolean;
    try { accepted = await takeRateAt(deps, { pk: orgScoped(orgId, bucket.key), sk: bucket.actor }, bucket.limit, 60_000); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", "The website request budget could not be checked."); }
    if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many website requests. Try again later.");
  }
}

/** Deterministic UUID-shaped id for the project's website proposal made for this ask at this project revision: the same ask at the same revision always replays the same proposal. */
export function hostProposalId(ask: Pick<SetupHostAsk, "orgId" | "project" | "host" | "askedAt">, baseRevision: number): string {
  const h = createHash("sha256").update(`setup-host\n${ask.orgId}\n${ask.project}\n${ask.host}\n${ask.askedAt}\n${String(baseRevision)}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Settles an open ask: the ask row, its company index row, the project's open counter and (for a refusal) the audit, in one transaction. A condition on the ask (still open, same ask) makes the first
 * settle stand: a second one changes nothing.
 */
async function settle(deps: HostDecisionDeps, input: HostDecisionInput, ask: SetupHostAsk, state: "approved" | "refused", extra: { words?: string; resultRevision?: number; reason?: string; expireNow?: boolean } = {}): Promise<void> {
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  const askId = hostAskSubjectId(input.orgId, input.project, ask.host);
  const event = state === "refused"
    ? auditSetupHostRefused({ orgId: input.orgId, actor: { kind: "member", id: input.by }, occurredAt: at, occurrence: auditOccurrence(input.project, askId, ask.askedAt, "refused"), projectName: input.project, askId, refusal: extra.reason ?? "person", host: ask.host })
    : undefined;
  const pending = event === undefined ? [] : auditPending(deps, event);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: deps.tableName, Key: askKey(input.orgId, input.project, ask.host),
        UpdateExpression: "SET #state = :next, decidedAt = :at, decidedBy = :by" + (state === "refused" ? ", expiresAt = :exp, refusalWords = :words" : "") + (extra.resultRevision === undefined ? "" : ", resultRevision = :rev"),
        ConditionExpression: "#state = :open AND askedAt = :asked", ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":next": state, ":at": at, ":by": input.by, ":open": "open", ":asked": ask.askedAt,
          ...(state === "refused" ? { ":exp": new Date(extra.expireNow === true ? nowMs : nowMs + SETUP_HOST_REFUSED_MS).toISOString(), ":words": extra.words ?? "A person refused it." } : {}),
          ...(extra.resultRevision === undefined ? {} : { ":rev": extra.resultRevision }),
        },
      } },
      { Delete: { TableName: deps.tableName, Key: indexKey(input.orgId, input.project, ask.host) } },
      { Update: { TableName: deps.tableName, Key: countKey(input.orgId, input.project), UpdateExpression: "SET #ttl = :ttl ADD #open :minus", ExpressionAttributeNames: { "#open": "open", "#ttl": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":minus": -1, ":ttl": Math.floor(nowMs / 1000) + STORE_TTL_S } } },
      ...pending,
    ] }));
  } catch (error) {
    const failed = failedIndexes(error);
    // Someone settled it first: the idempotent answer is whatever is stored.
    if (failed !== undefined && failed.has(0)) return;
    throw error;
  }
  if (event !== undefined) await flushAuditEvents(deps, [event]);
}

export type HostApproval = { state: "applied"; resultRevision: number; mode: "second_person" | "sole_owner_exception"; staffPending: boolean } | { state: "already_allowed" };

const isCode = (error: unknown, ...codes: string[]): boolean => typeof error === "object" && error !== null && "code" in error && codes.includes(String((error).code));

/**
 * An admin approves the ask for `host`. The ask must be OPEN and belong to a setup run the broker recorded (its task's starter is the ask's requester); the host is checked against the refusal list AGAIN
 * (the list or the deny list may have changed since the ask); the website change's request budget is taken. Then, before anything is written, the commit's own conditions are read: the requester's and
 * the approver's live authority and the second-person decision (with the sole-owner exception only when acknowledged, which a card press never does), so a press that cannot commit writes nothing. Then
 * the person who started the run proposes and the approver commits (one transaction: egress plan, new revision, audit with `origin`, ask id and `pressedBy`). The ask becomes `approved` only after the
 * commit. A requester who can no longer change the project's websites settles the ask with a fixed sentence.
 */
export async function approveHostAsk(deps: HostDecisionDeps, input: HostDecisionInput & { soleOwnerAcknowledged?: boolean | undefined }): Promise<HostApproval> {
  if (!z.string().uuid().safeParse(input.requestId).success) throw agentXError("CONFIG_INVALID", "Review a valid request id.");
  const host = input.host.trim().toLowerCase();
  await requireApprover(deps, input.orgId, input.by);
  const ask = await readAsk(deps, input.orgId, input.project, host);
  if (ask === undefined || ask.state !== "open") throw agentXError("CHANGE_STALE", "This website ask is no longer open.");
  // The ask names a run; the run's record names who started it. They must agree, or the row is not one the broker wrote.
  if ((await setupRunStarterOf(deps, input.orgId, input.project, ask.taskId)) !== ask.requestedBy) throw agentXError("FORBIDDEN", "This website ask does not match its setup run.");
  await takeWebsiteBudget(deps, input.orgId, input.by);
  const prodDeny = deps.prodDeny === undefined ? undefined : await deps.prodDeny(input.orgId, input.project);
  const refusal = refuseSetupHost(host, prodDeny);
  if (refusal !== undefined) { await settle(deps, { ...input, host }, ask, "refused", { words: SETUP_HOST_REFUSAL_WORDS[refusal], reason: refusal }); throw agentXError("FORBIDDEN", SETUP_HOST_REFUSAL_WORDS[refusal]); }
  const dependencies = { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.signInTableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  const review = await readProjectAllowedDomainsReview(dependencies, { orgId: input.orgId, project: input.project, by: input.by });
  if (hostAlreadyAllowed(host, review.allowedDomains)) {
    await settle(deps, { ...input, host }, ask, "approved");
    return { state: "already_allowed" };
  }
  const proposalId = hostProposalId(ask, review.baseRevision);
  // One live website proposal per project: another person's waiting change is decided first; this ask's own earlier proposal is replayed below.
  if (review.liveProposal !== null && review.liveProposal.proposal.proposalId !== proposalId && review.liveProposal.status === "pending") throw agentXError("CHANGE_STALE", "Another website change is waiting. Decide it first.");
  const after = [...new Set([...review.allowedDomains, host])].sort();
  if (after.length > 50) throw agentXError("CONFIG_INVALID", "At most 50 project website rules are allowed.");
  // The person who started the run must still be able to change this project's websites; if not, no approve button can ever work, so the ask is settled with a fixed sentence.
  try { await readAllowedDomainActorConditions(dependencies, { orgId: input.orgId, project: input.project, actorId: ask.requestedBy }); }
  catch (error) {
    if (isCode(error, "FORBIDDEN")) { await settle(deps, { ...input, host }, ask, "refused", { words: SETUP_HOST_REQUESTER_GONE, reason: "requester_gone", expireNow: true }); throw agentXError("FORBIDDEN", SETUP_HOST_REQUESTER_GONE); }
    throw error;
  }
  // The commit's own checks, read first: nothing is written by a press that cannot commit.
  await readAllowedDomainActorConditions(dependencies, { orgId: input.orgId, project: input.project, actorId: input.by });
  const evidence = await readSecondPersonApprovalEvidence(dependencies, { orgId: input.orgId, project: input.project, proposerId: ask.requestedBy, approverId: input.by });
  const decision = decideSecondPersonApproval(evidence.decisionInput);
  if (decision.mode === "sole_owner_exception" && input.soleOwnerAcknowledged !== true) throw agentXError("FORBIDDEN", "Explicitly acknowledge the sole-owner website exception.");
  // The audit shows who pressed, who started the run (the proposer) and, when a person's own command hit the website, who typed it: each of them, even when they are the same person.
  const auditDetails = { origin: "setup_host_ask", askId: hostAskSubjectId(input.orgId, input.project, host), pressedBy: input.by, ...(ask.typedBy === undefined ? {} : { typedBy: ask.typedBy }) };
  const asStale = (error: unknown): never => { throw isCode(error, "IDEMPOTENCY_CONFLICT") ? agentXError("CHANGE_STALE", "This website ask changed. Review it again.") : error; };
  const proposal = await proposeProjectAllowedDomains(dependencies, {
    orgId: input.orgId, project: input.project, by: ask.requestedBy, auditDetails,
    body: { requestId: proposalId, expectedRevision: review.baseRevision, allowedDomains: after, expectedContextDigest: review.contextDigest },
  }).catch(asStale);
  if (proposal.state !== "pending" || proposal.afterDomains.join(",") !== after.join(",")) throw agentXError("CHANGE_STALE", "Another website change is waiting. Decide it first.");
  const receipt = await commitReviewedProjectAllowedDomains(dependencies, {
    orgId: input.orgId, project: input.project, by: input.by, auditDetails,
    body: { requestId: input.requestId, proposalId, soleOwnerAcknowledged: input.soleOwnerAcknowledged === true },
  }).catch(asStale);
  await settle(deps, { ...input, host }, ask, "approved", { resultRevision: receipt.resultRevision });
  return { state: "applied", resultRevision: receipt.resultRevision, mode: receipt.mode, staffPending: true };
}

/** A person refuses the ask: the host stays refused for a week, no card comes back, and nothing about the project's websites changes. Needs the same approver as an approval. Audited (`setup.host_refused`) in the same transaction. */
export async function refuseHostAsk(deps: HostDecisionDeps, input: HostDecisionInput): Promise<void> {
  const host = input.host.trim().toLowerCase();
  await requireApprover(deps, input.orgId, input.by);
  const ask = await readAsk(deps, input.orgId, input.project, host);
  if (ask === undefined || ask.state !== "open") throw agentXError("CHANGE_STALE", "This website ask is no longer open.");
  // An earlier press whose commit failed may have left this ask's own website proposal pending (it blocks every other website change for a day). "Not now" ends it, as a rejection by the person refusing.
  // Best effort: a proposal that cannot be ended does not stop the refusal, and it lapses by itself.
  await rejectLeftoverProposal(deps, input, ask).catch(() => undefined);
  await settle(deps, { ...input, host }, ask, "refused", { words: "A person refused it.", reason: "person" });
}

async function rejectLeftoverProposal(deps: HostDecisionDeps, input: HostDecisionInput, ask: SetupHostAsk): Promise<void> {
  const dependencies = { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.signInTableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  const review = await readProjectAllowedDomainsReview(dependencies, { orgId: input.orgId, project: input.project, by: input.by });
  const live = review.liveProposal;
  if (live === null || live.status !== "pending" || live.proposal.proposalId !== hostProposalId(ask, review.baseRevision)) return;
  await decideProjectAllowedDomainProposal(dependencies, {
    orgId: input.orgId, project: input.project, by: input.by,
    body: { requestId: input.requestId, proposalId: live.proposal.proposalId, decision: "reject", reason: "Not now (setup website ask)" },
  });
}

/** The state a setup run reads to learn whether its ask was answered: `open`, `approved` (still waits for staff on Cloud), or `refused`. Undefined when there is none. */
export async function hostAskState(table: HostAskTable, orgId: OrgId, project: string, host: string): Promise<SetupHostAsk["state"] | undefined> {
  const ask = await readAsk(table, orgId, project, host.trim().toLowerCase());
  return ask === undefined || refusedAndExpired(ask, table.now()) ? undefined : ask.state;
}

// ---- the card's performer handler

type HostItem = Extract<DecisionItem, { kind: "setup_host" }>;
/** A caller of a card press: the person and whether the web boundary authenticated them with a live browser session. */
export interface HostPressCaller { orgId: string; developerId: string; browserSession?: true | undefined }

/**
 * `setup_host`. APPROVE needs a live browser session, as the project's own website change does: a press from Slack or with a token decides nothing and answers the project's website page (`needs_confirmation`
 * with an https address on `webOrigin`). Reject only ever makes things stricter and needs no session. A card press never acknowledges the sole-owner exception, so a company with one admin gets the
 * refusal and finishes on that page. Every refusal of the endpoint (not a company admin, a changed project, a second person needed) is the card's `forbidden` or `stale`.
 */
export function setupHostHandler<C extends HostPressCaller>(deps: HostDecisionDeps, options: { webOrigin: string }): KindHandler<C> {
  const run = (kind: "approve" | "refuse") => (caller: C, input: PerformInput): Promise<PerformOutcome> => perform(async () => {
    const item = input.item as HostItem;
    if (item.kind !== "setup_host") return { kind: "refused", reason: "unsupported" };
    if (kind === "approve" && caller.browserSession !== true) {
      return { kind: "needs_confirmation", confirmUrl: `${options.webOrigin.replace(/\/+$/u, "")}/app/projects/${encodeURIComponent(item.project)}` };
    }
    const scope = { orgId: caller.orgId, project: item.project, host: item.host, by: caller.developerId, requestId: input.requestId };
    if (kind === "approve") await approveHostAsk(deps, scope);
    else await refuseHostAsk(deps, scope);
    return { kind: "done" };
  });
  return { approve: run("approve"), reject: run("refuse") };
}
