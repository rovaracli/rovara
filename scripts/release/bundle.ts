// Enterprise foundations, task N2: builds the signed release bundle from a release directory (scripts/release/build.ts output) and the
// images the install runs. The output is the release plus images/*.oci.tar, bundle.json (every file, its SHA-256 and size) and
// bundle.sig.json (a signature over bundle.json's exact bytes). Signing goes through a `BundleSigner`: a key REFERENCE (KMS) in the
// release pipeline, a runtime-generated key in tests. No private key material is read from, or written to, a file here.
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  BUNDLE_LITELLM_IMAGE_NAME,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_SIGNATURE_FILE,
  BundleImageName,
  BundleManifestSchema,
  SynthKitManifestSchema,
  type SynthKitManifest,
  ImageDigest,
  ReleaseManifestSchema,
  type ReleaseManifest,
  parseBundlePublicKey,
  sha256OfBytes,
  type BundleManifest,
} from "@agentx/contracts";
import { createHash } from "node:crypto";
import { LITELLM_SOURCE_IMAGE, imageDigestOf } from "../../infra/lib/bundle-images.js";
import { assertReleaseFlavorImage, skopeoLabelReader, type ImageLabelReader } from "./image-flavor.js";
import { ociArchiveDigests } from "./oci-archive.js";
import { reverifyKitBeforeSigning } from "./bundle-verify.js";
import { kmsBundleSigner, signManifestBytes, type BundleSigner } from "./bundle-signer.js";

export { kmsBundleSigner, type BundleSigner, type KmsLike } from "./bundle-signer.js";

const execFileAsync = promisify(execFile);

/** Writes the image named by `sourceRef` (a digest reference, every platform) to `destFile` as an OCI archive. */
export type ImageExporter = (sourceRef: string, destFile: string) => Promise<void>;

export interface BundleImageInput {
  name: string;
  sourceRef: string;
}

export interface BuildBundleInput {
  /** A release directory made by `release:build`. */
  releaseDir: string;
  /** Must be absent or empty. */
  out: string;
  images: readonly BundleImageInput[];
  exportImage: ImageExporter;
  /**
   * Signs bundle.json in this process. Absent: the bundle is PREPARED only (bundle.json written, no signature): the release workflow's signing job, which builds nothing, checks it again and signs it
   * (sign-bundle.ts). `release:bundle` in the build job never holds a signing permission.
   */
  signer?: BundleSigner;
  /**
   * The release's own pinned CDK app (task N3b): a directory with kit.json and the module it names, copied into the bundle under synth-kit/ and listed, hashed and signed with everything
   * else. An Enterprise install's templates are built from it at approval. Without it the bundle can be approved by a Public install only.
   */
  synthKitDir?: string;
  /** Release notes written into the bundle as notes/RELEASE-NOTES.md and hashed with everything else. */
  notes?: string;
  /**
   * SK-4: runs on the kit AS COPIED into the output folder, before anything is signed: the checkout is the release's commit and clean, and the kit's self-checks run again in the sandbox. Defaults to
   * `verifyKitForSigning` (release:bundle never passes one); a test double replaces it, as `exportImage` and `signer` are. A failure removes the output folder.
   */
  kitCheck?: (kit: { kitRoot: string; releaseDir: string; release: ReleaseManifest }) => Promise<void>;
  /** Reads an image's labels: the worker image must say catalog-flavor=release (scripts/release/image-flavor.ts). Defaults to skopeo; a test gives a fake. */
  readImageLabels?: ImageLabelReader;
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

async function claimOutDir(out: string): Promise<void> {
  try {
    if ((await readdir(out)).length > 0) throw new Error(`bundle output directory is not empty: ${out}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(out, { recursive: true });
  }
}

/** Copies one release file into the bundle, refusing a source that is not the regular file release.json describes. */
async function copyReleaseFile(releaseDir: string, out: string, file: string, expectedSha256: string): Promise<{ sha256: string; bytes: number }> {
  const source = join(releaseDir, file);
  const info = await lstat(source);
  if (!info.isFile()) throw new Error(`release file ${file} is not a regular file`);
  const target = join(out, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  const measured = await sha256OfFile(target);
  if (measured.sha256 !== expectedSha256) throw new Error(`release file ${file} does not match release.json; rebuild the release before bundling it`);
  return measured;
}

/**
 * The kit's files, relative and "/"-separated: regular files only (a link is refused), kit.json present and valid, and exactly the files kit.json lists by hash (SK-4): the entry, the code map and
 * the code packages. A file kit.json does not list, or a listed file that is missing, refuses the kit. The hashes are checked again against the copied bytes (`verifyKitCopy`).
 */
async function listKitFiles(root: string): Promise<{ files: string[]; kit: SynthKitManifest }> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 6) throw new Error("the synthesis kit nests deeper than allowed");
    for (const entry of await readdir(join(root, relative))) {
      const path = relative === "" ? entry : `${relative}/${entry}`;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) found.push(path);
      else throw new Error(`the synthesis kit holds a link or a special file (${path})`);
    }
  };
  await walk("", 0);
  if (!found.includes("kit.json")) throw new Error("the synthesis kit has no kit.json");
  const kit = SynthKitManifestSchema.parse(JSON.parse(await readFile(join(root, "kit.json"), "utf8")));
  if (!found.includes(kit.entry.replace(/^synth-kit\//, ""))) throw new Error("the synthesis kit's entry is not in the kit");
  const listed = Object.keys(kit.files).sort();
  const others = found.filter((file) => file !== "kit.json").sort();
  const extra = others.filter((file) => !listed.includes(file));
  if (extra.length > 0) throw new Error(`the synthesis kit holds a file kit.json does not list (${extra[0] ?? ""}); only the files release:kit wrote are signed`);
  const missing = listed.filter((file) => !others.includes(file));
  if (missing.length > 0) throw new Error(`the synthesis kit is missing a file kit.json lists (${missing[0] ?? ""})`);
  return { files: found.sort(), kit };
}

/** The bytes just copied into the bundle are the bytes kit.json names (the kit was not changed after release:kit wrote it, nor while it was being copied). */
function verifyKitCopy(kit: SynthKitManifest, file: string, copied: { sha256: string }): void {
  if (file === "kit.json") return;
  if (kit.files[file] !== copied.sha256) throw new Error(`the synthesis kit file ${file} is not what kit.json lists (it was changed after release:kit made it); make the kit again from this release`);
}

/** The signing step's own check of a kit: a clean checkout of the release's commit, and the kit's self-checks again in the sandbox. Loaded here, not at the top: it brings in the whole release build. */
async function defaultKitCheck(kit: { kitRoot: string; releaseDir: string; release: ReleaseManifest }): Promise<void> {
  const { verifyKitForSigning } = await import("./synth-kit.js");
  await verifyKitForSigning({ kitRoot: kit.kitRoot, releaseDir: kit.releaseDir, release: kit.release });
}

/** Builds the bundle; on any failure the output directory it claimed is removed, so a half-written bundle is never left to be mistaken for one. */
export async function buildBundle(input: BuildBundleInput): Promise<{ manifest: BundleManifest; bundleSha256: string }> {
  const claimed: { out?: string } = {};
  try {
    return await buildBundleInto(input, claimed);
  } catch (error) {
    if (claimed.out !== undefined) await rm(claimed.out, { recursive: true, force: true });
    throw error;
  }
}

async function buildBundleInto(input: BuildBundleInput, claimed: { out?: string }): Promise<{ manifest: BundleManifest; bundleSha256: string }> {
  const releaseDir = resolve(input.releaseDir);
  const out = resolve(input.out);

  // Everything that can be refused is refused before the output directory is touched.
  if (input.signer !== undefined) parseBundlePublicKey(input.signer.publicKeyPem);
  const names = new Set<string>();
  for (const image of input.images) {
    if (!BundleImageName.safeParse(image.name).success) throw new Error(`image name ${JSON.stringify(image.name)} is not a valid bundle image name`);
    if (!ImageDigest.safeParse(image.sourceRef).success) throw new Error(`image ${image.name} must be referenced by digest, not ${JSON.stringify(image.sourceRef)}`);
    if (names.has(image.name)) throw new Error(`image ${image.name} is listed twice`);
    names.add(image.name);
  }
  // The Enterprise templates run LiteLLM by this digest from the install's ECR: the bundle must carry exactly that image.
  const litellm = input.images.find((image) => image.name === BUNDLE_LITELLM_IMAGE_NAME);
  if (litellm === undefined) throw new Error("an Enterprise bundle must carry the LiteLLM image (name litellm)");
  if (imageDigestOf(litellm.sourceRef) !== imageDigestOf(LITELLM_SOURCE_IMAGE)) {
    throw new Error("the litellm image is not the digest the templates pin; update infra/lib/bundle-images.ts and the templates together");
  }
  const release = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8")));
  // Every image the release names is mirrored (review I6): the install pulls nothing from a public registry at run time.
  for (const name of ["worker", "slack", "executor", "embedder"] as const) {
    const named = release.images[name];
    if (named === undefined) continue;
    const bundled = input.images.find((image) => image.name === name);
    if (bundled === undefined) throw new Error(`the release names a ${name} image (${named}); the bundle must mirror it`);
    if (bundled.sourceRef !== named) throw new Error(`the ${name} image given is not the one release.json names`);
  }
  // The worker image is built by Docker from whatever tree it was given, so it is checked by its label, before the output folder is touched.
  for (const image of input.images) {
    if (image.name === "worker") await assertReleaseFlavorImage("worker", image.sourceRef, input.readImageLabels ?? skopeoLabelReader);
  }
  await claimOutDir(out);
  claimed.out = out;

  const files: BundleManifest["files"] = [];
  const releaseJson = join(out, "release.json");
  await copyFile(join(releaseDir, "release.json"), releaseJson);
  const releaseJsonHash = await sha256OfFile(releaseJson);
  files.push({ file: "release.json", kind: "release-manifest", ...releaseJsonHash });
  for (const entry of release.templates) files.push({ file: entry.file, kind: "template", ...(await copyReleaseFile(releaseDir, out, entry.file, entry.sha256)) });
  // Both lists are signed as packages: the second holds the code only an Enterprise install's stacks use, and a build made at approval may use no package the signed manifest does not list.
  for (const entry of [...release.packages, ...(release.enterprisePackages ?? [])]) files.push({ file: entry.file, kind: "package", ...(await copyReleaseFile(releaseDir, out, entry.file, entry.sha256)) });
  for (const entry of release.legalDocuments ?? []) files.push({ file: entry.file, kind: "legal", ...(await copyReleaseFile(releaseDir, out, entry.file, entry.sha256)) });

  if (input.synthKitDir !== undefined) {
    const { files: kitFiles, kit } = await listKitFiles(resolve(input.synthKitDir));
    // The kit is bound to one release: the hash of this release.json and its commit. A kit made from another release (or another commit) is never signed into this bundle.
    if (kit.releaseSha256 !== releaseJsonHash.sha256 || kit.gitCommit !== release.gitCommit) throw new Error("the synthesis kit was made from a different release than the one being bundled; make it again from this release (release:kit)");
    for (const file of kitFiles) {
      const target = join(out, "synth-kit", ...file.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(resolve(input.synthKitDir), ...file.split("/")), target);
      const copied = await sha256OfFile(target);
      verifyKitCopy(kit, file, copied);
      files.push({ file: `synth-kit/${file}`, kind: "synth-kit", ...copied });
    }
    // SK-4: the self-checks run again on the copy that is about to be signed (not on the folder it came from, which could change while this runs).
    await (input.kitCheck ?? defaultKitCheck)({ kitRoot: join(out, "synth-kit"), releaseDir, release });
  }

  if (input.notes !== undefined) {
    await mkdir(join(out, "notes"), { recursive: true });
    await writeFile(join(out, "notes", "RELEASE-NOTES.md"), input.notes, "utf8");
    files.push({ file: "notes/RELEASE-NOTES.md", kind: "notes", ...(await sha256OfFile(join(out, "notes", "RELEASE-NOTES.md"))) });
  }

  const images: BundleManifest["images"] = [];
  await mkdir(join(out, "images"), { recursive: true });
  for (const image of [...input.images].sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `images/${image.name}.oci.tar`;
    await input.exportImage(image.sourceRef, join(out, file));
    // The archive must hold the very digest the signed manifest will promise; a converted manifest has another digest (review I7).
    const held = await ociArchiveDigests(join(out, file)).catch((): string[] => []);
    if (!held.includes(imageDigestOf(image.sourceRef))) throw new Error(`the exported archive of image ${image.name} does not hold ${imageDigestOf(image.sourceRef)}`);
    files.push({ file, kind: "image", ...(await sha256OfFile(join(out, file))) });
    images.push({ name: image.name, sourceRef: image.sourceRef, file });
  }

  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  // SK-4: the kit in the output folder is measured once more, from its bytes, immediately before the signature; a signing key is never used on a kit that differs from kit.json.
  if (input.synthKitDir !== undefined) await reverifyKitBeforeSigning({ kitRoot: join(out, "synth-kit"), releaseJsonSha256: releaseJsonHash.sha256, release, manifestFiles: files });
  const manifest = BundleManifestSchema.parse({ schemaVersion: 1, format: "rovara-release-bundle", version: release.version, gitCommit: release.gitCommit, files, images } satisfies BundleManifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const bundleSha256 = sha256OfBytes(manifestBytes);
  await writeFile(join(out, BUNDLE_MANIFEST_FILE), manifestBytes);
  if (input.signer !== undefined) {
    // The signer is checked against its own published key before the signature is written, so a mismatched key reference cannot produce a bundle nobody can verify.
    const signature = await signManifestBytes(input.signer, manifestBytes);
    await writeFile(join(out, BUNDLE_SIGNATURE_FILE), `${JSON.stringify(signature, null, 2)}\n`, "utf8");
  }
  return { manifest, bundleSha256 };
}

/** skopeo copies every platform of the image, so the archive keeps the digest the templates pin. */
export const skopeoImageExporter: ImageExporter = async (sourceRef, destFile) => {
  await execFileAsync("skopeo", ["copy", "--all", "--preserve-digests", `docker://${sourceRef}`, `oci-archive:${destFile}`], { maxBuffer: 16 * 1024 * 1024 });
};

function usage(): string {
  return "Usage: tsx scripts/release/bundle.ts --release <dir> --out <dir> (--kms-key <key id or ARN> | --unsigned) --image <name>=<repo@sha256:...> [--image ...] [--synth-kit <dir>] [--notes <file>]\n(The litellm image is required. --synth-kit takes the folder `release:kit` made from this release: without it the bundle can be approved by a Public install only. --unsigned writes bundle.json and no signature: the release workflow's signing job checks the folder again and signs it. AWS calls go through the pipeline's own credentials; this script never reads a private key.)\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const values = (flag: string): string[] => argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ""] : []));
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(usage());
  } else {
    (async () => {
      const [release] = values("--release");
      const [out] = values("--out");
      const [kmsKey] = values("--kms-key");
      const [notesFile] = values("--notes");
      const [synthKit] = values("--synth-kit");
      const unsigned = argv.includes("--unsigned");
      if (!release || !out) throw new Error("--release and --out are required");
      if (unsigned === (kmsKey !== undefined)) throw new Error("give exactly one of --kms-key (sign here) or --unsigned (prepare the bundle for the signing job, which checks it again and signs it)");
      const images = values("--image").map((value) => {
        const [name, ...rest] = value.split("=");
        return { name: name ?? "", sourceRef: rest.join("=") };
      });
      let signer: BundleSigner | undefined;
      if (kmsKey !== undefined) {
        const { KMSClient, GetPublicKeyCommand, SignCommand } = await import("@aws-sdk/client-kms");
        signer = await kmsBundleSigner({ client: new KMSClient({}), keyId: kmsKey, commands: { GetPublicKeyCommand, SignCommand } });
      }
      const result = await buildBundle({
        releaseDir: release, out: resolve(out), images, exportImage: skopeoImageExporter, ...(signer === undefined ? {} : { signer }),
        ...(synthKit === undefined ? {} : { synthKitDir: resolve(synthKit) }),
        ...(notesFile === undefined ? {} : { notes: await readFile(notesFile, "utf8") }),
      });
      process.stdout.write(`wrote bundle ${result.manifest.version} id ${result.bundleSha256} to ${resolve(out)}\n`);
    })().catch((error: unknown) => {
      process.stderr.write(`rovara bundle build failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
