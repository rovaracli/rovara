// A READY worker whose instance is gone (terminated, stopped, or confirmed absent): the session is marked lost (READY -> STOPPED, fenced on the generation and the instance it was read with) and the workspace's active
// operation is failed with the compute-lost error, which the task's retry path knows ("compute was lost; retry"). Shared by the reconciler (an instance it finds gone, #86) and the reaper (a worker it terminated under its
// task because the company removed an internal address, owner decision 128), so both take the same fences and the same words. Nothing else lives here, so the reaper's bundle stays small.
import type { WorkspaceSession } from "@rovara-code/contracts";
import type { SessionManager } from "./sessions.js";

export const COMPUTE_LOST_ERROR = "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request";

export interface ComputeLostDependencies {
  sessions: Pick<SessionManager, "markLost">;
  /** Fails the workspace's active operation and releases it; returns the operation ID, if any. */
  failActiveOperation: (workspaceId: string, error: string) => Promise<string | undefined>;
}

/** Marks the session lost and fails its operation. `lost: false`: the session moved on since it was read (a new generation, a claim), and nothing was changed. */
export async function markComputeLost(dependencies: ComputeLostDependencies, session: WorkspaceSession): Promise<{ lost: false } | { lost: true; operationId: string | undefined }> {
  if (!(await dependencies.sessions.markLost(session))) return { lost: false };
  return { lost: true, operationId: await dependencies.failActiveOperation(session.workspaceId, COMPUTE_LOST_ERROR) };
}
