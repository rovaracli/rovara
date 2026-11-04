// Test services slice 1, T1 (TS-IMG-1): a named environment's worker role can pull the pinned catalog images from
// `rovara-catalog/<env>/svc/*` in this account and region, and can do nothing else with them. Evaluated from the synthesised
// runtime template. The grant is two read actions, named exactly: no wildcard action, no push, no repository creation, and no
// other repository (the worker image's own grant is a separate policy, see worker-image-pull.test.ts).
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { evaluate, type CfnContext } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const DIGEST = `sha256:${"a".repeat(64)}`;
const ACCOUNT = "123456789012";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-worker-InstanceRole-ABC123`;
const WORKER_IMAGE = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/worker@${DIGEST}`;

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: unknown };
type PolicyResource = { Type: string; Condition?: string; Properties: { PolicyName: string; Roles: unknown; PolicyDocument: { Statement: Statement[] } } };

function catalogPolicies(template: Record<string, unknown>) {
  const context: CfnContext = {
    parameters: { WorkerImageUri: WORKER_IMAGE, Ec2WorkerInstanceRoleArn: ROLE_ARN },
    conditions: (template.Conditions ?? {}) as Record<string, unknown>,
  };
  return Object.entries(template.Resources as Record<string, PolicyResource>)
    .filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && resource.Properties.PolicyName.startsWith("CatalogImagePull"))
    .map(([logicalId, resource]) => ({
      logicalId,
      condition: resource.Condition,
      roles: evaluate(resource.Properties.Roles, context) as string[],
      statements: evaluate(resource.Properties.PolicyDocument.Statement, context) as Statement[],
    }));
}

describe("the named environment's worker role and the catalog images (TS-IMG-1)", () => {
  let staging: Record<string, unknown>;
  let legacy: Record<string, unknown>;
  beforeAll(() => {
    const runtime = (agentxEnv: string | undefined, name: string) => {
      const app = buildAgentXApp(agentxEnv === undefined ? {} : { agentxEnv });
      const stack = app.node.children.filter((child): child is Stack => Stack.isStack(child)).find((entry) => entry.stackName === name)!;
      return Template.fromStack(stack).toJSON() as Record<string, unknown>;
    };
    staging = runtime("staging", "agentx-staging-runtime");
    legacy = runtime(undefined, "AgentXProductionRuntime");
  }, 480_000);

  it("allows exactly BatchGetImage and GetDownloadUrlForLayer, on the environment's svc repositories, for the worker instance role", () => {
    const [policy, ...rest] = catalogPolicies(staging);
    expect(rest).toEqual([]);
    expect(policy!.condition).toBeUndefined();
    expect(policy!.roles).toEqual(["agentx-staging-worker-InstanceRole-ABC123"]);
    expect(policy!.statements).toEqual([
      {
        Sid: "PullCatalogImages",
        Effect: "Allow",
        Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/rovara-catalog/staging/svc/*`,
      },
    ]);
  });

  it("names no wildcard action, no other environment, no push or create action, and not the authorization token", () => {
    const [policy] = catalogPolicies(staging);
    const text = JSON.stringify(policy!.statements);
    for (const action of policy!.statements.flatMap((entry) => [entry.Action].flat())) expect(action).not.toContain("*");
    expect(text).not.toMatch(/PutImage|InitiateLayerUpload|UploadLayerPart|CompleteLayerUpload|CreateRepository|BatchImportUpstreamImage|GetAuthorizationToken|BatchDeleteImage/u);
    expect(text).not.toContain("rovara-catalog/*");
    expect(text).not.toContain("repository/*");
    expect(text).not.toContain("/prod/");
    expect(policy!.statements.every((entry) => entry.Effect === "Allow")).toBe(true);
  });

  it("is not in the legacy deployment's runtime template", () => {
    expect(catalogPolicies(legacy)).toEqual([]);
  });
});
