// Meta repo lane B, fix round 1 (I2): an approved setup card is consent for one application. The helper is shared by every applier the registry holds (the built-in ones
// and the source, intake and secret lanes'), so its rules are tested on their own: the first use wins, a second use by another request is refused, a repeat of the same request
// may continue, a failed application gives the consent back (only the request that used it can), and an old or untimed approval has expired.
import { describe, expect, it } from "vitest";
import { AgentXError } from "@rovara-code/contracts";
import {
  SETUP_CONSENT_MAX_AGE_MS, SETUP_CONSENT_USED, consentHasExpired, consentIsUsed, giveBackConsent, useConsent,
} from "../../packages/broker/src/rovara-code/setup-consent.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const make = () => {
  const db = new FakeDynamoDb();
  return { deps: { documentClient: db as unknown as { send(command: unknown): Promise<unknown> }, tableName: "state", now: () => Date.UTC(2026, 9, 30) }, db };
};
const who = { orgId: TEST_ORG, project: "web", approvalId: "apr_1", by: "d".repeat(64) };

describe("using an approved card's consent", () => {
  it("lets the first request use it, refuses another request in fixed words, and lets a repeat of the first request go on", async () => {
    const { deps } = make();
    expect(await consentIsUsed(deps, TEST_ORG, "web", "apr_1")).toBe(false);
    await useConsent(deps, { ...who, requestId: "request-1" });
    expect(await consentIsUsed(deps, TEST_ORG, "web", "apr_1")).toBe(true);
    await expect(useConsent(deps, { ...who, requestId: "request-2" })).rejects.toMatchObject({ code: "APPROVAL_CLOSED" });
    await expect(useConsent(deps, { ...who, requestId: "request-2" })).rejects.toThrow(SETUP_CONSENT_USED);
    await expect(useConsent(deps, { ...who, requestId: "request-2" })).rejects.toBeInstanceOf(AgentXError);
    await expect(useConsent(deps, { ...who, requestId: "request-1" })).resolves.toBeUndefined();
  });

  it("is per card and per project: using one card uses no other", async () => {
    const { deps } = make();
    await useConsent(deps, { ...who, requestId: "request-1" });
    expect(await consentIsUsed(deps, TEST_ORG, "web", "apr_2")).toBe(false);
    expect(await consentIsUsed(deps, TEST_ORG, "other", "apr_1")).toBe(false);
  });

  it("gives the consent back only to the request that used it", async () => {
    const { deps } = make();
    await useConsent(deps, { ...who, requestId: "request-1" });
    await giveBackConsent(deps, { ...who, requestId: "request-2" });
    expect(await consentIsUsed(deps, TEST_ORG, "web", "apr_1")).toBe(true);
    await giveBackConsent(deps, { ...who, requestId: "request-1" });
    expect(await consentIsUsed(deps, TEST_ORG, "web", "apr_1")).toBe(false);
    await expect(useConsent(deps, { ...who, requestId: "request-3" })).resolves.toBeUndefined();
  });

  it("does not let a write error pass for a used consent", async () => {
    const { deps } = make();
    const broken = { ...deps, documentClient: { send: async () => { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); } } };
    await expect(useConsent(broken, { ...who, requestId: "request-1" })).rejects.toThrow("throttled");
  });
});

describe("when an approval has expired", () => {
  const now = Date.UTC(2026, 9, 30);
  it("counts an approval older than the limit, or with no time on record, as expired", () => {
    expect(consentHasExpired(new Date(now - SETUP_CONSENT_MAX_AGE_MS + 1000).toISOString(), now)).toBe(false);
    expect(consentHasExpired(new Date(now - SETUP_CONSENT_MAX_AGE_MS - 1000).toISOString(), now)).toBe(true);
    expect(consentHasExpired(undefined, now)).toBe(true);
    expect(consentHasExpired("not a time", now)).toBe(true);
  });
});
