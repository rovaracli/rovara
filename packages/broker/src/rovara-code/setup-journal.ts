// Setup run journal, broker side (design setup-test-health 3.2, task SH13): the commands a setup run ran, kept so people can watch the run live and read it afterwards, and as the evidence on the confirm card.
// The setup journal does not fit one DynamoDB item (up to 400 entries of up to 4 KiB of output), so each entry is one item. The worker sends entries (the setup callback, SH14); this module is
// the broker's side of that:
//   - an entry is READ AGAIN by the contract (`SetupJournalEntrySchema`), its command and output redacted once more and cut, and stored once: the first entry for a position stands, a repeat changes nothing;
//   - nothing the worker sends can name another run: the org, project and task come from the authenticated operation, never from the body;
//   - a run holds at most `SETUP_JOURNAL_MAX_ENTRIES` entries; entries are kept 31 days like the other setup items;
//   - the entry's `blockedHosts` are shown to people and never act: a name only becomes a host ask through `requestHostAsk`, and an ask grants nothing until a person approves it.
// The task carries only a count (`setupAgentProgress`) for the Live wall tile.
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, SETUP_JOURNAL_MAX_ENTRIES, SETUP_JOURNAL_TAIL_BYTES, SetupJournalEntrySchema, redactText, setupDraftKey, type OrgId, type SetupJournalEntry,
} from "@agentx/contracts";
import { taskKey } from "../developer/task-records.js";

type Client = { send(command: unknown): Promise<unknown> };
export interface JournalTable { documentClient: Client; tableName: string; now: () => number }
export interface JournalScope { orgId: OrgId; project: string; taskId: string }

/** The most entries one callback may carry. */
export const SETUP_JOURNAL_BATCH_MAX = 20;
const KEEP_SECONDS = 31 * 86_400;

const journalKey = (scope: JournalScope, n: number) => ({ pk: setupDraftKey(scope.orgId, scope.project).pk, sk: `JOURNAL#${scope.taskId}#${String(n).padStart(4, "0")}` });
const plainOneLine = (text: string, max: number): string => redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);

/** The entry as the broker keeps it: the worker's words, redacted once more, cut, and read by the contract again. Undefined when it does not read. */
export function readJournalEntry(raw: unknown): SetupJournalEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const tail = typeof entry["tail"] === "string" ? redactText(entry["tail"]).replace(/[^\P{Cc}\n\t]/gu, "?") : entry["tail"];
  const parsed = SetupJournalEntrySchema.safeParse({
    ...entry,
    ...(typeof entry["command"] === "string" ? { command: plainOneLine(entry["command"], 2_000) || "(empty command)" } : {}),
    ...(typeof tail === "string" ? { tail: Buffer.byteLength(tail) > SETUP_JOURNAL_TAIL_BYTES ? Buffer.from(tail).subarray(-SETUP_JOURNAL_TAIL_BYTES).toString("utf8").replace(/^�+/u, "") : tail } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Stores the entries of a batch (at most `SETUP_JOURNAL_BATCH_MAX`; the rest are refused). An entry for a position that is stored already is left as it is. Answers how many were stored, repeated and refused.
 * The count on the task moves up to the highest position stored, never down; a failure to move it never fails the append.
 */
export async function appendSetupJournal(table: JournalTable, scope: JournalScope, entries: readonly unknown[]): Promise<{ stored: number; repeated: number; refused: number }> {
  let stored = 0, repeated = 0, refused = 0, highest = 0;
  for (const raw of entries.slice(0, SETUP_JOURNAL_BATCH_MAX)) {
    const entry = readJournalEntry(raw);
    if (entry === undefined || entry.n > SETUP_JOURNAL_MAX_ENTRIES) { refused += 1; continue; }
    try {
      await table.documentClient.send(new PutCommand({
        TableName: table.tableName,
        Item: { ...journalKey(scope, entry.n), entityType: "SETUP_JOURNAL", orgId: scope.orgId, project: scope.project, taskId: scope.taskId, entry, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(table.now() / 1000) + KEEP_SECONDS },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      stored += 1;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") repeated += 1;
      else throw error;
    }
    highest = Math.max(highest, entry.n);
  }
  refused += Math.max(0, entries.length - SETUP_JOURNAL_BATCH_MAX);
  if (highest > 0) {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: taskKey(scope.taskId), UpdateExpression: "SET setupAgentProgress = :progress",
      ConditionExpression: "purpose = :purpose AND (attribute_not_exists(setupAgentProgress) OR setupAgentProgress.commands < :commands)",
      ExpressionAttributeValues: { ":progress": { commands: highest, at: new Date(table.now()).toISOString() }, ":purpose": "setup_agent", ":commands": highest },
    })).catch(() => undefined);
  }
  return { stored, repeated, refused };
}

/** The run's entries in order, from position `after` (exclusive; default 0). A row that does not read back is skipped, never guessed at. At most `SETUP_JOURNAL_MAX_ENTRIES`. */
export async function readSetupJournal(table: JournalTable, scope: JournalScope, after = 0): Promise<SetupJournalEntry[]> {
  const out: SetupJournalEntry[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < 20 && out.length < SETUP_JOURNAL_MAX_ENTRIES; page += 1) {
    const result = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": journalKey(scope, 1).pk, ":from": journalKey(scope, Math.max(1, after + 1)).sk, ":to": journalKey(scope, SETUP_JOURNAL_MAX_ENTRIES).sk },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of result.Items ?? []) {
      if (item["taskId"] !== scope.taskId || item["orgId"] !== scope.orgId || item["project"] !== scope.project) continue;
      const entry = readJournalEntry(item["entry"]);
      if (entry !== undefined && entry.n > after) out.push(entry);
    }
    start = result.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return out.slice(0, SETUP_JOURNAL_MAX_ENTRIES);
}
