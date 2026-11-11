// Company-approved images, the worker's pull (test services, switch `pj`). A company image is NOT one of the digests baked into the worker image and pulled by root at boot: an admin approved it later, and the broker
// copied it (the mirror) into a private repository of THIS install's registry. So the worker pulls it, right before its services start, from that repository and nowhere else:
//   - the reference is `<this install's registry>/<mirror repository>@sha256:<approved digest>`, built from the plan and checked here: the registry is the worker's own, the repository is one of this environment's saved-environment-shaped
//     repositories, the digest is 64 hex. A tag is never used, and the worker never contacts the source registry (worker egress is unchanged);
//   - the login comes from the broker (`company-image-login`, which re-checks the approval, the registry list and the copy NOW) for that one repository, and is held to the same reference: another registry or repository, or one that
//     is about to expire, is refused. It is written to a throwaway Docker config in the run's own tmpfs directory, used for one `docker pull`, and removed in every case. It is never logged and never in an error;
//   - after the pull, `RepoDigests` must name exactly the reference. An image that does not is removed from the host and refused.
// Every refusal is the fixed `pull_failed` for the dependency (the same words as an image that is not on this worker); the callers never see a registry's, a login's or Docker's text.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompanyImageLoginReplySchema, isSavedEnvRepositoryName, savedEnvRepositoryPrefix, type SavedEnvRegistryAuth } from "@agentx/contracts";
import type { DockerCli } from "./swebench/containers.js";

/** The worker's call to the broker's `company-image-login` (callback-client.ts): `{ imageId }` in, the broker's raw answer out. */
export type CompanyImageLoginCallback = (body: { imageId: string }) => Promise<unknown>;

export interface CompanyImageTarget { dependencyId: string; imageId: string; reference: string; repository: string }

const PULL_TIMEOUT_MS = 10 * 60_000;
const QUICK_MS = 60_000;
/** A login with less than this left is not used: the pull could outlive it. */
const LOGIN_MIN_REMAINING_MS = 60_000;
const DIGEST = /^[a-f0-9]{64}$/u;

/**
 * The reference a company image is pulled by, or undefined when the plan's mirror is not one this worker may pull: the repository must be of THIS environment's saved-environment family (`rovara-env/<env>/...`, the shape
 * the broker's names have), the digest 64 hex, and the registry the worker's own.
 */
export function companyImageReference(input: { registry: string; catalogEnv: string; repository: string; digest: string }): string | undefined {
  try {
    if (!isSavedEnvRepositoryName(input.repository) || !input.repository.startsWith(`${savedEnvRepositoryPrefix(input.catalogEnv)}/`) || !DIGEST.test(input.digest)) return undefined;
  } catch {
    return undefined;
  }
  return `${input.registry}/${input.repository}@sha256:${input.digest}`;
}

const parsedDigests = (stdout: string): readonly string[] | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Pulls every company image that is not on this host yet. Returns the dependency ids that could not be made available (empty: all are here). Never throws; never exposes a login. */
export async function pullCompanyImages(input: {
  docker: DockerCli; registry: string; targets: readonly CompanyImageTarget[]; login: CompanyImageLoginCallback | undefined; tempParent: string; signal?: AbortSignal | undefined; now?: () => number;
}): Promise<ReadonlySet<string>> {
  const failed = new Set<string>();
  const now = input.now ?? Date.now;
  const docker = input.docker;
  const run = (args: readonly string[], timeoutMs: number) => docker.run(args, { timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }) }).catch(() => undefined);
  const here = async (reference: string): Promise<boolean> => {
    const inspected = await run(["image", "inspect", "--format", "{{json .RepoDigests}}", reference], QUICK_MS);
    return inspected !== undefined && inspected.exitCode === 0 && (parsedDigests(inspected.stdout)?.includes(reference) ?? false);
  };
  for (const target of input.targets) {
    if (input.signal?.aborted === true) { failed.add(target.dependencyId); continue; }
    if (await here(target.reference)) continue;
    if (input.login === undefined) { failed.add(target.dependencyId); continue; }
    let auth: SavedEnvRegistryAuth | undefined;
    try {
      const raw = await input.login({ imageId: target.imageId });
      const bare = typeof raw === "object" && raw !== null ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "requestId")) : raw;
      const parsed = CompanyImageLoginReplySchema.safeParse(bare);
      if (parsed.success) auth = parsed.data.login;
    } catch { /* refused or unreachable: the image is not available */ }
    // The login must be for exactly this registry and repository, and have time left.
    if (auth === undefined || auth.registry !== input.registry || auth.repository !== target.repository || Date.parse(auth.expiresAt) - now() < LOGIN_MIN_REMAINING_MS) { failed.add(target.dependencyId); continue; }
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(input.tempParent, "company-image-login-"));
      await writeFile(join(directory, "config.json"), JSON.stringify({ auths: { [auth.registry]: { auth: Buffer.from(`${auth.username}:${auth.password}`).toString("base64") } } }), { mode: 0o600 });
      const pulled = await run(["--config", directory, "pull", target.reference], PULL_TIMEOUT_MS);
      if (pulled === undefined || pulled.exitCode !== 0) { failed.add(target.dependencyId); continue; }
    } catch {
      failed.add(target.dependencyId);
      continue;
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    // The pulled image must be exactly the reference; anything else is taken off the host.
    if (!(await here(target.reference))) {
      await run(["image", "rm", "--force", target.reference], QUICK_MS);
      failed.add(target.dependencyId);
    }
  }
  return failed;
}
