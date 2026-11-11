// Test services slice 1: the catalog's trusted keys (packages/cloud-contracts/src/catalog-trust.ts). The staging-only key counts only in the staging account AND in a staging build, and a release build does not contain it.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG_BUILD_FLAVOR, CATALOG_STAGING_ACCOUNT_ID, CATALOG_STAGING_ONLY_SIGNING_KEYS, catalogTrustedKeyPems, loadSignedCatalog } from "@agentx/cloud-contracts";
import { CATALOG_TRUSTED_SIGNING_KEYS, CATALOG_SIGNATURE_ALGORITHM, accountIdOfArn, catalogSigningMessage, parseBundlePublicKey, sha256HexOf, type CatalogSigningKey } from "@rovara-code/contracts";
import { loadSignedCatalogWithKeys, trustedKeyPemsFor } from "@agentx/cloud-contracts/testing";
import { FLAVOR_FILE, STAGING_KEYS_FILE, STAGING_KEY_DATA_FILE, setCatalogFlavor, withFlavor, withStagingKeys } from "../../packages/cloud-contracts/tools/catalog-flavor.js";
import { pinnedCatalog, testSigner } from "../support/catalog-pinning.js";

// A test-only key: made now, kept nowhere.
function testKey(signer = testSigner()): { key: CatalogSigningKey; signer: ReturnType<typeof testSigner> } {
  return { key: { keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, publicKey: signer.publicKeyPem, algorithm: "ECDSA_SHA_256" }, signer };
}
async function signedBy(signer: ReturnType<typeof testSigner>) {
  const catalogBytes = Buffer.from(JSON.stringify(pinnedCatalog(), null, 2), "utf8");
  const signature = (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64");
  const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature }), "utf8");
  return { catalogBytes, signatureBytes };
}
const STAGING = { runningAccountId: CATALOG_STAGING_ACCOUNT_ID };
const OTHER = { runningAccountId: "123456789012" };

describe("the catalog's trusted keys", () => {
  it("ship empty until the owner names the keys, so nothing verifies and the reason says why", async () => {
    expect(CATALOG_TRUSTED_SIGNING_KEYS).toEqual([]);
    expect(CATALOG_STAGING_ONLY_SIGNING_KEYS).toEqual([]);
    const { signer } = testKey();
    const files = await signedBy(signer);
    for (const trust of [undefined, STAGING, OTHER, { runningAccountId: undefined }]) {
      expect(loadSignedCatalog({ ...files, ...(trust === undefined ? {} : { trust }) })).toEqual({ ok: false, reason: "no trusted catalog key" });
    }
    expect(loadSignedCatalogWithKeys({ ...files, trustedKeys: [] })).toEqual({ ok: false, reason: "no trusted catalog key" });
  });
  it("cannot be widened by the production functions: a key list, a build flavor or a staging claim passed to them anyway changes nothing", async () => {
    const { key, signer } = testKey();
    const files = await signedBy(signer);
    // a JavaScript caller (or a cast) can pass whatever it likes; the production loader and key list ignore it
    const load = loadSignedCatalog as (input: unknown) => { ok: boolean; reason?: string };
    expect(load({ ...files, trustedKeys: [signer.publicKeyPem] })).toEqual({ ok: false, reason: "no trusted catalog key" });
    expect(load({ ...files, trust: STAGING, trustedKeys: [signer.publicKeyPem], flavor: "staging", stagingOnly: [key], sources: { stagingOnly: [key], flavor: "staging" } })).toEqual({ ok: false, reason: "no trusted catalog key" });
    const pems = catalogTrustedKeyPems as (context: unknown, sources?: unknown) => string[];
    expect(pems(STAGING, { real: [key], stagingOnly: [key], flavor: "staging" })).toEqual([]);
    expect(pems(OTHER, { real: [key] })).toEqual([]);
  });
  it("trust a real key anywhere (a test-only key in the real list verifies), and drop a key whose id, algorithm or PEM is wrong", async () => {
    const { key, signer } = testKey();
    const files = await signedBy(signer);
    for (const context of [STAGING, OTHER, { runningAccountId: undefined }]) {
      for (const flavor of ["release", "staging"] as const) {
        const pems = trustedKeyPemsFor(context, { real: [key], stagingOnly: [], flavor });
        expect(loadSignedCatalogWithKeys({ ...files, trustedKeys: pems }).ok, `${context.runningAccountId ?? "unknown"} ${flavor}`).toBe(true);
      }
    }
    const lists = (real: CatalogSigningKey[]) => ({ real, stagingOnly: [], flavor: "release" as const });
    expect(trustedKeyPemsFor(OTHER, lists([{ ...key, keyId: "0".repeat(64) }]))).toEqual([]);
    expect(trustedKeyPemsFor(OTHER, lists([{ ...key, algorithm: "RSA" as unknown as "ECDSA_SHA_256" }]))).toEqual([]);
    expect(trustedKeyPemsFor(OTHER, lists([{ ...key, publicKey: "not a key" }]))).toEqual([]);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(trustedKeyPemsFor(OTHER, lists([{ ...key, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }]))).toEqual([]);
  });
  it("trust the staging-only key only in the staging account AND in a staging build", async () => {
    const { key, signer } = testKey();
    const files = await signedBy(signer);
    const verifies = (context: { runningAccountId: string | undefined }, flavor: "release" | "staging") =>
      loadSignedCatalogWithKeys({ ...files, trustedKeys: trustedKeyPemsFor(context, { real: [], stagingOnly: [key], flavor }) }).ok;
    // only the right account plus a staging build accepts it
    expect(verifies(STAGING, "staging")).toBe(true);
    // a public or Enterprise build with agentxEnv=staging in another account rejects it
    expect(verifies(OTHER, "release")).toBe(false);
    expect(verifies(OTHER, "staging")).toBe(false);
    // the right account plus a release build also rejects it
    expect(verifies(STAGING, "release")).toBe(false);
    // an account that could not be found, and look-alikes of the account id, reject it
    for (const runningAccountId of [undefined, "", "944937319446", "9449373194450", " 944937319445", "944937319445\n"]) expect(verifies({ runningAccountId }, "staging"), String(runningAccountId)).toBe(false);
  });
  it("read the account from an ARN of the process's own identity and from nothing else", () => {
    expect(accountIdOfArn("arn:aws:lambda:us-west-2:944937319445:function:agentx-staging-broker")).toBe("944937319445");
    expect(accountIdOfArn("arn:aws-us-gov:sts::123456789012:assumed-role/x/y")).toBe("123456789012");
    for (const bad of [undefined, "", "944937319445", "arn:aws:lambda:us-west-2:94493731944:function:x", "arn:aws:lambda:us-west-2:944937319445"]) expect(accountIdOfArn(bad), String(bad)).toBeUndefined();
  });
});

describe("the build flavor and the staging key list of a tree", () => {
  const sourceFile = (name: string) => new URL(`../../${name}`, import.meta.url);
  /** A throwaway tree holding just the two generated files (as committed) and a staging key data file. */
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "catalog-flavor-"));
    for (const file of [FLAVOR_FILE, STAGING_KEYS_FILE]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await cp(sourceFile(file), join(root, file));
    }
    return root;
  }
  const dataFor = (key: CatalogSigningKey) => JSON.stringify([key]);

  it("are release and empty in the committed tree, which is what every release is built from", async () => {
    expect(CATALOG_BUILD_FLAVOR).toBe("release");
    expect(await readFile(sourceFile(FLAVOR_FILE), "utf8")).toContain('CATALOG_BUILD_FLAVOR: "release" | "staging" = "release";');
    expect(await readFile(sourceFile(STAGING_KEYS_FILE), "utf8")).toContain("CATALOG_STAGING_ONLY_SIGNING_KEYS: readonly CatalogSigningKey[] = [];");
  });
  it("a staging flavor writes the staging-only keys from the data file, a release flavor strips them to the empty list whatever the data file holds", async () => {
    const root = await fixture();
    try {
      const { key } = testKey();
      await mkdir(join(root, "environments/service-catalog"), { recursive: true });
      await writeFile(join(root, STAGING_KEY_DATA_FILE), dataFor(key));
      await setCatalogFlavor(root, "staging");
      const staging = await readFile(join(root, STAGING_KEYS_FILE), "utf8");
      expect(staging).toContain(key.keyId);
      expect(staging).toContain("BEGIN PUBLIC KEY");
      expect(await readFile(join(root, FLAVOR_FILE), "utf8")).toContain('= "staging";');
      await setCatalogFlavor(root, "release");
      expect(await readFile(join(root, STAGING_KEYS_FILE), "utf8")).toBe(await readFile(sourceFile(STAGING_KEYS_FILE), "utf8"));
      expect(await readFile(join(root, FLAVOR_FILE), "utf8")).toBe(await readFile(sourceFile(FLAVOR_FILE), "utf8"));
      // and with no data file a staging flavor is still just the flavor
      await rm(join(root, STAGING_KEY_DATA_FILE));
      await setCatalogFlavor(root, "staging");
      expect(await readFile(join(root, STAGING_KEYS_FILE), "utf8")).toContain("= [];");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses a key that is not a 64-hex id, the one algorithm and a PEM, and a file it does not recognise", async () => {
    const text = await readFile(sourceFile(STAGING_KEYS_FILE), "utf8");
    const { key } = testKey();
    for (const bad of [{ ...key, keyId: "abc" }, { ...key, algorithm: "RSA" }, { ...key, publicKey: "not a key" }, null, "x"]) expect(() => withStagingKeys(text, [bad]), JSON.stringify(bad)).toThrow(/staging-only signing key/u);
    expect(() => withStagingKeys("export const X = 1;\n", [])).toThrow(/expected form/u);
    expect(() => withFlavor("export const X = 1;\n", "staging")).toThrow(/expected form/u);
    expect(() => withFlavor(text, "prod" as "release")).toThrow();
  });
  it("a tree written with a staging key trusts it (in the staging account) through the compiled-in path, and the stripped tree does not", async () => {
    // the generated list is valid TypeScript that yields exactly the key it was given
    const { key } = testKey();
    const text = withStagingKeys(await readFile(sourceFile(STAGING_KEYS_FILE), "utf8"), [key]);
    const root = await mkdtemp(join(tmpdir(), "catalog-keys-eval-"));
    try {
      const file = join(root, "keys.mjs");
      await writeFile(file, text.replace(/^import .*$/mu, "").replace(": readonly CatalogSigningKey[]", ""));
      const evaluated = (await import(pathToFileURL(file).href) as { CATALOG_STAGING_ONLY_SIGNING_KEYS: CatalogSigningKey[] }).CATALOG_STAGING_ONLY_SIGNING_KEYS;
      expect(evaluated).toEqual([key]);
      expect(trustedKeyPemsFor(STAGING, { real: [], stagingOnly: evaluated, flavor: "staging" })).toEqual([key.publicKey]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
