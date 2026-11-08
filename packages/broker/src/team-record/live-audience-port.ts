// SRL-4: the State-table side of the live task check (`live-audience.ts`). A task's live visibility is read the way it was decided when rows were written (`lessons/task-visibility.ts`: the session's shares,
// then the People list), but STRICTLY: any read that fails, a malformed People list, a task that is gone or belongs to another company is "unreadable", never the owner's alone.
import { resolveTaskVisibility } from "../lessons/task-visibility.js";
import type { TaskVisibilityPort } from "./live-audience.js";

type StateTable = Parameters<typeof resolveTaskVisibility>[0];

const LOOKUP_PARALLEL = 8;

export function tableTaskVisibilityPort(table: StateTable): TaskVisibilityPort {
  return {
    async read(orgId, taskIds, options) {
      const out = new Map<string, Awaited<ReturnType<typeof resolveTaskVisibility>>>();
      const queue = [...new Set(taskIds)];
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined && options?.signal?.aborted !== true; id = queue.shift()) {
          try {
            out.set(id, await resolveTaskVisibility(table, orgId, id, { strict: true }));
          } catch {
            out.set(id, undefined);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(LOOKUP_PARALLEL, queue.length) }, worker));
      return out;
    },
  };
}
