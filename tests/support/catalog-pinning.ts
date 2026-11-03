// Test services TS19: a pinned catalog and a signer for tests, built at run time (no key is kept anywhere). The digests are the SHA-256 of the entry's id, so they are stable and differ per entry.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { ServiceCatalogSchema, type ServiceCatalog } from "@agentx/contracts";

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
