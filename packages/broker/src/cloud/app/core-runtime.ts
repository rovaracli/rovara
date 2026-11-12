// Convergence S0: Rovara Code's core, built for one company over the sealed Cloud registry.
//
// The task flow comes straight from Code (`createTaskFlowFromRegistry`): start, the stage machine, dispatch, the recovery sweep and the outbox relay. Its
// build steps are Code's default (`createBuildSteps`, set by `createTaskFlow`). Every core task gets its engine stamp in the start's own transaction.
//
// The other core services (merge tracking, the session sweep, notices) are joined in Code by its LOCAL composition root (`Kb/local/app/tracking.ts`,
// `app.ts`), which is not exported and carries laptop rules (`fixedCodeSettings`, `soleOwnerPeople`). Cloud needs the same joins with its own company
// settings and people. Until Code exports a service layer for them (open question S0-Q1 in the lane report), each is a `CoreService` the deployment
// supplies; `serviceGaps` names the ones missing so the switch cannot be turned on for an area whose service is not wired.
import { RepositoryGrantService } from "@rovara-code/broker";
import { createStoreProjectSource, createTaskFlowFromRegistry, type RegistryTaskFlowOptions, type StartExtras, type StartExtrasInput, type TaskAccess, type TaskFlow } from "@rovara-code/broker/core/task-flow";
import type { AdapterRegistry, OrgId } from "@rovara-code/contracts";
import { stampForNewTask, stampItem } from "./engine-stamp.js";
import type { CoreArea, CoreEngineFlags } from "./flags.js";

/** A core service a scheduled job runs, per company. */
export interface CoreService {
  /** One pass (a sweep); returns a small report for the log. */
  pass(options: { budgetMs: number }): Promise<Record<string, unknown>>;
}

/** The services beyond the task flow, by name, and the area each belongs to. */
export const CORE_SERVICES = {
  "merge-tracking": "merge",
  "session-sweep": "flow",
  "notify-deliver": "flow",
  "admission-hold-sweep": "flow",
} as const satisfies Record<string, CoreArea>;
export type CoreServiceName = keyof typeof CORE_SERVICES;

export interface CoreRuntime {
  companyId: OrgId;
  flow: TaskFlow;
  services: Partial<Record<CoreServiceName, CoreService>>;
}

export interface CoreRuntimeOptions {
  registry: AdapterRegistry;
  companyId: OrgId;
  flags: CoreEngineFlags;
  callbackSigningKey: string | Buffer;
  /** Who may start work and act on a task (Cloud: the people adapter's access rule). */
  access: TaskAccess;
  /** Issues a worker's repository grant (Cloud: the GitHub App credential provider). */
  repositoryCredential: ConstructorParameters<typeof RepositoryGrantService>[1];
  repositoryGrantKey: Buffer;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
  /** Extra flow options (limits, prompts, the design review, ...): whatever the deployment wires. */
  flowOptions?: Partial<RegistryTaskFlowOptions>;
  /** The services beyond the flow, built for this company. */
  services?: (flow: TaskFlow) => Partial<Record<CoreServiceName, CoreService>>;
}

export function createCoreRuntime(options: CoreRuntimeOptions): CoreRuntime {
  const { registry, companyId } = options;
  const store = registry.require("storage");
  const given = options.flowOptions?.startExtras;
  // Every core start writes the engine stamp with the task (decision 130: a task keeps its engine). Joined with any start extras the deployment gives.
  const startExtras = (input: StartExtrasInput): StartExtras => {
    const own = given?.(input);
    const stamp = stampItem(companyId, input.taskId, stampForNewTask(options.flags, companyId, options.now()));
    return { ...(own ?? {}), items: [...(own?.items ?? []), stamp] };
  };
  const flow = createTaskFlowFromRegistry(registry, {
    ...options.flowOptions,
    companyId,
    projects: options.flowOptions?.projects ?? createStoreProjectSource(store, companyId),
    access: options.access,
    repositoryGrants: options.flowOptions?.repositoryGrants ?? new RepositoryGrantService(options.repositoryGrantKey, options.repositoryCredential),
    callbackSigningKey: options.callbackSigningKey,
    now: options.now,
    log: options.log,
    startExtras,
  });
  return { companyId, flow, services: options.services?.(flow) ?? {} };
}

/** The services an area needs that this runtime lacks. */
export function serviceGaps(services: Partial<Record<CoreServiceName, CoreService>>, areas: readonly CoreArea[]): CoreServiceName[] {
  return (Object.entries(CORE_SERVICES) as [CoreServiceName, CoreArea][]).filter(([name, area]) => areas.includes(area) && services[name] === undefined).map(([name]) => name);
}
