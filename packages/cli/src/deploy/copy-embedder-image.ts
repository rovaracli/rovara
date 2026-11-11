// A Public install's embedder image (the Team record's self-hosted embedder): copied from the release's public image into a private repository of the install's own account, OUTSIDE every
// pull-through prefix, before the control plane is deployed. Why: Lambda cannot create a function from an image in a pull-through cache repository (ECR user guide, pull through cache,
// "Considerations": "AWS Lambda doesn't support pulling container images from Amazon ECR using a pull through cache rule.", and "Pushing images directly to a pull through cache repository is not a
// supported pattern."), so the embedder cannot use the account's cache the way the worker image does. Enterprise installs already have the image there (`rovara upgrade --bundle` loads it into
// `rovara-bundle/<env>/embedder`, upgrade/bundle/load-images.ts); this puts a Public install's copy in the same repository, which the access stack creates when the Team record is built
// (infra/lib/app.ts).
//
// The copy preserves the digest (skopeo copy --all --preserve-digests re-encodes nothing), so the digest the release names is the digest Lambda runs. It is idempotent (an image already in
// the repository by that digest is left alone) and it refuses, rather than carry on, when the repository does not hold exactly the release's digest afterwards.
// Needs: skopeo on this machine (the Enterprise bundle path needs it too), and for the caller of `agentx upgrade` / `agentx deploy` (the access stack is deployed with the caller's own
// credentials, so the caller also creates the repository): ecr:GetAuthorizationToken, and on the one repository the AWS::ECR::Repository create handler's rights (ecr:CreateRepository, PutLifecyclePolicy,
// SetRepositoryPolicy, TagResource; the export bundle's access deployer policy carries them as `EmbedderRepository`) and, to copy, BatchGetImage, BatchCheckLayerAvailability, InitiateLayerUpload, UploadLayerPart, CompleteLayerUpload and PutImage. The source is a public registry and needs no credential.
// `checkEmbedderCopyPrerequisites` checks skopeo and the authorization token BEFORE any stack deploys (the push rights on the repository cannot be tried before the repository exists);
// the copy itself runs right after the access stack, before foundation, identity, runtime and the control plane, so a refusal never leaves the environment split across releases.
import { BatchGetImageCommand, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { agentXError } from "@rovara-code/contracts";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { CommandRunner } from "./cdk-engine.js";
import { openOwnRegistryAuth } from "../upgrade/bundle/registry-auth.js";
import { embedderRepository } from "./parameters.js";

export interface CopyEmbedderImageInput {
  /** The release's embedder image: `public.ecr.aws/<alias>/<repository>@sha256:<64 hex>`. */
  source: string;
  env: string;
  /** The install's account and region: the registry must be exactly this one. */
  account: string;
  region: string;
  ecr: { send(command: unknown): Promise<unknown> };
  runner: CommandRunner;
  write: (line: string) => void;
}

export type CopyEmbedderImageResult = "present" | "copied";

const PUBLIC_REGISTRY = "public.ecr.aws/";
/** Every manifest type a release image may have, so the check can SEE an index and refuse it (Lambda: "the image you build for your function must target only one of the architectures. Lambda does not support functions that use multi-architecture container images."). */
const SINGLE_IMAGE_TYPES = ["application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.manifest.v1+json"];
const INDEX_TYPES = ["application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.index.v1+json"];

/** True when the error is the runner's "could not start" form for a missing program (a spawn ENOENT), and nothing else: a registry's own "not found" in skopeo's output is not this. */
const isSpawnNotFound = (error: unknown): boolean => error instanceof Error && / could not start: /.test(error.message) && /ENOENT/.test(error.message);
const SKOPEO_MISSING = "skopeo is needed to copy the embedder image into your registry and was not found on this machine; install it (the Enterprise bundle path needs it too) and run the command again. Nothing was deployed";

/**
 * Before any stack deploys: skopeo runs, and ECR gives this caller a registry credential (ecr:GetAuthorizationToken). Cheap, read-only. The caller's push rights on the repository cannot be
 * tried before the access stack has made the repository; a refusal there still comes right after the access stack and before every other stack.
 */
export async function checkEmbedderCopyPrerequisites(input: { runner: CommandRunner; ecr: { send(command: unknown): Promise<unknown> } }): Promise<void> {
  try {
    await input.runner.run("skopeo", ["--version"], { cwd: tmpdir(), display: "skopeo --version", quiet: true });
  } catch (error) {
    if (isSpawnNotFound(error)) throw agentXError("CONFIG_INVALID", SKOPEO_MISSING);
    throw agentXError("CONFIG_INVALID", "skopeo is installed but `skopeo --version` failed, so the embedder image cannot be copied into your registry; fix skopeo and run the command again. Nothing was deployed");
  }
  try {
    await input.ecr.send(new GetAuthorizationTokenCommand({}));
  } catch {
    throw agentXError("CONFIG_INVALID", "the AWS credentials in use cannot get a registry credential from ECR (ecr:GetAuthorizationToken), which copying the embedder image into your registry needs; use credentials that may, and run the command again. Nothing was deployed");
  }
}
const SOURCE = /^public\.ecr\.aws\/[a-z0-9][a-z0-9._/-]*@(sha256:[a-f0-9]{64})$/;

export async function copyEmbedderImage(input: CopyEmbedderImageInput): Promise<CopyEmbedderImageResult> {
  const { source, env, account, region, ecr, runner, write } = input;
  const digest = SOURCE.exec(source)?.[1];
  if (digest === undefined) throw agentXError("CONFIG_INVALID", `the release's embedder image ${JSON.stringify(source)} is not a ${PUBLIC_REGISTRY}<repository>@sha256:<digest> reference; nothing was copied`);
  const repository = embedderRepository(env);
  const lookup = async (): Promise<{ found: boolean; mediaType?: string }> => {
    try {
      const result = (await ecr.send(new BatchGetImageCommand({ repositoryName: repository, imageIds: [{ imageDigest: digest }], acceptedMediaTypes: [...SINGLE_IMAGE_TYPES, ...INDEX_TYPES] }))) as { images?: Array<{ imageManifestMediaType?: string }> };
      const image = (result.images ?? [])[0];
      return image === undefined ? { found: false } : { found: true, ...(image.imageManifestMediaType === undefined ? {} : { mediaType: image.imageManifestMediaType }) };
    } catch (error) {
      if (error instanceof Error && error.name === "RepositoryNotFoundException") {
        throw agentXError("CONFIG_INVALID", `the registry repository ${repository} does not exist. The access stack of this release creates it; deploy that stack first. Nothing was copied`);
      }
      throw error;
    }
  };
  // A multi-platform index is refused (its digest would be preserved, and Lambda would refuse it at CreateFunction, after the other stacks had changed).
  const singleImage = (found: { mediaType?: string }): void => {
    if (found.mediaType !== undefined && INDEX_TYPES.includes(found.mediaType)) throw agentXError("CONFIG_INVALID", `${repository} holds ${digest} as a multi-platform index (${found.mediaType}), and Lambda runs only a single-platform image. The release must name the linux/arm64 image manifest. Nothing was deployed`);
  };
  const first = await lookup();
  if (first.found) {
    singleImage(first);
    write(`The embedder image ${digest.slice(0, 19)} is already in ${repository}`);
    return "present";
  }
  const { registry, authDir, authFile, password } = await openOwnRegistryAuth({ ecr, account, region });
  try {
    const target = `docker://${registry}/${repository}:${digest.slice("sha256:".length, "sha256:".length + 32)}`;
    write(`Copying the embedder image ${digest.slice(0, 19)} from ${PUBLIC_REGISTRY} into ${repository} (Lambda cannot use the pull-through cache)`);
    try {
      await runner.run("skopeo", ["copy", "--all", "--preserve-digests", "--dest-authfile", authFile, `docker://${source}`, target], {
        cwd: authDir, display: `skopeo copy --all --preserve-digests docker://${source} ${target}`, redact: (text) => text.split(password).join("****"), quiet: true,
      });
    } catch (error) {
      // skopeo missing is the one cause worth naming; every other message is the runner's, already redacted.
      if (isSpawnNotFound(error)) throw agentXError("CONFIG_INVALID", SKOPEO_MISSING);
      throw error;
    }
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
  const after = await lookup();
  if (!after.found) throw agentXError("CONFIG_INVALID", `after copying, ${repository} does not hold ${digest}; the copy did not carry the image the release names. Nothing was deployed`);
  singleImage(after);
  return "copied";
}
