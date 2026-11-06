// Where a decision card's "Open" goes for a task. The web app has no route for a task by its own id: a task is read on its session's page (`/app/sessions/:id`, `paths.session` in the UI),
// so every card source that opens a task builds its link here, and `tests/web/decision-open-paths.test.ts` checks each one against the app's real routes (QA6-02: `/app/tasks/<uuid>` was "Not found").
import { SessionIdSchema, decisionFocusPath } from "@agentx/contracts";

/** The page of a session in the web app. */
export const sessionOpenPath = (sessionId: string): string => `/app/sessions/${sessionId}`;

/**
 * The page a card opens for a task: its session when it has one (a task record carries `sessionId`; a chain step's session is found by the caller and passed as `sessionId`),
 * otherwise its project's page, which is a real route and shows the project's running work. Never a path built from the task's own id.
 */
export function taskOpenPath(task: { project: string; sessionId?: string | undefined }): string {
  if (task.sessionId !== undefined && SessionIdSchema.safeParse(task.sessionId).success) return sessionOpenPath(task.sessionId);
  return `/app/projects/${encodeURIComponent(task.project)}`;
}

/**
 * The address of one decision card in the app, for a message outside it (Slack): `<origin>/app/sessions/<id>?decision=<card id>` when the task's session is known, otherwise `fallback` (the task page). Only an
 * https origin with no user, query or fragment is used; anything else answers `fallback`.
 */
export function decisionCardUrl(origin: string | undefined, task: { sessionId?: string | undefined }, cardId: string, fallback: string | undefined): string | undefined {
  if (origin === undefined || task.sessionId === undefined || !SessionIdSchema.safeParse(task.sessionId).success) return fallback;
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") return fallback;
    const path = decisionFocusPath(sessionOpenPath(task.sessionId), cardId);
    return path.includes("?") ? `${base.origin}${path}` : fallback;
  } catch {
    return fallback;
  }
}
