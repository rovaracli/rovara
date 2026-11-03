// SK-4: the release workflow's signing job. It is the only job that holds the OIDC token and the signing permission, and it builds nothing: it takes the folder `release:bundle --unsigned` made (as an artifact),
// checks it again from its bytes (verifyPreparedBundle: every file, the kit against kit.json, the images' digests), signs the exact bytes of bundle.json with the KMS key and writes bundle.sig.json.
// The workflow builds it in the signing job itself, from the tagged commit's source (esbuild from scripts/release/signer's own small, hash-locked package, installed with --ignore-scripts); it never runs a file
// that came from the build job's artifact, which is data.
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLE_SIGNATURE_FILE } from "@agentx/contracts";
import { kmsBundleSigner, signManifestBytes, type BundleSigner } from "./bundle-signer.js";
import { verifyPreparedBundle } from "./bundle-verify.js";

/** Checks the folder and signs it. A failure writes no signature. */
/** `signer` may be made lazily: the folder is checked first, so a bundle that fails its checks never reaches KMS at all (not even to read the public key). */
export async function signPreparedBundle(input: { dir: string; signer: BundleSigner | (() => Promise<BundleSigner>); requireKit: boolean }): Promise<{ bundleSha256: string; version: string }> {
  const dir = resolve(input.dir);
  const { manifestBytes, manifest } = await verifyPreparedBundle({ dir, requireKit: input.requireKit });
  const signer = typeof input.signer === "function" ? await input.signer() : input.signer;
  const signature = await signManifestBytes(signer, manifestBytes);
  await writeFile(join(dir, BUNDLE_SIGNATURE_FILE), `${JSON.stringify(signature, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { bundleSha256: signature.bundleSha256, version: manifest.version };
}

// realpath: the runner may reach the file through a symlink, and the main-module check compares resolved URLs.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
  (async () => {
    const dir = value("--bundle");
    const kmsKey = value("--kms-key");
    if (!dir || !kmsKey) throw new Error("Usage: sign-bundle --bundle <folder made by release:bundle --unsigned> --kms-key <key id or ARN> [--allow-no-kit]");
    const signer = async (): Promise<BundleSigner> => {
      const { KMSClient, GetPublicKeyCommand, SignCommand } = await import("@aws-sdk/client-kms");
      return kmsBundleSigner({ client: new KMSClient({}), keyId: kmsKey, commands: { GetPublicKeyCommand, SignCommand } });
    };
    const result = await signPreparedBundle({ dir, signer, requireKit: !argv.includes("--allow-no-kit") });
    process.stdout.write(`signed bundle ${result.version} id ${result.bundleSha256}\n`);
  })().catch((error: unknown) => {
    process.stderr.write(`rovara bundle signing failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
