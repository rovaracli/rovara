// Test services, slice 1 T2 (design test-services.md 8.1 and DEFERRED TS-IMG-2): which dependencies a task's run starts, pinned from the signed catalog.
//
// The approved environment says WHAT backs a dependency (a catalog id, chosen when it was proposed). This says what the run may start NOW: the catalog entry must be in the signed catalog this release ships, live,
// offered in this edition, and pinned to an image digest; the catalog must be newer than the release's minimum (a rolled-back catalog could pin a digest that was later found critical). Anything else is refused
// with a fixed reason, never a plan that leaves a dependency out (a run with no database would only fail its tests in a confusing way). Pure apart from the catalog source; it never reads a clock, a network or a file itself.
//
// Slice 1 starts real software from the catalog only (backing `local`, no substitute image). Every other backing is "not available yet", at approval (`dependenciesStartableNow`) and again here.
import { loadSignedCatalog, type CatalogEntry, type TaskDependencyPlan, type TestEnvDependency, type TestEnvironmentBody, type VerifiedCatalog, TaskDependencyPlanSchema, TASK_DEPENDENCY_PLAN_MAX, catalogEntryById } from "@agentx/contracts";
import { chooseBacking, effectiveAllowedBackings, type BackingPlace, type SkipReason } from "./backing-choice.js";

/**
 * The oldest catalog revision this release will start images from. Raise it with every catalog release that retires or replaces a pinned digest. It is a constant of the release, not a setting: the broker's
 * environment has no room for another variable, and a rollback of the catalog file must not be a matter of configuration.
 */
export const TEST_SERVICES_MIN_CATALOG_REVISION = 1;

export const DEPENDENCY_PLAN_REFUSALS = ["no_catalog", "catalog_too_old", "not_available_yet", "not_in_catalog", "not_in_edition", "retired", "not_pinned", "not_allowed", "too_many", "invalid"] as const;
export type DependencyPlanRefusal = (typeof DEPENDENCY_PLAN_REFUSALS)[number];
/** What a person reads when a run cannot start its dependencies. Fixed words: no catalog id, digest or error text of any kind. */
export const DEPENDENCY_PLAN_REFUSAL_WORDS: Record<DependencyPlanRefusal, string> = {
  no_catalog: "The service images this run needs could not be checked, so its test services were not started.",
  catalog_too_old: "The service image list is older than this release allows, so test services were not started.",
  not_available_yet: "This project asks for a kind of test service that is not available yet.",
  not_in_catalog: "A test service this project asks for is not in Rovara's image list.",
  not_in_edition: "A test service this project asks for is not offered in this edition.",
  retired: "A test service this project asks for has been retired.",
  not_pinned: "A test service this project asks for has no checked image yet.",
  not_allowed: "A test service this project asks for is not allowed by the company's settings.",
  too_many: "This project asks for more test services than a run starts.",
  invalid: "The plan for this project's test services could not be built.",
};

export type DependencyPlanResult = { ok: true; dependencies: TaskDependencyPlan[] } | { ok: false; reason: DependencyPlanRefusal };

const startableBacking = (backing: { kind: string; substituteImage?: unknown }): boolean => backing.kind === "local" && backing.substituteImage === undefined;

/** Whether every dependency is something slice 1 can start: real software from the catalog (no substitute image), the same while coding, and a fallback of nothing at most. Pure; no catalog needed. */
export function dependenciesStartableNow(dependencies: readonly TestEnvDependency[]): boolean {
  return dependencies.every((dependency) =>
    startableBacking(dependency.backing)
    && (dependency.workingBacking === undefined || (startableBacking(dependency.workingBacking) && sameBacking(dependency.workingBacking, dependency.backing)))
    && (dependency.fallback === undefined || dependency.fallback.kind === "none"));
}

const sameBacking = (left: TestEnvDependency["backing"], right: TestEnvDependency["backing"]): boolean => left.kind === "local" && right.kind === "local" && left.catalogId === right.catalogId;

const REFUSAL_OF_SKIP: Partial<Record<SkipReason, DependencyPlanRefusal>> = {
  not_allowed: "not_allowed", not_in_catalog: "not_in_catalog", not_in_edition: "not_in_edition", retired: "retired", no_such_version: "not_in_catalog", not_pinned: "not_pinned",
};

const majorOf = (entry: CatalogEntry): string => entry.version.split(".")[0] ?? entry.version;

/** One dependency's plan, or the reason it cannot be pinned. */
function planOne(dependency: TestEnvDependency, catalog: VerifiedCatalog, edition: "public" | "enterprise", projectId: string, prodDeny: TestEnvironmentBody["prodDeny"]): { ok: true; plan: unknown } | { ok: false; reason: DependencyPlanRefusal } {
  const backing = dependency.backing;
  if (backing.kind !== "local" || !dependenciesStartableNow([dependency])) return { ok: false, reason: "not_available_yet" };
  const entry = catalogEntryById(catalog, backing.catalogId);
  if (entry === undefined || entry.backing !== "local" || entry.family !== dependency.family) return { ok: false, reason: "not_in_catalog" };
  // The chooser decides allowed / edition / retired / pinned for THIS entry in each place the dependency runs (checks, and the working sandbox), so the rules live in one function.
  for (const place of ["task_check", "working"] as const satisfies readonly BackingPlace[]) {
    const chosen = chooseBacking({
      dependency: { family: dependency.family, kind: dependency.kind, major: majorOf(entry), maintainerChoice: "local" }, place, edition, allowed: effectiveAllowedBackings(undefined),
      catalog: { ...catalog, entries: [entry] }, projectId, projectImages: [], accounts: [], prodDeny, fixtures: [], canMakeFake: false, now: 0,
    });
    if (chosen.backing.kind !== "local") {
      const skipped = chosen.skipped.find((step) => step.step === "local");
      return { ok: false, reason: (skipped === undefined ? undefined : REFUSAL_OF_SKIP[skipped.reason]) ?? "not_available_yet" };
    }
  }
  if (entry.image.digest === undefined) return { ok: false, reason: "not_pinned" };
  return { ok: true, plan: {
    id: dependency.id, name: dependency.name, kind: dependency.kind, family: dependency.family, backing: "local", catalogId: backing.catalogId, repository: entry.image.repository, digest: entry.image.digest,
    config: backing.config, aliases: dependency.connect.hostAliases.length > 0 ? dependency.connect.hostAliases : entry.connect.defaultAliases, connect: dependency.connect.env, seeds: dependency.seeds, reset: dependency.reset,
  } };
}

/**
 * The pinned plans of every dependency of an approved environment, or the first reason one cannot be started. `catalog` is what `serviceCatalogSourceOf` loaded (undefined: it could not be). Never throws.
 */
export function taskDependencyPlansOf(input: { body: TestEnvironmentBody; catalog: VerifiedCatalog | undefined; edition: "public" | "enterprise"; projectId?: string; minCatalogRevision?: number }): DependencyPlanResult {
  try {
    const dependencies = input.body.dependencies ?? [];
    if (dependencies.length > TASK_DEPENDENCY_PLAN_MAX) return { ok: false, reason: "too_many" };
    if (input.catalog === undefined) return { ok: false, reason: "no_catalog" };
    if (input.catalog.revision < (input.minCatalogRevision ?? TEST_SERVICES_MIN_CATALOG_REVISION)) return { ok: false, reason: "catalog_too_old" };
    if (!input.catalog.pinned) return { ok: false, reason: "not_pinned" };
    const plans: TaskDependencyPlan[] = [];
    for (const dependency of dependencies) {
      const one = planOne(dependency, input.catalog, input.edition, input.projectId ?? "", input.body.prodDeny);
      if (!one.ok) return one;
      const parsed = TaskDependencyPlanSchema.safeParse(one.plan);
      if (!parsed.success) return { ok: false, reason: "invalid" };
      plans.push(parsed.data);
    }
    return { ok: true, dependencies: plans };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

// ---- the signed catalog the release ships

/** Where the bytes of the shipped, signed catalog come from (the release's files). The reader is a port: this module reads no file. */
export type ServiceCatalogSource = () => Promise<VerifiedCatalog | undefined>;

/**
 * A catalog source over a reader of the shipped catalog and its signature: it verifies the signature over the exact bytes with the release's trusted keys (`loadSignedCatalog`), refuses a revision under the minimum,
 * and keeps the first good answer for the life of the process. A failure is not kept (the next call tries again) and never says why: undefined. Never throws.
 */
export function serviceCatalogSourceOf(input: { read: () => Promise<{ catalogBytes: Uint8Array; signatureBytes: Uint8Array }>; trustedKeys: readonly string[]; minRevision?: number }): ServiceCatalogSource {
  let kept: VerifiedCatalog | undefined;
  return async () => {
    if (kept !== undefined) return kept;
    try {
      const files = await input.read();
      const loaded = loadSignedCatalog({ catalogBytes: files.catalogBytes, signatureBytes: files.signatureBytes, trustedKeys: input.trustedKeys });
      if (!loaded.ok || loaded.catalog.revision < (input.minRevision ?? TEST_SERVICES_MIN_CATALOG_REVISION)) return undefined;
      kept = loaded.catalog;
      return kept;
    } catch {
      return undefined;
    }
  };
}
