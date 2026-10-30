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
        if (lock.present) return lock.mode ?? "off";
        if (project === undefined) return LEARNING_MODE_DEFAULT;
        const own = await read(learningModeKey(orgId, project));
        if (!own.present) return LEARNING_MODE_DEFAULT;
        return own.mode ?? "off";
      } catch {
        return "off";
      }
    },
  };
}
