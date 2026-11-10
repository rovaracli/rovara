// Account limits (lane fix/0513-embedder-3gb). The 0.5.12 Team record switch-on failed on staging because the embedder function asked for 10,240 MB of memory and the account's limit is
// 3,008 MB; template diffs, cfn-lint and no-execute change sets cannot see account limits. infra/lib/account-limits.ts writes the assumed limits down; this test holds every Lambda function
// of every synthesised stack, with the Team record on and off and in both editions, to them. A bigger size needs the account's limit confirmed first (docs/runbooks/new-resource-size-vs-account-limit.md).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ASSUMED_LAMBDA_MEMORY_LIMIT_MB } from "../../infra/lib/account-limits.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { EMBEDDER_MEMORY_MB } from "../../infra/lib/embedder-function.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
const PUBLIC = { agentxEnv: "staging", agentxCloud: true } as const;
const LAMBDA_FUNCTION = "AWS::Lambda::Function";
type FunctionProperties = { FunctionName?: unknown; MemorySize?: number; EphemeralStorage?: { Size?: number } };

/** Every Lambda function of every stack the app synthesises, with the stack it is in. */
function functionsOf(context: Record<string, unknown>): Array<{ stack: string; id: string; properties: FunctionProperties }> {
  const app = buildAgentXApp(context);
  return app.node.children.filter((child): child is Stack => Stack.isStack(child)).flatMap((stack) => {
    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: FunctionProperties }>;
    return Object.entries(resources).filter(([, resource]) => resource.Type === LAMBDA_FUNCTION).map(([id, resource]) => ({ stack: stack.node.id, id, properties: resource.Properties }));
  });
}

describe("no function asks for more than the account allows", () => {
  it("assumes the limit of an account whose Lambda memory limit has not been raised", () => {
    expect(ASSUMED_LAMBDA_MEMORY_LIMIT_MB).toBe(3008);
    expect(EMBEDDER_MEMORY_MB).toBeLessThanOrEqual(ASSUMED_LAMBDA_MEMORY_LIMIT_MB);
  });

  // Every synth option that adds a stack or a function: the identity modes, the Team record in both editions (with and without the lake), the eval and installer stacks, no reserved concurrency, and the
  // legacy deployment. A function added behind any of them is held to the limit.
  const MATRIX: Array<[string, Record<string, unknown>]> = [
    ["legacy deployment (no environment)", {}],
    ["Public cloud, Team record off", PUBLIC],
    ["Public cloud, Team record on", { ...PUBLIC, agentxTeamRecord: "enabled" }],
    ["Public cloud, Team record on, no lake", { ...PUBLIC, agentxTeamRecord: "enabled", agentxTeamRecordLake: "false" }],
    ["Public cloud, no reserved concurrency", { ...PUBLIC, agentxReservedConcurrency: false }],
    ["Public cloud with the eval stack", { ...PUBLIC, agentxEval: "enabled" }],
    ["Public cloud with the installer stack", { ...PUBLIC, agentxInstaller: "enabled" }],
    ["named environment, OIDC sign-in", { agentxEnv: "oidc", agentxIdentity: "oidc" }],
    ["named environment, Cognito sign-in", { agentxEnv: "cog", agentxIdentity: "cognito" }],
    ["Enterprise, Team record off", ENTERPRISE],
    ["Enterprise, Team record on", { ...ENTERPRISE, agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa" }],
    ["Enterprise, Team record on, no lake", { ...ENTERPRISE, agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa", agentxTeamRecordLake: "false" }],
  ];
  it.each(MATRIX)("%s: every function's memory is within the limit", (_name, context) => {
    const functions = functionsOf(context);
    expect(functions.length).toBeGreaterThan(0);
    // A positive control: the check really saw the embedder when the Team record is on.
    if (context.agentxTeamRecord === "enabled") expect(functions.find((fn) => fn.properties.FunctionName === `agentx-${String(context.agentxEnv)}-embedder`)?.properties.MemorySize).toBe(EMBEDDER_MEMORY_MB);
    const over = functions.filter((fn) => (fn.properties.MemorySize ?? 128) > ASSUMED_LAMBDA_MEMORY_LIMIT_MB).map((fn) => `${fn.stack}/${fn.id}: ${fn.properties.MemorySize} MB`);
    expect(over).toStrictEqual([]);
  }, 300_000);

  // The matrix cannot know a flag nobody listed; the source can be read for every literal memory size, in any file of infra/.
  it("no `memorySize:` literal in infra/ is above the limit", () => {
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === "node_modules" ? [] : files(join(directory, entry.name))) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []));
    const found = files("infra").flatMap((file) => [...readFileSync(file, "utf8").matchAll(/memorySize\s*[:=]\s*([0-9][0-9_]*)/gu)].map((match) => ({ file, mb: Number((match[1] ?? "0").replaceAll("_", "")) })));
    expect(found.length).toBeGreaterThan(3);
    expect(found.filter((entry) => entry.mb > ASSUMED_LAMBDA_MEMORY_LIMIT_MB)).toStrictEqual([]);
  });
});
