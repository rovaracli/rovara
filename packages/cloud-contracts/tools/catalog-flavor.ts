// The staging build path's one switch (test services slice 1), and the strip that makes a release build contain no staging key at all.
//   npx tsx packages/contracts/tools/catalog-flavor.ts staging|release [--root <checkout>]
// It rewrites TWO generated files of the contracts package, from the tree's own sources:
//   packages/contracts/src/catalog-build-flavor.ts   the flavor line ("release" or "staging");
//   packages/contracts/src/catalog-staging-keys.ts   the staging-only catalog signing keys: for a "staging" flavor the keys of environments/service-catalog/staging-signing-key.json (an array of
//                                                    {keyId, publicKey, algorithm}; no file means none), for "release" the EMPTY list. Both files are committed as release and empty.
// The worker Dockerfile runs it from its CATALOG_FLAVOR build argument, so the image's flavor is the argument and not whatever the checkout says; the staging release path (scripts/test-deploy.ts, the "ecr-push" step) passes
// CATALOG_FLAVOR=staging and nothing else does. scripts/release/build.ts refuses a tree whose files or compiled output are not release and empty (`assertReleaseCatalogTree`).
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FLAVOR_FILE = "packages/contracts/src/catalog-build-flavor.ts";
export const STAGING_KEYS_FILE = "packages/contracts/src/catalog-staging-keys.ts";
export const STAGING_KEY_DATA_FILE = "environments/service-catalog/staging-signing-key.json";
const LINE = /^export const CATALOG_BUILD_FLAVOR: "release" \| "staging" = "(?:release|staging)";$/mu;
const KEYS_LINE = /^export const CATALOG_STAGING_ONLY_SIGNING_KEYS: readonly CatalogSigningKey\[\] = [\s\S]*?;$/mu;
const KEY_PEM = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/u;

/** The flavor file's text with the flavor set. Throws when the file is not the one line it expects, so a hand-edited file is never silently rewritten. */
export function withFlavor(text: string, flavor: "release" | "staging"): string {
  if (flavor !== "release" && flavor !== "staging") throw new Error("the flavor is release or staging");
  if (text.match(new RegExp(LINE.source, "gmu"))?.length !== 1) throw new Error("catalog-build-flavor.ts is not in the expected form");
  return text.replace(LINE, `export const CATALOG_BUILD_FLAVOR: "release" | "staging" = "${flavor}";`);
}

/** The keys file's text with the list set. Each key is checked: a 64-hex id, the one algorithm and a PEM public key. */
export function withStagingKeys(text: string, keys: readonly unknown[]): string {
  if (text.match(new RegExp(KEYS_LINE.source, "gmu"))?.length !== 1) throw new Error("catalog-staging-keys.ts is not in the expected form");
  const rows = keys.map((key) => {
    const row = key as { keyId?: unknown; publicKey?: unknown; algorithm?: unknown } | null;
    if (typeof row !== "object" || row === null || typeof row.keyId !== "string" || !/^[a-f0-9]{64}$/u.test(row.keyId) || row.algorithm !== "ECDSA_SHA_256" || typeof row.publicKey !== "string" || !KEY_PEM.test(row.publicKey)) {
      throw new Error("a staging-only signing key is {keyId (64 hex), publicKey (PEM), algorithm ECDSA_SHA_256}");
    }
    return `  { keyId: ${JSON.stringify(row.keyId)}, algorithm: "ECDSA_SHA_256", publicKey: ${JSON.stringify(row.publicKey)} },`;
  });
  const list = rows.length === 0 ? "[]" : `[\n${rows.join("\n")}\n]`;
  return text.replace(KEYS_LINE, () => `export const CATALOG_STAGING_ONLY_SIGNING_KEYS: readonly CatalogSigningKey[] = ${list};`);
}

/** Sets both generated files under `root`. A release flavor writes the EMPTY list whatever data file exists; a staging flavor reads the data file (no file: none). */
export async function setCatalogFlavor(root: string, flavor: "release" | "staging"): Promise<void> {
  const flavorFile = join(root, FLAVOR_FILE);
  const keysFile = join(root, STAGING_KEYS_FILE);
  let keys: unknown[] = [];
  if (flavor === "staging") {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, STAGING_KEY_DATA_FILE), "utf8"));
      if (!Array.isArray(parsed)) throw new Error("staging-signing-key.json is an array of keys");
      keys = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const nextFlavor = withFlavor(await readFile(flavorFile, "utf8"), flavor);
  const nextKeys = withStagingKeys(await readFile(keysFile, "utf8"), keys);
  await writeFile(flavorFile, nextFlavor);
  await writeFile(keysFile, nextKeys);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flavor = process.argv[2];
  const rootAt = process.argv.indexOf("--root");
  const root = rootAt > 0 ? resolve(process.argv[rootAt + 1] ?? ".") : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (flavor !== "release" && flavor !== "staging") {
    process.stderr.write("usage: catalog-flavor.ts release|staging [--root <checkout>]\n");
    process.exitCode = 2;
  } else {
    setCatalogFlavor(root, flavor).then(() => process.stdout.write(`catalog build flavor: ${flavor}\n`), (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`);
      process.exitCode = 1;
    });
  }
}
