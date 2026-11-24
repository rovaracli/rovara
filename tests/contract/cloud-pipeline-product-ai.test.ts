// PRODUCT-AI-PIPELINE-SWITCH: the Cloud release pipeline's deploy carries each environment's switches from CLOUD_PIPELINE_SWITCHES
// (config, never typed per run). Staging's deploy carries `-c rovaraModelGatewayProductAi=on`, so a release keeps the server's
// product key grants and settings; production never does (refused). Other environments deploy exactly as before.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CLOUD_APP_CONTEXT_KEY } from "../../infra/lib/cloud-app.js";
import { CLOUD_PIPELINE_SWITCHES, CloudReleasePipelineStack, PIPELINE_AI_SOURCE_KINDS_CONTEXT_KEY, pipelineDeployContext } from "../../infra/lib/cloud-release-pipeline.js";
import { AI_SOURCE_KINDS_CONTEXT_KEY } from "../../infra/lib/app.js";
import { PRODUCTION_SOURCE_KINDS_REFUSAL } from "../../packages/contracts/src/model-sources.js";
import { MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";

const deployCommand = (environmentName: string) => {
  const template = Template.fromStack(new CloudReleasePipelineStack(new App(), "RovaraCloudPipeline", { environmentName, env: { region: "us-east-1" } }));
  const project = Object.values(template.findResources("AWS::CodeBuild::Project")).map((each) => each.Properties as { Name: string; Source: { BuildSpec: string | { "Fn::Join": [string, unknown[]] } } }).find((each) => each.Name === `rovara-cloud-${environmentName}-deploy`)!;
  const source = project.Source.BuildSpec;
  const text = typeof source === "string" ? source : source["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<token>")).join("");
  const spec = JSON.parse(text) as { phases: { build: { commands: string[] } } };
  return spec.phases.build.commands[0]!.split("\n").find((line) => line.startsWith("npx cdk deploy"))!;
};
const SWITCH = `-c ${MODEL_GATEWAY_PRODUCT_CONTEXT_KEY}=on`;

describe("Cloud release pipeline: per-environment deploy switches", () => {
  it("the staging pipeline's deploy carries the product AI switch, from config", () => {
    expect(CLOUD_PIPELINE_SWITCHES.staging).toEqual({ productAi: true });
    const command = deployCommand("staging");
    expect(command).toBe(`npx cdk deploy RovaraCloudApp RovaraCloudWeb --app "node infra/dist/bin/agentx.js" -c ${CLOUD_APP_CONTEXT_KEY}="$ROVARA_ENV" -c agentxRegion="$AWS_REGION" ${SWITCH} --parameters CodeUrl="$CODE_URL" --require-approval never --progress events`);
  });

  it("beta's deploy carries it too, now that beta's gateway is deployed (Rovara-cloud#273)", () => {
    expect(CLOUD_PIPELINE_SWITCHES.beta).toEqual({ productAi: true, aiSourceKinds: "openai" });
    expect(pipelineDeployContext("beta")).toEqual([SWITCH, `-c ${AI_SOURCE_KINDS_CONTEXT_KEY}=openai`]);
    expect(deployCommand("beta")).toContain(SWITCH);
  });

  it("production's deploy carries it too, now that production's gateway is deployed (Rovara-cloud#247)", () => {
    expect(CLOUD_PIPELINE_SWITCHES.production).toEqual({ productAi: true, aiSourceKinds: "openai" });
    expect(deployCommand("production")).toContain(SWITCH);
    expect(deployCommand("production")).toContain(`-c ${AI_SOURCE_KINDS_CONTEXT_KEY}=openai`);
    expect(pipelineDeployContext("production")).toEqual([SWITCH, `-c ${AI_SOURCE_KINDS_CONTEXT_KEY}=openai`]);
    expect(pipelineDeployContext("production", { production: { productAi: true } })).toEqual([`-c ${MODEL_GATEWAY_PRODUCT_CONTEXT_KEY}=on`]);
    expect(pipelineDeployContext("staging", {})).toEqual([]);
  });

  it("an environment the config does not name deploys exactly as before", () => {
    expect(pipelineDeployContext("dev1")).toEqual([]);
    expect(deployCommand("dev1")).not.toContain(MODEL_GATEWAY_PRODUCT_CONTEXT_KEY);
  });

  it("Rovara-cloud#308: an environment's company AI source kinds are carried as the app's own context key", () => {
    expect(PIPELINE_AI_SOURCE_KINDS_CONTEXT_KEY).toBe(AI_SOURCE_KINDS_CONTEXT_KEY);
    expect(pipelineDeployContext("staging", { staging: { productAi: true, aiSourceKinds: "openai,openrouter" } })).toEqual([SWITCH, `-c ${AI_SOURCE_KINDS_CONTEXT_KEY}=openai,openrouter`]);
    expect(pipelineDeployContext("production", { production: { productAi: true, aiSourceKinds: "openai" } })).toEqual([SWITCH, `-c ${AI_SOURCE_KINDS_CONTEXT_KEY}=openai`]);
    expect(pipelineDeployContext("staging", { staging: { productAi: true, aiSourceKinds: "" } })).toEqual([SWITCH]);
    // A release never carries what a hand deploy would refuse: a malformed value, or a kind production may not switch on.
    expect(() => pipelineDeployContext("staging", { staging: { aiSourceKinds: "openai,openai" } })).toThrow("invalid AI source kinds");
    expect(() => pipelineDeployContext("production", { production: { productAi: true, aiSourceKinds: "openrouter" } })).toThrow(PRODUCTION_SOURCE_KINDS_REFUSAL);
  });

  it("the config is frozen: a run can't add a switch", () => {
    expect(Object.isFrozen(CLOUD_PIPELINE_SWITCHES)).toBe(true);
    expect(Object.isFrozen(CLOUD_PIPELINE_SWITCHES.staging)).toBe(true);
    expect(Object.isFrozen(CLOUD_PIPELINE_SWITCHES.production)).toBe(true);
  });
});
