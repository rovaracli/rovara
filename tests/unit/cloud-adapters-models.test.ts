// Convergence lane A3: Cloud's model key store and model-provider adapters on Code's ports. No AWS: an in-memory Secrets Manager and a scripted STS.
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it } from "vitest";
import { ModelProviderError, SecretValue, bedrockExternalId } from "@rovara-code/contracts";
import { assertBuiltinIdsKept, OPENROUTER_PROVIDER } from "@rovara-code/broker";
import { CloudModelKeyError, createCloudModelKeyStore, installModelKeyArns } from "../../packages/broker/src/cloud-adapters/model-keys/secrets-manager.js";
import { BEDROCK_ROLE_PROBLEM, cloudBedrockRoleProvider, type RoleStsClient } from "../../packages/broker/src/cloud-adapters/model-provider/bedrock-role.js";
import { cloudLiteLlmProvider } from "../../packages/broker/src/cloud-adapters/model-provider/litellm.js";
import { cloudOpenRouterProvider } from "../../packages/broker/src/cloud-adapters/model-provider/openrouter.js";
import { cloudCatalogPrices } from "../../packages/broker/src/cloud-adapters/model-provider/catalog-prices.js";
import { FakeModelKeySecrets, fakeSecretArn } from "../support/fake-model-key-secrets.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const KEY = ["sk", "test", "value", "123"].join("-");

describe("Cloud model key store", () => {
  it("reads the ARNs the stacks hand over, and ignores empty, none and malformed ones", () => {
    expect(installModelKeyArns({ AGENTX_OPENROUTER_SECRET_ARN: fakeSecretArn("openrouter"), AGENTX_ANTHROPIC_SECRET_ARN: "none", AGENTX_OPENAI_SECRET_ARN: "arn:aws:s3:::bucket" })).toEqual({ openrouter: fakeSecretArn("openrouter") });
    expect(installModelKeyArns({})).toEqual({});
  });

  it("gives every company the install's key, reads by ARN on every call, and lists only providers whose secret holds a key", async () => {
    const secrets = new FakeModelKeySecrets();
    const installKeys = secrets.hold({ openrouter: `  ${KEY}\n` });
    installKeys["anthropic"] = fakeSecretArn("anthropic-missing");
    const store = createCloudModelKeyStore({ secrets, installKeys });
    const key = await store.get(ORG, "openrouter");
    expect(key).toBeInstanceOf(SecretValue);
    expect(key?.reveal()).toBe(KEY);
    await store.get("org_bbbbbbbbbbbbbbbbbbbb", "openrouter");
    expect(secrets.reads).toEqual([fakeSecretArn("openrouter"), fakeSecretArn("openrouter")]);
    expect(await store.providers(ORG)).toEqual(["openrouter"]);
    expect(await store.get(ORG, "anthropic")).toBeUndefined();
    expect(await store.get(ORG, "toString")).toBeUndefined();
  });

  it("keeps a read key for cacheMs only, and never keeps a failure", async () => {
    let now = 0;
    const secrets = new FakeModelKeySecrets();
    const store = createCloudModelKeyStore({ secrets, installKeys: secrets.hold({ openai: "first" }), cacheMs: 1_000, now: () => now });
    expect((await store.get(ORG, "openai"))?.reveal()).toBe("first");
    secrets.secrets.set(fakeSecretArn("openai"), { string: "rotated" });
    expect((await store.get(ORG, "openai"))?.reveal()).toBe("first");
    now = 1_001;
    expect((await store.get(ORG, "openai"))?.reveal()).toBe("rotated");
  });

  it("refuses a non-company id, and says why a key cannot be read without the ARN, the value or AWS's words", async () => {
    const secrets = new FakeModelKeySecrets();
    const installKeys = { openai: fakeSecretArn("o"), anthropic: fakeSecretArn("a"), openrouter: fakeSecretArn("r") };
    secrets.secrets.set(installKeys.openai, { string: KEY, failure: "AccessDeniedException" });
    secrets.secrets.set(installKeys.anthropic, { string: KEY, failure: "DecryptionFailure" });
    secrets.secrets.set(installKeys.openrouter, { string: KEY, failure: "ThrottlingException" });
    const store = createCloudModelKeyStore({ secrets, installKeys });
    await expect(store.get("not-a-company", "openai")).rejects.toBeInstanceOf(CloudModelKeyError);
    const messages: string[] = [];
    for (const provider of ["openai", "anthropic", "openrouter"]) {
      const error = await store.get(ORG, provider).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CloudModelKeyError);
      messages.push((error as Error).message);
    }
    expect(messages).toEqual([
      "the openai key's secret may not be read by this role",
      "the anthropic key's secret could not be decrypted (check its KMS key policy)",
      "the openrouter key could not be read right now",
    ]);
    for (const message of messages) {
      expect(message).not.toContain("arn:");
      expect(message).not.toContain(KEY);
    }
    expect(await store.providers(ORG)).toEqual([]);
  });

  it("refuses a malformed ARN or provider id when it is built", () => {
    expect(() => createCloudModelKeyStore({ secrets: new FakeModelKeySecrets(), installKeys: { openai: "arn:aws:s3:::x" } })).toThrow(CloudModelKeyError);
    expect(() => createCloudModelKeyStore({ secrets: new FakeModelKeySecrets(), installKeys: { "Open AI": fakeSecretArn("x") } })).toThrow(CloudModelKeyError);
  });
});

function scriptedSts(answer: (input: AssumeRoleCommand["input"]) => { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: Date } | Error) {
  const calls: AssumeRoleCommand["input"][] = [];
  const sts: RoleStsClient = {
    async send(command) {
      calls.push(command.input);
      await Promise.resolve();
      const got = answer(command.input);
      if (got instanceof Error) throw got;
      return { Credentials: got };
    },
  };
  return { sts, calls };
}

describe("Cloud Bedrock role provider", () => {
  it("is Code's Bedrock provider signed with the company's role, external id and session name, assumed once per session", async () => {
    let now = Date.parse("2026-11-11T00:00:00Z");
    const { sts, calls } = scriptedSts(() => ({ AccessKeyId: "AKIDEXAMPLE", SecretAccessKey: ["s", "k"].join(""), SessionToken: "token", Expiration: new Date(now + 900_000) }));
    const provider = cloudBedrockRoleProvider({ orgId: ORG, region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/rovara-bedrock", sts, now: () => now });
    expect(provider).toMatchObject({ kind: "bedrock-aaaaaaaaaaaaaaaaaaaa", address: "https://bedrock-runtime.us-west-2.amazonaws.com", signIn: { kind: "aws-sigv4", region: "us-west-2", service: "bedrock" } });
    const [first, second] = await Promise.all([provider.credential!(), provider.credential!()]);
    expect(JSON.parse(first!.reveal())).toEqual({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "sk", sessionToken: "token" });
    expect(second!.reveal()).toBe(first!.reveal());
    expect(calls).toEqual([{ RoleArn: "arn:aws:iam::123456789012:role/rovara-bedrock", RoleSessionName: `rovara-${ORG}`, ExternalId: bedrockExternalId(ORG), DurationSeconds: 900 }]);
    now += 850_000;
    await provider.credential!();
    expect(calls).toHaveLength(2);
    expect(() => assertBuiltinIdsKept(provider)).not.toThrow();
  });

  it("says the role could not be assumed, never AWS's words", async () => {
    const { sts } = scriptedSts(() => Object.assign(new Error("User arn:aws:sts::123456789012:assumed-role/x is not authorized to perform sts:AssumeRole on arn:aws:iam::123456789012:role/secret-name"), { name: "AccessDenied" }));
    const provider = cloudBedrockRoleProvider({ orgId: ORG, region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/secret-name", sts });
    expect(await provider.credential!()).toBeUndefined();
    expect(provider.credentialProblem!()).toBe(BEDROCK_ROLE_PROBLEM);
  });

  it("refuses the id amazon-bedrock, a bad ARN, region or company", () => {
    const { sts } = scriptedSts(() => new Error("x"));
    const base = { orgId: ORG, region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/r", sts };
    expect(() => cloudBedrockRoleProvider({ ...base, kind: "amazon-bedrock" })).toThrow();
    expect(() => cloudBedrockRoleProvider({ ...base, roleArn: "arn:aws:iam::1:user/u" })).toThrow();
    expect(() => cloudBedrockRoleProvider({ ...base, region: "west" })).toThrow();
    expect(() => cloudBedrockRoleProvider({ ...base, orgId: "org_x" })).toThrow();
  });
});

describe("Cloud model proxy (LiteLLM) provider", () => {
  it("speaks the three formats on the inference paths the load balancer forwards, signed with the task's proxy key", async () => {
    const key = new SecretValue(KEY);
    const provider = cloudLiteLlmProvider({ address: "https://models.internal.example.test:4000", taskKey: async () => key });
    expect(provider.signIn).toEqual({ kind: "bearer-key" });
    expect(provider.formats.map((entry) => [entry.format, entry.pathOverride])).toEqual([["anthropic-messages", "/v1/messages"], ["openai-responses", "/v1/responses"], ["openai-completions", "/chat/completions"]]);
    expect(provider.formats.every((entry) => !entry.capabilities.forcedToolChoice)).toBe(true);
    expect(await provider.credential!()).toBe(key);
  });

  it("names a missing or failed task key with a fixed sentence", async () => {
    const none = cloudLiteLlmProvider({ address: "https://models.example.test", taskKey: async () => undefined });
    expect(await none.credential!()).toBeUndefined();
    expect(none.credentialProblem!()).toBe("no model proxy key was minted for this task");
    const failing = cloudLiteLlmProvider({ address: "https://models.example.test", taskKey: async () => { throw new Error(`mint failed for ${KEY}`); } });
    expect(await failing.credential!()).toBeUndefined();
    expect(failing.credentialProblem!()).toBe("the model proxy key could not be minted right now");
  });

  it("is refused on today's plain-http internal listener by Code's address rule (an owner choice before wiring)", () => {
    expect(() => cloudLiteLlmProvider({ address: "http://internal-rovara-proxy-1.us-west-2.elb.amazonaws.com:4000", taskKey: async () => undefined })).toThrow(ModelProviderError);
  });
});

describe("Cloud OpenRouter provider", () => {
  it("is Code's built-in OpenRouter row with Cloud's catalog prices, so the built-in id keeps its address", () => {
    const provider = cloudOpenRouterProvider({ models: ["anthropic/claude-sonnet-4.5", "no-such/model"] });
    expect({ address: provider.address, signIn: provider.signIn, formats: provider.formats }).toEqual({ address: OPENROUTER_PROVIDER.address, signIn: OPENROUTER_PROVIDER.signIn, formats: OPENROUTER_PROVIDER.formats });
    expect(provider.prices?.currency).toBe("USD");
    expect(Object.keys(provider.prices!.models)).not.toContain("no-such/model");
    for (const price of Object.values(provider.prices!.models)) expect(price.inputMicrosPerMillionTokens > 0 || price.free === true).toBe(true);
  });

  it("turns catalog dollars per million tokens into micros, and leaves out unknown models", () => {
    const prices = cloudCatalogPrices("anthropic", ["claude-sonnet-4-5", "nope"]);
    const row = prices.models["claude-sonnet-4-5"];
    if (row !== undefined) expect(row.inputMicrosPerMillionTokens).toBeGreaterThan(100_000);
    expect(prices.models["nope"]).toBeUndefined();
  });
});
