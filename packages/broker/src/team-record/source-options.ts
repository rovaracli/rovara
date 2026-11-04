// What an editor may pick instead of typing an id (source-row lane, task 10): `GET /v1/app/projects/{p}/record/sources/options?kind=slack|linear|jira&cursor=`.
//   Slack   the channels the bot sees in the workspace this company bound (read fresh through DeveloperIdentity, which holds the bot token; direct messages only where the edition allows them);
//   Linear  the teams of the company's connected app; Jira  the projects of the company's connections (the same live readers the write route checks a typed place against).
// WHO. The same people as the write route (`gate`): an owner, an admin or a maintainer of this project, on a live browser session. Everyone else is refused before anything is read.
// ORG. Only the caller's session org: the Slack workspace is listed only when it is bound to THAT company (another company gets an empty list and Slack is never asked), and the connected apps are
// the caller company's. Each option says whether this project already has it, whether another project holds it (never named), or whether it is never allowed (Slack Connect). Nothing is stored.
// BOUNDS. At most 200 an answer, at most 10 pages in all, held by the SERVER: the first page that has a next one opens a short-lived session item (`SRCOPT#<uuid>`: kind, project and a page count, no person and no text,
// expiring in 15 minutes), the cursor is `<session>.<the tool's own cursor>`, and every later page adds one to the count in a conditional update that refuses at 10 (and for an unknown, expired or other project's,
// kind's or company's session). A client cannot reset the count by editing a cursor. The reply says `truncated: true` when the server stopped while more existed. Slack page reads are also rationed per company
// (12 a minute, the existing rate limiter) because `conversations.list` is one rate-limited method shared with the channel-by-name lookup. Every failure is a fixed code: Slack down or unreadable, an app
// that cannot be read, no reader wired, all 503 `RUNTIME_UNAVAILABLE` (the screen then offers the typed field); a bot without the listing scopes is 503 `SLACK_SCOPE_MISSING`. No text from Slack or a tool
// is ever in an error; names appear only in the options, cut to 200 characters, and the screen shows them as plain text.
import { randomUUID } from "node:crypto";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, INDEX_EXPIRY_ATTRIBUTE, SourceOptionsQuerySchema, SourceOptionsViewSchema, agentXError, teamRecordPk, type OrgId, type SourceOption, type SourcePickerKind } from "@agentx/contracts";
import { Aliases, NOT_EXISTS, errorName } from "../agents/table-writes.js";
import type { RecordQueryDependencies } from "./query.js";
import type { RecordRouteReply, RecordRouteRequest } from "./routes.js";
import { gate, type SourceWriteContext } from "./source-write.js";
import { classifySlack } from "./source-places.js";
import { readScopeClaim } from "./source-store.js";
import { listSourceConfigs } from "./store.js";

/** Most pages one listing session may read in all (200 Slack channels, 100 Linear teams or Jira projects each). */
export const OPTION_PAGES_MAX = 10;
/** How long a listing session lasts. */
export const OPTION_SESSION_SECONDS = 900;
/** Slack page reads a company may make a minute (Slack's `conversations.list` allows about twenty a minute for the whole app, and the channel-by-name lookup shares it). */
export const SLACK_LIST_PER_MINUTE = 12;
/** First pages one person may open a minute. */
export const LISTINGS_PER_PERSON_PER_MINUTE = 60;
const SESSION_SK = "SRCOPT#";
const CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.*)$/su;
const OPTIONS_MAX = 200;
const SLACK_CURSOR = /^[A-Za-z0-9+/=_%.-]{1,300}$/u;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The list can't be read right now.");
const scopeMissing = (): RecordRouteReply => ({ status: 503, body: { code: "SLACK_SCOPE_MISSING", message: "Rovara can't list channels. Ask an admin to reinstall the Slack app." } });

interface Found { options: Array<Omit<SourceOption, "state"> & { connect?: true }>; next?: string }
const invalidRequest = () => agentXError("CONFIG_INVALID", "The request is not valid.");

export async function sourceOptions(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<RecordRouteReply> {
  const sources = deps.sources;
  const ctx = request.write;
  if (sources === undefined || ctx === undefined) throw agentXError("NOT_FOUND", "No such route.");
  gate(request, ctx);
  const parsed = SourceOptionsQuerySchema.safeParse({ kind: request.query.kind, ...(request.query.cursor === undefined || request.query.cursor === "" ? {} : { cursor: request.query.cursor }) });
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "The request is not valid.");
  const { kind } = parsed.data;
  const cursorMatch = parsed.data.cursor === undefined ? undefined : CURSOR.exec(parsed.data.cursor);
  if (parsed.data.cursor !== undefined && cursorMatch === null) throw invalidRequest();
  let session = cursorMatch?.[1];
  const inner = cursorMatch === null || cursorMatch === undefined || cursorMatch[2] === "" ? undefined : cursorMatch[2];
  const orgId = request.caller.orgId;

  // The server's own count of pages read in this session (a later page adds one, and is refused at the bound), or, for a first page, the person's rate.
  let pages = 1;
  if (session !== undefined) pages = await takePage(deps, orgId, project, kind, session);
  else await ration(deps, orgId, `person:${request.caller.developerId}`, "source-options", LISTINGS_PER_PERSON_PER_MINUTE);

  let found: Found | RecordRouteReply;
  if (kind === "slack") {
    if (inner !== undefined && !SLACK_CURSOR.test(inner)) throw invalidRequest();
    found = await slackOptions(deps, ctx, orgId, inner);
  } else {
    found = await trackerOptions(deps, orgId, kind, inner);
  }
  if ("status" in found) return found;

  // More to read: the first such page opens the session that counts the pages; at the bound the list is cut and says so.
  let next: string | undefined;
  let truncated = false;
  if (found.next !== undefined) {
    if (session === undefined) { session = await openSession(deps, orgId, project, kind); pages = 1; }
    if (pages >= OPTION_PAGES_MAX) truncated = true; else next = `${session}.${found.next}`;
  }
  const states = await statesOf(deps, orgId, project, kind, found.options.map((option) => option.scope));
  const options: SourceOption[] = found.options.map((option) => {
    const { connect, ...rest } = option;
    const held = states.get(option.scope);
    return { ...rest, state: held === "added" ? "added" : connect === true ? "slack_connect" : held === "taken" ? "taken" : "available" };
  });
  return { status: 200, body: SourceOptionsViewSchema.parse({ kind, options, ...(next === undefined ? {} : { next }), ...(truncated ? { truncated: true as const } : {}) }) };
}

/** The channels of the workspace this company bound. Another company, or one that never bound a workspace, gets an empty list and Slack is never asked. */
async function slackOptions(deps: RecordQueryDependencies, ctx: SourceWriteContext, orgId: OrgId, cursor: string | undefined): Promise<Found | RecordRouteReply> {
  const sources = deps.sources!;
  const teamId = ctx.slackTeamId;
  if (teamId === undefined || ctx.slackChannels === undefined || sources.slackTeamBound === undefined) throw unavailable();
  let mine: boolean;
  try { mine = await sources.slackTeamBound(orgId, teamId); } catch { throw unavailable(); }
  if (!mine) return { options: [] };
  // One company's reads of Slack's list method are rationed (every editor of the company counts together).
  await ration(deps, orgId, "org", "source-options-slack", SLACK_LIST_PER_MINUTE);
  let answer: Awaited<ReturnType<NonNullable<SourceWriteContext["slackChannels"]>>>;
  try { answer = await ctx.slackChannels({ teamId, ...(cursor === undefined ? {} : { cursor }) }); } catch { throw unavailable(); }
  if (!answer.ok) { if (answer.error === "missing_scope") return scopeMissing(); throw unavailable(); }
  const options: Found["options"] = [];
  for (const channel of answer.channels) {
    if (options.length >= OPTIONS_MAX) break;
    if (channel.kind !== "public" && channel.kind !== "private") continue; // a direct message or group message is never listed (the bot sees only its own)
    const name = channel.name.slice(0, 200);
    if (name === "" || !/^[CG][A-Z0-9]{2,31}$/u.test(channel.id)) continue;
    options.push({ scope: `slack:${teamId}/${channel.id}`, name, slackKind: channel.kind, joined: channel.joined === true, ...(classifySlack({ kind: channel.kind, extShared: channel.extShared }) === "slack_connect" ? { connect: true as const } : {}) });
  }
  return { options, ...(answer.next !== undefined && SLACK_CURSOR.test(answer.next) ? { next: answer.next } : {}) };
}

/** The places of the caller company's connected apps of this kind. A place two connections both list is shown once in a page. */
async function trackerOptions(deps: RecordQueryDependencies, orgId: OrgId, kind: Exclude<SourcePickerKind, "slack">, cursor: string | undefined): Promise<Found> {
  const read = deps.sources!.trackerOptions;
  if (read === undefined) throw unavailable();
  let page: Awaited<ReturnType<typeof read>>;
  try { page = await read(orgId, kind, cursor); } catch { page = undefined; }
  if (page === undefined) throw unavailable();
  const seen = new Set<string>();
  const options: Found["options"] = [];
  for (const place of page.places) {
    if (options.length >= OPTIONS_MAX || seen.has(place.scope)) continue;
    seen.add(place.scope);
    options.push({ scope: place.scope, name: place.name.slice(0, 200) });
  }
  return { options, ...(page.next === undefined ? {} : { next: page.next }) };
}

/** Whether each place is already a source of this project (its row, or its claim) or held by another project. A claim that cannot be read fails the whole read. */
async function statesOf(deps: RecordQueryDependencies, orgId: OrgId, project: string, kind: SourcePickerKind, scopes: readonly string[]): Promise<Map<string, "added" | "taken">> {
  const states = new Map<string, "added" | "taken">();
  if (scopes.length === 0) return states;
  try {
    const mine = new Set((await listSourceConfigs(deps.table, orgId, project)).filter((row) => row.source === kind).map((row) => row.scope));
    for (let from = 0; from < scopes.length; from += 25) {
      await Promise.all(scopes.slice(from, from + 25).map(async (scope) => {
        if (mine.has(scope)) { states.set(scope, "added"); return; }
        const holder = await readScopeClaim(deps.table, orgId, kind, scope);
        if (holder === undefined) return;
        states.set(scope, holder === project ? "added" : "taken");
      }));
    }
  } catch { throw unavailable(); }
  return states;
}

// ---- the listing session and the rates

/** Takes one from the company's or person's minute. No limiter wired: no limit. A limiter that cannot answer refuses (fail closed). */
async function ration(deps: RecordQueryDependencies, orgId: OrgId, who: string, what: string, limit: number): Promise<void> {
  if (deps.limiter === undefined) return;
  const allowed = await deps.limiter.take(`${orgId}|${what}|${who}`, limit, 60).then((value) => value, () => false);
  if (!allowed) throw agentXError("TOO_MANY_REQUESTS", "Too many requests. Try again in a minute.");
}

const sessionKey = (orgId: OrgId, session: string) => ({ pk: teamRecordPk(orgId), sk: `${SESSION_SK}${session}` });
const nowSeconds = (deps: RecordQueryDependencies): number => Math.floor((deps.now ?? Date.now)() / 1000);

/** The session of a listing that has more pages: this company's partition, this project and kind, the pages read so far (one). Holds no person and no text. */
async function openSession(deps: RecordQueryDependencies, orgId: OrgId, project: string, kind: SourcePickerKind): Promise<string> {
  const session = randomUUID();
  try {
    await deps.table.documentClient.send(new PutCommand({
      TableName: deps.table.tableName,
      Item: { ...sessionKey(orgId, session), entityType: "TEAM_RECORD_SOURCE_OPTIONS", kind, project, pages: 1, [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds(deps) + OPTION_SESSION_SECONDS },
      ConditionExpression: NOT_EXISTS,
    }));
  } catch { throw unavailable(); }
  return session;
}

/** One more page of the session, or a refusal: the session must exist in THIS company's partition, be unexpired, belong to this project and kind, and have read fewer than 10 pages. Returns the count now. */
async function takePage(deps: RecordQueryDependencies, orgId: OrgId, project: string, kind: SourcePickerKind, session: string): Promise<number> {
  const aliases = new Aliases();
  const [pages, kindName, projectName, expires] = [aliases.name("pages"), aliases.name("kind"), aliases.name("project"), aliases.name(INDEX_EXPIRY_ATTRIBUTE)];
  try {
    const result = await deps.table.documentClient.send(new UpdateCommand({
      TableName: deps.table.tableName, Key: sessionKey(orgId, session),
      UpdateExpression: `ADD ${pages} ${aliases.value(1)}`,
      ConditionExpression: `attribute_exists(pk) AND ${kindName} = ${aliases.value(kind)} AND ${projectName} = ${aliases.value(project)} AND ${pages} < ${aliases.value(OPTION_PAGES_MAX)} AND ${expires} > ${aliases.value(nowSeconds(deps))}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values, ReturnValues: "ALL_NEW",
    })) as { Attributes?: { pages?: unknown } };
    const count = result.Attributes?.pages;
    if (typeof count !== "number") throw unavailable();
    return count;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") throw invalidRequest();
    if (error instanceof AgentXError) throw error;
    throw unavailable();
  }
}
