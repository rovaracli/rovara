// The all-zero SHA-256 is the placeholder a release branch carries for an image that is not built yet (catalog revision 4, local-aws@r1). It parses as a digest, so every place that loads a catalog or a pre-pull list to START images must
// refuse it with a clear error, instead of letting a pull fail late. The places: the signed-catalog loader (the one place a catalog becomes verified), the worker's baked-catalog loader and the worker's pre-pull list loader.
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_SHA256, placeholderDigestProblem } from "@agentx/cloud-contracts";
import { loadSignedCatalogWithKeys } from "@agentx/cloud-contracts/testing";
import { CATALOG_SIGNATURE_ALGORITHM, catalogPrepullList, catalogSigningMessage, parseBundlePublicKey, sha256HexOf, type ServiceCatalog } from "@rovara-code/contracts";
import { loadBakedCatalog, TestServicesError } from "../../packages/worker/src/test-services-run.js";
import { loadPrepullList } from "../../packages/worker/src/service-prepull.js";
import { pinnedCatalog } from "../support/catalog-pinning.js";

const REAL = "ab".repeat(32);
const withDigest = (digest: string): ServiceCatalog => pinnedCatalog((entries) => { (entries.find((entry) => entry["id"] === "local-aws@r1")!["image"] as { digest?: string }).digest = digest; });

function signAndLoad(catalog: ServiceCatalog) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2), "utf8");
  const signature = createSign("sha256").update(catalogSigningMessage(catalogBytes)).sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
  const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature }), "utf8");
  return loadSignedCatalogWithKeys({ catalogBytes, signatureBytes, trustedKeys: [publicKeyPem] });
}

describe("placeholderDigestProblem", () => {
  it("names the first entry or image that holds the all-zero digest, and nothing otherwise", () => {
    expect(placeholderDigestProblem(withDigest(PLACEHOLDER_SHA256))).toMatch(/^local-aws@r1 .*all-zero placeholder/u);
    expect(placeholderDigestProblem(withDigest(REAL))).toBeUndefined();
    expect(placeholderDigestProblem(catalogPrepullList(withDigest(PLACEHOLDER_SHA256)))).toMatch(/^local-aws@r1 /u);
    expect(placeholderDigestProblem(catalogPrepullList(withDigest(REAL)))).toBeUndefined();
    // an unpinned entry (no digest at all) is not a placeholder
    expect(placeholderDigestProblem({ entries: [{ id: "x@1", image: {} }] })).toBeUndefined();
  });
});

describe("the signed-catalog loader refuses a signed catalog that pins the placeholder", () => {
  it("a catalog with the all-zero digest is not verified, with a clear reason", () => {
    expect(signAndLoad(withDigest(PLACEHOLDER_SHA256))).toEqual({ ok: false, reason: "the catalog pins an all-zero placeholder digest" });
  });
  it("positive control: the same catalog with a real digest verifies", () => {
    expect(signAndLoad(withDigest(REAL)).ok).toBe(true);
  });
});

describe("the worker refuses the placeholder in the files baked into its image", () => {
  async function inTemp<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "placeholder-digest-"));
    try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
  }
  it("loadBakedCatalog gives the fixed catalog error for the all-zero digest and loads a real one", async () => {
    await inTemp(async (directory) => {
      const bad = join(directory, "bad.json");
      const good = join(directory, "good.json");
      await writeFile(bad, JSON.stringify(withDigest(PLACEHOLDER_SHA256)));
      await writeFile(good, JSON.stringify(withDigest(REAL)));
      await expect(loadBakedCatalog(bad)).rejects.toBeInstanceOf(TestServicesError);
      await expect(loadBakedCatalog(bad)).rejects.toThrow(/catalog/u);
      expect((await loadBakedCatalog(good)).entries.find((entry) => entry.id === "local-aws@r1")?.image.digest).toBe(REAL);
    });
  });
  it("loadPrepullList throws for the all-zero digest and loads a real one", async () => {
    await inTemp(async (directory) => {
      const bad = join(directory, "bad.json");
      const good = join(directory, "good.json");
      await writeFile(bad, JSON.stringify(catalogPrepullList(withDigest(PLACEHOLDER_SHA256))));
      await writeFile(good, JSON.stringify(catalogPrepullList(withDigest(REAL))));
      await expect(loadPrepullList(bad)).rejects.toThrow(/all-zero placeholder/u);
      expect((await loadPrepullList(good)).images.find((image) => image.id === "local-aws@r1")?.digest).toBe(REAL);
    });
  });
});
