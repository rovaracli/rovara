// Test services slice 1: a release never carries the staging-only catalog signing key. The tree check (scripts/release/build.ts), the worker image's flavor label (scripts/release/image-flavor.ts) and the paths that take
// a worker image into a release, a bundle or a production deploy are exercised here on fixture trees and with fake label readers; nothing starts Docker or reads a registry.
import { chmodSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_STAGING_ACCOUNT_ID, catalogTrustedKeyPems } from "@agentx/contracts";
import { FLAVOR_FILE, STAGING_KEYS_FILE, STAGING_KEY_DATA_FILE, setCatalogFlavor } from "../../packages/contracts/tools/catalog-flavor.js";
import { CATALOG_FLAVOR_TOOL, buildStagingArtifacts, restoreReleaseFlavor } from "../../scripts/test-deploy.js";
import { skopeoLabelReader } from "../../scripts/release/image-flavor.js";
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


describe("the staging build path", () => {
  const recording = () => {
    const seen: string[][] = [];
    return { runner: { run: (command: string, args: readonly string[]) => { seen.push([command, ...args]); return ""; } }, seen };
  };
  it("sets the staging flavor automatically, right before it builds the contracts dist and the Lambdas, and sets release back afterwards", () => {
    const { runner, seen } = recording();
    buildStagingArtifacts(runner);
    expect(seen).toEqual([["npx", "tsx", CATALOG_FLAVOR_TOOL, "staging"], ["npm", "run", "build"]]);
    expect(CATALOG_FLAVOR_TOOL).toBe("packages/contracts/tools/catalog-flavor.ts");
    restoreReleaseFlavor(runner);
    expect(seen.at(-1)).toEqual(["npx", "tsx", CATALOG_FLAVOR_TOOL, "release"]);
  });
  it("a build that forgets the step is a release build with an empty list and trusts nothing extra, even in the staging account with the key data file present", async () => {
    // the checked-in tree, compiled: no extra key for the staging account
    expect(catalogTrustedKeyPems({ runningAccountId: CATALOG_STAGING_ACCOUNT_ID })).toEqual([]);
    // a tree holding the staging key data but no switch run: still release, still empty, so it passes the release check and its list holds nothing
    const root = await temporary("forgot-the-step-");
    for (const file of [FLAVOR_FILE, STAGING_KEYS_FILE]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await cp(new URL(`../../${file}`, import.meta.url), join(root, file));
    }
    await mkdir(join(root, "packages/contracts/dist"), { recursive: true });
    await writeFile(join(root, "packages/contracts/dist/catalog-build-flavor.js"), FLAVOR_DIST("release"));
    await writeFile(join(root, "packages/contracts/dist/catalog-staging-keys.js"), KEYS_DIST("[]"));
    await mkdir(join(root, "environments/service-catalog"), { recursive: true });
    await writeFile(join(root, STAGING_KEY_DATA_FILE), JSON.stringify([{ keyId: "a".repeat(64), algorithm: "ECDSA_SHA_256", publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n" }]));
    await expect(assertReleaseCatalogTree(root)).resolves.toBeUndefined();
    expect(await readFile(join(root, STAGING_KEYS_FILE), "utf8")).not.toContain("a".repeat(64));
    // and the switch is what changes that, and the release switch changes it back
    await setCatalogFlavor(root, "staging");
    expect(await readFile(join(root, STAGING_KEYS_FILE), "utf8")).toContain("a".repeat(64));
    await expect(assertReleaseCatalogTree(root)).rejects.toThrow(/release refused/u);
    await setCatalogFlavor(root, "release");
    expect(await readFile(join(root, STAGING_KEYS_FILE), "utf8")).not.toContain("a".repeat(64));
  });
  it("an interrupted staging build leaves a tree that no release can be made from, until the release flavor is put back", async () => {
    const root = await temporary("interrupted-");
    for (const file of [FLAVOR_FILE, STAGING_KEYS_FILE]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await cp(new URL(`../../${file}`, import.meta.url), join(root, file));
    }
    await mkdir(join(root, "packages/contracts/dist"), { recursive: true });
    await writeFile(join(root, "packages/contracts/dist/catalog-build-flavor.js"), FLAVOR_DIST("release"));
    await writeFile(join(root, "packages/contracts/dist/catalog-staging-keys.js"), KEYS_DIST("[]"));
    await mkdir(join(root, "environments/service-catalog"), { recursive: true });
    await writeFile(join(root, STAGING_KEY_DATA_FILE), JSON.stringify([{ keyId: "c".repeat(64), algorithm: "ECDSA_SHA_256", publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n" }]));
    // a runner that does what the commands do to this tree: the switch rewrites the files, and the build is killed half way
    const pending: Array<Promise<void>> = [];
    const runner = {
      run: (command: string, args: readonly string[]) => {
        if (args.includes(CATALOG_FLAVOR_TOOL)) return void pending.push(setCatalogFlavor(root, args.at(-1) as "release" | "staging"));
        throw new Error(`killed during ${command} ${args.join(" ")}`);
      },
    };
    try { buildStagingArtifacts(runner); } catch { /* the build was killed */ }
    await Promise.all(pending);
    expect(await readFile(join(root, FLAVOR_FILE), "utf8")).toContain('= "staging";');
    // no restore ran (the process died), so a later release from this tree is refused, and so is buildRelease, before it touches the output folder
    await expect(assertReleaseCatalogTree(root)).rejects.toThrow(/release refused/u);
    const out = join(await temporary("release-out-"), "r");
    await expect(buildRelease({ version: "1.2.3", out, gitCommit: "b".repeat(40), catalogTreeRoot: root })).rejects.toThrow(/release refused|release flavor/u);
    await expect(readdir(out)).rejects.toMatchObject({ code: "ENOENT" });
    // restoring the release flavor (what the deploy's finally does when it can run) makes the source clean again; the stale compiled output still needs a build
    restoreReleaseFlavor(runner);
    await Promise.all(pending);
    await expect(assertReleaseCatalogTree(root)).resolves.toBeUndefined();
  });
  it("is the only path that runs the switch: no production release, bundle, installer, upgrade or workflow file runs it or builds a staging image", async () => {
    const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const releaseScripts = (await readdir(new URL("../../scripts/release/", import.meta.url))).filter((name) => name.endsWith(".ts") && name !== "catalog-flavor.ts").map((name) => `scripts/release/${name}`);
    const workflows = (await readdir(new URL("../../.github/workflows/", import.meta.url))).map((name) => `.github/workflows/${name}`);
    const productionFiles = [...releaseScripts, ...workflows, "scripts/release-production.ts", "scripts/release-common.ts", "scripts/release-installer.ts", "package.json", "infra/lib/release-pipeline.ts"];
    for (const path of productionFiles) {
      let text: string;
      try { text = read(path); } catch { continue; }
      // build.ts and image-flavor.ts name the tool in refusal messages; none of them runs it or passes the staging argument
      expect(text, path).not.toMatch(/--build-arg\s+CATALOG_FLAVOR=staging|CATALOG_FLAVOR:\s*["']staging|catalog-flavor\.ts["'],\s*["']staging|catalog-flavor\.ts staging/u);
    }
    // the deploy workflow images pass no flavor, so Docker's default (release) applies
    const release = YAML.parse(read(".github/workflows/release.yml")) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    for (const job of Object.values(release.jobs)) for (const step of job.steps) expect(step.run ?? "").not.toMatch(/CATALOG_FLAVOR|catalog-flavor/u);
    // staging is named in exactly one place that runs: scripts/test-deploy.ts (the tool call and the worker image argument)
    const deploy = read("scripts/test-deploy.ts");
    expect(deploy.match(/CATALOG_FLAVOR_TOOL, "staging"/gu)).toHaveLength(1);
    expect(deploy.match(/CATALOG_FLAVOR: "staging"/gu)).toHaveLength(1);
    expect(deploy.indexOf("buildStagingArtifacts(context.runner)")).toBeGreaterThan(0);
    expect(deploy).toContain("if (context.built) restoreReleaseFlavor(runner);");
  });
});

describe("the release workflow can read the label", () => {
  const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")) as { jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }> };
  /** The steps of every job that runs a command which reads the worker image's label (release:build with --worker-image, release:bundle with a worker image). */
  const labelReaders = Object.entries(workflow.jobs).filter(([, job]) => job.steps.some((step) => /release:build[^\n]*--worker-image|release:bundle[^\n]*image_flags|--image "worker=/u.test(step.run ?? "")));
  it("has skopeo installed in every job that takes a worker image into a release or a bundle, before that step", () => {
    expect(labelReaders.map(([name]) => name).sort()).toEqual(["bundle", "release"]);
    for (const [name, job] of labelReaders) {
      const reads = job.steps.findIndex((step) => /release:build[^\n]*--worker-image|release:bundle/u.test(step.run ?? ""));
      const installs = job.steps.findIndex((step) => /apt-get install[^\n]*\bskopeo\b/u.test(step.run ?? ""));
      expect(installs, name).toBeGreaterThanOrEqual(0);
      expect(installs, name).toBeLessThan(reads);
    }
  });
  it("reads a published image's label the way the workflow's skopeo can: anonymously, the arm64 config, the labels map", async () => {
    // a fake skopeo on the PATH answers like the real one for a public image config
    const bin = await temporary("fake-skopeo-");
    const log = join(bin, "calls");
    await writeFile(join(bin, "skopeo"), `#!/bin/sh\necho "$@" >> "${log}"\necho '{"config":{"Labels":{"ai.rovara.catalog-flavor":"release","org.opencontainers.image.revision":"abc"}}}'\n`);
    chmodSync(join(bin, "skopeo"), 0o755);
    const before = process.env["PATH"];
    process.env["PATH"] = `${bin}:${before ?? ""}`;
    try {
      expect(await skopeoLabelReader(WORKER)).toMatchObject({ "ai.rovara.catalog-flavor": "release" });
      expect((await readFile(log, "utf8")).trim()).toBe(`inspect --config --override-os linux --override-arch arm64 docker://${WORKER}`);
      await expect(assertReleaseFlavorImage("worker", WORKER, skopeoLabelReader)).resolves.toBeUndefined();
    } finally {
      if (before === undefined) delete process.env["PATH"]; else process.env["PATH"] = before;
    }
  });
});

describe("the worker Dockerfile never fails on a missing optional file", () => {
  it("every host COPY source either is a directory/file that exists or a glob that matches something", async () => {
    const dockerfile = await readFile(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8");
    const root = new URL("../../", import.meta.url).pathname;
    const sources = dockerfile.split("\n").filter((line) => line.startsWith("COPY ") && !line.includes("--from=")).flatMap((line) => line.trim().split(/\s+/u).slice(1, -1).filter((word) => !word.startsWith("--")));
    expect(sources.length).toBeGreaterThan(10);
    const matches = async (pattern: string): Promise<boolean> => {
      if (!pattern.includes("*")) { try { await readFile(join(root, pattern)).catch(async () => readdir(join(root, pattern))); return true; } catch { return false; } }
      const directory = join(root, pattern.slice(0, pattern.lastIndexOf("/")));
      const expression = new RegExp(`^${pattern.slice(pattern.lastIndexOf("/") + 1).replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u");
      return (await readdir(directory).catch(() => [])).some((name) => expression.test(name));
    };
    const missing: string[] = [];
    for (const source of sources) if (!(await matches(source))) missing.push(source);
    expect(missing).toEqual([]);
    // the optional staging key file is never named: the whole catalog directory is copied into the build stage, and the final stage copies catalog*.json from there
    expect(dockerfile).not.toMatch(/staging-signing-key/u);
    expect(dockerfile).toContain("COPY environments/service-catalog environments/service-catalog");
    expect(dockerfile).toContain("COPY --from=build /opt/agentx/environments/service-catalog/catalog*.json ./packages/worker/service-catalog/");
  });
});
