// 0.5.15 (chore/0515-drop-callback-key-param): the NoEcho CallbackSigningKey parameter is gone from the named control-plane template and the CLI no longer sends it.
// CloudFormation refuses a deploy that passes a parameter the template does not declare, and one that omits a declared parameter that has no default. This file proves the
// upgrade of a stack deployed BEFORE the change (it still holds CallbackSigningKey) by the NEW CLI with the NEW template succeeds, against the real synthesized template.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { environmentStackName, type ReleaseManifest } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { deployEnvironment, type DeployAnswers } from "../../packages/cli/src/deploy/deploy-environment.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import { upgradeOrder, type DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ENV = "staging";
const HOLDER = "arn:aws:iam::123456789012:user/alice";
const stackName = (part: DeployPart) => environmentStackName(ENV, part);
type Declared = Record<string, { Default?: unknown; NoEcho?: boolean }>;

/** The named environment's real synthesized template parameters, per part (what the 0.5.15 release would ship). */
const declaredByPart = (): Map<string, Declared> => new Map(buildAgentXApp({ agentxEnv: ENV }).node.children
  .filter((child): child is Stack => Stack.isStack(child))
  .map((stack) => [stack.stackName, ((Template.fromStack(stack).toJSON() as { Parameters?: Declared }).Parameters ?? {})]));

/** CloudFormation's two parameter refusals on an UPDATE that sends explicit values (the templates engine sends no UsePreviousValue). */
function cloudFormationAccepts(parameters: Record<string, string>, declared: Declared): string | undefined {
  const unknown = Object.keys(parameters).filter((name) => !(name in declared));
  if (unknown.length > 0) return `Parameters: [${unknown.join(", ")}] do not exist in the template`;
  // The release's package parameters (AssetParameters...) are supplied by the release itself, not by this CLI's answers: not checked here.
  const missing = Object.entries(declared).filter(([name, p]) => p.Default === undefined && !(name in parameters) && !name.startsWith("AssetParameters")).map(([name]) => name);
  if (missing.length > 0) return `Parameters: [${missing.join(", ")}] must have values`;
  return undefined;
}

const OUTPUTS: Record<string, StackOutputs> = {
  [stackName("access")]: { ArtifactBucketName: "agentx-staging-access-artifactbucket-abc", CloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", OperatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", PullThroughPrefix: "agentx-staging" },
  [stackName("foundation")]: {
    VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2", SessionManagerSecurityGroupId: "sg-0123456789abcdef0", DispatcherSecurityGroupId: "sg-0fedcba9876543210",
    WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/k", Ec2WorkerInstanceRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/worker", Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0",
    Ec2WorkerSubnets: "us-east-1a=subnet-1,us-east-1b=subnet-2", Ec2WorkerSecurityGroupId: "sg-0fedcba9876543210",
  },
  [stackName("identity")]: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123", ClientId: "client123" },
  [stackName("control-plane")]: {
    ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com", SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask",
    SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo", SlackThreadsTableName: "t", TurnRecordsTableName: "tr", SlackThreadSessionBucketName: "b",
    SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x", OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts",
    ModelProxyUrl: "http://internal-proxy.example.test:4000", ModelProxySecurityGroupId: "sg-0123456789abcdef0",
  },
  [stackName("runtime")]: { RuntimeArn: "arn:runtime" },
  [stackName("slack")]: { OrchestratorArn: "arn:slack" },
};

const answers = (): DeployAnswers => ({
  env: ENV, region: "us-east-1", account: "123456789012",
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
  identity: { mode: "cognito" },
  github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
});

function secrets(initial: Record<string, string>): SecretValueStore {
  const values = new Map(Object.entries(initial));
  return { async get(name) { return values.get(name); }, async create(name, value) { values.set(name, value); } };
}

/** A release whose templates are the real synthesized ones (only their parameter lists matter to the CLI). */
function releaseWith(declared: Map<string, Declared>): LoadedRelease {
  const manifest: ReleaseManifest = {
    schemaVersion: 1, version: "0.5.15", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [],
    images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}` },
  };
  return {
    manifest, dir: "/nonexistent", regions: () => ["us-east-1"],
    template: (part) => JSON.stringify({ Parameters: declared.get(stackName(part)) ?? {} }),
    packagePath: () => { throw new Error("test setup: not expected"); },
  };
}

/** A deployer that behaves like CloudFormation about parameters, against the real synthesized template of each stack. */
function cloudFormationLike(declared: Map<string, Declared>): { deployer: StackDeployer; requests: DeployRequest[] } {
  const requests: DeployRequest[] = [];
  return {
    requests,
    deployer: {
      async deploy(request) {
        requests.push(request);
        const refusal = cloudFormationAccepts(request.parameters, declared.get(request.stackName) ?? {});
        if (refusal !== undefined) throw new Error(`${request.stackName}: ${refusal}`);
        return OUTPUTS[request.stackName]!;
      },
      async outputs(name) { return OUTPUTS[name]; },
    },
  };
}

describe("dropping the CallbackSigningKey parameter (0.5.15)", () => {
  const declared = declaredByPart();
  const parts: DeployPart[] = ["access", "foundation", "identity", "control-plane", "runtime", "slack"];

  it("the named control-plane template no longer declares it, and no named stack declares a NoEcho parameter (positive control: the control plane does declare its own parameters)", () => {
    const controlPlane = declared.get(stackName("control-plane"))!;
    expect(Object.keys(controlPlane)).toContain("GitHubAppId");
    expect(controlPlane).not.toHaveProperty("CallbackSigningKey");
    for (const [name, parameters] of declared) expect(Object.entries(parameters).filter(([, p]) => p.NoEcho === true), name).toEqual([]);
  });

  it("negative control: the CloudFormation stand-in refuses the old pass-through (a parameter its template does not declare)", () => {
    const controlPlane = declared.get(stackName("control-plane"))!;
    expect(cloudFormationAccepts({ CallbackSigningKey: "k".repeat(48) }, controlPlane)).toMatch(/\[CallbackSigningKey\] do not exist in the template/u);
  });

  it("a fresh install deploys every part, sending no CallbackSigningKey", async () => {
    const { deployer, requests } = cloudFormationLike(declared);
    await deployEnvironment({ mode: "install", engine: "templates", answers: answers(), release: releaseWith(declared), deployer, store: new MemoryParameterStore(), secrets: secrets({}), holder: HOLDER });
    expect(requests.map((request) => request.part)).toEqual(parts);
    for (const request of requests) expect(request.parameters).not.toHaveProperty("CallbackSigningKey");
  });

  it("upgrades an old stack that still holds CallbackSigningKey: the new CLI deploys the new template, sends none, keeps the operator's settings, and every stack is accepted", async () => {
    const store = new MemoryParameterStore();
    const key = "k".repeat(48);
    const keys = { [`agentx/${ENV}/callback-signing-key`]: key, [`agentx/${ENV}/erasure-hash-key`]: key };
    const first = cloudFormationLike(declared);
    await deployEnvironment({ mode: "install", engine: "templates", answers: answers(), release: releaseWith(declared), deployer: first.deployer, store, secrets: secrets(keys), holder: HOLDER });

    // The deployed (0.5.14-shaped) control-plane stack: the parameters CloudFormation reports, NoEcho read back as "****".
    const oldControlPlane = { CallbackSigningKey: "****", BudgetMonthlyUsd: "250", SlackThreadTurnsPerMinute: "12", GitHubAppId: "123" };
    const upgrade = cloudFormationLike(declared);
    const result = await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: answers(), release: releaseWith(declared), deployer: upgrade.deployer, store, secrets: secrets(keys), holder: HOLDER,
      deployedParameters: async (name) => (name === stackName("control-plane") ? oldControlPlane : undefined),
    });

    // Success: no stack was refused (the stand-in would have thrown), and all six deployed.
    expect(upgrade.requests.map((request) => request.part)).toEqual(upgradeOrder("cognito"));
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!.parameters;
    expect(controlPlane).not.toHaveProperty("CallbackSigningKey");
    // Positive control: the upgrade really did read the old stack and carry what the operator set.
    expect(controlPlane).toMatchObject({ BudgetMonthlyUsd: "250", SlackThreadTurnsPerMinute: "12" });
    // Nothing is reported dropped by mistake: the secret is simply never carried (DescribeStacks would give "****").
    expect(result.droppedParameters).toEqual([]);
    expect(JSON.stringify(upgrade.requests)).not.toContain("****");
  });

  it("an upgrade with a forced value for the old parameter is still filtered by the new template's declared names", async () => {
    const store = new MemoryParameterStore();
    const keys = { [`agentx/${ENV}/callback-signing-key`]: "k".repeat(48), [`agentx/${ENV}/erasure-hash-key`]: "k".repeat(48) };
    await deployEnvironment({ mode: "install", engine: "templates", answers: answers(), release: releaseWith(declared), deployer: cloudFormationLike(declared).deployer, store, secrets: secrets(keys), holder: HOLDER });
    const upgrade = cloudFormationLike(declared);
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: answers(), release: releaseWith(declared), deployer: upgrade.deployer, store, secrets: secrets(keys), holder: HOLDER,
      deployedParameters: async () => ({ CallbackSigningKey: "****" }), forcedParameters: { "control-plane": { CallbackSigningKey: "x".repeat(48), BudgetMonthlyUsd: "5" } },
    });
    expect(upgrade.requests.find((request) => request.part === "control-plane")!.parameters).not.toHaveProperty("CallbackSigningKey");
  });
});
