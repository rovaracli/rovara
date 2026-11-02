// Setup and test health SH28 (owner decision 7): "Setup needs repair" does not pause a task start. The task starts and runs as always; its view only gets a notice that testing may be blocked. This module is the one
// place a task view picks that up (task start and task read), so the view builder stays as it is. With the `nh` switch (or the test environment) off the view is returned untouched; a health that cannot be read
// shows nothing, and nothing here can fail a start or a read.
import type { DeveloperTaskView } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { taskStartNotice } from "../../test-env/health.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

export async function withTestingNotice(deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "now">, task: Pick<DeveloperTaskRecord, "orgId" | "project">, view: DeveloperTaskView, env: NodeJS.ProcessEnv = process.env): Promise<DeveloperTaskView> {
  if (task.orgId === undefined) return view;
  try {
    const notice = await taskStartNotice({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, task.orgId, task.project, env);
    return notice.banner === undefined ? view : { ...view, testingNotice: { state: notice.banner.state, text: notice.banner.text } };
  } catch {
    return view;
  }
}
