// The Team record's source rows, written from the app (learning v2 design 4.2 to 4.4, source-row lane task 2): `POST /v1/app/projects/{project}/record/sources` with one of
//   add      a new source row, for a place that belongs to THIS project (resolved here, never taken from the body);
//   change   retention, who sees it, on/off, the exclusion list, the Public edition's notes opt-in; names the revision it read and loses cleanly to any other writer;
//   remove   deletes the row and, with it, that place's data (one transaction queues the deletion; see `saveRemove`).
// and the admin read, `GET .../record/sources` for a person who may edit (`sourcesAdminView`).
//
// WHO. A company owner or admin, or a maintainer of this project (`projectRole` is the effective role the broker already found, and admins count as maintainers there), on a live browser
// session. The Auditor and everyone below maintainer are refused; a person with no role in the project gets the missing-project answer.
// NO SECOND PERSON (owner decision 2026-11-04, task 9). Every editor's change applies at once, in both editions, and is audited. A write that WIDENS what is kept (a retention raise, adding
// above the edition default, a private channel, a DM or a group DM) says so in the audit event's `widened` fact, and is refused when that audit item cannot be written (the audit is its only control).
// This replaces the earlier waiting-change flow (`SRCCHG#`, approve and reject). Slack Connect stays refused, DMs stay Enterprise only, Public Slack stays at A, or B with the notes opt-in.
// EVERY WRITE is one transaction: the row, its scope claim, the request item that makes a repeat answer the same, and the audit item. Refusals are fixed codes and
// sentences; nothing a client sent (a place, an id, a word) is echoed.
import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, canonicalJson, type OrgId } from "@rovara-code/contracts";
import { SOURCE_WIDENED_WORDS, parseSlackPlaceInput, scopeAndAncestors, SourceConfigSchema, SourceWriteBodySchema, SourcesAdminViewSchema, isWriterOrgRole, recordScopeMarkerKey, recordSourceKey, type AuditEventInput, type RetentionMode, type SourceConfig, type SourceWidenedWord, type SourceWriteBody } from "@agentx/cloud-contracts";
import { updateItem, errorName, isTransactionConflict, NOT_EXISTS } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditDeps, type TransactItem } from "../audit/outbox.js";
import { pauseMatches } from "../lessons/view.js";
import {
  allowedRetention, checkRetentionChange, slackScopeAllowed, type CompanyLocks, type RecordSourceKind, type SlackScope, type TeamRecordEdition,
} from "./edition.js";
import { exceedsRetention, retentionRefusal } from "./retention.js";
import { classifySlack, parseSlackScope, type SlackFacts, type TrackerPlaceCheck, type TrackerPlaceOptions } from "./source-places.js";
import { auditRecordSourceAdded, auditRecordSourceChanged, auditRecordSourceRemoved } from "./audit.js";
import { closeScope } from "./item-head.js";
import { DEFAULT_WORK_BUDGET, tombstoneRows } from "./scope-work.js";
import { personRateKey, type RecordQueryDependencies } from "./query.js";
import type { RecordRouteReply, RecordRouteRequest } from "./routes.js";
import { rovaraScope } from "./sources/rovara.js";
import { claimDrop, claimPut, readRevisionFloor, readScopeClaim, readSourceRequest, readSourceRow, requestPut, revisionFloorCheck, revisionFloorPut } from "./source-store.js";
import { listScopeWork, listSourceConfigs, putScopeWork, scopeWorkItems, sourceRowItem, type ScopeWork } from "./store.js";

/** What the route needs from the install. */
export interface SourceRouteDependencies {
  edition: TeamRecordEdition;
  /** The numeric GitHub ids of the project's repositories, read live from its latest revision. Undefined (or a throw): the project's places cannot be checked, so nothing is added. */
  projectRepositories(orgId: OrgId, project: string): Promise<readonly number[] | undefined>;
  /** The project's repositories by name and numeric id, read live from the same latest revision, for the editors' view (the screen offers these when adding a repository). Absent or a throw: the view leaves the list out. */
  repositoryNames?(orgId: OrgId, project: string): Promise<ReadonlyArray<{ id: number; name: string }> | undefined>;
  /** The company's retention ceiling. Absent: none is set. A read that throws refuses the write. */
  locks?(orgId: OrgId): Promise<CompanyLocks | undefined>;
  /** Whether this Slack workspace is bound to the company (the same binding the Slack tap resolves). Absent or a throw: a Slack place cannot be checked, so nothing is added. */
  slackTeamBound?: (orgId: OrgId, teamId: string) => Promise<boolean>;
  /** The Slack user ids (`U...`) the person has signed in with: the sign-in store's own links, read by the server (never from a request). For "your private channels" in the Slack picker (`source-options.ts`). Absent or a throw: that group cannot be read. */
  slackUserIdsOf?: (developerId: string) => Promise<readonly string[]>;
  /** Whether a connected Linear or Jira app of the company lists the place, read live. Absent (the install has no connections): such a place is never accepted. */
  trackerPlace?: TrackerPlaceCheck;
  /** The places the company's connected Linear and Jira apps list, with names, a page at a time, for the pickers (`source-options.ts`). Absent: the pickers for those kinds cannot be read and the editor types the place. */
  trackerOptions?: TrackerPlaceOptions;
  /** The source keys the learning loop paused (for the admin view). */
  pausedSources?(orgId: OrgId, project: string): Promise<readonly string[]>;
  /**
   * SRL-14: the least time a web editor's refused Slack add takes (see `SLACK_REFUSAL_FLOOR_MS`). `sleep` waits that many milliseconds; the runtime passes a real timer and tests pass one that moves their clock. Absent: refusals are not
   * held back (only for tests that do not care; the runtime always sets it).
   */
  refusalFloor?: RefusalFloor;
  newId?(): string;
}

/**
 * SRL-14 (owner decision 24b): a web editor who types a channel ID must not learn from the response time whether a private channel exists or Rovara is in it. The refusals the editor may not learn the reason for (SLACK_INVITE_NEEDED,
 * SLACK_NOT_LINKED) are held until this long after the place check began, on top of making the same Slack reads on every path. Slack answers in well under this; a Slack slower than this (its own per-call limit is 5 s) is not slowed further.
 */
export const SLACK_REFUSAL_FLOOR_MS = 3_000;
/** The membership reads must be done this long before the floor ends; what is not done by then counts as "not in", so the refusal is still sent AT the floor and a slow Slack cannot separate the cases (review of SRL-14, finding 1). */
export const SLACK_MEMBERSHIP_MARGIN_MS = 250;
/** A web editor's Slack adds a minute (each one reads Slack up to 1 + 5 times, and a refusal holds a Lambda for the floor). Counted before the place is read, so every channel gets the same answer. */
export const SLACK_ADDS_PER_EDITOR_PER_MINUTE = 20;
export interface RefusalFloor {
  ms: number;
  /** Waits that many milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Waits for `work`, but no longer than `ms`: "late" when the time is up first (the work is left to finish unobserved). */
  within<T>(ms: number, work: Promise<T>): Promise<T | "late">;
}
/** The floor as the runtime runs it: real timers. */
export function realRefusalFloor(ms: number = SLACK_REFUSAL_FLOOR_MS): RefusalFloor {
  return {
    ms,
    sleep: (wait) => new Promise<void>((resolve) => { setTimeout(resolve, wait); }),
    within: (wait, work) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("late"), Math.max(0, wait));
      work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error("the work failed")); });
    }),
  };
}

/** A page of Slack channels, or why it could not be read. */
export type SlackChannelPage =
  { ok: true; channels: Array<{ id: string; name: string; kind: "public" | "private"; extShared: boolean; joined: boolean }>; next?: string } | { ok: false; error: "missing_scope" | "unavailable" };

/** What only the broker's request knows, handed in per request by the caller (`aws/developer-routes/team-record-source-write.ts`). */
export interface SourceWriteContext {
  /** The caller's company role. */
  orgRole: string;
  /** True only for a live browser session (never a token). */
  browserSession: boolean;
  /**
   * Who is acting when it is NOT a browser session: `slack_interaction` is a signed Slack button press by a person linked to Rovara (`slack-add.ts`). Only the broker's own direct-invoke path sets it (the web route's
   * context builder never does, and a request body cannot); the route accepts it for ONE write, adding a Slack place, and the audit event then says `via: slack`. `browserSession` stays false for it.
   */
  actor?: "slack_interaction";
  /** The parsed request body; throws when it is not JSON. Read only for a write. */
  body(): unknown;
  /** The audit outbox of the State table. Absent (a legacy install): ordinary writes go on without an event, and a write that widens what is kept is refused. */
  audit?: AuditDeps;
  /** What Slack says a channel is, read fresh: its facts, `"none"` when Slack does not know it, `undefined` (or a throw) when it could not be read. Absent: no Slack place can be checked. */
  slackChannel?: (teamId: string, channelId: string) => Promise<SlackFacts | "none" | undefined>;
  /** Whether the Slack user `userId` is in the channel, read fresh (`channel-members` through DeveloperIdentity): `undefined` (or a throw) when it could not be read. `userId` is always one of the editor's own linked Slack ids, chosen by the server. Absent: a private place cannot be added from the web. */
  slackMember?: (userId: string, channelId: string) => Promise<boolean | undefined>;
  /** The Slack team of this install (the one whose bot token DeveloperIdentity holds). The pickers list only this team, and only for the company it is bound to. Absent: the Slack picker cannot be read. */
  slackTeamId?: string;
  /** One page of the channels the bot can see, read fresh through DeveloperIdentity (`channel-list`). `missing_scope`: the Slack app lacks the listing scopes. Absent: the Slack picker cannot be read. */
  slackChannels?: (input: { teamId: string; cursor?: string }) => Promise<SlackChannelPage>;
  /** One page of the PRIVATE channels that both the bot and the Slack user `userId` are in (`member-channels` through DeveloperIdentity). `userId` is always one of the editor's own linked Slack ids, chosen by the server. Absent: "your private channels" cannot be read. */
  slackMemberChannels?: (input: { teamId: string; userId: string; cursor?: string }) => Promise<SlackChannelPage>;
}

/** The route's fixed sentences (the Slack add reads them to tell its own apart from anything else). */
export const WORDS = {
  browser: "Use a live browser session to change this project's sources.",
  notEditor: "Only a maintainer of this project, or a company admin, can change its sources.",
  invalid: "The request is not valid.",
  place: "That place can't be used as a source for this project.",
  taken: "That place is already used by another project.",
  noSource: "No such source.",
  stale: "This source changed. Reload and try again.",
  notOffered: "That retention isn't offered for this source.",
  ceiling: "Your company doesn't allow that much retention for this source.",
  connect: "Slack Connect channels can't be used as a source.",
  directMessages: "Direct messages and group messages can't be used as a source in this edition.",
  audit: "This change needs the audit ledger.",
  unavailable: "The sources can't be changed right now.",
} as const;
/** An add is refused while the deletion of the same place is still queued: answered with its own code (route-local, like the two above). */
class RemovalRunning extends Error {}
/** The same refusal when the removal that is still being cleared was not this project's (another project's, or a tap's): the sentence does not say this project removed it, and names nobody. */
class ClearingElsewhere extends Error {}
/** The delete queue is too long to tell whether this place is in it (500 or more items): every add waits, with its own code, so the person is not told a source "was just removed" that never was. */
class RemovalBusy extends Error {}
/** A place the edition's rules never allow (Slack Connect; a DM in Public): answered 422 with its own route-local code, like the two above. */
class NotAllowed extends Error {}
/**
 * Slack could not show the bot the channel (channel_not_found, not_in_channel: Rovara is not in it, or it does not exist), OR the channel is not public and the editor adding it is not in it (or has no linked Slack account): one
 * answer for all of them, so a channel's existence is never told. Its own route-local code and one fixed sentence (task 11, C; final review 3, I1).
 */
class InviteNeeded extends Error {}
/**
 * UX-4b: the editor has no linked Slack account, so Rovara can't check they are in the channel. Its own code and next step (link the account), because it is about the caller alone. It is answered only where the
 * other answer would be "Rovara can't use that channel" (no such channel, Rovara not in it, or a channel that isn't public), so it tells nothing more about a channel than that answer did.
 */
class NotLinked extends Error {}
const notLinkedReply = (): RecordRouteReply => ({ status: 422, body: { code: "SLACK_NOT_LINKED", message: "Link your Slack account to Rovara so it can check you're in that channel, then try again." } });
/** A pasted link (or place) for a Slack workspace other than this install's: its own route-local code and one fixed sentence (task 11, B). */
class WrongWorkspace extends Error {}
const wrongWorkspaceReply = (): RecordRouteReply => ({ status: 422, body: { code: "SLACK_WRONG_WORKSPACE", message: "That link is for a different Slack workspace." } });
const inviteNeededReply = (): RecordRouteReply => ({ status: 422, body: { code: "SLACK_INVITE_NEEDED", message: "Rovara isn't in that channel yet. Type /invite @Rovara in the channel, then try again. You must be in the channel yourself, with your Slack account linked to Rovara. If Rovara and you are both in it already, wait a minute and try again." } });
const removalRunningReply = (): RecordRouteReply => ({ status: 409, body: { code: "SOURCE_REMOVAL_RUNNING", message: "This source was just removed and its stored data is still being deleted. You can add it again in about an hour." } });
const clearingElsewhereReply = (): RecordRouteReply => ({ status: 409, body: { code: "SOURCE_CLEARING", message: "This source is still being cleared after a recent removal. You can add it again in about an hour." } });
const removalBusyReply = (): RecordRouteReply => ({ status: 409, body: { code: "SOURCE_REMOVAL_BUSY", message: "Rovara is still deleting data from recently removed sources. Try again in an hour." } });
const notAllowedReply = (error: NotAllowed): RecordRouteReply => ({ status: 422, body: { code: "SOURCE_NOT_ALLOWED", message: error.message } });
const invalid = (message: string = WORDS.invalid) => agentXError("CONFIG_INVALID", message);
const stale = (message: string = WORDS.stale) => agentXError("CHANGE_STALE", message);
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", WORDS.unavailable);

const KINDS_WRITABLE = new Set<string>(["github", "rovara", "slack", "linear", "jira"]);
const OFFERED_KINDS: readonly RecordSourceKind[] = ["slack", "github", "codehost", "linear", "jira", "mcp", "rovara"];
const GITHUB_SCOPE = /^github:repo\/([1-9][0-9]{0,14})$/u;

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const bodyHashOf = (body: unknown): string => sha(canonicalJson(body));

/** Who may edit sources: a company role that can write, and a maintainer of this project. */
export function mayEditSources(caller: { projectRole: string | undefined }, write: Pick<SourceWriteContext, "orgRole">): boolean {
  return isWriterOrgRole(write.orgRole) && caller.projectRole === "maintainer";
}

/** What a Slack place widens, from its kind (the server's own reading of the channel): a private channel, a DM or a group DM (a DM is refused in Public before this is asked). */
export function placeWidened(edition: TeamRecordEdition, kind: SlackScope | undefined): SourceWidenedWord[] {
  if (kind === undefined || !slackScopeAllowed(edition, kind).widens) return [];
  return kind === "private_channel" ? ["private_channel"] : kind === "dm" ? ["dm"] : kind === "mpim" ? ["mpim"] : [];
}
const orderedWords = (words: Iterable<SourceWidenedWord>): SourceWidenedWord[] => { const set = new Set(words); return SOURCE_WIDENED_WORDS.filter((word) => set.has(word)); };
/** Whether the widening is about the place (the audit fact `restricted`), as against retention alone. */
const restrictedBy = (words: readonly SourceWidenedWord[]): boolean => words.some((word) => word !== "retention_raise");

interface Run {
  deps: RecordQueryDependencies;
  sources: SourceRouteDependencies;
  ctx: SourceWriteContext;
  orgId: OrgId;
  project: string;
  me: string;
  now: () => number;
}
const nowIso = (run: Run): string => new Date(run.now()).toISOString();

/** Who may use the editors' routes: a person with a role in the project, who may edit its sources, on a live browser session. */
export function gate(request: RecordRouteRequest, ctx: SourceWriteContext, options: { slackInteraction?: boolean } = {}): void {
  if (request.caller.projectRole === undefined) throw agentXError("PROJECT_NOT_FOUND", "No such project.");
  if (!mayEditSources(request.caller, ctx)) throw agentXError("FORBIDDEN", WORDS.notEditor);
  // A live browser session; or, for the one write that allows it (`handleSourceWrite`), a Slack interaction. The pickers and the admin view never pass `slackInteraction`.
  if (!ctx.browserSession && !(options.slackInteraction === true && ctx.actor === "slack_interaction")) throw agentXError("FORBIDDEN", WORDS.browser);
}

export async function handleSourceWrite(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<RecordRouteReply> {
  const sources = deps.sources;
  const ctx = request.write;
  if (sources === undefined || ctx === undefined) throw unavailable();
  gate(request, ctx, { slackInteraction: true });
  let raw: unknown;
  try { raw = ctx.body(); } catch { throw invalid(); }
  const parsed = SourceWriteBodySchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  // The Slack interaction actor may add a Slack place and do nothing else here: not a change, not a removal, not another kind of source.
  if (ctx.actor === "slack_interaction" && !(parsed.data.action === "add" && parsed.data.source === "slack")) throw agentXError("FORBIDDEN", WORDS.browser);
  const run: Run = { deps, sources, ctx, orgId: request.caller.orgId, project, me: request.caller.developerId, now: deps.now ?? Date.now };
  // A Slack place may be pasted as a channel ID or a Slack link (task 11, B): read again here, whatever the screen did, and the exact place is what is stored, claimed, audited and replayed.
  try {
    const body = parsed.data.action === "add" && parsed.data.source === "slack" ? { ...parsed.data, scope: slackPlaceOf(ctx, parsed.data.scope) } : parsed.data;
    switch (body.action) {
      case "add": return await saveAdd(run, body);
      case "change": return await saveChange(run, body);
      case "remove": return await saveRemove(run, body);
    }
  } catch (error) {
    if (error instanceof RemovalRunning) return removalRunningReply();
    if (error instanceof ClearingElsewhere) return clearingElsewhereReply();
    if (error instanceof RemovalBusy) return removalBusyReply();
    if (error instanceof NotAllowed) return notAllowedReply(error);
    if (error instanceof NotLinked) return notLinkedReply();
    if (error instanceof InviteNeeded) return inviteNeededReply();
    if (error instanceof WrongWorkspace) return wrongWorkspaceReply();
    throw error;
  }
}

const notYet = (): RecordRouteReply => ({ status: 422, body: { code: "SOURCE_KIND_NOT_YET", message: "That kind of source can't be added yet." } });

// ---- the place

/** What checking a place found out: for a Slack channel, its class (the server's reading, never the body's). */
interface Place { slack?: SlackScope }

async function checkScope(run: Run, source: string, scope: string, options: { editorInChannel?: boolean } = {}): Promise<Place> {
  if (source === "rovara") {
    if (scope !== rovaraScope(run.project)) throw invalid(WORDS.place);
    return {};
  }
  if (source === "slack") return { slack: await checkSlackPlace(run, scope, options.editorInChannel === true) };
  if (source === "linear" || source === "jira") { await checkTrackerPlace(run, source, scope); return {}; }
  const match = GITHUB_SCOPE.exec(scope);
  if (match === null) throw invalid(WORDS.place);
  // Read live on every write: a repository that left the project is no longer its place.
  let ids: readonly number[] | undefined;
  try { ids = await run.sources.projectRepositories(run.orgId, run.project); } catch { ids = undefined; }
  if (ids === undefined) throw unavailable();
  if (!ids.includes(Number(match[1]))) throw invalid(WORDS.place);
  return {};
}

/**
 * The exact place (`slack:<team>/<channel>`) of what was typed or pasted: a bare channel ID or a workspace link takes the install's Slack team; an app link names its team, which must be the install's (a link for another workspace
 * is refused with its own sentence; an enterprise-grid id in the link stands for the install's team). The full place and anything this does not read are returned as they came, for the place check to accept or refuse as it always did.
 */
function slackPlaceOf(ctx: SourceWriteContext, scope: string): string {
  const input = parseSlackPlaceInput(scope);
  if (input === undefined || input.form === "scope") return scope;
  const team = ctx.slackTeamId;
  if (team === undefined) throw unavailable();
  if (input.form === "client" && input.teamId!.startsWith("T") && input.teamId !== team) throw new WrongWorkspace();
  return `slack:${team}/${input.channelId}`;
}

/**
 * A Slack place: the workspace is this company's (the binding the tap resolves), the channel is read LIVE and classified here, and the edition's rules apply. A workspace of another company answers as a
 * missing place and Slack is never asked; a channel that cannot be read fails closed. Slack Connect, and a DM or group DM in Public, are refused with their own code.
 * A web editor's refusals that hide the reason (SRL-14) are held to a fixed floor in time (`withRefusalFloor`).
 */
async function checkSlackPlace(run: Run, scope: string, editorInChannel: boolean): Promise<SlackScope> {
  if (!editorInChannel || run.ctx.actor === "slack_interaction") return await checkSlackPlaceNow(run, scope, false, undefined);
  // The editor's own count first: the same answer for every channel, so it says nothing about one.
  await rationSlackAdds(run);
  return await withRefusalFloor(run, (started) => checkSlackPlaceNow(run, scope, true, started));
}

/** One from the editor's minute. No limiter wired: no limit. A limiter that cannot answer refuses (fail closed). Kept under `RATE#slack-add-web|person:<id>`, which person erase removes (`PERSON_RATE_KINDS`). */
async function rationSlackAdds(run: Run): Promise<void> {
  const limiter = run.deps.limiter;
  if (limiter === undefined) return;
  const allowed = await limiter.take(`${run.orgId}|slack-add-web|${personRateKey(run.me)}`, SLACK_ADDS_PER_EDITOR_PER_MINUTE, 60).then((value) => value, () => false);
  if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many channels added just now. Try again in a minute.");
}

/**
 * Runs the check; when it ends in a refusal that must not tell why, or in "unavailable" (an anomaly on a channel Rovara can see is told apart from a missing one by speed alone, so a 503 is held back too), waits out the rest of
 * the floor before letting it go. Success and every other answer are not delayed.
 */
async function withRefusalFloor<T>(run: Run, work: (started: number) => Promise<T>): Promise<T> {
  const floor = run.sources.refusalFloor;
  if (floor === undefined) return await work(run.now());
  const started = run.now();
  try {
    return await work(started);
  } catch (error) {
    if (error instanceof InviteNeeded || error instanceof NotLinked || (error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE")) {
      const rest = floor.ms - (run.now() - started);
      if (rest > 0) { try { await floor.sleep(rest); } catch { /* the answer is the same without the wait */ } }
    }
    throw error;
  }
}

async function checkSlackPlaceNow(run: Run, scope: string, editorInChannel: boolean, started: number | undefined): Promise<SlackScope> {
  const parsed = parseSlackScope(scope);
  if (parsed === undefined) throw invalid(WORDS.place);
  const bound = run.sources.slackTeamBound;
  if (bound === undefined || run.ctx.slackChannel === undefined) throw unavailable();
  // A workspace other than the one this install's bot belongs to (a pasted link for another workspace) is said so, in one fixed sentence that names nobody.
  if (run.ctx.slackTeamId !== undefined && parsed.teamId !== run.ctx.slackTeamId) throw new WrongWorkspace();
  let mine: boolean;
  try { mine = await bound(run.orgId, parsed.teamId); } catch { throw unavailable(); }
  if (!mine) throw invalid(WORDS.place);
  let facts: SlackFacts | "none" | undefined;
  try { facts = await run.ctx.slackChannel(parsed.teamId, parsed.channelId); } catch { facts = undefined; }
  if (facts === undefined) throw unavailable();
  // Slack does not show the bot this channel: it is not in it, or there is no such channel. Never said which. SRL-14: a web editor goes through EXACTLY the reads a private channel Rovara is in would cost (their linked ids, then one membership
  // read per id, on this same channel), so the work, and the answer, are the same either way. Nothing the reads say can change the answer here.
  if (facts === "none") {
    if (editorInChannel) await editorIsInByTheFloor(run, parsed.channelId, started);
    throw new InviteNeeded();
  }
  // Adding a channel that is not public from the web: the editor must be in it, by one of their own linked Slack ids (as the Slack-side Add checks), BEFORE anything else is said about the channel (Slack Connect, a DM). The Slack
  // interaction has already checked the person who pressed. A person not in it, with no linked id, answers exactly as "Rovara is not in that channel": the channel's existence is never told.
  if (editorInChannel && facts.kind !== "public" && !await editorIsInByTheFloor(run, parsed.channelId, started)) throw new InviteNeeded();
  const place = classifySlack(facts);
  if (!slackScopeAllowed(run.sources.edition, place).allowed) throw new NotAllowed(place === "slack_connect" ? WORDS.connect : WORDS.directMessages);
  return place;
}

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,31}$/u;
const LINKED_IDS_MAX = 5;
/**
 * Whether one of the editor's own linked Slack ids (the sign-in store's, read by the server from the session's developer, never from the request) is in the channel. NotLinked when they have none. A membership that cannot be read
 * (an error, a throw, a channel Slack will not show) counts as "not in", the same as a plain no, so that a missing scope or a failing read on an existing private channel is not a different answer from a channel that does not exist
 * (SRL-14). A missing way to read it, or the links failing, is unavailable for every channel alike.
 */
async function editorIsIn(run: Run, channelId: string): Promise<boolean> {
  const linksOf = run.sources.slackUserIdsOf, memberOf = run.ctx.slackMember;
  if (linksOf === undefined || memberOf === undefined) throw unavailable();
  let ids: string[];
  try { ids = [...new Set(await linksOf(run.me))].filter((id) => SLACK_USER_ID.test(id)).sort().slice(0, LINKED_IDS_MAX); } catch { throw unavailable(); }
  if (ids.length === 0) throw new NotLinked();
  // All the ids at once (one round trip however many the editor linked, in every case), answered "yes" as soon as one is.
  return await new Promise<boolean>((resolve) => {
    let left = ids.length;
    for (const id of ids) {
      Promise.resolve().then(() => memberOf(id, channelId)).then((answer) => answer === true, () => false).then((yes) => {
        if (yes) resolve(true);
        else { left -= 1; if (left === 0) resolve(false); }
      }, () => { left -= 1; if (left === 0) resolve(false); });
    }
  });
}

/** `editorIsIn`, but done by the time the floor allows. A web editor's membership reads that are not finished by then count as "not in": the refusal is sent at the floor in every case instead of whenever Slack finishes. */
async function editorIsInByTheFloor(run: Run, channelId: string, started: number | undefined): Promise<boolean> {
  const floor = run.sources.refusalFloor;
  const work = editorIsIn(run, channelId);
  if (floor === undefined || started === undefined) return await work;
  work.catch(() => undefined); // a read that outlives the answer must not surface later
  const result = await floor.within(floor.ms - SLACK_MEMBERSHIP_MARGIN_MS - (run.now() - started), work);
  return result === "late" ? false : result;
}

/** A Linear team or Jira project: one the company's connected app lists, read live. No app of that kind (or an install without connections) is a missing place; a listing that cannot be read fails closed. */
async function checkTrackerPlace(run: Run, kind: "linear" | "jira", scope: string): Promise<void> {
  if (!scope.startsWith(kind === "linear" ? "linear:team/" : "jira:project/")) throw invalid(WORDS.place);
  const check = run.sources.trackerPlace;
  if (check === undefined) throw invalid(WORDS.place);
  let answer: "found" | "absent" | undefined;
  try { answer = await check(run.orgId, kind, scope); } catch { answer = undefined; }
  if (answer === undefined) throw unavailable();
  if (answer === "absent") throw invalid(WORDS.place);
}

// ---- retention

async function locksOf(run: Run): Promise<CompanyLocks | undefined> {
  try { return await run.sources.locks?.(run.orgId); } catch { throw unavailable(); }
}

/** Whether the retention change is a raise that widens what is kept (either edition). Refuses what the edition does not offer (Public Slack: C and D never, B only with the notes opt-in) and what the company's ceiling forbids. */
async function retentionWidens(run: Run, source: string, stored: string | undefined, to: RetentionMode, notesOptIn: boolean): Promise<boolean> {
  const edition = run.sources.edition;
  if (retentionRefusal(edition, source, to, notesOptIn) !== undefined) throw invalid(WORDS.notOffered);
  const locks = await locksOf(run);
  const check = checkRetentionChange({ edition, source, stored, to, ...(locks === undefined ? {} : { locks }) });
  if (!check.ok) throw invalid(check.refusal === "RETENTION_ABOVE_COMPANY_CEILING" ? WORDS.ceiling : WORDS.notOffered);
  return check.widens;
}

// ---- transactions

type Reply = RecordRouteReply;

async function commit(run: Run, items: TransactItem[]): Promise<"ok" | "cancelled"> {
  if (items.length > 100) throw unavailable();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await run.deps.table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return "ok";
    } catch (error) {
      if (isTransactionConflict(error) && attempt < 2) continue;
      if (errorName(error) === "TransactionCanceledException" || isTransactionConflict(error)) return "cancelled";
      throw error;
    }
  }
  return "cancelled";
}

/** The audit items for events. `required`: every event must have its item (a less-safe write), else the write is refused before anything is written. */
function auditItems(run: Run, events: AuditEventInput[], required: boolean): TransactItem[] {
  const items = events.flatMap((event) => auditPending(run.ctx.audit ?? {}, event));
  if (required && items.length !== events.length) throw agentXError("AUDIT_UNAVAILABLE", WORDS.audit);
  return items;
}
async function flush(run: Run, events: AuditEventInput[]): Promise<void> {
  try { await flushAuditEvents(run.ctx.audit ?? {}, events); } catch { /* the pending item stays for the drain */ }
}

async function replayed(run: Run, requestId: string, hash: string): Promise<Reply | undefined> {
  const found = await readSourceRequest(run.deps.table, run.orgId, run.project, run.me, requestId, run.now());
  if (found === undefined) return undefined;
  if (found.bodyHash !== hash) throw invalid();
  return { status: found.status, body: found.reply };
}
const requestItem = (run: Run, requestId: string, hash: string, reply: Reply): TransactItem => requestPut(run.deps.table, run.orgId, run.project, run.me, requestId, { bodyHash: hash, status: reply.status, reply: reply.body }, run.now());

const rowUpdate = (run: Run, current: SourceConfig, change: { set: Record<string, unknown>; remove?: string[] }, expected: number): TransactItem => updateItem(
  { ...run.deps.table, now: run.now }, recordSourceKey(run.orgId, run.project, current.source, current.scope),
  { set: change.set, ...(change.remove === undefined ? {} : { remove: change.remove }), when: (aliases) => (expected === 0
    ? `attribute_exists(pk) AND (attribute_not_exists(${aliases.name("revision")}) OR ${aliases.name("revision")} = ${aliases.value(0)})`
    : `attribute_exists(pk) AND ${aliases.name("revision")} = ${aliases.value(expected)}`) },
);

// ---- add

async function saveAdd(run: Run, body: Extract<SourceWriteBody, { action: "add" }>): Promise<Reply> {
  if (!KINDS_WRITABLE.has(body.source)) return notYet();
  // A repeat of a request that was answered gets that answer, whatever the place and the company's rules say now.
  const hash = bodyHashOf(body);
  const again = await replayed(run, body.requestId, hash);
  if (again !== undefined) return again;
  const place = await checkScope(run, body.source, body.scope, { editorInChannel: true });
  if (body.notesOptIn !== undefined && body.source !== "slack") throw invalid();
  const raises = await retentionWidens(run, body.source, undefined, body.retention, body.notesOptIn === true);
  const table = run.deps.table;
  if ((await readSourceRow(table, run.orgId, run.project, body.source, body.scope)) !== undefined) throw stale();
  await refuseWhileRemoving(run, body.scope);
  const holder = await readScopeClaim(table, run.orgId, body.source, body.scope);
  if (holder !== undefined && holder !== run.project) throw invalid(WORDS.taken);
  // A place whose row was removed counts on from the revision it reached, so nothing made against the old row can fit the new one.
  const floor = await readRevisionFloor(table, run.orgId, run.project, body.source, body.scope);
  const revision = (floor?.revision ?? 0) + 1;

  const row: Omit<SourceConfig, "revision" | "updatedAt"> = {
    workspaceId: run.orgId, project: run.project, source: body.source, scope: body.scope, enabled: body.enabled, retention: body.retention, exclude: body.exclude ?? [],
    audienceDefault: body.audienceDefault, ...(body.notesOptIn === true && body.retention === "B" ? { notesOptIn: true as const } : {}), health: "unknown", addedBy: run.me,
  };
  const widened = orderedWords([...(raises ? (["retention_raise"] as const) : []), ...placeWidened(run.sources.edition, place.slack)]);

  const reply: Reply = { status: 200, body: { status: "saved", revision } };
  const at = nowIso(run);
  const stored = SourceConfigSchema.parse({ ...row, revision, updatedAt: at });
  const events = [auditRecordSourceAdded({ orgId: run.orgId, actorId: run.me, at, occurrence: randomUUID(), project: run.project, source: body.source, scope: body.scope, retention: body.retention, restricted: restrictedBy(widened), widened, ...(run.ctx.actor === "slack_interaction" ? { via: "slack" as const } : {}) })];
  const items: TransactItem[] = [
    { Put: { TableName: table.tableName, Item: sourceRowItem(stored), ConditionExpression: NOT_EXISTS } },
    claimPut(table, run.orgId, run.project, body.source, body.scope, at),
    revisionFloorCheck(table, run.orgId, run.project, body.source, body.scope, floor),
    { Delete: { TableName: table.tableName, Key: recordScopeMarkerKey(run.orgId, body.scope) } }, // saving a row for a closed place opens it again
    requestItem(run, body.requestId, hash, reply),
    ...auditItems(run, events, widened.length > 0),
  ];
  if ((await commit(run, items)) === "ok") { await flush(run, events); return reply; }
  // Cancelled: the same request may have been answered meanwhile, the place may have a row, or another project took it. Read again before deciding.
  const earlier = await replayed(run, body.requestId, hash);
  if (earlier !== undefined) return earlier;
  if ((await readSourceRow(table, run.orgId, run.project, body.source, body.scope)) !== undefined) throw stale();
  const now = await readScopeClaim(table, run.orgId, body.source, body.scope);
  if (now !== undefined && now !== run.project) throw invalid(WORDS.taken);
  throw stale();
}

// ---- change

async function saveChange(run: Run, body: Extract<SourceWriteBody, { action: "change" }>): Promise<Reply> {
  if (!KINDS_WRITABLE.has(body.source)) return notYet();
  if (body.notesOptIn !== undefined && body.source !== "slack") throw invalid();
  const hash = bodyHashOf(body);
  const again = await replayed(run, body.requestId, hash);
  if (again !== undefined) return again;
  const table = run.deps.table;
  const current = await readSourceRow(table, run.orgId, run.project, body.source, body.scope);
  if (current === undefined) throw agentXError("NOT_FOUND", WORDS.noSource);
  const was = current.revision ?? 0;
  if (was !== body.expectedRevision) throw stale();

  const retention = body.retention ?? current.retention;
  const notesOptIn = body.notesOptIn === null ? undefined : body.notesOptIn ?? current.notesOptIn;
  // The starting point of a retention change is the STORED row, never anything the caller says.
  const raises = body.retention !== undefined && body.retention !== current.retention
    ? await retentionWidens(run, body.source, current.retention, body.retention, notesOptIn === true) : false;
  // The notes opt-in and the retention stay a pair in the Public edition: whenever the body names either, the FINAL pair is checked (B without the opt-in is never stored, whatever the body says;
  // a retention that moves is also checked above against the edition and the company's ceiling).
  if ((body.retention !== undefined || body.notesOptIn !== undefined) && retentionRefusal(run.sources.edition, body.source, retention, notesOptIn === true) !== undefined) throw invalid(WORDS.notOffered);
  // A Slack row turned on, or kept more (more retained, a wider audience), looks at the channel again: it may have become Slack Connect, private or a DM since. Turning off or keeping less never asks Slack.
  // Turning it on or widening who sees it widens what is kept as much as adding the place did, so the class the server just read brings its words (private_channel, dm, mpim).
  const turnsOn = body.enabled === true && !current.enabled;
  const widensAudience = body.audienceDefault === "project" && current.audienceDefault !== "project";
  let placeWords: SourceWidenedWord[] = [];
  if (body.source === "slack" && (turnsOn || widensAudience || (body.retention !== undefined && exceedsRetention(body.retention, current.retention)))) {
    const place = await checkScope(run, body.source, body.scope);
    if (turnsOn || widensAudience) placeWords = placeWidened(run.sources.edition, place.slack);
  } else if (body.source === "github" && (turnsOn || widensAudience || (body.retention !== undefined && exceedsRetention(body.retention, current.retention)))) {
    // A GitHub row turned on, or kept more, looks at the project's repositories again: one that has left the project is a missing place, as when it was added.
    await checkScope(run, body.source, body.scope);
  }
  const next = {
    retention, audienceDefault: body.audienceDefault ?? current.audienceDefault, enabled: body.enabled ?? current.enabled, exclude: body.exclude ?? current.exclude,
    // The opt-in belongs to retention B and goes with it: a row saved below B never carries one, so a later move to B needs its own explicit opt-in.
    ...(notesOptIn === true && retention === "B" ? { notesOptIn: true as const } : {}),
  };
  const dropsOptIn = body.notesOptIn === null || (current.notesOptIn !== undefined && !(notesOptIn === true && retention === "B"));
  const widened = orderedWords([...(raises ? (["retention_raise"] as const) : []), ...placeWords]);

  const revision = was + 1;
  const at = nowIso(run);
  const reply: Reply = { status: 200, body: { status: "saved", revision } };
  const events = [auditRecordSourceChanged({ orgId: run.orgId, actorId: run.me, at, occurrence: randomUUID(), project: run.project, source: body.source, scope: body.scope, fromRetention: current.retention, toRetention: retention, enabled: next.enabled, widened })];
  const items: TransactItem[] = [
    rowUpdate(run, current, { set: { ...next, revision, updatedAt: at }, ...(dropsOptIn ? { remove: ["notesOptIn"] } : {}) }, was),
    requestItem(run, body.requestId, hash, reply),
    ...auditItems(run, events, widened.length > 0),
  ];
  if ((await commit(run, items)) === "ok") { await flush(run, events); return reply; }
  const earlier = await replayed(run, body.requestId, hash);
  if (earlier !== undefined) return earlier;
  throw stale();
}

// ---- remove

const QUEUE_READ = 500;

/**
 * A place whose deletion is still queued cannot be added again yet: the delete would close it again and take the new rows with it. A queue too long to read counts as busy.
 * Work that only strips free text (a removed Rovara source row) never closes a place and does not count.
 */
async function refuseWhileRemoving(run: Run, scope: string): Promise<void> {
  let queue: Awaited<ReturnType<typeof listScopeWork>>;
  try { queue = await listScopeWork(run.deps.table, run.orgId, QUEUE_READ); } catch { throw unavailable(); }
  if (queue.length >= QUEUE_READ) throw new RemovalBusy();
  const busy = closingWork(queue, scope);
  if (busy.length === 0) return;
  // This project's own removal keeps "you removed it"; anyone else's (another project, a tap) is told only that the place is still being cleared.
  throw busy.some((work) => work.project === run.project) ? new RemovalRunning() : new ClearingElsewhere();
}

/** The queued deletions that would close the place (or one above or below it) again: a removed place's tombstone. Work that only strips free text never closes a place. */
function closingWork(queue: ReadonlyArray<{ type: string; textOnly?: boolean; scope?: string; cause?: string; project?: string }>, scope: string) {
  const above = new Set(scopeAndAncestors(scope));
  return queue.filter((work) => work.type === "tombstone" && work.textOnly !== true && work.scope !== undefined && (work.cause === "excluded" || work.cause === "source_deleted")
    && (above.has(work.scope) || work.scope.startsWith(`${scope}/`)));
}

/**
 * Of these places of one kind, the ones whose deletion some OTHER project (or a tap) still has queued: the picker shows them as unavailable, without saying who. A project's own removals are on its Sources tab
 * (`clearingPlaces`). Best effort: a queue that cannot be read, or one too long to read, marks nothing (the add is still refused by the server in its own sentence).
 */
export async function clearingElsewhere(deps: RecordQueryDependencies, orgId: OrgId, project: string, scopes: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (scopes.length === 0) return found;
  let queue: Awaited<ReturnType<typeof listScopeWork>>;
  try { queue = await listScopeWork(deps.table, orgId, QUEUE_READ); } catch { return found; }
  if (queue.length >= QUEUE_READ) return found;
  for (const scope of scopes) if (closingWork(queue, scope).some((work) => work.project !== project)) found.add(scope);
  return found;
}

/**
 * Removing a source row deletes that place's data. ONE transaction: the row (fenced on its revision), its place claim, the request item, the audit item and a
 * durable queue item for the delete worker (cause `excluded`, hidden from every read from this commit on). Nothing can be lost between "row gone" and "deletion queued". Then, best effort, the place is
 * closed at once; if that fails the worker closes it on its next run. Removing is always safe (it only keeps less).
 * The project's own Rovara row is different: it returns the project to the default retention and removes only the rows that hold free text (the structured outcomes and the place stay).
 */
async function saveRemove(run: Run, body: Extract<SourceWriteBody, { action: "remove" }>): Promise<Reply> {
  const hash = bodyHashOf(body);
  const again = await replayed(run, body.requestId, hash);
  if (again !== undefined) return again;
  const table = run.deps.table;
  const current = await readSourceRow(table, run.orgId, run.project, body.source, body.scope);
  if (current === undefined) throw agentXError("NOT_FOUND", WORDS.noSource);
  const was = current.revision ?? 0;
  if (was !== body.expectedRevision) throw stale();

  const at = nowIso(run);
  const textOnly = body.source === "rovara";
  const work: ScopeWork = {
    requestId: randomUUID(), type: "tombstone", system: body.source, scope: body.scope, project: run.project, cause: "excluded", hidePending: true, at, queuedAtSeconds: Math.floor(run.now() / 1000), hidden: 0,
    ...(textOnly ? { textOnly: true } : { childPending: true }),
  };
  const reply: Reply = { status: 200, body: { status: "removed" } };
  const events = [auditRecordSourceRemoved({ orgId: run.orgId, actorId: run.me, at, occurrence: randomUUID(), project: run.project, source: body.source, scope: body.scope })];
  const items: TransactItem[] = [
    rowDelete(run, current, was),
    claimDrop(table, run.orgId, run.project, body.source, body.scope),
    revisionFloorPut(table, run.orgId, run.project, body.source, body.scope, was, at),
    ...scopeWorkItems(table, run.orgId, work),
    requestItem(run, body.requestId, hash, reply),
    ...auditItems(run, events, false),
  ];
  if ((await commit(run, items)) !== "ok") {
    const earlier = await replayed(run, body.requestId, hash);
    if (earlier !== undefined) return earlier;
    throw stale();
  }
  await flush(run, events);
  // Best effort, and only an acceleration: the queued work above already hides the place from every read, and (it lists the workspace in the directory the hourly job walks, in the same transaction) makes the worker finish the job.
  if (textOnly) {
    try {
      const result = await tombstoneRows({ table, now: run.now }, run.orgId, { system: body.source, scope: body.scope, cause: "excluded", textOnly: true }, DEFAULT_WORK_BUDGET);
      await putScopeWork(table, run.orgId, { ...work, hidden: result.changed, hidePending: !result.complete, hideDone: result.complete, ...(result.cursor === undefined ? {} : { hideCursor: result.cursor }) });
    } catch { /* the worker hides them */ }
  } else {
    try { await closeScope(table, run.orgId, body.scope, "excluded", at); } catch { /* the worker closes the place */ }
  }
  return reply;
}

const rowDelete = (run: Run, current: SourceConfig, expected: number): TransactItem => ({
  Delete: {
    TableName: run.deps.table.tableName, Key: recordSourceKey(run.orgId, run.project, current.source, current.scope),
    ...(expected === 0
      ? { ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(#r) OR #r = :r)", ExpressionAttributeNames: { "#r": "revision" }, ExpressionAttributeValues: { ":r": 0 } }
      : { ConditionExpression: "attribute_exists(pk) AND #r = :r", ExpressionAttributeNames: { "#r": "revision" }, ExpressionAttributeValues: { ":r": expected } }),
  },
});

// ---- the admin read

/**
 * The places this project removed whose deletion is still queued (the same queue `refuseWhileRemoving` reads), oldest first and at most 100: what an editor sees as "being removed". Work that only strips Rovara text,
 * and work queued without a project (a tap, an erasure), is not listed. A queue that cannot be read lists nothing (the add is still refused by the server).
 */
async function clearingPlaces(deps: RecordQueryDependencies, orgId: OrgId, project: string): Promise<Array<{ source: string; scope: string; since: string }>> {
  let queue: Awaited<ReturnType<typeof listScopeWork>>;
  try { queue = await listScopeWork(deps.table, orgId, QUEUE_READ); } catch { return []; }
  return queue
    .filter((work) => work.type === "tombstone" && work.textOnly !== true && work.project === project && work.scope !== undefined && (work.cause === "excluded" || work.cause === "source_deleted"))
    .map((work) => ({ source: work.system, scope: work.scope!, since: work.at }))
    .sort((a, b) => a.since.localeCompare(b.since))
    .slice(0, 100);
}

/** What a person who may edit sees on the Sources tab (`SourcesAdminViewSchema`). Anyone else keeps the older reply of the route. */
export async function sourcesAdminView(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<unknown> {
  const sources = deps.sources;
  const ctx = request.write;
  if (sources === undefined || ctx === undefined) throw unavailable();
  const orgId = request.caller.orgId;
  const [rows, paused] = await Promise.all([
    listSourceConfigs(deps.table, orgId, project),
    Promise.resolve(sources.pausedSources?.(orgId, project) ?? ([] as readonly string[])).catch(() => [] as readonly string[]),
  ]);
  const matched = new Set<string>();
  const shown = rows.slice(0, 200).map((row) => {
    const pausedBy = paused.filter((key) => pauseMatches(key, row.source, row.scope));
    for (const key of pausedBy) matched.add(key);
    return {
      kind: row.source, scope: row.scope, enabled: row.enabled, retention: row.retention, ...(row.notesOptIn === true ? { notesOptIn: true as const } : {}), health: row.health, audience: row.audienceDefault,
      excluded: Math.min(200, row.exclude.length), updatedAt: row.updatedAt, paused: pausedBy.length > 0, revision: row.revision ?? 0, addedBy: row.addedBy,
      ...(row.approval === undefined ? {} : { approval: { by: row.approval.by, at: row.approval.at } }), exclude: row.exclude,
    };
  });
  let locks: CompanyLocks | undefined;
  try { locks = await sources.locks?.(orgId); } catch { throw unavailable(); }
  const offered = Object.fromEntries(OFFERED_KINDS.map((kind) => [kind, allowedRetention(sources.edition, kind).filter((mode) => checkRetentionChange({ edition: sources.edition, source: kind, stored: undefined, to: mode, ...(locks === undefined ? {} : { locks }) }).ok)]));
  // TRW-4: the counts of what was left out for want of a linked author, for the project's editors (a read that fails leaves them out).
  const skippedUnlinked = await Promise.resolve(deps.skipped?.read(orgId, project)).catch(() => undefined);
  const repositoryNames = await Promise.resolve(sources.repositoryNames?.(orgId, project)).catch(() => undefined);
  const clearing = await clearingPlaces(deps, orgId, project);
  return SourcesAdminViewSchema.parse({
    sources: shown, otherPaused: paused.filter((key) => !matched.has(key)).length,
    canEdit: true, ...(sources.edition === "public" ? { notesSwitch: true as const } : {}), offered, ...(skippedUnlinked === undefined ? {} : { skippedUnlinked }),
    ...(clearing.length === 0 ? {} : { clearing }),
    ...(repositoryNames === undefined || repositoryNames.length === 0 ? {} : { repositories: repositoryNames.slice(0, 100).map((repository) => ({ name: repository.name, scope: `github:repo/${String(repository.id)}` })) }),
  });
}
