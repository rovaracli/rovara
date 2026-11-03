// What a project's page says about its automatic runs (owner decision 2026-11-02): the runs Rovara started by itself ("Started by Rovara (nightly)"), its own "Automatic runs" line (this month's runs against the cap, and
// that the cap has paused them), and the reminder to review the setup when the person who approved it has left. Fixed words, counts and days: nothing from a repository, and no task id (a person cannot open a task they do not own).
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AutomaticJobSchema, orgMemberKey, projectPk, startedByAutomaticWords, type AutomaticJob, type OrgId } from "@agentx/contracts";
import { taskKey } from "../developer/task-records.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { readApprovedBy, readApprovedTestEnvironment } from "../org/test-environment.js";
import { AUTOMATIC_RUNS_STARTED_PREFIX, readAutomaticRunsUse, type AutomaticRunsUse } from "./cap.js";

export const RECENT_AUTOMATIC_RUNS_SHOWN = 10;

export type AutomaticRunState = "running" | "complete" | "failed" | "cancelled";
export interface AutomaticRunView { job: AutomaticJob; words: string; startedAt: string; state: AutomaticRunState }
export interface ReviewReminder { kind: "approver_left"; revision: number; words: string }
export interface AutomaticRunsView {
  /** The project's own "Automatic runs" line: the project pays, so this month's runs against its cap. */
  line: AutomaticRunsUse & { label: "Automatic runs"; words: string };
  /** Why automatic runs are paused, when the cap has paused them. */
  pausedWords?: string;
  recent: AutomaticRunView[];
  reviewReminder?: ReviewReminder;
}

export const AUTOMATIC_RUNS_PAUSED_WORDS = (cap: number): string => `Automatic runs are paused for this month: this project reached its cap of ${String(cap)}. A project maintainer can raise the cap.`;
export const APPROVER_LEFT_WORDS = "The person who approved this project's test setup is no longer in the company. Automatic runs keep going; a project maintainer should review the setup and approve it again.";

const get = async (deps: TestEnvDeps, key: { pk: string; sk: string }) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;

/** The runs the project's system owner started lately, newest first, with where each one stands now (from its own task). A run whose record cannot be read is left out, never shown as something it is not. */
export async function recentAutomaticRuns(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<AutomaticRunView[]> {
  const found: Array<{ job: AutomaticJob; at: string; taskId: string | undefined }> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": AUTOMATIC_RUNS_STARTED_PREFIX }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const job = AutomaticJobSchema.safeParse(item.job);
      if (job.success && typeof item.at === "string" && Number.isFinite(Date.parse(item.at))) found.push({ job: job.data, at: item.at, taskId: typeof item.taskId === "string" ? item.taskId : undefined });
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  found.sort((a, b) => b.at.localeCompare(a.at));
  const runs: AutomaticRunView[] = [];
  for (const entry of found.slice(0, RECENT_AUTOMATIC_RUNS_SHOWN)) {
    const task = entry.taskId === undefined ? undefined : await get(deps, taskKey(entry.taskId)).catch(() => undefined);
    // Only a task of this company and project counts as the run's own.
    if (task !== undefined && (task.orgId !== orgId || task.project !== project)) continue;
    const end = task?.agentRunEnd as { state?: unknown } | undefined;
    const state: AutomaticRunState = end?.state === "COMPLETE" ? "complete" : end?.state === "FAILED" ? "failed" : end?.state === "CANCELLED" ? "cancelled" : "running";
    runs.push({ job: entry.job, words: startedByAutomaticWords(entry.job), startedAt: entry.at, state });
  }
  return runs;
}

/**
 * The approver-left reminder: the person who approved the project's current test setup is no longer a member of the company. The runs go on regardless; this only asks a maintainer to look again. A new approval names a new
 * approver and clears it. Undefined when the approver is still there, or when nothing names one.
 */
export async function reviewReminderOf(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<ReviewReminder | undefined> {
  const approved = await readApprovedTestEnvironment(deps, orgId, project).catch(() => undefined);
  if (approved === undefined) return undefined;
  const approver = await readApprovedBy(deps, orgId, project, approved.revision).catch(() => undefined);
  if (approver === undefined) return undefined;
  const member = await get(deps, orgMemberKey(orgId, approver)).catch(() => "unreadable" as const);
  // A member row that cannot be read says nothing: no reminder on a doubt (the reminder is advice, not a gate).
  if (member === "unreadable" || member !== undefined) return undefined;
  return { kind: "approver_left", revision: approved.revision, words: APPROVER_LEFT_WORDS };
}

export async function automaticRunsView(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<AutomaticRunsView> {
  const [use, recent, reviewReminder] = await Promise.all([readAutomaticRunsUse(deps, orgId, project), recentAutomaticRuns(deps, orgId, project).catch(() => []), reviewReminderOf(deps, orgId, project).catch(() => undefined)]);
  return {
    line: { ...use, label: "Automatic runs", words: `Automatic runs: ${String(use.used)} of ${String(use.cap)} this month` },
    ...(use.paused ? { pausedWords: AUTOMATIC_RUNS_PAUSED_WORDS(use.cap) } : {}),
    recent,
    ...(reviewReminder === undefined ? {} : { reviewReminder }),
  };
}
