// `@agentx/contracts/testing`: the seams tests need to exercise the catalog's trust with keys of their own. NOTHING in production code may import this (tests/contract/catalog-trust-seams.test.ts fails the build if it does):
// the production `loadSignedCatalog` and `catalogTrustedKeyPems` take no key list and no build flavor.
import { loadSignedCatalogWith, type LoadedCatalog } from "./catalog-load-core.js";
import { trustedKeyPemsOf, type CatalogTrustLists } from "./catalog-trust-core.js";
import { type CatalogTrustContext } from "@rovara-code/contracts";

export type { CatalogTrustLists } from "./catalog-trust-core.js";
export type { LoadedCatalog } from "./catalog-load-core.js";

/** `loadSignedCatalog` over the keys the test gives. */
export function loadSignedCatalogWithKeys(input: { catalogBytes: Uint8Array; signatureBytes: Uint8Array; trustedKeys: readonly string[] }): LoadedCatalog {
  return loadSignedCatalogWith(input, input.trustedKeys);
}

/** `catalogTrustedKeyPems` over the lists and the build flavor the test gives. */
export function trustedKeyPemsFor(context: CatalogTrustContext, lists: CatalogTrustLists): string[] {
  return trustedKeyPemsOf(context, lists);
}
