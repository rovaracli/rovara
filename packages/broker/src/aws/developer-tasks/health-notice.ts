// Setup and test health SH28 (owner decision 7): "Setup needs repair" does not pause a task start. The task starts and runs as always; its view only gets a notice that testing may be blocked. This module is the one
// place a task view picks that up (task start and task read), so the view builder stays as it is. With the `nh` switch (or the test environment) off the view is returned untouched; a health that cannot be read,
// or is slow to read, shows nothing: the read has a short deadline, and a start or a read is never delayed by more than that.
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { taskStartNotice } from "../../test-env/health.js";
import { companyGatedEnv } from "../../org/feature-rollout.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

/** How long a start or a read waits for the notice. */
export const TESTING_NOTICE_TIMEOUT_MS = 300;

export async function withTestingNotice(
  deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "now" | "gates">, task: Pick<DeveloperTaskRecord, "orgId" | "project">, view: DeveloperTaskView,
  env: NodeJS.ProcessEnv = process.env, timeoutMs: number = TESTING_NOTICE_TIMEOUT_MS,
): Promise<DeveloperTaskView> {
  if (task.orgId === undefined) return view;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
    // TE-A1: the notice follows the company's gates (the whole read is inside the bound: a slow gate read shows no banner, as a slow health read does).
    const store = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, gates: deps.gates };
    const notice = await Promise.race([companyGatedEnv(store, task.orgId, env).then((gated) => taskStartNotice(store, task.orgId!, task.project, gated)), timeout]);
    return notice?.banner === undefined ? view : { ...view, testingNotice: { state: notice.banner.state, text: notice.banner.text } };
  } catch {
    return view;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
