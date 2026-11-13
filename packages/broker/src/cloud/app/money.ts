// Convergence S0: the money rules the composition root owns (A5's notes, DEFERRED A5-S0-OPEN-QUESTIONS).
//
//  (2) ONE spend writer. CloudAdmission.settle and the LiteLLM key ledger both count the same SPEND# counters. Work whose model calls go through a
//      Cloud model key (the LiteLLM key ledger records the real spend) RELEASES its admission hold: the ledger is the writer. Only work the key ledger
//      does not see (machine time, a provider outside the proxy) SETTLES, from what Metering priced. Never both: that is double counting.
//  (3) A hold whose caller died is charged in full by `sweepExpiredHolds` on a schedule (jobs.ts `admission-hold-sweep`).
//  (4) The levels a request counts against repeat Cloud's own `budgetScopesFor` + `effectiveLimits`, with the default payer (the person who acts; the
//      project when no person is named), so a core admission and Cloud's own `admitWork` agree on the scopes and limits.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { projectAiKey, scopeKey, type BudgetScope } from "@agentx/cloud-contracts";
import type { AdmissionRequest, Cost, Payer, TransactItem } from "@rovara-code/contracts";
import { ROVARA_CODE_AGENT_ID, agentXError, when } from "@rovara-code/contracts";
import { taskPointerKey } from "../../developer/task-records.js";
import { effectiveLimits, readProjectAiWithRevision } from "../../spend/settings.js";
import { budgetScopesFor, resolvePayer } from "../../spend/payer.js";

/** Where a core task's payer is kept: captured by its start, read by every later admission that has no person (the machine, the second review, a design review, a re-run after a merge). */
export const taskPayerKey = (taskId: string): { pk: string; sk: string } => ({ pk: `DEVTASK#${taskId}`, sk: "PAYER" });
export const TASK_PAYER_ENTITY = "TASK_PAYER";

/** Who records the real spend of a piece of work. */
export type SpendWriter = "key-ledger" | "metering";

export interface WorkSpend {
  /** The work's model calls went through a Cloud model key (the LiteLLM proxy's per-task key). */
  viaModelKey: boolean;
}

export function spendWriterFor(work: WorkSpend): SpendWriter {
  return work.viaModelKey ? "key-ledger" : "metering";
}

export interface HoldCloser {
  settle(reservationId: string, actual: { tokens?: number; cost?: Cost }): Promise<void>;
  release(reservationId: string): Promise<void>;
}

/**
 * Closes an admission hold with the one writer rule. `metered` is what Metering priced for the work (undefined: nothing priced, which settles the
 * whole hold, as an unknown cost is never $0, decision 79).
 */
export async function closeHold(admission: HoldCloser, reservationId: string, work: WorkSpend, metered: Cost | undefined): Promise<"released" | "settled"> {
  if (spendWriterFor(work) === "key-ledger") {
    await admission.release(reservationId);
    return "released";
  }
  await admission.settle(reservationId, metered === undefined ? {} : { cost: metered });
  return "settled";
}

export interface AdmissionLevel {
  scope: string;
  kind: BudgetScope["kind"];
  limitUsd: number | undefined;
}

export interface LevelSources {
  /** Cloud's `effectiveLimits` for these scopes in this month (by `scopeKey`). */
  limits(input: { orgId: string; month: string; scopes: readonly BudgetScope[] }): Promise<Map<string, number | undefined>>;
  /** The agent that runs a request (Rovara's own agent unless the request names another). */
  agentId(request: AdmissionRequest): string;
  /** Whether the project's AI settings say the project pays for its tasks (`readProjectAiWithRevision`). Absent: the person pays. */
  projectPays?: (orgId: string, project: string) => Promise<boolean>;
  /** A task's captured payer, by the request's subject (a task, or a workspace: its task by the pointer). Absent: only a request with a person, and the project's own work, can be attributed. */
  taskPayer?: (orgId: string, subject: { type: string; id: string }) => Promise<Payer | undefined>;
  /** What a task's start records beside the task, in the start's own commit: the payer (as `resolvePayer` decides it now) and a hold on the project's AI settings as read. */
  capture?: (request: AdmissionRequest) => Promise<readonly TransactItem[]>;
}

/**
 * Whose budgets a core request counts against, as v2 charges the same work:
 *   - a start by a person (a request with an actor): Cloud's own payer rules (`resolvePayer`, as `resolveRunPayer` applies them) over the project's AI settings read now: the project pays when its settings say
 *     so, else the person who acts. That read is the capture: the task's start records the payer it decided (`capture`), and holds the settings it read;
 *   - the nightly run: the project's own work (`resolvePayer`'s `nightly`);
 *   - every other request, which has no person (the machine of a workspace, the second review, a design review, a re-run after a merge): the task's CAPTURED payer, as v2 charges a task's follow-on spend
 *     to the payer its start recorded (`paymentOfTask`), whatever the project's settings say now. A task with no captured payer is not guessed at: the request fails (nothing is held);
 *   - anything else (no person, no task): the payer is unknown, and the request fails rather than being charged to the project by default.
 * The scopes are `budgetScopesFor` of that payer, as `admitWork` counts them, so a core admission and Cloud's agree.
 */
export async function scopesOf(request: AdmissionRequest, sources: Pick<LevelSources, "agentId" | "projectPays" | "taskPayer">): Promise<BudgetScope[]> {
  const project = request.projectName;
  if (project === undefined) throw new Error("a request that spends money names its project");
  const agentId = sources.agentId(request);
  const personId = request.actor?.personId;
  let payer: Payer | undefined;
  if (personId !== undefined) {
    const projectPays = sources.projectPays === undefined ? false : await sources.projectPays(request.companyId, project);
    // The origins a person starts from (the app, Slack, the CLI, MCP) all charge the project when it pays, else whoever started it.
    payer = resolvePayer({ origin: "app", project, projectPays, agentId, startedBy: { developerId: personId } });
  } else if (request.action === "nightly.run") {
    payer = resolvePayer({ origin: "nightly", project, projectPays: false, agentId });
  } else if (request.subject !== undefined && (request.subject.type === "task" || request.subject.type === "workspace") && sources.taskPayer !== undefined) {
    payer = await sources.taskPayer(request.companyId, request.subject);
  }
  if (payer === undefined) throw agentXError("CONFIG_INVALID", `payer: the ${request.action} request has no payer recorded, so it is not charged to anyone by default`);
  return budgetScopesFor(payer, { project }, { agentId });
}

/** CloudAdmission's `levels`: the scopes and limits of a request in a month, as Cloud's own admission computes them. */
export function cloudAdmissionLevels(sources: LevelSources) {
  return async (request: AdmissionRequest, month: string): Promise<AdmissionLevel[]> => {
    const scopes = await scopesOf(request, sources);
    const limits = await sources.limits({ orgId: request.companyId, month, scopes });
    return scopes.map((scope) => ({ scope: scopeKey(scope), kind: scope.kind, limitUsd: limits.get(scopeKey(scope)) }));
  };
}

/** Cloud's own sources for the levels: `effectiveLimits`, Rovara's own agent, the project's `projectPays` setting read live from the State table, and the task's captured payer. */
export function cloudLevelSources(deps: Parameters<typeof effectiveLimits>[0]): LevelSources {
  const read = async (Key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  return {
    limits: (input) => effectiveLimits(deps, input),
    agentId: () => ROVARA_CODE_AGENT_ID,
    projectPays: async (orgId, project) => (await readProjectAiWithRevision(deps, orgId, project)).settings.projectPays,
    async taskPayer(orgId, subject) {
      // A workspace's task is the one its pointer names.
      const taskId = subject.type === "task" ? subject.id : (await read(taskPointerKey(subject.id)))?.["taskId"];
      if (typeof taskId !== "string") return undefined;
      const row = await read(taskPayerKey(taskId));
      const payer = row?.["payer"] as Payer | undefined;
      return row !== undefined && row["orgId"] === orgId && payer !== undefined && typeof payer === "object" && typeof payer.kind === "string" ? payer : undefined;
    },
    async capture(request) {
      if (request.action !== "task.start" || request.subject?.type !== "task" || request.actor === undefined || request.projectName === undefined) return [];
      const stored = await readProjectAiWithRevision(deps, request.companyId, request.projectName);
      const payer = resolvePayer({ origin: "app", project: request.projectName, projectPays: stored.settings.projectPays, agentId: ROVARA_CODE_AGENT_ID, startedBy: { developerId: request.actor.personId } });
      return [
        { kind: "put", item: { ...taskPayerKey(request.subject.id), entityType: TASK_PAYER_ENTITY, orgId: request.companyId, taskId: request.subject.id, payer, project: request.projectName, origin: "app", settingsRevision: stored.revision } },
        // The settings the payer was decided from still hold at the commit (a project switched to paying, or back, meanwhile stops the start, which is then asked again): absent where there were none.
        { kind: "check", key: projectAiKey(request.companyId, request.projectName), condition: stored.revision === 0 ? when.absent() : when.eq("revision", stored.revision) },
      ];
    },
  };
}
