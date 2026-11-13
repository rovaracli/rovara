// Live interaction A3: the readers an Ask's context is built from (the data the audience tiers of `ask-context.ts` then filter again). Each one reads only what the task's own partitions hold, hands
// over plain data, and fails to nothing: a reader that throws gives its section nothing and the Ask is answered without it.
//
//   timeline  the session's events: Rovara's own sentences, and (the `events` tier only, LA-3) the agent's last tool events from its newest run: names and whether each failed, never arguments or output. The `milestones` tier (Slack) takes only events no member is named in; the `events` tier (the task page) takes all but comments.
//   notes     the messages people sent to the agent, with the sender's fixed label and authority. A Slack reply by someone who is not the task's owner is OUTSIDER text, not a note.
//   outsider  Slack thread replies by people who are not the task's owner, as untrusted data. (Team record rows and pull request comments are not wired yet: see the lane report.)
//   diff      a peek of the working tree, else the pull request's diff (`ask-diff.ts`).
import { coreOperationEvents } from "../cloud/rows/core-rows.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { LatestChecksSchema, SessionEventSchema, agentSessionKey, checkOutputTail, redactText, workflowSelectedChecks, type OrgId } from "@rovara-code/contracts";
import { effectiveTaskOwner, taskEvent, type DeveloperTaskRecord } from "../developer/task-records.js";
import { personLabel, readWorkflowThreadNotes } from "../aws/developer-tasks/thread-notes.js";
import type { AskContextReaders } from "./ask-context.js";
import { createAskDiffReader, type AskPullRequestDiffPort } from "./ask-diff.js";
import type { PeekClient } from "./peek-client.js";
import { loadTaskPeople } from "../developer/task-people.js";

export interface AskReaderDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  peek?: PeekClient | undefined;
  pullRequests?: AskPullRequestDiffPort | undefined;
}

const EVENTS_READ_MAX = 100;
/** Events that carry what a person said: never part of the timeline (their words come through `notes`, with an author and an authority). */
const PERSON_TEXT_EVENT_TYPES = new Set(["comment", "steer"]);

async function sessionEvents(deps: AskReaderDependencies, orgId: OrgId, sessionId: string): Promise<Array<{ at: string; type: string; text: string; member: boolean }>> {
  const key = agentSessionKey(orgId, sessionId, "EVENT#");
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": key.pk, ":prefix": "EVENT#" },
    ScanIndexForward: false, Limit: EVENTS_READ_MAX, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> };
  const out: Array<{ at: string; type: string; text: string; member: boolean }> = [];
  for (const item of (response.Items ?? []).reverse()) {
    const { pk: _pk, sk: _sk, entityType: _entityType, ...fields } = item;
    void _pk; void _sk; void _entityType;
    const parsed = SessionEventSchema.safeParse(fields);
    if (parsed.success) out.push({ at: parsed.data.at, type: parsed.data.type, text: parsed.data.text, member: parsed.data.actor?.kind === "member" });
  }
  return out;
}

/** The workspace's operations one read looks at, and the newest events of the run it reads. */
const OPERATIONS_READ_MAX = 200;
const TOOL_EVENTS_READ_MAX = 200;
const TOOL_LINES_MAX = 40;
/** The check failures one read hands over (the builder cuts each tail again, and the whole context to its size). */
const FAILING_CHECKS_MAX = 50;

/**
 * The agent's last tool events of the task's newest run, oldest first, as `<time> Started|Finished|Failed <tool name>` (the same lines the task page shows). Only the tool's name and whether it failed:
 * a tool's arguments and output are never read (a payload is not looked into past its name), the lines are made safe again by the builder, and the count is bounded. A read that fails gives nothing.
 */
async function recentToolEvents(deps: AskReaderDependencies, task: DeveloperTaskRecord): Promise<string[]> {
  const operations = (await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `WORKSPACE#${task.workspaceId}`, ":prefix": "OPERATION#" },
    Limit: OPERATIONS_READ_MAX, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> }).Items ?? [];
  const newest = operations
    .filter((item) => item["kind"] === "task" && typeof item["id"] === "string" && typeof item["createdAt"] === "string")
    .sort((left, right) => String(right["createdAt"]).localeCompare(String(left["createdAt"])))[0];
  if (newest === undefined) return [];
  const cloudEvents = (await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `OPERATION#${String(newest["id"])}`, ":prefix": "EVENT#" },
    ScanIndexForward: false, Limit: TOOL_EVENTS_READ_MAX, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> }).Items ?? [];
  // An operation of a core task keeps its events under its workspace (D18): looked for only where Cloud's own partition has none.
  const events = cloudEvents.length > 0 ? cloudEvents : await coreOperationEvents(deps, task.workspaceId, String(newest["id"]), { limit: TOOL_EVENTS_READ_MAX, newestFirst: true });
  const lines: string[] = [];
  for (const item of events) {
    if (item["entityType"] !== "EVENT" || typeof item["sequence"] !== "number" || typeof item["type"] !== "string" || typeof item["timestamp"] !== "string") continue;
    const readable = taskEvent({ sequence: item["sequence"], type: item["type"], timestamp: item["timestamp"], payload: item["payload"] });
    if (readable?.kind === "tool") lines.push(`${readable.at} ${readable.text}`);
    if (lines.length >= TOOL_LINES_MAX) break;
  }
  return lines.reverse();
}

/**
 * The tails of the failing checks of the workspace's latest report, by the workflow's check id (the report's `readiness:<index>` is the index among the selected checks; else the label; else the report's own id). Each is the last lines
 * of that check's output, redacted, within the section's tail size; the builder cuts it again to its own size and makes it inert. Nothing for a report that is not readable or says why it has none.
 */
async function failingCheckTails(deps: AskReaderDependencies, task: DeveloperTaskRecord): Promise<Record<string, string>> {
  const workspace = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" }, ConsistentRead: true }))) as { Item?: { latestChecks?: { report?: unknown } } };
  const parsed = LatestChecksSchema.safeParse(workspace.Item?.latestChecks?.report);
  if (!parsed.success || "reason" in parsed.data) return {};
  const selected = workflowSelectedChecks(task.workflow?.checkPolicy);
  const tails: Record<string, string> = {};
  for (const check of parsed.data.checks) {
    if (check.after !== "failed" && check.after !== "timed_out") continue;
    if (Object.keys(tails).length >= FAILING_CHECKS_MAX) break;
    // The report numbers the project's checks in the order the workflow selected them (`readiness:<index>`); a check by another id is found by its label.
    const index = /^readiness:(\d{1,3})$/u.exec(check.id)?.[1];
    const id = (index === undefined ? undefined : selected[Number(index)]?.id) ?? selected.find((candidate) => candidate.label === check.label)?.id ?? check.id;
    const tail = checkOutputTail(redactText(check.output));
    if (tail !== "") tails[id] = tail;
  }
  return tails;
}

/**
 * The members who may speak in the task's thread without being its owner (the task's co-owners and the others on its People list, not those it denies), by their Slack user id. A Slack reply by one of them
 * is a teammate's information note, not outsider text (LA-5, M7). A list that cannot be read names no one: everyone but the owner stays outsider text, as before.
 */
async function listedMembersBySlackId(deps: AskReaderDependencies, task: DeveloperTaskRecord): Promise<Map<string, string>> {
  try {
    const people = await loadTaskPeople(deps, task.taskId);
    // A person with no Slack account has no Slack reply to speak for, so they are not in a map keyed by Slack user id.
    return new Map((people?.people ?? []).flatMap((person): Array<[string, string]> => person.role !== "denied" && person.slackUserId !== undefined ? [[person.slackUserId, person.developerId]] : []));
  } catch {
    return new Map();
  }
}

export function createAskReaders(deps: AskReaderDependencies): AskContextReaders {
  return {
    async timeline(task, tier) {
      if (tier === "posted" || task.orgId === undefined || task.sessionId === undefined) return undefined;
      const events = (await sessionEvents(deps, task.orgId, task.sessionId)).filter((event) => !PERSON_TEXT_EVENT_TYPES.has(event.type));
      // The milestones tier is for a place that may hold people who are not members: no event that names a member is given to it.
      const shown = tier === "milestones" ? events.filter((event) => !event.member) : events;
      const lines = shown.map((event) => `${event.at} ${event.text}`);
      if (tier === "milestones") return { statusLines: lines, milestones: lines.filter((_, index) => shown[index]!.type !== "status") };
      // The agent's tool events are the `events` tier's (the web asker's) alone; a run whose events cannot be read leaves them out, not the timeline.
      const agentEvents = await recentToolEvents(deps, task).catch(() => []);
      return { statusLines: lines.slice(-20), ...(agentEvents.length === 0 ? {} : { agentEvents }) };
    },
    checkTails: (task) => failingCheckTails(deps, task),
    diff: createAskDiffReader({ peek: deps.peek, pullRequests: deps.pullRequests }),
    async notes(task) {
      const owner = effectiveTaskOwner(task).developerId;
      const notes = await readWorkflowThreadNotes(deps, task.taskId, undefined, { includeAnswered: true });
      const members = await listedMembersBySlackId(deps, task);
      return notes.flatMap((note) => {
        if (note.source === "app" || note.source === "linear") return [{ authorLabel: personLabel(note.developerId), authority: note.isOwner ? "owner_instruction" as const : "information" as const, text: note.text }];
        // A Slack reply by the task's owner is the owner's; one by another member on its People list is a teammate's information (M7); anyone else's is outsider text (see `outsider`).
        if (note.isOwner) return [{ authorLabel: personLabel(owner), authority: "owner_instruction" as const, text: note.text }];
        const member = "slackUserId" in note ? members.get(note.slackUserId) : undefined;
        return member === undefined ? [] : [{ authorLabel: personLabel(member), authority: "information" as const, text: note.text }];
      });
    },
    async outsider(task: DeveloperTaskRecord, sources) {
      if (!sources.includes("slack_thread")) return [];
      const notes = await readWorkflowThreadNotes(deps, task.taskId, undefined, { includeAnswered: true });
      const members = await listedMembersBySlackId(deps, task);
      return notes.flatMap((note) => (note.source === "app" || note.source === "linear" || note.isOwner || ("slackUserId" in note && members.has(note.slackUserId)) ? [] : [{ source: "slack_thread" as const, text: note.text }]));
    },
  };
}
