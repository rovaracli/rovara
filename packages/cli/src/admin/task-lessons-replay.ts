// Lane 7: `agentx admin task lessons-replay`, an administrator's replay COPY of a past task, made to measure the lessons (`scripts/lessons-replay-measure.ts` calls it). `start` makes a copy of the past task, marked as a
// replay at creation, with no lessons or exactly one frozen snapshot, never shared or published; `show` reads a copy. Like every `agentx admin` command, the admin sign-in is the only confirmation.
import { adminResponseBody } from "./http.js";

const base = (controlPlaneUrl: string, taskId: string) => `${controlPlaneUrl.replace(/\/$/, "")}/v1/admin/tasks/${encodeURIComponent(taskId)}/lessons-replay`;

export interface LessonsReplayStart {
  requestId: string;
  memory: { mode: "off" } | { mode: "snapshot"; snapshotId: string; lessons?: Array<{ id: string; version: number }> };
  maxUsd: number;
  /** The file arm. */
  file?: true;
}

export async function startTaskLessonsReplay(input: { controlPlaneUrl: string; accessToken: string; taskId: string; body: LessonsReplayStart }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImplementation(base(input.controlPlaneUrl, input.taskId), {
    method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(input.body),
  });
  return adminResponseBody(response);
}

export async function showTaskLessonsReplay(input: { controlPlaneUrl: string; accessToken: string; taskId: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImplementation(base(input.controlPlaneUrl, input.taskId), { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } });
  return adminResponseBody(response);
}

const taskBase = base;
const post = async (url: string, accessToken: string, body: unknown, fetchImplementation: typeof fetch): Promise<unknown> =>
  adminResponseBody(await fetchImplementation(url, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

/** Approves the copy's waiting plan (the install's guarded route; refused for any task that is not a replay copy). */
export const approveTaskLessonsReplay = (input: { controlPlaneUrl: string; accessToken: string; taskId: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> =>
  post(`${taskBase(input.controlPlaneUrl, input.taskId)}/approve`, input.accessToken, {}, fetchImplementation);
/** Closes a copy once it is graded. */
export const closeTaskLessonsReplay = (input: { controlPlaneUrl: string; accessToken: string; taskId: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> =>
  post(`${taskBase(input.controlPlaneUrl, input.taskId)}/close`, input.accessToken, {}, fetchImplementation);
/** The copy's request, the change it made and the past task's merged change: what the grader reads. */
export async function evidenceTaskLessonsReplay(input: { controlPlaneUrl: string; accessToken: string; taskId: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  return adminResponseBody(await fetchImplementation(`${taskBase(input.controlPlaneUrl, input.taskId)}/evidence`, { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } }));
}

const projectBase = (controlPlaneUrl: string, project: string) => `${controlPlaneUrl.replace(/\/$/, "")}/v1/admin/projects/${encodeURIComponent(project)}/lessons-replay`;
/** Imports the lessons an arm's pipeline built offline as one frozen snapshot of the project. */
export const importLessonsReplaySnapshot = (input: { controlPlaneUrl: string; accessToken: string; project: string; body: { pipeline: string; day: string; lessons: unknown[] } }, fetchImplementation: typeof fetch = fetch): Promise<unknown> =>
  post(`${projectBase(input.controlPlaneUrl, input.project)}/snapshots`, input.accessToken, input.body, fetchImplementation);
/** One model call on the company's own model path, for a grading or an arm's offline pipeline; the answer holds the text and the cost. */
export const callLessonsReplayModel = (input: { controlPlaneUrl: string; accessToken: string; project: string; body: { purpose: "grade" | "learn"; system: string; user: string; maxOutputTokens: number; maxUsd: number } }, fetchImplementation: typeof fetch = fetch): Promise<unknown> =>
  post(`${projectBase(input.controlPlaneUrl, input.project)}/model`, input.accessToken, input.body, fetchImplementation);

/** The project's learning settings as the live pipeline reads them (and whether auto-apply and an embedder are on), so the offline pipeline runs under the project's real rules. */
export async function settingsLessonsReplay(input: { controlPlaneUrl: string; accessToken: string; project: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  return adminResponseBody(await fetchImplementation(`${projectBase(input.controlPlaneUrl, input.project)}/settings`, { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } }));
}

/** A historical task as the reflector sees it, for an arm's offline pipeline. */
export async function subjectLessonsReplay(input: { controlPlaneUrl: string; accessToken: string; project: string; taskId: string }, fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  return adminResponseBody(await fetchImplementation(`${projectBase(input.controlPlaneUrl, input.project)}/subjects/${encodeURIComponent(input.taskId)}`, { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } }));
}
