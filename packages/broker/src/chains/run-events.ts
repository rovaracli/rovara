// Plan 4 Task 6: a chain run's event log. Every state change of a run carries its event in its own transaction, together with `eventSeq` and `version` on the
// run's META, so a crash can't lose an event or leave a gap: the numbers run 1, 2, 3 with nothing missing. An event with no state change goes in alone
// (`appendRunEvent`), by the same rule. Event text is shown to people and may come from a task's failure, so it is neutralised before it is written: control,
// invisible and direction characters become `[U+XXXX]` markers, and the text is cut.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, chainRunKey, runEventSk, type ChainRunEventType, type ChainRunId, type OrgId } from "@rovara-code/contracts";
import { Aliases, NOT_EXISTS, failedIndexes, type TransactItem } from "../agents/table-writes.js";

/** The kinds of event a run records (the plan's list for the session view, Task 10). */
export type RunEventType = ChainRunEventType;

export interface RunEventInput { type: RunEventType; stepSeq?: number; text: string }

/** The most an event's text may be, in characters. */
export const RUN_EVENT_TEXT_MAX = 500;

/** Characters a person must not be shown as they are: controls, format characters (direction marks, zero-width), private use, unassigned, surrogates and line separators. */
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/**
 * The text made safe to print: each unsafe character is replaced by its code point as `[U+XXXX]`, then the text is cut to `max` characters (code points),
 * ending in an ellipsis when it was cut.
 */
export function neutralText(text: string, max: number = RUN_EVENT_TEXT_MAX): string {
  const marked = text.replace(UNSAFE, (char) => `[U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`);
  const characters = [...marked];
  return characters.length <= max ? marked : `${characters.slice(0, max - 1).join("")}…`;
}

/** The part of a run an event is numbered from. */
export interface EventRun { orgId: OrgId; runId: ChainRunId; eventSeq: number }

/** The `EVENT#` put for an event, numbered after the run's last one. The transaction that holds it must also move the run's `eventSeq` to its number. */
export function runEventItem(tableName: string, run: EventRun, event: RunEventInput, at: string): TransactItem {
  const seq = run.eventSeq + 1;
  return {
    Put: {
      TableName: tableName,
      Item: {
        ...chainRunKey(run.orgId, run.runId, runEventSk(seq)), entityType: "CHAIN_RUN_EVENT", orgId: run.orgId, runId: run.runId, seq, at, type: event.type,
        ...(event.stepSeq === undefined ? {} : { stepSeq: event.stepSeq }), text: neutralText(event.text),
      },
      ConditionExpression: NOT_EXISTS,
    },
  };
}

/** Several events in a row, numbered from the run's last one: the items, and the number the run's `eventSeq` becomes. */
export function runEventItems(tableName: string, run: EventRun, events: readonly RunEventInput[], at: string): { items: TransactItem[]; eventSeq: number } {
  const items = events.map((event, index) => runEventItem(tableName, { ...run, eventSeq: run.eventSeq + index }, event, at));
  return { items, eventSeq: run.eventSeq + events.length };
}

export interface EventDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

/**
 * Appends one event with no state change: the event, the run's `eventSeq` and its `version` in one transaction, conditional on the version that was read. A run
 * moved by someone else in between is read again, up to three times.
 */
export async function appendRunEvent(deps: EventDependencies, orgId: OrgId, runId: ChainRunId, event: RunEventInput): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const key = chainRunKey(orgId, runId, "META");
    const { Item } = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { orgId?: string; eventSeq: number; version: number } };
    if (Item === undefined || Item.orgId !== orgId) throw agentXError("NOT_FOUND", "no chain run has that ID");
    const at = new Date(deps.now()).toISOString();
    const aliases = new Aliases();
    const move = `SET ${aliases.name("eventSeq")} = ${aliases.value(Item.eventSeq + 1)}, ${aliases.name("version")} = ${aliases.value(Item.version + 1)}, ${aliases.name("updatedAt")} = ${aliases.value(at)}`;
    try {
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: deps.tableName, Key: key, UpdateExpression: move, ConditionExpression: `${aliases.name("version")} = ${aliases.value(Item.version)}`, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values } },
          runEventItem(deps.tableName, { orgId, runId, eventSeq: Item.eventSeq }, event, at),
        ],
      }));
      return;
    } catch (error) {
      if (failedIndexes(error) === undefined || attempt === 2) throw error;
    }
  }
}
