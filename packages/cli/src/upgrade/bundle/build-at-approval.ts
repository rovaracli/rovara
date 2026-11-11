// Enterprise upgrades are built AT APPROVAL (owner decision 2026-10-31, option A): the install's exact templates and packages, made from the signed release's own
// pinned CDK app and the install's recorded settings, and from nothing else. Deterministic: the same bundle and the same recorded settings are the same bytes, so
// the same hash, on any machine, in any directory, at any time. The result is described by a manifest only this code writes (the kit writes files, never the manifest).
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_PARTS, BuiltManifestSchema, SYNTH_KIT_MANIFEST_FILE, SYNTH_OUTPUT_FILE, SynthKitManifestSchema, SynthOutputSchema, builtPackageFile, builtTemplateFile, sha256OfBytes, synthContext, synthKitSha256, synthSettingsSha256, type BuiltManifest, type BuiltPart, type SynthSettings } from "@agentx/cloud-contracts";
import { agentXError, canonicalJson } from "@rovara-code/contracts";
import { ENVIRONMENT_PLACEHOLDER } from "@rovara-code/contracts";
import type { SynthRunner } from "./synth-run.js";
import type { VerifiedBundle } from "./verify.js";

/** A CloudFormation template read from a bucket is at most 1 MiB; this allows a little more and refuses the rest. */
const MAX_TEMPLATE_BYTES = 1_100_000;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGES = 200;

export interface BuiltBundle {
  manifest: BuiltManifest;
  /** The exact bytes of built/manifest.json: their SHA-256 is the hash of the result. */
  manifestBytes: Buffer;
  resultSha256: string;
  /** Every file of the build, by path in the approval bucket under approved/<id>/ (the manifest included). */
  files: Array<{ file: string; body: Buffer }>;
  kitSha256: string;
  settingsSha256: string;
}

/** A name from a kit shown only if it looks like an id. */
const shownId = (id: string): string => (/^[A-Za-z0-9]{1,128}$/.test(id) ? id : "?");
const refuse = (message: string) => agentXError("CONFIG_INVALID", `the build was refused: ${message}; nothing was approved`);

/** The text a template is stored as: parsed, keys sorted at every level, two-space indent, one trailing newline. Formatting the kit chose has no effect on the hash. */
const templateText = (value: unknown): string => `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

async function regularFile(path: string, max: number, what: string): Promise<Buffer> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) throw refuse(`${what} was not produced`);
  if (!info.isFile() || info.nlink > 1) throw refuse(`${what} is not a plain file`);
  if (info.size > max) throw refuse(`${what} is larger than allowed`);
  return readFile(path);
}

/** Every path under `root` (files only, relative, "/"-separated). A link or any special file is a refusal. */
async function listOutput(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 4) throw refuse("the kit's output nests deeper than a build does");
    for (const entry of await readdir(join(root, relative))) {
      const path = relative === "" ? entry : `${relative}/${entry}`;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) found.push(path);
      else throw refuse("the kit's output holds a link or a special file");
      if (found.length > MAX_PACKAGES + BUILT_PARTS.length + 2) throw refuse("the kit wrote more files than a build holds");
    }
  };
  await walk("", 0);
  return found;
}

export function requiredParts(identityMode: "cognito" | "oidc"): BuiltPart[] {
  return BUILT_PARTS.filter((part) => part !== "identity" || identityMode !== "oidc");
}

/**
 * Runs the bundle's kit with the recorded settings and returns what it built, checked. `bundle` is a VERIFIED bundle: the kit is read from its private copy, whose bytes were
 * hashed against the signed manifest while they were copied. The context the kit gets is `synthContext(settings)` and nothing else; the recorded settings are the install's.
 */
export async function buildAtApproval(input: { bundle: VerifiedBundle; settings: SynthSettings; runner: SynthRunner; nodeMajor?: number }): Promise<BuiltBundle> {
  const { bundle, settings } = input;
  const kitEntries = bundle.manifest.files.filter((entry) => entry.kind === "synth-kit");
  if (kitEntries.length === 0) throw refuse("this bundle carries no synthesis kit, so an Enterprise install's templates cannot be built from it");
  const kitBytes = await readFile(join(bundle.copyDir, ...SYNTH_KIT_MANIFEST_FILE.split("/")));
  let kit;
  try {
    kit = SynthKitManifestSchema.parse(JSON.parse(kitBytes.toString("utf8")));
  } catch {
    throw refuse("the synthesis kit's manifest is not valid");
  }
  if (!kitEntries.some((entry) => entry.file === kit.entry)) throw refuse("the kit's entry is not one of the files the signed bundle lists");
  // The kit names the release it was made from; it must be the release this bundle carries.
  const signedRelease = bundle.manifest.files.find((entry) => entry.file === "release.json");
  if (signedRelease === undefined || kit.releaseSha256 !== signedRelease.sha256 || kit.gitCommit !== bundle.manifest.gitCommit) throw refuse("the synthesis kit was made from another release than this bundle's");
  const major = input.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  if (kit.nodeMajor !== major) throw refuse(`the kit was built for Node ${String(kit.nodeMajor)} and this agentx runs on Node ${String(major)}`);

  // Real paths: the permission model compares the paths a kit opens (resolved) with the ones it was allowed, and a temp directory may sit behind a link (macOS /var).
  const workRoot = await realpath(await mkdtemp(join(tmpdir(), "rovara-build-")));
  const kitRoot = await realpath(bundle.copyDir);
  try {
    const workDir = join(workRoot, "work");
    const outDir = join(workRoot, "out");
    await mkdir(workDir, { mode: 0o700 });
    await mkdir(outDir, { mode: 0o700 });
    // The kit is confined to these directories (where the platform can), so the ones it writes into exist already.
    await mkdir(join(outDir, "templates"), { mode: 0o700 });
    await mkdir(join(outDir, "packages"), { mode: 0o700 });
    const contextFile = join(workDir, "context.json");
    // The whole of the kit's input: the install's fixed values and its recorded settings. Written here, canonical, nothing merged in from anywhere.
    await writeFile(contextFile, canonicalJson({ context: synthContext(settings) }), { mode: 0o400 });
    await input.runner.run({ entry: join(kitRoot, ...kit.entry.split("/")), kitDir: join(kitRoot, "synth-kit"), contextFile, outDir, workDir });
    return await collect({ bundle, settings, outDir });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function collect(input: { bundle: VerifiedBundle; settings: SynthSettings; outDir: string }): Promise<BuiltBundle> {
  const { bundle, settings, outDir } = input;
  let output;
  try {
    output = SynthOutputSchema.parse(JSON.parse((await regularFile(join(outDir, SYNTH_OUTPUT_FILE), 1_000_000, SYNTH_OUTPUT_FILE)).toString("utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("the build was refused")) throw error;
    throw refuse(`${SYNTH_OUTPUT_FILE} is not valid`);
  }
  const parts = requiredParts(settings.identityMode);
  const expectedFiles = new Set<string>([SYNTH_OUTPUT_FILE, ...parts.map((part) => `templates/${part}.template.json`), ...output.packages.map((pkg) => `packages/${pkg.assetId}.zip`)]);
  const onDisk = await listOutput(outDir);
  for (const file of onDisk) if (!expectedFiles.has(file)) throw refuse("the kit wrote a file the build does not use");
  for (const file of expectedFiles) if (!onDisk.includes(file)) throw refuse("the kit did not write a file it declared");
  if (new Set(output.packages.map((pkg) => pkg.assetId)).size !== output.packages.length) throw refuse("the kit declared a package twice");
  if (output.packages.length > MAX_PACKAGES) throw refuse("the kit declared more packages than a build holds");

  const files: Array<{ file: string; body: Buffer }> = [];
  const templates: BuiltManifest["templates"] = [];
  const parsedTemplates = new Map<BuiltPart, { Parameters?: Record<string, unknown> }>();
  for (const part of parts) {
    const raw = await regularFile(join(outDir, "templates", `${part}.template.json`), MAX_TEMPLATE_BYTES, `the ${part} template`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw refuse(`the ${part} template is not JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { Resources?: unknown }).Resources === undefined) throw refuse(`the ${part} template is not a template`);
    const text = templateText(parsed);
    // A template still holding the release's placeholder environment was not built for this install.
    if (text.includes(ENVIRONMENT_PLACEHOLDER)) throw refuse(`the ${part} template was built for no install (it still holds the release's placeholder name)`);
    const body = Buffer.from(text, "utf8");
    if (body.length > MAX_TEMPLATE_BYTES) throw refuse(`the ${part} template is larger than allowed`);
    parsedTemplates.set(part, parsed);
    files.push({ file: builtTemplateFile(part), body });
    templates.push({ part, file: builtTemplateFile(part), sha256: sha256OfBytes(body), bytes: body.length });
  }
  const packages: BuiltManifest["packages"] = [];
  for (const pkg of [...output.packages].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0))) {
    const body = await regularFile(join(outDir, "packages", `${pkg.assetId}.zip`), MAX_PACKAGE_BYTES, `package ${shownId(pkg.assetId)}`);
    // Lambda code does not depend on the install's settings, so every package of the build is the SIGNED release's package for that asset id, byte for byte. The kit makes templates;
    // it does not get to make code (review I3). A package the release does not list is refused: there is no exception.
    const signedPackage = bundle.manifest.files.find((entry) => entry.kind === "package" && entry.file === `packages/${pkg.assetId}.zip`);
    if (signedPackage === undefined) throw refuse(`package ${shownId(pkg.assetId)} is not one the signed release lists`);
    if (signedPackage.sha256 !== sha256OfBytes(body) || signedPackage.bytes !== body.length) throw refuse(`package ${shownId(pkg.assetId)} is not the signed release's package`);
    for (const part of pkg.parts) {
      const declared = parsedTemplates.get(part)?.Parameters;
      // The package's code location must be parameters its stack declares: otherwise the deployer could not point the stack at the bytes it verified.
      if (declared === undefined || declared[pkg.bucketParameter] === undefined || declared[pkg.keyParameter] === undefined) throw refuse(`package ${pkg.assetId} names parameters the ${part} template does not declare`);
    }
    files.push({ file: builtPackageFile(pkg.assetId), body });
    packages.push({ assetId: pkg.assetId, file: builtPackageFile(pkg.assetId), sha256: sha256OfBytes(body), bytes: body.length, parts: [...pkg.parts].sort(), bucketParameter: pkg.bucketParameter, keyParameter: pkg.keyParameter, hashParameter: pkg.hashParameter });
  }
  // Every asset a template asks for by parameter has bytes in the build.
  for (const [part, template] of parsedTemplates) {
    for (const name of Object.keys(template.Parameters ?? {})) {
      if (name.startsWith("AssetParameters") && !packages.some((pkg) => pkg.parts.includes(part) && [pkg.bucketParameter, pkg.keyParameter, pkg.hashParameter].includes(name))) {
        throw refuse(`the ${part} template asks for code (${name}) that the build does not hold`);
      }
    }
  }

  const manifest = BuiltManifestSchema.parse({
    schemaVersion: 1, format: "rovara-approved-build", bundleId: bundle.bundleId, version: bundle.manifest.version, gitCommit: bundle.manifest.gitCommit,
    env: settings.env, region: settings.region, kitSha256: synthKitSha256(bundle.manifest.files), settingsSha256: synthSettingsSha256(settings), templates, packages,
  } satisfies BuiltManifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2)}\n`, "utf8");
  files.unshift({ file: "built/manifest.json", body: manifestBytes });
  return { manifest, manifestBytes, resultSha256: sha256OfBytes(manifestBytes), files, kitSha256: manifest.kitSha256, settingsSha256: manifest.settingsSha256 };
}
