// scripts/cloud-lambda.ts's product AI store (B7): off without its three settings, refused with only some of them, and built on the gateway's
// write-only store (AI Studio and Vertex product keys, learning accounts; a Vertex connect needs the gateway's address for its connection test).
import { denyNetwork } from "./model-gateway-no-network.js";
import { beforeAll, describe, expect, it } from "vitest";
import { productAiStore } from "../../scripts/cloud-lambda.js";

const ENV = { AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "test-secret-not-real", CLOUD_PRODUCT_KEYS_TABLE: "gw-product-keys", CLOUD_PRODUCT_KEYS_KEY: "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-000000000000", CLOUD_PRODUCT_KEYS_MAC_KEY: "arn:aws:kms:us-west-2:944937319445:key/00000000-0000-4000-8000-000000000001" };
beforeAll(denyNetwork);
describe("Cloud's product AI store", () => {
  it("is off unless all three settings are present, and refuses a partial set", () => {
    expect(productAiStore({})).toBeUndefined();
    expect(productAiStore(ENV)).toBeDefined();
    for (const name of ["CLOUD_PRODUCT_KEYS_TABLE", "CLOUD_PRODUCT_KEYS_KEY", "CLOUD_PRODUCT_KEYS_MAC_KEY"]) expect(() => productAiStore({ ...ENV, [name]: undefined })).toThrow(/go together/u);
  });
  const vertex = JSON.stringify({ scheme: "federation", projectId: "acme-evals", location: "us-central1", audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara-pool/providers/rovara-aws" });
  const connect = (store: NonNullable<ReturnType<typeof productAiStore>>, provider: "vertex" | "anthropic" | "openai" | "openrouter" | "endpoint", key: string, owner = "web") => store.connect({ iss: "https://code.example/v1/auth", cid: `org_${"a".repeat(20)}`, owner, requestId: "00000000-0000-4000-8000-000000000000", expectedRevision: 0, actor: { id: "a".repeat(64), role: "company_admin" }, sourceId: "src_vtx", provider, key });
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
  // A3-REVIEW-1 M2 (A2's part): the deployed store must take the company's OpenRouter account (DEC 254t), or every OpenRouter connect on a
  // deployed Cloud is refused as "invalid". With it, the connect gets past the provider check and stops only at KMS (no network here).
  it("takes a company OpenRouter account in the learning document (past the provider check, up to the KMS call)", async () => {
    const outcome = await connect(productAiStore(ENV)!, "openrouter", ["sk", "or", "v1", "0123456789abcdef"].join("-"), "_learning").then(() => "saved", (error: unknown) => (error as { code?: unknown }).code ?? "not a store refusal");
    expect(outcome).not.toBe("invalid");
    expect(outcome).not.toBe("saved");
    // A project never holds one.
    await expect(connect(productAiStore(ENV)!, "openrouter", ["sk", "or", "v1", "0123456789abcdef"].join("-"))).rejects.toMatchObject({ code: "invalid" });
  });
  // A3-REVIEW-1 M2: the same for the company's own endpoint (DEC 254t, A3): a valid sealed connection gets past the provider check.
  it("takes a company endpoint connection in the learning document (past the provider check, up to the KMS call)", async () => {
    const text = JSON.stringify({ scheme: "openai_compatible", baseUrl: "https://llm.example.com/v1", key: ["ep", "fake", "z".repeat(16)].join("-"), models: [{ name: "our-coder", catalog: { provider: "openai", modelId: "gpt-5-mini" } }] });
    const outcome = await connect(productAiStore(ENV)!, "endpoint", text, "_learning").then(() => "saved", (error: unknown) => (error as { code?: unknown }).code ?? "not a store refusal");
    expect(outcome).not.toBe("invalid");
    expect(outcome).not.toBe("saved");
    await expect(connect(productAiStore(ENV)!, "endpoint", text)).rejects.toMatchObject({ code: "invalid" });
  });
});
