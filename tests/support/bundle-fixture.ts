// Test support for the signed release bundle (N2, N3): keys are generated at run time (no key material in the repository), the release is a tiny
// valid one, and the image exporter writes bytes instead of calling skopeo.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ReleaseManifestSchema, STACK_PARTS } from "@rovara-code/contracts";
import { LITELLM_SOURCE_IMAGE } from "../../infra/lib/bundle-images.js";
import { buildBundle, type BundleSigner, type ImageExporter } from "../../scripts/release/bundle.js";
import type { ImageLabelReader } from "../../scripts/release/image-flavor.js";
import { FAKE_ASSET, FAKE_PACKAGE_BYTES, SECOND_ASSET, SECOND_PACKAGE_BYTES, writeFakeKit, type FakeKitOptions } from "./synth-kit-fixture.js";

const sha = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export interface TestKey { publicKeyPem: string; signer: BundleSigner }
export function newTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { publicKeyPem, signer: { publicKeyPem, sign: async (message) => sign("sha256", message, { key: privateKey, dsaEncoding: "der" }) } };
}

export const WORKER_REF = `public.ecr.aws/agentx/agentx-worker@sha256:${"a".repeat(64)}`;
export const SLACK_REF = `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}`;
export const IMAGES = [{ name: "litellm", sourceRef: LITELLM_SOURCE_IMAGE }, { name: "worker", sourceRef: WORKER_REF }, { name: "slack", sourceRef: SLACK_REF }];
/** A minimal tar with an OCI index.json naming `digest`, as skopeo's oci-archive has, plus a blob so the archive is not only its index. */
export function ociArchive(digest: string, blob = "layer"): Buffer {
  const entry = (name: string, content: Buffer): Buffer => {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0" + "00", 257, "ascii");
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
  };
  return Buffer.concat([entry("index.json", Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest, size: 1 }] }))), entry("blobs/sha256/layer", Buffer.from(blob)), Buffer.alloc(1024)]);
}
/** Every image says it was built as a release (scripts/release/image-flavor.ts); bundle tests that are not about the flavor use this. */
export const RELEASE_LABELS: ImageLabelReader = async () => ({ "ai.rovara.catalog-flavor": "release" });

export const fakeExporter: ImageExporter = async (sourceRef, destFile) => {
  await mkdir(dirname(destFile), { recursive: true });
  await writeFile(destFile, ociArchive(/@(sha256:[a-f0-9]{64})$/.exec(sourceRef)![1]!));
};

/** A fake kit cannot pass the real self-checks (it is a stand-in, not the CDK app); the real ones run in synth-kit.test.ts on the real kit. */
export const NO_KIT_CHECK = async (): Promise<void> => undefined;

/** A small, schema-valid release directory. */
export async function writeRelease(dir: string, version = "1.4.0", templates: Partial<Record<string, object>> = {}, extraPackage = false): Promise<void> {
  const templateText = (part: string): string => `${JSON.stringify(templates[part] ?? { Resources: {} })}\n`;
  const pkg = Buffer.from(FAKE_PACKAGE_BYTES);
  const assetId = FAKE_ASSET;
  const second = Buffer.from(SECOND_PACKAGE_BYTES);
  const legal = "license text\n";
  const files: Record<string, string | Buffer> = { [`packages/${assetId}.zip`]: pkg, ...(extraPackage ? { [`packages/${SECOND_ASSET}.zip`]: second } : {}), "legal/LICENSE": legal };
  for (const part of STACK_PARTS) files[`templates/us-east-1/${part}.template.json`] = templateText(part);
  for (const [file, data] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), data);
  }
  const manifest = ReleaseManifestSchema.parse({
    schemaVersion: 1, version, gitCommit: "b".repeat(40), environmentPlaceholder: "qqenv-placeholderqq",
    templates: STACK_PARTS.map((part) => ({ region: "us-east-1", part, file: `templates/us-east-1/${part}.template.json`, sha256: sha(templateText(part)) })),
    packages: [{ assetId, file: `packages/${assetId}.zip`, sha256: sha(pkg), parts: ["control-plane"], bucketParameter: "B", keyParameter: "K", hashParameter: "H", keyParameterValue: `packages/||${assetId}.zip` },
      ...(extraPackage ? [{ assetId: SECOND_ASSET, file: `packages/${SECOND_ASSET}.zip`, sha256: sha(second), parts: ["control-plane" as const], bucketParameter: "B2", keyParameter: "K2", hashParameter: "H2", keyParameterValue: `packages/||${SECOND_ASSET}.zip` }] : [])],
    legalDocuments: [{ file: "legal/LICENSE", sha256: sha(legal) }],
    images: { worker: WORKER_REF, slack: SLACK_REF },
  });
  await writeFile(join(dir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export interface BuiltBundle { root: string; dir: string; bundleSha256: string; key: TestKey; cleanup(): Promise<void> }
export async function builtBundle(options: { version?: string; key?: TestKey; templates?: Partial<Record<string, object>>; kit?: FakeKitOptions; extraPackage?: boolean } = {}): Promise<BuiltBundle> {
  const root = await mkdtemp(join(tmpdir(), "bundle-test-"));
  const release = join(root, "release");
  await mkdir(release);
  await writeRelease(release, options.version, options.templates, options.extraPackage === true);
  const key = options.key ?? newTestKey();
  const dir = join(root, "bundle");
  const kitDir = join(root, "kit");
  if (options.kit !== undefined) await writeFakeKit(kitDir, { releaseSha256: sha(await readFile(join(release, "release.json"))), ...options.kit });
  const { bundleSha256 } = await buildBundle({ releaseDir: release, out: dir, images: IMAGES, readImageLabels: RELEASE_LABELS, exportImage: fakeExporter, signer: key.signer, notes: "Notes.\n", ...(options.kit === undefined ? {} : { synthKitDir: kitDir, kitCheck: NO_KIT_CHECK }) });
  return { root, dir, bundleSha256, key, cleanup: () => rm(root, { recursive: true, force: true }) };
}
