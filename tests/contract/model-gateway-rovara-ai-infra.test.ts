// DEC 240 in the gateway stack: Rovara's AI for agents. Made only with -c rovaraModelGatewayRovaraAi=<allow-list> beside
// -c rovaraModelGatewayProductAi=on, refused for production at synth. The serving role then gets EXACTLY bedrock:InvokeModel and
// bedrock:InvokeModelWithResponseStream on the allow-listed system inference profiles in its Region and, only through those
// profiles (bedrock:InferenceProfileArn), their foundation models in the profile's Regions. No other Bedrock action or resource.
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { parseRovaraAiModels } from "../../packages/model-gateway/src/agent-ai.js";
import { buildAgentXApp, rovaraAiContext } from "../../infra/lib/app.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_ENV, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY, rovaraAiModelIds } from "../../infra/lib/model-gateway.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const app = (context: Record<string, string>, env = "staging") => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: env, agentxRegion: "us-west-2", ...context });
const synth = (context: Record<string, string>) => Template.fromStack(app(context).node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, Resource> };
const MODELS = "claude-sonnet-5-5=us.anthropic.claude-sonnet-5-5,claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0";
const FOUNDERS = `org_${"f".repeat(20)}`;
const productOn = { [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" };
const on = synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: FOUNDERS });
const without = synth(productOn);

const statements = (t: { Resources: Record<string, Resource> }): Statement[] => Object.values(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy").flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const actionsOf = (s: Statement) => [s.Action].flat();
const bedrock = (t: { Resources: Record<string, Resource> }) => statements(t).filter((s) => actionsOf(s).some((a) => a.startsWith("bedrock:")));
const join = (parts: unknown[]) => ({ "Fn::Join": ["", parts] });
const profileArn = (id: string) => join(["arn:", { Ref: "AWS::Partition" }, ":bedrock:us-west-2:", { Ref: "AWS::AccountId" }, `:inference-profile/${id}`]);
const modelArn = (region: string, model: string) => join(["arn:", { Ref: "AWS::Partition" }, `:bedrock:${region}::foundation-model/${model}`]);
const serveEnv = (t: { Resources: Record<string, Resource> }) => {
  const task = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::ECS::TaskDefinition" && id.startsWith("ServeTask"))![1];
  const container = (task.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  return Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value]));
};

describe("Rovara's AI in the gateway stack (DEC 240)", () => {
  it("absent: no Bedrock grant and no Rovara's AI setting (the template as before)", () => {
    expect(bedrock(without)).toEqual([]);
    expect(serveEnv(without)[GATEWAY_ENV.rovaraAiModels]).toBeUndefined();
    expect(rovaraAiContext(undefined, undefined)).toEqual({});
  });

  it("on: exactly the two invoke actions, on the allow-listed profiles and (only through them) their models", () => {
    const granted = bedrock(on);
    expect(granted.map((s) => s.Sid).sort()).toEqual(["RovaraAiProfileModels", "RovaraAiProfiles"]);
    for (const s of granted) {
      expect(s.Effect).toBe("Allow");
      expect([...actionsOf(s)].sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    }
    const bySid: Record<string, Statement> = Object.fromEntries(granted.map((s) => [s.Sid ?? "", s]));
    const profiles = [profileArn("us.anthropic.claude-sonnet-5-5"), profileArn("us.anthropic.claude-haiku-4-5-20251001-v1:0")];
    expect(bySid.RovaraAiProfiles!.Resource).toEqual(profiles);
    expect(bySid.RovaraAiProfiles!.Condition).toBeUndefined();
    expect(bySid.RovaraAiProfileModels!.Resource).toEqual(["us-east-1", "us-east-2", "us-west-2"].map((r) => modelArn(r, "anthropic.claude-sonnet-5-5"))
      .concat(["us-east-1", "us-east-2", "us-west-2"].map((r) => modelArn(r, "anthropic.claude-haiku-4-5-20251001-v1:0"))));
    expect(bySid.RovaraAiProfileModels!.Condition).toEqual({ StringEquals: { "bedrock:InferenceProfileArn": profiles } });
    // Nothing else of Bedrock: no wildcard action, no control plane, no Marketplace, no other model.
    const all = statements(on).flatMap(actionsOf);
    expect(all.filter((a) => /^(bedrock|aws-marketplace|bedrock-mantle):/u.test(a)).sort()).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModelWithResponseStream"]);
    expect(JSON.stringify(granted)).not.toContain("*");
  });

  it("on: the process gets the allow-list and the operator's exempt list as set", () => {
    const env = serveEnv(on);
    expect(env[GATEWAY_ENV.rovaraAiModels]).toBe(MODELS);
    expect(env[GATEWAY_ENV.rovaraAiExempt]).toBe(FOUNDERS);
    expect(MODEL_GATEWAY_ENV.rovaraAiModels).toBe(GATEWAY_ENV.rovaraAiModels);
    expect(MODEL_GATEWAY_ENV.rovaraAiExempt).toBe(GATEWAY_ENV.rovaraAiExempt);
    expect(serveEnv(synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS }))[GATEWAY_ENV.rovaraAiExempt]).toBeUndefined();
  });

  it("a plain model id (no profile) is granted in this Region only", () => {
    const t = synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "claude-sonnet-5-5=anthropic.claude-sonnet-5-5" });
    expect(bedrock(t).map((s) => [s.Sid, [s.Resource].flat()])).toEqual([["RovaraAiModels", [modelArn("us-west-2", "anthropic.claude-sonnet-5-5")]]]);
  });

  it("refused at synth: production, without product AI (company-key mode), global or another geography, bad lists", () => {
    expect(() => app({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS }, "production")).toThrow(/^Rovara's AI is for named test environments/u);
    expect(() => synth({ [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS })).toThrow(/needs rovaraModelGatewayProductAi=on/u);
    for (const bad of ["claude-sonnet-5-5=global.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=eu.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5=us.meta.llama3", "x=us.anthropic.claude-a", "claude-a=us.anthropic.claude-a,claude-a=us.anthropic.claude-b"]) {
      expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: bad })).toThrow();
    }
    expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: MODELS, [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: "founders" })).toThrow();
    expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY]: FOUNDERS })).toThrow();
    expect(() => synth({ ...productOn, [MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY]: "" })).toThrow();
  });

  it("synth and the process accept and refuse the same allow-lists", () => {
    for (const value of [MODELS, "claude-sonnet-5-5=anthropic.claude-sonnet-5-5", "claude-a=global.anthropic.claude-a", "claude-a=eu.anthropic.claude-a", "claude-a=us.anthropic.claude-a=x", "a=us.anthropic.claude-a", ""]) {
      let synthOk = true; let processOk = true;
      try { rovaraAiModelIds(value, "us-west-2"); } catch { synthOk = false; }
      try { parseRovaraAiModels(value, "us-west-2"); } catch { processOk = false; }
      expect([value, synthOk]).toEqual([value, processOk]);
    }
  });
});
