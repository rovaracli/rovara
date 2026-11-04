// SK-4 (S1): the release workflow's signing job. release:bundle --unsigned (build job, no signing permission) makes the folder; sign-bundle (signing job, builds nothing) checks it again from its
// bytes and signs bundle.json. Nothing here reaches AWS: the key is generated at run time.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_SIGNATURE_FILE, BundleSignatureSchema, sha256OfBytes, verifyBundleSignature } from "@agentx/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBundle } from "../../scripts/release/bundle.js";
import { signPreparedBundle } from "../../scripts/release/sign-bundle.js";
import { IMAGES, NO_KIT_CHECK, RELEASE_LABELS, fakeExporter, newTestKey, writeRelease } from "../support/bundle-fixture.js";
import { writeFakeKit } from "../support/synth-kit-fixture.js";

let root: string;
let releaseDir: string;
let releaseSha: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sign-bundle-")));
  releaseDir = join(root, "release");
  await mkdir(releaseDir);
  await writeRelease(releaseDir);
  releaseSha = sha256OfBytes(await readFile(join(releaseDir, "release.json")));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

let counter = 0;
/** A prepared (unsigned) bundle, as the build job leaves it. */
async function prepared(withKit = true): Promise<string> {
  const out = join(root, `bundle-${String(counter += 1)}`);
  const kit = join(root, `kit-${String(counter)}`);
  if (withKit) await writeFakeKit(kit, { releaseSha256: releaseSha });
  await buildBundle({ releaseDir, out, images: IMAGES, readImageLabels: RELEASE_LABELS, exportImage: fakeExporter, ...(withKit ? { synthKitDir: kit, kitCheck: NO_KIT_CHECK } : {}) });
  return out;
}
const countingSigner = () => { const key = newTestKey(); let signed = 0; return { key, signer: { publicKeyPem: key.publicKeyPem, sign: async (message: Buffer) => { signed += 1; return key.signer.sign(message); } }, count: () => signed }; };

describe("release:bundle without a signer prepares a bundle and signs nothing", () => {
  it("writes bundle.json and every file it lists, and no signature", async () => {
    const dir = await prepared();
    expect(existsSync(join(dir, "bundle.json"))).toBe(true);
    expect(existsSync(join(dir, BUNDLE_SIGNATURE_FILE))).toBe(false);
  });
});

describe("the signing job signs a prepared bundle that is exactly what bundle.json lists", () => {
  it("signs the exact bytes of bundle.json, and the signature verifies against the key's public half", async () => {
    const dir = await prepared();
    const { key, signer, count } = countingSigner();
    const bytesBefore = await readFile(join(dir, "bundle.json"));
    const result = await signPreparedBundle({ dir, signer, requireKit: true });
    expect(count()).toBe(1);
    expect(result.bundleSha256).toBe(sha256OfBytes(bytesBefore));
    expect((await readFile(join(dir, "bundle.json"))).equals(bytesBefore)).toBe(true);
    const signature = BundleSignatureSchema.parse(JSON.parse(await readFile(join(dir, BUNDLE_SIGNATURE_FILE), "utf8")));
    expect(verifyBundleSignature({ manifestBytes: bytesBefore, signature, trustedKeys: [key.publicKeyPem] }).ok).toBe(true);
  });
});

describe("the signing job refuses anything that is not what the build job prepared, and never reaches the signer", () => {
  const refuses = async (change: (dir: string) => Promise<void>, message: RegExp, requireKit = true) => {
    const dir = await prepared();
    await change(dir);
    const { signer, count } = countingSigner();
    await expect(signPreparedBundle({ dir, signer, requireKit })).rejects.toThrow(message);
    expect(count()).toBe(0);
    expect(existsSync(join(dir, BUNDLE_SIGNATURE_FILE))).toBe(false);
  };

  it("a kit module edited after the build job, even with kit.json recomputed to match (the manifest still lists the old bytes)", async () => {
    await refuses(async (dir) => {
      await writeFile(join(dir, "synth-kit", "synth.mjs"), "export {};\n// edited\n");
      const kit = JSON.parse(await readFile(join(dir, "synth-kit", "kit.json"), "utf8")) as { files: Record<string, string> };
      kit.files["synth.mjs"] = sha256OfBytes(await readFile(join(dir, "synth-kit", "synth.mjs")));
      await writeFile(join(dir, "synth-kit", "kit.json"), JSON.stringify(kit));
    }, /is not what bundle\.json lists/u);
  });
  it("a package, a template or a legal file edited", async () => {
    await refuses(async (dir) => { await writeFile(join(dir, "legal", "LICENSE"), "other\n"); }, /legal\/LICENSE is not what bundle\.json lists/u);
  });
  it("an image archive replaced", async () => {
    await refuses(async (dir) => { await writeFile(join(dir, "images", "worker.oci.tar"), "x"); }, /images\/worker\.oci\.tar is not what bundle\.json lists/u);
  });
  it("a file added, a file removed, a link", async () => {
    await refuses(async (dir) => { await writeFile(join(dir, "extra.sh"), "x"); }, /does not list \(extra\.sh\)/u);
    await refuses(async (dir) => { await rm(join(dir, "legal", "LICENSE")); }, /missing a file bundle\.json lists \(legal\/LICENSE\)/u);
    await refuses(async (dir) => { await symlink("/etc/hosts", join(dir, "notes.txt")); }, /link or a special file/u);
  });
  it("a bundle.json that was edited (re-rendered or not), and one that lists a file twice or is not canonical", async () => {
    await refuses(async (dir) => { await writeFile(join(dir, "bundle.json"), `${JSON.stringify(JSON.parse(await readFile(join(dir, "bundle.json"), "utf8")))}\n`); }, /canonical/u);
    await refuses(async (dir) => { await writeFile(join(dir, "bundle.json"), "{}"); }, /./u);
  });
  it("a bundle that fails its checks never makes the signer: no KMS call, not even to read the public key", async () => {
    const dir = await prepared();
    await writeFile(join(dir, "extra.sh"), "x");
    let made = 0;
    await expect(signPreparedBundle({ dir, signer: async () => { made += 1; return newTestKey().signer; }, requireKit: true })).rejects.toThrow(/refusing to sign/u);
    expect(made).toBe(0);
  });
  it("a bundle that is already signed", async () => {
    const dir = await prepared();
    const first = countingSigner();
    await signPreparedBundle({ dir, signer: first.signer, requireKit: true });
    const second = countingSigner();
    await expect(signPreparedBundle({ dir, signer: second.signer, requireKit: true })).rejects.toThrow(/already exists/u);
    expect(second.count()).toBe(0);
  });
  it("a bundle with no kit, unless the job says a kit-less bundle is allowed", async () => {
    const dir = await prepared(false);
    const { signer, count } = countingSigner();
    await expect(signPreparedBundle({ dir, signer, requireKit: true })).rejects.toThrow(/no synthesis kit/u);
    expect(count()).toBe(0);
    await expect(signPreparedBundle({ dir, signer, requireKit: false })).resolves.toMatchObject({ version: "1.4.0" });
    expect(count()).toBe(1);
  });
});
