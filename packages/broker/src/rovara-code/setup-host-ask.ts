// Setup host asks (design setup-test-health 3.3, task SH12): the setup run hit a website its machines cannot resolve, and an admin decides once, per project and host, whether the project may reach it.
//
// What this module owns:
//   - which hosts are refused WITHOUT a card (an address literal, a name that is not a plain host, paste, link-shortener, tunnel, webhook-sink and raw object-storage hosts, anything on the company's
//     production deny list, a name too long to be read whole on a card). The refusal list is fixed words and fixed suffixes; it is not repository text and no run can change it;
//   - one ask per host per project: a second request for the same host JOINS the open ask (it never makes a second card), and a refused host stays refused for a week;
//   - the card item (`setup_host`) the decision-card projector turns into a card, and the performer handlers that approve or refuse an ask;
//   - the approval. It adds NO authority of its own: it takes the project's existing website change (propose as the person whose run asked, then the approver's commit with the second-person rule
//     and the sole-owner exception, which plans the egress change through `planProjectEgressChange`, writes the new project revision and the audit in ONE transaction). Cloud's staff step is that
//     plan's own: the website stays pending until Rovara staff approve it.
//
// A host list is never a grant. Nothing here reads a list of blocked names and allows any of them: the DNS watch's names only become asks (`requestHostAsk`), and an ask grants nothing until a person
// approves it (design SH-3). Command output is never parsed for host names; the only source of a name is the DNS watch.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  DEFAULT_AGENT_ALLOW_DOMAINS, INDEX_EXPIRY_ATTRIBUTE, SetupHostSchema, agentXError, orgMemberKey, projectPk, prodDenyMatchesHost, type OrgId, type TestEnvProdDeny,
} from "@agentx/contracts";
import type { AuditRuntime } from "../audit/outbox.js";
import { commitReviewedProjectAllowedDomains, proposeProjectAllowedDomains, readProjectAllowedDomainsReview } from "../org/project-allowed-domains.js";
import type { DecisionItem } from "../decisions/project.js";
import { perform, type KindHandler } from "../decisions/performer.js";
import type { PerformInput, PerformOutcome } from "../decisions/routes.js";

type Row = Record<string, unknown>;
export interface HostAskTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }

/** How long a refused ask is remembered, so the same host does not come back as a new card every run. */
export const SETUP_HOST_REFUSED_MS = 7 * 86_400_000;
/** A host longer than this is refused: the card shows the whole name, and a long name can hide its end. */
export const SETUP_HOST_CARD_MAX = 70;
/** Open asks one project may hold at once (a bound on the listing; the run's own limit is lower). */
export const SETUP_HOST_OPEN_MAX = 20;
const STORE_TTL_S = 31 * 86_400;

// ---- refusals

export const SETUP_HOST_REFUSALS = ["not_a_host", "address_literal", "too_long", "paste_site", "link_shortener", "tunnel", "webhook_sink", "raw_storage", "production"] as const;
export type SetupHostRefusal = (typeof SETUP_HOST_REFUSALS)[number];

/** The fixed words a refusal is shown with (never a repository's or a model's words). */
export const SETUP_HOST_REFUSAL_WORDS: Record<SetupHostRefusal, string> = {
  not_a_host: "Not a plain website name.",
  address_literal: "An address, not a website name.",
  too_long: "The name is too long to show whole.",
  paste_site: "A paste or file-drop website.",
  link_shortener: "A link-shortener website.",
  tunnel: "A tunnel to a machine outside the company.",
  webhook_sink: "A website that collects whatever is sent to it.",
  raw_storage: "Storage or hosting that anyone can upload to.",
  production: "On the company's production deny list.",
};

/** Suffixes by kind. A host matches when it IS the suffix or ends with `.<suffix>`. */
const SUFFIXES: ReadonlyArray<readonly [Exclude<SetupHostRefusal, "not_a_host" | "address_literal" | "too_long" | "production">, readonly string[]]> = [
  ["paste_site", ["pastebin.com", "paste.ee", "hastebin.com", "dpaste.org", "dpaste.com", "0bin.net", "rentry.co", "ix.io", "termbin.com", "transfer.sh", "file.io", "anonfiles.com", "gofile.io", "catbox.moe", "temp.sh", "wetransfer.com"]],
  ["link_shortener", ["bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "t.ly", "tiny.cc", "s.id", "rb.gy", "v.gd"]],
  ["tunnel", ["ngrok.io", "ngrok.app", "ngrok-free.app", "ngrok.dev", "trycloudflare.com", "loca.lt", "localtunnel.me", "serveo.net", "pagekite.me", "tunnelmole.net", "lhr.life", "localhost.run", "playit.gg", "portmap.io"]],
  ["webhook_sink", ["webhook.site", "requestbin.com", "requestbin.net", "pipedream.net", "interact.sh", "oast.fun", "oast.live", "oast.me", "oast.online", "oast.pro", "oast.site", "burpcollaborator.net", "canarytokens.com", "beeceptor.com", "hookbin.com", "mockbin.org", "requestcatcher.com"]],
  ["raw_storage", ["blob.core.windows.net", "storage.googleapis.com", "r2.cloudflarestorage.com", "r2.dev", "digitaloceanspaces.com", "backblazeb2.com", "wasabisys.com", "s3.amazonaws.com", "amazonaws.com.cn", "firebasestorage.googleapis.com", "web.app", "firebaseapp.com", "workers.dev", "pages.dev", "netlify.app", "vercel.app", "herokuapp.com", "glitch.me", "repl.co", "replit.dev"]],
];

const IPV4_ALL_DIGITS = /^[0-9.]+$/u;

/**
 * Why a host is refused without a card, or undefined when it may be asked about. Pure and total: any text gives an answer. The checks, in order, are: not a plain DNS name (the contract's host shape), an
 * address literal (digits and dots, or a bracketed or hex-and-colon form), too long, the fixed suffix lists, then the company's production deny list. A name the contract cannot read is refused as
 * `not_a_host`, never passed on.
 */
export function refuseSetupHost(host: string, prodDeny?: TestEnvProdDeny): SetupHostRefusal | undefined {
  const lower = typeof host === "string" ? host.trim().toLowerCase().replace(/\.$/u, "") : "";
  if (lower === "") return "not_a_host";
  if (IPV4_ALL_DIGITS.test(lower) || lower.includes(":") || lower.startsWith("[") || /^0x[0-9a-f]+$/u.test(lower)) return "address_literal";
  if (!SetupHostSchema.safeParse(lower).success) return "not_a_host";
  if (lower.length > SETUP_HOST_CARD_MAX) return "too_long";
  for (const [kind, suffixes] of SUFFIXES) if (suffixes.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))) return kind;
  if (prodDeny !== undefined && prodDenyMatchesHost(prodDeny, lower)) return "production";
  return undefined;
}

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
  state: z.enum(SETUP_HOST_ASK_STATES), requestedBy: z.string().regex(/^[a-f0-9]{64}$/u), taskId: z.string().uuid().optional(),
  journalN: z.number().int().min(1).max(400).optional(),
  from: z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
  askedAt: z.string().datetime(), joined: z.number().int().min(0).max(1_000_000),
  decidedAt: z.string().datetime().optional(), decidedBy: z.string().optional(), refusalWords: z.string().max(200).optional(), resultRevision: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
}).passthrough();
export type SetupHostAsk = z.infer<typeof AskRowSchema>;

const askKey = (orgId: OrgId, project: string, host: string): { pk: string; sk: string } => ({ pk: projectPk(orgId, project), sk: `SETUP_HOST_ASK#${host}` });
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The website ask could not be read.");

async function readAsk(table: HostAskTable, orgId: OrgId, project: string, host: string): Promise<SetupHostAsk | undefined> {
  const raw = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: askKey(orgId, project, host), ConsistentRead: true })) as { Item?: Row }).Item;
  if (raw === undefined) return undefined;
  const parsed = AskRowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.project !== project || parsed.data.host !== host) throw unavailable();
  return parsed.data;
}

/** The asks of one project, newest first, at most `SETUP_HOST_OPEN_MAX` open ones (a damaged row is skipped, never guessed at). */
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
      if (parsed.success && parsed.data.orgId === orgId && parsed.data.project === project && states.includes(parsed.data.state) && !refusedAndExpired(parsed.data, table.now())) out.push(parsed.data);
    }
    start = result.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return out.sort((a, b) => b.askedAt.localeCompare(a.askedAt)).slice(0, SETUP_HOST_OPEN_MAX);
}
const refusedAndExpired = (ask: SetupHostAsk, nowMs: number): boolean => ask.state === "refused" && ask.expiresAt !== undefined && Date.parse(ask.expiresAt) <= nowMs;

// ---- asking

export type HostAskOutcome =
  | { outcome: "refused"; reason: SetupHostRefusal; words: string }
  | { outcome: "already_allowed" }
  | { outcome: "created" | "joined"; ask: SetupHostAsk }
  | { outcome: "refused_before"; ask: SetupHostAsk }
  | { outcome: "approved_before"; ask: SetupHostAsk }
  | { outcome: "too_many_open" };

export interface HostAskInput {
  orgId: OrgId; project: string; host: string; requestedBy: string;
  taskId?: string | undefined; journalN?: number | undefined; from?: { path: string; line: number } | undefined;
  /** The project's own allowed websites now (to say "already allowed"). */
  projectDomains: readonly string[];
  prodDeny?: TestEnvProdDeny | undefined;
}

/**
 * The setup run saw `host` blocked. Refused kinds make no card and no row. A host that is already reachable needs no ask. Otherwise the ask is created, or joined when one is open (the join only counts).
 * The conditional put makes two runs racing for the same host produce ONE row.
 */
export async function requestHostAsk(table: HostAskTable, input: HostAskInput): Promise<HostAskOutcome> {
  const host = input.host.trim().toLowerCase().replace(/\.$/u, "");
  const reason = refuseSetupHost(host, input.prodDeny);
  if (reason !== undefined) return { outcome: "refused", reason, words: SETUP_HOST_REFUSAL_WORDS[reason] };
  if (hostAlreadyAllowed(host, input.projectDomains)) return { outcome: "already_allowed" };
  const existing = await readAsk(table, input.orgId, input.project, host);
  if (existing !== undefined && !refusedAndExpired(existing, table.now())) {
    if (existing.state === "refused") return { outcome: "refused_before", ask: existing };
    if (existing.state === "approved") return { outcome: "approved_before", ask: existing };
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: askKey(input.orgId, input.project, host), UpdateExpression: "SET joined = joined + :one",
      ConditionExpression: "#state = :open", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":one": 1, ":open": "open" },
    })).catch((error: unknown) => { if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error; });
    const current = await readAsk(table, input.orgId, input.project, host);
    return current === undefined ? { outcome: "joined", ask: existing } : { outcome: "joined", ask: current };
  }
  if ((await listHostAsks(table, input.orgId, input.project)).length >= SETUP_HOST_OPEN_MAX) return { outcome: "too_many_open" };
  const nowMs = table.now();
  const row = AskRowSchema.parse({
    ...askKey(input.orgId, input.project, host), entityType: "SETUP_HOST_ASK", orgId: input.orgId, project: input.project, host, state: "open", requestedBy: input.requestedBy,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }), ...(input.journalN === undefined ? {} : { journalN: input.journalN }),
    ...(input.from === undefined ? {} : { from: { path: input.from.path.slice(0, 500), line: input.from.line } }),
    askedAt: new Date(nowMs).toISOString(), joined: 0, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + STORE_TTL_S,
  });
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName, Item: row,
      // A new row, or one that replaces an expired refusal. Never an open or approved row.
      ConditionExpression: "attribute_not_exists(pk) OR (#state = :refused AND expiresAt <= :now)", ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":refused": "refused", ":now": new Date(nowMs).toISOString() },
    }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    const raced = await readAsk(table, input.orgId, input.project, host);
    if (raced === undefined) throw unavailable();
    return raced.state === "open" ? { outcome: "joined", ask: raced } : raced.state === "approved" ? { outcome: "approved_before", ask: raced } : { outcome: "refused_before", ask: raced };
  }
  return { outcome: "created", ask: row };
}

// ---- the card item

/** A short id for the card: 32 hex of a hash of the project and host, so the id holds no dot or repository text. */
export const hostAskSubjectId = (orgId: string, project: string, host: string): string => createHash("sha256").update(`${orgId}\n${project}\n${host}`).digest("hex").slice(0, 32);

export function hostAskItem(ask: SetupHostAsk, input: { staffStep: boolean }): Extract<DecisionItem, { kind: "setup_host" }> {
  const subjectId = hostAskSubjectId(ask.orgId, ask.project, ask.host);
  const base = `/app/projects/${ask.project}`;
  return {
    kind: "setup_host", subjectId, project: ask.project, host: ask.host, staffStep: input.staffStep,
    ...(ask.taskId === undefined ? {} : { taskId: ask.taskId }), ...(ask.from === undefined ? {} : { from: ask.from }), ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }),
    title: `Allow ${ask.host}`, createdAt: ask.askedAt, openPath: `${base}/settings`, contentVersion: `${ask.host}@${ask.askedAt}`,
  };
}

export interface HostItemPorts extends HostAskTable {
  /** The projects the caller may approve asks for. */
  approvableProjects(who: { orgId: string; developerId: string }): Promise<readonly string[]>;
  /** Whether Rovara staff also approve a project's websites (Cloud). */
  staffStep: boolean;
}
/** The open asks the caller may decide, as card items. Bounded: at most 25 projects, `SETUP_HOST_OPEN_MAX` asks each. */
export async function hostAskItemsFor(ports: HostItemPorts, who: { orgId: string; developerId: string }): Promise<DecisionItem[]> {
  const projects = (await ports.approvableProjects(who)).slice(0, 25);
  const out: DecisionItem[] = [];
  for (const project of projects) {
    for (const ask of await listHostAsks(ports, who.orgId, project)) out.push(hostAskItem(ask, { staffStep: ports.staffStep }));
  }
  return out;
}

// ---- deciding

/** The company's rule for who approves a host: an admin (default) or a project maintainer. Locks can only move it to `admin` (SH29); this module reads the result. */
export type HostApprover = "admin" | "maintainer";
export interface HostDecisionDeps extends HostAskTable {
  signInTableName: string;
  audit?: AuditRuntime | undefined;
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

/** Deterministic UUID-shaped id for the project's website proposal made for this ask: the same ask always replays the same proposal. */
export function hostProposalId(ask: Pick<SetupHostAsk, "orgId" | "project" | "host" | "askedAt">): string {
  const h = createHash("sha256").update(`setup-host\n${ask.orgId}\n${ask.project}\n${ask.host}\n${ask.askedAt}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function settle(deps: HostDecisionDeps, input: HostDecisionInput, ask: SetupHostAsk, state: "approved" | "refused", extra: Row = {}): Promise<void> {
  const at = new Date(deps.now()).toISOString();
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: askKey(input.orgId, input.project, input.host),
      UpdateExpression: "SET #state = :next, decidedAt = :at, decidedBy = :by" + (state === "refused" ? ", expiresAt = :exp, refusalWords = :words" : "") + (extra["resultRevision"] === undefined ? "" : ", resultRevision = :rev"),
      ConditionExpression: "#state = :open AND askedAt = :asked", ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":next": state, ":at": at, ":by": input.by, ":open": "open", ":asked": ask.askedAt,
        ...(state === "refused" ? { ":exp": new Date(deps.now() + SETUP_HOST_REFUSED_MS).toISOString(), ":words": typeof extra["words"] === "string" ? extra["words"] : "A person refused it." } : {}),
        ...(extra["resultRevision"] === undefined ? {} : { ":rev": extra["resultRevision"] }),
      },
    }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    // Someone settled it first: the idempotent answer is whatever is stored.
  }
}

export type HostApproval = { state: "applied"; resultRevision: number; mode: "second_person" | "sole_owner_exception"; staffPending: boolean } | { state: "already_allowed" };

/**
 * An admin approves the ask for `host`. The ask must be open; the host is checked against the refusal list AGAIN (the list or the deny list may have changed since the ask); then the project's website change
 * runs: the person whose run asked proposes (their live authority is read again), the approver commits (second-person rule, sole-owner exception only when acknowledged, audit, egress plan, new revision
 * in one transaction). The ask becomes `approved` only after the commit. A failure leaves the ask open; a proposal that was made stays pending (24 hours) and the next press replays it.
 * `soleOwnerAcknowledged` is never set by a card press: a company with one admin approves on the project's website page, where the exception is spelled out.
 */
export async function approveHostAsk(deps: HostDecisionDeps, input: HostDecisionInput & { soleOwnerAcknowledged?: boolean | undefined }): Promise<HostApproval> {
  if (!z.string().uuid().safeParse(input.requestId).success) throw agentXError("CONFIG_INVALID", "Review a valid request id.");
  const host = input.host.trim().toLowerCase();
  await requireApprover(deps, input.orgId, input.by);
  const ask = await readAsk(deps, input.orgId, input.project, host);
  if (ask === undefined || ask.state === "refused") throw agentXError("CHANGE_STALE", "This website ask is no longer open.");
  const prodDeny = deps.prodDeny === undefined ? undefined : await deps.prodDeny(input.orgId, input.project);
  const refusal = refuseSetupHost(host, prodDeny);
  if (refusal !== undefined) { await settle(deps, { ...input, host }, ask, "refused", { words: SETUP_HOST_REFUSAL_WORDS[refusal] }); throw agentXError("FORBIDDEN", SETUP_HOST_REFUSAL_WORDS[refusal]); }
  const dependencies = { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.signInTableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  const review = await readProjectAllowedDomainsReview(dependencies, { orgId: input.orgId, project: input.project, by: input.by });
  if (hostAlreadyAllowed(host, review.allowedDomains)) {
    if (ask.state === "open") await settle(deps, { ...input, host }, ask, "approved");
    return { state: "already_allowed" };
  }
  const proposalId = hostProposalId(ask);
  // One live website proposal per project: another person's waiting change is decided first; this ask's own earlier proposal is replayed below.
  if (review.liveProposal !== null && review.liveProposal.proposal.proposalId !== proposalId && review.liveProposal.status === "pending") throw agentXError("CHANGE_STALE", "Another website change is waiting. Decide it first.");
  const after = [...new Set([...review.allowedDomains, host])].sort();
  if (after.length > 50) throw agentXError("CONFIG_INVALID", "At most 50 project website rules are allowed.");
  const proposal = await proposeProjectAllowedDomains(dependencies, {
    orgId: input.orgId, project: input.project, by: ask.requestedBy,
    body: { requestId: proposalId, expectedRevision: review.baseRevision, allowedDomains: after, expectedContextDigest: review.contextDigest },
  });
  if (proposal.state !== "pending" || proposal.afterDomains.join(",") !== after.join(",")) throw agentXError("CHANGE_STALE", "Another website change is waiting. Decide it first.");
  const receipt = await commitReviewedProjectAllowedDomains(dependencies, {
    orgId: input.orgId, project: input.project, by: input.by,
    body: { requestId: input.requestId, proposalId, soleOwnerAcknowledged: input.soleOwnerAcknowledged === true },
  });
  await settle(deps, { ...input, host }, ask, "approved", { resultRevision: receipt.resultRevision });
  return { state: "applied", resultRevision: receipt.resultRevision, mode: receipt.mode, staffPending: true };
}

/** A person refuses the ask: the host stays refused for a week, no card comes back, and nothing about the project's websites changes. Needs the same approver as an approval. */
export async function refuseHostAsk(deps: HostDecisionDeps, input: HostDecisionInput): Promise<void> {
  const host = input.host.trim().toLowerCase();
  await requireApprover(deps, input.orgId, input.by);
  const ask = await readAsk(deps, input.orgId, input.project, host);
  if (ask === undefined || ask.state !== "open") throw agentXError("CHANGE_STALE", "This website ask is no longer open.");
  await settle(deps, { ...input, host }, ask, "refused", { words: "A person refused it." });
}

/** The state a setup run reads to learn whether its ask was answered: `open`, `approved` (still waits for staff on Cloud), or `refused`. Undefined when there is none. */
export async function hostAskState(table: HostAskTable, orgId: OrgId, project: string, host: string): Promise<SetupHostAsk["state"] | undefined> {
  const ask = await readAsk(table, orgId, project, host.trim().toLowerCase());
  return ask === undefined || refusedAndExpired(ask, table.now()) ? undefined : ask.state;
}

// ---- the card's performer handler

type HostItem = Extract<DecisionItem, { kind: "setup_host" }>;
/**
 * `setup_host`: approve runs `approveHostAsk` and reject runs `refuseHostAsk`, as the caller. A card press never acknowledges the sole-owner exception (that is spelled out on the project's website page), so a
 * company with one admin gets the refusal and opens that page. Every refusal of the endpoint (not a company admin, a changed project, a second person needed) is the card's `forbidden` or `stale`.
 */
export function setupHostHandler<C extends { orgId: string; developerId: string }>(deps: HostDecisionDeps): KindHandler<C> {
  const run = (kind: "approve" | "refuse") => (caller: C, input: PerformInput): Promise<PerformOutcome> => perform(async () => {
    const item = input.item as HostItem;
    if (item.kind !== "setup_host") return { kind: "refused", reason: "unsupported" };
    const scope = { orgId: caller.orgId, project: item.project, host: item.host, by: caller.developerId, requestId: input.requestId };
    if (kind === "approve") await approveHostAsk(deps, scope);
    else await refuseHostAsk(deps, scope);
    return { kind: "done" };
  });
  return { approve: run("approve"), reject: run("refuse") };
}
