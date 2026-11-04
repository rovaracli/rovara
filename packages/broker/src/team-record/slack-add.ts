// Start from inside Slack (source-row lane, task 12; owner decision 2026-11-04, "Adding private Slack channels", item D). In any channel someone writes `@Rovara learn from this channel`; Rovara answers ONLY
// that person (chat.postEphemeral) with an "Add to project" prompt: a project menu (only projects they edit), a retention choice limited to what the edition offers, and an Add button. The same prompt goes to
// whoever first invites Rovara into a PRIVATE channel (`member_joined_channel`, the `inviter` field). Pressing Add saves through the SAME source route as the web (`handleRecordRoute`, `source-write.ts`): editor of that
// project, the server classifies the channel, Slack Connect refused, DMs Enterprise only, the Public A/B rules, the place claim, replay by requestId, and the audit event with `widened`.
//
// WHO. Identity comes only from the signed Slack request: the ingress verified the signature and the team, and hands this module the Slack user id, the team and the channel it saw. The company is the one the Slack team
// is bound to (`orgOfSlackTeam`, the binding the tap uses); the person is `developerOfSlackUser(slack user)` (the sign-in store's Slack link). Nothing in a message's text is ever read as an id. The person's rights are read live
// at the prompt and again at the press (company role and project role), never taken from the prompt.
//
// THE PROMPT is one item in the company's partition (`SLKADD#<uuid>`: team, channel, a HASH of the person, an expiry of 15 minutes; no Slack user id, no text). The Add button carries only that id. A press must come from
// the same Slack user in the same channel and team, before it expires. The press is acknowledged at once and the work is handed to an asynchronous invoke of the same Lambda, which answers through the press's response_url.
// The route's requestId is derived from the interaction id, so one press delivered twice is one save. Once a press has SAVED, the outcome ("added") is stored on the prompt and every later press by that person answers it
// and closes the prompt (Slack never redelivers a press, so a retry after a timeout is a new interaction); a press that finds the row already there on a prompt a press had begun on is the same "Added". A refusal is never
// stored: the prompt stays open. One prompt per person per channel per 10 minutes (the record's rate item, keyed by the hash).
//
// THE ACTOR. A Slack press is not a browser session: the write context says `browserSession: false` and `actor: "slack_interaction"`, which the source route accepts for adding a Slack place only (`source-write.ts`), and the
// audit event for it says `via: slack`. Only this module sets that actor.
//
// A PRIVATE CHANNEL. Being in the channel proves membership when the prompt is made, but the button can be pressed later: the server reads the channel's class live and, for a private channel or group message, asks
// Slack again whether the person is still in it (`isMember`, through DeveloperIdentity's `channel-members`). Unreadable fails closed. The route still classifies the channel itself and decides everything else.
//
// Everything here is fixed sentences. No client text (a project name, a retention word) is ever echoed. The ingress and interactivity sides are small adapters at the bottom of the file; the logic is the service.
import { createHash, randomUUID } from "node:crypto";
import {
  AgentXError, SlackChannelIdSchema, SlackTeamIdSchema, SlackUserIdSchema, isWriterOrgRole,
  type OrgId, type ProjectRole,
} from "@agentx/contracts";
import { readProjectMeta } from "../developer/project-roles.js";
import { readProjectRole } from "../learning/standing.js";
import { OrgStore } from "../org/store.js";
import type { AuditDeps } from "../audit/outbox.js";
import { allowedRetention, defaultRetention, type TeamRecordEdition } from "./edition.js";
import type { RateLimiter } from "./query.js";
import type { RecordRouteReply } from "./routes.js";
import { classifySlack, type SlackFacts } from "./source-places.js";
import { markSlackAddStarted, markSlackAddUsed, putSlackAddPrompt, readSlackAddPrompt } from "./source-store.js";
import type { SourceWriteContext } from "./source-write.js";
import { WORDS as SOURCE_WORDS } from "./source-write.js";
import type { TeamRecordTable } from "./types.js";

/** What the person types after the mention. Matched exactly: trimmed, case-insensitive, nothing more. */
export const LEARN_PHRASE = "learn from this channel";
export const isLearnFromChannel = (text: string): boolean => text.trim().toLowerCase() === LEARN_PHRASE;

export const LEARN_ADD_ACTION = "rovara_record_add";
export const LEARN_PROJECT_ACTION = "rovara_record_project";
export const LEARN_PROJECT_BLOCK = "rovara_record_project_block";
export const LEARN_RETENTION_ACTION = "rovara_record_retention";
export const LEARN_RETENTION_BLOCK = "rovara_record_retention_block";
const ACTIONS_BLOCK = "rovara_record_actions";

/** The sentences this feature says. Fixed; none of them carries anything the client sent. */
export const SLACK_ADD_WORDS = {
  prompt: "Add this channel to a project's team record?",
  notLinked: "Link your Slack account to Rovara first.",
  notEditor: "Only a project maintainer or a company admin can add channels. Ask one of them to add this channel.",
  added: "Added. Rovara will start recording new messages.",
  expired: "This prompt has expired. Mention me with `learn from this channel` to get a new one.",
  notYours: "This prompt isn't yours. Mention me with `learn from this channel` to get your own.",
  chooseProject: "Choose a project first.",
  leftChannel: "You're not in that channel any more, so I can't add it.",
  unavailable: "I can't do that right now. Try again in a moment.",
  otherWorkspace: "Channels can be added only by a member of this Slack workspace.",
  taken: "That channel is already a source of another project.",
  alreadyHere: "That channel is already a source of this project.",
  inviteNeeded: "Rovara isn't in that channel yet. Type /invite @Rovara in the channel, then try again.",
  notOffered: SOURCE_WORDS.notOffered,
  cannotAdd: "That channel can't be added.",
  projectGone: "That project isn't available any more.",
  notesNote: "Rovara keeps short notes with links to the messages, never the messages themselves. See <https://slack.com/terms-of-service/api|Slack's API terms>.",
} as const;

export type SlackAddAnswer = { show: { text: string; blocks?: Array<Record<string, unknown>> } } | { none: true };
export interface SlackAddPressAnswer { text: string; final: boolean }
const NONE = { none: true } as const;
const say = (text: string, final: boolean): SlackAddPressAnswer => ({ text, final });

// ---- what the broker is asked (the ingress holds no table: it asks the broker, which holds the record)

const SOURCE = "agentx.slack-ingress";
const ACTION = "team-record-slack-add";
export interface SlackAddAskInput { teamId: string; userId: string; channelId: string; trigger: "phrase" | "invite" }
export interface SlackAddPressInput { teamId: string; userId: string; channelId: string; token: string; project?: string; retention?: string; interactionId: string }
export type SlackAddEvent = { source: typeof SOURCE; action: typeof ACTION; step: "ask" } & SlackAddAskInput | { source: typeof SOURCE; action: typeof ACTION; step: "press" } & SlackAddPressInput;

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ids = (value: { teamId?: unknown; userId?: unknown; channelId?: unknown }) => SlackTeamIdSchema.safeParse(value.teamId).success && SlackUserIdSchema.safeParse(value.userId).success && SlackChannelIdSchema.safeParse(value.channelId).success;

/** A direct invoke from the ingress, never an HTTP request, with well-formed ids. */
export function isTeamRecordSlackAddEvent(event: unknown): event is SlackAddEvent {
  if (event === null || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  if (value.source !== SOURCE || value.action !== ACTION || value.requestContext !== undefined || !ids(value)) return false;
  if (value.step === "ask") return value.trigger === "phrase" || value.trigger === "invite";
  if (value.step !== "press") return false;
  const text = (field: unknown, max: number): boolean => typeof field === "string" && field.length >= 1 && field.length <= max;
  return text(value.token, 100) && text(value.interactionId, 200) && (value.project === undefined || (typeof value.project === "string" && value.project.length <= 150)) && (value.retention === undefined || (typeof value.retention === "string" && value.retention.length <= 20));
}

// ---- the service

export const PROMPT_SECONDS = 15 * 60;
const RATE_SECONDS = 600;
const PROJECTS_SCANNED = 300;
const PROJECTS_OFFERED = 100;
const OPTION_TEXT = 75;
const OPTION_VALUE = 150;
const SCAN_PARALLEL = 25;

/** What the broker reads from Slack for one call (DeveloperIdentity holds the bot token). Each is absent where the install cannot read it: that fails closed. */
export interface SlackAddPorts {
  /** This install's own Slack team. A request for another team is not answered. */
  teamId?: string | undefined;
  /** What Slack says a channel is, read fresh: its facts, "none" when Slack does not show it to Rovara, undefined (or a throw) when it could not be read. */
  channel?: SourceWriteContext["slackChannel"] | undefined;
  /** Whether the Slack user is in the channel now. Undefined (or a throw): could not be read. */
  isMember?: ((userId: string, channelId: string) => Promise<boolean | undefined>) | undefined;
  /** The audit outbox. Absent: a write that widens what is kept is refused by the route. */
  audit?: AuditDeps | undefined;
}

export interface SlackAddRouteRequest {
  method: string; path: string; query: Readonly<Record<string, string | undefined>>;
  caller: { orgId: OrgId; developerId: string; projectRole: ProjectRole | undefined };
  write: SourceWriteContext;
}

export interface SlackAddDeps {
  edition: TeamRecordEdition;
  /** The TeamRecord table: the prompt items. */
  table: TeamRecordTable;
  /** The State table: the person's company role and project grants, the projects' records. */
  state: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string };
  now(): number;
  /** The company a Slack team is bound to, or undefined. */
  orgOfSlackTeam(teamId: string): Promise<OrgId | undefined>;
  /** The Rovara person a Slack user id is linked to, or undefined. */
  developerOfSlackUser(slackUserId: string): Promise<string | undefined>;
  projectsOf(orgId: OrgId): Promise<string[]>;
  limiter: RateLimiter;
  /** The record's own source route (`runtime.routes`): the same one the web uses. */
  route(request: SlackAddRouteRequest): Promise<RecordRouteReply | undefined>;
  newId?(): string;
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const personOf = (orgId: OrgId, slackUserId: string): string => sha(`slack-add\0${orgId}\0${slackUserId}`);
/** A requestId (a UUID the route accepts) derived from the Slack interaction: one press, however many times Slack delivers it, is one request. */
function requestIdOf(teamId: string, userId: string, interactionId: string): string {
  const hex = sha(`slack-add-request\0${teamId}\0${userId}\0${interactionId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[Number.parseInt(hex.charAt(16), 16) % 4]!}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const strip = (error: AgentXError): string => error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message;
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const RETENTION_LABELS: Record<"public" | "enterprise", Record<string, string>> = {
  public: { A: "Live only", B: "Keep notes with links" },
  enterprise: { A: "Nothing; read live", B: "Only notes with links", C: "Text for 30 days, then notes", D: "Full history" },
};

export interface SlackAddService {
  ask(ports: SlackAddPorts, input: SlackAddAskInput): Promise<SlackAddAnswer>;
  press(ports: SlackAddPorts, input: SlackAddPressInput): Promise<SlackAddPressAnswer>;
}

export function createSlackAdd(deps: SlackAddDeps): SlackAddService {
  const orgs = new OrgStore({ documentClient: deps.state.documentClient, tableName: deps.state.tableName, now: () => deps.now() });
  /** The person's company role now, or undefined when they are not a member of this company (the company's own record of who is in it, never a Slack claim). */
  async function orgRoleOf(orgId: OrgId, developerId: string): Promise<string | undefined> {
    const member = await orgs.orgForDeveloper(developerId);
    return member?.orgId === orgId ? member.role : undefined;
  }

  /** Whether the person may edit this project's sources right now: a company role that writes, a maintainer of an existing, unarchived project. */
  async function mayEdit(orgId: OrgId, developerId: string, orgRole: string | undefined, project: string): Promise<ProjectRole | undefined> {
    if (orgRole === undefined || !isWriterOrgRole(orgRole)) return undefined;
    const meta = await readProjectMeta(deps.state, orgId, project);
    if (meta === undefined || meta.status === "archived") return undefined;
    const role = await readProjectRole(deps.state, orgId, developerId, project);
    return role === "maintainer" ? role : undefined;
  }

  async function editableProjects(orgId: OrgId, developerId: string): Promise<string[]> {
    const orgRole = await orgRoleOf(orgId, developerId);
    if (orgRole === undefined || !isWriterOrgRole(orgRole)) return [];
    const names = [...new Set(await deps.projectsOf(orgId))].filter((name) => name.length > 0 && name.length <= OPTION_VALUE).sort().slice(0, PROJECTS_SCANNED);
    const editable: string[] = [];
    for (let start = 0; start < names.length && editable.length < PROJECTS_OFFERED; start += SCAN_PARALLEL) {
      const batch = names.slice(start, start + SCAN_PARALLEL);
      const roles = await Promise.all(batch.map((name) => mayEdit(orgId, developerId, orgRole, name)));
      batch.forEach((name, index) => { if (roles[index] !== undefined) editable.push(name); });
    }
    return editable.slice(0, PROJECTS_OFFERED);
  }

  function promptBlocks(token: string, channelId: string, projects: string[]): Array<Record<string, unknown>> {
    const edition = deps.edition;
    const option = (value: string, text: string) => ({ text: { type: "plain_text", text: text.slice(0, OPTION_TEXT) }, value });
    const projectOptions = projects.map((name) => option(name, name));
    const offered = allowedRetention(edition, "slack").map((mode) => option(mode, RETENTION_LABELS[edition][mode] ?? mode));
    const initialRetention = offered.find((entry) => entry.value === defaultRetention(edition, "slack")) ?? offered[0]!;
    return [
      { type: "section", text: { type: "mrkdwn", text: `Add <#${channelId}> to a project's team record?` } },
      { type: "section", block_id: LEARN_PROJECT_BLOCK, text: { type: "mrkdwn", text: "Project" },
        accessory: { type: "static_select", action_id: LEARN_PROJECT_ACTION, placeholder: { type: "plain_text", text: "Choose a project" }, options: projectOptions, ...(projectOptions.length === 1 ? { initial_option: projectOptions[0] } : {}) } },
      { type: "section", block_id: LEARN_RETENTION_BLOCK, text: { type: "mrkdwn", text: "How long Rovara keeps it" },
        accessory: { type: "static_select", action_id: LEARN_RETENTION_ACTION, placeholder: { type: "plain_text", text: "Choose" }, options: offered, initial_option: initialRetention } },
      ...(edition === "public" ? [{ type: "context", elements: [{ type: "mrkdwn", text: SLACK_ADD_WORDS.notesNote }] }] : []),
      { type: "actions", block_id: ACTIONS_BLOCK, elements: [{ type: "button", action_id: LEARN_ADD_ACTION, text: { type: "plain_text", text: "Add" }, style: "primary", value: token }] },
    ];
  }

  async function ask(ports: SlackAddPorts, input: SlackAddAskInput): Promise<SlackAddAnswer> {
    if (!ids(input)) return NONE;
    const invite = input.trigger === "invite";
    // An invite that cannot be answered says nothing: Rovara never speaks in the channel, and never explains to a person who did not ask.
    const quiet = (text: string): SlackAddAnswer => (invite ? NONE : { show: { text } });
    try {
      const orgId = await deps.orgOfSlackTeam(input.teamId);
      if (orgId === undefined) return NONE;
      if (ports.teamId !== undefined && ports.teamId !== input.teamId) return NONE;
      // An invite is only for a PRIVATE channel, by what Slack says it is now (the flags, never the id's letter; a private channel made after March 2021 has a C id). This comes before the rate item, so a join of a public
      // channel never uses the person's window. Anything else (public, a group message, Slack Connect, unreadable, not shown to Rovara) is silence.
      if (invite) {
        let facts: SlackFacts | "none" | undefined;
        try { facts = ports.channel === undefined ? undefined : await ports.channel(input.teamId, input.channelId); } catch { facts = undefined; }
        if (facts === undefined || facts === "none" || classifySlack(facts) !== "private_channel") return NONE;
      }
      const person = personOf(orgId, input.userId);
      // A limiter that cannot answer is silence: nothing is shown that cannot be rationed.
      if (!await deps.limiter.take(`${orgId}|slack-add|${person}|${input.channelId}`, 1, RATE_SECONDS).then((allowed) => allowed, () => false)) return NONE;
      const developerId = await deps.developerOfSlackUser(input.userId);
      if (developerId === undefined) return quiet(SLACK_ADD_WORDS.notLinked);
      const projects = await editableProjects(orgId, developerId);
      if (projects.length === 0) return quiet(SLACK_ADD_WORDS.notEditor);
      const token = (deps.newId ?? randomUUID)();
      await putSlackAddPrompt(deps.table, orgId, token, { team: input.teamId, channel: input.channelId, person, createdAt: new Date(deps.now()).toISOString(), expiresAtSeconds: Math.floor(deps.now() / 1000) + PROMPT_SECONDS });
      return { show: { text: SLACK_ADD_WORDS.prompt, blocks: promptBlocks(token, input.channelId, projects) } };
    } catch {
      return quiet(SLACK_ADD_WORDS.unavailable);
    }
  }

  async function press(ports: SlackAddPorts, input: SlackAddPressInput): Promise<SlackAddPressAnswer> {
    if (!ids(input)) return say(SLACK_ADD_WORDS.expired, true);
    try {
      const orgId = await deps.orgOfSlackTeam(input.teamId);
      if (orgId === undefined || (ports.teamId !== undefined && ports.teamId !== input.teamId)) return say(SLACK_ADD_WORDS.expired, true);
      const item = TOKEN.test(input.token) ? await readSlackAddPrompt(deps.table, orgId, input.token) : undefined;
      if (item === undefined || !(item.expiresAtSeconds * 1000 > deps.now()) || item.team !== input.teamId) return say(SLACK_ADD_WORDS.expired, true);
      // The press must be the person and the channel the prompt was made for. Another person's press changes nothing and does not use the prompt.
      if (item.person !== personOf(orgId, input.userId) || item.channel !== input.channelId) return say(SLACK_ADD_WORDS.notYours, false);
      // A prompt that saved answers every later press by its person with that outcome (a retry after a press that timed out carries a new interaction id), and closes the prompt.
      if (item.doneOutcome === "added") return say(SLACK_ADD_WORDS.added, true);
      const developerId = await deps.developerOfSlackUser(input.userId);
      if (developerId === undefined) return say(SLACK_ADD_WORDS.notLinked, false);
      const project = input.project;
      if (project === undefined || project === "") return say(SLACK_ADD_WORDS.chooseProject, false);
      const retention = input.retention ?? defaultRetention(deps.edition, "slack");
      if (!(allowedRetention(deps.edition, "slack") as string[]).includes(retention)) return say(SLACK_ADD_WORDS.notOffered, true);
      // Their rights are read again now: company role, then the project.
      const orgRole = await orgRoleOf(orgId, developerId);
      const projectRole = await mayEdit(orgId, developerId, orgRole, project);
      if (orgRole === undefined || projectRole === undefined) return say(SLACK_ADD_WORDS.notEditor, true);
      const refusal = await channelRefusal(ports, input);
      if (refusal !== undefined) return refusal;
      const body = {
        action: "add", requestId: requestIdOf(input.teamId, input.userId, input.interactionId), source: "slack", scope: `slack:${input.teamId}/${input.channelId}`, retention,
        audienceDefault: "maintainers", enabled: true, ...(deps.edition === "public" && retention === "B" ? { notesOptIn: true } : {}),
      };
      const write: SourceWriteContext = {
        orgRole, browserSession: false, actor: "slack_interaction", body: () => body,
        ...(ports.audit === undefined ? {} : { audit: ports.audit }), ...(ports.channel === undefined ? {} : { slackChannel: ports.channel }), ...(ports.teamId === undefined ? {} : { slackTeamId: ports.teamId }),
      };
      await markSlackAddStarted(deps.table, orgId, input.token, input.interactionId);
      let reply: RecordRouteReply | undefined;
      try {
        reply = await deps.route({ method: "POST", path: `/v1/app/projects/${encodeURIComponent(project)}/record/sources`, query: {}, caller: { orgId, developerId, projectRole }, write });
      } catch (error) {
        return error instanceof AgentXError ? refusalOf(error.code, strip(error)) : say(SLACK_ADD_WORDS.unavailable, false);
      }
      // The row is already there and an earlier press began on THIS prompt: that was this prompt's own save (its press timed out or its used-mark did not land), so it is "Added" too.
      const own = item.startedBy !== undefined && typeof reply?.body === "object" && reply.body !== null && (reply.body as { code?: unknown }).code === "CHANGE_STALE";
      const answer = own ? say(SLACK_ADD_WORDS.added, true) : answerOf(reply);
      if (own || (answer.final && reply?.status === 200)) await markSlackAddUsed(deps.table, orgId, input.token);
      return answer;
    } catch {
      return say(SLACK_ADD_WORDS.unavailable, false);
    }
  }

  /** What Slack says the channel is now; for a private channel or a group message, whether the person is still in it. Fails closed. */
  async function channelRefusal(ports: SlackAddPorts, input: SlackAddPressInput): Promise<SlackAddPressAnswer | undefined> {
    if (ports.channel === undefined) return say(SLACK_ADD_WORDS.unavailable, false);
    let facts: SlackFacts | "none" | undefined;
    try { facts = await ports.channel(input.teamId, input.channelId); } catch { facts = undefined; }
    if (facts === undefined) return say(SLACK_ADD_WORDS.unavailable, false);
    if (facts === "none") return say(SLACK_ADD_WORDS.inviteNeeded, true);
    const place = classifySlack(facts);
    if (place === "public_channel" || place === "slack_connect") return undefined;
    let member: boolean | undefined;
    try { member = ports.isMember === undefined ? undefined : await ports.isMember(input.userId, input.channelId); } catch { member = undefined; }
    if (member === undefined) return say(SLACK_ADD_WORDS.unavailable, false);
    return member ? undefined : say(SLACK_ADD_WORDS.leftChannel, true);
  }

  return { ask, press };
}

/** The route's answer as a sentence: "Added", or one of its own fixed refusal sentences. Anything not recognised is "try again" with no detail. */
function answerOf(reply: RecordRouteReply | undefined): SlackAddPressAnswer {
  if (reply === undefined) return say(SLACK_ADD_WORDS.unavailable, false);
  const body = typeof reply.body === "object" && reply.body !== null ? reply.body as Record<string, unknown> : {};
  if (reply.status === 200 && body.status === "saved") return say(SLACK_ADD_WORDS.added, true);
  return refusalOf(typeof body.code === "string" ? body.code : "", typeof body.message === "string" ? body.message : "");
}

/** The route's own route-local refusals: each carries one fixed sentence of its own, said as it is. */
const OWN_SENTENCE = new Set(["SOURCE_REMOVAL_RUNNING", "SOURCE_CLEARING", "SOURCE_REMOVAL_BUSY", "SOURCE_NOT_ALLOWED", "SLACK_INVITE_NEEDED", "SLACK_WRONG_WORKSPACE", "SOURCE_KIND_NOT_YET"]);

/** A refusal the route gave (the same ones the web screen shows), as one of its fixed sentences. A message that is not one of the route's own is never passed on. */
function refusalOf(code: string, message: string): SlackAddPressAnswer {
  if (OWN_SENTENCE.has(code) && message !== "") return say(message, true);
  switch (code) {
    case "CONFIG_INVALID":
      if (message === SOURCE_WORDS.taken) return say(SLACK_ADD_WORDS.taken, true);
      return say([SOURCE_WORDS.notOffered, SOURCE_WORDS.ceiling, SOURCE_WORDS.place].includes(message as never) ? message : SLACK_ADD_WORDS.cannotAdd, true);
    case "CHANGE_STALE": return say(SLACK_ADD_WORDS.alreadyHere, true);
    case "FORBIDDEN": return say(SLACK_ADD_WORDS.notEditor, true);
    case "PROJECT_NOT_FOUND": return say(SLACK_ADD_WORDS.projectGone, true);
    case "AUDIT_UNAVAILABLE": return say(SOURCE_WORDS.audit, false);
    default: return say(SLACK_ADD_WORDS.unavailable, false);
  }
}

// ---- the ingress's side: the invite event and the private prompt

/** A bot's own user ids under the event's authorizations (only a bot authorization counts, as the mention path reads them). */
function ownBotUsers(payload: Record<string, unknown>): Set<string> {
  const entries = Array.isArray(payload.authorizations) ? payload.authorizations : [];
  return new Set(entries.flatMap((entry) => (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).is_bot === true && typeof (entry as Record<string, unknown>).user_id === "string" ? [(entry as Record<string, string>).user_id!] : [])));
}

/**
 * Rovara itself joining a channel because a person invited it: that person, the channel and the verified team. Every other membership event is not this. Whether the channel is PRIVATE is not read from the event (its
 * `channel_type` is only the id's letter, and a private channel made after March 2021 has a C id): the broker reads Slack's own flags and says nothing for a channel that is not private.
 */
export function botInvite(payload: Record<string, unknown>): { eventId: string; teamId: string; channelId: string; inviterId: string } | undefined {
  const event = typeof payload.event === "object" && payload.event !== null ? payload.event as Record<string, unknown> : {};
  if (payload.type !== "event_callback" || event.type !== "member_joined_channel") return undefined;
  const teamId = SlackTeamIdSchema.safeParse(payload.team_id);
  const channelId = SlackChannelIdSchema.safeParse(event.channel);
  const inviter = SlackUserIdSchema.safeParse(event.inviter);
  const bots = ownBotUsers(payload);
  if (!teamId.success || !channelId.success || !inviter.success || typeof payload.event_id !== "string" || payload.event_id === "") return undefined;
  if (typeof event.user !== "string" || !bots.has(event.user) || bots.has(inviter.data) || inviter.data === event.user) return undefined;
  if (event.team !== undefined && event.team !== teamId.data) return undefined;
  return { eventId: payload.event_id, teamId: teamId.data, channelId: channelId.data, inviterId: inviter.data };
}

export interface LearnIngress {
  recordLearn: {
    ask(input: SlackAddAskInput): Promise<SlackAddAnswer>;
    /** chat.postEphemeral: a message only `user` sees, in the thread when there is one and in the channel when there is not (an invite has no thread). */
    postEphemeral(input: { channel: string; threadTs?: string; user: string; text: string; blocks?: Array<Record<string, unknown>> }): Promise<void>;
  };
  claimEvent(eventId: string, expiresAtSeconds: number): Promise<boolean>;
  log?: ((event: string, fields: Record<string, string>) => void) | undefined;
}

/**
 * Asks the Team record and shows the answer to that one person. The event is claimed first (Slack's redelivery shows nothing twice). A record that fails is a fixed sentence for a typed phrase and silence for an
 * invite; nothing a person must retry is made to wait on Slack's own retry. Never throws.
 */
export async function offerLearnPrompt(deps: LearnIngress, input: { eventId: string; ask: SlackAddAskInput; threadTs?: string; claimUntilSeconds: number }): Promise<void> {
  const log = deps.log ?? (() => undefined);
  try {
    if (!await deps.claimEvent(input.eventId, input.claimUntilSeconds)) return;
  } catch (error) {
    log("record_learn.claim_failed", { errorName: errorName(error) });
    return;
  }
  let answer: SlackAddAnswer | undefined;
  try {
    answer = await deps.recordLearn.ask(input.ask);
  } catch (error) {
    log("record_learn.failed", { eventId: input.eventId, errorName: errorName(error) });
    if (input.ask.trigger === "phrase") answer = { show: { text: SLACK_ADD_WORDS.unavailable } };
  }
  if (answer === undefined || !("show" in answer)) return;
  try {
    await deps.recordLearn.postEphemeral({ channel: input.ask.channelId, ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }), user: input.ask.userId, text: answer.show.text, ...(answer.show.blocks === undefined ? {} : { blocks: answer.show.blocks }) });
  } catch (error) {
    log("record_learn.post_failed", { errorName: errorName(error) });
  }
}

interface BrokerReply { statusCode?: number; body?: string }
const parseBody = (reply: BrokerReply): Record<string, unknown> | undefined => {
  if (reply.statusCode !== 200) return undefined;
  try { const parsed: unknown = JSON.parse(reply.body ?? ""); return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
};

/** The ingress's `recordLearn.ask`: one direct invoke of the broker. Anything but a prompt or "nothing" throws. */
export function askThroughBroker(invoke: (event: Record<string, unknown>) => Promise<BrokerReply>): LearnIngress["recordLearn"]["ask"] {
  return async (input) => {
    const body = parseBody(await invoke({ source: SOURCE, action: ACTION, step: "ask", ...input }));
    if (body?.none === true) return NONE;
    const show = typeof body?.show === "object" && body.show !== null ? body.show as Record<string, unknown> : undefined;
    if (show === undefined || typeof show.text !== "string") throw new Error("the Team record did not answer");
    return { show: { text: show.text, ...(Array.isArray(show.blocks) ? { blocks: show.blocks as Array<Record<string, unknown>> } : {}) } };
  };
}

// ---- the interactivity side: the Add button

/** What the handler needs of a block action (the interactivity handler's own type is assignable to this). */
interface PressedAction {
  actionId: string; value: string; userId: string; userTeamId: string; workspaceTeamId: string; triggerId: string; actionTs?: string; messageTs: string; responseUrl: string;
  thread: { teamId: string; channelId: string };
  stateValues?: Record<string, unknown>;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? value as Record<string, unknown> : {});
/** The chosen option of a select in the message's state, or undefined when nothing was chosen. */
const chosen = (state: Record<string, unknown> | undefined, block: string, action: string): string | undefined => {
  const value = record(record(record(state)[block])[action]).selected_option;
  const picked = record(value).value;
  return typeof picked === "string" && picked !== "" ? picked : undefined;
};

/**
 * The press is acknowledged at once and the work is handed to an asynchronous invoke of the same Lambda (the pattern the Quick or Full choice and the ChatGPT form use), because the work (the prompt, the person's rights, two Slack
 * reads, the save) can outlast Slack's 3 seconds. The answer then goes through Slack's `response_url` (good for 30 minutes). Nothing about the person is in the hand-off but ids Slack's signed request carried.
 */
export interface HandedOffLearnPress { source: "agentx.slack-interactivity"; action: "team-record-slack-add-press"; press: SlackAddPressInput; responseUrl: string }

export function isHandedOffLearnPress(event: unknown): event is HandedOffLearnPress {
  if (event === null || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  const press = record(value.press);
  // Never an HTTP request (API Gateway's events always carry a requestContext), and only Slack's own response URL.
  return value.source === "agentx.slack-interactivity" && value.action === "team-record-slack-add-press" && value.requestContext === undefined
    && typeof value.responseUrl === "string" && value.responseUrl.startsWith("https://hooks.slack.com/") && value.responseUrl.length <= 2_000
    && isTeamRecordSlackAddEvent({ source: SOURCE, action: ACTION, step: "press", ...press });
}

export interface LearnPressDependencies {
  invokeBroker(event: Record<string, unknown>): Promise<BrokerReply>;
  respondEphemeral(responseUrl: string, text: string): Promise<void>;
  respondReplace(responseUrl: string, message: { text: string; blocks: Array<Record<string, unknown>> }): Promise<void>;
}

/** Runs a handed-off press: asks the broker, then says the answer privately through the response URL (a final answer replaces the prompt, so its button goes away). Never throws. */
export async function runHandedOffLearnPress(deps: LearnPressDependencies, event: HandedOffLearnPress): Promise<"final" | "open" | "failed"> {
  let answer: SlackAddPressAnswer | undefined;
  try {
    const body = parseBody(await deps.invokeBroker({ source: SOURCE, action: ACTION, step: "press", ...event.press }));
    if (body !== undefined && typeof body.text === "string" && typeof body.final === "boolean") answer = { text: body.text, final: body.final };
  } catch { /* answered below */ }
  try {
    if (answer === undefined) { await deps.respondEphemeral(event.responseUrl, SLACK_ADD_WORDS.unavailable); return "failed"; }
    if (answer.final) await deps.respondReplace(event.responseUrl, { text: answer.text, blocks: [{ type: "section", text: { type: "plain_text", text: answer.text } }] });
    else await deps.respondEphemeral(event.responseUrl, answer.text);
    return answer.final ? "final" : "open";
  } catch {
    return "failed";
  }
}

export function learnAddHandler(deps: {
  /** Hands the press to an asynchronous invoke of this Lambda. Throws when it was not handed over. */
  handOff(event: HandedOffLearnPress): Promise<void>;
  respondEphemeral(responseUrl: string, text: string): Promise<void>;
}): { matches(actionId: string): boolean; handle(action: PressedAction): Promise<void> } {
  return {
    matches: (actionId) => actionId === LEARN_ADD_ACTION,
    async handle(action) {
      // The press must come through this workspace, from one of its own members (a Slack Connect member of another organisation is not).
      if (action.userTeamId !== action.thread.teamId || (action.workspaceTeamId !== "" && action.workspaceTeamId !== action.thread.teamId)) {
        await deps.respondEphemeral(action.responseUrl, SLACK_ADD_WORDS.otherWorkspace);
        return;
      }
      const project = chosen(action.stateValues, LEARN_PROJECT_BLOCK, LEARN_PROJECT_ACTION);
      const retention = chosen(action.stateValues, LEARN_RETENTION_BLOCK, LEARN_RETENTION_ACTION);
      const interactionId = action.triggerId !== "" ? action.triggerId : (action.actionTs ?? action.messageTs);
      try {
        await deps.handOff({
          source: "agentx.slack-interactivity", action: "team-record-slack-add-press", responseUrl: action.responseUrl,
          press: { teamId: action.thread.teamId, userId: action.userId, channelId: action.thread.channelId, token: action.value, ...(project === undefined ? {} : { project }), ...(retention === undefined ? {} : { retention }), interactionId },
        });
      } catch {
        await deps.respondEphemeral(action.responseUrl, SLACK_ADD_WORDS.unavailable);
      }
    },
  };
}
