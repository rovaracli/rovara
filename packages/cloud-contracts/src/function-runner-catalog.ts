// Slice 4, lane C1: what the function runner needs from the image catalog and from the worker's boot, written as data and pure rules.
//
// WHAT THE CATALOG HOLDS. The runner runs a function in a gVisor sandbox built from AWS's own Lambda base image for the runtime (`public.ecr.aws/lambda/<runtime>:<tag>-arm64`), with Rovara's static agent binary mounted
// read-only as the entrypoint. Both are catalog images, pinned by digest and mirrored into `rovara-catalog/<env>/svc/<name>` like every other catalog image:
//   lambda-python@3.12, lambda-python@3.13, lambda-nodejs@22, lambda-nodejs@24   AWS base images (linux/arm64 only: workers are arm64; an x86_64 image is a separate lane, X3)
//   function-agent@r1                                                           the agent: a FROM scratch image holding the one static file /agent (lane A1)
// The entries are in `environments/service-catalog/function-runner-entries.json`, UNPINNED (no digest, SBOM or scan), and join `catalog.json` at the next catalog revision, when `catalog-build` pins them. The shipped, signed
// catalog is not touched until then (its signature covers its exact bytes).
//
// WHY THE ENTRIES NEED GUARDS HERE. The vendored catalog schema has no "image only" kind of entry: any new name must be `backing: local`, and `catalogPrepullList` (vendored, Rovara Code's) puts EVERY pinned local entry in
// the pre-pull list and the broker's `isPrepulledEntry` then lets a dependency plan name it. That is wrong for these images (they are never started as a service, and four Lambda images are about 2 GB the boot must not
// pull with the services). So, in Cloud's own code: `functionRunnerPrepullList` and `servicesPrepullList` (made WITHOUT the runner's entries, so the 16-image bound counts services only) split the list in two, the broker refuses a plan that names one of these ids (dependency-plan.ts,
// company-images.ts) and so does the worker (test-services-run.ts). The clean fix is a marker on the entry in Code's contract (owed upstream, see the lane report); until then these guards are the rule.
import { z } from "zod";
import { CatalogIdSchema, PrepullListSchema, catalogImageReference, catalogPrepullList, catalogRepositoryName, type PrepullList, type ServiceCatalog } from "@rovara-code/contracts";

/** The agent's catalog id and repository. */
export const FUNCTION_RUNNER_AGENT_ID = "function-agent@r1";
/** The AWS Lambda runtimes the runner runs (design section 4, phase 1) and the catalog id of the base image each one uses. Another runtime is `Rovara.Unsupported`. */
export const FUNCTION_RUNNER_RUNTIME_IMAGES = {
  "python3.12": "lambda-python@3.12",
  "python3.13": "lambda-python@3.13",
  "nodejs22.x": "lambda-nodejs@22",
  "nodejs24.x": "lambda-nodejs@24",
} as const;
export type FunctionRunnerRuntime = keyof typeof FUNCTION_RUNNER_RUNTIME_IMAGES;
export const FUNCTION_RUNNER_RUNTIMES = Object.keys(FUNCTION_RUNNER_RUNTIME_IMAGES) as [FunctionRunnerRuntime, ...FunctionRunnerRuntime[]];
export const FUNCTION_RUNNER_CATALOG_IDS: readonly string[] = [...Object.values(FUNCTION_RUNNER_RUNTIME_IMAGES), FUNCTION_RUNNER_AGENT_ID].sort();
/** The catalog repositories of those ids (lambda-python 3.12 and 3.13 share one, as postgres 15, 16 and 17 do): the registry repositories the control plane must have before a catalog build can push them. */
export const FUNCTION_RUNNER_REPOSITORIES: readonly string[] = ["svc/function-agent", "svc/lambda-nodejs", "svc/lambda-python"];
/** The only platform these images are pinned for: workers are arm64 (design section 3, x86 addendum). */
export const FUNCTION_RUNNER_PLATFORM = "linux/arm64";
/** At most this many runner images are pulled at boot (4 runtimes and the agent now, with room for provided.al2023, java21, dotnet8 and ruby later). The services' list has its own bound (16): the two never share it. */
export const FUNCTION_RUNNER_PREPULL_MAX_IMAGES = 12;
/** The file in the worker image beside `prepull.json`, made by `catalog-build`. Empty until the entries are pinned. */
export const FUNCTION_RUNNER_PREPULL_FILE = "packages/worker/service-catalog/function-runner-prepull.json";

/**
 * The runner's families (the name part of the catalog id, and the entry's `family`). The rule is the family, not a list of ids: `lambda-` is RESERVED for the runner (a later `lambda-python@3.14` or `lambda-provided@al2023` is a runner
 * image the day it is added, with no change here), and `function-agent` is the agent. A service family can never start with `lambda-`.
 */
export const FUNCTION_RUNNER_FAMILIES = ["function-agent", "lambda-nodejs", "lambda-python"] as const;
export const FUNCTION_RUNNER_FAMILY_PREFIX = "lambda-";
const nameOfId = (catalogId: string): string => (catalogId.includes("@") ? catalogId.slice(0, catalogId.indexOf("@")) : catalogId);
/** Whether a family (or the name part of a catalog id) is the runner's. */
export function isFunctionRunnerFamily(family: string): boolean {
  return (FUNCTION_RUNNER_FAMILIES as readonly string[]).includes(family) || family.startsWith(FUNCTION_RUNNER_FAMILY_PREFIX);
}
/** Whether a repository (`svc/lambda-python`) is the runner's: one of its three, or any `svc/lambda-*`. */
export function isFunctionRunnerRepository(repository: string): boolean {
  return FUNCTION_RUNNER_REPOSITORIES.includes(repository) || repository.startsWith(`svc/${FUNCTION_RUNNER_FAMILY_PREFIX}`);
}

/** Whether a catalog id is one of the runner's images (by its family, so an id added later is covered). Such an id is never a dependency a plan may start and never in the services pre-pull list. */
export function isFunctionRunnerCatalogId(catalogId: string): boolean {
  return isFunctionRunnerFamily(nameOfId(catalogId));
}

/** Whether a catalog ENTRY is the runner's: by its id, its family or its repository, any one of the three. Every guard asks this of the entry when it has one. */
export function isFunctionRunnerEntry(entry: { id: string; family: string; image: { repository: string } }): boolean {
  return isFunctionRunnerCatalogId(entry.id) || isFunctionRunnerFamily(entry.family) || isFunctionRunnerRepository(entry.image.repository);
}

/** The runner pre-pull list: the same shape as the services one (a repository and a digest per image, never a tag), arm64 only, only runner ids, and a smaller bound. */
export const FunctionRunnerPrepullListSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogRevision: z.number().int().min(1),
    images: PrepullListSchema.shape.images.element.array().max(FUNCTION_RUNNER_PREPULL_MAX_IMAGES),
  })
  .strict()
  .superRefine((list, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    const ids = list.images.map((image) => image.id);
    if (new Set(ids).size !== ids.length) problem(["images"], "an id is listed once");
    list.images.forEach((image, index) => {
      if (image.platforms.length !== 1 || image.platforms[0] !== FUNCTION_RUNNER_PLATFORM) problem(["images", index, "platforms"], "the runner's images are linux/arm64 only");
      // A runner id (by family) lives in `svc/<its family>`; any other id is listed only when it is in one of the runner's repositories (an entry the guards took for a runner's by its repository).
      if (isFunctionRunnerCatalogId(image.id) ? image.repository !== runnerRepositoryOf(image.id) : !isFunctionRunnerRepository(image.repository)) problem(["images", index, "repository"], "only the function runner's images, in the repository their id has, are listed here");
    });
  });
export type FunctionRunnerPrepullList = z.infer<typeof FunctionRunnerPrepullListSchema>;

/** `lambda-python@3.12` is in `svc/lambda-python`. */
function runnerRepositoryOf(catalogId: string): string {
  return `svc/${CatalogIdSchema.parse(catalogId).slice(0, catalogId.indexOf("@"))}`;
}

/** The pinned runner images of a catalog, sorted by id. An unpinned catalog, or one that does not hold them yet, gives the empty list. Retired entries and entries with no digest are left out. */
export function functionRunnerPrepullList(catalog: ServiceCatalog): FunctionRunnerPrepullList {
  const images = catalog.entries
    .filter((entry) => catalog.pinned && entry.status !== "retired" && entry.image.digest !== undefined && isFunctionRunnerEntry(entry))
    .map((entry) => ({ id: entry.id, repository: entry.image.repository, digest: entry.image.digest as string, platforms: [...entry.image.platforms] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return FunctionRunnerPrepullListSchema.parse({ schemaVersion: 1, catalogRevision: catalog.revision, images });
}

/**
 * The services pre-pull list of a catalog, made WITHOUT the runner's entries. The vendored `catalogPrepullList` holds every pinned local entry and refuses a list of more than 16 images, so taking the runner's images out of its
 * RESULT would be too late (10 services and 7 runner images already throw, and the broker's try/catch would then turn every service off). The entries are taken out first, so the 16 bound counts services only.
 */
export function servicesPrepullList(catalog: ServiceCatalog): PrepullList {
  return catalogPrepullList({ ...catalog, entries: catalog.entries.filter((entry) => !isFunctionRunnerEntry(entry)) });
}

/**
 * The digest reference of the base image for a runtime, or undefined when the runtime is not one the runner runs or the list has no pinned image for it. Always `<registry>/<repository>@sha256:<digest>`: no tag can be built.
 */
export function functionRunnerImageReference(list: FunctionRunnerPrepullList, runtime: string, install: { registry: string; env: string }): string | undefined {
  const id = (FUNCTION_RUNNER_RUNTIME_IMAGES as Record<string, string | undefined>)[runtime];
  if (id === undefined) return undefined;
  const image = FunctionRunnerPrepullListSchema.parse(list).images.find((candidate) => candidate.id === id);
  return image === undefined ? undefined : catalogImageReference({ registry: install.registry, repositoryName: catalogRepositoryName(install.env, image.repository), digest: image.digest });
}

// ---- gVisor (runsc), installed by boot-stage2.sh

/**
 * The pinned gVisor release the boot installs. A DATED release (the `latest` path 404s), by the sha512 of the exact archive for the machine's architecture. The hashes are written here AND in boot-stage2.sh (the script
 * cannot import them: it runs from the worker image before anything else does); a test holds the two equal. The aarch64 hash was taken from a full download and equals the one Google publishes beside it; the x86_64 one is
 * the published `.sha512` (nothing runs on x86_64 workers yet). A new release is a change to both places and to the live proof (F7), never a runtime lookup.
 */
export const FUNCTION_RUNNER_GVISOR = {
  release: "20261109.0",
  baseUrl: "https://storage.googleapis.com/gvisor/releases/release/20261109.0",
  archive: "gvisor.tar.bz2",
  sha512: {
    aarch64: "411f2d6f7f98a93643725ce9933ff67a7f96f884c2317be3e2b579b976ceb54065bd1d4292a9d61de38da1940ef21b7e41070127874086b7992fb7b5e7a85897",
    x86_64: "1a6b8f74c37b4931ef473f67ec1f601690855bedc52ac709f2fac965c69677aa0426ef44598d8eee1aed72cfdb9df87a2a5f352cb3348880fc61a7732bc10f2a",
  },
  /** The runtime name Docker is given (`--runtime runsc`): the sandbox spec's `SANDBOX_RUNTIME`. */
  dockerRuntime: "runsc",
} as const;

/** Where the boot installs the agent on the host (root-owned): the sandbox mounts it read-only at /rovara/agent. */
export const FUNCTION_RUNNER_AGENT_HOST_PATH = "/opt/rovara/function-runner/agent";
/** The worker environment names boot-stage2.sh writes (root-only /etc/agentx/worker.env): readiness, and the paths the worker uses. */
export const FUNCTION_RUNNER_ENVIRONMENT = {
  state: "AGENTX_FUNCTION_RUNNER",
  reason: "AGENTX_FUNCTION_RUNNER_REASON",
  runtime: "AGENTX_FUNCTION_RUNNER_RUNTIME",
  agent: "AGENTX_FUNCTION_RUNNER_AGENT",
} as const;
/** The fixed reasons boot gives when the runner is not offered on a worker: never a command's own text. */
export const FUNCTION_RUNNER_UNAVAILABLE_REASONS = ["runtime-install-failed", "runtime-not-registered", "runtime-smoke-failed", "images-not-pulled", "disk-too-low", "agent-unavailable", "arch-not-supported"] as const;
export type FunctionRunnerUnavailableReason = (typeof FUNCTION_RUNNER_UNAVAILABLE_REASONS)[number];
