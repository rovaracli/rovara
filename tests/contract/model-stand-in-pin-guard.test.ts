// RELEASE GUARD for the model stand-in (lane SM3, entry `model-stand-in@r1`). The entry is STAGED in environments/model-stand-in/catalog-entry.json, unpinned, until the signing that pins it (the next one, revision 6): putting
// it in the signed catalog.json earlier would change the signed bytes. While it is staged this file holds that it is a valid unpinned entry that merges into the shipped catalog. The moment the entry is in catalog.json (the signing
// step merges it, then `scripts/catalog-build.ts --entries model-stand-in@r1` pins it) it must be wholly pinned with a real digest, in the pre-pull list with the same digest, and covered by catalog.sig.json. Do not skip it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CatalogSignatureSchema, PrepullListSchema, ServiceCatalogSchema, sha256HexOf } from "@rovara-code/contracts";
import { MODEL_STAND_IN_ID, catalogWithModelStandIn, modelStandInIsShipped, shippedCatalogFile, stagedModelStandInEntry } from "../support/model-stand-in-entry.js";

const PLACEHOLDER_HEX = "0".repeat(64);
const catalogText = readFileSync("environments/service-catalog/catalog.json", "utf8");
const prepullText = readFileSync("packages/worker/service-catalog/prepull.json", "utf8");

/** What is wrong with a SHIPPED entry's pin (empty when it is a real one). */
function shippedPinProblems(files: { catalogText: string; prepullText: string }): string[] {
  const catalog = ServiceCatalogSchema.parse(JSON.parse(files.catalogText));
  const prepull = PrepullListSchema.parse(JSON.parse(files.prepullText));
  const entry = catalog.entries.find((candidate) => candidate.id === MODEL_STAND_IN_ID);
  const image = prepull.images.find((candidate) => candidate.id === MODEL_STAND_IN_ID);
  if (entry === undefined) return [`${MODEL_STAND_IN_ID} is not in the catalog`];
  const problems: string[] = [];
  if (entry.image.digest === undefined || entry.image.digest === PLACEHOLDER_HEX) problems.push("the catalog image digest is missing or a placeholder");
  if (entry.sbomRef === undefined || entry.sbomRef === PLACEHOLDER_HEX) problems.push("sbomRef is missing or a placeholder");
  if (entry.scan === undefined || entry.scan.scannedAt.startsWith("2000-")) problems.push("the scan stamp is missing or a placeholder");
  if (image === undefined) problems.push(`${MODEL_STAND_IN_ID} is missing from the pre-pull list`);
  else if (image.digest !== entry.image.digest) problems.push("the pre-pull digest differs from the catalog's");
  if (prepull.catalogRevision !== catalog.revision) problems.push("the pre-pull list is from another catalog revision");
  if (files.catalogText.includes(PLACEHOLDER_HEX) || files.prepullText.includes(PLACEHOLDER_HEX)) problems.push("an all-zero placeholder digest is in a shipped file");
  return problems;
}

describe("the staged model stand-in entry (until the signing that pins it)", () => {
  it("is a valid UNPINNED entry: no digest, SBOM, scan or placeholder anywhere", () => {
    const entry = stagedModelStandInEntry();
    expect(entry.id).toBe(MODEL_STAND_IN_ID);
    expect(entry.image.digest).toBeUndefined();
    expect(entry.sbomRef).toBeUndefined();
    expect(entry.scan).toBeUndefined();
    expect(readFileSync("environments/model-stand-in/catalog-entry.json", "utf8")).not.toMatch(/[a-f0-9]{64}|sha256/u);
  });
  it("merges into the shipped catalog into a catalog that parses, keeping every shipped pin exactly", () => {
    const shipped = shippedCatalogFile();
    const merged = catalogWithModelStandIn();
    expect(merged.entries.map((entry) => entry.id)).toEqual(modelStandInIsShipped() ? shipped.entries.map((entry) => entry.id) : [...shipped.entries.map((entry) => entry.id), MODEL_STAND_IN_ID]);
    for (const entry of shipped.entries) expect(merged.entries.find((candidate) => candidate.id === entry.id)).toEqual(entry);
    expect(merged.pinned).toBe(true);
    expect(merged.revision).toBe(shipped.revision);
  });
  it("is not in the signed catalog yet, or, once it is, is wholly pinned (the guard below) ", () => {
    if (!modelStandInIsShipped()) {
      expect(catalogText).not.toContain("model-stand-in");
      expect(prepullText).not.toContain("model-stand-in");
    } else {
      expect(shippedPinProblems({ catalogText, prepullText })).toEqual([]);
    }
  });
  it("catalog.sig.json signs exactly the shipped catalog bytes", () => {
    const signature = CatalogSignatureSchema.parse(JSON.parse(readFileSync("environments/service-catalog/catalog.sig.json", "utf8")));
    expect(signature.catalogSha256).toBe(sha256HexOf(Buffer.from(catalogText, "utf8")));
  });
  it("positive control: the shipped-pin check catches an unpinned or placeholder entry and accepts a real-looking pin", () => {
    const real = "ab".repeat(32);
    const withEntry = (change: (entry: Record<string, unknown> & { image: { digest?: string } }) => void, prepullDigest: string | undefined) => {
      const catalog = JSON.parse(catalogText) as { revision: number; entries: Array<Record<string, unknown> & { image: { digest?: string } }> };
      const entry = JSON.parse(readFileSync("environments/model-stand-in/catalog-entry.json", "utf8")) as Record<string, unknown> & { image: { digest?: string } };
      change(entry);
      catalog.entries.push(entry);
      const prepull = JSON.parse(prepullText) as { images: Array<Record<string, unknown>> };
      if (prepullDigest !== undefined) prepull.images.push({ id: MODEL_STAND_IN_ID, repository: "svc/model-stand-in", digest: prepullDigest, platforms: ["linux/arm64", "linux/amd64"] });
      return { catalogText: JSON.stringify(catalog), prepullText: JSON.stringify(prepull) };
    };
    const pin = (digest: string, sbom: string, scannedAt: string) => (entry: Record<string, unknown> & { image: { digest?: string } }) => { entry.image.digest = digest; entry["sbomRef"] = sbom; entry["scan"] = { scannedAt, criticalOpen: 0, highOpen: 0 }; };
    expect(shippedPinProblems(withEntry(() => undefined, undefined)).length).toBeGreaterThanOrEqual(3); // unpinned
    expect(shippedPinProblems(withEntry(pin(PLACEHOLDER_HEX, PLACEHOLDER_HEX, "2000-01-01T00:00:00.000Z"), PLACEHOLDER_HEX)).length).toBeGreaterThanOrEqual(4);
    expect(shippedPinProblems(withEntry(pin(real, "cd".repeat(32), "2026-11-13T00:00:00.000Z"), real))).toEqual([]);
    expect(shippedPinProblems(withEntry(pin(real, "cd".repeat(32), "2026-11-13T00:00:00.000Z"), "ef".repeat(32)))).toContain("the pre-pull digest differs from the catalog's");
  });
});
