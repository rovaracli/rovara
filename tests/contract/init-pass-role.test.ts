import { readFileSync } from "node:fs";
import { DeleteRolePolicyCommand, GetRolePolicyCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { ListStacksCommand } from "@aws-sdk/client-cloudformation";
import { describe, expect, it } from "vitest";
import { environmentStackName } from "@rovara-code/contracts";
import { deployEnvironment } from "../../packages/cli/src/deploy/deploy-environment.js";
import {
  CDK_PASS_ROLE_POLICY_NAME, cdkDeployRoleName, ensureCdkPassRole, passRolePolicyDocument, removeCdkPassRole,
} from "../../packages/cli/src/init/pass-role.js";
import { awsPrerequisiteChecks, checkPrerequisites } from "../../packages/cli/src/init/prerequisites.js";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import { runDestroy } from "../../packages/cli/src/destroy/run.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { writeInstallAnswers, writeInstallProgress } from "../../packages/cli/src/init/install-state.js";
import { destroyProjectFiles } from "../../packages/cli/src/destroy/project-files.js";
import { fakeDestroyApi, installedAccount, PROGRESS, SETTINGS } from "../support/destroy-fakes.js";
import { fakeRelease, passingChecks, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { memoryTokenStore } from "../support/setup-fakes.js";
import type { DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { DeployAnswers } from "../../packages/cli/src/deploy/deploy-environment.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { ReleaseManifest } from "@rovara-code/contracts";

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const ROLE = `cdk-hnb659fds-deploy-role-${ACCOUNT}-${REGION}`;
const FIXTURE = readFileSync(new URL("../fixtures/pass-role-policy.json", import.meta.url), "utf8");
interface PolicyShape { Statement: Array<{ Resource: string[] }> }
const awsError = (name: string) => Object.assign(new Error(name), { name });

interface IamCall { kind: string; input: Record<string, unknown> }

/** An IAM client in memory: GetRolePolicy returns `existing` (URL-encoded, as IAM does) or NoSuchEntity. */
function fakeIam(options: { existing?: string; getError?: string; putError?: string; deleteError?: string; log?: string[] } = {}) {
  const calls: IamCall[] = [];
  const events: string[] = [];
  /** Every IAM call is also recorded, in order, in the shared log a test passes (the account's calls, for destroy). */
  const record = (command: { input: unknown }, kind: string) => { options.log?.push(`iam ${kind} ${JSON.stringify(command.input)}`); };
  return {
    calls, events,
    client: {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof GetRolePolicyCommand) {
          record(command, "get");
          calls.push({ kind: "get", input: command.input as never });
          events.push("get");
          if (options.getError !== undefined) throw awsError(options.getError);
          if (options.existing === undefined) throw awsError("NoSuchEntity");
          return { PolicyDocument: encodeURIComponent(options.existing), PolicyName: CDK_PASS_ROLE_POLICY_NAME, RoleName: ROLE };
        }
        if (command instanceof PutRolePolicyCommand) {
          record(command, "put");
          calls.push({ kind: "put", input: command.input as never });
          events.push("put");
          if (options.putError !== undefined) throw awsError(options.putError);
          return {};
        }
        if (command instanceof DeleteRolePolicyCommand) {
          record(command, "delete");
          calls.push({ kind: "delete", input: command.input as never });
          events.push("delete");
          if (options.deleteError !== undefined) throw awsError(options.deleteError);
          return {};
        }
        throw new Error(`unexpected IAM command ${(command as { constructor: { name: string } }).constructor.name}`);
      },
    },
  };
}

function fakeCloudFormation(names: Array<{ name: string; status?: string }>) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async send(command: unknown): Promise<unknown> {
        calls.push(command);
        if (command instanceof ListStacksCommand) {
          const filter = (command.input as { StackStatusFilter?: string[] }).StackStatusFilter;
          return { StackSummaries: names.filter((entry) => filter === undefined || filter.includes(entry.status ?? "CREATE_COMPLETE")).map((entry) => ({ StackName: entry.name, StackStatus: entry.status ?? "CREATE_COMPLETE" })) };
        }
        throw new Error("unexpected CloudFormation command");
      },
    },
  };
}

describe("the CDK deploy role's PassRole permission", () => {
  it("names the deploy role and the policy", () => {
    expect(CDK_PASS_ROLE_POLICY_NAME).toBe("AgentXPassCloudFormationRole");
    expect(cdkDeployRoleName({ account: ACCOUNT, region: REGION })).toBe(ROLE);
    expect(cdkDeployRoleName({ account: ACCOUNT, region: REGION, qualifier: "abc" })).toBe(`cdk-abc-deploy-role-${ACCOUNT}-${REGION}`);
  });

  it("builds exactly the fixture document, in any partition", () => {
    expect(JSON.stringify(passRolePolicyDocument({ partition: "aws", account: ACCOUNT }))).toBe(FIXTURE);
    expect(JSON.stringify(passRolePolicyDocument({ partition: "aws-cn", account: ACCOUNT }))).toBe(FIXTURE.replaceAll("arn:aws:", "arn:aws-cn:"));
  });

  it("prints the policy before PutRolePolicy, writes the fixture byte for byte, and never prompts", async () => {
    const iam = fakeIam();
    const lines: string[] = [];
    const result = await ensureCdkPassRole({
      iam: iam.client, account: ACCOUNT, region: REGION, partition: "aws",
      write: (line) => { lines.push(line); iam.events.push("write"); },
    });
    expect(result).toBe("added");
    expect(iam.events).toEqual(["get", "write", "write", "put"]);
    expect(lines[0]).toBe(`Rovara is letting the CDK deploy role ${ROLE} hand the AgentX CloudFormation role to CloudFormation. Adding this inline policy named AgentXPassCloudFormationRole:`);
    expect(lines[1]).toBe(JSON.stringify(JSON.parse(FIXTURE), null, 2));
    const put = iam.calls.find((call) => call.kind === "put")!;
    expect(put.input).toEqual({ RoleName: ROLE, PolicyName: "AgentXPassCloudFormationRole", PolicyDocument: FIXTURE });
    expect(put.input.PolicyDocument).toBe(FIXTURE);
  });

  it("overwrites a different policy with the same name", async () => {
    const iam = fakeIam({ existing: JSON.stringify({ Version: "2012-10-17", Statement: [] }) });
    expect(await ensureCdkPassRole({ iam: iam.client, account: ACCOUNT, region: REGION, partition: "aws", write: () => undefined })).toBe("added");
    expect(iam.calls.map((call) => call.kind)).toEqual(["get", "put"]);
  });

  it("does nothing and prints nothing when the same policy is present, however its keys are ordered or encoded", async () => {
    const reordered = JSON.stringify({ Statement: [{ Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } }, Resource: (JSON.parse(FIXTURE) as PolicyShape).Statement[0]!.Resource, Action: "iam:PassRole", Effect: "Allow", Sid: "PassAgentXCloudFormationRole" }], Version: "2012-10-17" }, null, 4);
    for (const existing of [FIXTURE, reordered]) {
      const iam = fakeIam({ existing });
      const lines: string[] = [];
      expect(await ensureCdkPassRole({ iam: iam.client, account: ACCOUNT, region: REGION, partition: "aws", write: (line) => lines.push(line) })).toBe("present");
      expect(iam.calls.map((call) => call.kind)).toEqual(["get"]);
      expect(lines).toEqual([]);
    }
  });

  it("stops with the document and the CLI command when the credentials cannot add it", async () => {
    for (const denied of [{ putError: "AccessDenied" }, { getError: "AccessDenied" }]) {
      const iam = fakeIam(denied);
      const error = await ensureCdkPassRole({ iam: iam.client, account: ACCOUNT, region: REGION, partition: "aws", write: () => undefined }).then(() => new Error("did not throw"), (caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error.message).toContain([
        `init cannot continue: the deploy role needs a permission your AWS credentials cannot add. Ask your cloud team to add this inline policy named AgentXPassCloudFormationRole to role ${ROLE}:`,
        JSON.stringify(JSON.parse(FIXTURE), null, 2),
        `or to run: aws iam put-role-policy --role-name ${ROLE} --policy-name AgentXPassCloudFormationRole --policy-document '${FIXTURE}'`,
      ].join("\n"));
    }
  });

  it("passes any other IAM failure through untouched", async () => {
    const iam = fakeIam({ putError: "ThrottlingException" });
    await expect(ensureCdkPassRole({ iam: iam.client, account: ACCOUNT, region: REGION, partition: "aws", write: () => undefined })).rejects.toThrow("ThrottlingException");
  });
});

describe("init: the cdk engine adds the permission, the templates engine never touches IAM", () => {
  const caller = { account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Admin/alice` };
  const prompter = () => scriptedPrompter([]);

  it("calls the check once the bootstrap check has passed, with the partition of the caller", async () => {
    const seen: Array<{ partition: string }> = [];
    const checks = passingChecks({ ensurePassRole: async (input) => { seen.push({ partition: input.partition }); } });
    await checkPrerequisites({ answers: sampleAnswers({ engine: "cdk" }), release: fakeRelease(), caller, checks, prompter: prompter(), write: () => undefined });
    expect(seen).toEqual([{ partition: "aws" }]);
  });

  it("calls it after a bootstrap that just ran", async () => {
    const order: string[] = [];
    const checks = passingChecks({
      cdkBootstrapped: async () => false,
      runCdkBootstrap: async () => { order.push("bootstrap"); },
      ensurePassRole: async () => { order.push("pass-role"); },
    });
    await checkPrerequisites({ answers: sampleAnswers({ engine: "cdk" }), release: fakeRelease(), caller, checks, prompter: scriptedPrompter([true]), write: () => undefined });
    expect(order).toEqual(["bootstrap", "pass-role"]);
  });

  it("is not called by the templates engine, nor when another prerequisite failed", async () => {
    let calls = 0;
    const ensurePassRole = async () => { calls += 1; };
    await checkPrerequisites({ answers: sampleAnswers({ engine: "templates" }), release: fakeRelease(), caller, checks: passingChecks({ ensurePassRole }), prompter: prompter(), write: () => undefined });
    await expect(checkPrerequisites({ answers: sampleAnswers({ engine: "cdk" }), release: fakeRelease(), caller, checks: passingChecks({ ensurePassRole, ec2Quota: async () => 0 }), prompter: prompter(), write: () => undefined })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("an AccessDenied from the permission stops init before any CloudFormation call", async () => {
    const iam = fakeIam({ putError: "AccessDenied" });
    const cloudFormation = fakeCloudFormation([]);
    const checks = passingChecks({
      ensurePassRole: (input) => ensureCdkPassRole({ iam: iam.client, account: ACCOUNT, region: REGION, partition: input.partition, write: input.write }),
    });
    // What init does next: the first CloudFormation call of the deploy. It is reached only when the checks pass.
    const initUpToTheFirstStack = async () => {
      await checkPrerequisites({ answers: sampleAnswers({ engine: "cdk" }), release: fakeRelease(), caller, checks, prompter: prompter(), write: () => undefined });
      await cloudFormation.client.send(new ListStacksCommand({}));
    };
    await expect(initUpToTheFirstStack()).rejects.toThrow(`--policy-document '${FIXTURE}'`);
    expect(iam.calls.map((call) => call.kind)).toEqual(["get", "put"]);
    expect(cloudFormation.calls).toEqual([]);

    // The recorder is wired in: when the permission is added, the very same path does reach CloudFormation.
    const added = fakeIam();
    const reaching = passingChecks({
      ensurePassRole: (input) => ensureCdkPassRole({ iam: added.client, account: ACCOUNT, region: REGION, partition: input.partition, write: input.write }),
    });
    await checkPrerequisites({ answers: sampleAnswers({ engine: "cdk" }), release: fakeRelease(), caller, checks: reaching, prompter: prompter(), write: () => undefined });
    await cloudFormation.client.send(new ListStacksCommand({}));
    expect(cloudFormation.calls).toHaveLength(1);
  });

  it("the real checks use the injected IAM client", async () => {
    const iam = fakeIam();
    const checks = awsPrerequisiteChecks({ region: REGION, account: ACCOUNT, store: new MemoryParameterStore(), runner: { run: async () => ({ stdout: "", stderr: "" }) }, fetch: (() => { throw new Error("no fetch"); }), iam: iam.client });
    await checks.ensurePassRole!({ write: () => undefined, partition: "aws" });
    expect(iam.calls.map((call) => call.kind)).toEqual(["get", "put"]);
  });
});

describe("deployEnvironment: the cdk engine checks the permission before the first non-access stack", () => {
  const manifest: ReleaseManifest = {
    schemaVersion: 1, version: "1.2.3", gitCommit: "a".repeat(40), environmentPlaceholder: "qqenv-placeholderqq", templates: [], packages: [],
    images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${"b".repeat(64)}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${"c".repeat(64)}` },
  };
  const release: LoadedRelease = { manifest, dir: "/nonexistent", regions: () => ["us-east-1"], template: () => { throw new Error("not expected"); }, packagePath: () => { throw new Error("not expected"); } };
  const answers: DeployAnswers = {
    env: "staging", region: REGION, account: ACCOUNT,
    models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
    identity: { mode: "cognito" },
    github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
  };
  const stack = (part: DeployPart) => environmentStackName("staging", part);

  function recorder(events: string[]): StackDeployer {
    return {
      async deploy(request: DeployRequest): Promise<StackOutputs> {
        events.push(`deploy ${request.part}`);
        if (request.part === "access") return { ArtifactBucketName: "b", CloudFormationRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx-staging-cloudformation`, OperatorRoleArn: "o", PullThroughPrefix: "p" };
        throw new Error("stop after the first non-access stack");
      },
      async outputs() { return undefined; },
    };
  }
  const secrets = { async get() { return undefined; }, async create() { return undefined; } };
  const run = (engine: "cdk" | "templates", events: string[], ensurePassRole?: () => Promise<"present" | "added">) => deployEnvironment({
    mode: "install", engine, answers, release, deployer: recorder(events), store: new MemoryParameterStore(), secrets, holder: "arn:aws:iam::123456789012:user/alice",
    parts: ["access", "foundation"], ...(ensurePassRole === undefined ? {} : { ensurePassRole }),
  });

  it("runs after access and before foundation, once", async () => {
    const events: string[] = [];
    await expect(run("cdk", events, async () => { events.push("pass-role"); return "added"; })).rejects.toThrow("stop after the first non-access stack");
    expect(events).toEqual(["deploy access", "pass-role", "deploy foundation"]);
    expect(stack("access")).toBe("agentx-staging-access");
  });

  it("stops before the stack when it fails", async () => {
    const events: string[] = [];
    await expect(run("cdk", events, async () => { throw new Error("denied"); })).rejects.toThrow("denied");
    expect(events).toEqual(["deploy access"]);
  });

  it("the templates engine never calls it", async () => {
    const events: string[] = [];
    await expect(run("templates", events, async () => { events.push("pass-role"); return "added"; })).rejects.toThrow("stop after");
    expect(events).toEqual(["deploy access", "deploy foundation"]);
  });
});

describe("destroy removes the permission last, and keeps it while another environment uses it", () => {
  async function harness(options: { others?: Array<{ name: string; status?: string }>; deleteError?: string; engine?: "cdk" | "templates" } = {}) {
    const env = "staging";
    const account = installedAccount(env);
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, { ...SETTINGS, env, engine: options.engine ?? "cdk", stacks: { access: `agentx-${env}-access`, foundation: `agentx-${env}-foundation`, identity: `agentx-${env}-identity`, runtime: `agentx-${env}-runtime`, "control-plane": `agentx-${env}-control-plane`, slack: `agentx-${env}-slack` } });
    await writeInstallAnswers(store, sampleAnswers({ env, engine: options.engine ?? "cdk" }));
    await writeInstallProgress(store, { ...PROGRESS, env });
    let time = 0;
    const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
    const lines: string[] = [];
    const iam = fakeIam({ log: account.calls, ...(options.deleteError === undefined ? {} : { deleteError: options.deleteError }) });
    const cloudFormation = fakeCloudFormation([{ name: `agentx-${env}-access` }, ...(options.others ?? [])]);
    const run = () => runDestroy({ env, keepData: false }, {
      store, api: fakeDestroyApi(account, clock), identity: { get: async () => ({ account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Admin/alice` }) },
      confirmLine: async () => env, write: (line) => lines.push(line), ...clock, home: "/nonexistent-home",
      projectFiles: (name) => destroyProjectFiles({ configDir: "/nonexistent-config", env: name, write: () => undefined }), tokenStore: memoryTokenStore(), region: REGION, isInteractive: () => true,
      passRole: { iam: iam.client, cloudformation: cloudFormation.client },
    });
    return { run, iam, cloudFormation, lines, account };
  }

  it("the last environment in the region deletes the policy, after the access stack", async () => {
    const h = await harness();
    await h.run();
    expect(h.iam.calls).toEqual([{ kind: "delete", input: { RoleName: ROLE, PolicyName: "AgentXPassCloudFormationRole" } }]);
    const deleteAt = h.account.calls.findIndex((call) => call.startsWith("iam delete "));
    expect(h.account.calls[deleteAt]).toBe(`iam delete ${JSON.stringify({ RoleName: ROLE, PolicyName: "AgentXPassCloudFormationRole" })}`);
    // Only after every stack is gone (in the recorded order), never before one.
    const stackDeletes = h.account.calls.flatMap((call, index) => (call.startsWith("delete stack ") ? [index] : []));
    expect(stackDeletes).toHaveLength(6);
    expect(Math.max(...stackDeletes)).toBeLessThan(deleteAt);
    expect(h.account.calls[stackDeletes.at(-1)!]).toBe("delete stack agentx-staging-access");
    expect(h.account.stacks.size).toBe(0);
  });

  it("names the role and policy in the manual step when destroy cannot remove it", async () => {
    const h = await harness({ deleteError: "AccessDenied" });
    const result = await h.run();
    expect(result.manualSteps).toContainEqual(expect.stringContaining(`from the role ${ROLE} by hand`));
    expect(result.manualSteps.join("\n")).toContain("inline policy named AgentXPassCloudFormationRole");
  });

  it("keeps it while agentx-other-access is still there, and says so", async () => {
    const h = await harness({ others: [{ name: "agentx-other-access" }, { name: "agentx-third-access" }, { name: "agentx-gone-access", status: "DELETE_COMPLETE" }, { name: "agentx-other-foundation" }] });
    await h.run();
    expect(h.iam.calls).toEqual([]);
    expect(h.lines).toContain(`Kept AgentXPassCloudFormationRole: environments other, third in ${REGION} still use it.`);
  });

  it("ignores NoSuchEntity", async () => {
    const h = await harness({ deleteError: "NoSuchEntity" });
    await expect(h.run()).resolves.toMatchObject({ removed: true });
  });

  it("an environment installed with the templates engine never touches IAM", async () => {
    const h = await harness({ engine: "templates" });
    await h.run();
    expect(h.iam.calls).toEqual([]);
    expect(h.cloudFormation.calls).toEqual([]);
  });
});

describe("removeCdkPassRole", () => {
  it("answers removed, kept and absent", async () => {
    const input = { env: "staging", account: ACCOUNT, region: REGION, write: () => undefined };
    expect(await removeCdkPassRole({ ...input, iam: fakeIam().client, cloudformation: fakeCloudFormation([{ name: "agentx-staging-access" }]).client })).toBe("removed");
    expect(await removeCdkPassRole({ ...input, iam: fakeIam().client, cloudformation: fakeCloudFormation([{ name: "agentx-prod-access" }]).client })).toBe("kept");
    expect(await removeCdkPassRole({ ...input, iam: fakeIam({ deleteError: "NoSuchEntity" }).client, cloudformation: fakeCloudFormation([]).client })).toBe("absent");
  });
});

describe("prepareDeployment hands the permission step to the deploy callers", () => {
  const caller = { account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Admin/alice` };
  const base = { env: "staging", region: REGION, account: ACCOUNT, identityMode: "cognito" as const, release: fakeRelease(), stderr: { write: () => undefined } };
  const deployer = { async deploy() { return {}; }, async outputs() { return undefined; } };

  it("builds it for the cdk engine from an injected IAM client, with the caller's partition", async () => {
    const iam = fakeIam();
    const prepared = await prepareDeployment({ ...base, engine: "cdk", source: "/src", deps: { identity: { get: async () => caller }, deployer, store: new MemoryParameterStore(), secrets: { get: async () => undefined, create: async () => undefined }, iam: iam.client } });
    expect(await prepared.ensurePassRole!()).toBe("added");
    expect((JSON.parse(iam.calls.find((call) => call.kind === "put")!.input.PolicyDocument as string) as PolicyShape).Statement[0]!.Resource[0]).toBe(`arn:aws:iam::${ACCOUNT}:role/agentx-*-cloudformation`);
  });

  it("builds nothing for a fake deployer without an IAM client, nor for the templates engine", async () => {
    const deps = { identity: { get: async () => caller }, deployer, store: new MemoryParameterStore(), secrets: { get: async () => undefined, create: async () => undefined } };
    expect((await prepareDeployment({ ...base, engine: "cdk", source: "/src", deps })).ensurePassRole).toBeUndefined();
    expect((await prepareDeployment({ ...base, engine: "templates", deps: { ...deps, iam: fakeIam().client } })).ensurePassRole).toBeUndefined();
  });
});
