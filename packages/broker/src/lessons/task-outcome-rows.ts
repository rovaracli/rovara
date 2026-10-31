// Learning v2 wiring (WA-2, WA-3): what the reflector needs about a finished task that lives in the Team record's own rows. Read by the rows' deterministic source ids (the
// record core's source index), never by a scan:
//   - a human send-back: the `rovara.send_back` row `task:<task>:sendback:<request id>` (who, their standing, their words, whether it was automatic);
//   - the revert's person: the `rovara.reverted_by` link row `task:<task>:reverted_by`, whose actor is the member who reverted. The revert's OUTCOME rows carry no person.
// A row that is missing, belongs to another workspace, project or task, is hidden (erased, deleted at its source), or names someone who is not a member gives no person, and a
// send-back without a person is not a measured outcome. Internal reads: the audience of the lesson is the subject's, set by the caller, not by this read.
import type { RecordEvent } from "@agentx/contracts";
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
