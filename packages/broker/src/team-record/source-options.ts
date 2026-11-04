// What an editor may pick instead of typing an id (source-row lane, task 10): `GET /v1/app/projects/{p}/record/sources/options?kind=slack|linear|jira&cursor=`.
//   Slack   the channels the bot sees in the workspace this company bound (read fresh through DeveloperIdentity, which holds the bot token; direct messages only where the edition allows them);
//   Linear  the teams of the company's connected app; Jira  the projects of the company's connections (the same live readers the write route checks a typed place against).
// WHO. The same people as the write route (`gate`): an owner, an admin or a maintainer of this project, on a live browser session. Everyone else is refused before anything is read.
// ORG. Only the caller's session org: the Slack workspace is listed only when it is bound to THAT company (another company gets an empty list and Slack is never asked), and the connected apps are
// the caller company's. Each option says whether this project already has it, whether another project holds it (never named), or whether it is never allowed (Slack Connect). Nothing is stored.
// BOUNDS. At most 200 an answer, at most 10 pages in all (the cursor carries the page number: `<page>.<the tool's own cursor>`). Every failure is a fixed code: Slack down or unreadable, an app
// that cannot be read, no reader wired, all 503 `RUNTIME_UNAVAILABLE` (the screen then offers the typed field); a bot without the listing scopes is 503 `SLACK_SCOPE_MISSING`. No text from Slack or a tool
// is ever in an error; names appear only in the options, cut to 200 characters, and the screen shows them as plain text.
import { SourceOptionsQuerySchema, SourceOptionsViewSchema, agentXError, type OrgId, type SourceOption, type SourcePickerKind } from "@agentx/contracts";
import { slackScopeAllowed } from "./edition.js";
import type { RecordQueryDependencies } from "./query.js";
import type { RecordRouteReply, RecordRouteRequest } from "./routes.js";
import { gate, type SourceWriteContext } from "./source-write.js";
import { classifySlack } from "./source-places.js";
import { readScopeClaim } from "./source-store.js";
import { listSourceConfigs } from "./store.js";

/** Most pages one picker may read in all (200 Slack channels, 100 Linear teams or Jira projects each). */
export const OPTION_PAGES_MAX = 10;
const OPTIONS_MAX = 200;
const SLACK_CURSOR = /^[A-Za-z0-9+/=_%.-]{1,300}$/u;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The list can't be read right now.");
const scopeMissing = (): RecordRouteReply => ({ status: 503, body: { code: "SLACK_SCOPE_MISSING", message: "Rovara can't list channels. Ask an admin to reinstall the Slack app." } });

interface Found { options: Array<Omit<SourceOption, "state"> & { connect?: true }>; next?: string }

export async function sourceOptions(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<RecordRouteReply> {
  const sources = deps.sources;
  const ctx = request.write;
  if (sources === undefined || ctx === undefined) throw agentXError("NOT_FOUND", "No such route.");
  gate(request, ctx);
  const parsed = SourceOptionsQuerySchema.safeParse({ kind: request.query.kind, ...(request.query.cursor === undefined || request.query.cursor === "" ? {} : { cursor: request.query.cursor }) });
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "The request is not valid.");
  const { kind } = parsed.data;
  const cursorMatch = parsed.data.cursor === undefined ? undefined : /^([0-9]{1,2})\.(.*)$/su.exec(parsed.data.cursor);
  const page = cursorMatch === null || cursorMatch === undefined ? 0 : Number(cursorMatch[1]);
  const inner = cursorMatch === null || cursorMatch === undefined || cursorMatch[2] === "" ? undefined : cursorMatch[2];
  if (page >= OPTION_PAGES_MAX) throw agentXError("CONFIG_INVALID", "The request is not valid.");
  const orgId = request.caller.orgId;

  let found: Found | RecordRouteReply;
  if (kind === "slack") {
    if (inner !== undefined && !SLACK_CURSOR.test(inner)) throw agentXError("CONFIG_INVALID", "The request is not valid.");
    found = await slackOptions(deps, ctx, orgId, inner);
  } else {
    found = await trackerOptions(deps, orgId, kind, inner);
  }
  if ("status" in found) return found;

  const next = found.next !== undefined && page + 1 < OPTION_PAGES_MAX ? `${String(page + 1)}.${found.next}` : undefined;
  const states = await statesOf(deps, orgId, project, kind, found.options.map((option) => option.scope));
  const options: SourceOption[] = found.options.map((option) => {
    const { connect, ...rest } = option;
    const held = states.get(option.scope);
    return { ...rest, state: held === "added" ? "added" : connect === true ? "slack_connect" : held === "taken" ? "taken" : "available" };
  });
  return { status: 200, body: SourceOptionsViewSchema.parse({ kind, options, ...(next === undefined ? {} : { next }) }) };
}

/** The channels of the workspace this company bound. Another company, or one that never bound a workspace, gets an empty list and Slack is never asked. */
async function slackOptions(deps: RecordQueryDependencies, ctx: SourceWriteContext, orgId: OrgId, cursor: string | undefined): Promise<Found | RecordRouteReply> {
  const sources = deps.sources!;
  const teamId = ctx.slackTeamId;
  if (teamId === undefined || ctx.slackChannels === undefined || sources.slackTeamBound === undefined) throw unavailable();
  let mine: boolean;
  try { mine = await sources.slackTeamBound(orgId, teamId); } catch { throw unavailable(); }
  if (!mine) return { options: [] };
  const edition = sources.edition;
  const includeDirect = slackScopeAllowed(edition, "dm").allowed;
  let answer: Awaited<ReturnType<NonNullable<SourceWriteContext["slackChannels"]>>>;
  try { answer = await ctx.slackChannels({ teamId, includeDirect, ...(cursor === undefined ? {} : { cursor }) }); } catch { throw unavailable(); }
  if (!answer.ok) { if (answer.error === "missing_scope") return scopeMissing(); throw unavailable(); }
  const options: Found["options"] = [];
  for (const channel of answer.channels) {
    if (options.length >= OPTIONS_MAX) break;
    if ((channel.kind === "im" || channel.kind === "mpim") && !slackScopeAllowed(edition, channel.kind === "im" ? "dm" : "mpim").allowed) continue; // never shown where the edition does not allow them
    const name = channel.name.slice(0, 200);
    if (name === "" || !/^[CGD][A-Z0-9]{2,31}$/u.test(channel.id)) continue;
    options.push({ scope: `slack:${teamId}/${channel.id}`, name, slackKind: channel.kind, ...(classifySlack({ kind: channel.kind, extShared: channel.extShared }) === "slack_connect" ? { connect: true as const } : {}) });
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
