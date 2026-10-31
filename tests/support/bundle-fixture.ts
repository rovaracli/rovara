// Test support for the signed release bundle (N2, N3): keys are generated at run time (no key material in the repository), the release is a tiny
// valid one, and the image exporter writes bytes instead of calling skopeo.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ReleaseManifestSchema, STACK_PARTS } from "@agentx/contracts";
import { LITELLM_SOURCE_IMAGE } from "../../infra/lib/bundle-images.js";
import { buildBundle, type BundleSigner, type ImageExporter } from "../../scripts/release/bundle.js";

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
export const fakeExporter: ImageExporter = async (sourceRef, destFile) => {
  await mkdir(dirname(destFile), { recursive: true });
  await writeFile(destFile, `oci-archive-bytes:${sourceRef}`);
};

/** A small, schema-valid release directory. */
export async function writeRelease(dir: string, version = "1.4.0"): Promise<void> {
  const template = `${JSON.stringify({ Resources: {} })}\n`;
  const pkg = Buffer.from("zip-bytes");
  const assetId = sha("asset");
  const legal = "license text\n";
  const files: Record<string, string | Buffer> = { [`packages/${assetId}.zip`]: pkg, "legal/LICENSE": legal };
  for (const part of STACK_PARTS) files[`templates/us-east-1/${part}.template.json`] = template;
  for (const [file, data] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), data);
  }
  const manifest = ReleaseManifestSchema.parse({
    schemaVersion: 1, version, gitCommit: "b".repeat(40), environmentPlaceholder: "qqenv-placeholderqq",
    templates: STACK_PARTS.map((part) => ({ region: "us-east-1", part, file: `templates/us-east-1/${part}.template.json`, sha256: sha(template) })),
    packages: [{ assetId, file: `packages/${assetId}.zip`, sha256: sha(pkg), parts: ["control-plane"], bucketParameter: "B", keyParameter: "K", hashParameter: "H", keyParameterValue: `packages/||${assetId}.zip` }],
    legalDocuments: [{ file: "legal/LICENSE", sha256: sha(legal) }],
    images: { worker: WORKER_REF, slack: SLACK_REF },
  });
  await writeFile(join(dir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export interface BuiltBundle { root: string; dir: string; bundleSha256: string; key: TestKey; cleanup(): Promise<void> }
export async function builtBundle(options: { version?: string; key?: TestKey } = {}): Promise<BuiltBundle> {
  const root = await mkdtemp(join(tmpdir(), "bundle-test-"));
  const release = join(root, "release");
  await mkdir(release);
  await writeRelease(release, options.version);
  const key = options.key ?? newTestKey();
  const dir = join(root, "bundle");
  const { bundleSha256 } = await buildBundle({ releaseDir: release, out: dir, images: IMAGES, exportImage: fakeExporter, signer: key.signer, notes: "Notes.\n" });
  return { root, dir, bundleSha256, key, cleanup: () => rm(root, { recursive: true, force: true }) };
}
