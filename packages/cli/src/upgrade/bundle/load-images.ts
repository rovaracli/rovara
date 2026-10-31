// Enterprise foundations, task N3: loads a verified bundle's images into the install's own ECR, digests preserved (skopeo copies every platform without
// re-encoding), so the signed manifest's hash is the hash the task runs. The registry credential comes from ECR and is kept out of the displayed
// command and out of any error text. Each image is checked in the registry by digest afterwards.
import { BatchGetImageCommand, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { BUNDLE_IMAGE_REPOSITORY_PREFIX, agentXError } from "@agentx/contracts";
import type { CommandRunner } from "../../deploy/cdk-engine.js";
import type { VerifiedBundle } from "./verify.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LoadBundleImagesInput {
  bundle: VerifiedBundle;
  env: string;
  /** The install's account and region: the registry must be exactly this one. */
  account: string;
  region: string;
  ecr: { send(command: unknown): Promise<unknown> };
  runner: CommandRunner;
}

const digestOf = (reference: string): string => /@(sha256:[a-f0-9]{64})$/.exec(reference)?.[1] as string;

export async function loadBundleImages(input: LoadBundleImagesInput): Promise<void> {
  const { bundle, env, account, region, ecr, runner } = input;
  const auth = ((await ecr.send(new GetAuthorizationTokenCommand({}))) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string }> }).authorizationData?.[0];
  if (auth?.authorizationToken === undefined || auth.proxyEndpoint === undefined) throw agentXError("CONFIG_INVALID", "ECR gave no registry credential; no image was loaded");
  const password = Buffer.from(auth.authorizationToken, "base64").toString("utf8").replace(/^AWS:/, "");
  const registry = auth.proxyEndpoint.replace(/^https:\/\//, "");
  if (!/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(registry) || !registry.startsWith(`${account}.dkr.ecr.${region}.`)) {
    throw agentXError("CONFIG_INVALID", "ECR named a registry other than this install's own account and region; no image was loaded");
  }
  // The credential goes to skopeo in a 0600 file in a 0700 directory, never on its command line where any local user could read it (review M2).
  const authDir = await mkdtemp(join(tmpdir(), "rovara-registry-auth-"));
  const authFile = join(authDir, "auth.json");
  await writeFile(authFile, JSON.stringify({ auths: { [registry]: { auth: auth.authorizationToken } } }), { mode: 0o600 });
  try {
  for (const image of bundle.manifest.images) {
    const repository = `${BUNDLE_IMAGE_REPOSITORY_PREFIX}/${env}/${image.name}`;
    const digest = digestOf(image.sourceRef);
    const present = async (): Promise<boolean> => {
      try {
        const result = (await ecr.send(new BatchGetImageCommand({ repositoryName: repository, imageIds: [{ imageDigest: digest }] }))) as { images?: unknown[] };
        return (result.images ?? []).length > 0;
      } catch (error) {
        if (error instanceof Error && error.name === "RepositoryNotFoundException") {
          throw agentXError("CONFIG_INVALID", `the registry repository ${repository} does not exist; deploy the access stack of this release first (it creates the bundle repositories)`);
        }
        throw error;
      }
    };
    if (await present()) continue;
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
