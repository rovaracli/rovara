// Test services TS19: a pinned catalog and a signer for tests, built at run time (no key is kept anywhere). The digests are the SHA-256 of the entry's id, so they are stable and differ per entry.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { CATALOG_SIGNATURE_ALGORITHM, ServiceCatalogSchema, catalogSigningMessage, loadSignedCatalog, parseBundlePublicKey, sha256HexOf, type ServiceCatalog, type VerifiedCatalog } from "@agentx/contracts";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
export const unpinnedCatalog = (): ServiceCatalog => ServiceCatalogSchema.parse(JSON.parse(readFileSync("environments/service-catalog/catalog.json", "utf8")));
export const digestOfId = (id: string): string => sha(`image:${id}`);

/** A pinned copy of the data file: every non-retired entry gets its digest, an SBOM hash and a clean scan. */
export function pinnedCatalog(change: (entries: Array<Record<string, unknown>>) => void = () => undefined): ServiceCatalog {
  const raw = JSON.parse(readFileSync("environments/service-catalog/catalog.json", "utf8")) as { pinned: boolean; revision: number; entries: Array<Record<string, unknown>> };
  raw.pinned = true;
  raw.revision = 2;
  for (const entry of raw.entries) {
    const id = entry["id"] as string;
    (entry["image"] as { digest?: string }).digest = digestOfId(id);
    entry["sbomRef"] = sha(`sbom:${id}`);
    entry["scan"] = { scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 0, highOpen: 1 };
  }
  change(raw.entries);
  return ServiceCatalogSchema.parse(raw);
}

export interface TestSigner {
  readonly publicKeyPem: string;
  sign: (message: Buffer) => Promise<Buffer>;
}
/** An ECDSA P-256 signer with a key made now. */
export function testSigner(): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    async sign(message: Buffer) {
      return createSign("sha256").update(message).sign({ key: privateKey, dsaEncoding: "der" });
    },
  };
}

/**
 * A catalog as `resolveCatalogImage` takes it: signed with a key made now and loaded through `loadSignedCatalog`, the one function that returns a `VerifiedCatalog`. (Nothing in a test asserts the brand with a cast.)
 */
export function verifiedCatalog(catalog: ServiceCatalog): VerifiedCatalog {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2), "utf8");
  const signature = createSign("sha256").update(catalogSigningMessage(catalogBytes)).sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
  const signatureBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature }), "utf8");
  const loaded = loadSignedCatalog({ catalogBytes, signatureBytes, trustedKeys: [publicKeyPem] });
  if (!loaded.ok) throw new Error(`the test catalog did not load: ${loaded.reason}`);
  return loaded.catalog;
}
