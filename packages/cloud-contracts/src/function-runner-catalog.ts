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
// pull with the services). So, in Cloud's own code: `functionRunnerPrepullList` and `withoutFunctionRunner` split the list in two, the broker refuses a plan that names one of these ids (dependency-plan.ts,
// company-images.ts) and so does the worker (test-services-run.ts). The clean fix is a marker on the entry in Code's contract (owed upstream, see the lane report); until then these guards are the rule.
import { z } from "zod";
import { CatalogIdSchema, PrepullListSchema, catalogImageReference, catalogRepositoryName, type PrepullList, type ServiceCatalog } from "@rovara-code/contracts";

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
export const FUNCTION_RUNNER_RUNTIMES = Object.keys(FUNCTION_RUNNER_RUNTIME_IMAGES) as FunctionRunnerRuntime[];
export const FUNCTION_RUNNER_CATALOG_IDS: readonly string[] = [...Object.values(FUNCTION_RUNNER_RUNTIME_IMAGES), FUNCTION_RUNNER_AGENT_ID].sort();
/** The catalog repositories of those ids (lambda-python 3.12 and 3.13 share one, as postgres 15, 16 and 17 do): the registry repositories the control plane must have before a catalog build can push them. */
export const FUNCTION_RUNNER_REPOSITORIES: readonly string[] = ["svc/function-agent", "svc/lambda-nodejs", "svc/lambda-python"];
/** The only platform these images are pinned for: workers are arm64 (design section 3, x86 addendum). */
export const FUNCTION_RUNNER_PLATFORM = "linux/arm64";
/** At most this many runner images are pulled at boot (4 runtimes and the agent, with room for provided.al2023 and java21 later). */
export const FUNCTION_RUNNER_PREPULL_MAX_IMAGES = 8;
/** The file in the worker image beside `prepull.json`, made by `catalog-build`. Empty until the entries are pinned. */
export const FUNCTION_RUNNER_PREPULL_FILE = "packages/worker/service-catalog/function-runner-prepull.json";

/** Whether a catalog id is one of the runner's images. Such an id is never a dependency a plan may start and never in the services pre-pull list. */
export function isFunctionRunnerCatalogId(catalogId: string): boolean {
  return FUNCTION_RUNNER_CATALOG_IDS.includes(catalogId);
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
      if (!isFunctionRunnerCatalogId(image.id)) problem(["images", index, "id"], "only the function runner's images are listed here");
      if (image.platforms.length !== 1 || image.platforms[0] !== FUNCTION_RUNNER_PLATFORM) problem(["images", index, "platforms"], "the runner's images are linux/arm64 only");
      if (image.repository !== runnerRepositoryOf(image.id)) problem(["images", index, "repository"], "the repository is the one this id has");
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
    .filter((entry) => catalog.pinned && entry.status !== "retired" && entry.image.digest !== undefined && isFunctionRunnerCatalogId(entry.id))
    .map((entry) => ({ id: entry.id, repository: entry.image.repository, digest: entry.image.digest as string, platforms: [...entry.image.platforms] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return FunctionRunnerPrepullListSchema.parse({ schemaVersion: 1, catalogRevision: catalog.revision, images });
}

/** The services pre-pull list with the runner's images taken out (`catalogPrepullList` includes every pinned local entry): what `prepull.json` holds, so the services boot step never pulls a Lambda image. */
export function withoutFunctionRunner(list: PrepullList): PrepullList {
  return PrepullListSchema.parse({ ...list, images: list.images.filter((image) => !isFunctionRunnerCatalogId(image.id)) });
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
