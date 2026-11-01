// Live interaction A3: the readers an Ask's context is built from (the data the audience tiers of `ask-context.ts` then filter again). Each one reads only what the task's own partitions hold, hands
// over plain data, and fails to nothing: a reader that throws gives its section nothing and the Ask is answered without it.
//
//   timeline  the session's events: Rovara's own sentences (the agent's tool events are not stored per task, so there are no `agentEvents`: see the lane report). The `milestones` tier (Slack) takes only events no member is named in; the `events` tier (the task page) takes all but comments.
//   notes     the messages people sent to the agent, with the sender's fixed label and authority. A Slack reply by someone who is not the task's owner is OUTSIDER text, not a note.
//   outsider  Slack thread replies by people who are not the task's owner, as untrusted data. (Team record rows and pull request comments are not wired yet: see the lane report.)
//   diff      a peek of the working tree, else the pull request's diff (`ask-diff.ts`).
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SessionEventSchema, agentSessionKey, type OrgId } from "@agentx/contracts";
import { effectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { personLabel, readWorkflowThreadNotes } from "../aws/developer-tasks/thread-notes.js";
import type { AskContextReaders } from "./ask-context.js";
import { createAskDiffReader, type AskPullRequestDiffPort } from "./ask-diff.js";
import type { PeekClient } from "./peek-client.js";

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

export function createAskReaders(deps: AskReaderDependencies): AskContextReaders {
  return {
    async timeline(task, tier) {
      if (tier === "posted" || task.orgId === undefined || task.sessionId === undefined) return undefined;
      const events = (await sessionEvents(deps, task.orgId, task.sessionId)).filter((event) => !PERSON_TEXT_EVENT_TYPES.has(event.type));
      // The milestones tier is for a place that may hold people who are not members: no event that names a member is given to it.
      const shown = tier === "milestones" ? events.filter((event) => !event.member) : events;
      const lines = shown.map((event) => `${event.at} ${event.text}`);
      return tier === "milestones" ? { statusLines: lines, milestones: lines.filter((_, index) => shown[index]!.type !== "status") } : { statusLines: lines.slice(-20) };
    },
    diff: createAskDiffReader({ peek: deps.peek, pullRequests: deps.pullRequests }),
    async notes(task) {
      const owner = effectiveTaskOwner(task).developerId;
      const notes = await readWorkflowThreadNotes(deps, task.taskId, undefined, { includeAnswered: true });
      return notes.flatMap((note) => {
        if (note.source === "app" || note.source === "linear") return [{ authorLabel: personLabel(note.developerId), authority: note.isOwner ? "owner_instruction" as const : "information" as const, text: note.text }];
        // A Slack reply by the task's owner is the owner's; anyone else's is outsider text (see `outsider`).
        return note.isOwner ? [{ authorLabel: personLabel(owner), authority: "owner_instruction" as const, text: note.text }] : [];
      });
    },
    async outsider(task: DeveloperTaskRecord, sources) {
      if (!sources.includes("slack_thread")) return [];
      const notes = await readWorkflowThreadNotes(deps, task.taskId, undefined, { includeAnswered: true });
      return notes.flatMap((note) => (note.source === "app" || note.source === "linear" || note.isOwner ? [] : [{ source: "slack_thread" as const, text: note.text }]));
    },
  };
}
