// scripts/cloud-lambda.ts's product AI store (B7): off without its three settings, refused with only some of them, and built on the gateway's
// write-only store (AI Studio keys only; a Vertex connect needs the gateway's federation probe, so it answers unavailable here).
import { describe, expect, it } from "vitest";
import { productAiStore } from "../../scripts/cloud-lambda.js";

const ENV = { AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "test-secret-not-real", CLOUD_PRODUCT_KEYS_TABLE: "gw-product-keys", CLOUD_PRODUCT_KEYS_KEY: "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-000000000000", CLOUD_PRODUCT_KEYS_MAC_KEY: "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-000000000001" };
describe("Cloud's product AI store", () => {
  it("is off unless all three settings are present, and refuses a partial set", () => {
    expect(productAiStore({})).toBeUndefined();
    expect(productAiStore(ENV)).toBeDefined();
    for (const name of ["CLOUD_PRODUCT_KEYS_TABLE", "CLOUD_PRODUCT_KEYS_KEY", "CLOUD_PRODUCT_KEYS_MAC_KEY"]) expect(() => productAiStore({ ...ENV, [name]: undefined })).toThrow(/go together/u);
  });
  it("refuses a Vertex connect before any AWS call (no federation probe here)", async () => {
    const store = productAiStore(ENV)!;
    await expect(store.connect({ iss: "https://code.example/v1/auth", cid: `org_${"a".repeat(20)}`, owner: "web", requestId: "00000000-0000-4000-8000-000000000000", expectedRevision: 0, actor: { id: "a".repeat(64), role: "company_admin" }, sourceId: "src_vtx", provider: "vertex", key: "{}" })).rejects.toThrow();
  });
});
