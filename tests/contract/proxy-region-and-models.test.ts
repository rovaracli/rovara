// Ruling R52 (with R21): the model proxy's inference-profile geography follows the install's region, and an environment whose
// models the proxy cannot serve is refused before anything deploys.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { bedrockClaudeModelIds, proxyGeographyForRegion, proxyGeographyOfModelId } from "../../packages/model-runtime/src/catalog.js";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { assertModelsServedByProxy } from "../../packages/cli/src/deploy/proxy-models.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Ref = { Ref?: string; "Fn::Join"?: [string, unknown[]] };

/** The model names the proxy of a control plane for this region is configured to serve. */
function servedModels(region: string | undefined): string[] {
  const template = Template.fromStack(new ControlPlaneStack(new App(), `Proxy${region ?? "Default"}`, { naming: environmentNaming("staging"), ...(region === undefined ? {} : { deploymentRegion: region }) }));
  const [, definition] = Object.entries(template.findResources("AWS::ECS::TaskDefinition"))[0]!;
  const environment = (definition as { Properties: { ContainerDefinitions: Array<{ Environment: Array<{ Name: string; Value: Ref }> }> } }).Properties.ContainerDefinitions[0]!.Environment;
  const yaml = environment.find((variable) => variable.Name === "LITELLM_CONFIG_YAML")!.Value["Fn::Join"]![1].map((part) => (typeof part === "string" ? part : "?")).join("");
  return [...yaml.matchAll(/model_name: "([^"]+)"/g)].map((match) => match[1]!);
}

describe("the proxy's geography follows the region", () => {
  it.each([["us-east-1", "us"], ["us-west-2", "us"], ["eu-west-1", "eu"], ["eu-central-1", "eu"], ["ap-southeast-1", "apac"], ["ap-northeast-1", "apac"]] as const)("%s serves the %s profiles", (region, geography) => {
    expect(proxyGeographyForRegion(region)).toBe(geography);
  });

  it.each(["sa-east-1", "ca-central-1", "me-south-1", "af-south-1", "cn-north-1", "", "nowhere"])("refuses %s, naming it", (region) => {
    expect(() => proxyGeographyForRegion(region)).toThrow(`region ${region}`);
  });

  it("reads a model id's geography from its prefix", () => {
    expect(proxyGeographyOfModelId("eu.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("eu");
    expect(proxyGeographyOfModelId("us.anthropic.claude-sonnet-4-6")).toBe("us");
    expect(proxyGeographyOfModelId("apac.anthropic.claude-sonnet-4-20250514-v1:0")).toBe("apac");
    expect(proxyGeographyOfModelId("anthropic.claude-sonnet-4-6")).toBeUndefined();
    expect(proxyGeographyOfModelId("gpt-5.4")).toBeUndefined();
  });

  it("the control plane's proxy serves the install region's profiles, us by default, and fails the synth for a region it cannot serve", () => {
    expect(servedModels(undefined)).toEqual(bedrockClaudeModelIds("us"));
    expect(servedModels("us-east-1")).toEqual(bedrockClaudeModelIds("us"));
    const eu = servedModels("eu-west-1");
    expect(eu).toEqual(bedrockClaudeModelIds("eu"));
    expect(eu.length).toBeGreaterThan(0);
    expect(eu.every((id) => id.startsWith("eu.anthropic.claude-"))).toBe(true);
    expect(() => servedModels("sa-east-1")).toThrow(/no Amazon Bedrock inference profile for region sa-east-1/);
  });

  it("a runtime on an eu install's proxy serves the eu profile its model names", async () => {
    const [euModel] = bedrockClaudeModelIds("eu");
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: euModel! }, { proxy: { baseUrl: "http://proxy.example.test:4000", apiKey: "sk-task" }, fetch: vi.fn() });
    expect(runtime.getModel("amazon-bedrock", euModel!)).toBeDefined();
    const usModel = bedrockClaudeModelIds("us")[0]!;
    expect(runtime.getModel("amazon-bedrock", usModel)).toBeUndefined();
  });
});

describe("assertModelsServedByProxy", () => {
  const models = { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" };
  const refusal = (value: Parameters<typeof assertModelsServedByProxy>[0], region = "us-east-1") => { try { assertModelsServedByProxy(value, region); } catch (error) { return error as { code: string; message: string }; } throw new Error("expected a refusal"); };

  it("accepts Bedrock Claude models of the region's geography", () => {
    expect(() => assertModelsServedByProxy(models, "us-east-1")).not.toThrow();
    expect(() => assertModelsServedByProxy({ ...models, providers: { worker: "amazon-bedrock" } }, "us-east-1")).not.toThrow();
    const eu = bedrockClaudeModelIds("eu")[0]!;
    expect(() => assertModelsServedByProxy({ orchestrator: eu, classifier: eu, worker: eu }, "eu-west-1")).not.toThrow();
  });

  it.each(["orchestrator", "classifier", "worker"] as const)("refuses a %s on a provider the proxy does not serve, naming the role and the provider", (role) => {
    const error = refusal({ ...models, providers: { [role]: "openrouter" } });
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain(`the ${role} model provider is openrouter`);
    expect(error.message).toContain("model proxy");
    expect(error.message).toContain("us.anthropic.claude-");
    for (const provider of ["anthropic", "openai"] as const) expect(refusal({ ...models, providers: { [role]: provider } }).message).toContain(`is ${provider}`);
  });

  it("refuses a Bedrock model the proxy does not serve, and a us model on an eu install", () => {
    expect(refusal({ ...models, worker: "zai.glm-4.7" }).message).toContain("the worker model zai.glm-4.7 is not one the model proxy serves in us-east-1");
    const error = refusal(models, "eu-west-1");
    expect(error.message).toContain("the orchestrator model us.anthropic.claude-sonnet-4-6 is not one the model proxy serves in eu-west-1");
    expect(error.message).toContain("eu.*");
  });

  it("refuses a region the proxy has no profile for, as CONFIG_INVALID", () => {
    expect(refusal(models, "sa-east-1")).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("region sa-east-1") as string });
  });
});
