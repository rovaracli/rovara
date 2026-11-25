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
  /** The one account whose processes may honour the staging-only keys, from the release's own configuration (`readCatalogStagingAccountId`). Never a literal in code. Undefined when the release did not set it: a staging build then refuses (see `trustedKeyPemsOf`). */
  readonly stagingAccountId: string | undefined;
}

/** The environment variable that carries the staging account id. The release sets it (beta and prod each their own value); no account id is written in this repository. */
export const CATALOG_STAGING_ACCOUNT_ENV = "ROVARA_CATALOG_STAGING_ACCOUNT_ID";

/** The stable code of the refusal when a staging build runs without a usable staging account id. */
export const CATALOG_STAGING_ACCOUNT_REFUSAL = "catalog_staging_account_unset";

export class CatalogTrustConfigError extends Error {
  readonly code = CATALOG_STAGING_ACCOUNT_REFUSAL;
  constructor() {
    super(`${CATALOG_STAGING_ACCOUNT_REFUSAL}: ${CATALOG_STAGING_ACCOUNT_ENV} must hold the 12-digit staging account id in a staging build; the staging-only catalog keys are not trusted without it`);
    this.name = "CatalogTrustConfigError";
  }
}

/** The configured staging account id, or undefined when the variable is absent, blank or not exactly 12 digits (a malformed value is treated as unset, never guessed at). */
export function readCatalogStagingAccountId(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env[CATALOG_STAGING_ACCOUNT_ENV]?.trim();
  return value !== undefined && /^[0-9]{12}$/u.test(value) ? value : undefined;
}

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

/**
 * The PEM keys that count: the real ones always; the staging-only ones only in a staging build AND in the configured staging account.
 * A staging build REFUSES (throws `CatalogTrustConfigError`, code `catalog_staging_account_unset`) when the staging account is not configured: there is no default account. A release build holds no staging keys
 * and never reads the setting, so it is unaffected.
 */
export function trustedKeyPemsOf(context: CatalogTrustContext, lists: CatalogTrustLists): string[] {
  const real = pemsOf(lists.real);
  if (lists.flavor !== "staging") return real;
  const configured = context.stagingAccountId;
  if (typeof configured !== "string" || !/^[0-9]{12}$/u.test(configured)) throw new CatalogTrustConfigError();
  const stagingAccount = typeof context.runningAccountId === "string" && context.runningAccountId === configured;
  return stagingAccount ? [...real, ...pemsOf(lists.stagingOnly)] : real;
}
