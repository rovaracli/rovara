// Lessons in production, lane 1b: learning is never silent. When it cannot run for a project or its company (no company-billed provider, the monthly learning limit, every model forbidden, the
// cheapest model too dear for the budgets) ONE current reason is recorded, as a fixed code and a time, and the Lessons tab and Home say it in one line. A learning call that succeeds clears it.
//
//   project: pk of the project, sk `LESSONSET#PAUSED`   (why learning cannot run for this project: its providers, models and budgets)
//   company: pk of the workspace, sk `LESSONSET#PAUSED`  (why it cannot run for the company: the monthly learning limit)
// Every sort key starts with `LESSONSET`, which the project erase and the workspace erase already wipe. The item holds a code from the allow-list, a time and nothing else: no model name, no amount, no
// provider or proxy text, no person (checklist section 3). A store that cannot be reached never blocks learning and never throws into it: the pause is bookkeeping, not a gate.
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { LESSONS_PAUSE_CODES, teamRecordPk, type LessonsPauseCode } from "@agentx/contracts";
import type { TeamRecordTable } from "../team-record/types.js";

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
  /** A learning call for the project succeeded: its own reason and the company's are cleared. Never throws. */
  clear(workspaceId: string, project: string): Promise<void>;
  /** The reason in force for a project: its own, else the company's. Undefined when there is none or it cannot be read. */
  read(workspaceId: string, project: string): Promise<CurrentPause | undefined>;
}

/** Which scope a reason belongs to: the monthly limit is the company's; the rest follow from the project's own providers, models and budgets. */
export const pauseScopeOf = (code: LessonsPauseCode): "project" | "company" => (code === "monthly_limit" ? "company" : "project");

const SK = "LESSONSET#PAUSED";
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
        await table.documentClient.send(new PutCommand({
          TableName: table.tableName, Item: { ...keyOf(workspaceId, pauseScopeOf(code) === "company" ? undefined : project), entityType: "LESSON_PAUSE", code, at: now() },
        }));
      } catch { log?.("lessons.pause_not_recorded", { code }); }
    },
    async clear(workspaceId, project) {
      for (const scoped of [project, undefined]) {
        try { await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: keyOf(workspaceId, scoped) })); } catch { log?.("lessons.pause_not_cleared", { scope: scoped === undefined ? "company" : "project" }); }
      }
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
