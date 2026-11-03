// Test services slice 1: a release never carries the staging-only catalog signing key. The tree check (scripts/release/build.ts), the worker image's flavor label (scripts/release/image-flavor.ts) and the paths that take
// a worker image into a release, a bundle or a production deploy are exercised here on fixture trees and with fake label readers; nothing starts Docker or reads a registry.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRelease, assertReleaseCatalogTree } from "../../scripts/release/build.js";
import { buildBundle } from "../../scripts/release/bundle.js";
import { CATALOG_FLAVOR_LABEL, assertReleaseFlavorImage, type ImageLabelReader } from "../../scripts/release/image-flavor.js";
import { buildAndPushImage, buildAndPushWorker, type Runner } from "../../scripts/release-common.js";
import { acceptReleaseWorkerImage, parseProductionReleaseArgs } from "../../scripts/release-production.js";
import { IMAGES, RELEASE_LABELS, fakeExporter, newTestKey, writeRelease } from "../support/bundle-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temporary = async (prefix: string): Promise<string> => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };

const FLAVOR_SRC = (flavor: string) => `export const CATALOG_BUILD_FLAVOR: "release" | "staging" = "${flavor}";\n`;
const KEYS_SRC = (list: string) => `import type { CatalogSigningKey } from "./catalog-trust-core.js";\nexport const CATALOG_STAGING_ONLY_SIGNING_KEYS: readonly CatalogSigningKey[] = ${list};\n`;
const FLAVOR_DIST = (flavor: string) => `export const CATALOG_BUILD_FLAVOR = "${flavor}";\n`;
const KEYS_DIST = (list: string) => `export const CATALOG_STAGING_ONLY_SIGNING_KEYS = ${list};\n`;
const KEY_LIST = '[{ keyId: "a", algorithm: "ECDSA_SHA_256", publicKey: "k" }]';

interface TreeParts { flavorSrc?: string; keysSrc?: string; flavorDist?: string | null; keysDist?: string | null }
/** A throwaway checkout holding just the files the tree check reads. */
async function tree(parts: TreeParts = {}): Promise<string> {
  const root = await temporary("release-tree-");
  await mkdir(join(root, "packages/contracts/src"), { recursive: true });
  await mkdir(join(root, "packages/contracts/dist"), { recursive: true });
  await writeFile(join(root, "packages/contracts/src/catalog-build-flavor.ts"), parts.flavorSrc ?? FLAVOR_SRC("release"));
  await writeFile(join(root, "packages/contracts/src/catalog-staging-keys.ts"), parts.keysSrc ?? KEYS_SRC("[]"));
  if (parts.flavorDist !== null) await writeFile(join(root, "packages/contracts/dist/catalog-build-flavor.js"), parts.flavorDist ?? FLAVOR_DIST("release"));
  if (parts.keysDist !== null) await writeFile(join(root, "packages/contracts/dist/catalog-staging-keys.js"), parts.keysDist ?? KEYS_DIST("[]"));
  return root;
}
const labels = (flavor: string | undefined): ImageLabelReader => async () => (flavor === undefined ? {} : { [CATALOG_FLAVOR_LABEL]: flavor });
const WORKER = `944937319445.dkr.ecr.us-west-2.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`;

describe("a release is made from a release tree", () => {
  it("accepts a tree whose flavor is release and whose staging-only key list is empty, in the source and the compiled output", async () => {
    await expect(assertReleaseCatalogTree(await tree())).resolves.toBeUndefined();
  });
  it("refuses a staging flavor, a key in the list, a compiled output of another flavor or with a key, and a missing build", async () => {
    const cases: Array<[string, TreeParts, RegExp]> = [
      ["staging flavor in the source", { flavorSrc: FLAVOR_SRC("staging") }, /catalog-build-flavor\.ts is not the release flavor/u],
      ["a key in the source list", { keysSrc: KEYS_SRC(KEY_LIST) }, /catalog-staging-keys\.ts holds a staging-only catalog key/u],
      ["staging flavor compiled", { flavorDist: FLAVOR_DIST("staging") }, /dist\/catalog-build-flavor\.js is compiled from another flavor/u],
      ["a key compiled in", { keysDist: KEYS_DIST(KEY_LIST) }, /dist\/catalog-staging-keys\.js is compiled with a staging-only catalog key/u],
      ["no compiled flavor", { flavorDist: null }, /dist\/catalog-build-flavor\.js is missing/u],
      ["no compiled list", { keysDist: null }, /dist\/catalog-staging-keys\.js is missing/u],
    ];
    for (const [name, parts, message] of cases) await expect(assertReleaseCatalogTree(await tree(parts)), name).rejects.toThrow(message);
  });
  it("buildRelease refuses such a tree before it touches the output folder", async () => {
    const out = join(await temporary("release-out-"), "r");
    const staging = await tree({ keysSrc: KEYS_SRC(KEY_LIST) });
    await expect(buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), catalogTreeRoot: staging })).rejects.toThrow(/staging-only catalog key/u);
    await expect(readdir(out)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("buildRelease refuses a worker image that is not labelled release (or not labelled at all, or not readable) before it touches the output folder", async () => {
    const root = await tree();
    for (const [name, reader] of [["staging", labels("staging")], ["unlabelled", labels(undefined)], ["unreadable", async () => { throw new Error("denied"); }], ["odd", labels("release ")]] as const) {
      const out = join(await temporary("release-out-"), "r");
      await expect(buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), catalogTreeRoot: root, images: { worker: WORKER }, readImageLabels: reader }), name).rejects.toThrow(/worker image .* (is not a release-flavor image|could not be inspected)/u);
      await expect(readdir(out), name).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("the image flavor label", () => {
  it("is accepted only when it is exactly release", async () => {
    await expect(assertReleaseFlavorImage("worker", WORKER, labels("release"))).resolves.toBeUndefined();
    for (const flavor of ["staging", "Release", "", " release", "release\n", undefined]) await expect(assertReleaseFlavorImage("worker", WORKER, labels(flavor)), String(flavor)).rejects.toThrow(/not a release-flavor image/u);
    await expect(assertReleaseFlavorImage("worker", WORKER, async () => { throw new Error("x"); })).rejects.toThrow(/could not be inspected/u);
  });
});

describe("a bundle takes only a release-flavor worker image", () => {
  it("refuses a staging, an unlabelled or an unreadable worker image before anything is written, and takes a release one", async () => {
    const root = await temporary("bundle-flavor-");
    await writeRelease(join(root, "release"));
    const key = newTestKey();
    const base = { releaseDir: join(root, "release"), images: IMAGES, exportImage: fakeExporter, signer: key.signer };
    for (const [name, reader] of [["staging", labels("staging")], ["unlabelled", labels(undefined)], ["unreadable", async () => { throw new Error("denied"); }]] as const) {
      const out = join(root, `out-${name}`);
      await expect(buildBundle({ ...base, out, readImageLabels: reader }), name).rejects.toThrow(/worker image/u);
      await expect(readdir(out), name).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(buildBundle({ ...base, out: join(root, "ok"), readImageLabels: RELEASE_LABELS })).resolves.toBeDefined();
  }, 120_000);
});

describe("a production release takes only a release-flavor worker image", () => {
  const options = (extra: string[], reader: ImageLabelReader) => ({ ...parseProductionReleaseArgs(["--region", "us-west-2", ...extra], {}), readImageLabels: reader });
  it("refuses a staging worker image whichever way it was chosen, with --reuse-unchanged-worker and --allow-dirty too", async () => {
    for (const extra of [[], ["--reuse-unchanged-worker"], ["--allow-dirty"], ["--reuse-unchanged-worker", "--allow-dirty"], ["--worker-image", WORKER, "--allow-dirty", "--skip-checks"]]) {
      await expect(acceptReleaseWorkerImage(WORKER, options(extra, labels("staging"))), extra.join(" ")).rejects.toThrow(/not a release-flavor image/u);
      await expect(acceptReleaseWorkerImage(WORKER, options(extra, labels(undefined))), extra.join(" ")).rejects.toThrow(/not a release-flavor image/u);
      await expect(acceptReleaseWorkerImage(WORKER, options(extra, labels("release"))), extra.join(" ")).resolves.toBeUndefined();
    }
  });
  it("is checked for every worker image releaseProduction uses, after it was chosen and before anything is deployed", async () => {
    const source = await readFile(new URL("../../scripts/release-production.ts", import.meta.url), "utf8");
    const chosen = source.indexOf("?? await buildAndPushWorker(runner, options, repositoryUri, revision);");
    const accepted = source.indexOf("await acceptReleaseWorkerImage(workerImage, options, runner);");
    const deployed = source.indexOf('"--parameters",\n    `${RUNTIME_STACK}:WorkerImageUri=${workerImage}`');
    expect(chosen).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(chosen);
    expect(deployed).toBeGreaterThan(accepted);
  });
});

describe("the worker image build", () => {
  /** A runner that records the docker command and stops at the first one, so no image is built. */
  const recording = () => {
    const seen: string[][] = [];
    const runner = { run: (command: string, args: readonly string[]) => { seen.push([command, ...args]); throw new Error("stop"); } } as unknown as Runner;
    return { runner, seen };
  };
  const release = { region: "us-west-2", repository: "agentx-worker-production", allowDirty: false, skipChecks: false, dryRun: false };
  it("a production release builds the worker with CATALOG_FLAVOR=release", async () => {
    const { runner, seen } = recording();
    await expect(buildAndPushWorker(runner, release, "944937319445.dkr.ecr.us-west-2.amazonaws.com/agentx-worker-production", "c".repeat(40))).rejects.toThrow("stop");
    const args = seen[0]!;
    expect(args.slice(0, 3)).toEqual(["docker", "buildx", "build"]);
    expect(args[args.indexOf("--build-arg") + 1]).toBe("CATALOG_FLAVOR=release");
    expect(args.filter((arg) => arg === "--build-arg")).toHaveLength(1);
  });
  it("any other image gets only the build arguments it names (the staging path names staging)", async () => {
    const { runner, seen } = recording();
    const image = { repository: "r", repositoryUri: "944937319445.dkr.ecr.us-west-2.amazonaws.com/r", dockerfile: "environments/base/Dockerfile", localName: "agentx-worker", smokeTest: async () => undefined };
    await expect(buildAndPushImage(runner, release, { ...image, buildArgs: { CATALOG_FLAVOR: "staging" } }, "c".repeat(40))).rejects.toThrow("stop");
    expect(seen[0]![seen[0]!.indexOf("--build-arg") + 1]).toBe("CATALOG_FLAVOR=staging");
    const plain = recording();
    await expect(buildAndPushImage(plain.runner, release, image, "c".repeat(40))).rejects.toThrow("stop");
    expect(plain.seen[0]).not.toContain("--build-arg");
  });
  it("only the staging build path passes staging, and the Dockerfile defaults to release, labels the image and fails closed on any other value", async () => {
    const deploy = await readFile(new URL("../../scripts/test-deploy.ts", import.meta.url), "utf8");
    expect(deploy.match(/CATALOG_FLAVOR: "staging"/gu)).toHaveLength(1);
    const production = await readFile(new URL("../../scripts/release-production.ts", import.meta.url), "utf8");
    const common = await readFile(new URL("../../scripts/release-common.ts", import.meta.url), "utf8");
    expect(`${production}\n${common}`).not.toMatch(/CATALOG_FLAVOR: "staging"/u);
    const dockerfile = await readFile(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8");
    expect(dockerfile.match(/^ARG CATALOG_FLAVOR=release$/gmu)).toHaveLength(2);
    expect(dockerfile).toContain('LABEL ai.rovara.catalog-flavor="${CATALOG_FLAVOR}"');
    expect(dockerfile).toContain('case "$CATALOG_FLAVOR" in release|staging) ;; *) echo "CATALOG_FLAVOR is release or staging" >&2; exit 1 ;; esac');
    expect(dockerfile.indexOf("node packages/contracts/tools/catalog-flavor.ts")).toBeLessThan(dockerfile.indexOf("npx tsc -b packages/contracts"));
  });
});
