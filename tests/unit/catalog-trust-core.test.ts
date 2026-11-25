// The catalog trust check's staging account comes from the release's configuration, never from a literal: a staging build refuses without it (stable code, no default),
// trusts the staging-only keys only in the configured account, and a release build never reads the setting.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseBundlePublicKey } from "../../packages/contracts/src/bundle.js";
import {
  CATALOG_STAGING_ACCOUNT_ENV,
  CATALOG_STAGING_ACCOUNT_REFUSAL,
  CatalogTrustConfigError,
  readCatalogStagingAccountId,
  trustedKeyPemsOf,
  type CatalogSigningKey,
  type CatalogTrustLists,
} from "../../packages/contracts/src/catalog-trust-core.js";

const CONFIGURED = "123456789012";
const OTHER = "210987654321";

function signingKey(): CatalogSigningKey {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { keyId: parseBundlePublicKey(publicPem).keyId, publicKey: publicPem, algorithm: "ECDSA_SHA_256" };
}

const REAL = signingKey();
const STAGING_ONLY = signingKey();
const lists = (flavor: CatalogTrustLists["flavor"]): CatalogTrustLists => ({ real: [REAL], stagingOnly: [STAGING_ONLY], flavor });

describe("catalog trust: the staging account is configuration", () => {
  it("a staging build refuses, with a stable code, when the staging account is not configured", () => {
    for (const stagingAccountId of [undefined, "", "   ", "12345", "abcdefghijkl", `${CONFIGURED}0`]) {
      const attempt = () => trustedKeyPemsOf({ runningAccountId: CONFIGURED, stagingAccountId }, lists("staging"));
      expect(attempt).toThrow(CatalogTrustConfigError);
      expect(attempt).toThrow(CATALOG_STAGING_ACCOUNT_REFUSAL);
    }
    expect(new CatalogTrustConfigError().code).toBe("catalog_staging_account_unset");
  });

  it("a staging build trusts the staging-only keys in the configured account", () => {
    expect(trustedKeyPemsOf({ runningAccountId: CONFIGURED, stagingAccountId: CONFIGURED }, lists("staging"))).toEqual([REAL.publicKey, STAGING_ONLY.publicKey]);
  });

  it("a staging build does not trust them in any other account, or when the running account is unknown", () => {
    expect(trustedKeyPemsOf({ runningAccountId: OTHER, stagingAccountId: CONFIGURED }, lists("staging"))).toEqual([REAL.publicKey]);
    expect(trustedKeyPemsOf({ runningAccountId: undefined, stagingAccountId: CONFIGURED }, lists("staging"))).toEqual([REAL.publicKey]);
  });

  it("a release build never trusts the staging-only keys, in any account, and does not need the setting", () => {
    expect(trustedKeyPemsOf({ runningAccountId: CONFIGURED, stagingAccountId: CONFIGURED }, lists("release"))).toEqual([REAL.publicKey]);
    expect(trustedKeyPemsOf({ runningAccountId: CONFIGURED, stagingAccountId: undefined }, lists("release"))).toEqual([REAL.publicKey]);
  });

  it("reads the account from the named environment variable, and treats anything but 12 digits as unset", () => {
    expect(CATALOG_STAGING_ACCOUNT_ENV).toBe("ROVARA_CATALOG_STAGING_ACCOUNT_ID");
    expect(readCatalogStagingAccountId({ [CATALOG_STAGING_ACCOUNT_ENV]: ` ${CONFIGURED} ` })).toBe(CONFIGURED);
    expect(readCatalogStagingAccountId({})).toBeUndefined();
    expect(readCatalogStagingAccountId({ [CATALOG_STAGING_ACCOUNT_ENV]: "" })).toBeUndefined();
    expect(readCatalogStagingAccountId({ [CATALOG_STAGING_ACCOUNT_ENV]: "not-an-account" })).toBeUndefined();
    expect(readCatalogStagingAccountId({ [CATALOG_STAGING_ACCOUNT_ENV]: "1234567890123" })).toBeUndefined();
  });
});
