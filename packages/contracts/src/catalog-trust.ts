// Test services slice 1: the ONLY source of trusted keys for the signed service catalog (`loadSignedCatalog`). Nothing here reads an environment variable, an SSM parameter, a setting or a file at run time: the keys are
// compiled in, and which of them count is decided by two facts a customer install cannot choose.
//
//   CATALOG_TRUSTED_SIGNING_KEYS       real catalog keys (the dedicated signing account, SK-5). Honoured by every build in every environment. EMPTY until the owner names the key.
//   CATALOG_STAGING_ONLY_SIGNING_KEYS  the staging-only key (owner, 2026-11-03). Honoured ONLY when BOTH hold:
//       1. the running AWS account is the staging account, CATALOG_STAGING_ACCOUNT_ID. The caller passes the account id it got from the process's own identity (the Lambda's invoked function ARN, or the instance
//          identity document / STS GetCallerIdentity on a worker), never from configuration. A customer can name their environment "staging" and set any parameter or setting; they cannot run in our account;
//       2. this is a STAGING BUILD (`CATALOG_BUILD_FLAVOR`, catalog-build-flavor.ts). Public and Enterprise release builds are made from a clean checkout whose flavor is "release", so even code that somehow ran in
//          the staging account from a release build would not trust the key.
//     An unknown account (the lookup failed), any other account, a release build, or an empty list all give no staging key. Production and Enterprise never consult it. EMPTY until the owner OKs creating the key.
//
// The caller's edition and environment name are deliberately NOT inputs: nothing a customer controls can widen trust.
import { parseBundlePublicKey } from "./bundle.js";
import { CATALOG_BUILD_FLAVOR } from "./catalog-build-flavor.js";

export interface CatalogSigningKey {
  /** SHA-256 (hex) of the key's SubjectPublicKeyInfo DER, as `parseBundlePublicKey` computes it. A key whose id does not match its PEM is dropped. */
  readonly keyId: string;
  /** The public key as a PEM PUBLIC KEY (SPKI), ECDSA P-256. */
  readonly publicKey: string;
  readonly algorithm: "ECDSA_SHA_256";
}

export const CATALOG_TRUSTED_SIGNING_KEYS: readonly CatalogSigningKey[] = [];
export const CATALOG_STAGING_ONLY_SIGNING_KEYS: readonly CatalogSigningKey[] = [];
/** The staging AWS account. A constant on purpose. */
export const CATALOG_STAGING_ACCOUNT_ID = "944937319445";

export interface CatalogTrustContext {
  /** The AWS account the process is running in, from its own identity. Undefined when it could not be found: the staging-only keys are then not trusted. */
  readonly runningAccountId: string | undefined;
}

/** The lists and the build flavor, as parameters so a test can exercise each case; production callers leave them out. */
export interface CatalogTrustSources {
  readonly real?: readonly CatalogSigningKey[];
  readonly stagingOnly?: readonly CatalogSigningKey[];
  readonly flavor?: "release" | "staging";
}

/** The account id in an ARN (`arn:aws:lambda:us-west-2:944937319445:function:...`), or nothing. */
export function accountIdOfArn(arn: string | undefined): string | undefined {
  const match = typeof arn === "string" ? /^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:([0-9]{12}):/u.exec(arn) : null;
  return match?.[1];
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

/** The PEM keys a verifier may trust right now. Possibly empty, and then nothing verifies (`loadSignedCatalog`: "no trusted catalog key"). */
export function catalogTrustedKeyPems(context: CatalogTrustContext, sources: CatalogTrustSources = {}): string[] {
  const real = pemsOf(sources.real ?? CATALOG_TRUSTED_SIGNING_KEYS);
  const stagingBuild = (sources.flavor ?? CATALOG_BUILD_FLAVOR) === "staging";
  const stagingAccount = typeof context.runningAccountId === "string" && context.runningAccountId === CATALOG_STAGING_ACCOUNT_ID;
  return stagingBuild && stagingAccount ? [...real, ...pemsOf(sources.stagingOnly ?? CATALOG_STAGING_ONLY_SIGNING_KEYS)] : real;
}
