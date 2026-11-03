import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATALOG_BUILD_FLAVOR, ENVIRONMENT_PLACEHOLDER, STACK_PARTS, environmentStackName } from "@agentx/contracts";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SUPPORTED_REGIONS } from "../../infra/lib/production-foundation.js";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";
import { accumulateAsset, assetSignatureMismatch, type PackageAccumulator, type ReleaseAssetLike } from "./assets.js";
import { sha256Hex } from "./hash.js";
import { enterpriseReleaseProfiles } from "./profiles.js";
import { ImageDigest, ReleaseManifestSchema, type ReleaseManifest } from "./manifest.js";
import { gitSourceState, releaseCommitOfCleanTree } from "./source-state.js";
import { zipDirectory } from "./zip.js";

export { accumulateAsset, assetSignatureMismatch, type PackageAccumulator, type ReleaseAssetLike };

export interface BuildReleaseInput {
  version: string;
  out: string;
  gitCommit: string;
  images?: { worker?: string; slack?: string; executor?: string };
}

// scripts/release/build.ts -> repo root is two levels up. NodejsFunction's esbuild bundles embed
// source-map `sources` as paths *relative to the bundle's own location*: when that bundle is built
// under an unrelated directory tree (os.tmpdir(), which varies by TMPDIR and by how deep the OS
// nests it), esbuild finds no common ancestor with the checkout and falls back to walking all the
// way up to "/" and back down through the checkout's *absolute* path — embedding that path as text
// and making the number of ".." segments depend on tmpdir's depth. Synthesizing at a fixed depth
// under the repo root instead keeps the relative path between the bundle and its sources constant
// (the same "../../../packages/..." however deep or wherever the checkout itself lives), so asset
// ids, zip checksums, the control-plane template and release.json stop depending on TMPDIR or the
// checkout's location. Verified by inspecting a real index.js.map: synthesizing under os.tmpdir()
// embedded "../../../../../../../../Users/<name>/.../packages/...", synthesizing under
// `<repoRoot>/.release-synth/...` produced clean "../../../node_modules/..." with no absolute path.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RELEASE_SYNTH_ROOT = join(REPO_ROOT, ".release-synth");

/** Validates images against ImageDigest before any other work, so a bad reference fails fast. */
function checkedImages(images: BuildReleaseInput["images"]): ReleaseManifest["images"] {
  const result: ReleaseManifest["images"] = {};
  if (images?.worker !== undefined) {
    const parsed = ImageDigest.safeParse(images.worker);
    if (!parsed.success) throw new Error(`worker image must be referenced by digest, not ${JSON.stringify(images.worker)}`);
    result.worker = parsed.data;
  }
  if (images?.slack !== undefined) {
    const parsed = ImageDigest.safeParse(images.slack);
    if (!parsed.success) throw new Error(`slack image must be referenced by digest, not ${JSON.stringify(images.slack)}`);
    result.slack = parsed.data;
  }
  if (images?.executor !== undefined) {
    const parsed = ImageDigest.safeParse(images.executor);
    if (!parsed.success) throw new Error(`executor image must be referenced by digest, not ${JSON.stringify(images.executor)}`);
    result.executor = parsed.data;
  }
  return result;
}

/** Reuses the manifest schema's own field validators, so "valid" means the same thing everywhere. */
export function checkedVersion(version: string): string {
  const parsed = ReleaseManifestSchema.shape.version.safeParse(version);
  if (!parsed.success) throw new Error(`version must be a semantic version such as 1.2.3 or 1.2.3-beta.1, not ${JSON.stringify(version)}`);
  return parsed.data;
}

function checkedGitCommit(gitCommit: string): string {
  const parsed = ReleaseManifestSchema.shape.gitCommit.safeParse(gitCommit);
  if (!parsed.success) throw new Error(`gitCommit must be a 40-character hex git commit SHA, not ${JSON.stringify(gitCommit)}`);
  return parsed.data;
}

/**
 * CDK_CONTEXT_JSON and the context-overflow temp file are how the `cdk` CLI (or a leftover/ambient
 * environment) inject context; buildAgentXApp lets CDK_CONTEXT_JSON/the overflow file win over its
 * own context argument to match how App itself merges context (see infra/lib/app.ts). That is the
 * right behavior for `cdk synth`, but it means an ambient CDK_CONTEXT_JSON could silently override
 * this function's agentxEnv/agentxSynthesizer/outdir and produce a release that depends on whatever
 * happened to be in the calling shell's environment. Refuse instead.
 */
export function checkedNoAmbientCdkContext(): void {
  if (process.env[CONTEXT_ENV] !== undefined) {
    throw new Error(
      `refusing to build a release with ${CONTEXT_ENV} set in the environment; it could override this release's context and make the output depend on the ambient environment instead of these inputs alone. Unset it and retry`,
    );
  }
  if (process.env[CONTEXT_OVERFLOW_LOCATION_ENV] !== undefined) {
    throw new Error(
      `refusing to build a release with ${CONTEXT_OVERFLOW_LOCATION_ENV} set in the environment; it could override this release's context and make the output depend on the ambient environment instead of these inputs alone. Unset it and retry`,
    );
  }
}

/**
 * Runs `run` with the process's current working directory pinned to the repo root, restoring the
 * caller's original cwd afterward (even if `run` throws). infra/lib/control-plane.ts resolves each
 * Lambda's `entry` with `resolve(process.cwd(), entry)` against paths that are relative to the repo
 * root (e.g. "packages/broker/src/aws/broker.ts"), and NodejsFunction bundles each one synchronously
 * while the stacks are being constructed — before `.synth()` is ever called. So this release builder
 * has to produce the same output regardless of the caller's own working directory.
 *
 * process.chdir is process-global state, not scoped to this call: it affects every other piece of
 * code running in this process at the same time, so this only works because vitest runs this
 * suite's files under the forks pool (a separate OS process per test file) and no test in this file
 * calls buildRelease concurrently with another cwd-sensitive call.
 */
export function withRepoRootCwd<T>(run: () => T): T {
  const originalCwd = process.cwd();
  process.chdir(REPO_ROOT);
  try {
    return run();
  } finally {
    process.chdir(originalCwd);
  }
}

/** One Lambda function of an app and the id of the code package it runs, as the real build (esbuild, from source) made it. */
export interface FunctionCode {
  /** The function's construct path, for example "AgentXControlPlane/Broker". It is the same in every edition. */
  path: string;
  assetId: string;
}

/**
 * Synthesises the app for `context` the way the release always does (bootstrap-free synthesizer, fixed depth under the repo root, repo root as the working directory), and reads off the
 * code package of every Lambda function by walking the construct tree, so no part of CDK is patched. `outdir` must be under RELEASE_SYNTH_ROOT (see REPO_ROOT's comment).
 */
export function synthReleaseProfile(input: { context: Readonly<Record<string, string>>; outdir: string }): { assembly: CloudAssembly; functions: FunctionCode[] } {
  return withRepoRootCwd(() => {
    const app = buildAgentXApp({ ...input.context, agentxSynthesizer: "legacy", outdir: input.outdir });
    const assembly = app.synth();
    const functions: FunctionCode[] = [];
    for (const construct of app.node.findAll()) {
      if (!(construct instanceof NodejsFunction)) continue;
      const code = construct.node.tryFindChild("Code");
      if (!(code instanceof Asset)) throw new Error(`function ${construct.node.path} has no code asset`);
      functions.push({ path: construct.node.path, assetId: code.assetHash });
    }
    functions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { assembly, functions };
  });
}

/** The out directory must not already hold a release; it is created if absent. */
async function claimOutDir(out: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(out, { recursive: true });
      return;
    }
    throw error;
  }
  if (existing.length > 0) {
    throw new Error(`release output directory is not empty: ${out}`);
  }
}

export async function buildRelease(input: BuildReleaseInput): Promise<ReleaseManifest> {
  // Fail fast, before touching the filesystem or running the expensive synth below, and in an
  // order that leaves the output directory untouched (absent, or unmodified if pre-existing) for
  // every one of these refusals, not just the non-empty-directory one.
  const images = checkedImages(input.images);
  const version = checkedVersion(input.version);
  const gitCommit = checkedGitCommit(input.gitCommit);
  checkedNoAmbientCdkContext();
  // A public or Enterprise release is a RELEASE build: the staging-only catalog signing key (catalog-trust.ts) is honoured by a staging build alone.
  if (CATALOG_BUILD_FLAVOR !== "release") throw new Error("a release is built from a release flavor (packages/contracts/src/catalog-build-flavor.ts); this tree is a staging build");
  await claimOutDir(input.out);

  await mkdir(RELEASE_SYNTH_ROOT, { recursive: true });
  const synthDirs: string[] = [];
  try {
    // Write each region's parts, in SUPPORTED_REGIONS order, each region's parts in STACK_PARTS
    // (deploy) order, and group each stack's zip-packaged code assets by asset id. Code packages are
    // shared across regions (asset hashes don't depend on region), so only the first region's
    // (the baseline's) synth directories are kept around for zipping below; every later region is
    // checked against the baseline's asset ids and parameter names instead of contributing its own.
    const templates: ReleaseManifest["templates"] = [];
    const packagesById = new Map<string, PackageAccumulator>();
    await mkdir(join(input.out, "templates"), { recursive: true });

    for (const [index, region] of SUPPORTED_REGIONS.entries()) {
      // Synthesize the placeholder-environment app, bootstrap-free, at a fixed depth under the repo
      // root (see REPO_ROOT's comment for why), with the repo root as the working directory (see
      // withRepoRootCwd's comment for why).
      const synthDir = await mkdtemp(join(RELEASE_SYNTH_ROOT, "run-"));
      synthDirs.push(synthDir);
      const assembly = withRepoRootCwd(() =>
        buildAgentXApp({
          agentxEnv: ENVIRONMENT_PLACEHOLDER,
          agentxSynthesizer: "legacy",
          agentxRegion: region,
          outdir: synthDir,
        }).synth(),
      );

      const stackByName = new Map(assembly.stacks.map((stack) => [stack.stackName, stack]));
      await mkdir(join(input.out, "templates", region), { recursive: true });

      const regionPackagesById = new Map<string, PackageAccumulator>();
      for (const part of STACK_PARTS) {
        const stackName = environmentStackName(ENVIRONMENT_PLACEHOLDER, part);
        const stack = stackByName.get(stackName);
        if (!stack) throw new Error(`release synth produced no stack named ${stackName} (part ${part}, region ${region})`);
        const file = `templates/${region}/${part}.template.json`;
        const text = `${JSON.stringify(stack.template, null, 2)}\n`;
        await writeFile(join(input.out, file), text, "utf8");
        templates.push({ region, part, file, sha256: sha256Hex(Buffer.from(text, "utf8")) });

        for (const asset of stack.assets) {
          accumulateAsset(regionPackagesById, asset, part, join(assembly.directory, asset.path));
        }
      }

      if (index === 0) {
        for (const [assetId, accumulated] of regionPackagesById) packagesById.set(assetId, accumulated);
      } else if (assetSignatureMismatch(packagesById, regionPackagesById)) {
        throw new Error(`region ${region} produced different code packages`);
      }
    }

    // The Enterprise profiles (first region only: code does not depend on the region, which the loop above checks): a code package an Enterprise install's stacks use and the
    // placeholder templates do not (the operator-access deployer, for one) goes into `enterprisePackages`. A build made at approval may use no package outside the signed lists, so
    // a package missing here would make the install's upgrade refuse; a package two lists disagree about stops the release.
    const [firstRegion] = SUPPORTED_REGIONS;
    if (firstRegion === undefined) throw new Error("no supported region");
    const enterpriseOnly = new Map<string, PackageAccumulator>();
    for (const profile of enterpriseReleaseProfiles()) {
      const synthDir = await mkdtemp(join(RELEASE_SYNTH_ROOT, "run-"));
      synthDirs.push(synthDir);
      const { assembly } = synthReleaseProfile({ context: { ...profile.context, agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxRegion: firstRegion }, outdir: synthDir });
      const stackByName = new Map(assembly.stacks.map((stack) => [stack.stackName, stack]));
      const profileAssets = new Map<string, PackageAccumulator>();
      for (const part of STACK_PARTS) {
        const stack = stackByName.get(environmentStackName(ENVIRONMENT_PLACEHOLDER, part));
        if (!stack) {
          if (part === "identity" && profile.context.agentxIdentity === "oidc") continue;
          throw new Error(`release synth of profile ${profile.name} produced no ${part} stack`);
        }
        for (const asset of stack.assets) accumulateAsset(profileAssets, asset, part, join(assembly.directory, asset.path));
      }
      for (const [assetId, found] of profileAssets) {
        const known = packagesById.get(assetId) ?? enterpriseOnly.get(assetId);
        if (known === undefined) {
          enterpriseOnly.set(assetId, found);
        } else if (known.bucketParameter !== found.bucketParameter || known.keyParameter !== found.keyParameter || known.hashParameter !== found.hashParameter) {
          throw new Error(`asset ${assetId} has different parameter names in profile ${profile.name}, which the legacy synthesizer should never produce`);
        } else if (enterpriseOnly.has(assetId)) {
          for (const part of found.parts) if (!known.parts.includes(part)) known.parts.push(part);
        }
      }
    }

    // Zip and write each distinct asset once, sorted by asset id for a stable manifest order.
    await mkdir(join(input.out, "packages"), { recursive: true });
    const writePackage = async (assetId: string, accumulated: PackageAccumulator, parts: string[]): Promise<ReleaseManifest["packages"][number]> => {
      const zipBuffer = await zipDirectory(accumulated.directory);
      const file = `packages/${assetId}.zip`;
      await writeFile(join(input.out, file), zipBuffer);
      return {
        assetId,
        file,
        sha256: sha256Hex(zipBuffer),
        parts,
        bucketParameter: accumulated.bucketParameter,
        keyParameter: accumulated.keyParameter,
        hashParameter: accumulated.hashParameter,
        keyParameterValue: `packages/||${assetId}.zip`,
      };
    };
    const packages: ReleaseManifest["packages"] = [];
    for (const assetId of [...packagesById.keys()].sort()) {
      const accumulated = packagesById.get(assetId);
      if (accumulated === undefined) throw new Error(`missing accumulated package for asset ${assetId}`);
      packages.push(await writePackage(assetId, accumulated, accumulated.parts));
    }
    const enterprisePackages: NonNullable<ReleaseManifest["enterprisePackages"]> = [];
    for (const assetId of [...enterpriseOnly.keys()].sort()) {
      const accumulated = enterpriseOnly.get(assetId);
      if (accumulated === undefined) throw new Error(`missing accumulated package for asset ${assetId}`);
      enterprisePackages.push(await writePackage(assetId, accumulated, [...new Set(accumulated.parts)].sort()));
    }

    // Include both current and previously granted license texts plus the grant history in the
    // release artifact, and checksum them in release.json like every other shipped file.
    const legalDir = join(input.out, "legal");
    await mkdir(legalDir, { recursive: true });
    const legalDocuments: NonNullable<ReleaseManifest["legalDocuments"]> = [];
    for (const name of ["LICENSE", "LICENSE-APACHE", "RELICENSED.md"] as const) {
      const file = `legal/${name}`;
      await copyFile(join(REPO_ROOT, name), join(input.out, file));
      const content = await readFile(join(input.out, file));
      legalDocuments.push({ file, sha256: sha256Hex(content) });
    }

    // The stage 2 boot script the worker image of this commit carries (Task 10); a deploy writes its hash beside the image.
    const bootStage2Sha256 = sha256Hex(await readFile(join(REPO_ROOT, "packages", "worker", "ec2", "boot-stage2.sh")));

    // Write release.json as validated, pretty JSON.
    const manifest = ReleaseManifestSchema.parse({
      schemaVersion: 1,
      version,
      gitCommit,
      environmentPlaceholder: ENVIRONMENT_PLACEHOLDER,
      templates,
      packages,
      ...(enterprisePackages.length === 0 ? {} : { enterprisePackages }),
      legalDocuments,
      images,
      bootStage2Sha256,
    } satisfies ReleaseManifest);
    await writeFile(join(input.out, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  } finally {
    await Promise.all(synthDirs.map((synthDir) => rm(synthDir, { recursive: true, force: true })));
  }
}

function usage(): string {
  return (
    "Usage: tsx scripts/release/build.ts --version <version> --out <dir> " +
    "[--worker-image <uri@sha256:...>] [--slack-image <uri@sha256:...>] [--executor-image <uri@sha256:...>]\n"
  );
}

interface CliArgs {
  version: string;
  out: string;
  images?: { worker?: string; slack?: string; executor?: string };
}

export function parseBuildArgs(argv: readonly string[]): CliArgs {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  const known = new Set(["--version", "--out", "--worker-image", "--slack-image", "--executor-image", "--help"]);
  for (const argument of argv) {
    if (argument.startsWith("--") && !known.has(argument)) throw new Error(`unknown option ${argument}`);
  }
  const version = valueAfter("--version");
  const out = valueAfter("--out");
  if (version === undefined) throw new Error("--version is required");
  if (out === undefined) throw new Error("--out is required");
  const worker = valueAfter("--worker-image");
  const slack = valueAfter("--slack-image");
  const executor = valueAfter("--executor-image");
  return {
    version,
    out,
    ...(worker !== undefined || slack !== undefined || executor !== undefined
      ? { images: { ...(worker !== undefined ? { worker } : {}), ...(slack !== undefined ? { slack } : {}), ...(executor !== undefined ? { executor } : {}) } }
      : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    process.stdout.write(usage());
  } else {
    // Wraps the synchronous argument parsing and `git rev-parse` too, not just the buildRelease
    // promise below: a bad flag or a missing git checkout used to crash with a raw Node stack trace
    // instead of the same clean "agentx release build failed: ..." message + exit code every other
    // failure gets.
    try {
      const args = parseBuildArgs(process.argv.slice(2));
      // SK-4: the commit written into release.json is true: the tree is clean, nothing ignored changes what is built, and the build output is not older than its source.
      const gitCommit = releaseCommitOfCleanTree(gitSourceState(process.cwd()));
      buildRelease({
        version: args.version,
        out: resolve(args.out),
        gitCommit,
        ...(args.images !== undefined ? { images: args.images } : {}),
      })
        .then((manifest) => {
          process.stdout.write(`wrote release ${manifest.version} (${manifest.gitCommit}) to ${resolve(args.out)}\n`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`agentx release build failed: ${message}\n`);
          process.exitCode = 1;
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agentx release build failed: ${message}\n`);
      process.exitCode = 1;
    }
  }
}
