// The learning mode of a project (design 1.2): Off, Collect, Suggest, On. A company lock, when set, wins over the project's own value. Capture (the record fills)
// is on for Collect, Suggest and On; Off captures nothing and loads nothing. A mode that cannot be read is Off: the pipeline fails closed.
// Where the mode is stored is the learning lane's settings writer; this file reads the two items the key builders name and accepts anything else through a port.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { LEARNING_MODE_DEFAULT, LearningModeSchema, learningModeKey, learningModeLockKey, type LearningMode, type OrgId } from "@agentx/contracts";
import type { TeamRecordTable } from "./types.js";

export interface LearningModeReader {
  /** The effective mode of a project: the company lock if set, else the project's own, else the default (Suggest). Off when unreadable. */
  effectiveMode(orgId: OrgId, project: string | undefined): Promise<LearningMode>;
}

const STRICTNESS: Record<LearningMode, number> = { off: 0, collect: 1, suggest: 2, on: 3 };
/** The stricter of two modes: Off is the strictest, On the loosest. */
export const stricter = (left: LearningMode, right: LearningMode): LearningMode => (STRICTNESS[left] <= STRICTNESS[right] ? left : right);

export const captureIsOn = (mode: LearningMode): boolean => mode !== "off";
export const lessonsLoad = (mode: LearningMode): boolean => mode === "suggest" || mode === "on";

/** Reads `MODE_LOCK` (workspace partition) and the project's `MODE` item from the TeamRecord table. A value that does not parse counts as Off. */
export function tableModeReader(table: TeamRecordTable): LearningModeReader {
  const read = async (key: { pk: string; sk: string }): Promise<{ present: boolean; mode?: LearningMode }> => {
    const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: { mode?: unknown } };
    if (response.Item === undefined) return { present: false };
    const parsed = LearningModeSchema.safeParse(response.Item.mode);
    return parsed.success ? { present: true, mode: parsed.data } : { present: true };
  };
  return {
    async effectiveMode(orgId, project) {
      try {
        const lock = await read(learningModeLockKey(orgId));
        // A company lock only ever makes the mode stricter (owner decision M8): the project's own value is kept unless the lock is stricter still.
        const own = project === undefined ? { present: false } as const : await read(learningModeKey(orgId, project));
        const ownMode: LearningMode = own.present ? (own.mode ?? "off") : LEARNING_MODE_DEFAULT;
        if (!lock.present) return ownMode;
        return stricter(lock.mode ?? "off", ownMode);
      } catch {
        return "off";
      }
    },
  };
}
