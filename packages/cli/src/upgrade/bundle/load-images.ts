// Enterprise foundations, task N3: loads a verified bundle's images into the install's own ECR, digests preserved (skopeo copies every platform without
// re-encoding), so the signed manifest's hash is the hash the task runs. The registry credential comes from ECR and is kept out of the displayed
// command and out of any error text. Each image is checked in the registry by digest afterwards.
import { BatchGetImageCommand } from "@aws-sdk/client-ecr";
import { BUNDLE_IMAGE_REPOSITORY_PREFIX, agentXError } from "@agentx/contracts";
import type { CommandRunner } from "../../deploy/cdk-engine.js";
import type { VerifiedBundle } from "./verify.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { openOwnRegistryAuth } from "./registry-auth.js";

export interface LoadBundleImagesInput {
  bundle: VerifiedBundle;
  env: string;
  /** The install's account and region: the registry must be exactly this one. */
  account: string;
  region: string;
  ecr: { send(command: unknown): Promise<unknown> };
  runner: CommandRunner;
  /** Names of images that are skipped, without an error, where their repository does not exist. */
  skipWhenNoRepository?: readonly string[];
}

/**
 * Bundle images whose repository exists only in some installs. The embedder's repository is made by the access stack only where the Team record is built (infra/lib/app.ts); an install
 * without the record has none, and its image is simply not loaded (the bundle carries it for the installs that have the record). The caller says which images may be skipped
 * (`skipWhenNoRepository`): for the embedder, only when the install does not record the Team record as on. Every other missing repository is an error.
 */
export const EMBEDDER_BUNDLE_IMAGE_NAME = "embedder";

const digestOf = (reference: string): string => /@(sha256:[a-f0-9]{64})$/.exec(reference)?.[1] as string;

export async function loadBundleImages(input: LoadBundleImagesInput): Promise<void> {
  const { bundle, env, account, region, ecr, runner } = input;
  const { registry, authDir, authFile, password } = await openOwnRegistryAuth({ ecr, account, region });
  try {
  for (const image of bundle.manifest.images) {
    const repository = `${BUNDLE_IMAGE_REPOSITORY_PREFIX}/${env}/${image.name}`;
    const digest = digestOf(image.sourceRef);
    let repositoryMissing = false;
    const present = async (): Promise<boolean> => {
      try {
        const result = (await ecr.send(new BatchGetImageCommand({ repositoryName: repository, imageIds: [{ imageDigest: digest }] }))) as { images?: unknown[] };
        return (result.images ?? []).length > 0;
      } catch (error) {
        if (error instanceof Error && error.name === "RepositoryNotFoundException") {
          if (input.skipWhenNoRepository?.includes(image.name) === true) { repositoryMissing = true; return false; }
          throw agentXError("CONFIG_INVALID", image.name === EMBEDDER_BUNDLE_IMAGE_NAME
            ? `the registry repository ${repository} does not exist. The access stack of this release creates it when the Team record is built; deploy that stack first (it holds the Team record's embedder image)`
            : `the registry repository ${repository} does not exist; deploy the access stack of this release first (it creates the bundle repositories)`);
        }
        throw error;
      }
    };
    if (await present()) continue;
    if (repositoryMissing) continue;
    const target = `docker://${registry}/${repository}:${digest.slice("sha256:".length, "sha256:".length + 32)}`;
    await runner.run("skopeo", ["copy", "--all", "--preserve-digests", "--dest-authfile", authFile, `oci-archive:${join(bundle.dir, image.file)}`, target], {
      cwd: bundle.dir, display: `skopeo copy --all --preserve-digests oci-archive:${image.file} ${target}`, redact: (text) => text.split(password).join("****"), quiet: true,
    });
    if (!(await present())) throw agentXError("CONFIG_INVALID", `after loading, ${repository} does not hold ${digest}; the archive does not carry the image the manifest names`);
  }
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
}
