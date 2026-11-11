import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
function statements(stack: Stack): Array<{ Action: string | string[]; Resource: unknown }> {
  return Object.values(Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: { PolicyDocument?: { Statement: Array<{ Action: string | string[]; Resource: unknown }> }; Policies?: Array<{ PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } }> } }>)
    .flatMap((r) => [...(r.Properties?.PolicyDocument?.Statement ?? []), ...(r.Properties?.Policies ?? []).flatMap((p) => p.PolicyDocument.Statement)]);
}
/** Every object anywhere in `value` whose Sid is `sid`. */
function findSid(value: unknown, sid: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => findSid(v, sid));
  if (value === null || typeof value !== "object") return [];
  const own = (value as { Sid?: unknown }).Sid === sid ? [value] : [];
  return [...own, ...Object.values(value).flatMap((v) => findSid(v, sid))];
}
const grants = (stack: Stack, action: string) => statements(stack).filter((s) => [s.Action].flat().includes(action)).map((s) => JSON.stringify(s.Resource));

describe("pulling AgentX images through the cache", () => {
  const stacks = stacksOf(buildAgentXApp({ agentxEnv: "staging" }));
  // The Slack service's execution role imports its image into the cache prefix. The EC2 worker role does not: its policy comes
  // from the runtime stack and names exactly the worker image's repository (worker-image-pull.test.ts).
  it("agentx-staging-slack may import upstream images into its cache prefix", () => {
    const stack = stacks.find((s) => s.stackName === "agentx-staging-slack")!;
    for (const action of ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) {
      expect(grants(stack, action).some((r) => r.includes("repository/agentx-staging/*\"")), action).toBe(true);
    }
  }, 240_000);

  it("agentx-staging-foundation grants no ECR repository access of its own", () => {
    const stack = stacks.find((s) => s.stackName === "agentx-staging-foundation")!;
    for (const action of ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) {
      expect(grants(stack, action), action).toEqual([]);
    }
  }, 240_000);

  it("names no literal region in the released slack template's pull-through statement or the runtime stack's worker image policy", () => {
    const released = buildAgentXApp({ agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxSynthesizer: "legacy" }).synth();
    const pullThrough = findSid(released.getStackByName(`agentx-${ENVIRONMENT_PLACEHOLDER}-slack`).template, "EcrPullThroughCache").map((st) => JSON.stringify(st));
    expect(pullThrough).toHaveLength(1);
    expect(pullThrough[0]).not.toContain("us-east-1");
    expect(pullThrough[0]).toContain('{"Ref":"AWS::Region"}');
    // The worker image policy takes its region from the image URI, so no region is written into the template at all.
    const workerImage = findSid(released.getStackByName(`agentx-${ENVIRONMENT_PLACEHOLDER}-runtime`).template, "PullWorkerImage").map((st) => JSON.stringify(st));
    expect(workerImage).toHaveLength(1);
    expect(workerImage[0]).not.toMatch(/us-east-1|us-west-2/u);
  }, 240_000);

  it("adds nothing to the deployment that predates environments", () => {
    for (const stack of stacksOf(buildAgentXApp())) {
      expect(grants(stack, "ecr:BatchImportUpstreamImage"), stack.stackName).toEqual([]);
    }
  }, 240_000);
});
