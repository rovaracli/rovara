import { writeCustomDomain } from "../../packages/cli/src/environments/custom-domain.js";
import { describe, expect, it } from "vitest";
import { environmentStackName, type ReleaseManifest } from "@rovara-code/contracts";
import { adoptOrphanedEditionRecord, settleEditionRecord } from "../../packages/cli/src/deploy/edition.js";
import { deployEnvironment, keptOperatorParameters, type DeployAnswers, type DeployEnvironmentInput } from "../../packages/cli/src/deploy/deploy-environment.js";
import { CDK_CONSTRUCT_IDS, cdkAppArguments, cdkDeployer, type CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { PROTECTED_PARTS, type DeployRequest, type StackDeployer, type StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import { OPERATOR_PARAMETERS, type DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { upgradeAnswers } from "../../packages/cli/src/upgrade/answers.js";
import { readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { SIGN_IN_PARAMETER_NAMES } from "../../packages/cli/src/signin/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";

const ENV = "staging";
const HOLDER = "arn:aws:iam::123456789012:user/alice";
const stackName = (part: DeployPart) => environmentStackName(ENV, part);

// ---- fakes -------------------------------------------------------------------------------------

/** Records every deploy request and returns the scripted outputs for its stack name; `outputs()` reads the same map. */
function fakeDeployer(scripted: Record<string, StackOutputs>): { deployer: StackDeployer; requests: DeployRequest[]; outputCalls: string[] } {
  const requests: DeployRequest[] = [];
  const outputCalls: string[] = [];
  return {
    requests,
    outputCalls,
    deployer: {
      async deploy(request) {
        requests.push(request);
        const result = scripted[request.stackName];
        if (result === undefined) throw new Error(`test setup: no scripted outputs for ${request.stackName}`);
        return result;
      },
      async outputs(name) {
        outputCalls.push(name);
        return scripted[name];
      },
    },
  };
}

/** Wraps `real` so that reading `flipName` returns `undefined` the first time and `real`'s actual
 * value on every read after that: models a settings write landing in the window between
 * `deployEnvironment`'s pre-lock check and the point where `lockHeld` hands control straight to
 * `work` (no lock of its own to make that window visible). Everything else passes through to `real`
 * unchanged. */
function flipOnceThenReveal(real: MemoryParameterStore, flipName: string): ParameterStore {
  let flipped = false;
  return {
    async get(name) {
      if (name === flipName && !flipped) {
        flipped = true;
        return undefined;
      }
      return real.get(name);
    },
    put: (name, value, options) => real.put(name, value, options),
    delete: (name) => real.delete(name),
    list: (path) => real.list(path),
  };
}

/** A deployed environment that reports no parameters: nothing for an upgrade to keep. */
const nothingDeployed = async (): Promise<Record<string, string> | undefined> => undefined;

function memorySecrets(initial: Record<string, string> = {}): SecretValueStore & { creates: Array<{ name: string; value: string }> } {
  const values = new Map(Object.entries(initial));
  const creates: Array<{ name: string; value: string }> = [];
  return {
    creates,
    async get(name) {
      return values.get(name);
    },
    async create(name, value) {
      creates.push({ name, value });
      values.set(name, value);
    },
  };
}

/** A small fake release: no real templates or packages to load, just what stackParameters needs. */
function fakeRelease(): LoadedRelease {
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: "1.2.3",
    gitCommit: "a".repeat(40),
    environmentPlaceholder: "qqenv-placeholderqq",
    templates: [],
    packages: [],
    images: {
      worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`,
      slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}`,
    },
  };
  return {
    manifest,
    dir: "/nonexistent",
    regions: () => ["us-east-1"],
    template: () => {
      throw new Error("test setup: template() is not expected to be called by the orchestrator");
    },
    packagePath: () => {
      throw new Error("test setup: packagePath() is not expected to be called by the orchestrator");
    },
  };
}

/**
 * A release whose control-plane template declares exactly `parameterNames` (F24: `deployEnvironment`
 * parses this to decide which stored sign-in keys it may pass). Only `("control-plane", region)` is
 * ever requested; any other request throws, matching `fakeRelease()`'s own "not expected to be
 * called" contract for parts/regions a test does not exercise.
 */
function fakeReleaseWithControlPlaneParameters(parameterNames: readonly string[], region = "us-east-1"): LoadedRelease {
  return {
    ...fakeRelease(),
    regions: () => [region],
    template: (part, requestedRegion) => {
      if (part !== "control-plane" || requestedRegion !== region) {
        throw new Error(`test setup: template(${part}, ${requestedRegion}) is not expected to be called`);
      }
      return JSON.stringify({ Parameters: Object.fromEntries(parameterNames.map((name) => [name, { Type: "String" }])) });
    },
  };
}

const baseAnswers = (): DeployAnswers => ({
  env: ENV,
  region: "us-east-1",
  account: "123456789012",
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
  identity: { mode: "cognito" },
  github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
});

/** Every part's scripted stack outputs, exactly enough for `stackParameters` to succeed for all six parts. */
function scriptedOutputs(): Record<string, StackOutputs> {
  return {
    [stackName("access")]: {
      ArtifactBucketName: "agentx-staging-access-artifactbucket-abc",
      CloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
      OperatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator",
      PullThroughPrefix: "agentx-staging",
    },
    [stackName("foundation")]: {
      VpcId: "vpc-0123456789abcdef0",
      PrivateSubnetIds: "subnet-1,subnet-2",
      SessionManagerSecurityGroupId: "sg-0123456789abcdef0",
      DispatcherSecurityGroupId: "sg-0fedcba9876543210",
      WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/k",
      Ec2WorkerInstanceRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/worker",
      Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-1,us-east-1b=subnet-2", Ec2WorkerSecurityGroupId: "sg-0fedcba9876543210",
      // The hosted cloud's foundation only (the DNS firewall's project allow list); a plain install's control plane ignores it.
      ProjectAllowListId: "rslvr-fdl-0123456789abcdef",
    },
    [stackName("identity")]: {
      Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc",
      Audience: "client123",
      ClientId: "client123",
    },
    [stackName("control-plane")]: {
      ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com",
      SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask",
      SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo",
      SlackThreadsTableName: "t",
      TurnRecordsTableName: "tr",
      SlackThreadSessionBucketName: "b",
      SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x",
      OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts",
      ModelProxyUrl: "http://internal-proxy.example.test:4000",
      ModelProxySecurityGroupId: "sg-0123456789abcdef0",
    },
    [stackName("runtime")]: { RuntimeArn: "arn:runtime" },
    [stackName("slack")]: { OrchestratorArn: "arn:slack" },
  };
}

// ---- tests ---------------------------------------------------------------------------------------

describe("deploy environment", () => {
  it("installs every part in install order, feeding outputs forward and using the service role after access", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const { deployer, requests } = fakeDeployer(scriptedOutputs());

    const result = await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER,
    });

    expect(requests.map((request) => request.part)).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    expect(requests[0]!.part).toBe("access");
    expect(requests[0]!.roleArn).toBeUndefined();
    const accessRoleArn = scriptedOutputs()[stackName("access")]!.CloudFormationRoleArn;
    for (const request of requests.slice(1)) expect(request.roleArn).toBe(accessRoleArn);

    const slackRequest = requests.find((request) => request.part === "slack")!;
    expect(slackRequest.parameters.ControlPlaneUrl).toBe(scriptedOutputs()[stackName("control-plane")]!.ApiEndpoint);
    // The runtime part is only the EC2 worker settings (#117): no retired runtime callback URL or capacity provider.
    const runtimeRequest = requests.find((request) => request.part === "runtime")!;
    expect(runtimeRequest.parameters).not.toHaveProperty("ControlPlaneUrl");
    expect(runtimeRequest.parameters).not.toHaveProperty("CapacityProviderArn");

    for (const request of requests) {
      expect(request.terminationProtection).toBe(PROTECTED_PARTS.has(request.part));
    }
    expect(requests.every((request) => request.stackName === stackName(request.part))).toBe(true);
    expect(result.settingsWritten).toBe(true);
  });

  it("sends the release's package parameters with the templates engine only: cdk uploads its own assets (Task 20 live check)", async () => {
    // live15eb: cdk deploy refused the change set, "Parameters: [AssetParameters...] do not exist in the template".
    const withPackage = (): LoadedRelease => {
      const release = fakeRelease();
      return { ...release, manifest: { ...release.manifest, packages: [{ assetId: "f".repeat(64), file: `packages/${"f".repeat(64)}.zip`, sha256: "e".repeat(64), parts: ["control-plane"], bucketParameter: "AssetBucket", keyParameter: "AssetKey", hashParameter: "AssetHash", keyParameterValue: `packages/||${"f".repeat(64)}.zip` }] } };
    };
    const controlPlane = async (engine: "templates" | "cdk") => {
      const { deployer, requests } = fakeDeployer(scriptedOutputs());
      await deployEnvironment({ mode: "install", engine, answers: baseAnswers(), release: withPackage(), deployer, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER });
      return requests.find((request) => request.part === "control-plane")!.parameters;
    };
    expect(await controlPlane("templates")).toMatchObject({ AssetBucket: scriptedOutputs()[stackName("access")]!.ArtifactBucketName, AssetKey: `packages/||${"f".repeat(64)}.zip`, AssetHash: "f".repeat(64) });
    const cdk = await controlPlane("cdk");
    expect(Object.keys(cdk).filter((name) => name.startsWith("Asset"))).toEqual([]);
    expect(cdk.GitHubAppId).toBe(baseAnswers().github.appId);
  });

  it("creates the callback signing key once and reuses it on later deploys", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();

    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed });

    expect(secrets.creates).toHaveLength(1);
    const firstKey = install.requests.find((request) => request.part === "control-plane")!.parameters.CallbackSigningKey;
    const secondKey = upgrade.requests.find((request) => request.part === "control-plane")!.parameters.CallbackSigningKey;
    expect(firstKey).toBeDefined();
    expect(firstKey!.length).toBeGreaterThanOrEqual(32);
    expect(secondKey).toBe(firstKey);
  });

  it("writes settings with the engine, version, stacks, identity and access block after an install", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const { deployer } = fakeDeployer(scriptedOutputs());
    const now = () => Date.parse("2026-09-26T00:00:00.000Z");
    const answers: DeployAnswers = { ...baseAnswers(), permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/agentx-boundary" };

    const result = await deployEnvironment({ mode: "install", engine: "templates", answers, release: fakeRelease(), deployer, store, secrets, holder: HOLDER, now });

    expect(result.settingsWritten).toBe(true);
    const settings = await readEnvironmentSettings(store, ENV);
    expect(settings).toEqual({
      schemaVersion: 1,
      env: ENV,
      account: "123456789012",
      region: "us-east-1",
      engine: "templates",
      version: "1.2.3",
      naming: "environment",
      stacks: {
        access: stackName("access"),
        foundation: stackName("foundation"),
        identity: stackName("identity"),
        runtime: stackName("runtime"),
        "control-plane": stackName("control-plane"),
        slack: stackName("slack"),
      },
      controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
      identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", audience: "client123", clientId: "client123" },
      models: answers.models,
      access: {
        artifactBucket: "agentx-staging-access-artifactbucket-abc",
        cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
        operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator",
        pullThroughPrefix: "agentx-staging",
        permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/agentx-boundary",
      },
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
  });

  it("adopts a retained edition record just before the foundation deploys, and only then (fix round 2, N-1)", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const events: string[] = [];
    const scripted = fakeDeployer(scriptedOutputs());
    const deployer: StackDeployer = { outputs: (name) => scripted.deployer.outputs(name), async deploy(request) { events.push(`deploy ${request.part}`); return scripted.deployer.deploy(request); } };
    await deployEnvironment({
      mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER,
      adoptEditionRecord: async () => { events.push("adopt"); },
    });
    expect(events.filter((event) => event === "adopt")).toHaveLength(1);
    expect(events.indexOf("adopt")).toBe(events.indexOf("deploy foundation") - 1);
  });

  it("runs afterAccess once, right after the access stack and before every other stack (the embedder image copy needs only the repository the access stack makes), and a throw stops the deploy before any other stack changes", async () => {
    const events: string[] = [];
    const scripted = fakeDeployer(scriptedOutputs());
    const deployer: StackDeployer = { outputs: (name) => scripted.deployer.outputs(name), async deploy(request) { events.push(`deploy ${request.part}`); return scripted.deployer.deploy(request); } };
    await deployEnvironment({
      mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER,
      afterAccess: async () => { events.push("copy"); },
    });
    expect(events.filter((event) => event === "copy")).toHaveLength(1);
    expect(events.indexOf("deploy access")).toBe(events.indexOf("copy") - 1);
    expect(events.indexOf("copy")).toBeLessThan(events.indexOf("deploy foundation"));
    expect(events.indexOf("copy")).toBeLessThan(events.indexOf("deploy control-plane"));
    // a refusal in the copy stops the deploy: only the access stack has deployed, so the environment is never split across releases
    const stopped: string[] = [];
    const again = fakeDeployer(scriptedOutputs());
    const guarded: StackDeployer = { outputs: (name) => again.deployer.outputs(name), async deploy(request) { stopped.push(request.part); return again.deployer.deploy(request); } };
    await expect(deployEnvironment({
      mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: guarded, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER,
      afterAccess: async () => { throw new Error("the copy refused"); },
    })).rejects.toThrow("the copy refused");
    expect(stopped).toEqual(["access"]);
    // when the run does not deploy the access stack, it runs before the first stack that is deployed
    const parted: string[] = [];
    const upgradeStore = new MemoryParameterStore();
    const upgradeSecrets = memorySecrets();
    await deployEnvironment({ mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store: upgradeStore, secrets: upgradeSecrets, holder: HOLDER });
    const third = fakeDeployer(scriptedOutputs());
    const partial: StackDeployer = { outputs: (name) => third.deployer.outputs(name), async deploy(request) { parted.push(`deploy ${request.part}`); return third.deployer.deploy(request); } };
    await deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: partial, store: upgradeStore, secrets: upgradeSecrets, holder: HOLDER, deployedParameters: nothingDeployed, parts: ["control-plane"], afterAccess: async () => { parted.push("copy"); } });
    expect(parted.slice(0, 2)).toEqual(["copy", "deploy control-plane"]);
    // the templates engine never calls it
    let called = false;
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER, afterAccess: async () => { called = true; } });
    expect(called).toBe(false);
  });

  it("puts the edition record back when the foundation deploy fails after the record was taken out of the way, and drops the backup when it completes (fix round 2)", async () => {
    const editions = new MemoryParameterStore();
    const record = "/agentx/staging/edition";
    editions.values.set(record, "enterprise");
    const adopt = () => adoptOrphanedEditionRecord({ store: editions, env: "staging", edition: "enterprise", foundationResources: async () => [] });
    const settle = (completed: boolean) => settleEditionRecord({ store: editions, env: "staging", completed });
    const base = fakeDeployer(scriptedOutputs());
    const failing: StackDeployer = { outputs: (name) => base.deployer.outputs(name), async deploy(request) { if (request.part === "foundation") { expect(editions.values.has(record)).toBe(false); throw new Error("the foundation deploy failed"); } return base.deployer.deploy(request); } };
    await expect(deployEnvironment({
      mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: failing, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER,
      adoptEditionRecord: adopt, settleEditionRecord: settle,
    })).rejects.toThrow("the foundation deploy failed");
    expect(editions.values.get(record)).toBe("enterprise");
    expect(editions.values.get("/agentx/staging/edition-backup")).toBe("enterprise");

    // A deploy that completes: the stack creates the record again, and the backup is removed.
    const scripted = fakeDeployer(scriptedOutputs());
    const creating: StackDeployer = { outputs: (name) => scripted.deployer.outputs(name), async deploy(request) { if (request.part === "foundation") editions.values.set(record, "enterprise"); return scripted.deployer.deploy(request); } };
    editions.values.delete(record);
    await deployEnvironment({ mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: creating, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER, adoptEditionRecord: adopt, settleEditionRecord: settle });
    expect(editions.values.has("/agentx/staging/edition-backup")).toBe(false);
    expect(editions.values.get(record)).toBe("enterprise");
  });

  it("upgrades in upgrade order and reads outputs of parts it does not deploy", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const upgrade = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed,
      parts: ["runtime", "control-plane"],
    });

    // Upgrade order deploys runtime before control-plane (unlike install order); both requested parts
    // are deployed, in that order, and control-plane's parameters come from the foundation it does not deploy.
    expect(upgrade.requests.map((request) => request.part)).toEqual(["runtime", "control-plane"]);
    const controlPlaneRequest = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlaneRequest.parameters.PrivateSubnetIds).toBe(scriptedOutputs()[stackName("foundation")]!.PrivateSubnetIds);
    // access, foundation, identity and slack are not deployed this run: their outputs come from the existing stacks.
    expect(upgrade.outputCalls).toEqual(expect.arrayContaining([stackName("access"), stackName("foundation"), stackName("identity"), stackName("slack")]));
    expect(result.outputs.access).toEqual(scriptedOutputs()[stackName("access")]);
    expect(result.outputs.foundation).toEqual(scriptedOutputs()[stackName("foundation")]);
    expect(result.settingsWritten).toBe(true);
  });

  it("refuses a different engine than the environment was installed with, before deploying anything, taking the lock or creating a key", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await writeEnvironmentSettings(store, stagingSettings);
    const attempt = fakeDeployer(scriptedOutputs());

    await expect(
      deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: attempt.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed }),
    ).rejects.toThrow("environment staging was installed with the templates engine; switching engines is not supported");
    expect(attempt.requests).toEqual([]);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
    expect(secrets.creates).toEqual([]);
  });

  it("refuses to deploy an environment adopted with legacy stack naming, before deploying anything, taking the lock or creating a key", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await writeEnvironmentSettings(store, { ...stagingSettings, naming: "legacy", engine: "cdk" });
    const attempt = fakeDeployer(scriptedOutputs());

    await expect(
      deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: attempt.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed }),
    ).rejects.toThrow("environment staging uses the legacy stack names; upgrading it with agentx deploy is not supported yet");
    expect(attempt.requests).toEqual([]);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
    expect(secrets.creates).toEqual([]);
  });

  it("refuses your own OIDC provider without clientId before deploying anything, taking the lock or creating a key", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const answers: DeployAnswers = { ...baseAnswers(), identity: { mode: "oidc", issuer: "https://login.example.com", audience: "api://agentx" } };
    const { deployer, requests } = fakeDeployer(scriptedOutputs());

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers, release: fakeRelease(), deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("bringing your own OIDC provider requires clientId to write environment settings (needed for agentx login)");

    expect(requests).toEqual([]);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
    expect(secrets.creates).toEqual([]);
  });

  it("throws instead of silently deploying a non-access part without the service role", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const outputs = scriptedOutputs();
    const accessOutputs = { ...outputs[stackName("access")]! };
    delete (accessOutputs as Record<string, string>).CloudFormationRoleArn;
    outputs[stackName("access")] = accessOutputs;
    const { deployer, requests } = fakeDeployer(outputs);

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow(`stack ${stackName("access")} has no output CloudFormationRoleArn`);

    // Access itself deployed fine (it needs no role); nothing after it was ever attempted without one.
    expect(requests.map((request) => request.part)).toEqual(["access"]);
  });

  it("resumes a failed install with no settings yet, reading already-deployed parts' outputs directly", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const outputs = scriptedOutputs();
    const failingAtRuntime: StackDeployer = {
      async deploy(request) {
        if (request.part === "runtime") throw new Error("runtime deploy failed");
        return outputs[request.stackName]!;
      },
      async outputs(name) {
        return outputs[name];
      },
    };

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: failingAtRuntime, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("runtime deploy failed");
    // The failed install never got far enough to write settings.
    expect(await readEnvironmentSettings(store, ENV)).toBeUndefined();

    // Resuming names only the parts still needed; access/foundation/identity/control-plane already
    // exist (from the failed attempt) but have no settings recording them yet.
    const resume = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: resume.deployer, store, secrets, holder: HOLDER,
      parts: ["runtime", "slack"],
    });

    expect(resume.requests.map((request) => request.part)).toEqual(["runtime", "slack"]);
    expect(resume.outputCalls).toEqual(
      expect.arrayContaining([stackName("access"), stackName("foundation"), stackName("identity"), stackName("control-plane")]),
    );
    expect(result.settingsWritten).toBe(true);
  });

  it("throws when a stack settings lists (access or identity) no longer reports outputs, instead of silently dropping it from rewritten settings", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const missingAccess = scriptedOutputs();
    delete missingAccess[stackName("access")];
    const { deployer } = fakeDeployer(missingAccess);

    await expect(
      deployEnvironment({
        mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed,
        parts: ["runtime"],
      }),
    ).rejects.toThrow(`stack ${stackName("access")} (environment staging's access stack) no longer reports outputs`);
  });

  it("refuses an upgrade of an environment that is not installed, and an install over an installed one", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();

    const freshUpgrade = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: freshUpgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed }),
    ).rejects.toThrow("environment staging is not installed; install it first");
    expect(freshUpgrade.requests).toEqual([]);

    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    const reinstall = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: reinstall.deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("environment staging is already installed; use upgrade");
    expect(reinstall.requests).toEqual([]);
  });

  it("deploys only the requested parts, in order, reading earlier parts' outputs", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });

    // A resumed/repeated install naming only one part: install mode with existing settings is refused
    // only when no `parts` is given.
    const resume = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: resume.deployer, store, secrets, holder: HOLDER,
      parts: ["runtime"],
    });

    expect(resume.requests.map((request) => request.part)).toEqual(["runtime"]);
    expect(resume.outputCalls).toEqual(
      expect.arrayContaining([stackName("access"), stackName("foundation"), stackName("identity"), stackName("control-plane"), stackName("slack")]),
    );
    const runtimeRequest = resume.requests[0]!;
    expect(runtimeRequest.parameters.WorkerImageUri).toContain(scriptedOutputs()[stackName("access")]!.PullThroughPrefix);
    expect(runtimeRequest.roleArn).toBe(scriptedOutputs()[stackName("access")]!.CloudFormationRoleArn);
    expect(result.settingsWritten).toBe(true);
  });

  it("holds the environment lock while deploying and releases it after a failure", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const outputs = scriptedOutputs();
    let sawLockHeld = false;
    const deployer: StackDeployer = {
      async deploy(request) {
        if (request.part === "foundation") {
          sawLockHeld = store.values.has("/agentx/staging/lock");
          throw new Error("boom");
        }
        return outputs[request.stackName]!;
      },
      async outputs(name) {
        return outputs[name];
      },
    };

    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("boom");

    expect(sawLockHeld).toBe(true);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it.each([
    { label: "a full install with SSM already populated (init resume)", mode: "install" as const, seedInstall: false, parts: undefined },
    { label: "a scoped upgrade naming only control-plane", mode: "upgrade" as const, seedInstall: true, parts: ["control-plane"] as DeployPart[] },
    { label: "a full upgrade", mode: "upgrade" as const, seedInstall: true, parts: undefined },
  ])("passes the stored sign-in settings to $label (Review Focus 4, R7)", async ({ mode, seedInstall, parts }) => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    // A release whose control-plane template declares every sign-in parameter, as any 25a+ release does.
    const release = fakeReleaseWithControlPlaneParameters([...SIGN_IN_PARAMETER_NAMES]);
    if (seedInstall) {
      const seed = fakeDeployer(scriptedOutputs());
      await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release, deployer: seed.deployer, store, secrets, holder: HOLDER });
    }
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));

    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode, engine: "templates", answers: baseAnswers(), release, deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed, ...(parts === undefined ? {} : { parts }) });
    expect(requests.find((request) => request.part === "control-plane")!.parameters).toMatchObject({ SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled" });
  });

  it("filters stored sign-in down to the keys an older release's control-plane template actually declares (F24)", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));

    // This release's control-plane template declares none of the sign-in parameters (a release from
    // before phase 25a, or the legacy template) — the sign-in keys must be dropped, not sent to a
    // template that would refuse them as unknown parameters.
    const release = fakeReleaseWithControlPlaneParameters([]);
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release, deployer, store, secrets, holder: HOLDER });

    const controlPlaneRequest = requests.find((request) => request.part === "control-plane")!;
    for (const name of SIGN_IN_PARAMETER_NAMES) expect(controlPlaneRequest.parameters).not.toHaveProperty(name);
  });

  it("passes the stored enabled-since cutoffs, and drops them for a release from before them (FR-045, F24)", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, since: { slack: 1790000000 }, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));
    const current = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters([...SIGN_IN_PARAMETER_NAMES]), deployer: current.deployer, store, secrets, holder: HOLDER });
    expect(current.requests.find((request) => request.part === "control-plane")!.parameters).toMatchObject({ DeveloperSignInSlack: "enabled", DeveloperSignInSlackSince: "1790000000", DeveloperOidcSince: "0" });

    const older = fakeDeployer(scriptedOutputs());
    const beforeCutoffs = SIGN_IN_PARAMETER_NAMES.filter((name) => !name.endsWith("Since"));
    await deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(beforeCutoffs), deployer: older.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed });
    const parameters = older.requests.find((request) => request.part === "control-plane")!.parameters;
    expect(parameters).toMatchObject({ DeveloperSignInSlack: "enabled" });
    expect(parameters).not.toHaveProperty("DeveloperSignInSlackSince");
    expect(parameters).not.toHaveProperty("DeveloperOidcSince");
  });

  it("names the release version and region, instead of a bare SyntaxError, when the control-plane template cannot be read", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));

    const corruptRelease: LoadedRelease = {
      ...fakeRelease(),
      regions: () => ["us-east-1"],
      template: (part, region) => {
        if (part !== "control-plane" || region !== "us-east-1") throw new Error(`test setup: template(${part}, ${region}) is not expected to be called`);
        return "{ this is not valid json";
      },
    };
    const { deployer } = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: corruptRelease, deployer, store, secrets, holder: HOLDER }),
    ).rejects.toThrow("the release's control-plane template for us-east-1 could not be read; rebuild or re-download release 1.2.3");
  });

  it("passes every sign-in key through when the release covers no region at all, instead of silently dropping them all (F24 fallback)", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));

    // fakeRelease()'s own template() always throws "not expected to be called by the orchestrator";
    // an empty regions() must mean it is never even asked (see templateParameterNames).
    const noRegionRelease: LoadedRelease = { ...fakeRelease(), regions: () => [] };
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: noRegionRelease, deployer, store, secrets, holder: HOLDER });

    const controlPlaneRequest = requests.find((request) => request.part === "control-plane")!;
    expect(controlPlaneRequest.parameters).toMatchObject({ SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled" });
  });

  it("does not read sign-in settings for a deploy without the control plane", async () => {
    const store = new MemoryParameterStore();
    const { deployer } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["access"] });
    expect(store.calls.filter((call) => call.name.includes("/signin") || call.name.includes("/slack/teamId"))).toEqual([]);
  });

  it("never writes the callback signing key into settings", async () => {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const { deployer } = fakeDeployer(scriptedOutputs());

    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets, holder: HOLDER });

    const signingKey = secrets.creates[0]!.value;
    expect(signingKey.length).toBeGreaterThanOrEqual(32);
    const stored = store.values.get(settingsParameterName(ENV));
    expect(stored).toBeDefined();
    for (const value of store.values.values()) expect(value).not.toContain(signingKey);
  });
});

/** Sets up `store`'s lock parameter as already held by `holder`, the way agentx init's step runner
 * leaves it while it calls deployEnvironment repeatedly with lockHeld. */
function seedOwnLock(store: MemoryParameterStore, holder: string): void {
  store.values.set(lockParameterName(ENV), JSON.stringify({ holder, command: "init", acquiredAt: "2026-09-27T00:00:00.000Z" }));
}

describe("deployEnvironment with lockHeld", () => {
  it("never puts or deletes the lock parameter when the caller already holds the lock (only reads it, to confirm it is theirs)", async () => {
    const store = new MemoryParameterStore();
    seedOwnLock(store, HOLDER);
    const { deployer } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["access"], lockHeld: true });
    expect(store.calls.filter((call) => call.name === lockParameterName(ENV) && call.op !== "get")).toEqual([]);
  });

  // F16: a naive version of this test (writing settings, then calling deployEnvironment with a
  // conflicting engine) would pass even if `work` never re-checked anything, because
  // `assertDeployAllowed`'s call before the lock/lockHeld branch already catches it. This version
  // makes the settings parameter read as "not installed yet" the first time (what the pre-lockHeld
  // check sees) and only reveal the real, conflicting settings on the second read (what `work`'s own
  // re-check sees), so the test can only pass if that re-check genuinely runs under `lockHeld`.
  it("still refuses a different engine with lockHeld, via the re-check inside work (not just the check before it)", async () => {
    const store = new MemoryParameterStore();
    seedOwnLock(store, HOLDER);
    await writeEnvironmentSettings(store, stagingSettings);
    const flippingStore = flipOnceThenReveal(store, settingsParameterName(ENV));
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await expect(deployEnvironment({ mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer, store: flippingStore, secrets: memorySecrets(), holder: HOLDER, parts: ["slack"], lockHeld: true }))
      .rejects.toThrow("was installed with the templates engine");
    expect(requests).toEqual([]);
  });

  // Fix round 1, item 5: lockHeld must not be a way to skip locking altogether. It only skips
  // *taking* the lock for a caller who genuinely already holds it.
  it("refuses lockHeld when the lock is held by someone else", async () => {
    const store = new MemoryParameterStore();
    seedOwnLock(store, "arn:aws:iam::123456789012:user/bob");
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["access"], lockHeld: true }),
    ).rejects.toThrow("is not held by");
    expect(requests).toEqual([]);
  });

  it("refuses lockHeld when there is no lock at all", async () => {
    const store = new MemoryParameterStore();
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await expect(
      deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, parts: ["access"], lockHeld: true }),
    ).rejects.toThrow("is not held by");
    expect(requests).toEqual([]);
  });
});

describe("an upgrade keeps what the operator set (OPERATOR_PARAMETERS)", () => {
  const declared = ["BudgetMonthlyUsd", "BudgetScope", "SlackAppPostedMessages", "SlackThreadTurnsPerMinute", "SlackMemberWorkspaceLimit", "SlackOrganizationWorkspaceLimit", "TaskPeopleChangesEnabled", "TaskPeoplePublicInvitationsEnabled", "TaskPeoplePrivateInvitationsEnabled", "TaskPersonProofEnabled"];

  async function installed(): Promise<{ store: MemoryParameterStore; secrets: ReturnType<typeof memorySecrets> }> {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });
    return { store, secrets };
  }

  it("sends the deployed budget and thread limit when the answers set none", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    const events: unknown[] = [];
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(declared), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => (name === stackName("control-plane") ? { BudgetMonthlyUsd: "250", BudgetScope: "account", SlackThreadTurnsPerMinute: "12", GitHubAppId: "999" } : undefined),
      onEvent: (event) => events.push(event),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("250");
    expect(controlPlane.parameters.BudgetScope).toBe("account");
    expect(controlPlane.parameters.SlackThreadTurnsPerMinute).toBe("12");
    // Only OPERATOR_PARAMETERS are carried: every other parameter still comes from the answers.
    expect(controlPlane.parameters.GitHubAppId).toBe("123");
    expect(events).toContainEqual({ kind: "kept", stackName: stackName("control-plane"), kept: ["BudgetMonthlyUsd", "BudgetScope", "SlackThreadTurnsPerMinute"], dropped: [] });
  });

  it("preserves an explicitly enabled workflow-dependencies parameter across an upgrade", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(),
      release: fakeReleaseWithControlPlaneParameters([...declared, "WorkflowDependenciesEnabled"]),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => name === stackName("control-plane") ? { WorkflowDependenciesEnabled: "true" } : undefined,
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.WorkflowDependenciesEnabled).toBe("true");
  });

  it("lets the answers' own budget win over the deployed one", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: { ...baseAnswers(), budget: { monthlyUsd: 40, scope: "tag" } }, release: fakeReleaseWithControlPlaneParameters(declared),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async () => ({ BudgetMonthlyUsd: "250", BudgetScope: "account" }),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("40");
    expect(controlPlane.parameters.BudgetScope).toBe("tag");
  });

  it("preserves independent People switches when upgrading and keeps absent invitation switches at template defaults", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(declared),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => name === stackName("control-plane")
        ? { TaskPeopleChangesEnabled: "true", TaskPeoplePublicInvitationsEnabled: "true", TaskPeoplePrivateInvitationsEnabled: "false" }
        : undefined,
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters).toMatchObject({
      TaskPeopleChangesEnabled: "true",
      TaskPeoplePublicInvitationsEnabled: "true",
      TaskPeoplePrivateInvitationsEnabled: "false",
    });
  });

  it("does not turn on invitations when an older install has role edits enabled but no invitation parameters", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(declared),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => name === stackName("control-plane") ? { TaskPeopleChangesEnabled: "true" } : undefined,
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters.TaskPeopleChangesEnabled).toBe("true");
    expect(controlPlane.parameters).not.toHaveProperty("TaskPeoplePublicInvitationsEnabled");
    expect(controlPlane.parameters).not.toHaveProperty("TaskPeoplePrivateInvitationsEnabled");
  });

  it("preserves an explicitly installed proof endpoint without changing People mutation switches", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(declared),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => name === stackName("control-plane")
        ? { TaskPersonProofEnabled: "true", TaskPeopleChangesEnabled: "false", TaskPeoplePublicInvitationsEnabled: "false", TaskPeoplePrivateInvitationsEnabled: "false" }
        : undefined,
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters).toMatchObject({
      TaskPersonProofEnabled: "true",
      TaskPeopleChangesEnabled: "false",
      TaskPeoplePublicInvitationsEnabled: "false",
      TaskPeoplePrivateInvitationsEnabled: "false",
    });
  });

  it("leaves a missing legacy proof parameter to the template's OFF default", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(declared),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => name === stackName("control-plane") ? { TaskPeopleChangesEnabled: "false" } : undefined,
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters).not.toHaveProperty("TaskPersonProofEnabled");
  });

  it("does not send a parameter the new template no longer declares, and reports it as dropped", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    const events: unknown[] = [];
    const result = await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(["BudgetMonthlyUsd"]),
      deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      deployedParameters: async (name) => (name === stackName("control-plane") ? { BudgetMonthlyUsd: "250", SlackThreadTurnsPerMinute: "12" } : undefined),
      onEvent: (event) => events.push(event),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters).not.toHaveProperty("SlackThreadTurnsPerMinute");
    // Dropping one parameter does not drop the others: the budget is still kept in the same request.
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("250");
    expect(events).toContainEqual({ kind: "kept", stackName: stackName("control-plane"), kept: ["BudgetMonthlyUsd"], dropped: ["SlackThreadTurnsPerMinute"] });
    expect(result.droppedParameters).toEqual([{ stackName: stackName("control-plane"), parameter: "SlackThreadTurnsPerMinute", value: "12" }]);
  });

  it("refuses an upgrade that cannot read the deployed parameters, before deploying anything", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await expect(deployEnvironment({ mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER }))
      .rejects.toThrow("an upgrade must read the deployed stacks' parameters");
    // F6: the refusal comes before the deploy loop, so no part deploys at all.
    expect(upgrade.requests).toEqual([]);
  });

  it("refuses, never skips, when the reader is missing at the part that needs it (the loop's own check)", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    // Forces the guard before the loop and the loop to disagree: the reader is there when the guard
    // looks, and gone when the control plane deploys. Skipping would reset the budget silently.
    let reads = 0;
    type GetterBoundaryInput = Omit<DeployEnvironmentInput, "deployedParameters"> & { deployedParameters: DeployEnvironmentInput["deployedParameters"] | undefined };
    const input: GetterBoundaryInput = {
      mode: "upgrade" as const, engine: "templates" as const, answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      get deployedParameters() { reads += 1; return reads === 1 ? nothingDeployed : undefined; },
    };
    await expect(deployEnvironment(input as DeployEnvironmentInput)).rejects.toThrow("an upgrade must read the deployed stacks' parameters");
    expect(upgrade.requests.filter((request) => request.part === "control-plane")).toEqual([]);
  });

  it("never reads deployed parameters on an install", async () => {
    const store = new MemoryParameterStore();
    const reads: string[] = [];
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "install", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets: memorySecrets(), holder: HOLDER,
      deployedParameters: async (name) => { reads.push(name); return { BudgetMonthlyUsd: "250" }; },
    });
    // Only the control plane's audit lock profile is looked up (so an install never changes it unasked); no other operator parameter is kept.
    expect(reads).toEqual([stackName("control-plane")]);
    expect(install.requests.find((request) => request.part === "control-plane")!.parameters).not.toHaveProperty("BudgetMonthlyUsd");
    expect(install.requests.find((request) => request.part === "control-plane")!.parameters).not.toHaveProperty("AuditLockProfile");
  });

  it("keeps the settings' alert address when it rewrites the settings (F16)", async () => {
    const { store, secrets } = await installed();
    const before = (await readEnvironmentSettings(store, ENV))!;
    await writeEnvironmentSettings(store, { ...before, alertAddress: "ops@example.com" });
    const upgrade = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed,
    });
    expect(result.settingsWritten).toBe(true);
    expect((await readEnvironmentSettings(store, ENV))!.alertAddress).toBe("ops@example.com");
  });

  it("writes no alert address when the settings had none", async () => {
    const { store, secrets } = await installed();
    const upgrade = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "upgrade", engine: "templates", answers: baseAnswers(), release: fakeRelease(), deployer: upgrade.deployer, store, secrets, holder: HOLDER, deployedParameters: nothingDeployed,
    });
    expect(await readEnvironmentSettings(store, ENV)).not.toHaveProperty("alertAddress");
  });
});

// Issue 152: the cdk engine reads which parameters each stack declares from its own synth of the
// source, not from the release's published templates (which a source-built release does not have).
describe("the cdk engine's declared parameters come from its synth (issue 152)", () => {
  async function installedWithCdk(): Promise<{ store: MemoryParameterStore; secrets: ReturnType<typeof memorySecrets> }> {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const install = fakeDeployer(scriptedOutputs());
    await deployEnvironment({ mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: install.deployer, store, secrets, holder: HOLDER });
    return { store, secrets };
  }
  const synthDeclares = (names: Partial<Record<DeployPart, string[]>>) => (part: DeployPart): ReadonlySet<string> => new Set(names[part] ?? []);

  it("keeps a parameter the synth declares although the release's template does not", async () => {
    const { store, secrets } = await installedWithCdk();
    const upgrade = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters([]), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      declaredParameters: synthDeclares({ "control-plane": ["BudgetMonthlyUsd"] }),
      deployedParameters: async (name) => (name === stackName("control-plane") ? { BudgetMonthlyUsd: "250" } : undefined),
    });
    expect(upgrade.requests.find((request) => request.part === "control-plane")!.parameters.BudgetMonthlyUsd).toBe("250");
    expect(result.droppedParameters).toEqual([]);
  });

  it("reports as dropped a parameter the synth no longer declares, although the release's template still does", async () => {
    const { store, secrets } = await installedWithCdk();
    const upgrade = fakeDeployer(scriptedOutputs());
    const result = await deployEnvironment({
      mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters(["BudgetMonthlyUsd", "SlackThreadTurnsPerMinute"]), deployer: upgrade.deployer, store, secrets, holder: HOLDER,
      declaredParameters: synthDeclares({ "control-plane": ["BudgetMonthlyUsd"] }),
      deployedParameters: async (name) => (name === stackName("control-plane") ? { BudgetMonthlyUsd: "250", SlackThreadTurnsPerMinute: "12" } : undefined),
    });
    const controlPlane = upgrade.requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters).not.toHaveProperty("SlackThreadTurnsPerMinute");
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("250");
    expect(result.droppedParameters).toEqual([{ stackName: stackName("control-plane"), parameter: "SlackThreadTurnsPerMinute", value: "12" }]);
  });

  it("filters the stored sign-in keys by the synth's set, not the release's template", async () => {
    const store = new MemoryParameterStore();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    await deployEnvironment({
      mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeReleaseWithControlPlaneParameters([]), deployer, store, secrets: memorySecrets(), holder: HOLDER,
      declaredParameters: synthDeclares({ "control-plane": ["SlackTeamId", "DeveloperSignInSlack"] }),
    });
    const controlPlane = requests.find((request) => request.part === "control-plane")!;
    expect(controlPlane.parameters).toMatchObject({ SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled" });
    for (const name of SIGN_IN_PARAMETER_NAMES.filter((key) => key !== "SlackTeamId" && key !== "DeveloperSignInSlack")) expect(controlPlane.parameters).not.toHaveProperty(name);
  });

  it("never reads the release's templates when the synth's set is given", async () => {
    const store = new MemoryParameterStore();
    await store.put("/agentx/staging/slack/teamId", "T0TEAM1");
    await store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER }));
    const release = { ...fakeRelease(), template: () => { throw new Error("the release's template must not be read"); } };
    const { deployer } = fakeDeployer(scriptedOutputs());
    await expect(deployEnvironment({
      mode: "install", engine: "cdk", answers: baseAnswers(), release, deployer, store, secrets: memorySecrets(), holder: HOLDER,
      declaredParameters: synthDeclares({ "control-plane": [...SIGN_IN_PARAMETER_NAMES] }),
    })).resolves.toMatchObject({ settingsWritten: true });
  });
});

describe("models the environment's model proxy cannot serve (R52)", () => {
  it("refuses an install or an upgrade before anything deploys or locks, naming the role", async () => {
    for (const mode of ["install", "upgrade"] as const) {
      const store = new MemoryParameterStore();
      if (mode === "upgrade") await writeEnvironmentSettings(store, { ...stagingSettings, engine: "cdk" });
      const { deployer, requests } = fakeDeployer(scriptedOutputs());
      const answers: DeployAnswers = { ...baseAnswers(), models: { ...baseAnswers().models, providers: { orchestrator: "openrouter" } } };
      await expect(deployEnvironment({
        mode, engine: "cdk", answers, release: fakeRelease(), deployer, store, secrets: memorySecrets(), holder: HOLDER, deployedParameters: nothingDeployed,
      })).rejects.toThrow(/the orchestrator model provider is openrouter, but this install calls every model through its model proxy/);
      expect(requests).toEqual([]);
      expect(await store.get(lockParameterName(ENV))).toBeUndefined();
    }
  });

  it("refuses a model of another geography than the region's", async () => {
    const answers: DeployAnswers = { ...baseAnswers(), region: "eu-west-1" };
    await expect(deployEnvironment({
      mode: "install", engine: "cdk", answers, release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER,
    })).rejects.toThrow(/not one the model proxy serves in eu-west-1/);
  });
});

describe("keptOperatorParameters", () => {
  it("keeps the Team record's pause only where the deployed stack and the new template both have it, and never sends it to a template without the record", () => {
    const declaredWith = new Set(["TeamRecordEnabled", "BudgetMonthlyUsd"]), declaredWithout = new Set(["BudgetMonthlyUsd"]);
    // Built and kept on (the upgrade synthesizes with the recorded record): the deployed value is kept.
    expect(keptOperatorParameters({ part: "control-plane", computed: {}, deployed: { TeamRecordEnabled: "0" }, declared: declaredWith }).kept).toEqual({ TeamRecordEnabled: "0" });
    // Not built: nothing is deployed and nothing is sent.
    expect(keptOperatorParameters({ part: "control-plane", computed: {}, deployed: {}, declared: declaredWithout }).kept).toEqual({});
    // Built by hand but not recorded (the new template has no record): reported dropped, never sent (CloudFormation would refuse it); the upgrade's data guard names the fix.
    expect(keptOperatorParameters({ part: "control-plane", computed: {}, deployed: { TeamRecordEnabled: "1" }, declared: declaredWithout })).toEqual({ kept: {}, dropped: [{ parameter: "TeamRecordEnabled", value: "1" }] });
  });

  it("keeps only listed parameters the answers did not set and the template declares", () => {
    expect(keptOperatorParameters({
      part: "slack", computed: { ModelId: "m" }, deployed: { SlowTurnMinutes: "9", ModelId: "old" }, declared: new Set(["SlowTurnMinutes", "ModelId"]),
    })).toEqual({ kept: { SlowTurnMinutes: "9" }, dropped: [] });
    expect(keptOperatorParameters({ part: "runtime", computed: {}, deployed: { ModelId: "old" }, declared: undefined })).toEqual({ kept: {}, dropped: [] });
  });

  it("never carries a secret parameter, even one listed by mistake: DescribeStacks reads it back as \"****\"", () => {
    // Simulates a later edit that lists a secret in OPERATOR_PARAMETERS; restored afterwards.
    const controlPlane = OPERATOR_PARAMETERS["control-plane"] as string[];
    controlPlane.push("CallbackSigningKey");
    try {
      expect(keptOperatorParameters({
        part: "control-plane", computed: {}, deployed: { CallbackSigningKey: "****", BudgetMonthlyUsd: "250" }, declared: new Set(["CallbackSigningKey", "BudgetMonthlyUsd"]),
      })).toEqual({ kept: { BudgetMonthlyUsd: "250" }, dropped: [] });
    } finally {
      controlPlane.pop();
    }
    expect(OPERATOR_PARAMETERS["control-plane"]).not.toContain("CallbackSigningKey");
  });
});

describe("the hosted Rovara cloud switch is stored and survives every deploy (R45)", () => {
  const SIGN_IN = { googleClientId: "google-id.apps.example", googleClientSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/google-AbCdEf", domainPrefix: "rovara-acme", githubClientId: "Iv1.githubapp", githubClientSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-AbCdEf" };

  /** A cdk runner that records every command and writes the scripted outputs of the stack it was asked to deploy. */
  function cdkRunner(): CommandRunner & { calls: string[][] } {
    const scripted = scriptedOutputs();
    const byConstruct = new Map(Object.entries(CDK_CONSTRUCT_IDS).map(([part, id]) => [id, environmentStackName(ENV, part as DeployPart)]));
    const calls: string[][] = [];
    return {
      calls,
      async run(_command, args) {
        calls.push(args);
        const file = args[args.indexOf("--outputs-file") + 1];
        const stack = byConstruct.get(args[3] ?? "");
        if (file !== undefined && stack !== undefined) await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ [stack]: scripted[stack] ?? {} }));
        return { stdout: "" };
      },
    };
  }
  const cdk = (runner: CommandRunner, cloud: boolean): StackDeployer => cdkDeployer({
    runner, source: "/src", env: ENV, region: "us-east-1", identityMode: "cognito", ...(cloud ? { cloud: true } : {}), outputsDir: process.env.TMPDIR ?? "/tmp", outputs: async (name) => scriptedOutputs()[name],
  });
  const cloudAnswers = (): DeployAnswers => ({ ...baseAnswers(), cloud: true, cloudSignIn: SIGN_IN });
  const deployedControlPlane = (settings: NonNullable<Awaited<ReturnType<typeof readEnvironmentSettings>>>) => ({
    async describe(name: string): Promise<StackDescription | undefined> {
      const parameters = name === settings.stacks["control-plane"]
        ? { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: baseAnswers().github.privateKeySecretArn, AdminClaim: "cognito:groups", AdminValues: "[\"agentx-admin\"]" }
        : { OperatorPrincipalArn: "" };
      return { status: "UPDATE_COMPLETE", outputs: {}, parameters };
    },
  });

  it("passes -c agentxCloud=true only for a cloud environment", () => {
    expect(cdkAppArguments({ env: ENV, region: "us-east-1", identityMode: "cognito", cloud: true })).toEqual(expect.arrayContaining(["-c", "agentxCloud=true"]));
    expect(cdkAppArguments({ env: ENV, region: "us-east-1", identityMode: "cognito" }).join(" ")).not.toContain("agentxCloud");
  });

  it("stores cloud: true and the sign-in settings on install, and passes the sign-in parameters to the control plane", async () => {
    const store = new MemoryParameterStore();
    const runner = cdkRunner();
    await deployEnvironment({ mode: "install", engine: "cdk", answers: cloudAnswers(), release: fakeRelease(), deployer: cdk(runner, true), store, secrets: memorySecrets(), holder: HOLDER, declaredParameters: () => new Set() });
    const settings = await readEnvironmentSettings(store, ENV);
    expect(settings).toMatchObject({ cloud: true, cloudSignIn: SIGN_IN });
    const controlPlane = runner.calls.find((args) => args[3] === "AgentXControlPlane")!;
    expect(controlPlane).toContain(`${stackName("control-plane")}:GoogleClientId=google-id.apps.example`);
    expect(controlPlane).toContain(`${stackName("control-plane")}:GoogleClientSecretArn=${SIGN_IN.googleClientSecretArn}`);
    expect(controlPlane).toContain(`${stackName("control-plane")}:CloudIdentityDomainPrefix=rovara-acme`);
    // Plan 2, Task 19: the foundation's DNS firewall project list reaches the control plane's broker.
    expect(controlPlane).toContain(`${stackName("control-plane")}:ProjectAllowListId=rslvr-fdl-0123456789abcdef`);
    expect(controlPlane).toContain(`${stackName("control-plane")}:GitHubClientId=Iv1.githubapp`);
    expect(controlPlane).toContain(`${stackName("control-plane")}:GitHubClientSecretArn=${SIGN_IN.githubClientSecretArn}`);
    expect(runner.calls.every((args) => args.includes("agentxCloud=true"))).toBe(true);
  });

  it("passes no Google parameters when no client id is set, and a non-cloud install stores no cloud setting", async () => {
    const store = new MemoryParameterStore();
    const runner = cdkRunner();
    await deployEnvironment({ mode: "install", engine: "cdk", answers: { ...baseAnswers(), cloud: true }, release: fakeRelease(), deployer: cdk(runner, true), store, secrets: memorySecrets(), holder: HOLDER, declaredParameters: () => new Set() });
    expect(runner.calls.find((args) => args[3] === "AgentXControlPlane")!.join(" ")).not.toMatch(/Google|GitHubClient|CloudIdentityDomainPrefix/);
    const plain = new MemoryParameterStore();
    const plainRunner = cdkRunner();
    await deployEnvironment({ mode: "install", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: cdk(plainRunner, false), store: plain, secrets: memorySecrets(), holder: HOLDER, declaredParameters: () => new Set() });
    expect(await readEnvironmentSettings(plain, ENV)).not.toHaveProperty("cloud");
    // A plain install's control plane declares no such parameter, so none is passed.
    expect(plainRunner.calls.find((args) => args[3] === "AgentXControlPlane")!.join(" ")).not.toContain("ProjectAllowListId");
  });

  it("an upgrade built from the stored settings keeps agentxCloud=true and the sign-in parameters", async () => {
    const store = new MemoryParameterStore();
    await deployEnvironment({ mode: "install", engine: "cdk", answers: cloudAnswers(), release: fakeRelease(), deployer: cdk(cdkRunner(), true), store, secrets: memorySecrets(), holder: HOLDER, declaredParameters: () => new Set() });
    const settings = (await readEnvironmentSettings(store, ENV))!;

    const answers = await upgradeAnswers({ settings, stacks: deployedControlPlane(settings) });
    expect(answers).toMatchObject({ cloud: true, cloudSignIn: SIGN_IN });
    const runner = cdkRunner();
    await deployEnvironment({
      mode: "upgrade", engine: settings.engine, answers, release: fakeRelease(), deployer: cdk(runner, settings.cloud === true), store, secrets: memorySecrets({ [`agentx/${ENV}/callback-signing-key`]: "k".repeat(40) }), holder: HOLDER,
      deployedParameters: nothingDeployed, declaredParameters: () => new Set(),
    });
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls.every((args) => args.includes("agentxCloud=true"))).toBe(true);
    expect((await readEnvironmentSettings(store, ENV))).toMatchObject({ cloud: true, cloudSignIn: SIGN_IN });
  });

  describe("the custom domain (0.5.7)", () => {
    const DOMAIN = { domainName: "staging.rovara.dev", hostedZoneId: "Z08286002FKUL2VBSO3MO" };
    const installed = async () => {
      const store = new MemoryParameterStore();
      await deployEnvironment({ mode: "install", engine: "cdk", answers: cloudAnswers(), release: fakeRelease(), deployer: cdk(cdkRunner(), true), store, secrets: memorySecrets(), holder: HOLDER, declaredParameters: () => new Set() });
      return { store, settings: (await readEnvironmentSettings(store, ENV))! };
    };
    const upgrade = async (store: MemoryParameterStore, settings: Awaited<ReturnType<typeof installed>>["settings"], deployedDomain: string | undefined, release = fakeRelease()) => {
      const runner = cdkRunner();
      const answers = await upgradeAnswers({ settings, stacks: deployedControlPlane(settings) });
      await deployEnvironment({
        mode: "upgrade", engine: settings.engine, answers, release, deployer: cdk(runner, true), store, secrets: memorySecrets({ [`agentx/${ENV}/callback-signing-key`]: "k".repeat(40) }), holder: HOLDER,
        deployedParameters: async (stack) => (stack === stackName("control-plane") && deployedDomain !== undefined ? { CustomDomainName: deployedDomain } : undefined), declaredParameters: () => new Set(),
      });
      return runner.calls;
    };
    const order = (calls: string[][]) => calls.map((args) => args[3]);

    it("adds it with the access stack first, sending the recorded name and zone to both stacks; the recorded domain is used though the answers name none", async () => {
      const { store, settings } = await installed();
      await writeCustomDomain(store, ENV, DOMAIN);
      const calls = await upgrade(store, settings, undefined);
      expect(order(calls).indexOf("AgentXAccess")).toBeLessThan(order(calls).indexOf("AgentXControlPlane"));
      for (const construct of ["AgentXAccess", "AgentXControlPlane"]) {
        const args = calls.find((call) => call[3] === construct)!;
        expect(args, construct).toContain(`${stackName(construct === "AgentXAccess" ? "access" : "control-plane")}:CustomDomainName=staging.rovara.dev`);
        expect(args, construct).toContain(`${stackName(construct === "AgentXAccess" ? "access" : "control-plane")}:CustomDomainHostedZoneId=Z08286002FKUL2VBSO3MO`);
      }
    });

    it("removes it with the control plane first and the access stack last, sending empty values so the removal reaches both stacks", async () => {
      const { store, settings } = await installed();
      const calls = await upgrade(store, settings, DOMAIN.domainName);
      expect(order(calls).indexOf("AgentXControlPlane")).toBeLessThan(order(calls).indexOf("AgentXAccess"));
      expect(order(calls).at(-1)).toBe("AgentXAccess");
      expect(calls.find((call) => call[3] === "AgentXAccess")!).toContain(`${stackName("access")}:CustomDomainName=`);
      expect(calls.find((call) => call[3] === "AgentXControlPlane")!).toContain(`${stackName("control-plane")}:CustomDomainHostedZoneId=`);
    });

    it("refuses to remove it in the same run as a release change, before anything deploys, and removes it at the same version", async () => {
      const { store, settings } = await installed();
      const newer = { ...fakeRelease(), manifest: { ...fakeRelease().manifest, version: "9.9.9" } };
      await expect(upgrade(store, settings, DOMAIN.domainName, newer)).rejects.toThrow(/remove it at the version the environment runs now/);
      await expect(upgrade(store, settings, DOMAIN.domainName)).resolves.toBeDefined();
    });

    it("refuses to change it to another name in one run", async () => {
      const { store, settings } = await installed();
      await writeCustomDomain(store, ENV, { ...DOMAIN, domainName: "other.rovara.dev" });
      await expect(upgrade(store, settings, DOMAIN.domainName)).rejects.toThrow(/two steps/);
    });
  });

  it("refuses a deploy whose cloud flag differs from the stored one, in both directions", async () => {
    const cloudStore = new MemoryParameterStore();
    await writeEnvironmentSettings(cloudStore, { ...stagingSettings, engine: "cdk", cloud: true });
    await expect(deployEnvironment({ mode: "upgrade", engine: "cdk", answers: baseAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store: cloudStore, secrets: memorySecrets(), holder: HOLDER, deployedParameters: nothingDeployed }))
      .rejects.toThrow(/installed as the hosted Rovara cloud/);
    const plainStore = new MemoryParameterStore();
    await writeEnvironmentSettings(plainStore, { ...stagingSettings, engine: "cdk" });
    await expect(deployEnvironment({ mode: "upgrade", engine: "cdk", answers: cloudAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store: plainStore, secrets: memorySecrets(), holder: HOLDER, deployedParameters: nothingDeployed }))
      .rejects.toThrow(/installed without the hosted Rovara cloud/);
  });

  it("refuses the prebuilt-templates engine for a cloud environment, on install and on upgrade", async () => {
    await expect(deployEnvironment({ mode: "install", engine: "templates", answers: cloudAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store: new MemoryParameterStore(), secrets: memorySecrets(), holder: HOLDER }))
      .rejects.toThrow(/must be synthesized from source/);
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, { ...stagingSettings, engine: "templates", cloud: true });
    await expect(deployEnvironment({ mode: "upgrade", engine: "templates", answers: cloudAnswers(), release: fakeRelease(), deployer: fakeDeployer(scriptedOutputs()).deployer, store, secrets: memorySecrets(), holder: HOLDER, deployedParameters: nothingDeployed }))
      .rejects.toThrow(/must be synthesized from source/);
  });
});

describe("the audit ledger's lock profile (Task 5b)", () => {
  const REFUSAL = "audit ledger: an install in production mode can't go back to trial; its records are locked for 3 years";
  const deployed = (profile: string | undefined) => async (stack: string): Promise<Record<string, string> | undefined> => (profile !== undefined && stack === stackName("control-plane") ? { AuditLockProfile: profile } : undefined);
  const withProfile = (auditLock?: "production" | "trial"): DeployAnswers => ({ ...baseAnswers(), ...(auditLock === undefined ? {} : { auditLock }) });
  const controlPlane = (requests: DeployRequest[]) => requests.find((request) => request.part === "control-plane")!.parameters;

  async function upgrade(input: { answers: DeployAnswers; deployedProfile: string | undefined; release?: LoadedRelease; mode?: "install" | "upgrade"; parts?: DeployPart[] }) {
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    // Every part has a stack, so a subset of the parts still reads the others' outputs.
    await writeEnvironmentSettings(store, { ...stagingSettings, stacks: { ...stagingSettings.stacks, access: stackName("access"), identity: stackName("identity") } });
    const { deployer, requests } = fakeDeployer(scriptedOutputs());
    const run = deployEnvironment({
      mode: input.mode ?? "upgrade", engine: "templates", answers: input.answers, release: input.release ?? fakeReleaseWithControlPlaneParameters(["AuditLockProfile", "BudgetMonthlyUsd"]),
      deployer, store, secrets, holder: HOLDER, deployedParameters: deployed(input.deployedProfile), ...(input.parts === undefined ? {} : { parts: input.parts }),
    });
    return { run, requests, secrets };
  }

  it("refuses production to trial with the exact text before anything deploys", async () => {
    const { run, requests, secrets } = await upgrade({ answers: withProfile("trial"), deployedProfile: "production" });
    await expect(run).rejects.toThrow(REFUSAL);
    await expect(run).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(requests).toEqual([]);
    expect(secrets.creates).toEqual([]);
  });

  it("refuses it on an install over an existing production stack too", async () => {
    const { run, requests } = await upgrade({ answers: withProfile("trial"), deployedProfile: "production", mode: "install", parts: ["control-plane"] });
    await expect(run).rejects.toThrow(REFUSAL);
    expect(requests).toEqual([]);
  });

  it("allows trial to production", async () => {
    const { run, requests } = await upgrade({ answers: withProfile("production"), deployedProfile: "trial" });
    await run;
    expect(controlPlane(requests).AuditLockProfile).toBe("production");
  });

  it("allows production to production and trial to trial", async () => {
    for (const profile of ["production", "trial"] as const) {
      const { run, requests } = await upgrade({ answers: withProfile(profile), deployedProfile: profile });
      await run;
      expect(controlPlane(requests).AuditLockProfile).toBe(profile);
    }
  });

  it("allows a first deploy of trial, when the stack has no profile yet", async () => {
    const { run, requests } = await upgrade({ answers: withProfile("trial"), deployedProfile: undefined });
    await run;
    expect(controlPlane(requests).AuditLockProfile).toBe("trial");
  });

  it("keeps the deployed profile on an upgrade whose answers do not set one", async () => {
    for (const profile of ["production", "trial"]) {
      const { run, requests } = await upgrade({ answers: withProfile(), deployedProfile: profile });
      await run;
      expect(controlPlane(requests).AuditLockProfile).toBe(profile);
    }
  });

  it("keeps the deployed profile on an install of the control plane whose answers do not set one (the template default would be production)", async () => {
    for (const profile of ["production", "trial"]) {
      const { run, requests } = await upgrade({ answers: withProfile(), deployedProfile: profile, mode: "install", parts: ["control-plane"] });
      await run;
      expect(controlPlane(requests).AuditLockProfile).toBe(profile);
    }
  });

  it("keeps it on an upgrade of the control plane alone, and sends nothing when the stack has no profile", async () => {
    for (const profile of ["production", "trial"]) {
      const { run, requests } = await upgrade({ answers: withProfile(), deployedProfile: profile, parts: ["control-plane"] });
      await run;
      expect(controlPlane(requests).AuditLockProfile).toBe(profile);
    }
    const fresh = await upgrade({ answers: withProfile(), deployedProfile: undefined, mode: "install", parts: ["control-plane"] });
    await fresh.run;
    expect(controlPlane(fresh.requests)).not.toHaveProperty("AuditLockProfile");
  });

  it("changes the profile on an install only when the answers choose it: trial to production is allowed there too", async () => {
    const { run, requests } = await upgrade({ answers: withProfile("production"), deployedProfile: "trial", mode: "install", parts: ["control-plane"] });
    await run;
    expect(controlPlane(requests).AuditLockProfile).toBe("production");
  });

  it("does not send the kept profile to a release whose template lacks the parameter", async () => {
    const { run, requests } = await upgrade({ answers: withProfile(), deployedProfile: "trial", mode: "install", parts: ["control-plane"], release: fakeReleaseWithControlPlaneParameters(["BudgetMonthlyUsd"]) });
    await run;
    expect(controlPlane(requests)).not.toHaveProperty("AuditLockProfile");
  });

  it("sends nothing for a release whose template has no such parameter, and does not refuse", async () => {
    const { run, requests } = await upgrade({ answers: withProfile("production"), deployedProfile: undefined, release: fakeReleaseWithControlPlaneParameters(["BudgetMonthlyUsd"]) });
    await run;
    expect(controlPlane(requests)).not.toHaveProperty("AuditLockProfile");
  });

  it("is kept across upgrades like the other operator parameters", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("AuditLockProfile");
  });
});
