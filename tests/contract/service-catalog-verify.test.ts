// Test services TS19: the signature on the catalog file, an image's signed statement, and the company-registry digest check (owner Q9).
import { describe, expect, it } from "vitest";
import {
  CATALOG_SIGNATURE_ALGORITHM,
  MIRROR_MANIFEST_MAX_BYTES,
  catalogSigningMessage,
  checkCatalogMirror,
  combinedSbomRef,
  checkMirrorServesDigest,
  imageStatementMessage,
  loadSignedCatalog,
  parseBundlePublicKey,
  sha256HexOf,
  verifyCatalogSignature,
  verifyImageStatement,
  type CatalogSignature,
  type ImageChildStatement,
  type ImageStatement,
  type RegistryManifestPort,
  type SignedImageStatement,
} from "@agentx/contracts";
import { pinnedCatalog, sha, testSigner, unpinnedCatalog } from "../support/catalog-pinning.js";

const bytesOf = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

async function signedFile(catalog: unknown, signer = testSigner()) {
  const catalogBytes = bytesOf(catalog);
  const signature: CatalogSignature = {
    schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes),
    signature: (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64"),
  };
  return { signer, catalogBytes, signature, signatureBytes: bytesOf(signature) };
}

describe("the catalog signature", () => {
  it("verifies the exact bytes with the pinned key and loads the catalog", async () => {
    const { signer, catalogBytes, signatureBytes } = await signedFile(pinnedCatalog());
    const loaded = loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys: [signer.publicKeyPem] });
    expect(loaded.ok && loaded.catalog.pinned).toBe(true);
  });
  it("refuses a changed byte, another key, an unknown key id, a different file's signature, and a signature over the bytes without the catalog prefix", async () => {
    const { signer, catalogBytes, signature, signatureBytes } = await signedFile(pinnedCatalog());
    const trusted = [signer.publicKeyPem];
    const flipped = Buffer.from(catalogBytes);
    flipped[flipped.length - 3] = flipped[flipped.length - 3] === 0x20 ? 0x21 : 0x20;
    expect(loadSignedCatalog({ catalogBytes: flipped, signatureBytes, trustedKeys: trusted }).ok).toBe(false);
    expect(loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys: [testSigner().publicKeyPem] }).ok).toBe(false);
    expect(loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys: [] }).ok).toBe(false);
    expect(loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys: ["not a key"] }).ok).toBe(false);
    const other = await signedFile(pinnedCatalog((entries) => { entries[0]!["image"] = { ...(entries[0]!["image"] as object), digest: sha("other") }; }), signer);
    expect(verifyCatalogSignature({ catalogBytes, signature: other.signature, trustedKeys: trusted }).ok).toBe(false);
    const bare: CatalogSignature = { ...signature, signature: (await signer.sign(catalogBytes)).toString("base64") };
    expect(verifyCatalogSignature({ catalogBytes, signature: bare, trustedKeys: trusted }).ok).toBe(false);
    expect(loadSignedCatalog({ catalogBytes, signatureBytes: Buffer.from("{}"), trustedKeys: trusted }).ok).toBe(false);
    expect(loadSignedCatalog({ catalogBytes, signatureBytes: Buffer.alloc(70_000), trustedKeys: trusted }).ok).toBe(false);
  });
  it("is not a bundle signature: a bundle signer's signature over the file's bytes alone is refused", async () => {
    const signer = testSigner();
    const catalogBytes = bytesOf(pinnedCatalog());
    const asBundle: CatalogSignature = {
      schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature: (await signer.sign(catalogBytes)).toString("base64"),
    };
    expect(loadSignedCatalog({ catalogBytes, signatureBytes: bytesOf(asBundle), trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
  });
  it("does not accept a signed file that is half pinned (the schema refuses it even with a valid signature)", async () => {
    const raw = JSON.parse(JSON.stringify(pinnedCatalog())) as { entries: Array<{ id: string; image: { digest?: string } }> };
    delete raw.entries.find((entry) => entry.id === "postgres@16")!.image.digest;
    const { signer, catalogBytes, signatureBytes } = await signedFile(raw);
    expect(loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys: [signer.publicKeyPem] })).toEqual({ ok: false, reason: "the catalog is signed but does not pass the catalog schema" });
  });
  it("accepts a signed unpinned file only as unpinned (nothing in it can be started)", async () => {
    const { signer, catalogBytes, signatureBytes } = await signedFile(unpinnedCatalog());
    const loaded = loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys: [signer.publicKeyPem] });
    expect(loaded.ok && loaded.catalog.pinned).toBe(false);
  });
});

describe("an image's signed statement", () => {
  const children: ImageChildStatement[] = [
    { platform: "linux/amd64", digest: sha("amd child"), sbomRef: sha("amd sbom"), scannedAt: "2026-11-02T08:00:00.000Z" },
    { platform: "linux/arm64", digest: sha("arm child"), sbomRef: sha("arm sbom"), scannedAt: "2026-11-02T10:00:00.000Z" },
  ];
  const statement: ImageStatement = { id: "postgres@16", repository: "svc/postgres", digest: sha("d"), sbomRef: combinedSbomRef(children), scannedAt: "2026-11-02T08:00:00.000Z", children };
  async function signedStatement(value: ImageStatement = statement) {
    const signer = testSigner();
    const signed: SignedImageStatement = { statement: value, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, signature: (await signer.sign(imageStatementMessage(value))).toString("base64") };
    return { signer, signed };
  }
  it("verifies, and verifies for no other image, index digest, SBOM or time", async () => {
    const { signer, signed } = await signedStatement();
    expect(verifyImageStatement({ signed, trustedKeys: [signer.publicKeyPem] }).ok).toBe(true);
    for (const change of [{ id: "postgres@17" }, { repository: "svc/mysql" }, { digest: sha("e") }]) {
      expect(verifyImageStatement({ signed: { ...signed, statement: { ...statement, ...change } }, trustedKeys: [signer.publicKeyPem] }).ok, JSON.stringify(change)).toBe(false);
    }
    expect(verifyImageStatement({ signed, trustedKeys: [testSigner().publicKeyPem] }).ok).toBe(false);
    expect(verifyImageStatement({ signed: { ...signed, signature: "!!" }, trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
  });
  it("covers every platform's child digest, SBOM hash and scan time: changing, swapping or leaving one out does not verify", async () => {
    const { signer, signed } = await signedStatement();
    const verifies = (value: unknown): boolean => verifyImageStatement({ signed: { ...signed, statement: value as ImageStatement }, trustedKeys: [signer.publicKeyPem] }).ok;
    const [amd, arm] = children as [ImageChildStatement, ImageChildStatement];
    // Each of these keeps the statement well formed (the combined hash and the oldest time are recomputed), so only the signature can refuse them.
    const rebuilt = (list: ImageChildStatement[]): ImageStatement => ({ ...statement, sbomRef: combinedSbomRef(list), scannedAt: list.map((child) => child.scannedAt).sort()[0]!, children: list });
    expect(verifies(rebuilt([{ ...amd, digest: sha("swapped") }, arm]))).toBe(false);
    expect(verifies(rebuilt([amd, { ...arm, digest: sha("swapped") }]))).toBe(false);
    expect(verifies(rebuilt([{ ...amd, digest: arm.digest }, { ...arm, digest: amd.digest }]))).toBe(false);
    expect(verifies(rebuilt([amd]))).toBe(false);
    expect(verifies(rebuilt([arm]))).toBe(false);
    expect(verifies(rebuilt([{ ...amd, sbomRef: sha("other") }, arm]))).toBe(false);
    expect(verifies(rebuilt([amd, { ...arm, scannedAt: "2026-11-02T07:00:00.000Z" }]))).toBe(false);
    expect(verifies(statement)).toBe(true);
  });
  it("is not well formed with a combined SBOM hash or an oldest time that the children do not give, a platform twice, a shared manifest, or no platform", () => {
    const [amd, arm] = children as [ImageChildStatement, ImageChildStatement];
    for (const bad of [
      { ...statement, sbomRef: sha("not combined") },
      { ...statement, scannedAt: "2026-11-02T10:00:00.000Z" },
      { ...statement, children: [amd, { ...amd }] },
      { ...statement, children: [amd, { ...arm, digest: amd.digest }] },
      { ...statement, children: [] },
      { ...statement, children: [{ ...amd, platform: "linux/s390x" }, arm] },
    ]) {
      expect(() => imageStatementMessage(bad as ImageStatement), JSON.stringify(bad)).toThrow();
    }
  });
  it("is not a catalog signature either", async () => {
    const { signer, signed } = await signedStatement();
    const asCatalog: CatalogSignature = { schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: signed.keyId, catalogSha256: sha("x"), signature: signed.signature };
    expect(verifyCatalogSignature({ catalogBytes: imageStatementMessage(statement), signature: { ...asCatalog, catalogSha256: sha256HexOf(imageStatementMessage(statement)) }, trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
  });
});

describe("the company registry serves the exact digest", () => {
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }));
  const digest = sha256HexOf(manifest);
  const registryOf = (served: Map<string, Uint8Array>): RegistryManifestPort => ({ manifestBytes: async (repositoryName, wanted) => served.get(`${repositoryName}@${wanted}`) });
  const id = { id: "postgres@16", repositoryName: "corp/pg", digest };

  it("passes when the bytes the registry serves for the digest hash to that digest", async () => {
    expect(await checkMirrorServesDigest(registryOf(new Map([[`corp/pg@${digest}`, manifest]])), id)).toEqual({ id: "postgres@16", ok: true, digest });
  });
  it("stops an image whose registry has other bytes under the name, has nothing, answers with nothing usable, or cannot be reached", async () => {
    const other = Buffer.from("a rebuilt image");
    expect(await checkMirrorServesDigest(registryOf(new Map([[`corp/pg@${digest}`, other]])), id)).toMatchObject({ ok: false, code: "digest_mismatch", message: "postgres image: the company registry serves other bytes than the catalog's digest" });
    expect(await checkMirrorServesDigest(registryOf(new Map()), id)).toMatchObject({ ok: false, code: "missing" });
    expect(await checkMirrorServesDigest(registryOf(new Map([[`corp/pg@${digest}`, Buffer.alloc(0)]])), id)).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(await checkMirrorServesDigest(registryOf(new Map([[`corp/pg@${digest}`, Buffer.alloc(MIRROR_MANIFEST_MAX_BYTES + 1)]])), id)).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(await checkMirrorServesDigest({ manifestBytes: async () => { throw new Error("connect ECONNREFUSED"); } }, id)).toMatchObject({ ok: false, code: "unreachable" });
    expect(await checkMirrorServesDigest(registryOf(new Map()), { ...id, digest: "latest" })).toMatchObject({ ok: false, code: "digest_mismatch" });
  });
  it("does not trust a registry's own claim: only the hash of the bytes counts", async () => {
    const lying: RegistryManifestPort = { manifestBytes: async () => Buffer.from("not what was asked for") };
    expect((await checkMirrorServesDigest(lying, id)).ok).toBe(false);
  });
  it("checks every Enterprise entry on its own: one mismatch or outage stops only that image", async () => {
    const catalog = pinnedCatalog();
    const port: RegistryManifestPort = {
      manifestBytes: async (repositoryName) => {
        if (repositoryName === "corp/svc/mysql") throw new Error("503");
        if (repositoryName === "corp/svc/postgres") return Buffer.from("rebuilt");
        return undefined;
      },
    };
    const results = await checkCatalogMirror({ catalog, port, repositoryNameFor: (repository) => `corp/${repository}` });
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get("mysql@8")).toMatchObject({ ok: false, code: "unreachable" });
    expect(byId.get("postgres@16")).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(byId.get("valkey@8")).toMatchObject({ ok: false, code: "missing" });
    expect(results.length).toBe(catalog.entries.filter((entry) => entry.status !== "retired").length);
    expect(await checkCatalogMirror({ catalog: unpinnedCatalog(), port, repositoryNameFor: (repository) => repository })).toEqual([]);
  });
  it("stops only the image whose repository name the company's naming function cannot make", async () => {
    const catalog = pinnedCatalog();
    const port: RegistryManifestPort = { manifestBytes: async () => undefined };
    const results = await checkCatalogMirror({
      catalog, port,
      repositoryNameFor: (repository) => {
        if (repository === "svc/mysql") throw new Error("no such company repository");
        return `corp/${repository}`;
      },
    });
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get("mysql@8")).toMatchObject({ ok: false, code: "unreachable", message: "mysql image: the company registry could not be checked" });
    expect(byId.get("postgres@16")).toMatchObject({ ok: false, code: "missing" });
    expect(results.length).toBe(catalog.entries.filter((entry) => entry.status !== "retired").length);
  });
});
