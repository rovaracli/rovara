// Part of the broker: what a worker's progress events tell the lessons library (learning v2, L4/L5) and the "What the agent loaded" record. `afterWorkerEvents` is called once after a batch of worker
// events was stored. It does nothing where the install has no lesson ports or the project's learning mode is Off, never throws, and never changes how the events were stored.
//   - `learnedLoadReport`: the worker's account of which lessons reached its prompt (valid, moved, dropped as stale or unchecked). It is applied only to the manifest this operation recorded at
//     dispatch (`operation.learnedLoad`), once per stage and round (`applyLoadReport`), and only for lessons that manifest names.
//   - `loadedKnowledge`: the references of the rule files and skills a stage loaded (no text). Stored beside the task for the task page.
import { learnedLoadReportOfProgress, loadedKnowledgeOfProgress } from "@rovara-code/contracts";
import { getItem, type OperationRecord } from "../cancellation.js";
import { recordLoadedKnowledgeFromProgress } from "../../developer/loaded-knowledge.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord } from "../../developer/task-records.js";
import { applyLoadReport } from "../../lessons/counters.js";
import { modeAllows, resolveLearning } from "../../lessons/policy.js";
import type { AwsBrokerDependencies } from "./definitions.js";

const MAX_EVENTS = 500;

export async function afterWorkerEvents(dependencies: Pick<AwsBrokerDependencies, "lessons" | "documentClient" | "tableName">, operation: OperationRecord, body: unknown): Promise<void> {
  const lessons = dependencies.lessons;
  if (lessons === undefined || operation.orgId === undefined) return;
  try {
    const events = (body as { events?: unknown } | null)?.events;
    if (!Array.isArray(events)) return;
    const progress = events.slice(0, MAX_EVENTS).flatMap((event) => {
      const item = event as { type?: unknown; payload?: unknown } | null;
      return item !== null && typeof item === "object" && item.type === "progress" ? [item.payload] : [];
    });
    const reports = progress.flatMap((payload) => { const report = learnedLoadReportOfProgress(payload); return report === undefined ? [] : [report]; });
    const knowledge = progress.filter((payload) => loadedKnowledgeOfProgress(payload) !== undefined);
    if (reports.length === 0 && knowledge.length === 0) return;
    const load = operation.learnedLoad;
    const project = load?.project ?? (await taskOfWorkspace(dependencies, operation))?.project;
    if (project === undefined) return;
    // The project's learning mode, read now: with learning off nothing is applied or stored.
    const resolved = await resolveLearning(lessons.settings, operation.orgId, project);
    if (!modeAllows(resolved.mode, "load")) return;
    if (load !== undefined) {
      for (const report of reports) {
        if (report.stage !== load.stage) continue;
        await applyLoadReport(lessons.counters, { workspaceId: operation.orgId, project: load.project, taskId: load.taskId, stage: load.stage, round: load.round, report });
      }
    }
    if (knowledge.length > 0) {
      const taskId = load?.taskId ?? (await taskOfWorkspace(dependencies, operation))?.taskId;
      if (taskId !== undefined) for (const payload of knowledge) await recordLoadedKnowledgeFromProgress({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, { taskId, operationId: operation.id, payload });
    }
  } catch { /* information only: a lost report leaves a lesson "not checked", it never fails the worker's events */ }
}

async function taskOfWorkspace(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">, operation: OperationRecord): Promise<{ taskId: string; project: string } | undefined> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  if (pointer === undefined) return undefined;
  const task = await getItem<{ taskId: string; project: string; orgId?: string }>(dependencies, taskKey(pointer.taskId));
  return task === undefined || task.orgId !== operation.orgId ? undefined : { taskId: task.taskId, project: task.project };
}
