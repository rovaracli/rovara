// How the self-hosted embedder image gets from a release into an install (review H4 of lane self-hosted-embeddings, decision 27: no keyword-only interim).
// The release job builds it and records its digest in release.json; the Enterprise bundle carries it into the install's own `rovara-bundle/<env>/embedder` repository; the CLI names it to the
// control plane's EmbedderImageUri from the release; a Team record with no embedder image is refused with a message that says what to do.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchGetImageCommand, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { BundleManifestSchema, ReleaseManifestSchema, type ReleaseManifest } from "@agentx/contracts";
import { buildBundle } from "../../scripts/release/bundle.js";
import { parseBuildArgs } from "../../scripts/release/build.js";
import { CONFIG_KEYS, configKey, embedderImageHome } from "../../packages/cli/src/config/keys.js";
import { embedderImageUri } from "../../packages/cli/src/deploy/parameters.js";
import { EMBEDDER_BUNDLE_IMAGE_NAME, loadBundleImages } from "../../packages/cli/src/upgrade/bundle/load-images.js";
import { IMAGES, RELEASE_LABELS, fakeExporter, newTestKey, writeRelease } from "../support/bundle-fixture.js";

const d = (c: string): string => c.repeat(64);
const EMBEDDER = `public.ecr.aws/agentx/agentx-embedder@sha256:${d("e")}`;
const baseRelease = { schemaVersion: 1, version: "1.4.0", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [], images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}` } } as unknown as ReleaseManifest;
const withEmbedder = { ...baseRelease, images: { ...baseRelease.images, embedder: EMBEDDER } } as ReleaseManifest;

describe("release.json names the embedder image", () => {
  it("accepts a digest-pinned embedder image and refuses anything else (images are strict: an unknown key is never skipped)", () => {
    const manifest = ReleaseManifestSchema.shape.images;
    expect(manifest.parse({ embedder: EMBEDDER })).toEqual({ embedder: EMBEDDER });
    expect(() => manifest.parse({ embedder: "public.ecr.aws/agentx/agentx-embedder:latest" })).toThrow();
    expect(() => manifest.parse({ embedder: EMBEDDER, other: EMBEDDER })).toThrow();
  });
  it("the build command takes --embedder-image", () => {
    expect(parseBuildArgs(["--version", "1.2.3", "--out", "o", "--embedder-image", EMBEDDER]).images).toEqual({ embedder: EMBEDDER });
    expect(parseBuildArgs(["--version", "1.2.3", "--out", "o", "--worker-image", baseRelease.images.worker!, "--embedder-image", EMBEDDER]).images).toEqual({ worker: baseRelease.images.worker, embedder: EMBEDDER });
  });
});

describe("the release workflow builds, pushes and records the embedder image", () => {
  const workflow = YAML.parse(readFileSyncText(".github/workflows/release.yml")) as { jobs: Record<string, { outputs?: Record<string, string>; steps: Array<{ id?: string; env?: Record<string, string>; run?: string }> }> };
  const push = workflow.jobs.images!.steps.find((step) => step.id === "push")!;
  it("builds it with the same script a person uses (linux/arm64), pushes it by digest only when its variable is true, and puts it first (its quality gates run in the build)", () => {
    expect(workflow.jobs.images!.outputs?.embedder).toBe("${{ steps.push.outputs.embedder }}");
    expect(push.env?.PUBLISH_EMBEDDER).toBe("${{ vars.AGENTX_PUBLISH_EMBEDDER_IMAGE }}");
    expect(push.run).toContain('if [ "$PUBLISH_EMBEDDER" = "true" ]; then images="embedder $images"; fi');
    expect(push.run).toContain('environments/embedder/tools/build-image.sh "$repo:$VERSION" --push "$RUNNER_TEMP/$image.json"');
    expect(push.run).toContain('echo "$image=$repo@$registry_digest" >> "$GITHUB_OUTPUT"');
  });
  it("hands the digest to the release, and to the Enterprise bundle", () => {
    const release = workflow.jobs.release!.steps.find((step) => step.run?.includes("release:build"))!;
    expect(release.env?.EMBEDDER).toBe("${{ needs.images.outputs.embedder }}");
    expect(release.run).toContain('--embedder-image "$EMBEDDER"');
    const bundle = Object.values(workflow.jobs).flatMap((job) => job.steps).find((step) => step.run?.includes("release:bundle"))!;
    expect(bundle.env?.EMBEDDER).toBe("${{ needs.images.outputs.embedder }}");
    expect(bundle.run).toContain('--image "embedder=$EMBEDDER"');
  });
});

function readFileSyncText(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("the Enterprise bundle carries the embedder image", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  async function releaseNaming(): Promise<{ root: string; releaseDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "bundle-embedder-")); roots.push(root);
    const releaseDir = join(root, "release");
    await writeRelease(releaseDir);
    const manifest = JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8")) as { images: Record<string, string> };
    manifest.images.embedder = EMBEDDER;
    await writeFile(join(releaseDir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, releaseDir };
  }
  it("refuses a bundle that does not mirror the embedder image the release names, and lists it when it does", async () => {
    const { root, releaseDir } = await releaseNaming();
    const base = { releaseDir, readImageLabels: RELEASE_LABELS, exportImage: fakeExporter, signer: newTestKey().signer };
    await expect(buildBundle({ ...base, out: join(root, "a"), images: IMAGES })).rejects.toThrow(/names a embedder image.*must mirror it/);
    const built = await buildBundle({ ...base, out: join(root, "b"), images: [...IMAGES, { name: "embedder", sourceRef: EMBEDDER }] });
    expect(BundleManifestSchema.parse(built.manifest).images.map((image) => image.name)).toContain("embedder");
    await expect(buildBundle({ ...base, out: join(root, "c"), images: [...IMAGES, { name: "embedder", sourceRef: `public.ecr.aws/agentx/agentx-embedder@sha256:${d("f")}` }] })).rejects.toThrow(/not the one release.json names/);
  });
});

describe("the CLI names the embedder image from the release", () => {
  const target = { release: withEmbedder, env: "staging", account: "123456789012", region: "us-east-1" } as const;
  it("through the account's image cache in a Public install, in this account and region", () => {
    expect(embedderImageUri({ ...target, edition: undefined })).toBe(`123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-embedder@sha256:${d("e")}`);
    expect(embedderImageUri({ ...target, edition: "public" })).toContain("/agentx-staging/agentx/agentx-embedder@sha256:");
  });
  it("from the install's own rovara-bundle/<env>/embedder repository in an Enterprise install (the bundle loaded it there, digest preserved)", () => {
    expect(embedderImageUri({ ...target, edition: "enterprise" })).toBe(`123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-bundle/staging/embedder@sha256:${d("e")}`);
    expect(embedderImageUri({ ...target, edition: "enterprise", partition: "aws-cn", region: "cn-north-1" })).toMatch(/^123456789012\.dkr\.ecr\.cn-north-1\.amazonaws\.com\.cn\/rovara-bundle\/staging\/embedder@sha256:/);
  });
  it("refuses a release that carries none, with a message that says what is missing", () => {
    expect(() => embedderImageUri({ ...target, release: baseRelease, edition: undefined })).toThrow(/carries no embedder image, and the Team record needs one/);
  });
  const own = `123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara/embedder@sha256:${d("a")}`;
  it("R7: a release with no image keeps the image the stack already runs (a source or override upgrade, or the key set by hand), instead of refusing", () => {
    expect(embedderImageUri({ ...target, release: baseRelease, edition: undefined, deployed: own })).toBe(own);
    expect(embedderImageUri({ ...target, release: baseRelease, edition: "enterprise", deployed: own })).toBe(own);
    // `none` is no image; a value that is not a digest-pinned image of the registry is not kept either
    for (const deployed of ["none", "", "embedder:latest", undefined]) expect(() => embedderImageUri({ ...target, release: baseRelease, edition: undefined, deployed }), String(deployed)).toThrow(/carries no embedder image.*stack runs none.*--embedder-image/s);
    // a release that names an image still wins over the running one (the upgrade moves the stack to the release's embedder)
    expect(embedderImageUri({ ...target, edition: undefined, deployed: own })).toContain("/agentx-staging/agentx/agentx-embedder@sha256:");
  });
  it("R7: --embedder-image names the image for a release that has none, and wins over the release and the running image; it must be pinned by digest in this account and region", () => {
    expect(embedderImageUri({ ...target, release: baseRelease, edition: undefined, override: own })).toBe(own);
    expect(embedderImageUri({ ...target, edition: "enterprise", override: own, deployed: `123456789012.dkr.ecr.us-east-1.amazonaws.com/other/embedder@sha256:${d("b")}` })).toBe(own);
    expect(() => embedderImageUri({ ...target, edition: undefined, override: "embedder:latest" })).toThrow(/pinned by digest/);
    expect(() => embedderImageUri({ ...target, edition: undefined, override: `999999999999.dkr.ecr.us-east-1.amazonaws.com/rovara/embedder@sha256:${d("a")}` })).toThrow(/this install's own registry/);
    expect(() => embedderImageUri({ ...target, edition: undefined, override: `123456789012.dkr.ecr.eu-west-1.amazonaws.com/rovara/embedder@sha256:${d("a")}` })).toThrow(/this install's own registry/);
  });
  it("the key teamRecord.embedderImage takes only an image pinned by digest in this account and region, never none", () => {
    const entry = configKey("teamRecord.embedderImage");
    const ok = `123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara/embedder@sha256:${d("a")}`;
    expect(entry.parse(ok)).toBe(ok);
    expect(() => entry.parse("none")).toThrow(/There is no "none"/);
    expect(() => entry.parse("embedder:latest")).toThrow();
    expect(embedderImageHome(ok)).toEqual({ account: "123456789012", region: "us-east-1" });
    expect(embedderImageHome("embedder:latest")).toBeUndefined();
    expect(CONFIG_KEYS.find((key) => key.key === "teamRecord.embedderImage")?.description).not.toMatch(/keyword/);
  });
});

describe("loading the embedder image from a bundle", () => {
  const bundle = { dir: "/unused", manifest: { images: [{ name: EMBEDDER_BUNDLE_IMAGE_NAME, sourceRef: `x/embedder@sha256:${d("e")}`, file: "images/embedder.oci.tar" }] } } as never;
  const ecr = { async send(command: unknown) {
    if (command instanceof GetAuthorizationTokenCommand) return { authorizationData: [{ authorizationToken: Buffer.from("AWS:pw").toString("base64"), proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com" }] };
    if (command instanceof BatchGetImageCommand) throw Object.assign(new Error("no repository"), { name: "RepositoryNotFoundException" });
    throw new Error("unexpected");
  } };
  const runner = { async run() { throw new Error("nothing may be copied"); } };
  const input = { bundle, env: "ent", account: "123456789012", region: "us-east-1", ecr, runner } as const;

  it("skips it where the install has no embedder repository and does not record the Team record (the access stack makes the repository only with the record)", async () => {
    await expect(loadBundleImages({ ...input, skipWhenNoRepository: [EMBEDDER_BUNDLE_IMAGE_NAME] })).resolves.toBeUndefined();
  });
  it("is an error where the record is on and the repository is missing, naming the access stack of this release", async () => {
    await expect(loadBundleImages(input)).rejects.toThrow(/rovara-bundle\/ent\/embedder does not exist.*access stack of this release creates it when the Team record is built/s);
  });
  it("never skips another image's missing repository", async () => {
    const other = { dir: "/unused", manifest: { images: [{ name: "worker", sourceRef: `x/worker@sha256:${d("e")}`, file: "images/worker.oci.tar" }] } } as never;
    await expect(loadBundleImages({ ...input, bundle: other, skipWhenNoRepository: [EMBEDDER_BUNDLE_IMAGE_NAME] })).rejects.toThrow(/does not exist/);
  });
});
