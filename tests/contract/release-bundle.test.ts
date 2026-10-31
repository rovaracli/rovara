// Enterprise foundations, N2: the signed release bundle's builder and manifest. Keys are generated here; none is stored.
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundleManifestSchema, BundleSignatureSchema, sha256OfBytes, verifyBundleSignature } from "@agentx/contracts";
import { LITELLM_SOURCE_IMAGE } from "../../infra/lib/bundle-images.js";
import { buildBundle } from "../../scripts/release/bundle.js";
import { IMAGES, builtBundle, fakeExporter, newTestKey, ociArchive, writeRelease, type BuiltBundle } from "../support/bundle-fixture.js";

const made: BuiltBundle[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((bundle) => bundle.cleanup())); });
const build = async (options?: Parameters<typeof builtBundle>[0]) => { const bundle = await builtBundle(options); made.push(bundle); return bundle; };

describe("the release bundle", () => {
  it("lists every file with its SHA-256 and size, images included, and the signature covers bundle.json's exact bytes", async () => {
    const bundle = await build();
    const bytes = await readFile(join(bundle.dir, "bundle.json"));
    const manifest = BundleManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    expect(bundle.bundleSha256).toBe(sha256OfBytes(bytes));
    const listed = manifest.files.map((entry) => entry.file);
    expect(listed).toEqual(expect.arrayContaining(["release.json", "images/litellm.oci.tar", "images/worker.oci.tar", "notes/RELEASE-NOTES.md", "legal/LICENSE"]));
    for (const entry of manifest.files) expect(sha256OfBytes(await readFile(join(bundle.dir, entry.file))), entry.file).toBe(entry.sha256);
    expect(manifest.images.map((image) => image.name)).toEqual(["litellm", "slack", "worker"]);
    const signature = BundleSignatureSchema.parse(JSON.parse(await readFile(join(bundle.dir, "bundle.sig.json"), "utf8")));
    expect(verifyBundleSignature({ manifestBytes: bytes, signature, trustedKeys: [bundle.key.publicKeyPem] }).ok).toBe(true);
    // Positive control for the next assertion: another key does not verify it.
    expect(verifyBundleSignature({ manifestBytes: bytes, signature, trustedKeys: [newTestKey().publicKeyPem] }).ok).toBe(false);
    // One changed byte of bundle.json breaks the signature.
    const flipped = Buffer.from(bytes); flipped[flipped.length - 3] = flipped[flipped.length - 3]! ^ 1;
    expect(verifyBundleSignature({ manifestBytes: flipped, signature: { ...signature, bundleSha256: sha256OfBytes(flipped) }, trustedKeys: [bundle.key.publicKeyPem] }).ok).toBe(false);
  });

  it("carries LiteLLM by the digest the templates pin, and refuses a bundle without it or with another digest", async () => {
    const bundle = await build();
    const manifest = BundleManifestSchema.parse(JSON.parse(await readFile(join(bundle.dir, "bundle.json"), "utf8")));
    expect(manifest.images.find((image) => image.name === "litellm")?.sourceRef).toBe(LITELLM_SOURCE_IMAGE);
    const root = await mkdtemp(join(tmpdir(), "bundle-refuse-"));
    try {
      await writeRelease(join(root, "release"));
      const key = newTestKey();
      const base = { releaseDir: join(root, "release"), exportImage: fakeExporter, signer: key.signer };
      await expect(buildBundle({ ...base, out: join(root, "a"), images: [IMAGES[1]!] })).rejects.toThrow(/must carry the LiteLLM image/);
      await expect(buildBundle({ ...base, out: join(root, "b"), images: [{ name: "litellm", sourceRef: `ghcr.io/berriai/litellm-database:v9@sha256:${"c".repeat(64)}` }] })).rejects.toThrow(/not the digest the templates pin/);
      // Refused before anything is written.
      await expect(readdir(join(root, "a"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(buildBundle({ ...base, out: join(root, "c"), images: [IMAGES[0]!, { name: "worker", sourceRef: "public.ecr.aws/agentx/agentx-worker:latest" }] })).rejects.toThrow(/must be referenced by digest/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses to bundle a release whose files no longer match release.json, and a signer whose key does not match its signatures", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-refuse-"));
    try {
      await writeRelease(join(root, "release"));
      await writeFile(join(root, "release", "legal", "LICENSE"), "tampered\n");
      const key = newTestKey();
      await expect(buildBundle({ releaseDir: join(root, "release"), out: join(root, "out"), images: IMAGES, exportImage: fakeExporter, signer: key.signer })).rejects.toThrow(/does not match release.json/);
      await writeRelease(join(root, "release2"));
      const mismatched = { publicKeyPem: newTestKey().publicKeyPem, sign: (message: Buffer) => key.signer.sign(message) };
      await expect(buildBundle({ releaseDir: join(root, "release2"), out: join(root, "out2"), images: IMAGES, exportImage: fakeExporter, signer: mismatched })).rejects.toThrow(/does not verify against its own public key/);
      await expect(readdir(join(root, "out2"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses an exported archive that does not hold the digest the manifest would promise, and a release image that is not mirrored (review I6, I7)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-refuse-"));
    try {
      await writeRelease(join(root, "release"));
      const key = newTestKey();
      const base = { releaseDir: join(root, "release"), signer: key.signer, images: IMAGES };
      // A converted manifest: the archive holds another digest than the source reference.
      const converting = async (sourceRef: string, destFile: string) => { await mkdir(dirname(destFile), { recursive: true }); await writeFile(destFile, ociArchive(`sha256:${"9".repeat(64)}`)); void sourceRef; };
      await expect(buildBundle({ ...base, out: join(root, "a"), exportImage: converting })).rejects.toThrow(/does not hold sha256:/);
      const garbage = async (_ref: string, destFile: string) => { await mkdir(dirname(destFile), { recursive: true }); await writeFile(destFile, "not a tar"); };
      await expect(buildBundle({ ...base, out: join(root, "b"), exportImage: garbage })).rejects.toThrow(/does not hold sha256:/);
      await expect(readdir(join(root, "a"))).rejects.toMatchObject({ code: "ENOENT" });
      // The release names worker and slack images: leaving one out, or giving another, is refused.
      await expect(buildBundle({ ...base, out: join(root, "c"), exportImage: fakeExporter, images: IMAGES.filter((image) => image.name !== "slack") })).rejects.toThrow(/must mirror it/);
      await expect(buildBundle({ ...base, out: join(root, "d"), exportImage: fakeExporter, images: [IMAGES[0]!, IMAGES[1]!, { name: "slack", sourceRef: `public.ecr.aws/agentx/agentx-slack@sha256:${"d".repeat(64)}` }] })).rejects.toThrow(/not the one release.json names/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a release file that is a link, not the file release.json describes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-refuse-"));
    try {
      await writeRelease(join(root, "release"));
      const target = join(root, "release", "legal", "LICENSE");
      await writeFile(join(root, "same-bytes"), await readFile(target));
      await rm(target);
      await symlink(join(root, "same-bytes"), target);
      await expect(buildBundle({ releaseDir: join(root, "release"), out: join(root, "out"), images: IMAGES, exportImage: fakeExporter, signer: newTestKey().signer })).rejects.toThrow(/not a regular file/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses an output directory that already holds files, and leaves them alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-refuse-"));
    try {
      await writeRelease(join(root, "release"));
      await mkdir(join(root, "out"));
      await writeFile(join(root, "out", "keep.txt"), "mine");
      await expect(buildBundle({ releaseDir: join(root, "release"), out: join(root, "out"), images: IMAGES, exportImage: fakeExporter, signer: newTestKey().signer })).rejects.toThrow(/not empty/);
      expect(await readFile(join(root, "out", "keep.txt"), "utf8")).toBe("mine");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a manifest that lists a file twice, names itself, escapes the directory, or points an image at a non-image file", () => {
    const base = { schemaVersion: 1, format: "rovara-release-bundle", version: "1.0.0", gitCommit: "a".repeat(40), images: [] as unknown[] };
    const file = (path: string, kind = "template") => ({ file: path, kind, sha256: "a".repeat(64), bytes: 1 });
    const release = file("release.json", "release-manifest");
    expect(BundleManifestSchema.safeParse({ ...base, files: [release] }).success).toBe(true);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, release] }).success).toBe(false);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("t/a.json"), file("t/a.json")] }).success).toBe(false);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("t/a.json")] }).success).toBe(true);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("bundle.json")] }).success).toBe(false);
    for (const bad of ["../x", "/etc/passwd", "a/../b", "a//b", ".hidden"]) expect(BundleManifestSchema.safeParse({ ...base, files: [release, file(bad)] }).success, bad).toBe(false);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release, file("t/a.json")], images: [{ name: "x", sourceRef: `r@sha256:${"a".repeat(64)}`, file: "t/a.json" }] }).success).toBe(false);
    expect(BundleManifestSchema.safeParse({ ...base, files: [file("t/a.json")] }).success).toBe(false);
    expect(BundleManifestSchema.safeParse({ ...base, files: [release], extra: 1 }).success).toBe(false);
  });
});
