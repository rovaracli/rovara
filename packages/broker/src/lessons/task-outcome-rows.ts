// Learning v2 wiring (WA-2, WA-3): what the reflector needs about a finished task that lives in the Team record's own rows. Read by the rows' deterministic source ids (the
// record core's source index), never by a scan:
//   - a human send-back: the `rovara.send_back` row `task:<task>:sendback:<request id>` (who, their standing, their words, whether it was automatic);
//   - the revert's person: the `rovara.reverted_by` link row `task:<task>:reverted_by`, whose actor is the member who reverted. The revert's OUTCOME rows carry no person.
// A row that is missing, belongs to another workspace, project or task, is hidden (erased, deleted at its source), or names someone who is not a member gives no person, and a
// send-back without a person is not a measured outcome. Internal reads: the audience of the lesson is the subject's, set by the caller, not by this read.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { RECORD_EVENT_SK_PREFIX, teamRecordPk, type OrgId, type RecordEvent } from "@agentx/contracts";
import { bySource } from "../team-record/store.js";
import { eventFromItem } from "../team-record/store.js";
import type { TeamRecordTable } from "../team-record/types.js";
import type { SendBackFact } from "./task-subject.js";

export interface OutcomeRowReader {
  sendBack(input: { workspaceId: string; project: string; taskId: string; requestId: string }): Promise<SendBackFact | undefined>;
  /** The `rovara.reverted_by` row's person. `{}` when the row exists but names no member; undefined when there is no such row. */
  revertedBy(input: { workspaceId: string; project: string; taskId: string }): Promise<{ actorDeveloperId?: string } | undefined>;
}

const MAX_ROWS = 5;

export function tableOutcomeRows(table: TeamRecordTable, nowSeconds?: () => number): OutcomeRowReader {
  async function rowOf(input: { workspaceId: string; project: string; taskId: string }, sourceId: string, kind: RecordEvent["kind"]): Promise<RecordEvent | undefined> {
    const found = await bySource(table, input.workspaceId, "rovara", sourceId, MAX_ROWS);
    for (const item of found.items) {
      const event = eventFromItem(item, nowSeconds?.());
      if (event === undefined || event.tombstone !== undefined || event.kind !== kind) continue;
      if (event.workspaceId !== input.workspaceId || event.project !== input.project || event.structured?.taskId !== input.taskId) continue;
      return event;
    }
    return undefined;
  }
  /** The row's actor as a member's canonical developer id, or undefined for anyone else. */
  const memberOf = (event: RecordEvent): string | undefined => (event.actor?.trust === "member" && event.trust === "member" ? event.actor.developerId : undefined);

  return {
    async sendBack(input) {
      const event = await rowOf(input, `task:${input.taskId}:sendback:${input.requestId}`, "rovara.send_back");
      if (event === undefined) return undefined;
      const human = event.structured?.origin === "human";
      const actor = human ? memberOf(event) : undefined;
      return {
        id: event.sourceRef.id, origin: human ? "human" : "automatic",
        ...(actor === undefined ? {} : { actorDeveloperId: actor }),
        ...(human && event.actor !== undefined ? { actorTrust: event.actor.trust } : {}),
        ...(human && event.text !== undefined ? { reasonText: event.text } : {}),
      };
    },
    async revertedBy(input) {
      const event = await rowOf(input, `task:${input.taskId}:reverted_by`, "rovara.reverted_by");
      if (event === undefined) return undefined;
      const actor = memberOf(event);
      return actor === undefined ? {} : { actorDeveloperId: actor };
    },
  };
}

/** The most pages one project's look at the last 26 h reads (500 rows each); a busier project is cut off and says so. */
export const MAX_REVERT_PAGES = 20;

/**
 * Lessons in production, lane 2 (nightly re-reflection): the tasks of one project whose change was reverted since `sinceMs`, from the `rovara.reverted_by` link rows (a record query over the project's rows
 * by time, never a scan of the table). Erasure-respecting by what the record already does: a row of an erased person is deleted, a tombstoned or hidden row is skipped here, and text past its expiry is dropped
 * by `eventFromItem`. A row that names another workspace, project or no task is ignored. Ids only; nothing a person wrote is read out. `truncated` says the project had more rows than the pages allow.
 */
export async function revertedTasksSince(table: TeamRecordTable, workspaceId: OrgId, project: string, sinceMs: number, options: { nowSeconds?: number; maxPages?: number } = {}): Promise<{ taskIds: string[]; truncated: boolean }> {
  const seen = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  const maxPages = options.maxPages ?? MAX_REVERT_PAGES;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
      ExpressionAttributeValues: { ":pk": teamRecordPk(workspaceId, project), ":low": `${RECORD_EVENT_SK_PREFIX}${new Date(sinceMs).toISOString()}`, ":high": `${RECORD_EVENT_SK_PREFIX}￿`, ":kind": "rovara.reverted_by" },
      // L3 (lane 2 review): only the revert link rows come back, and the read is eventually consistent (half the cost): the window is a day wide and a row a moment too new is found by the next night.
      FilterExpression: "#kind = :kind", ExpressionAttributeNames: { "#kind": "kind" },
      ScanIndexForward: false, Limit: 500, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }), ConsistentRead: false,
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      if (item["kind"] !== "rovara.reverted_by") continue;
      const event = eventFromItem(item, options.nowSeconds);
      if (event === undefined || event.tombstone !== undefined || event.kind !== "rovara.reverted_by") continue;
      const taskId = event.structured?.taskId;
      if (event.workspaceId !== workspaceId || event.project !== project || typeof taskId !== "string" || taskId === "") continue;
      seen.add(taskId);
    }
    startKey = response.LastEvaluatedKey;
    if (startKey === undefined) return { taskIds: [...seen], truncated: false };
  }
  return { taskIds: [...seen], truncated: true };
}
