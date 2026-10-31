// Stdio MCP host redesign, task T6: the controller's process. It refuses to start as root (this inverts the lane E host), reads its settings strictly, and serves only approved entries.
import { describe, expect, it } from "vitest";
import { controllerConfigFromEnv, registryFor, start, toolsHashOf } from "../../../packages/broker/src/mcp-host/main.js";
import type { McpServerEntry, McpStdioSpec } from "@agentx/contracts";
import { summariseProbe } from "../../../packages/broker/src/context-sources/mcp-servers.js";

const ENV = {
  MCP_CONTROLLER_URL: "https://mcp-controller.corp.example:8443", ROVARA_MCP_NPM_REGISTRY: "https://registry.corp.example/npm/", MCP_RUNNER_SUBNETS: "subnet-0aaaaaaaaaaaaaaaa, subnet-0bbbbbbbbbbbbbbbb",
  MCP_ECS_CLUSTER: "rovara-mcp", MCP_INSTALL_SECURITY_GROUP: "sg-0cccccccccccccccc", MCP_BUNDLE_BUCKET: "bundles", MCP_CONTROLLER_TLS_CERT: "CERT", MCP_CONTROLLER_TLS_KEY: "KEY",
  MCP_VPC_ID: "vpc-0123456789abcdef0", MCP_RUNNER_IMAGE: `111111111111.dkr.ecr.us-east-1.amazonaws.com/rovara-mcp-runner@sha256:${"a".repeat(64)}`, MCP_EXECUTION_ROLE_ARN: "arn:aws:iam::111111111111:role/rovara-mcp-execution",
  MCP_RUNNER_LOG_GROUP: "/rovara/mcp-runner", AWS_REGION: "us-east-1", MCP_ENDPOINT_SECURITY_GROUPS: "sg-0eeeeeeeeeeeeeeee, sg-0ffffffffffffffff", MCP_S3_PREFIX_LIST: "pl-0123456789abcdef0",
  MCP_CONTROLLER_SECURITY_GROUP: "sg-0123456789abcdef0", ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16",
};

describe("controller main: start", () => {
  it("refuses to start as root, as group root or with a root effective id, before it reads a setting or opens a port", async () => {
    const identities = [{ uid: 0, gid: 10_001 }, { uid: 10_001, gid: 0 }];
    for (const identity of identities) await expect(start({ identity: { getuid: () => identity.uid, getgid: () => identity.gid, geteuid: () => identity.uid, getegid: () => identity.gid }, env: {} })).rejects.toThrow("must not run as root");
    await expect(start({ identity: { getuid: () => 10_001, getgid: () => 10_001, geteuid: () => 0, getegid: () => 10_001 }, env: {} })).rejects.toThrow("must not run as root");
    // as an ordinary user it gets as far as the settings
    await expect(start({ identity: { getuid: () => 10_001, getgid: () => 10_001, geteuid: () => 10_001, getegid: () => 10_001 }, env: {} })).rejects.toThrow("is not set");
  });
});

describe("controller main: settings", () => {
  it("reads the settings", () => {
    expect(controllerConfigFromEnv(ENV)).toEqual({
      brokerPort: 8080, runnerPort: 8443, cluster: "rovara-mcp", subnets: ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"], installSecurityGroupId: "sg-0cccccccccccccccc", controllerUrl: "https://mcp-controller.corp.example:8443",
      controllerCa: undefined, npmRegistry: "https://registry.corp.example/npm/", bundleBucket: "bundles", tlsCert: "CERT", tlsKey: "KEY",
      vpcId: "vpc-0123456789abcdef0", runnerImage: ENV.MCP_RUNNER_IMAGE, executionRoleArn: "arn:aws:iam::111111111111:role/rovara-mcp-execution", logGroup: "/rovara/mcp-runner", region: "us-east-1",
      endpointGroupIds: ["sg-0eeeeeeeeeeeeeeee", "sg-0ffffffffffffffff"], s3PrefixListId: "pl-0123456789abcdef0", controllerGroupId: "sg-0123456789abcdef0", privateCidrs: ["10.1.0.0/16"], rovaraCidrs: ["10.42.0.0/16"],
    });
  });
  it("refuses what is missing, a controller address that is not https (the tasks refuse plain http), a registry that is not https and a port the controller may not use", () => {
    for (const name of Object.keys(ENV)) if (name !== "ROVARA_PRIVATE_MCP_CIDRS" && name !== "ROVARA_VPC_CIDRS") expect(() => controllerConfigFromEnv({ ...ENV, [name]: undefined }), name).toThrow();
    expect(() => controllerConfigFromEnv({ ...ENV, MCP_CONTROLLER_URL: "http://mcp-controller.corp.example:8443" })).toThrow(/https/u);
    expect(() => controllerConfigFromEnv({ ...ENV, ROVARA_MCP_NPM_REGISTRY: "http://registry.corp.example/" })).toThrow(/https/u);
    // ranges for private servers need the network Rovara runs in, so that an overlap can be refused; a range that is not private is refused
    expect(() => controllerConfigFromEnv({ ...ENV, ROVARA_VPC_CIDRS: undefined })).toThrow(/ROVARA_VPC_CIDRS/u);
    expect(() => controllerConfigFromEnv({ ...ENV, ROVARA_PRIVATE_MCP_CIDRS: "8.8.8.0/24" })).toThrow();
    expect(() => controllerConfigFromEnv({ ...ENV, ROVARA_VPC_CIDRS: "nonsense" })).toThrow();
    expect(controllerConfigFromEnv({ ...ENV, ROVARA_PRIVATE_MCP_CIDRS: undefined, ROVARA_VPC_CIDRS: undefined })).toMatchObject({ privateCidrs: [], rovaraCidrs: [] });
    for (const PORT of ["80", "0", "99999", "x"]) expect(() => controllerConfigFromEnv({ ...ENV, PORT }), PORT).toThrow();
    expect(() => controllerConfigFromEnv({ ...ENV, MCP_RUNNER_PORT: "443" })).toThrow();
  });
});

describe("controller main: the registry", () => {
  const spec: McpStdioSpec = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], integrity: `sha512-${"A".repeat(86)}==`, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } };
  const probe = summariseProbe([], 0);
  const entry = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({ serverId: "mcpsim000001", label: "Wiki", status: "approved", transport: { kind: "stdio", spec }, probe, requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z", ...over });
  const registry = (found: McpServerEntry | undefined) => registryFor({ get: async () => found } as never, "org_aaaaaaaaaaaaaaaaaaaa", (id) => `agentx/test/org-connectors/org/${id}`);

  it("serves an approved entry with its install pinned, with the tools hash the admin approved and its secret version", async () => {
    const approved = await registry(entry({ hasSecret: true, secretVersion: "v1" })).approved("mcpsim000001");
    expect(approved).toMatchObject({ spec, toolsHash: probe.toolsHash, secretVersion: "v1", secretRef: "agentx/test/org-connectors/org/mcpsim000001" });
  });
  it("serves nothing else: not a waiting, disabled or needs-reapproval entry, an http entry, or none", async () => {
    for (const status of ["awaiting_approval", "disabled", "needs_reapproval"] as const) expect(await registry(entry({ status })).approved("mcpsim000001"), status).toBeUndefined();
    expect(await registry(entry({ transport: { kind: "http", address: "https://mcp.corp.example/mcp" } })).approved("mcpsim000001")).toBeUndefined();
    expect(await registry(undefined).approved("mcpsim000001")).toBeUndefined();
  });
  it("hashes tools the way the broker hashes what the admin was shown", () => {
    const tools = [{ name: "b", inputSchema: { type: "object" } }, { name: "a", inputSchema: { type: "object" } }];
    expect(toolsHashOf(tools)).toBe(summariseProbe(tools, 123).toolsHash);
  });
});
