// Test services slice 1: which catalog keys a verifier trusts, as pure functions of the lists it is GIVEN. NOT exported from the package's index: production code reaches it only through `catalog-trust.ts`, which gives
// it the compiled-in lists and nothing else; tests reach it through `@agentx/contracts/testing`, which lets them give their own.
import { type CatalogSigningKey, type CatalogTrustContext, parseBundlePublicKey } from "@rovara-code/contracts";

/** The staging account. A constant on purpose. */
export const CATALOG_STAGING_ACCOUNT_ID = "944937319445";

export interface CatalogTrustLists {
  readonly real: readonly CatalogSigningKey[];
  readonly stagingOnly: readonly CatalogSigningKey[];
  readonly flavor: "release" | "staging";
}

function pemsOf(keys: readonly CatalogSigningKey[]): string[] {
  return keys.flatMap((key) => {
    try {
      return key.algorithm === "ECDSA_SHA_256" && parseBundlePublicKey(key.publicKey).keyId === key.keyId ? [key.publicKey] : [];
    } catch {
      return [];
    }
  });
}

/** The PEM keys that count: the real ones always; the staging-only ones only in a staging build AND in the staging account. */
export function trustedKeyPemsOf(context: CatalogTrustContext, lists: CatalogTrustLists): string[] {
  const real = pemsOf(lists.real);
  const stagingAccount = typeof context.runningAccountId === "string" && context.runningAccountId === CATALOG_STAGING_ACCOUNT_ID;
  return lists.flavor === "staging" && stagingAccount ? [...real, ...pemsOf(lists.stagingOnly)] : real;
}
