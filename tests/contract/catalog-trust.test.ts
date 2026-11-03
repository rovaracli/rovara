// Test services slice 1: the catalog's trusted keys (packages/contracts/src/catalog-trust.ts). The staging-only key counts only in the staging account AND in a staging build.
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CATALOG_BUILD_FLAVOR, CATALOG_STAGING_ACCOUNT_ID, CATALOG_STAGING_ONLY_SIGNING_KEYS, CATALOG_TRUSTED_SIGNING_KEYS, accountIdOfArn, catalogTrustedKeyPems, loadSignedCatalog, parseBundlePublicKey,
  type CatalogSigningKey,
} from "@agentx/contracts";
import { withFlavor } from "../../scripts/release/catalog-flavor.js";
import { pinnedCatalog, testSigner } from "../support/catalog-pinning.js";
import { CATALOG_SIGNATURE_ALGORITHM, catalogSigningMessage, sha256HexOf } from "@agentx/contracts";

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
    expect(loadSignedCatalog({ ...files, trustedKeys: [] })).toEqual({ ok: false, reason: "no trusted catalog key" });
  });
  it("trust a real key anywhere (a test-only key in the real list verifies), and drop a key whose id, algorithm or PEM is wrong", async () => {
    const { key, signer } = testKey();
    const files = await signedBy(signer);
    for (const context of [STAGING, OTHER, { runningAccountId: undefined }]) {
      for (const flavor of ["release", "staging"] as const) {
        const pems = catalogTrustedKeyPems(context, { real: [key], flavor });
        expect(loadSignedCatalog({ ...files, trustedKeys: pems }).ok, `${context.runningAccountId ?? "unknown"} ${flavor}`).toBe(true);
      }
    }
    expect(catalogTrustedKeyPems(OTHER, { real: [{ ...key, keyId: "0".repeat(64) }] })).toEqual([]);
    expect(catalogTrustedKeyPems(OTHER, { real: [{ ...key, algorithm: "RSA" as unknown as "ECDSA_SHA_256" }] })).toEqual([]);
    expect(catalogTrustedKeyPems(OTHER, { real: [{ ...key, publicKey: "not a key" }] })).toEqual([]);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(catalogTrustedKeyPems(OTHER, { real: [{ ...key, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }] })).toEqual([]);
  });
  it("trust the staging-only key only in the staging account AND in a staging build", async () => {
    const { key, signer } = testKey();
    const files = await signedBy(signer);
    const verifies = (context: { runningAccountId: string | undefined }, flavor: "release" | "staging") =>
      loadSignedCatalog({ ...files, trustedKeys: catalogTrustedKeyPems(context, { stagingOnly: [key], flavor }) }).ok;
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
  it("are compiled in: the trust module reads no environment variable, setting, parameter or file", () => {
    const source = readFileSync(new URL("../../packages/contracts/src/catalog-trust.ts", import.meta.url), "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(source).not.toMatch(/process\.env|readFile|ssm|SSM|fetch\(|AGENTX_|ROVARA_/u);
  });
});

describe("the build flavor", () => {
  it("is release in the committed tree, which is what every release is built from", () => {
    expect(CATALOG_BUILD_FLAVOR).toBe("release");
    expect(readFileSync(new URL("../../packages/contracts/src/catalog-build-flavor.ts", import.meta.url), "utf8")).toContain('CATALOG_BUILD_FLAVOR: "release" | "staging" = "release";');
  });
  it("is switched by the staging build path's script, one line, and nothing else is rewritten", () => {
    const text = readFileSync(new URL("../../packages/contracts/src/catalog-build-flavor.ts", import.meta.url), "utf8");
    const staging = withFlavor(text, "staging");
    expect(staging).toContain('= "staging";');
    expect(withFlavor(staging, "release")).toBe(text);
    expect(() => withFlavor("export const X = 1;\n", "staging")).toThrow(/expected form/u);
    expect(() => withFlavor(text, "prod" as "release")).toThrow();
  });
  it("is checked by the release builder before it touches anything", () => {
    const build = readFileSync(new URL("../../scripts/release/build.ts", import.meta.url), "utf8");
    expect(build.indexOf('CATALOG_BUILD_FLAVOR !== "release"')).toBeGreaterThan(0);
    expect(build.indexOf('CATALOG_BUILD_FLAVOR !== "release"')).toBeLessThan(build.indexOf("await claimOutDir(input.out)"));
  });
});
