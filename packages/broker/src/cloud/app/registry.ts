// Convergence S0: the adapter registry Cloud runs Rovara Code's core on (convergence plan section 2; Code's counterpart is `Kb/local/app/`).
//
// Each Cloud adapter is a `CloudAdapterModule`: the point it fills, its name, and a `create` that builds it from the context (AWS clients, the table
// name, the clock). The adapter lanes (A1-A9) wrote the adapters; this file only joins them. Modules are a list, so a new point or a second adapter is
// one more entry, and a test can build the same registry over fakes (tests/parity uses exactly that).
//
// Rules held here:
//  - Build once per Lambda container (cold start), never per request, and only when a switch is on (app.ts). With every switch off nothing is built.
//  - Every point the switched areas need must be filled, or the registry is refused with the list of what is missing (never a half-wired core).
//  - The `storage` adapter is wrapped with Cloud's retention rule (retention.ts, decision 74) before anything else sees it.
//  - The `audit-sink` must drop a malformed event with a log line, not throw it into a task's transaction (A7 note: the root passes onInvalid "skip").
//  - The registry is sealed before it is handed out: after that only channel adapters may change (Code's rule).
import { createAdapterRegistry } from "@rovara-code/broker/ports";
import type { AdapterOf, AdapterRegistry, PluginPoint } from "@rovara-code/contracts";
import type { CoreArea } from "./flags.js";
import { cloudRetentionStore, type RetentionLog } from "./retention.js";

/** What every Cloud adapter module may use to build itself. Production fills it from the Lambda's environment; tests from fakes. */
export interface CloudAdapterContext {
  /** The install's company (an install has one, ruling R3); adapters still take the company from each call. */
  installCompanyId: string;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  /** Named clients or fakes (a DynamoDB client, an SQS client, ...). Each module reads only the ones it names. */
  clients: Readonly<Record<string, unknown>>;
  log: (entry: Record<string, unknown>) => void;
}

export interface CloudAdapterModule<P extends PluginPoint = PluginPoint> {
  readonly point: P;
  readonly name: string;
  /** The lane that owns the adapter (shown when a point is missing). */
  readonly lane: string;
  /** Code's default for the point, replaced by a configured adapter of the same point. */
  readonly isDefault?: boolean;
  create(context: CloudAdapterContext, registry: Pick<AdapterRegistry, "get" | "require" | "names">): AdapterOf<P> | Promise<AdapterOf<P>>;
}

export function cloudAdapter<P extends PluginPoint>(module: CloudAdapterModule<P>): CloudAdapterModule<P> {
  return module;
}

/** The points each switched area needs filled (the core's own `createTaskFlowFromRegistry`, build step and merge tracking read these). */
export const POINTS_BY_AREA: Readonly<Record<CoreArea, readonly PluginPoint[]>> = {
  flow: ["storage", "queue", "worker-machines", "admission", "audit-sink", "approvers", "identity", "metering"],
  build: ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "model-keys", "secrets"],
  merge: ["storage", "code-host", "approvers", "audit-sink"],
};

/** Points that must hold Cloud's adapter, never Code's default (money, authority, audit: plan section 5). A default there is refused. */
export const NEVER_DEFAULT: ReadonlySet<PluginPoint> = new Set<PluginPoint>(["admission", "approvers", "identity", "audit-sink", "metering", "storage", "queue"]);

export class CloudRegistryError extends Error {
  constructor(readonly missing: readonly { point: PluginPoint; areas: readonly CoreArea[] }[], readonly defaulted: readonly PluginPoint[]) {
    super(`the core registry is not complete: ${[...missing.map((entry) => `${entry.point} (needed by ${entry.areas.join(", ")})`), ...defaulted.map((point) => `${point} is Code's default`)].join("; ")}`);
    this.name = "CloudRegistryError";
  }
}

export interface BuildRegistryOptions {
  modules: readonly CloudAdapterModule[];
  context: CloudAdapterContext;
  /** The areas this install may switch on: their points must be filled. */
  areas: readonly CoreArea[];
  retentionLog?: RetentionLog;
}

/** What is missing for these areas, as a report (an empty report means the registry can serve them). */
export function registryGaps(registry: Pick<AdapterRegistry, "names">, defaults: ReadonlySet<PluginPoint>, areas: readonly CoreArea[]): { missing: { point: PluginPoint; areas: CoreArea[] }[]; defaulted: PluginPoint[] } {
  const needed = new Map<PluginPoint, CoreArea[]>();
  for (const area of areas) for (const point of POINTS_BY_AREA[area]) needed.set(point, [...(needed.get(point) ?? []), area]);
  const missing = [...needed].filter(([point]) => registry.names(point).length === 0).map(([point, by]) => ({ point, areas: by }));
  const defaulted = [...needed.keys()].filter((point) => NEVER_DEFAULT.has(point) && defaults.has(point));
  return { missing, defaulted };
}

/**
 * Builds and seals the registry. Modules are created in order, so a module may read an adapter an earlier one registered (the queue reads the store).
 * Throws `CloudRegistryError` when a needed point is empty or holds only Code's default where Cloud's own is required.
 */
export async function buildCloudRegistry(options: BuildRegistryOptions): Promise<AdapterRegistry> {
  const registry = createAdapterRegistry();
  const defaults = new Set<PluginPoint>();
  for (const module of options.modules) {
    let adapter: unknown = await module.create(options.context, registry);
    if (module.point === "storage") adapter = cloudRetentionStore(adapter as AdapterOf<"storage">, options.retentionLog);
    registry.register(module.point, module.name, adapter as never, module.isDefault === true ? { isDefault: true } : {});
    // A configured adapter replaces a default of the point; the point then no longer counts as defaulted.
    if (module.isDefault === true) { if (!registry.names(module.point).some((name) => name !== module.name)) defaults.add(module.point); } else defaults.delete(module.point);
  }
  const gaps = registryGaps(registry, defaults, options.areas);
  if (gaps.missing.length > 0 || gaps.defaulted.length > 0) throw new CloudRegistryError(gaps.missing, gaps.defaulted);
  registry.seal();
  return registry;
}
