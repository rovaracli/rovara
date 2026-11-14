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
import { isCoreJobEvent, jobsOfHost, runPerCompany, type CompanyRunReport, type CoreJob, type CoreJobHost } from "./jobs.js";
import { buildCloudRegistry, type CloudAdapterContext, type CloudAdapterModule } from "./registry.js";

export interface CloudAppOptions {
  env?: NodeJS.ProcessEnv;
  /** The adapters (cloud-modules.ts in production; fakes in tests). A function is called when the registry is first built, so a deployment's inputs are asked for only then. */
  modules: readonly CloudAdapterModule[] | (() => readonly CloudAdapterModule[]);
  /**
   * The switch gates NEW tasks only (decision 130: a task keeps its engine). With this on, the root also serves the tasks the core already holds while the switch is off or narrowed: it builds
   * the whole registry (every area's points) and a runtime for any company on request (`runtimeFor`), and runs the jobs for the install's company (`installCompanyId`) and for every company that holds core tasks (`servedCompanies`). `active` still says whether
   * a new task may start on the core. Default off: with every switch off the root builds nothing.
   */
  serveStamped?: boolean;
  /** The companies that hold core tasks (`serveStamped`): every company with an in-use mark, listed. The jobs run for these as well as the install's company. Absent: the install's company only. */
  servedCompanies?: () => Promise<readonly string[]>;
  /** Builds the adapter context (clients) on first use. */
  context: () => CloudAdapterContext;
  /** The per-company runtime's own wiring (signing key, access, credentials, services). */
  runtime: (registry: AdapterRegistry, companyId: OrgId, flags: CoreEngineFlags) => Omit<CoreRuntimeOptions, "registry" | "companyId" | "flags">;
  /** The jobs this root runs. Default: the host's rows of CORE_JOBS (`host`). */
  jobs?: readonly CoreJob[];
  /** Which function this root runs in: the broker (default) or the tier pass's own function. Another host's job is answered `unknown_job` and never run. */
  host?: CoreJobHost;
  /** The time budget of one scheduled run. Default 50 s (a schedule's Lambda has 60). Never more than the function's own time left (`handleScheduledJob`'s `remainingMs`) less `JOB_EXIT_MARGIN_MS`. */
  jobBudgetMs?: number;
  nowMs?: () => number;
}

export interface CloudApp {
  readonly flags: CoreEngineFlags;
  /** Whether any switch is on, that is, whether a NEW task may start on the core. False with `serveStamped` off: nothing below builds anything. */
  readonly active: boolean;
  /** Whether the root serves tasks the core already holds even when no switch is on (`serveStamped`). */
  readonly serveStamped: boolean;
  engineForNewTask(companyId: string): Engine;
  engineOfTask(store: Parameters<typeof engineOfStoredTask>[0], taskId: string, area: CoreArea): Promise<Engine>;
  /** The sealed registry (built once). Throws when no switch is on: an off install never builds it. */
  registry(): Promise<AdapterRegistry>;
  /** The core for one company (built once). Throws when the flow is not switched on for it. */
  runtimeFor(companyId: string): Promise<CoreRuntime>;
  /** An EventBridge event: `undefined` when it is not a core job's; `{ skipped: "off" }` while off. `remainingMs`: the function's time left (Lambda's `getRemainingTimeInMillis`), which caps the budget. */
  handleScheduledJob(event: unknown, options?: { remainingMs?: number | undefined }): Promise<undefined | { skipped: "off" | "unknown_job" } | { job: string; companies: CompanyRunReport[] }>;
  /** The stream reader's hook: relay the outbox of these companies (those not switched on are skipped). */
  relayOutbox(companies: readonly string[]): Promise<CompanyRunReport[]>;
}

/** What a scheduled run leaves of its function's time for the run's own end (logging, the answer): its budget is the time left less this. */
export const JOB_EXIT_MARGIN_MS = 20_000;

export class CoreEngineOffError extends Error {
  constructor(what: string) {
    super(`the core engine is off: ${what}`);
    this.name = "CoreEngineOffError";
  }
}

export function createCloudApp(options: CloudAppOptions): CloudApp {
  const flags = readCoreEngineFlags(options.env ?? process.env);
  const active = anyCoreAreaOn(flags);
  const serveStamped = options.serveStamped === true;
  const serving = active || serveStamped;
  const jobs = options.jobs ?? jobsOfHost(options.host ?? "broker");
  const nowMs = options.nowMs ?? Date.now;
  let context: CloudAdapterContext | undefined;
  let registryPromise: Promise<AdapterRegistry> | undefined;
  const runtimes = new Map<string, Promise<CoreRuntime>>();
  let rotation = 0;

  const contextOnce = (): CloudAdapterContext => (context ??= options.context());
  // The areas some company may have on: their points must all be filled.
  const switchedAreas = (): CoreArea[] => (serveStamped ? [...CORE_AREAS] : CORE_AREAS.filter((area) => flags.areas[area]?.mode !== "off"));
  const modulesOf = (): readonly CloudAdapterModule[] => (typeof options.modules === "function" ? options.modules() : options.modules);

  const registry = (): Promise<AdapterRegistry> => {
    if (!serving) return Promise.reject(new CoreEngineOffError("no registry is built"));
    registryPromise ??= Promise.resolve().then(() => modulesOf()).then((modules) => buildCloudRegistry({ modules, context: contextOnce(), areas: switchedAreas() })).catch((error: unknown) => {
      // A failed build is not cached: the next container use tries again (a transient client error), and the switch stays effectively off meanwhile.
      registryPromise = undefined;
      throw error;
    });
    return registryPromise;
  };

  const runtimeFor = (companyId: string): Promise<CoreRuntime> => {
    if (!serveStamped && !coreAreaOn(flags, "flow", companyId)) return Promise.reject(new CoreEngineOffError("the flow is not on for this company"));
    let found = runtimes.get(companyId);
    if (found === undefined) {
      found = registry().then((built) => {
        const runtime = createCoreRuntime({ ...options.runtime(built, companyId, flags), registry: built, companyId: companyId, flags });
        // Only an area the switch has ON for this company must have its services: a gap in an area that is off (one this container serves only for the stamped tasks it still holds) costs that
        // area its jobs (`service_not_wired`), never the company's whole runtime, so a task of another area keeps being served.
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

  const companiesFor = async (area: CoreArea): Promise<string[]> => {
    const covered = coreCompanies(flags);
    const all = covered === "all" ? [contextOnce().installCompanyId] : [...covered];
    // Serving stamped tasks: the install's company, and every company that holds core tasks, is served (the core's tasks of a company the switch no longer names still need their sweeps).
    if (serveStamped) return [...new Set([...all, contextOnce().installCompanyId, ...(await options.servedCompanies?.() ?? [])])];
    return all.filter((companyId) => coreAreaOn(flags, area, companyId));
  };

  return {
    flags,
    active,
    serveStamped,
    engineForNewTask: (companyId) => engineForNewTask(flags, companyId),
    // A stamped core task stays on the core after the switch is turned off; reading the stamp never needs the switch.
    engineOfTask: (store, taskId, area) => engineOfStoredTask(store, taskId, area),
    registry,
    runtimeFor,
    async handleScheduledJob(event, run) {
      if (!isCoreJobEvent(event)) return undefined;
      if (!serving) return { skipped: "off" };
      const job = jobs.find((entry) => entry.name === event.job);
      if (job === undefined) return { skipped: "unknown_job" };
      const configured = options.jobBudgetMs ?? 50_000;
      const budgetMs = Math.max(0, run?.remainingMs === undefined ? configured : Math.min(configured, run.remainingMs - JOB_EXIT_MARGIN_MS));
      // Each company's job is given what is left of the run's budget when its turn comes (a tier pass that started late can never plan past the function's end).
      const companies = await runPerCompany(await companiesFor(job.area), async (companyId, leftMs) => {
        const asked = nowMs();
        const runtime = await runtimeFor(companyId);
        return await job.run(runtime, Math.max(0, leftMs - (nowMs() - asked)));
      }, { rotation: rotation++, budgetMs, nowMs });
      return { job: job.name, companies };
    },
    async relayOutbox(companies) {
      if (!serving) return [];
      const relay = jobs.find((entry) => entry.trigger.kind === "stream");
      if (relay === undefined) return [];
      const served = [...new Set(companies)].filter((companyId) => serveStamped || coreAreaOn(flags, relay.area, companyId));
      return await runPerCompany(served, async (companyId) => await relay.run(await runtimeFor(companyId), options.jobBudgetMs ?? 50_000), { rotation: rotation++, budgetMs: options.jobBudgetMs ?? 50_000, nowMs });
    },
  };
}
