// L6: the ECR helpers of the gateway image step (BETA-CLOUD-PLAN 1.7). The repository comes from the gateway-images stack's RepositoryUri output (never a
// committed name or account), and its account must be the account STS reports for this run. Nothing here reads a secret: the registry password goes from
// `ecr get-authorization-token` straight into `docker login` / `crane auth login` on stdin, into a throwaway config directory, and is never logged.
import { stackName } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { AwsError } from "../ports.ts";
import { StageError } from "../types.ts";
import type { Manifest, PipelineEnv, Ports } from "../types.ts";

export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TAG = /^[A-Za-z0-9._-]{1,128}$/u;
/** A tag this pipeline gave a gateway image: `ctx-<the 64 hex of the build-context hash>` (current) or `pipe-<exec8>-<sha9>` (older records, kept readable for rollback). */
const BUILT_TAG = /^(?:ctx-[0-9a-f]{64}|pipe-[0-9a-f]{8}-[0-9a-f]{9})$/u;
const CONTEXT_SHA256 = /^[0-9a-f]{64}$/u;
const URI = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*)$/u;

export interface Repository { uri: string; registry: string; name: string; account: string; region: string }
export interface ImageRow { digest: string; tags: string[]; /** When ECR says the image was pushed (ISO), null when it does not say. */ pushedAt: string | null }

export function parseRepositoryUri(uri: string): Repository {
  const match = URI.exec(uri);
  if (match === null) throw new StageError("REFUSED", "the gateway-images stack's RepositoryUri output is not an ECR repository address");
  const [, account, region, name] = match;
  return { uri, registry: uri.slice(0, uri.indexOf("/")), name: name!, account: account!, region: region! };
}

/**
 * The tag beta gives its image, by CONTENT: `ctx-<contextSha256>` (all 64 hex: 68 characters, under ECR's 128), the hash scripts/model-gateway-image.ts computes over the exact build context
 * (Dockerfile with its base digest, lockfiles, package files, every source file). The same context always has the same tag, whatever execution or Cloud commit
 * it runs in, so an unchanged gateway finds its tag and reuses its digest instead of being rebuilt.
 */
export function contentTagFor(contextSha256: string): string {
  if (!CONTEXT_SHA256.test(contextSha256)) throw new StageError("FAILED", "the gateway image context hash is not 64 hex characters");
  return `ctx-${contextSha256}`;
}

/**
 * The tag production copies beta's image under: the tag beta recorded in the manifest (a `ctx-` or an older `pipe-` tag; nothing parses a Cloud sha out of it),
 * or, only when the manifest has none, the older per-execution form `pipe-<exec8>-<sha9>`. Beta does not use this: it names its image by contentTagFor.
 */
export function imageTagFor(manifest: Readonly<Manifest>): string {
  const recorded = manifest.gateway.imageTag;
  if (recorded !== null && BUILT_TAG.test(recorded)) return recorded;
  return `pipe-${manifest.exec8}-${manifest.cloud.sha.slice(0, 9)}`;
}

export function assertTag(tag: string): string {
  if (!TAG.test(tag)) throw new StageError("REFUSED", "the image tag has characters ECR does not allow");
  return tag;
}

/** The environment's own gateway-images repository, read from its stack; refused when the stack is absent or lives in another account than this run's. */
export async function ownRepository(ports: Ports, config: PipelineConfig, env: PipelineEnv): Promise<Repository> {
  const stack = stackName(config, env, "gatewayImages");
  const described = await ports.cfn.describeStack(stack);
  if (described === null) throw new StageError("REFUSED", `the stack ${stack} does not exist: nothing to push the gateway image to`);
  const uri = described.outputs.RepositoryUri;
  if (uri === undefined) throw new StageError("REFUSED", `the stack ${stack} has no RepositoryUri output`);
  const repository = parseRepositoryUri(uri);
  const account = await ports.sts.account();
  if (repository.account !== account) throw new StageError("REFUSED", `the repository of ${stack} is not in the account this run uses: refusing to push or copy there`);
  return repository;
}

const notFound = (error: unknown): boolean => error instanceof AwsError && /ImageNotFoundException/u.test(error.stderr);

/** Looks an image up by tag or by digest. null = not there. `registryId` reads another account's repository (production reading beta's, allowed by beta's repository policy). */
export async function findImage(ports: Ports, repositoryName: string, by: { tag: string } | { digest: string }, registryId?: string): Promise<ImageRow | null> {
  const id = "tag" in by ? `imageTag=${assertTag(by.tag)}` : `imageDigest=${by.digest}`;
  if ("digest" in by && !IMAGE_DIGEST.test(by.digest)) throw new StageError("REFUSED", "an image digest must look like sha256:<64 hex>");
  try {
    const doc = (await ports.aws.json(["ecr", "describe-images", "--repository-name", repositoryName, "--image-ids", id, ...(registryId === undefined ? [] : ["--registry-id", registryId])])) as { imageDetails?: Array<{ imageDigest?: string; imageTags?: string[]; imagePushedAt?: string }> } | null;
    const detail = doc?.imageDetails?.[0];
    if (detail === undefined || typeof detail.imageDigest !== "string") return null;
    return { digest: detail.imageDigest, tags: Array.isArray(detail.imageTags) ? detail.imageTags.filter((t) => typeof t === "string") : [], pushedAt: typeof detail.imagePushedAt === "string" ? detail.imagePushedAt : null };
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

/**
 * A throwaway registry login for `docker` or `crane`: the password is piped on stdin and never appears in an argument, a log line or an error. One ECR token
 * (the run's own credentials) is valid for every registry that principal may reach, so `registries` may name another account's registry too.
 */
export async function registryLogin(ports: Ports, tool: "docker" | "crane", ownRegistry: string, registries: readonly string[], configDir: string): Promise<void> {
  const answer = (await ports.aws.json(["ecr", "get-authorization-token"])) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string }> } | null;
  const entry = answer?.authorizationData?.[0];
  if (entry === undefined || typeof entry.authorizationToken !== "string" || typeof entry.proxyEndpoint !== "string") throw new StageError("FAILED", "ECR returned no registry login");
  if (entry.proxyEndpoint.replace(/^https:\/\//u, "") !== ownRegistry) throw new StageError("REFUSED", "the registry login is for a different registry than this run's own");
  const decoded = Buffer.from(entry.authorizationToken, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) throw new StageError("FAILED", "ECR returned a malformed registry login");
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  ports.fs.mkdirp(configDir);
  for (const registry of registries) {
    const args = tool === "docker" ? ["login", "--username", user, "--password-stdin", registry] : ["auth", "login", registry, "--username", user, "--password-stdin"];
    const result = await ports.exec(tool, args, { env: { DOCKER_CONFIG: configDir }, input: password });
    if (result.code === 127) throw new StageError("FAILED", `${tool} is not installed on this build machine`);
    if (result.code !== 0) throw new StageError("FAILED", `${tool} could not log in to the registry (exit ${result.code})`);
  }
}

export async function removeDir(ports: Ports, dir: string): Promise<void> {
  await ports.exec("rm", ["-rf", dir]);
}
