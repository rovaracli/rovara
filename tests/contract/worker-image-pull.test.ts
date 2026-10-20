// Task 25 Part B fix round 1 (F3, F4): a named environment's worker role reads exactly the repository of the worker image the
// environment is configured with, wherever that image lives, and may create or import a repository only under its own
// pull-through prefix. Every case is evaluated from the synthesised runtime template with the image URI as a parameter.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { evaluate, evaluateCondition, type CfnContext } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const DIGEST = `sha256:${"a".repeat(64)}`;
const ACCOUNT = "123456789012";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-worker-InstanceRole-ABC123`;
const image = (repository: string, region = "us-west-2") => `${ACCOUNT}.dkr.ecr.${region}.amazonaws.com/${repository}@${DIGEST}`;

type Statement = { Effect: string; Action: string | string[]; Resource?: unknown; NotResource?: unknown };
type PolicyResource = { Type: string; Condition?: string; Properties: { PolicyName: string; Roles: unknown; PolicyDocument: { Statement: Statement[] } } };

describe("the named environment's worker role and its image", () => {
  let template: Record<string, unknown>;
  beforeAll(() => {
    const app = buildAgentXApp({ agentxEnv: "staging" });
    const stack = app.node.children.filter((child): child is Stack => Stack.isStack(child)).find((entry) => entry.stackName === "agentx-staging-runtime")!;
    template = Template.fromStack(stack).toJSON();
  }, 240_000);

  /** The role's policies for this image: each statement with Roles, Resource and NotResource evaluated. */
  function policies(workerImage: string) {
    const context: CfnContext = {
      parameters: { WorkerImageUri: workerImage, Ec2WorkerInstanceRoleArn: ROLE_ARN },
      conditions: (template.Conditions ?? {}) as Record<string, unknown>,
    };
    const resources = template.Resources as Record<string, PolicyResource>;
    return Object.values(resources)
      .filter((resource) => resource.Type === "AWS::IAM::Policy" && resource.Properties.PolicyName.startsWith("WorkerImagePull"))
      .filter((resource) => resource.Condition === undefined || evaluateCondition(resource.Condition, context))
      .map((resource) => ({
        roles: evaluate(resource.Properties.Roles, context) as string[],
        statements: evaluate(resource.Properties.PolicyDocument.Statement, context) as Statement[],
      }));
  }
  const glob = (pattern: string, text: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u").test(text);
  const matches = (statement: Statement, action: string, resource: string) => {
    if (![statement.Action].flat().includes(action)) return false;
    if (statement.NotResource !== undefined) return ![statement.NotResource].flat().some((pattern) => glob(pattern as string, resource));
    return [statement.Resource].flat().some((pattern) => glob(pattern as string, resource));
  };
  /** IAM's answer for the role: allowed by some Allow and denied by no Deny. */
  function can(workerImage: string, action: string, repository: string, region = "us-west-2"): boolean {
    const resource = `arn:aws:ecr:${region}:${ACCOUNT}:repository/${repository}`;
    const statements = policies(workerImage).flatMap((policy) => policy.statements);
    return statements.some((entry) => entry.Effect === "Allow" && matches(entry, action, resource))
      && !statements.some((entry) => entry.Effect === "Deny" && matches(entry, action, resource));
  }
  const PULL = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"];
  const CREATE = ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository"];
  const allowed = (workerImage: string, repository: string, region?: string) =>
    [...PULL, ...CREATE].filter((action) => can(workerImage, action, repository, region)).sort();

  it("takes the instance role and the image as parameters, and refuses an image that is not a private ECR digest reference", () => {
    const parameters = template.Parameters as Record<string, { AllowedPattern?: string }>;
    expect(parameters.Ec2WorkerInstanceRoleArn).toBeDefined();
    const pattern = new RegExp(parameters.WorkerImageUri!.AllowedPattern!, "u");
    expect(pattern.test(image("agentx-staging/worker"))).toBe(true);
    for (const bad of [
      `docker.io/library/node@${DIGEST}`, `${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker:latest`,
      `${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/@${DIGEST}`, `${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/UPPER/case@${DIGEST}`,
      `${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/a b@${DIGEST}`, `${ACCOUNT}.dkr.ecr.us-west-2.evil.example/agentx-staging/worker@${DIGEST}`,
      `12345.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@${DIGEST}`,
    ]) expect(pattern.test(bad), bad).toBe(false);
  });

  it("lets staging's hand-pushed image be pulled, from exactly its own repository (agentx-staging/worker)", () => {
    const hand = image("agentx-staging/worker");
    expect(allowed(hand, "agentx-staging/worker")).toEqual([...PULL, ...CREATE].sort());
    expect(policies(hand).flatMap((policy) => policy.roles)).toEqual(["agentx-staging-worker-InstanceRole-ABC123"]);
    // Nothing else in the account: not a sibling repository, not the CDK asset repository, not another account's.
    for (const other of ["agentx-staging/slack", "agentx-staging/worker-2", "cdk-hnb659fds-container-assets-123456789012-us-west-2", "agentx-production/worker"]) {
      expect(allowed(hand, other), other).toEqual([]);
    }
    expect(allowed(hand, "agentx-staging/worker", "us-east-1")).toEqual([]);
  });

  it("lets a pull-through release image be pulled and imported: <prefix>/<publisher alias>/agentx-worker", () => {
    const release = image("agentx-staging/agentx/agentx-worker");
    expect(allowed(release, "agentx-staging/agentx/agentx-worker")).toEqual([...PULL, ...CREATE].sort());
    expect(allowed(release, "agentx-staging/agentx/agentx-slack")).toEqual([]);
  });

  it("lets an override from a different repository be pulled, but never created or imported", () => {
    const override = image("platform-images/worker", "eu-west-1");
    expect(allowed(override, "platform-images/worker", "eu-west-1")).toEqual(PULL);
    expect(allowed(override, "agentx-staging/worker", "eu-west-1")).toEqual([]);
    // A name that merely starts like the prefix is not under it, nor is the prefix itself.
    expect(allowed(image("agentx-staging-other/worker"), "agentx-staging-other/worker")).toEqual(PULL);
    expect(allowed(image("agentx-staging"), "agentx-staging")).toEqual(PULL);
  });

  it("allows only the image's own repository: no wildcard resource and no repository/* in any Allow, and not the token", () => {
    for (const workerImage of [image("agentx-staging/worker"), image("agentx-staging/agentx/agentx-worker"), image("platform-images/worker", "eu-west-1")]) {
      const all = policies(workerImage);
      expect(all.length).toBeGreaterThan(0);
      for (const statement of all.flatMap((policy) => policy.statements).filter((entry) => entry.Effect === "Allow")) {
        expect([statement.Resource].flat()).toHaveLength(1);
        expect(JSON.stringify(statement.Resource)).not.toContain("*");
        expect(JSON.stringify(statement.Resource)).toMatch(/^"arn:aws:ecr:[a-z0-9-]+:123456789012:repository\/[a-z0-9._/-]+"$/u);
        expect([statement.Action].flat().join()).not.toContain("GetAuthorizationToken");
      }
    }
  });
});
