// Test services slice 1: which catalog keys a verifier trusts, as pure functions of the lists it is GIVEN. NOT exported from the package's index: production code reaches it only through `catalog-trust.ts`, which gives
// it the compiled-in lists and nothing else; tests reach it through `@agentx/contracts/testing`, which lets them give their own.
import { parseBundlePublicKey } from "./bundle.js";

export interface CatalogSigningKey {
  /** SHA-256 (hex) of the key's SubjectPublicKeyInfo DER, as `parseBundlePublicKey` computes it. A key whose id does not match its PEM is dropped. */
  readonly keyId: string;
  /** The public key as a PEM PUBLIC KEY (SPKI), ECDSA P-256. */
  readonly publicKey: string;
  readonly algorithm: "ECDSA_SHA_256";
}

export interface CatalogTrustContext {
  /** The AWS account the process is running in, from its own identity. Undefined when it could not be found: the staging-only keys are then not trusted. */
  readonly runningAccountId: string | undefined;
}

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
