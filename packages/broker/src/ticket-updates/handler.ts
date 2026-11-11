// Slice 5 "Outside tools" (owner decision 6): the milestone handler that writes back to the ticket that started a task. It is told the task's milestones (`rovara-code/milestones.ts`) and acts
// on five: `started`, `plan_ready`, `pr_ready` (the pull request opened), `merged` and `closed`. Write-back uses the company's tokens, so every rule fails closed:
//   - ONLY the ticket that started the task: a `tracker_item` binding of the task's session that intake itself recorded as started for THIS task (the intake item names the session or the
//     task). A ticket someone linked by hand, or any other place, is never written to;
//   - only fixed words, the task's title (made inert and cut), the status it moved to, and the link to `/app/sessions/<id>`. No plan, code, comment or summary ever leaves;
//   - a task only its owner can see is never written to a PUBLIC tracker (a GitHub issue whose repository is not private), whatever the project's settings (an owner rule); on Jira its comment
//     is internal (never shown to a service-desk customer). Linear and Jira are otherwise the company's own workspaces;
//   - rate limited: at most `TICKET_UPDATES_PER_HOUR` writes per company and tracker an hour, and at most `TICKET_UPDATES_PER_TASK` per task. Over a limit the update is skipped (logged), never queued;
//   - each update is claimed once (a conditional write in the task's partition) before it is sent, so two deliveries send it once; a fault that may pass gives the claim back and throws, so the
//     delivery tries again (bounded by the milestone's attempts). A missing scope is noted for the company's settings page and the update is skipped: it never fails the task.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, INDEX_EXPIRY_ATTRIBUTE, TICKET_MOMENT_WORDS, intakeItemIdOf, ticketUpdateCallsKey, type CodeMilestone, type CodeMilestoneKind, type OrgId, type TicketTracker, type TicketUpdateMoment } from "@rovara-code/contracts";
import { readIntakeItem } from "../intake/store.js";
import { resolveTaskVisibility } from "../lessons/task-visibility.js";
import { sessionBindingsOf } from "../rovara-code/session-bindings.js";
import type { CodeMilestoneHandler } from "../rovara-code/milestones.js";
import { noteWriteAccessMissing, noteWriteAccessOk, readTicketUpdates } from "./settings.js";
import type { TicketRef, TicketTrackerPort } from "./trackers.js";

export const TICKET_UPDATES_PER_HOUR = 120;
export const TICKET_UPDATES_PER_TASK = 12;
const CLAIM_LEASE_MS = 60_000;
const KEPT_SECONDS = 400 * 86_400;
const TITLE_MAX = 120;

const MOMENT_OF: Partial<Record<CodeMilestoneKind, TicketUpdateMoment>> = { started: "started", plan_ready: "plan_ready", pr_ready: "pr_opened", merged: "merged", closed: "closed" };
const TRACKER_OF: Readonly<Record<string, TicketTracker>> = { linear: "linear", jira: "jira", github: "github" };

export interface TicketUpdatesDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** The web app's origin; the link is `<origin>/app/sessions/<id>`. */
  origin: string;
  trackers: Record<TicketTracker, TicketTrackerPort>;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

type Item = Record<string, unknown>;
const isConditional = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";
const hourOf = (now: number): string => new Date(now).toISOString().slice(0, 13);

/** A title made safe to post: no controls, no mention or markup characters (nobody is pinged, nothing becomes a link), one line, cut. */
export function inertTicketTitle(title: string): string {
  const plain = title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/:\/\//gu, ": ").replace(/[@<>[\]()`*_~#|!]/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...plain].slice(0, TITLE_MAX).join("").trimEnd();
  return cut === "" ? "(no title)" : cut;
}

/** The words of one update: the moment, the title, the status it moved to, the link. Nothing else. */
export function ticketUpdateText(input: { moment: TicketUpdateMoment; title: string; link: string; status?: string | undefined }): string {
  return [`${TICKET_MOMENT_WORDS[input.moment]}: "${inertTicketTitle(input.title)}".`, ...(input.status === undefined ? [] : [`Status: ${inertTicketTitle(input.status)}.`]), `Follow it in Rovara: ${input.link}`].join("\n");
}

/** The ticket intake started this task from, verified against the intake item; undefined when the task did not start from a ticket Rovara writes to. */
export async function originTicketOf(deps: Pick<TicketUpdatesDependencies, "documentClient" | "tableName" | "now">, input: { orgId: OrgId; project: string; taskId: string; sessionId: string }): Promise<TicketRef | undefined> {
  const bindings = await sessionBindingsOf(deps, input.orgId, input.sessionId);
  for (const binding of bindings) {
    if (binding.kind !== "tracker_item") continue;
    const ticket = binding;
    const tracker = Object.hasOwn(TRACKER_OF, ticket.system) ? TRACKER_OF[ticket.system]! : undefined;
    if (tracker === undefined) continue;
    const item = await readIntakeItem(deps, input.orgId, input.project, intakeItemIdOf(ticket.system, ticket.id));
    // Intake itself must have started THIS task from this ticket; a ticket bound any other way is not written to.
    if (item === undefined || item.state !== "started" || item.system !== ticket.system || item.id !== ticket.id) continue;
    if (item.sessionId !== input.sessionId && item.taskId !== input.taskId) continue;
    return { tracker, id: ticket.id, url: item.url };
  }
  return undefined;
}

/** The claim's key: one per moment, per pull request for `pr_opened` and per plan for `plan_ready`. */
function claimKeyOf(milestone: CodeMilestone, moment: TicketUpdateMoment): string {
  if (moment === "pr_opened") return `pr_opened#${createHash("sha256").update((milestone.pullRequests ?? []).map((pr) => `${pr.repository}#${String(pr.number)}`).join(",")).digest("hex").slice(0, 24)}`;
  if (moment === "plan_ready") return `plan_ready#${createHash("sha256").update(milestone.at).digest("hex").slice(0, 24)}`;
  return moment;
}

async function claim(deps: TicketUpdatesDependencies, taskId: string, key: string): Promise<"claimed" | "done" | "busy"> {
  const now = deps.now();
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { pk: `DEVTASK#${taskId}`, sk: `TICKET_UPDATE#${key}`, entityType: "TICKET_UPDATE", state: "sending", leaseUntil: now + CLAIM_LEASE_MS, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + KEPT_SECONDS },
      ConditionExpression: "attribute_not_exists(pk) OR (#state = :sending AND #lease < :now)",
      ExpressionAttributeNames: { "#state": "state", "#lease": "leaseUntil" }, ExpressionAttributeValues: { ":sending": "sending", ":now": now },
    }));
    return "claimed";
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  const seen = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: `TICKET_UPDATE#${key}` }, ConsistentRead: true }))) as { Item?: Item }).Item;
  return seen?.["state"] === "sending" ? "busy" : "done";
}

async function settle(deps: TicketUpdatesDependencies, taskId: string, key: string, outcome: string): Promise<void> {
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: `TICKET_UPDATE#${key}` },
    UpdateExpression: "SET #state = :done, outcome = :outcome REMOVE #lease", ExpressionAttributeNames: { "#state": "state", "#lease": "leaseUntil" },
    ExpressionAttributeValues: { ":done": "done", ":outcome": outcome },
  }));
}

async function release(deps: TicketUpdatesDependencies, taskId: string, key: string): Promise<void> {
  await deps.documentClient.send(new DeleteCommand({
    TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: `TICKET_UPDATE#${key}` }, ConditionExpression: "#state = :sending",
    ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":sending": "sending" },
  })).catch(() => undefined);
}

/** Counts one write against a limit in one conditional update; false when the limit is used up. */
async function countWithin(deps: TicketUpdatesDependencies, key: { pk: string; sk: string }, max: number, expiresSeconds: number): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "ADD #count :one SET #expires = :expires", ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
      ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":one": 1, ":max": max, ":expires": expiresSeconds },
    }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** Gives one count back (a write that did not happen). Never below zero. */
async function giveBack(deps: TicketUpdatesDependencies, key: { pk: string; sk: string }): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "ADD #count :minus", ConditionExpression: "#count > :zero",
      ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":minus": -1, ":zero": 0 },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

/** A refusal that will not pass by itself (the tracker's own "no"): the update is skipped, not tried again. A rate limit or a fault may pass and is thrown. */
const isFinal = (error: unknown): boolean => error instanceof AgentXError && error.statusCode < 500 && error.code !== "TOO_MANY_REQUESTS";

/** One milestone: the update it calls for, sent once to the ticket the task started from. Never throws for a ticket that cannot be written; throws a fault that may pass. */
export async function sendTicketUpdate(deps: TicketUpdatesDependencies, milestone: CodeMilestone): Promise<string> {
  const moment = MOMENT_OF[milestone.kind];
  if (moment === undefined) return "not_a_moment";
  const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${milestone.taskId}`, sk: "META" }, ConsistentRead: true }))) as { Item?: Item }).Item;
  if (task === undefined || task["orgId"] !== milestone.orgId || typeof task["project"] !== "string") return "no_task";
  const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : milestone.sessionId;
  if (sessionId === undefined) return "no_session";
  const orgId = milestone.orgId;
  const project = task["project"];
  const ticket = await originTicketOf(deps, { orgId, project, taskId: milestone.taskId, sessionId });
  if (ticket === undefined) return "no_ticket";
  const { settings } = await readTicketUpdates(deps, orgId, project);
  const status = settings.changeStatus ? settings.statuses[moment] : undefined;
  if (!settings.comments && status === undefined) return "off";
  // A task only its owner (or a named few) can see never writes to a public tracker: an owner rule with no project switch (review I3). Unknown visibility is private.
  const visibility = await resolveTaskVisibility(deps, orgId, milestone.taskId).catch(() => undefined);
  const requirePrivate = visibility?.kind !== "shared";
  const key = claimKeyOf(milestone, moment);
  const claimed = await claim(deps, milestone.taskId, key);
  if (claimed === "done") return "already_sent";
  if (claimed === "busy") throw new Error("ticket update in flight");
  // Review M3: the two counters are spent only by a write that reached the tracker. Each is taken in one conditional update (so two deliveries cannot both use the last one), and given back
  // when the other limit says no, when nothing was written, or when the send fails and will be tried again.
  const now = deps.now();
  const perTask = { pk: `DEVTASK#${milestone.taskId}`, sk: "TICKET_UPDATE_COUNT" };
  const perHour = ticketUpdateCallsKey(orgId, ticket.tracker, hourOf(now));
  const spent: Array<{ pk: string; sk: string }> = [];
  const refund = async () => { for (const counter of spent.splice(0)) await giveBack(deps, counter).catch(() => undefined); };
  try {
    if (await countWithin(deps, perTask, TICKET_UPDATES_PER_TASK, Math.floor(now / 1000) + KEPT_SECONDS)) spent.push(perTask);
    if (spent.length === 1 && await countWithin(deps, perHour, TICKET_UPDATES_PER_HOUR, Math.floor(now / 1000) + 2 * 3600)) spent.push(perHour);
    if (spent.length < 2) {
      await refund();
      deps.log?.("ticket_update.rate_limited", { orgId, taskId: milestone.taskId, tracker: ticket.tracker, moment });
      await settle(deps, milestone.taskId, key, "rate_limited");
      return "rate_limited";
    }
    const port = deps.trackers[ticket.tracker];
    let moved: string | undefined;
    let missing = false;
    if (status !== undefined) {
      const answer = await port.setStatus({ orgId, ticket, status }).catch((error: unknown) => { if (isFinal(error)) return "refused" as const; throw error; });
      if (answer === "moved") moved = status;
      if (answer === "needs_write_access") missing = true;
    }
    let posted = "comments_off";
    if (settings.comments) {
      const link = `${deps.origin.replace(/\/+$/u, "")}/app/sessions/${encodeURIComponent(sessionId)}`;
      const text = ticketUpdateText({ moment, title: typeof task["title"] === "string" ? task["title"] : "", link, status: moved });
      posted = await port.comment({ orgId, ticket, text, key: `ticket_update:${milestone.taskId}:${key}`, requirePrivate }).catch((error: unknown) => { if (isFinal(error)) return "refused"; throw error; });
      if (posted === "needs_write_access") missing = true;
    }
    if (missing) await noteWriteAccessMissing(deps, orgId, ticket.tracker).catch(() => undefined);
    else if (posted === "posted" || moved !== undefined) await noteWriteAccessOk(deps, orgId, ticket.tracker).catch(() => undefined);
    if (posted !== "posted" && moved === undefined) await refund();
    const outcome = missing ? "needs_write_access" : posted;
    deps.log?.("ticket_update.sent", { orgId, taskId: milestone.taskId, tracker: ticket.tracker, moment, outcome, ...(moved === undefined ? {} : { statusMoved: true }) });
    await settle(deps, milestone.taskId, key, outcome);
    return outcome;
  } catch (error) {
    await refund();
    await release(deps, milestone.taskId, key);
    throw error;
  }
}

/** The handler the broker registers once at start (`registerCodeMilestoneHandler`). It reads the latest broker's dependencies; with none it does nothing. */
export function ticketUpdatesHandler(current: () => TicketUpdatesDependencies | undefined): CodeMilestoneHandler {
  return {
    name: "ticket_updates",
    async on(_deps, milestone) {
      const deps = current();
      if (deps === undefined || MOMENT_OF[milestone.kind] === undefined) return;
      await sendTicketUpdate(deps, milestone);
    },
  };
}
