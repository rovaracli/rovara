// Convergence S0: Cloud's composition root for Rovara Code's core (`Cb/cloud/app/`, the counterpart of Code's `Kb/local/app/`).
//
// One object per Lambda container. It reads the switches once, and only when one is on does it build the registry (once) and a core runtime per company
// (once). With every switch off it builds nothing, writes nothing, and every entry point answers "off" without touching the store: Cloud behaves
// exactly as before (tests/unit/cloud-app-off.test.ts).
//
// Entry points:
//   - `engineForNewTask(company)`: where a new task starts (the switch). The start route asks this; `core` sends the start to `startOnCore`.
//   - `engineOfTask(store, taskId, area)`: where an EXISTING task's area runs (its stamp, never the switch).
//   - `handleScheduledJob(event)`: an EventBridge schedule's event (`agentx.core-job`) runs one row of the jobs table, per company, isolated.
//   - `relayOutbox(companies)`: the stream reader's hook on outbox inserts (no third stream reader, plan 2 `queue`).
import type { AdapterRegistry, OrgId } from "@rovara-code/contracts";
import { createCoreRuntime, serviceGaps, type CoreRuntime, type CoreRuntimeOptions } from "./core-runtime.js";
import { engineForNewTask, engineOfStoredTask, type Engine } from "./engine-stamp.js";
import { CORE_AREAS, anyCoreAreaOn, coreAreaOn, coreCompanies, readCoreEngineFlags, type CoreArea, type CoreEngineFlags } from "./flags.js";
import { CORE_JOBS, isCoreJobEvent, runPerCompany, type CompanyRunReport, type CoreJob } from "./jobs.js";
import { buildCloudRegistry, type CloudAdapterContext, type CloudAdapterModule } from "./registry.js";

export interface CloudAppOptions {
  env?: NodeJS.ProcessEnv;
  /** The adapters (cloud-modules.ts in production; fakes in tests). */
  modules: readonly CloudAdapterModule[];
  /** Builds the adapter context (clients) on first use. */
  context: () => CloudAdapterContext;
  /** The per-company runtime's own wiring (signing key, access, credentials, services). */
  runtime: (registry: AdapterRegistry, companyId: OrgId, flags: CoreEngineFlags) => Omit<CoreRuntimeOptions, "registry" | "companyId" | "flags">;
  jobs?: readonly CoreJob[];
  /** The time budget of one scheduled run. Default 50 s (a schedule's Lambda has 60). */
  jobBudgetMs?: number;
  nowMs?: () => number;
}

export interface CloudApp {
  readonly flags: CoreEngineFlags;
  /** Whether any switch is on. False: nothing below builds anything. */
  readonly active: boolean;
  engineForNewTask(companyId: string): Engine;
  engineOfTask(store: Parameters<typeof engineOfStoredTask>[0], taskId: string, area: CoreArea): Promise<Engine>;
  /** The sealed registry (built once). Throws when no switch is on: an off install never builds it. */
  registry(): Promise<AdapterRegistry>;
  /** The core for one company (built once). Throws when the flow is not switched on for it. */
  runtimeFor(companyId: string): Promise<CoreRuntime>;
  /** An EventBridge event: `undefined` when it is not a core job's; `{ skipped: "off" }` while off. */
  handleScheduledJob(event: unknown): Promise<undefined | { skipped: "off" | "unknown_job" } | { job: string; companies: CompanyRunReport[] }>;
  /** The stream reader's hook: relay the outbox of these companies (those not switched on are skipped). */
  relayOutbox(companies: readonly string[]): Promise<CompanyRunReport[]>;
}

export class CoreEngineOffError extends Error {
  constructor(what: string) {
    super(`the core engine is off: ${what}`);
    this.name = "CoreEngineOffError";
  }
}

export function createCloudApp(options: CloudAppOptions): CloudApp {
  const flags = readCoreEngineFlags(options.env ?? process.env);
  const active = anyCoreAreaOn(flags);
  const jobs = options.jobs ?? CORE_JOBS;
  const nowMs = options.nowMs ?? Date.now;
  let context: CloudAdapterContext | undefined;
  let registryPromise: Promise<AdapterRegistry> | undefined;
  const runtimes = new Map<string, Promise<CoreRuntime>>();
  let rotation = 0;

  const contextOnce = (): CloudAdapterContext => (context ??= options.context());
  // The areas some company may have on: their points must all be filled.
  const switchedAreas = (): CoreArea[] => CORE_AREAS.filter((area) => flags.areas[area]?.mode !== "off");

  const registry = (): Promise<AdapterRegistry> => {
    if (!active) return Promise.reject(new CoreEngineOffError("no registry is built"));
    registryPromise ??= buildCloudRegistry({ modules: options.modules, context: contextOnce(), areas: switchedAreas() }).catch((error: unknown) => {
      // A failed build is not cached: the next container use tries again (a transient client error), and the switch stays effectively off meanwhile.
      registryPromise = undefined;
      throw error;
    });
    return registryPromise;
  };

  const runtimeFor = (companyId: string): Promise<CoreRuntime> => {
    if (!coreAreaOn(flags, "flow", companyId)) return Promise.reject(new CoreEngineOffError("the flow is not on for this company"));
    let found = runtimes.get(companyId);
    if (found === undefined) {
      found = registry().then((built) => {
        const runtime = createCoreRuntime({ ...options.runtime(built, companyId, flags), registry: built, companyId: companyId, flags });
        const areas = CORE_AREAS.filter((area) => coreAreaOn(flags, area, companyId));
        const gaps = serviceGaps(runtime.services, areas);
        if (gaps.length > 0) throw new Error(`the core runtime lacks services for the areas switched on: ${gaps.join(", ")}`);
        return runtime;
      });
      found.catch(() => runtimes.delete(companyId));
      runtimes.set(companyId, found);
    }
    return found;
  };

  const companiesFor = (area: CoreArea): string[] => {
    const covered = coreCompanies(flags);
    const all = covered === "all" ? [contextOnce().installCompanyId] : [...covered];
    return all.filter((companyId) => coreAreaOn(flags, area, companyId));
  };

  return {
    flags,
    active,
    engineForNewTask: (companyId) => engineForNewTask(flags, companyId),
    // A stamped core task stays on the core after the switch is turned off; reading the stamp never needs the switch.
    engineOfTask: (store, taskId, area) => engineOfStoredTask(store, taskId, area),
    registry,
    runtimeFor,
    async handleScheduledJob(event) {
      if (!isCoreJobEvent(event)) return undefined;
      if (!active) return { skipped: "off" };
      const job = jobs.find((entry) => entry.name === event.job);
      if (job === undefined) return { skipped: "unknown_job" };
      const budgetMs = options.jobBudgetMs ?? 50_000;
      const companies = await runPerCompany(companiesFor(job.area), async (companyId) => await job.run(await runtimeFor(companyId), budgetMs), { rotation: rotation++, budgetMs, nowMs });
      return { job: job.name, companies };
    },
    async relayOutbox(companies) {
      if (!active) return [];
      const relay = jobs.find((entry) => entry.trigger.kind === "stream");
      if (relay === undefined) return [];
      const served = [...new Set(companies)].filter((companyId) => coreAreaOn(flags, relay.area, companyId));
      return await runPerCompany(served, async (companyId) => await relay.run(await runtimeFor(companyId), options.jobBudgetMs ?? 50_000), { rotation: rotation++, budgetMs: options.jobBudgetMs ?? 50_000, nowMs });
    },
  };
}
