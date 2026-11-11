// The SBOMs, scans and signed statements behind this signature are NOT in the repo (megabytes): ~/web/rovara-research-2026-10-26/test-services-evidence/2026-11-04-rev2/ (README there), from GitHub run 41848024467 of the emulator image.
// Test services, the staging pin: the catalog this tree SHIPS (environments/service-catalog/catalog.json and catalog.sig.json, pinned at revision 3 and signed with the staging-only key) is trusted by a STAGING-flavor build
// running in the staging account, and by nothing else. A release-flavor build (the committed state of every release) does not contain the key, so it refuses the same files with "no trusted catalog key".
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG_STAGING_ACCOUNT_ID, CATALOG_STAGING_ONLY_SIGNING_KEYS, loadSignedCatalog } from "@agentx/cloud-contracts";
import { CatalogSignatureSchema, ServiceCatalogSchema, parseBundlePublicKey, sha256HexOf, type CatalogSigningKey } from "@rovara-code/contracts";
import { loadSignedCatalogWithKeys, trustedKeyPemsFor } from "@agentx/cloud-contracts/testing";
import { FLAVOR_FILE, STAGING_KEYS_FILE, STAGING_KEY_DATA_FILE, setCatalogFlavor } from "../../packages/cloud-contracts/tools/catalog-flavor.js";

const sourceFile = (name: string) => new URL(`../../${name}`, import.meta.url);
const catalogBytes = readFileSync(sourceFile("environments/service-catalog/catalog.json"));
const signatureBytes = readFileSync(sourceFile("environments/service-catalog/catalog.sig.json"));
const stagingKeys = JSON.parse(readFileSync(sourceFile(STAGING_KEY_DATA_FILE), "utf8")) as CatalogSigningKey[];
const STAGING = { runningAccountId: CATALOG_STAGING_ACCOUNT_ID };

/** The key list a tree gets from the staging build path: a throwaway copy of the two generated files, switched with the real tool, and evaluated. */
async function compiledKeys(flavor: "staging" | "release"): Promise<{ keys: CatalogSigningKey[]; flavorLine: string }> {
  const root = await mkdtemp(join(tmpdir(), "shipped-catalog-trust-"));
  try {
    for (const file of [FLAVOR_FILE, STAGING_KEYS_FILE, STAGING_KEY_DATA_FILE]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await cp(sourceFile(file), join(root, file));
    }
    await setCatalogFlavor(root, flavor);
    const text = await readFile(join(root, STAGING_KEYS_FILE), "utf8");
    const file = join(root, "keys.mjs");
    await writeFile(file, text.replace(/^import .*$/mu, "").replace(": readonly CatalogSigningKey[]", ""));
    const keys = (await import(pathToFileURL(file).href) as { CATALOG_STAGING_ONLY_SIGNING_KEYS: CatalogSigningKey[] }).CATALOG_STAGING_ONLY_SIGNING_KEYS;
    return { keys, flavorLine: (await readFile(join(root, FLAVOR_FILE), "utf8")).match(/CATALOG_BUILD_FLAVOR[^\n]*/u)?.[0] ?? "" };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("the shipped signed catalog", () => {
  const signature = CatalogSignatureSchema.parse(JSON.parse(signatureBytes.toString("utf8")));

  it("is signed over the exact bytes of catalog.json, by the key in staging-signing-key.json (whose id is the hash of its public key)", () => {
    expect(stagingKeys).toHaveLength(1);
    const [key] = stagingKeys as [CatalogSigningKey];
    expect(key.algorithm).toBe("ECDSA_SHA_256");
    expect(parseBundlePublicKey(key.publicKey).keyId).toBe(key.keyId);
    expect(signature.keyId).toBe(key.keyId);
    expect(signature.catalogSha256).toBe(sha256HexOf(catalogBytes));
  });

  it("is trusted by a staging-flavor build in the staging account: it verifies with the staging key and loads as the pinned revision 3", async () => {
    const { keys, flavorLine } = await compiledKeys("staging");
    expect(flavorLine).toContain('= "staging";');
    expect(keys).toEqual(stagingKeys);
    const trusted = trustedKeyPemsFor(STAGING, { real: [], stagingOnly: keys, flavor: "staging" });
    expect(trusted).toEqual([stagingKeys[0]!.publicKey]);
    const loaded = loadSignedCatalogWithKeys({ catalogBytes, signatureBytes, trustedKeys: trusted });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.keyId).toBe(stagingKeys[0]!.keyId);
    expect(loaded.catalog).toMatchObject({ revision: 3, pinned: true });
    expect(loaded.catalog.entries.filter((entry) => entry.image.digest !== undefined).map((entry) => entry.id).sort()).toEqual(["local-aws@r1", "postgres@16"]);
  });

  it("is not trusted by a staging build in another account, or when the account is not known", async () => {
    const { keys } = await compiledKeys("staging");
    for (const account of [{ runningAccountId: "123456789012" }, { runningAccountId: undefined }]) {
      const trusted = trustedKeyPemsFor(account, { real: [], stagingOnly: keys, flavor: "staging" });
      expect(trusted).toEqual([]);
      expect(loadSignedCatalogWithKeys({ catalogBytes, signatureBytes, trustedKeys: trusted })).toEqual({ ok: false, reason: "no trusted catalog key" });
    }
  });

  it("is refused by a release-flavor build, even in the staging account: the key is not in release code, and the same files give 'no trusted catalog key'", async () => {
    const { keys, flavorLine } = await compiledKeys("release");
    expect(flavorLine).toContain('= "release";');
    expect(keys).toEqual([]);
    const trusted = trustedKeyPemsFor(STAGING, { real: [], stagingOnly: keys, flavor: "release" });
    expect(trusted).toEqual([]);
    expect(loadSignedCatalogWithKeys({ catalogBytes, signatureBytes, trustedKeys: trusted })).toEqual({ ok: false, reason: "no trusted catalog key" });
    // Even a release build handed the key by mistake does not count it: the flavor decides, not the list.
    expect(trustedKeyPemsFor(STAGING, { real: [], stagingOnly: stagingKeys, flavor: "release" })).toEqual([]);
  });

  it("is refused by the code as committed (a release tree), through the real compiled-in path, in the staging account too", () => {
    expect(CATALOG_STAGING_ONLY_SIGNING_KEYS).toEqual([]);
    expect(loadSignedCatalog({ catalogBytes, signatureBytes, trust: STAGING })).toEqual({ ok: false, reason: "no trusted catalog key" });
    expect(loadSignedCatalog({ catalogBytes, signatureBytes })).toEqual({ ok: false, reason: "no trusted catalog key" });
  });

  it("is refused by a staging build when the catalog changes by one byte: by the file hash, and (with the hash recomputed) by the ECDSA check itself, on a catalog that still passes the schema", async () => {
    const { keys } = await compiledKeys("staging");
    const trusted = trustedKeyPemsFor(STAGING, { real: [], stagingOnly: keys, flavor: "staging" });
    // A change that keeps the file a valid pinned catalog: postgres@16's high-finding count 12 becomes 13 (the schema checks the shape, not the number).
    const text = catalogBytes.toString("utf8");
    const at = text.indexOf('"highOpen": 12');
    expect(at).toBeGreaterThan(0);
    const changed = Buffer.from(`${text.slice(0, at)}"highOpen": 13${text.slice(at + '"highOpen": 12'.length)}`, "utf8");
    expect(ServiceCatalogSchema.safeParse(JSON.parse(changed.toString("utf8"))).success).toBe(true);
    // 1. The signature file still names the old hash: refused as a different file.
    expect(loadSignedCatalogWithKeys({ catalogBytes: changed, signatureBytes, trustedKeys: trusted })).toEqual({ ok: false, reason: "the signature file names a different catalog.json" });
    // 2. The hash is recomputed over the changed bytes, so only the signature can refuse it: it does not match.
    const rehashed = Buffer.from(JSON.stringify({ ...signature, catalogSha256: sha256HexOf(changed) }), "utf8");
    expect(loadSignedCatalogWithKeys({ catalogBytes: changed, signatureBytes: rehashed, trustedKeys: trusted })).toEqual({ ok: false, reason: "the signature does not match" });
    // Positive control: the same rehashed file with the real bytes is the shipped signature, and the shipped pair loads.
    expect(loadSignedCatalogWithKeys({ catalogBytes, signatureBytes: Buffer.from(JSON.stringify({ ...signature, catalogSha256: sha256HexOf(catalogBytes) }), "utf8"), trustedKeys: trusted }).ok).toBe(true);
  });
});

describe("the repository holds no bulk catalog evidence", () => {
  it("has no file under environments/service-catalog/evidence/ larger than 64 KB (SBOMs are kept with the release evidence, outside the repo: catalog-build --evidence-dir)", () => {
    const big: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (statSync(path).size > 64 * 1024) big.push(path);
      }
    };
    const evidence = fileURLToPath(sourceFile("environments/service-catalog/evidence"));
    if (existsSync(evidence)) walk(evidence);
    expect(big).toEqual([]);
  });
});
