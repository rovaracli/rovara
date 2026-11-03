// SK-4: the checks made on a bundle's bytes right before a signature, shared by the one-process path (bundle.ts) and the separate signing job (sign-bundle.ts). This file imports nothing from the release
// build, so the signing job's single-file program stays small: it holds no code that builds anything.
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SIGNATURE_FILE,
  BundleManifestSchema,
  ReleaseManifestSchema,
  SynthKitManifestSchema,
  sha256OfBytes,
  type BundleManifest,
  type ReleaseManifest,
} from "@agentx/contracts";
import { ociArchiveDigests } from "./oci-archive.js";

/** The `sha256:<hex>` of a digest-pinned image reference. (infra/lib/bundle-images.ts has the same function; it is repeated because that file brings in aws-cdk-lib, which the signing job's program must not carry.) */
function imageDigestOf(reference: string): string {
  const match = /@(sha256:[a-f0-9]{64})$/u.exec(reference);
  if (match === null) throw new Error(`image reference ${JSON.stringify(reference)} is not pinned by digest`);
  return match[1] as string;
}

async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * SK-4: the last look before the signature. Everything the manifest says about the kit is measured again from the bytes now in the output folder (read into memory and hashed, so what is
 * compared is what is read, not a second look at the disk): the folder holds exactly kit.json and the files it lists, every hash equals kit.json's and the manifest's, and kit.json still names this
 * release. The manifest is then signed with no further step in between. The kit check and the image exports run for minutes after the first hashing; anything that changed the copy meanwhile is refused here.
 */
export async function reverifyKitBeforeSigning(input: { kitRoot: string; releaseJsonSha256: string; release: ReleaseManifest; manifestFiles: BundleManifest["files"] }): Promise<void> {
  const { kitRoot, release, manifestFiles } = input;
  const read = new Map<string, string>();
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 6) throw new Error("the synthesis kit nests deeper than allowed");
    for (const entry of await readdir(join(kitRoot, relative))) {
      const path = relative === "" ? entry : `${relative}/${entry}`;
      const info = await lstat(join(kitRoot, path));
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) read.set(path, sha256OfBytes(await readFile(join(kitRoot, path))));
      else throw new Error(`the synthesis kit holds a link or a special file (${path}); refusing to sign`);
    }
  };
  await walk("", 0);
  const kitJsonBytes = await readFile(join(kitRoot, "kit.json"));
  const kit = SynthKitManifestSchema.parse(JSON.parse(kitJsonBytes.toString("utf8")));
  // kit.json is hashed again from the bytes just parsed: the manifest's entry must be these very bytes.
  read.set("kit.json", sha256OfBytes(kitJsonBytes));
  if (kit.releaseSha256 !== input.releaseJsonSha256 || kit.gitCommit !== release.gitCommit) throw new Error("the synthesis kit was made from a different release than the one being bundled; refusing to sign");
  const expected = new Map<string, string | undefined>([["kit.json", undefined], ...Object.entries(kit.files)]);
  for (const file of read.keys()) if (!expected.has(file)) throw new Error(`the synthesis kit holds a file kit.json does not list (${file}); refusing to sign`);
  for (const [file, listed] of expected) {
    const hash = read.get(file);
    if (hash === undefined) throw new Error(`the synthesis kit is missing a file kit.json lists (${file}); refusing to sign`);
    if (listed !== undefined && hash !== listed) throw new Error(`the synthesis kit file ${file} is not what kit.json lists (it changed after it was copied); refusing to sign`);
  }
  const inManifest = new Map(manifestFiles.filter((entry) => entry.kind === "synth-kit").map((entry) => [entry.file, entry.sha256] as const));
  if (inManifest.size !== read.size) throw new Error("the bundle manifest and the synthesis kit in the output folder list different files; refusing to sign");
  for (const [file, hash] of read) {
    if (inManifest.get(`synth-kit/${file}`) !== hash) throw new Error(`the synthesis kit file ${file} is not the one the bundle manifest lists (it changed after it was copied); refusing to sign`);
  }
}

/** Every regular file under `root`, "/"-separated; a link or a special file refuses. */
async function regularFilesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("the bundle nests deeper than allowed");
    for (const entry of await readdir(join(root, relative))) {
      const path = relative === "" ? entry : `${relative}/${entry}`;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) found.push(path);
      else throw new Error(`the bundle holds a link or a special file (${path}); refusing to sign`);
    }
  };
  await walk("", 0);
  return found;
}

/**
 * The signing job's own check of a bundle made by `release:bundle --unsigned`, in a job that never builds anything: bundle.json parses, the folder holds exactly the files it lists plus bundle.json (no
 * signature yet), every file's SHA-256 and size are the listed ones, release.json is the release the manifest names, every image archive holds the digest the manifest promises, and (with `requireKit`) the
 * kit is exactly what its kit.json lists and was made from this release. Returns the exact bytes of bundle.json that are to be signed.
 */
export async function verifyPreparedBundle(input: { dir: string; requireKit: boolean }): Promise<{ manifestBytes: Buffer; manifest: BundleManifest }> {
  const { dir } = input;
  const manifestBytes = await readFile(join(dir, BUNDLE_MANIFEST_FILE));
  const manifest = BundleManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  // The bytes to be signed are the canonical rendering of the manifest, as release:bundle writes it: a hand-edited bundle.json that parses is not signed.
  if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"))) throw new Error("bundle.json is not the canonical rendering of its own content; refusing to sign");
  const present = await regularFilesUnder(dir);
  if (present.includes(BUNDLE_SIGNATURE_FILE)) throw new Error(`${BUNDLE_SIGNATURE_FILE} already exists; refusing to sign a bundle twice`);
  const listed = new Set(manifest.files.map((entry) => entry.file));
  if (listed.size !== manifest.files.length) throw new Error("bundle.json lists a file twice; refusing to sign");
  for (const file of present) if (file !== BUNDLE_MANIFEST_FILE && !listed.has(file)) throw new Error(`the bundle holds a file bundle.json does not list (${file}); refusing to sign`);
  for (const entry of manifest.files) {
    if (!present.includes(entry.file)) throw new Error(`the bundle is missing a file bundle.json lists (${entry.file}); refusing to sign`);
    const measured = await sha256OfFile(join(dir, ...entry.file.split("/")));
    if (measured.sha256 !== entry.sha256 || measured.bytes !== entry.bytes) throw new Error(`the bundle file ${entry.file} is not what bundle.json lists; refusing to sign`);
  }
  const releaseEntry = manifest.files.find((entry) => entry.file === "release.json");
  if (releaseEntry === undefined) throw new Error("bundle.json does not list release.json; refusing to sign");
  const release = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(dir, "release.json"), "utf8")));
  if (release.version !== manifest.version || release.gitCommit !== manifest.gitCommit) throw new Error("release.json is not the release bundle.json names; refusing to sign");
  for (const image of manifest.images) {
    const held = await ociArchiveDigests(join(dir, ...image.file.split("/"))).catch((): string[] => []);
    if (!held.includes(imageDigestOf(image.sourceRef))) throw new Error(`the archive of image ${image.name} does not hold ${imageDigestOf(image.sourceRef)}; refusing to sign`);
  }
  const hasKit = manifest.files.some((entry) => entry.kind === "synth-kit");
  if (input.requireKit && !hasKit) throw new Error("the bundle carries no synthesis kit; refusing to sign");
  if (hasKit) await reverifyKitBeforeSigning({ kitRoot: join(dir, "synth-kit"), releaseJsonSha256: releaseEntry.sha256, release, manifestFiles: manifest.files });
  return { manifestBytes, manifest };
}
