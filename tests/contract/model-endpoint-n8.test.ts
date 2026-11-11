// N8 (Enterprise): a company's own model endpoint. The pure rules: the schema (Public refuses the kind and its secret reference), what "qualified" means, the forbidden
// matcher, the address an endpoint may resolve to, and when an install has custom endpoints at all. The routes are in model-sources.test.ts, routing in model-routing.test.ts,
// the proxy side in model-proxy-sources.test.ts.
import { describe, expect, it } from "vitest";
import { MODEL_ENDPOINT_SECRET_PREFIX, ModelSourceSchema, endpointForbiddenModelProblem, endpointSecretRefProblem, isModelEndpointSecretRef, modelSourceInputSchema, modelSourceSchema, type ModelIdentifier } from "@rovara-code/contracts";
import { editionPolicy } from "@agentx/cloud-contracts";
import { endpointQualificationDigest, endpointQualified } from "../../packages/broker/src/model-sources/endpoint-digest.js";
import {
  checkModelEndpointHost, customEndpointsAllowed, endpointRangesFromEnvironment, modelEndpointChecker, modelEndpointInstall,
} from "../../packages/broker/src/model-sources/endpoint-qualification.js";

const sonnet: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const ORG = "org_abcdefghij0123456789";
const REF = `rovara/model-endpoints/${ORG}/llm.corp.example.com/gateway-key`;
const input = (extra: Record<string, unknown> = {}) => ({ kind: "endpoint", label: "Gateway", baseUrl: "https://llm.corp.example.com/v1", api: "openai-completions", models: [{ name: "our-model", catalog: sonnet }], ...extra });

describe("the schema: Public refuses the endpoint kind and its secret reference", () => {
  it("takes an endpoint where the edition has custom endpoints, and refuses it where it does not", () => {
    expect(modelSourceInputSchema({ customModelEndpoint: true }).safeParse(input({ keyRef: REF })).success).toBe(true);
    expect(modelSourceInputSchema().safeParse(input({ keyRef: REF })).success).toBe(true);
    const refused = modelSourceInputSchema({ customModelEndpoint: false }).safeParse(input({ keyRef: REF }));
    expect(refused.success).toBe(false);
    // The stored shape is refused too, so a record cannot be read back as an endpoint on Public.
    expect(modelSourceSchema({ customModelEndpoint: false }).safeParse({ ...input({ keyRef: REF }), sourceId: "src_aaaaaaaaaaaaaaaaaaaa" }).success).toBe(false);
    // The other kinds are untouched.
    expect(modelSourceInputSchema({ customModelEndpoint: false }).safeParse({ kind: "anthropic", label: "A", models: [{ catalog: sonnet }] }).success).toBe(true);
  });

  it("accepts a secret reference only as a name under the model-endpoint prefix", () => {
    for (const good of [REF, `rovara/model-endpoints/${ORG}/llm.corp.example.com/team-a/gateway_key.v2`, `rovara/model-endpoints/${ORG}/gw.example.com/k+=@-1`]) expect(isModelEndpointSecretRef(good), good).toBe(true);
    const bad = [
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:rovara/model-endpoints/x-AbCdEf", "agentx/staging/master-key", "rovara/model-endpoints", "rovara/model-endpoints/",
      "rovara/model-endpoints//x", "rovara/model-endpoints/x/", "rovara/model-endpoints/..", "rovara/model-endpoints/a/../b", "rovara/model-endpoints/./x", "/rovara/model-endpoints/x",
      "rovara/model-endpoints/with space", "rovara/model-endpoints/x?versionId=1", "rovara/model-endpoints/x#frag", "rovara/model-endpoints/ünï", `${MODEL_ENDPOINT_SECRET_PREFIX}${"a".repeat(200)}`, "sk-planted-value-0123456789abcdef", "",
      // The old shape, with no organization or host in the name, and shapes with a bad organization, host or name segment.
      "rovara/model-endpoints/gateway-key", `rovara/model-endpoints/${ORG}/gateway-key`, "rovara/model-endpoints/org_short/llm.example.com/k", `rovara/model-endpoints/${ORG}/LLM.example.com/k`,
      `rovara/model-endpoints/${ORG}/localhost/k`, `rovara/model-endpoints/${ORG}/llm.example.com/..`, `rovara/model-endpoints/${ORG}/llm.example.com/a/../b`, `rovara/model-endpoints/${ORG}/llm.example.com/`,
    ];
    for (const value of bad) {
      expect(isModelEndpointSecretRef(value), value).toBe(false);
      expect(modelSourceInputSchema().safeParse(input({ keyRef: value })).success, value).toBe(false);
    }
  });

  it("refuses a secret reference on any other kind, and a qualification digest from a client", () => {
    expect(modelSourceInputSchema().safeParse({ kind: "anthropic", label: "A", models: [{ catalog: sonnet }], keyRef: REF }).success).toBe(false);
    expect(modelSourceInputSchema().safeParse(input({ qualifiedDigest: "a".repeat(64) })).success).toBe(false);
    // The server-set field is part of the stored shape, as 64 hex characters only.
    const stored = { ...input(), sourceId: "src_aaaaaaaaaaaaaaaaaaaa" };
    expect(modelSourceSchema().safeParse({ ...stored, qualifiedDigest: "a".repeat(64) }).success).toBe(true);
    for (const digest of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) expect(modelSourceSchema().safeParse({ ...stored, qualifiedDigest: digest }).success, digest).toBe(false);
  });
});

describe("what qualified means", () => {
  const stored = (extra: Record<string, unknown> = {}) => ModelSourceSchema.parse({ ...input(), sourceId: "src_aaaaaaaaaaaaaaaaaaaa", ...extra });
  const endpointOf = (extra: Record<string, unknown> = {}) => { const source = stored(extra); if (source.kind !== "endpoint") throw new Error("expected an endpoint"); return source; };

  it("is the digest of the exact settings that were checked: the address, the wire format, the secret reference and every model", () => {
    const base = endpointOf({ keyRef: REF });
    const digest = endpointQualificationDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const qualified = stored({ keyRef: REF, qualifiedDigest: digest });
    expect(endpointQualified(qualified)).toBe(true);
    for (const change of [
      { baseUrl: "https://llm2.corp.example.com/v1" }, { api: "anthropic-messages" }, { keyRef: `rovara/model-endpoints/${ORG}/llm.corp.example.com/other` }, { keyRef: undefined },
      { models: [{ name: "renamed", catalog: sonnet }] }, { models: [{ name: "our-model", catalog: { provider: "anthropic", modelId: "claude-haiku-4-5" } }] },
      { models: [{ name: "our-model", catalog: sonnet }, { name: "second", catalog: { provider: "anthropic", modelId: "claude-haiku-4-5" } }] },
    ]) {
      expect(endpointQualified(ModelSourceSchema.parse({ ...qualified, ...change })), JSON.stringify(change)).toBe(false);
    }
  });

  it("ignores the label and the order of the models, and is not qualified without a digest or with a digest of other settings", () => {
    const two = [{ name: "b-model", catalog: sonnet }, { name: "a-model", catalog: { provider: "anthropic", modelId: "claude-haiku-4-5" } }];
    const digest = endpointQualificationDigest(endpointOf({ models: two }));
    expect(endpointQualificationDigest(endpointOf({ models: [...two].reverse(), label: "Renamed" }))).toBe(digest);
    expect(endpointQualified(stored())).toBe(false);
    expect(endpointQualified(stored({ qualifiedDigest: "b".repeat(64) }))).toBe(false);
  });

  it("is never true for a source that is not an endpoint", () => {
    expect(endpointQualified(ModelSourceSchema.parse({ kind: "anthropic", sourceId: "src_bbbbbbbbbbbbbbbbbbbb", label: "A", models: [{ catalog: sonnet }] }))).toBe(false);
  });
});

describe("the forbidden-model rule uses the shared matcher on the catalog model and on the served name", () => {
  const opus: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-1-20250805-v1:0" };
  const bedrockSonnet: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };

  it("refuses a catalog model on the list, however the list spells it", () => {
    expect(endpointForbiddenModelProblem([{ name: "ours", catalog: sonnet }], [{ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" }])).toBe("models.0: this model is forbidden in your company");
    expect(endpointForbiddenModelProblem([{ name: "ours", catalog: sonnet }], [])).toBeUndefined();
  });

  it("refuses a served name that is a forbidden model, whatever region prefix it carries", () => {
    for (const name of ["us.anthropic.claude-opus-4-1-20250805-v1:0", "eu.anthropic.claude-opus-4-1-20250805-v1:0", "apac.anthropic.claude-opus-4-1-20250805-v1:0", "global.anthropic.claude-opus-4-1-20250805-v1:0", "anthropic.claude-opus-4-1-20250805-v1:0"]) {
      expect(endpointForbiddenModelProblem([{ name, catalog: bedrockSonnet }], [opus]), name).toBe("models.0: this model is forbidden in your company");
    }
    expect(endpointForbiddenModelProblem([{ name: "eu.anthropic.claude-sonnet-4-6", catalog: bedrockSonnet }], [opus])).toBeUndefined();
  });

  it("names the position of the first model that is forbidden", () => {
    expect(endpointForbiddenModelProblem([{ name: "a", catalog: bedrockSonnet }, { name: "b", catalog: opus }], [opus])).toBe("models.1: this model is forbidden in your company");
  });
});

describe("the address an endpoint may resolve to", () => {
  const resolving = (...addresses: string[]) => ({ resolveHost: async () => addresses });
  const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as { code: string; message: string }; } throw new Error("expected a refusal"); };

  it("passes a host that resolves to public addresses only", async () => {
    await expect(checkModelEndpointHost("llm.example.com", resolving("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"))).resolves.toBeUndefined();
  });

  it("refuses the addresses Rovara never calls, whatever ranges are set: this machine, link-local and metadata, multicast, and an IPv4 address written as IPv6", async () => {
    const wide = { privateCidrs: ["10.0.0.0/8", "169.254.0.0/16"], rovaraCidrs: ["10.99.0.0/16"] };
    for (const address of ["127.0.0.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "not-an-address"]) {
      const error = await refusal(checkModelEndpointHost("llm.example.com", { ...wide, ...resolving(address) }));
      expect([error.code, error.message], address).toEqual(["CONFIG_INVALID", "CONFIG_INVALID: the endpoint host resolves to an address Rovara never calls"]);
    }
  });

  it("refuses one bad address among good ones", async () => {
    expect((await refusal(checkModelEndpointHost("llm.example.com", resolving("93.184.216.34", "169.254.169.254")))).code).toBe("CONFIG_INVALID");
  });

  it("refuses a private address unless the operator set a range for it, and then only inside the range", async () => {
    expect((await refusal(checkModelEndpointHost("llm.corp.example.com", resolving("10.4.5.6")))).message).toContain("private address outside the ranges");
    const ranges = { privateCidrs: ["10.4.0.0/16"] };
    await expect(checkModelEndpointHost("llm.corp.example.com", { ...ranges, ...resolving("10.4.5.6") })).resolves.toBeUndefined();
    expect((await refusal(checkModelEndpointHost("llm.corp.example.com", { ...ranges, ...resolving("10.5.5.6") }))).message).toContain("private address outside the ranges");
    expect((await refusal(checkModelEndpointHost("llm.corp.example.com", { ...ranges, ...resolving("10.4.5.6", "10.5.0.1") }))).code).toBe("CONFIG_INVALID");
    // An IPv4-mapped private address is judged by its IPv4 address.
    await expect(checkModelEndpointHost("llm.corp.example.com", { ...ranges, ...resolving("::ffff:10.4.5.6") })).resolves.toBeUndefined();
  });

  it("refuses the network Rovara itself runs in, even inside an operator range", async () => {
    const error = await refusal(checkModelEndpointHost("llm.corp.example.com", { privateCidrs: ["10.0.0.0/8"], rovaraCidrs: ["10.1.0.0/16"], ...resolving("10.1.2.3") }));
    expect(error.message).toContain("never calls");
  });

  it("fails closed on a lookup that fails (retryable), an empty answer and ranges that do not parse", async () => {
    expect((await refusal(checkModelEndpointHost("llm.example.com", { resolveHost: async () => { throw new Error("SERVFAIL for llm.example.com"); } }))).code).toBe("RUNTIME_UNAVAILABLE");
    expect((await refusal(checkModelEndpointHost("llm.example.com", resolving()))).code).toBe("CONFIG_INVALID");
    expect((await refusal(checkModelEndpointHost("llm.example.com", { privateCidrs: ["nonsense"], ...resolving("93.184.216.34") }))).code).toBe("CONFIG_INVALID");
    expect((await refusal(checkModelEndpointHost("llm.example.com", { rovaraCidrs: ["nonsense"], ...resolving("93.184.216.34") }))).code).toBe("CONFIG_INVALID");
  });

  it("checks the URL's shape where the host is resolved: https, the standard port, no user info, a name rather than an address", async () => {
    const check = modelEndpointChecker(resolving("93.184.216.34"));
    await expect(check("https://llm.example.com/v1")).resolves.toBeUndefined();
    for (const url of ["http://llm.example.com/v1", "https://llm.example.com:4001/v1", "https://user:pw@llm.example.com/v1", "https://10.0.0.5/v1", "https://[::1]/v1", "not a url"]) {
      expect((await refusal(check(url))).code, url).toBe("CONFIG_INVALID");
    }
  });

  it("reads the operator's ranges once, and refuses a public range, an overlap with Rovara's network and a missing Rovara network", () => {
    expect(endpointRangesFromEnvironment({})).toEqual({ privateCidrs: [], rovaraCidrs: [] });
    expect(endpointRangesFromEnvironment({ ROVARA_MODEL_ENDPOINT_CIDRS: "10.4.0.0/16, 172.20.0.0/16", ROVARA_VPC_CIDRS: "10.0.0.0/16" })).toEqual({ privateCidrs: ["10.4.0.0/16", "172.20.0.0/16"], rovaraCidrs: ["10.0.0.0/16"] });
    expect(() => endpointRangesFromEnvironment({ ROVARA_MODEL_ENDPOINT_CIDRS: "8.8.8.0/24", ROVARA_VPC_CIDRS: "10.0.0.0/16" })).toThrow("ROVARA_MODEL_ENDPOINT_CIDRS");
    expect(() => endpointRangesFromEnvironment({ ROVARA_MODEL_ENDPOINT_CIDRS: "10.0.5.0/24", ROVARA_VPC_CIDRS: "10.0.0.0/16" })).toThrow("overlaps the network Rovara itself runs in");
    expect(() => endpointRangesFromEnvironment({ ROVARA_MODEL_ENDPOINT_CIDRS: "10.4.0.0/16" })).toThrow("ROVARA_VPC_CIDRS");
    expect(() => endpointRangesFromEnvironment({ ROVARA_MODEL_ENDPOINT_CIDRS: "169.254.0.0/16", ROVARA_VPC_CIDRS: "10.0.0.0/16" })).toThrow("private range");
  });
});

describe("when an install has custom model endpoints", () => {
  it("needs the edition's feature AND the operator's switch; Public and an install with no edition never have them", () => {
    const enterprise = editionPolicy("enterprise");
    const publicPolicy = editionPolicy("public");
    expect(customEndpointsAllowed(enterprise)).toBe(true);
    expect(customEndpointsAllowed(publicPolicy)).toBe(false);
    expect(customEndpointsAllowed(undefined)).toBe(false);
    expect(modelEndpointInstall({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }, enterprise).enabled).toBe(true);
    expect(modelEndpointInstall({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }, publicPolicy).enabled).toBe(false);
    expect(modelEndpointInstall({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }, undefined).enabled).toBe(false);
    // Off by default, and only an exact "1" turns it on.
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) expect(modelEndpointInstall({ ...(value === undefined ? {} : { ROVARA_CUSTOM_MODEL_ENDPOINTS: value }) }, enterprise).enabled, String(value)).toBe(false);
  });

  it("stops the install on ranges that are wrong, rather than widening them", () => {
    expect(() => modelEndpointInstall({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "8.8.8.0/24", ROVARA_VPC_CIDRS: "10.0.0.0/16" }, editionPolicy("enterprise"))).toThrow("private range");
  });

  it("builds a checker that refuses a private address with no range set", async () => {
    const install = modelEndpointInstall({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }, editionPolicy("enterprise"), async () => ["10.4.5.6"]);
    if (!install.enabled) throw new Error("expected endpoints on");
    await expect(install.checkEndpoint("https://llm.corp.example.com/v1")).rejects.toThrow("private address outside the ranges");
  });
});

describe("the install's wiring (N8)", () => {
  const withEnv = async (env: Record<string, string>, run: () => Promise<void> | void) => {
    const { vi } = await import("vitest");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    try { await run(); } finally { vi.unstubAllEnvs(); }
  };

  it("adds the kind to the launch list, the edition and a checker only for an Enterprise install whose operator switched endpoints on", async () => {
    const { modelEndpointRouteOptions, customModelEndpointsOn } = await import("../../packages/broker/src/aws/broker/scope-helpers.js");
    const enterprise = { editionPolicy: editionPolicy("enterprise"), modelAccess: { access: { checkEndpoint: async () => undefined } } } as never;
    const publicInstall = { editionPolicy: editionPolicy("public") } as never;
    const legacy = {} as never;
    await withEnv({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }, () => {
      expect(customModelEndpointsOn(enterprise)).toBe(true);
      const on = modelEndpointRouteOptions(enterprise);
      expect(on.launch?.kinds).toEqual(["endpoint"]);
      expect(on.edition?.edition).toBe("enterprise");
      expect(typeof on.checkEndpoint).toBe("function");
      for (const install of [publicInstall, legacy]) {
        expect(customModelEndpointsOn(install)).toBe(false);
        const off = modelEndpointRouteOptions(install);
        expect(off.launch).toBeUndefined();
        expect(off.checkEndpoint).toBeUndefined();
      }
    });
    await withEnv({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "0" }, () => {
      expect(customModelEndpointsOn(enterprise)).toBe(false);
      expect(modelEndpointRouteOptions(enterprise).launch).toBeUndefined();
      // The edition is still passed on, so the routes refuse with the right sentence.
      expect(modelEndpointRouteOptions(enterprise).edition?.edition).toBe("enterprise");
    });
  });

  it("keeps the launch kinds an install or test supplied, and turns the feature off (never the routes) when the ranges are wrong", async () => {
    const { modelEndpointRouteOptions } = await import("../../packages/broker/src/aws/broker/scope-helpers.js");
    const supplied = { editionPolicy: editionPolicy("enterprise"), agents: { modelSources: { launch: { kinds: ["anthropic"] } } } } as never;
    await withEnv({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }, () => {
      expect(modelEndpointRouteOptions(supplied).launch?.kinds).toEqual(["anthropic", "endpoint"]);
    });
    await withEnv({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "8.8.8.0/24", ROVARA_VPC_CIDRS: "10.0.0.0/16" }, () => {
      const options = modelEndpointRouteOptions({ editionPolicy: editionPolicy("enterprise") } as never);
      expect(options.checkEndpoint).toBeUndefined();
    });
  });

  it("gives routing the edition and the company's forbidden models, read from the guardrails when asked", async () => {
    const { routingOf } = await import("../../packages/broker/src/aws/broker/scope-helpers.js");
    const { FakeDynamoDb } = await import("../support/fake-dynamodb.js");
    const { DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey } = await import("@rovara-code/contracts");
    const db = new FakeDynamoDb();
    const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as never;
    db.set({ ...agentGuardrailsKey(orgId), entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: [sonnet] } });
    await withEnv({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }, async () => {
      const routing = routingOf({ editionPolicy: editionPolicy("enterprise"), agents: {}, modelAccess: {}, documentClient: db, tableName: "state" } as never);
      expect(routing?.edition?.edition).toBe("enterprise");
      expect(routing?.launch?.kinds).toEqual(["endpoint"]);
      expect(await routing!.forbiddenModels!(orgId)).toEqual([sonnet]);
      // No edition on the install: nothing is passed, so routing cannot treat an endpoint as usable.
      expect(routingOf({ agents: {}, modelAccess: {}, documentClient: db, tableName: "state" } as never)?.edition).toBeUndefined();
    });
  });
});

describe("a secret reference belongs to its org and its host (S1, S3)", () => {
  const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz";
  const url = "https://llm.corp.example.com/v1";

  it("accepts this org's secret for this address's host", () => {
    expect(endpointSecretRefProblem(ORG as never, url, REF)).toBeUndefined();
    expect(endpointSecretRefProblem(ORG as never, "https://LLM.corp.example.com:443/v1", REF)).toBeUndefined();
  });

  it("refuses another org's secret, another host's secret and a malformed reference, without repeating the reference", () => {
    expect(endpointSecretRefProblem(OTHER_ORG as never, url, REF)).toBe("names a secret of another organization");
    expect(endpointSecretRefProblem(ORG as never, "https://other.corp.example.com/v1", REF)).toBe("names a secret for another host; a secret is named for the one host it is sent to");
    expect(endpointSecretRefProblem(ORG as never, "https://llm.corp.example.com.evil.example.net/v1", REF)).toContain("another host");
    expect(endpointSecretRefProblem(ORG as never, "not a url", REF)).toBe("needs a valid address to check the secret against");
    for (const bad of ["rovara/model-endpoints/gateway-key", `arn:aws:secretsmanager:us-east-1:123456789012:secret:${REF}`, "sk-planted-value-0123456789abcdef"]) {
      const problem = endpointSecretRefProblem(ORG, url, bad)!;
      expect(problem, bad).toMatch(/^must be a secret name of the form/u);
      expect(problem).not.toContain(bad);
    }
  });
});

describe("a forbidden model cannot hide behind another spelling (S2)", () => {
  const opus: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-1-20250805-v1:0" };

  it("reads a served name under every provider's rules, whatever the catalog entry's provider", () => {
    for (const catalog of [sonnet, { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" }, { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" }, { provider: "openai", modelId: "gpt-5" }]) {
      for (const name of [
        "us.anthropic.claude-opus-4-1-20250805-v1:0", "eu.anthropic.claude-opus-4-1-20250805-v1:0", "anthropic.claude-opus-4-1-20250805-v1:0", "anthropic/claude-opus-4-1", "anthropic/claude-opus-4.1",
        "bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0", "openrouter/anthropic/claude-opus-4.1", "claude-opus-4-1", "Claude-Opus-4.1", "claude-opus-4-1-20250805",
      ]) {
        expect(endpointForbiddenModelProblem([{ name, catalog }], [opus]), `${catalog.provider} ${name}`).toBe("models.0: this model is forbidden in your company");
      }
    }
  });

  it("does not refuse other models that merely look alike", () => {
    for (const name of ["us.anthropic.claude-sonnet-4-6", "anthropic/claude-sonnet-4-5", "claude-opus-4-5", "claude-opus-4", "my-claude-opus-4-1-proxy", "opus"]) {
      expect(endpointForbiddenModelProblem([{ name, catalog: sonnet }], [opus]), name).toBeUndefined();
    }
  });
});

describe("one answer for the whole feature when the ranges are wrong (S6)", () => {
  const withEnv = async (env: Record<string, string>, run: () => Promise<void> | void) => {
    const { vi } = await import("vitest");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    try { await run(); } finally { vi.unstubAllEnvs(); }
  };

  it("turns the launch list, the routes and routing all off when the ranges do not parse", async () => {
    const { customModelEndpointsOn, modelEndpointRouteOptions, routingOf } = await import("../../packages/broker/src/aws/broker/scope-helpers.js");
    const install = { editionPolicy: editionPolicy("enterprise"), agents: {}, modelAccess: { access: { checkEndpoint: async () => undefined } }, documentClient: {}, tableName: "state" } as never;
    await withEnv({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "10.4.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" }, () => {
      expect(customModelEndpointsOn(install)).toBe(true);
      expect(modelEndpointRouteOptions(install).launch?.kinds).toEqual(["endpoint"]);
      expect(routingOf(install)?.launch?.kinds).toEqual(["endpoint"]);
    });
    for (const bad of [{ ROVARA_MODEL_ENDPOINT_CIDRS: "8.8.8.0/24", ROVARA_VPC_CIDRS: "10.42.0.0/16" }, { ROVARA_MODEL_ENDPOINT_CIDRS: "nonsense", ROVARA_VPC_CIDRS: "10.42.0.0/16" }, { ROVARA_MODEL_ENDPOINT_CIDRS: "10.4.0.0/16" }]) {
      await withEnv({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ...bad }, () => {
        expect(customModelEndpointsOn(install), JSON.stringify(bad)).toBe(false);
        const options = modelEndpointRouteOptions(install);
        expect(options.launch).toBeUndefined();
        expect(options.checkEndpoint).toBeUndefined();
        expect(routingOf(install)?.launch).toBeUndefined();
      });
    }
  });
});

describe("the broker judges no address itself (S4)", () => {
  it("hands the route's address check to the access function, inside the VPC, and has none when that function has none", async () => {
    const { vi } = await import("vitest");
    const { modelEndpointRouteOptions } = await import("../../packages/broker/src/aws/broker/scope-helpers.js");
    const checked: string[] = [];
    const access = { checkEndpoint: async (url: string) => { checked.push(url); } };
    vi.stubEnv("ROVARA_CUSTOM_MODEL_ENDPOINTS", "1");
    try {
      const options = modelEndpointRouteOptions({ editionPolicy: editionPolicy("enterprise"), modelAccess: { access } } as never);
      await options.checkEndpoint!("https://llm.corp.example.com/v1");
      expect(checked).toEqual(["https://llm.corp.example.com/v1"]);
      expect(modelEndpointRouteOptions({ editionPolicy: editionPolicy("enterprise"), modelAccess: { access: {} } } as never).checkEndpoint).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("a redirect from an approved endpoint host is never followed (N6)", () => {
  it("is refused by the proxy's own guard for every company model, so a redirect cannot carry a prompt to another host", async () => {
    const { ROVARA_GUARD_PY } = await import("../../packages/model-proxy/src/rovara-guard.js");
    // Every httpx client send is forced to follow_redirects=False, and the proxy refuses to start if a redirect would still be followed.
    expect(ROVARA_GUARD_PY).toContain('kwargs["follow_redirects"] = False');
    expect(ROVARA_GUARD_PY).toContain("httpx.AsyncClient.send = _no_redirect_async_send");
    expect(ROVARA_GUARD_PY).toContain("httpx.Client.send = _no_redirect_send");
    expect(ROVARA_GUARD_PY).toContain("_self_test()");
  });
});

describe("a Vertex-style served name is the same model (S2)", () => {
  const opus: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-1-20250805-v1:0" };

  it("reads a version after @ (a date, or latest) and a publisher path as the model they name", () => {
    for (const name of ["claude-opus-4-1@20250805", "claude-opus-4-1@latest", "publishers/anthropic/models/claude-opus-4-1@20250805", "anthropic.claude-opus-4-1@20250805", "us.anthropic.claude-opus-4-1@20250805", "Claude-Opus-4.1@20250805"]) {
      expect(endpointForbiddenModelProblem([{ name, catalog: sonnet }], [opus]), name).toBe("models.0: this model is forbidden in your company");
    }
  });

  it("reads a forbidden model written the Vertex way, whatever spelling the endpoint serves", () => {
    const vertex: ModelIdentifier = { provider: "vertex_ai", modelId: "claude-opus-4-1@20250805" };
    for (const name of ["claude-opus-4-1", "us.anthropic.claude-opus-4-1-20250805-v1:0", "anthropic/claude-opus-4-1", "claude-opus-4-1@20250805"]) {
      expect(endpointForbiddenModelProblem([{ name, catalog: sonnet }], [vertex]), name).toBe("models.0: this model is forbidden in your company");
    }
    // A catalog entry written the Vertex way is read too.
    expect(endpointForbiddenModelProblem([{ name: "ours", catalog: vertex }], [opus])).toBe("models.0: this model is forbidden in your company");
    expect(endpointForbiddenModelProblem([{ name: "claude-sonnet-4-5@20250929", catalog: sonnet }], [opus, vertex])).toBeUndefined();
  });
});

describe("the endpoint ranges are parsed once (R2)", () => {
  it("returns the same answer, not a new parse, for the same settings, and a new one when they change; a bad setting fails the same way every time", async () => {
    const { endpointRangesFromEnvironment: ranges } = await import("../../packages/broker/src/model-sources/endpoint-qualification.js");
    const env = { ROVARA_MODEL_ENDPOINT_CIDRS: "10.4.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" };
    const first = ranges(env);
    expect(ranges({ ...env })).toBe(first);
    expect(ranges({ ...env, ROVARA_MODEL_ENDPOINT_CIDRS: "10.5.0.0/16" })).not.toBe(first);
    const bad = { ROVARA_MODEL_ENDPOINT_CIDRS: "8.8.8.0/24", ROVARA_VPC_CIDRS: "10.42.0.0/16" };
    let error1: unknown, error2: unknown;
    try { ranges(bad); } catch (error) { error1 = error; }
    try { ranges({ ...bad }); } catch (error) { error2 = error; }
    expect(error1).toBeDefined();
    expect(error2).toBe(error1);
  });

  it("says a misconfigured range once, not on every call", async () => {
    const { vi } = await import("vitest");
    const { customModelEndpointsOn } = await import("../../packages/broker/src/aws/broker/scope-helpers.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("ROVARA_CUSTOM_MODEL_ENDPOINTS", "1");
    vi.stubEnv("ROVARA_MODEL_ENDPOINT_CIDRS", "9.9.9.0/24");
    vi.stubEnv("ROVARA_VPC_CIDRS", "10.42.0.0/16");
    try {
      const install = { editionPolicy: editionPolicy("enterprise") } as never;
      for (let call = 0; call < 5; call += 1) expect(customModelEndpointsOn(install)).toBe(false);
      expect(log.mock.calls.filter(([line]) => String(line).includes("model_endpoints.misconfigured"))).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); log.mockRestore(); }
  });
});
