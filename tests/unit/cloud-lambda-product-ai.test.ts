// scripts/cloud-lambda.ts's product AI store (B7): off without its three settings, refused with only some of them, and built on the gateway's
// write-only store (AI Studio and Vertex product keys, learning accounts; a Vertex connect needs the gateway's address for its connection test).
import { describe, expect, it } from "vitest";
import { productAiStore } from "../../scripts/cloud-lambda.js";

const ENV = { AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "test-secret-not-real", CLOUD_PRODUCT_KEYS_TABLE: "gw-product-keys", CLOUD_PRODUCT_KEYS_KEY: "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-000000000000", CLOUD_PRODUCT_KEYS_MAC_KEY: "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-000000000001" };
describe("Cloud's product AI store", () => {
  it("is off unless all three settings are present, and refuses a partial set", () => {
    expect(productAiStore({})).toBeUndefined();
    expect(productAiStore(ENV)).toBeDefined();
    for (const name of ["CLOUD_PRODUCT_KEYS_TABLE", "CLOUD_PRODUCT_KEYS_KEY", "CLOUD_PRODUCT_KEYS_MAC_KEY"]) expect(() => productAiStore({ ...ENV, [name]: undefined })).toThrow(/go together/u);
  });
  const vertex = JSON.stringify({ scheme: "federation", projectId: "acme-evals", location: "us-central1", audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara-pool/providers/rovara-aws" });
  const connect = (store: NonNullable<ReturnType<typeof productAiStore>>, provider: "vertex" | "anthropic" | "openai", key: string, owner = "web") => store.connect({ iss: "https://code.example/v1/auth", cid: `org_${"a".repeat(20)}`, owner, requestId: "00000000-0000-4000-8000-000000000000", expectedRevision: 0, actor: { id: "a".repeat(64), role: "company_admin" }, sourceId: "src_vtx", provider, key });
  it("without the gateway's address, refuses a Vertex connect as unavailable before any AWS call", async () => {
    for (const env of [ENV, { ...ENV, CLOUD_MODEL_GATEWAY_URL: "" }]) await expect(connect(productAiStore(env)!, "vertex", vertex)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("takes the gateway's address only as https and a host; with it, the store has the gateway's Vertex test", () => {
    for (const bad of ["http://gateway.example", "https://gateway.example/v1", "gateway.example"]) expect(() => productAiStore({ ...ENV, CLOUD_MODEL_GATEWAY_URL: bad })).toThrow(/CLOUD_MODEL_GATEWAY_URL/u);
    expect(productAiStore({ ...ENV, CLOUD_MODEL_GATEWAY_URL: "https://gateway.staging.example", ROVARA_CODE_URL: "https://code.example" })).toBeDefined();
  });
  it("takes learning accounts only in the company's learning document (a project's Anthropic key is refused before any AWS call)", async () => {
    await expect(connect(productAiStore(ENV)!, "anthropic", "sk-ant-0123456789abcdef")).rejects.toMatchObject({ code: "invalid" });
    await expect(connect(productAiStore(ENV)!, "openai", "sk-proj-0123456789abcdef")).rejects.toMatchObject({ code: "invalid" });
  });
});
