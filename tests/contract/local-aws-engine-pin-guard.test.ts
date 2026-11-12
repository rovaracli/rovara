// RELEASE GUARD for the AWS Emulator engine swap (owner decisions 105 to 107, catalog revision 4). Until the controller session builds the new image, scans it and signs the catalog, `local-aws@r1` in the shipped files carries
// a PLACEHOLDER pin (a digest, an SBOM hash and a scan stamp that are all zeros or the year 2000). It keeps every other test of the shipped state meaningful, and it can never start: no image has that digest. THIS file is what stops
// it from shipping: it FAILS while any placeholder is still in `environments/service-catalog/catalog.json` or `packages/worker/service-catalog/prepull.json`. It goes green only when `scripts/catalog-build.ts --entries local-aws@r1`
// (the real image, a real SBOM and ECR scan, a KMS signature) has rewritten both files. Do not skip it or edit the placeholder constants to make it pass.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ServiceCatalogSchema, PrepullListSchema, sha256HexOf, CatalogSignatureSchema } from "@rovara-code/contracts";

export const PLACEHOLDER_HEX = "0".repeat(64);
export const PLACEHOLDER_SCANNED_AT = "2000-01-01T00:00:00.000Z";

const catalogText = readFileSync("environments/service-catalog/catalog.json", "utf8");
const prepullText = readFileSync("packages/worker/service-catalog/prepull.json", "utf8");

/** What is still a placeholder in the two files (empty when the pin is real). */
export function placeholderProblems(files: { catalogText: string; prepullText: string }): string[] {
  const catalog = ServiceCatalogSchema.parse(JSON.parse(files.catalogText));
  const prepull = PrepullListSchema.parse(JSON.parse(files.prepullText));
  const entry = catalog.entries.find((candidate) => candidate.id === "local-aws@r1");
  const image = prepull.images.find((candidate) => candidate.id === "local-aws@r1");
  const problems: string[] = [];
  if (entry === undefined) return ["local-aws@r1 is not in the catalog"];
  if (entry.image.digest === undefined || entry.image.digest === PLACEHOLDER_HEX) problems.push("the catalog image digest is the placeholder or missing");
  if (entry.sbomRef === undefined || entry.sbomRef === PLACEHOLDER_HEX) problems.push("sbomRef is the placeholder or missing");
  if (entry.scan === undefined || entry.scan.scannedAt === PLACEHOLDER_SCANNED_AT) problems.push("the scan stamp is the placeholder or missing");
  if (image === undefined) problems.push("local-aws@r1 is missing from the pre-pull list");
  else if (image.digest === PLACEHOLDER_HEX || image.digest !== entry.image.digest) problems.push("the pre-pull digest is the placeholder or differs from the catalog's");
  if (prepull.catalogRevision !== catalog.revision) problems.push("the pre-pull list is from another catalog revision");
  if (files.catalogText.includes(PLACEHOLDER_HEX) || files.prepullText.includes(PLACEHOLDER_HEX)) problems.push("an all-zero placeholder digest is still in a shipped file");
  return problems;
}

describe("release guard: the local-aws pin is a real one, not the placeholder", () => {
  it("the shipped catalog and pre-pull list hold no placeholder (run scripts/catalog-build.ts --entries local-aws@r1 to replace it)", () => {
    expect(placeholderProblems({ catalogText, prepullText })).toEqual([]);
  });
  it("catalog.sig.json signs exactly these catalog bytes (re-sign after the pin, with the staging key alias for staging)", () => {
    const signature = CatalogSignatureSchema.parse(JSON.parse(readFileSync("environments/service-catalog/catalog.sig.json", "utf8")));
    expect(signature.catalogSha256).toBe(sha256HexOf(Buffer.from(catalogText, "utf8")));
  });
  it("positive control: the checks do catch a placeholder, and accept a real-looking pin", () => {
    const real = "ab".repeat(32);
    const withPin = (digest: string, sbom: string, scannedAt: string): { catalogText: string; prepullText: string } => {
      const catalog = JSON.parse(catalogText) as { entries: Array<{ id: string; image: { digest: string }; sbomRef: string; scan: { scannedAt: string } }> };
      const entry = catalog.entries.find((candidate) => candidate.id === "local-aws@r1")!;
      entry.image.digest = digest;
      entry.sbomRef = sbom;
      entry.scan.scannedAt = scannedAt;
      const prepull = JSON.parse(prepullText) as { images: Array<{ id: string; digest: string }> };
      prepull.images.find((image) => image.id === "local-aws@r1")!.digest = digest;
      return { catalogText: JSON.stringify(catalog), prepullText: JSON.stringify(prepull) };
    };
    expect(placeholderProblems(withPin(PLACEHOLDER_HEX, PLACEHOLDER_HEX, PLACEHOLDER_SCANNED_AT)).length).toBeGreaterThanOrEqual(4);
    expect(placeholderProblems(withPin(real, "cd".repeat(32), "2026-11-12T00:00:00.000Z"))).toEqual([]);
    // each placeholder alone is caught
    expect(placeholderProblems(withPin(PLACEHOLDER_HEX, "cd".repeat(32), "2026-11-12T00:00:00.000Z")).length).toBeGreaterThan(0);
    expect(placeholderProblems(withPin(real, PLACEHOLDER_HEX, "2026-11-12T00:00:00.000Z")).length).toBeGreaterThan(0);
    expect(placeholderProblems(withPin(real, "cd".repeat(32), PLACEHOLDER_SCANNED_AT)).length).toBeGreaterThan(0);
  });
});
