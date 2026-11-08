// Lessons sweep (lane D): who wrote each saved note of a task (`NOTE#` rows), for the lessons' subject source (`threadNotes`). It reads AUTHOR FIELDS ONLY: the query projects the note's key, entity type, Slack workspace and user,
// sender and source, so a note's text never reaches the worker's memory. A row that is not a well-formed note, or whose author fields are not as expected, is `other` (unnamed), never dropped, so the source's
// count check still sees it. Bounded: at most `limit + 1` rows are read (one more than the source accepts, so a task with too many notes is seen as too many).
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ThreadNoteAuthor } from "./lesson-subject-source.js";

const SLACK_USER = /^[UW][A-Z0-9]{2,31}$/u;
const SLACK_TEAM = /^[TE][A-Z0-9]{2,31}$/u;

export async function threadNoteAuthors(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, taskId: string, limit: number): Promise<ThreadNoteAuthor[]> {
  const authors: ThreadNoteAuthor[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :note)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":note": "NOTE#" }, ConsistentRead: true,
      // Author fields only. `source` is a reserved word.
      ProjectionExpression: "sk, entityType, slackUserId, teamId, developerId, #source", ExpressionAttributeNames: { "#source": "source" },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const { entityType, slackUserId, teamId, developerId, source } = item;
      if (entityType !== "WORKFLOW_THREAD_NOTE") authors.push({ kind: "other" });
      else if ((source === undefined || source === "slack") && typeof slackUserId === "string" && SLACK_USER.test(slackUserId) && typeof teamId === "string" && SLACK_TEAM.test(teamId)) authors.push({ kind: "slack", teamId, slackUserId });
      else if ((source === "app" || source === "linear") && typeof developerId === "string" && developerId.trim() !== "") authors.push({ kind: "person", developerId });
      else authors.push({ kind: "other" });
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && authors.length <= limit);
  return authors;
}
