// Step image, the real one (lane L6; BETA-CLOUD-PLAN 1.7; L2-STAGE-CLI-INTERFACE.md section 8). L2 owns the checks around this function (adoption never calls it,
// production's result must equal beta's digest); this file owns the work:
//   beta        build the gateway image once (linux/arm64, scripts/model-gateway-image.ts), push it under the immutable tag pipe-<exec8>-<sha9>, read the digest
//               the tag resolves to;
//   production  never builds: `crane copy` the beta digest into the production repository, then assert the digest there is byte-for-byte beta's;
//   supplied    a digest chosen by the operator (gateway rollback): it must already be in this environment's repository.
// The repositories are IMMUTABLE, so every path is idempotent by digest: a tag that already holds the same digest is success, a tag that holds another is refused.
import { loadConfig, stackName } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { IMAGE_DIGEST, assertTag, findImage, imageTagFor, ownRepository, registryLogin, removeDir } from "../lib/ecr.ts";
import type { Repository } from "../lib/ecr.ts";
import { loadSwitches, rowFor } from "../switches.ts";
import type { SwitchesFile } from "../switches.ts";
import { StageError } from "../types.ts";
import type { ImageStepInput, ImageStepResult } from "../types.ts";

export interface ImageDeps { config?: PipelineConfig; /** Defaults to switches.json: beta's and production's regions must agree (the copy names beta's registry in production's region). */ switches?: SwitchesFile; /** Defaults to process.env; production reads BETA_ACCOUNT_ID (a pipeline project variable, never git). */ env?: Record<string, string | undefined> }

const tail = (text: string): string => text.split("\n").filter((line) => line !== "").slice(-3).join(" / ");

async function useSupplied(input: ImageStepInput, repository: Repository, digest: string): Promise<ImageStepResult> {
  const found = await findImage(input.ports, repository.name, { digest });
  if (found === null) throw new StageError("REFUSED", `the supplied digest is not in the repository ${repository.name}: nothing is pushed or copied for a supplied digest`);
  input.log(`supplied digest ${digest.slice(0, 19)}... is in ${repository.name}`);
  return { digest, source: "supplied", imageTag: found.tags[0] ?? "(untagged)", repository: repository.name };
}

async function buildAndPush(input: ImageStepInput, repository: Repository, tag: string): Promise<ImageStepResult> {
  const { ports, log, dirs, manifest } = input;
  const existing = await findImage(ports, repository.name, { tag });
  if (existing !== null) {
    // The tag names this execution and this commit, so an earlier attempt of this same step pushed it: reuse its digest, never rebuild.
    if (!IMAGE_DIGEST.test(existing.digest)) throw new StageError("FAILED", `the tag ${tag} resolves to something that is not a digest`);
    log(`tag ${tag} is already in ${repository.name} (an earlier attempt of this execution pushed it): reusing ${existing.digest.slice(0, 19)}..., no rebuild`);
    return { digest: existing.digest, source: "built", imageTag: tag, repository: repository.name };
  }
  const local = `rovara-model-gateway:${tag}`;
  log(`build: linux/arm64 image ${local} from ${manifest.cloud.sha.slice(0, 12)}`);
  const built = await ports.exec("npx", ["--no-install", "tsx", "scripts/model-gateway-image.ts", "build", "--tag", local], { cwd: dirs.cloud });
  if (built.code !== 0) throw new StageError("FAILED", `the gateway image build exited ${built.code}: ${tail(built.stderr || built.stdout)}`);
  const platform = await ports.exec("docker", ["image", "inspect", local, "--format", "{{.Os}}/{{.Architecture}}"]);
  if (platform.code !== 0 || platform.stdout.trim() !== "linux/arm64") throw new StageError("FAILED", `the built image is ${platform.stdout.trim() || "unreadable"}, not linux/arm64`);
  const configDir = `${dirs.work}/registry-auth-docker`;
  const remote = `${repository.uri}:${tag}`;
  try {
    await registryLogin(ports, "docker", repository.registry, [repository.registry], configDir);
    const env = { DOCKER_CONFIG: configDir };
    const tagged = await ports.exec("docker", ["tag", local, remote], { env });
    if (tagged.code !== 0) throw new StageError("FAILED", `docker tag failed: ${tail(tagged.stderr)}`);
    const pushed = await ports.exec("docker", ["push", remote], { env });
    if (pushed.code !== 0) {
      if ((await findImage(ports, repository.name, { tag })) !== null) throw new StageError("REFUSED", `the tag ${tag} appeared in ${repository.name} while this step was building (the repository is immutable): it holds an image this step did not push, so it is not used`);
      throw new StageError("FAILED", `docker push failed: ${tail(pushed.stderr || pushed.stdout)}`);
    }
    const reported = /digest: (sha256:[0-9a-f]{64})/u.exec(`${pushed.stdout}\n${pushed.stderr}`)?.[1];
    const row = await findImage(ports, repository.name, { tag });
    if (row === null) throw new StageError("FAILED", `the push succeeded but the tag ${tag} is not in ${repository.name}`);
    if (!IMAGE_DIGEST.test(row.digest)) throw new StageError("FAILED", `the tag ${tag} resolves to something that is not a digest`);
    if (reported !== undefined && reported !== row.digest) throw new StageError("REFUSED", `the push reported ${reported.slice(0, 19)}... but the tag ${tag} resolves to ${row.digest.slice(0, 19)}...: not using either`);
    log(`pushed ${repository.name}:${tag} = ${row.digest.slice(0, 19)}...`);
    return { digest: row.digest, source: "built", imageTag: tag, repository: repository.name };
  } finally {
    await removeDir(ports, configDir);
  }
}

async function copyFromBeta(input: ImageStepInput, config: PipelineConfig, settings: Record<string, string | undefined>, switches: SwitchesFile, target: Repository, tag: string): Promise<ImageStepResult> {
  const { ports, log, dirs, manifest } = input;
  const digest = manifest.gateway.digest;
  if (digest === null || !IMAGE_DIGEST.test(digest)) throw new StageError("REFUSED", "production has no beta digest to copy");
  const sourceName = manifest.gateway.repository;
  const betaPrefix = `${stackName(config, "beta", "gatewayImages")}-`;
  if (sourceName === null || !sourceName.startsWith(betaPrefix)) throw new StageError("REFUSED", "the manifest does not name beta's gateway-images repository: the beta image step of this execution did not record it");
  // Beta's account comes from the production project's BETA_ACCOUNT_ID (a stack parameter, never git) AND must equal what beta's own steps recorded in this
  // execution's manifest. Production reads beta's repository with its OWN credentials (beta's repository policy allows read-only pulls on that one repository).
  const configured = settings.BETA_ACCOUNT_ID ?? null;
  const recorded = manifest.stages.beta?.account ?? null;
  const ACCOUNT = /^[0-9]{12}$/u;
  if (configured === null || !ACCOUNT.test(configured)) throw new StageError("REFUSED", "BETA_ACCOUNT_ID is not set to a 12-digit account: production cannot name beta's registry");
  if (recorded === null || !ACCOUNT.test(recorded)) throw new StageError("REFUSED", "the manifest records no beta account: the beta stage of this execution did not complete a step");
  if (configured !== recorded) throw new StageError("REFUSED", "BETA_ACCOUNT_ID differs from the beta account this execution recorded: not copying from an account the beta stage did not run in");
  const sourceAccount = configured;
  if (sourceAccount === target.account) throw new StageError("REFUSED", "the beta account is the production account: the image would be copied from production to itself");
  // Assumption made explicit: beta's registry is addressed in PRODUCTION's region, so the two environments must be in the same region (switches.json rows).
  const betaRegion = rowFor("beta", switches).region;
  if (betaRegion !== target.region) throw new StageError("REFUSED", `beta runs in ${betaRegion} but the production repository is in ${target.region}: the copy source is addressed in the production region, so a cross-region copy is not supported`);
  const sourceRegistry = `${sourceAccount}.dkr.ecr.${target.region}.amazonaws.com`;
  const source = `${sourceRegistry}/${sourceName}@${digest}`;
  if ((await findImage(ports, sourceName, { digest }, sourceAccount)) === null) throw new StageError("REFUSED", `beta's repository ${sourceName} does not hold ${digest.slice(0, 19)}... (or the production role cannot read it): nothing to copy`);

  const existing = await findImage(ports, target.name, { tag });
  if (existing !== null && existing.digest !== digest) throw new StageError("REFUSED", `the tag ${tag} already exists in ${target.name} with ${existing.digest.slice(0, 19)}..., not beta's ${digest.slice(0, 19)}... (the repository is immutable): the gateway must be byte-identical to beta, so this is not used`);
  if (existing !== null) {
    log(`tag ${tag} already holds ${digest.slice(0, 19)}... in ${target.name}: nothing to copy`);
    return { digest, source: "copied", imageTag: tag, repository: target.name };
  }

  const destination = `${target.uri}:${tag}`;
  // crane reads one config directory, so both logins go into the same throwaway one.
  const configDir = `${dirs.work}/registry-auth-crane`;
  const env = { DOCKER_CONFIG: configDir };
  try {
    await registryLogin(ports, "crane", target.registry, [sourceRegistry, target.registry], configDir);
    log(`copy: beta ${sourceName}@${digest.slice(0, 19)}... -> ${target.name}:${tag}`);
    const copied = await ports.exec("crane", ["copy", source, destination], { env });
    if (copied.code === 127) throw new StageError("FAILED", "crane is not installed on this build machine");
    if (copied.code !== 0) throw new StageError("FAILED", `crane copy failed (exit ${copied.code}): ${tail(copied.stderr || copied.stdout)}`);
    const seen = await ports.exec("crane", ["digest", destination], { env });
    if (seen.code !== 0) throw new StageError("FAILED", `crane digest failed (exit ${seen.code}): ${tail(seen.stderr)}`);
    if (seen.stdout.trim() !== digest) throw new StageError("REFUSED", `after the copy ${tag} resolves to ${seen.stdout.trim().slice(0, 19)}..., not beta's ${digest.slice(0, 19)}...: do not deploy it`);
  } finally {
    await removeDir(ports, configDir);
  }
  const row = await findImage(ports, target.name, { tag });
  if (row === null || row.digest !== digest) throw new StageError("REFUSED", `ECR holds ${row === null ? "no image" : `${row.digest.slice(0, 19)}...`} for ${tag} after the copy, not beta's ${digest.slice(0, 19)}...: do not deploy it`);
  log(`copied: ${target.name}:${tag} = ${digest.slice(0, 19)}... (equal to beta's)`);
  return { digest, source: "copied", imageTag: tag, repository: target.name };
}

export async function runImage(input: ImageStepInput, deps: ImageDeps = {}): Promise<ImageStepResult> {
  const config = deps.config ?? loadConfig();
  const repository = await ownRepository(input.ports, config, input.env);
  if (input.supplied !== null) return useSupplied(input, repository, input.supplied.digest);
  const tag = assertTag(imageTagFor(input.manifest));
  return input.env === "beta" ? buildAndPush(input, repository, tag) : copyFromBeta(input, config, deps.env ?? process.env, deps.switches ?? loadSwitches(), repository, tag);
}
