// The model stand-in's catalog entry (lane SM3). It is STAGED in `environments/model-stand-in/catalog-entry.json` until the signing that pins it (adding it to the signed `catalog.json` earlier would change the signed
// bytes); once the entry is in `catalog.json` the shipped one is the one used.
import { readFileSync } from "node:fs";
import { CatalogEntrySchema, ServiceCatalogSchema, type CatalogEntry, type ServiceCatalog } from "@rovara-code/contracts";

export const MODEL_STAND_IN_ID = "model-stand-in@r1";
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

/** The shipped signed catalog, as written (no entry added). */
export const shippedCatalogFile = (): ServiceCatalog => ServiceCatalogSchema.parse(read("environments/service-catalog/catalog.json"));
/** The staged entry file, parsed. */
export const stagedModelStandInEntry = (): CatalogEntry => CatalogEntrySchema.parse(read("environments/model-stand-in/catalog-entry.json"));
/** Whether the signing that pins the entry has put it in `catalog.json`. */
export const modelStandInIsShipped = (): boolean => shippedCatalogFile().entries.some((entry) => entry.id === MODEL_STAND_IN_ID);
/** The entry as the next catalog will carry it: the shipped one when it is there, else the staged one. */
export const modelStandInEntry = (): CatalogEntry => shippedCatalogFile().entries.find((entry) => entry.id === MODEL_STAND_IN_ID) ?? stagedModelStandInEntry();
/** The shipped catalog with the staged entry merged in (what the signing step's merge produces), or the shipped catalog when the entry is already in it. */
export const catalogWithModelStandIn = (): ServiceCatalog => {
  const shipped = shippedCatalogFile();
  return modelStandInIsShipped() ? shipped : ServiceCatalogSchema.parse({ ...shipped, entries: [...shipped.entries, stagedModelStandInEntry()] });
};
