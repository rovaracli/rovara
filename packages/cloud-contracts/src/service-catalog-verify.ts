// Test services, TS19: the checks on a pinned catalog that need Node's crypto (so they are not in `service-catalog-images.ts`, which is pure).
//
//   - The catalog is SIGNED as a file: `catalog.sig.json` holds an ECDSA P-256 signature over the exact bytes of `catalog.json`, behind a fixed prefix (a catalog signature can never be a bundle signature). The
//     keys are the same public keys installers already pin for release bundles (`parseBundlePublicKey`). `loadSignedCatalog` is the one way a caller gets a catalog it may trust: the signature, then the strict schema
//     (a half-pinned file does not parse). It returns a `VerifiedCatalog`, the only type `resolveCatalogImage` accepts.
//   - Each image has a signed STATEMENT (id, repository, the index digest, and for EVERY platform its child manifest digest, SBOM hash and scan time): the evidence the build keeps beside the catalog. A statement for one
//     image or one digest verifies for no other, and one that leaves a platform out is not the statement the build signed.
//   - The company-registry check (owner Q9, Enterprise): a customer's internal registry must serve the exact digest. The manifest is fetched BY DIGEST and its bytes are hashed here, so a registry that answers with
//     other bytes (a tag followed, a rebuilt image, a proxy) is a mismatch that stops that image only.
import { z } from "zod";
import { type CatalogEdition, catalogIdName, catalogPins, MIRROR_MANIFEST_MAX_BYTES, type MirrorCheck, type RegistryManifestPort, type ServiceCatalog, sha256HexOf } from "@rovara-code/contracts";
import { registerMirrorCheck } from "./service-catalog-brand.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const MIRROR_MESSAGES = {
  missing: (service: string) => `${service} image: the company registry does not hold the catalog's digest`,
  digest_mismatch: (service: string) => `${service} image: the company registry serves other bytes than the catalog's digest`,
  unreachable: (service: string) => `${service} image: the company registry could not be checked`,
} as const;

/** One image: the registry must hold the manifest of exactly `digest`. The bytes are hashed here; the registry's word is not taken. */
export async function checkMirrorServesDigest(port: RegistryManifestPort, input: { id: string; repositoryName: string; digest: string }): Promise<MirrorCheck> {
  const service = catalogIdName(input.id);
  const fail = (code: keyof typeof MIRROR_MESSAGES): MirrorCheck => registerMirrorCheck({ id: input.id, ok: false, code, message: MIRROR_MESSAGES[code](service) });
  try {
    if (!Sha256Schema.safeParse(input.digest).success) return fail("digest_mismatch");
    const bytes = await port.manifestBytes(input.repositoryName, input.digest);
    if (bytes === undefined) return fail("missing");
    if (bytes.byteLength === 0 || bytes.byteLength > MIRROR_MANIFEST_MAX_BYTES) return fail("digest_mismatch");
    return sha256HexOf(bytes) === input.digest ? registerMirrorCheck({ id: input.id, ok: true, digest: input.digest }) : fail("digest_mismatch");
  } catch {
    return fail("unreachable");
  }
}

/**
 * Every pinned entry of an edition against the company's registry. Each image is checked on its own: a mismatch or an outage for one never stops another (the result lists them all).
 * `repositoryNameFor` is the company's own repository path for a catalog repository.
 */
export async function checkCatalogMirror(input: { catalog: ServiceCatalog; edition?: CatalogEdition; port: RegistryManifestPort; repositoryNameFor: (catalogRepository: string) => string }): Promise<MirrorCheck[]> {
  return Promise.all(
    catalogPins(input.catalog, input.edition ?? "enterprise").map(async (pin): Promise<MirrorCheck> => {
      // The company's own naming function is called inside the per-image try: one that throws for one repository is that image's failure to check, not the whole run's.
      let repositoryName: string;
      try {
        repositoryName = input.repositoryNameFor(pin.repository);
      } catch {
        return registerMirrorCheck({ id: pin.id, ok: false, code: "unreachable", message: MIRROR_MESSAGES.unreachable(catalogIdName(pin.id)) });
      }
      return checkMirrorServesDigest(input.port, { id: pin.id, repositoryName, digest: pin.digest });
    }),
  );
}
