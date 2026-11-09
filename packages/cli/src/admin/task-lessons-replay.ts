// Lane 7: `agentx admin task lessons-replay`, an administrator's replay COPY of a past task, made to measure the lessons (`scripts/lessons-replay-measure.ts` calls it). `start` makes a copy of the past task, marked as a
// replay at creation, with no lessons or exactly one frozen snapshot, never shared or published; `show` reads a copy. Like every `agentx admin` command, the admin sign-in is the only confirmation.
import { adminResponseBody } from "./http.js";

const base = (controlPlaneUrl: string, taskId: string) => `${controlPlaneUrl.replace(/\/$/, "")}/v1/admin/tasks/${encodeURIComponent(taskId)}/lessons-replay`;

export interface LessonsReplayStart {
  requestId: string;
  memory: { mode: "off" } | { mode: "snapshot"; snapshotId: string; lessons?: Array<{ id: string; version: number }> };
  maxUsd: number;
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
