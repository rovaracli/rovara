// Enterprise foundations, task N3: verifies a signed release bundle (packages/contracts/src/bundle.ts) before `rovara upgrade --bundle` changes anything.
// Order: signature over the exact bytes of bundle.json, the customer's approved bundle id (if given), the manifest's shape, the directory holds exactly the
// listed files (no extra, no missing, no link), every file's size and SHA-256, and the release inside agrees with the bundle. Any failure is a refusal with
// a fixed message; nothing is read from AWS and nothing is written here.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_MAX_BYTES,
  BUNDLE_MAX_FILES,
  BUNDLE_SIGNATURE_FILE,
  BUNDLE_SIGNATURE_MAX_BYTES,
  BundleManifestSchema,
  BundleSignatureSchema,
  ReleaseManifestSchema,
  agentXError,
  sha256OfBytes,
  verifyBundleSignature,
  type BundleManifest,
} from "@agentx/contracts";
import { loadRelease, type LoadedRelease } from "../../deploy/release.js";

export interface VerifiedBundle {
  /** The directory the bundle was given in. Only the image archives are still read from here (the registry checks them by digest afterwards). */
  dir: string;
  /** A private copy (mode 0700, files 0400) of every other file, made while hashing it: the release, templates and packages are read from here, never from `dir` again. */
  copyDir: string;
  /** Removes the private copy. */
  cleanup(): Promise<void>;
  /** SHA-256 of bundle.json: what the customer approves and a restore point records. */
  bundleId: string;
  keyId: string;
  manifest: BundleManifest;
  release: LoadedRelease;
}

export interface VerifyBundleInput {
  dir: string;
  /** PEM public keys: the ones pinned in this agentx plus any the customer passed. Empty refuses every bundle. */
  trustedKeys: readonly string[];
  /** The bundle id the customer approved. A bundle with another id is refused. */
  approvedBundleSha256?: string;
}

const refuse = (message: string) => agentXError("CONFIG_INVALID", `bundle refused: ${message}; nothing was changed`);
/** A file name from the disk, shown without any character that could move the cursor or fake a line. */
const shown = (name: string): string => name.replace(/[^A-Za-z0-9._/-]/g, "?").slice(0, 120);

async function readBounded(path: string, max: number, what: string): Promise<Buffer> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) throw refuse(`${what} is missing`);
  if (!info.isFile()) throw refuse(`${what} is not a regular file`);
  if (info.size > max) throw refuse(`${what} is larger than allowed`);
  const data = await readFile(path);
  if (data.length > max) throw refuse(`${what} is larger than allowed`);
  return data;
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Copies `from` to `to` (mode 0400, parents 0700) and returns the size and SHA-256 of the bytes that were written. */
async function copyAndHash(from: string, to: string): Promise<{ sha256: string; bytes: number }> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytes = 0;
  const source = createReadStream(from);
  source.on("data", (chunk) => { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; });
  await pipeline(source, createWriteStream(to, { mode: 0o400 }));
  return { sha256: hash.digest("hex"), bytes };
}

/** Every regular file under `root`, "/"-separated and relative. A link, a device or any other kind is a refusal; so is a tree that is too large. */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 6) throw refuse("the directory nests deeper than a bundle does");
    for (const entry of await readdir(join(root, relative))) {
      const path = relative === "" ? entry : `${relative}/${entry}`;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile() && info.nlink > 1) throw refuse(`${shown(path)} has other names on the disk (a hard link)`);
      else if (info.isFile()) found.push(path);
      else throw refuse(`${shown(path)} is a link or a special file`);
      if (found.length > BUNDLE_MAX_FILES + 2) throw refuse("the directory holds more files than a bundle may");
    }
  };
  await walk("", 0);
  return found;
}

export async function verifyBundle(input: VerifyBundleInput): Promise<VerifiedBundle> {
  const root = await realpath(input.dir).catch(() => undefined);
  if (root === undefined) throw refuse("the bundle directory does not exist");
  if (!(await lstat(root)).isDirectory()) throw refuse("the bundle path is not a directory");
  if (input.trustedKeys.length === 0) throw refuse("this agentx pins no bundle signing key; pass --bundle-public-key <file> with the public key your release channel publishes");

  // 1. The signature, over the exact bytes that are parsed below.
  const manifestBytes = await readBounded(join(root, BUNDLE_MANIFEST_FILE), BUNDLE_MANIFEST_MAX_BYTES, BUNDLE_MANIFEST_FILE);
  const signatureBytes = await readBounded(join(root, BUNDLE_SIGNATURE_FILE), BUNDLE_SIGNATURE_MAX_BYTES, BUNDLE_SIGNATURE_FILE);
  let signature;
  try {
    signature = BundleSignatureSchema.parse(JSON.parse(signatureBytes.toString("utf8")));
  } catch {
    throw refuse(`${BUNDLE_SIGNATURE_FILE} is not a valid signature file`);
  }
  const checked = verifyBundleSignature({ manifestBytes, signature, trustedKeys: input.trustedKeys });
  if (!checked.ok) throw refuse(checked.reason);

  // 2. The bundle the customer approved.
  const bundleId = sha256OfBytes(manifestBytes);
  if (input.approvedBundleSha256 !== undefined && input.approvedBundleSha256.toLowerCase() !== bundleId) {
    throw refuse(`its id ${bundleId} is not the approved bundle ${input.approvedBundleSha256.slice(0, 64)}`);
  }

  // 3. The manifest.
  let manifest: BundleManifest;
  try {
    manifest = BundleManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  } catch {
    throw refuse(`${BUNDLE_MANIFEST_FILE} is not a valid bundle manifest`);
  }

  // 4. Exactly the listed files.
  const onDisk = await listFiles(root);
  const listed = new Set(manifest.files.map((entry) => entry.file));
  const expected = new Set([...listed, BUNDLE_MANIFEST_FILE, BUNDLE_SIGNATURE_FILE]);
  for (const file of onDisk) if (!expected.has(file)) throw refuse(`${shown(file)} is in the directory but not in the signed manifest`);
  const present = new Set(onDisk);
  for (const file of listed) if (!present.has(file)) throw refuse(`${file} is in the signed manifest but missing from the directory`);

  // 5. Every file's size and hash. Everything but the image archives is copied into a private directory WHILE it is hashed, so the bytes that were checked are the
  // bytes that are used (review I4); an image archive is hashed in place and checked again by digest when the registry has it.
  const copyDir = await mkdtemp(join(tmpdir(), "rovara-bundle-"));
  await chmod(copyDir, 0o700);
  const cleanup = async (): Promise<void> => { await rm(copyDir, { recursive: true, force: true }); };
  try {
    for (const entry of manifest.files) {
      const path = join(root, ...entry.file.split("/"));
      const real = await realpath(path).catch(() => undefined);
      if (real === undefined || !real.startsWith(root + sep)) throw refuse(`${entry.file} is outside the bundle directory`);
      const measured = entry.kind === "image" ? await hashFile(path) : await copyAndHash(path, join(copyDir, ...entry.file.split("/")));
      if (measured.bytes !== entry.bytes || measured.sha256 !== entry.sha256) throw refuse(`${entry.file} does not match the signed manifest`);
    }
    // The two signed files the verification itself read are kept as well, from the bytes it read, so the copy is a complete bundle apart from its images.
    await writeFile(join(copyDir, BUNDLE_MANIFEST_FILE), manifestBytes, { mode: 0o400 });
    await writeFile(join(copyDir, BUNDLE_SIGNATURE_FILE), signatureBytes, { mode: 0o400 });

  // 6. The release inside agrees with the bundle, entry by entry.
  let releaseManifest;
  try {
    releaseManifest = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(copyDir, "release.json"), "utf8")));
  } catch {
    throw refuse("release.json is not a valid release manifest");
  }
  if (releaseManifest.version !== manifest.version || releaseManifest.gitCommit !== manifest.gitCommit) throw refuse("release.json names another release than the bundle does");
  const byFile = new Map(manifest.files.map((entry) => [entry.file, entry]));
  const releaseEntries = [
    ...releaseManifest.templates.map((entry) => ({ ...entry, kind: "template" as const })),
    ...releaseManifest.packages.map((entry) => ({ ...entry, kind: "package" as const })),
    ...(releaseManifest.legalDocuments ?? []).map((entry) => ({ ...entry, kind: "legal" as const })),
  ];
  for (const entry of releaseEntries) {
    const bundled = byFile.get(entry.file);
    if (bundled === undefined || bundled.kind !== entry.kind || bundled.sha256 !== entry.sha256) throw refuse(`release.json lists ${entry.file} differently than the signed manifest`);
  }
  const releaseFiles = new Set(releaseEntries.map((entry) => entry.file));
  for (const entry of manifest.files) {
    if ((entry.kind === "template" || entry.kind === "package" || entry.kind === "legal") && !releaseFiles.has(entry.file)) throw refuse(`${entry.file} is in the bundle but not in release.json`);
  }
  for (const image of manifest.images) {
    const named = releaseManifest.images[image.name as "worker" | "slack" | "executor"];
    if (named !== undefined && named !== image.sourceRef) throw refuse(`image ${image.name} differs between release.json and the bundle`);
  }

  // The deploy engine's own loader re-reads and re-checks every template and package, from the private copy.
  const release = await loadRelease(copyDir).catch(() => {
    throw refuse("the release inside the bundle could not be loaded");
  });
  return { dir: root, copyDir, cleanup, bundleId, keyId: checked.keyId, manifest, release };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
