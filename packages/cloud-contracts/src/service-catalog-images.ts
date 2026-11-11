// Test services, TS19 (design test-services.md, sections 2.5, 4.1.5, 5.3 and 10): what the catalog's PINS mean once the images are mirrored. Pure logic, no Node module and no I/O:
//
//   - where a catalog image lives in a registry (`rovara-catalog/<env>/<repository>`) and how it is named in a pull: always by digest, never by a tag;
//   - the worker pre-pull list, generated from the pinned catalog;
//   - the Enterprise signed bundle: the bundle image name of a catalog entry, and a check that a bundle holds exactly the digests the catalog pins;
//   - `resolveCatalogImage`: the one place that decides which digest a backing may start (owner Q9). It takes a `VerifiedCatalog` (only `loadSignedCatalog` returns one) and, for what the install serves, the RESULT of a
//     digest check (`MirrorCheck` from the registry check, or `BundleImageCheck` from `checkBundleImages`), never a bare digest. The image served must be the catalog's digest. A company-built substitute is allowed only for an Enterprise
//     install, only for a local (real software) entry, and only when DC-TS-1's two checks hold:
//       1. `substituteImage.catalogDigest` equals the digest of the catalog entry named by the backing's `catalogId`;
//       2. `substituteImage.approvalRef` resolves, through the `SubstituteApprovalPort`, to an admin approval whose catalog id is that `catalogId` and whose two digests are exactly the substitute's
//          `catalogDigest` and `digest` (an approval for one image or one digest pair never covers another).
//     A mismatch without an approved substitute stops THAT image only (`resolveCatalogImages` never throws and never lets one image's refusal reach another).
//
// The approval record itself is a later task (TS40): this file knows it only as a port that returns a live approval or nothing.
import { z } from "zod";
import { type BundleImageCheck, CATALOG_EDITION_SOURCES, CATALOG_IMAGE_MESSAGES, CATALOG_IMAGE_SOURCES, catalogBundleImageName, type CatalogEntry, catalogEntryById, catalogIdName, CatalogIdSchema, type CatalogImageRefusal, catalogPins, type ResolveCatalogImageInput, type ResolvedCatalogImage, type ServiceCatalog, substituteImageLabel, SubstituteImageSchema } from "@rovara-code/contracts";
import { isBundleCheck, isMirrorCheck, isVerifiedCatalog, registerBundleCheck } from "./service-catalog-brand.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** One result per Enterprise entry the catalog pins; the `digest` of an `ok` result is the digest the bundle's image reference names, which equals the catalog's. */
export function checkBundleImages(bundle: { images: ReadonlyArray<{ name: string; sourceRef: string }> }, catalog: ServiceCatalog): BundleImageCheck[] {
  const digestOf = (reference: string): string | undefined => /@sha256:([a-f0-9]{64})$/u.exec(reference)?.[1];
  return catalogPins(catalog, "enterprise").map((pin): BundleImageCheck => {
    const service = catalogIdName(pin.id);
    const image = bundle.images.find((candidate) => candidate.name === catalogBundleImageName(pin.id));
    if (image === undefined) return registerBundleCheck({ id: pin.id, ok: false, code: "missing", message: `${service} image: the signed bundle does not hold it` });
    return registerBundleCheck(
      digestOf(image.sourceRef) === pin.digest
        ? { id: pin.id, ok: true, digest: pin.digest }
        : { id: pin.id, ok: false, code: "digest_mismatch", message: `${service} image: the signed bundle holds other bytes than the catalog's digest` },
    );
  });
}

const refuse = (catalogId: string, code: CatalogImageRefusal): ResolvedCatalogImage => ({ ok: false, id: catalogId, code, message: CATALOG_IMAGE_MESSAGES[code](catalogIdName(catalogId)) });

/**
 * Decides whether an image may start, and which digest it is. Fails closed: bad input, a port that throws and every unmet check are refusals, never exceptions. A started image is ALWAYS pinned by digest.
 */
export async function resolveCatalogImage(input: ResolveCatalogImageInput): Promise<ResolvedCatalogImage> {
  const { catalogId } = input;
  try {
    const id = CatalogIdSchema.safeParse(catalogId);
    if (!id.success) return refuse(catalogId, "unknown_entry");
    // Run-time brands (service-catalog-brand.ts): the catalog is the object `loadSignedCatalog` returned, and the check is the object a real checker returned, of the kind the source needs. A raw or cloned catalog, a
    // hand-built check, and a bundle check offered for a registry (or the reverse) are refused, whatever their fields say.
    if (!isVerifiedCatalog(input.catalog)) return refuse(catalogId, "not_verified");
    const check = (input.served as { check?: { id?: unknown; ok?: unknown; digest?: unknown } } | undefined)?.check;
    const source = z.enum(CATALOG_IMAGE_SOURCES).safeParse((input.served as { source?: unknown } | undefined)?.source);
    if (!source.success || !(source.data === "signed_bundle" ? isBundleCheck(check) : isMirrorCheck(check))) return refuse(catalogId, "not_verified");
    // The check must also have passed, be for THIS id, and carry a digest: a failed or foreign check is a refusal, whatever else is true.
    if (check === undefined || check === null || check.ok !== true || check.id !== catalogId || !Sha256Schema.safeParse(check.digest).success) return refuse(catalogId, "not_verified");
    const served = { source: source.data, digest: check.digest as string };
    const entry: CatalogEntry | undefined = catalogEntryById(input.catalog, catalogId);
    if (entry === undefined) return refuse(catalogId, "unknown_entry");
    if (entry.status === "retired") return refuse(catalogId, "retired");
    const pinned = entry.image.digest;
    if (!input.catalog.pinned || pinned === undefined) return refuse(catalogId, "not_pinned");
    if (!entry.editions.includes(input.edition)) return refuse(catalogId, "edition_not_offered");
    if (!CATALOG_EDITION_SOURCES[input.edition].includes(served.source)) return refuse(catalogId, "source_not_allowed");
    const repository = entry.image.repository;

    if (input.substitute === undefined) {
      if (served.digest !== pinned) return refuse(catalogId, "digest_mismatch");
      return { ok: true, id: catalogId, kind: "catalog", repository, digest: pinned, source: served.source };
    }

    // A substitute: Enterprise only, and only for real software from the catalog (Rovara's own emulator, fake server and helpers are never swapped).
    const substitute = SubstituteImageSchema.safeParse(input.substitute);
    if (!substitute.success || input.edition !== "enterprise" || entry.backing !== "local") return refuse(catalogId, "substitute_not_allowed");
    // DC-TS-1 check 1: it replaces THIS entry's digest.
    if (substitute.data.catalogDigest !== pinned) return refuse(catalogId, "substitute_replaces_other_digest");
    // DC-TS-1 check 2: an admin approval for this catalog id and exactly this pair of digests.
    // A port that throws (the approval store was unreachable, say) is a refusal of this image, not of the run.
    const approval = await (async () => input.approvals.find(substitute.data.approvalRef))().catch((): undefined => undefined);
    if (approval === undefined) return refuse(catalogId, "substitute_approval_missing");
    if (approval.approvalRef !== substitute.data.approvalRef || approval.catalogId !== catalogId || approval.catalogDigest !== substitute.data.catalogDigest || approval.digest !== substitute.data.digest) {
      return refuse(catalogId, "substitute_approval_mismatch");
    }
    // What starts is the approved digest: the registry must serve exactly it.
    if (served.digest !== substitute.data.digest) return refuse(catalogId, "substitute_not_served");
    return {
      ok: true, id: catalogId, kind: "substitute", repository, digest: substitute.data.digest, catalogDigest: pinned, approvalRef: substitute.data.approvalRef, source: served.source,
      label: substituteImageLabel(catalogId),
    };
  } catch {
    return refuse(catalogId, "unknown_entry");
  }
}

/** Every request resolved on its own. One image's refusal (or failure) never reaches another's result. */
export async function resolveCatalogImages(requests: readonly ResolveCatalogImageInput[]): Promise<ResolvedCatalogImage[]> {
  return Promise.all(requests.map((request) => resolveCatalogImage(request)));
}
