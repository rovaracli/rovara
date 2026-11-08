// Lessons in production, lane 1b: learning is never silent. When it cannot run for a project or its company (no company-billed provider, the monthly learning limit, every model forbidden, the
// cheapest model too dear for the budgets) ONE current reason is recorded, as a fixed code and a time, and the Lessons tab and Home say it in one line. A learning call that succeeds clears it.
//
//   project: pk of the project, sk `LESSONSET#PAUSED`   (why learning cannot run for this project: its providers, models and budgets)
//   company: pk of the workspace, sk `LESSONSET#PAUSED`  (why it cannot run for the company: the monthly learning limit)
//   project: pk of the project, sk `LESSONSET#FAILS`     (how many learning calls in a row failed after the key was made: a count and a time, nothing else)
// A reason that is already in force keeps the time it started; a success clears the reason and the count.
// Every sort key starts with `LESSONSET`, which the project erase and the workspace erase already wipe. The item holds a code from the allow-list, a time and nothing else: no model name, no amount, no
// provider or proxy text, no person (checklist section 3). A store that cannot be reached never blocks learning and never throws into it: the pause is bookkeeping, not a gate.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LESSONS_PAUSE_CODES, teamRecordPk, type LessonsPauseCode } from "@agentx/contracts";
import type { TeamRecordTable } from "../team-record/types.js";
import type { LearningSpend } from "./ports.js";

export type { LessonsPauseCode };

/** A learning call refused BEFORE any key existed or any money was held, with the fixed code that says why. The message is fixed words, never a provider's or the proxy's. */
export class LearningRefusal extends Error {
  constructor(readonly code: LessonsPauseCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LearningRefusal";
  }
}
export const isLearningRefusal = (error: unknown): error is LearningRefusal => error instanceof LearningRefusal;

export interface CurrentPause { code: LessonsPauseCode; at: number; scope: "project" | "company" }
export interface LessonsPauseStore {
  /** Records the one current reason for the code's scope (the monthly limit is the company's; every other reason is the project's). Never throws. */
  record(workspaceId: string, project: string, code: LessonsPauseCode): Promise<void>;
  /** A learning call for the project succeeded: its own reason and the company's are cleared, and the count of failures in a row starts again. Never throws. */
  clear(workspaceId: string, project: string, only?: "project" | "company"): Promise<void>;
  /** A learning call for the project failed after its key was made (the provider, the proxy, an empty answer): counts one more failure in a row and returns the count. Never throws; absent counts nothing. */
  failed?(workspaceId: string, project: string): Promise<number>;
  /** The reason in force for a project: its own, else the company's. Undefined when there is none or it cannot be read. */
  read(workspaceId: string, project: string): Promise<CurrentPause | undefined>;
}

/** Which scope a reason belongs to: the monthly limit is the company's; the rest follow from the project's own providers, models and budgets. */
export const pauseScopeOf = (code: LessonsPauseCode): "project" | "company" => (code === "monthly_limit" ? "company" : "project");

const SK = "LESSONSET#PAUSED";
const FAILS_SK = "LESSONSET#FAILS";
/** This many failed learning calls in a row for a project pause it as `model_failed`. */
export const MODEL_FAILURES_BEFORE_PAUSE = 3;
const isCode = (value: unknown): value is LessonsPauseCode => typeof value === "string" && (LESSONS_PAUSE_CODES as readonly string[]).includes(value);

export function dynamoPauseStore(table: TeamRecordTable, now: () => number, log?: (event: string, fields: Record<string, string | number>) => void): LessonsPauseStore {
  const keyOf = (workspaceId: string, project: string | undefined) => ({ pk: teamRecordPk(workspaceId, project), sk: SK });
  const readOne = async (workspaceId: string, project: string | undefined, scope: CurrentPause["scope"]): Promise<CurrentPause | undefined> => {
    const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: keyOf(workspaceId, project), ConsistentRead: true }))) as { Item?: { code?: unknown; at?: unknown } }).Item;
    return item !== undefined && isCode(item.code) && typeof item.at === "number" && Number.isFinite(item.at) ? { code: item.code, at: item.at, scope } : undefined;
  };
  return {
    async record(workspaceId, project, code) {
      try {
        // A reason already in force keeps the time it started (the condition fails and nothing is written); a different reason replaces it.
        await table.documentClient.send(new PutCommand({
          TableName: table.tableName, Item: { ...keyOf(workspaceId, pauseScopeOf(code) === "company" ? undefined : project), entityType: "LESSON_PAUSE", code, at: now() },
          ConditionExpression: "attribute_not_exists(pk) OR #code <> :code", ExpressionAttributeNames: { "#code": "code" }, ExpressionAttributeValues: { ":code": code },
        }));
      } catch (error) { if ((error as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") log?.("lessons.pause_not_recorded", { code }); }
    },
    async clear(workspaceId, project, only) {
      for (const scoped of only === "project" ? [project] : only === "company" ? [undefined] : [project, undefined]) {
        try { await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: keyOf(workspaceId, scoped) })); } catch { log?.("lessons.pause_not_cleared", { scope: scoped === undefined ? "company" : "project" }); }
      }
      if (only === "company") return;
      try { await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: teamRecordPk(workspaceId, project), sk: FAILS_SK } })); } catch { log?.("lessons.failures_not_cleared", {}); }
    },
    async failed(workspaceId, project) {
      try {
        const out = await table.documentClient.send(new UpdateCommand({
          TableName: table.tableName, Key: { pk: teamRecordPk(workspaceId, project), sk: FAILS_SK }, ReturnValues: "ALL_NEW",
          UpdateExpression: "ADD #count :one SET entityType = :type, #at = :now", ExpressionAttributeNames: { "#count": "count", "#at": "at" }, ExpressionAttributeValues: { ":one": 1, ":type": "LESSON_FAILS", ":now": now() },
        })) as { Attributes?: { count?: unknown } };
        return typeof out.Attributes?.count === "number" ? out.Attributes.count : 0;
      } catch { log?.("lessons.failure_not_counted", {}); return 0; }
    },
    async read(workspaceId, project) {
      try {
        const [own, company] = await Promise.all([readOne(workspaceId, project, "project"), readOne(workspaceId, undefined, "company")]);
        return own ?? company;
      } catch { return undefined; }
    },
  };
}

/** Records a pause without ever throwing into the learning call (the store may be absent). */
export async function notePause(pause: LessonsPauseStore | undefined, workspaceId: string, project: string, code: LessonsPauseCode): Promise<void> {
  if (pause === undefined) return;
  try { await pause.record(workspaceId, project, code); } catch { /* bookkeeping only */ }
}
/** Clears the pause after a learning call succeeded, without ever throwing into the call. */
export async function noteRecovered(pause: LessonsPauseStore | undefined, workspaceId: string, project: string): Promise<void> {
  if (pause === undefined) return;
  try { await pause.clear(workspaceId, project); } catch { /* bookkeeping only */ }
}

/** What the cheap look at the company's learning month says, with the reason when it refuses; a spend port without `look` is asked `admit`, and a refusal there reads as `month_full`. */
export async function spendLook(spend: LearningSpend, workspaceId: string, estimateUsd: number): Promise<"ok" | "month_full" | "too_large" | "unreadable"> {
  try {
    if (spend.look !== undefined) return await spend.look(workspaceId, estimateUsd);
    return (await spend.admit(workspaceId, estimateUsd)) ? "ok" : "month_full";
  } catch { return "unreadable"; }
}
/** The pause a refused look records: the month's limit is the company's; a call too large for the whole cap is a cost problem; a counter that could not be read is a fault, not a reason (nothing is recorded). */
export const pauseOfLook = (look: "month_full" | "too_large" | "unreadable"): LessonsPauseCode | undefined => (look === "month_full" ? "monthly_limit" : look === "too_large" ? "cost_too_high" : undefined);

/** A learning call failed after its key was made: counts it, and pauses the project as `model_failed` once this many in a row have failed (a success clears both). Never throws. */
export async function noteModelFailure(pause: LessonsPauseStore | undefined, workspaceId: string, project: string): Promise<void> {
  if (pause?.failed === undefined) return;
  try {
    if ((await pause.failed(workspaceId, project)) >= MODEL_FAILURES_BEFORE_PAUSE) await pause.record(workspaceId, project, "model_failed");
  } catch { /* bookkeeping only */ }
}
