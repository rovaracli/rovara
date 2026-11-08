// Lessons connect (fix 1, M3 and L5): what the nightly passes remember between nights, one small item per company and pass on the Team record table (`LESSONSET#NIGHTLY#<pass>` in the company's partition, which the
// company erase already wipes):
//   - `next`: where the pass starts tomorrow. Both passes walk the company's projects from a saved position, so when the time budget runs out the projects at the end are not the same ones every night.
//   - `projects` (the expiry pass): per project (a hash, never the name), when the sweep last ran for it and until when its pending lessons are held. A project the sweep did not see for a few nights (learning was Off)
//     starts a grace window, so switching learning back on never expires the whole pending backlog on the first night.
// Nothing here names a person or a lesson. A read that fails is "no memory": the pass runs from the top with no grace written.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk } from "@agentx/contracts";
import type { TeamRecordTable } from "../team-record/types.js";

export type NightlyPass = "expire" | "promote";
export interface NightlyProjectState { seenAt: number; graceUntil?: number }
export interface NightlyPassState { next: number; projects: Record<string, NightlyProjectState> }
export interface NightlyStateStore {
  /** Throws when the item cannot be read (the pass then neither rotates nor writes). */
  read(orgId: string, pass: NightlyPass): Promise<NightlyPassState>;
  write(orgId: string, pass: NightlyPass, state: NightlyPassState): Promise<void>;
}

/** A project is not seen for longer than this when learning was Off (or the passes ran out of time): its next sweep opens a grace window. */
export const RETURN_GAP_MS = 3 * 86_400_000;
/** How long a returning project's pending lessons are held. */
export const PENDING_GRACE_MS = 7 * 86_400_000;
const MAX_PROJECT_STATES = 400;

export const projectHash = (orgId: string, project: string): string => createHash("sha256").update(`${orgId}\u0000${project}`).digest("hex").slice(0, 12);
const keyOf = (orgId: string, pass: NightlyPass) => ({ pk: teamRecordPk(orgId, undefined), sk: `LESSONSET#NIGHTLY#${pass.toUpperCase()}` });

export function tableNightlyState(table: TeamRecordTable): NightlyStateStore {
  return {
    async read(orgId, pass) {
      const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: keyOf(orgId, pass), ConsistentRead: true }))) as { Item?: { next?: unknown; projects?: unknown } }).Item;
      if (item === undefined) return { next: 0, projects: {} };
      const next = typeof item.next === "number" && Number.isInteger(item.next) && item.next >= 0 ? item.next : 0;
      const projects: Record<string, NightlyProjectState> = {};
      if (typeof item.projects === "object" && item.projects !== null) {
        for (const [hash, value] of Object.entries(item.projects as Record<string, unknown>).slice(0, MAX_PROJECT_STATES)) {
          const v = value as { seenAt?: unknown; graceUntil?: unknown };
          if (typeof v?.seenAt === "number") projects[hash] = { seenAt: v.seenAt, ...(typeof v.graceUntil === "number" ? { graceUntil: v.graceUntil } : {}) };
        }
      }
      return { next, projects };
    },
    async write(orgId, pass, state) {
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...keyOf(orgId, pass), entityType: "LESSON_NIGHTLY", next: state.next, projects: state.projects } }));
    },
  };
}

/** The projects in a fixed order (sorted) starting at `next`, wrapping round. */
export function rotated(projects: readonly string[], next: number): string[] {
  const sorted = [...new Set(projects)].sort();
  if (sorted.length === 0) return [];
  const start = next % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}
