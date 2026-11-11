// Test services slice 1: the ONLY source of trusted keys for the signed service catalog (`loadSignedCatalog`). Nothing here reads an environment variable, an SSM parameter, a setting or a file at run time: the keys are
// compiled in, and which of them count is decided by two facts a customer install cannot choose. There is NO parameter that adds a key or claims a build flavor: the seams tests need are in `@agentx/contracts/testing`
// (testing.ts), which no production code may import (tests/contract/catalog-trust-seams.test.ts).
//
//   CATALOG_TRUSTED_SIGNING_KEYS       real catalog keys (the dedicated signing account, SK-5). Honoured by every build in every environment. EMPTY until the owner names the key.
//   CATALOG_STAGING_ONLY_SIGNING_KEYS  the staging-only key (owner, 2026-11-03; catalog-staging-keys.ts). Honoured ONLY when BOTH hold:
//       1. the running AWS account is the staging account, CATALOG_STAGING_ACCOUNT_ID. The caller passes the account id it got from the process's own identity (the Lambda's invoked function ARN, or the instance
//          identity document read by the boot on a worker), never from configuration. A customer can name their environment "staging" and set any parameter or setting; they cannot run in our account;
//       2. this is a STAGING BUILD (`CATALOG_BUILD_FLAVOR`, catalog-build-flavor.ts). And in a release build the list itself is EMPTY: catalog-staging-keys.ts is generated empty for every build but a staging one, so the key
//          is not in release code at all.
//     An unknown account (the lookup failed), any other account, a release build, or an empty list all give no staging key. Production and Enterprise never consult it. EMPTY until the owner OKs creating the key.
//
// The caller's edition and environment name are deliberately NOT inputs: nothing a customer controls can widen trust.
import { CATALOG_BUILD_FLAVOR } from "./catalog-build-flavor.js";
import { CATALOG_STAGING_ONLY_SIGNING_KEYS } from "./catalog-staging-keys.js";
import { loadSignedCatalogWith, type LoadedCatalog } from "./catalog-load-core.js";
import { CATALOG_STAGING_ACCOUNT_ID, trustedKeyPemsOf } from "./catalog-trust-core.js";
import { CATALOG_TRUSTED_SIGNING_KEYS, type CatalogTrustContext } from "@rovara-code/contracts";
export { CATALOG_STAGING_ACCOUNT_ID, CATALOG_STAGING_ONLY_SIGNING_KEYS };

/** The PEM keys a verifier may trust right now. Possibly empty, and then nothing verifies (`loadSignedCatalog`: "no trusted catalog key"). Takes no list and no flavor: only the compiled-in ones. */
export function catalogTrustedKeyPems(context: CatalogTrustContext): string[] {
  return trustedKeyPemsOf(context, { real: CATALOG_TRUSTED_SIGNING_KEYS, stagingOnly: CATALOG_STAGING_ONLY_SIGNING_KEYS, flavor: CATALOG_BUILD_FLAVOR });
}

/** The signed catalog, verified with the compiled-in keys. `trust` carries the running account (from the process's own identity). Nothing else widens or narrows the keys. */
export function loadSignedCatalog(input: { catalogBytes: Uint8Array; signatureBytes: Uint8Array; trust?: CatalogTrustContext }): LoadedCatalog {
  return loadSignedCatalogWith(input, catalogTrustedKeyPems(input.trust ?? { runningAccountId: undefined }));
}
