// Enterprise foundations, task N2: the container images an Enterprise install runs come from its own ECR, loaded from the signed release
// bundle (packages/contracts/src/bundle.ts); nothing is pulled from a public registry at run time. Public installs are unchanged.
import { Aws, Fn } from "aws-cdk-lib";
import { BUNDLE_IMAGE_REPOSITORY_PREFIX, BUNDLE_LITELLM_IMAGE_NAME } from "@agentx/contracts";

/** LiteLLM, pinned by digest (spike: docs/learnings/model-proxy-spike.md). ghcr.io is public; a Public install's tasks pull it through the NAT. */
export const LITELLM_SOURCE_IMAGE = "ghcr.io/berriai/litellm-database:v1.105.1@sha256:2bcadb9905b692a5ca4dadd51bccaaa23a95dc8a0f9322d9c9787f0ac2aeb50e";

/** The `sha256:<hex>` part of a digest-pinned image reference. */
export function imageDigestOf(reference: string): string {
  const match = /@(sha256:[a-f0-9]{64})$/.exec(reference);
  if (match === null) throw new Error(`image reference ${JSON.stringify(reference)} is not pinned by digest`);
  return match[1] as string;
}

/** The ECR repository a bundle image is loaded into, by environment and bundle image name. */
export const bundleImageRepository = (env: string, name: string): string => `${BUNDLE_IMAGE_REPOSITORY_PREFIX}/${env}/${name}`;
/** The repositories the access stack creates for an Enterprise install: one per image the templates reference. */
export const BUNDLE_IMAGE_NAMES = [BUNDLE_LITELLM_IMAGE_NAME] as const;

/**
 * The install's own ECR reference to a bundle image. The digest is the source image's, which loading from the bundle preserves, so the
 * task runs exactly the bytes the signed manifest hashed.
 */
export function bundleImageUri(env: string, name: string, digest: string): string {
  return Fn.join("", [Aws.ACCOUNT_ID, ".dkr.ecr.", Aws.REGION, ".", Aws.URL_SUFFIX, "/", bundleImageRepository(env, name), "@", digest]);
}

/** ECR resource ARN of a bundle image's repository in this install's account and region. */
export const bundleImageRepositoryArn = (env: string, name: string): string => `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${bundleImageRepository(env, name)}`;
