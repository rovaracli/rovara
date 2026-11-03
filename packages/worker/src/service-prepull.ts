// Test services, TS19: the worker's pre-pull of catalog images.
//
// The list of what to pull ahead is DATA in the worker image (`service-catalog/prepull.json`, made from the pinned catalog by `scripts/catalog-build.ts`), not a line in EC2 user data or in boot-stage2.sh: boot.sh is at
// its size limit, and the image is already digest-pinned and its stage 2 hash checked. The file names a repository and a digest for each image and nothing else; the registry host is the install's and is given when
// the pull runs. Every reference built here is `<registry>/<repository>@sha256:<digest>`: no tag can be pulled.
//
// The pre-pull is an optimisation and never a requirement: it is bounded (a count, a time budget), an image that fails is reported and skipped, and nothing here throws. A run that needs an image that was not pulled
// ahead pulls it itself, by the same digest, through the service runner (TS17).
//
// Wiring pending: the caller (the worker's start, after the service runner exists) gives the registry host and a `pull` that runs `docker pull <reference>`; nothing calls this yet.
import { readFile } from "node:fs/promises";
import { PREPULL_MAX_IMAGES, PrepullListSchema, catalogImageReference, catalogRepositoryName, type PrepullList } from "@agentx/contracts";

/** The list shipped in the worker image, beside `dist/` (the same relative place from `src/` and from `dist/`). */
export const PREPULL_LIST_URL = new URL("../service-catalog/prepull.json", import.meta.url);
export const PREPULL_LIST_MAX_BYTES = 64 * 1024;
export const PREPULL_DEFAULT_BUDGET_MS = 5 * 60 * 1000;
export const EMPTY_PREPULL_LIST: PrepullList = { schemaVersion: 1, catalogRevision: 1, images: [] };

/** Reads and checks the shipped list. A file that is not there is the empty list (nothing pinned yet); one that is there and invalid throws, so a bad release is seen and not skipped. */
export async function loadPrepullList(file: URL | string = PREPULL_LIST_URL): Promise<PrepullList> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_PREPULL_LIST;
    throw error;
  }
  if (Buffer.byteLength(text) > PREPULL_LIST_MAX_BYTES) throw new Error("the service pre-pull list is too large");
  return PrepullListSchema.parse(JSON.parse(text));
}

/** The digest references of a list in the order they are pulled. `registry` is the install's registry host; `env` the named environment. */
export function prepullReferences(list: PrepullList, input: { registry: string; env: string }): Array<{ id: string; reference: string }> {
  return PrepullListSchema.parse(list).images.map((image) => ({
    id: image.id,
    reference: catalogImageReference({ registry: input.registry, repositoryName: catalogRepositoryName(input.env, image.repository), digest: image.digest }),
  }));
}

export interface PrepullPorts {
  /** Pulls one digest reference. May throw. */
  pull: (reference: string) => Promise<void>;
  /** Whether the host already holds the reference (a pull is skipped then). */
  present?: (reference: string) => Promise<boolean>;
  now?: () => number;
}

export interface PrepullResult {
  readonly pulled: string[];
  readonly alreadyPresent: string[];
  readonly failed: Array<{ id: string; reason: string }>;
  /** Ids not tried because the time budget ended first. */
  readonly skipped: string[];
}

/** Pulls the list one image at a time inside a time budget. Never throws; the result says what happened to each image. */
export async function prepullCatalogImages(input: { list: PrepullList; registry: string; env: string; ports: PrepullPorts; budgetMs?: number }): Promise<PrepullResult> {
  const result: { pulled: string[]; alreadyPresent: string[]; failed: Array<{ id: string; reason: string }>; skipped: string[] } = { pulled: [], alreadyPresent: [], failed: [], skipped: [] };
  const now = input.ports.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? PREPULL_DEFAULT_BUDGET_MS);
  let references: Array<{ id: string; reference: string }>;
  try {
    references = prepullReferences(input.list, { registry: input.registry, env: input.env }).slice(0, PREPULL_MAX_IMAGES);
  } catch (error) {
    // A list or a registry that does not parse pulls nothing; the first run pulls what it needs.
    return { ...result, failed: [{ id: "*", reason: error instanceof Error ? error.message.slice(0, 200) : "invalid list" }] };
  }
  for (const [index, { id, reference }] of references.entries()) {
    if (now() >= deadline) {
      result.skipped.push(...references.slice(index).map((rest) => rest.id));
      break;
    }
    try {
      if (input.ports.present !== undefined && (await input.ports.present(reference))) {
        result.alreadyPresent.push(id);
        continue;
      }
      await input.ports.pull(reference);
      result.pulled.push(id);
    } catch (error) {
      result.failed.push({ id, reason: error instanceof Error ? error.message.slice(0, 200) : "pull failed" });
    }
  }
  return result;
}
