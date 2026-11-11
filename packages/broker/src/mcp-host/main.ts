// Stdio MCP host redesign (T6), design sections 2 and 3: the process the MCP controller service runs (infra/lib/mcp-host.ts). It is NOT root and refuses to start as root (this inverts the
// lane E host, which refused to start as anything else): it runs no customer code and starts no uid. It reads the registry of approved stdio servers from the install's own table,
// starts and stops the install, probe and serve tasks through ECS, and keeps the bundles in the install's bucket.
//
// Two listeners: the broker's (plain HTTP on PORT, behind the load balancer's TLS) and the tasks' (TLS, on RUNNER_PORT, certificate and key from the environment). They share no route.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { OrgIdSchema, isPackageServerId, stdioSpecIfComplete, type McpStdioProposal, type McpStdioSpec } from "@rovara-code/contracts";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createMcpController, ecsServerResources, ecsTaskRunner, objectBundleStore, RootRefusedError, runsAsRoot, type ApprovedServer, type ControllerRegistry, type McpController } from "@agentx/gateway";
import { orgMcpServerSecretName } from "../connections/org-secrets.js";
import { cidrBlockListOf, parseInstallCidrs } from "../connections/private-endpoints.js";
import { installEnvironmentName } from "../org/resolve.js";
import { secretArnResolver, bundleObjectApiFromS3, ec2GroupApiFromSdk, ecsApiFromSdk, ecsDefinitionApiFromSdk, type EcsSdk } from "./aws-adapters.js";
import { destinationResolver } from "./destinations.js";
import { dynamoInstanceLeases } from "./instance-leases.js";
import { dynamoProbeSlots } from "./probe-slots.js";
import { dynamoControllerEvents } from "./events.js";
import { dynamoPauses } from "./pauses.js";
import { dynamoBundleMarks } from "./bundle-marks.js";
import { randomBytes } from "node:crypto";
import { dynamoMcpServerStore, legacyToolsHash, summariseProbe } from "../context-sources/mcp-servers.js";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/**
 * Whether a test is the pinned install of a paused entry, in every part that decides what a task may do with the secret: the package and its tarball, the arguments, the secret names, the addresses
 * it may reach (in order), the size, and both pinned hashes. The tarball's integrity must be named: a test that leaves it out is not the pinned package.
 */
function isPinnedInstall(test: McpStdioProposal, tested: { lockfileHash: string; bundleHash: string }, pinned: McpStdioSpec): boolean {
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  return test.name === pinned.name && test.version === pinned.version && test.registry === pinned.registry && test.integrity === pinned.integrity
    && same(test.args, pinned.args) && same(test.secretEnv, pinned.secretEnv)
    && same(test.destinations.map((item) => [item.host, item.port]), pinned.destinations.map((item) => [item.host, item.port]))
    && test.size.cpu === pinned.size.cpu && test.size.memoryMiB === pinned.size.memoryMiB
    && tested.lockfileHash === pinned.lockfileHash && tested.bundleHash === pinned.bundleHash;
}

/**
 * Review S1: the name of the secret a task is given for a server. Built only for a package-run id (`mcppkg...`): the runner execution role reads only those names, and the controller never
 * names an address-based server's token to ECS, even by mistake.
 */
export function packageSecretName(env: string, orgId: string, serverId: string): string {
  if (!isPackageServerId(serverId)) throw new Error("only a package-run server has secrets a task may be given");
  return orgMcpServerSecretName(env, orgId, serverId);
}

/** An Enterprise install has one org; the controller serves that org's approved stdio entries and nothing else. */
export function registryFor(store: ReturnType<typeof dynamoMcpServerStore>, orgId: string, secretArn?: (serverId: string) => Promise<string | undefined>): ControllerRegistry {
  const org = OrgIdSchema.parse(orgId);
  return {
    async approved(serverId): Promise<ApprovedServer | undefined> {
      const entry = await store.get(org, serverId);
      // Only an approved entry with its install pinned is served; a needs_reapproval or incomplete one is not.
      if (entry?.status !== "approved") return undefined;
      const spec = stdioSpecIfComplete(entry);
      if (spec === undefined) return undefined;
      // The secret's full ARN (ECS needs it to read one key of the JSON secret). A secret that cannot be resolved leaves no reference, and then a server that declares secrets does not start.
      const secretRef = entry.hasSecret === true && secretArn !== undefined ? await secretArn(serverId).catch(() => undefined) : undefined;
      return { spec, toolsHash: entry.probe.toolsHash, toolsHashVersion: entry.probe.hashVersion === 2 ? 2 : 1, secretVersion: entry.secretVersion, secretRef };
    },
    // Review M10: the bundles that are kept. Every package-run entry of the org counts, in any status. An entry that cannot be read could be the one that references a bundle, so there is no answer.
    async referencedBundles(): Promise<ReadonlySet<string>> {
      const { entries, unreadable } = await store.listAll(org);
      if (unreadable > 0) throw new Error("an entry cannot be read, so the bundles in use cannot be told");
      const kept = new Set<string>();
      for (const entry of entries) if (entry.transport.kind === "stdio" && entry.transport.spec.bundleHash !== undefined) kept.add(entry.transport.spec.bundleHash);
      return kept;
    },
    async probeSecret(serverId, test): Promise<string | undefined> {
      if (secretArn === undefined) return undefined;
      // The broker stores a proposal's secrets under the proposal's id BEFORE the test. That secret is read by a test only while the proposal has no entry yet or its entry still waits for
      // approval: the secret of an approved or disabled entry never goes into a test of a package the caller names. A waiting entry must be a package-run entry (review M4): an address-based
      // server's token is never handed to a package test.
      // Fix round 2 (N1): the one other case is the review and re-approve test of a PAUSED stdio entry, which has secrets and must be tested to be looked at. It gets the secret only when the test
      // is that entry's own pinned install: the same package, arguments, secret names, tarball, addresses and size, and both pinned hashes (SR-7 H1); anything else under that id gets none.
      const entry = await store.get(org, serverId);
      // Review N1: with no entry, only a package-run proposal's id (`mcppkg...`) has a secret to give. An address-based server's token sits under its id between its storing and its entry, and the
      // secret of a removed entry whose delete failed may remain: neither is ever handed to a test.
      if (entry === undefined && !isPackageServerId(serverId)) return undefined;
      if (entry !== undefined && entry.status === "changed_needs_review") {
        const pinned = stdioSpecIfComplete({ ...entry, status: "approved" });
        if (entry.hasSecret !== true || pinned === undefined || test === undefined || test.pinned === undefined) return undefined;
        if (!isPinnedInstall(test.spec, test.pinned, pinned)) return undefined;
      } else if (entry !== undefined && (entry.status !== "awaiting_approval" || entry.transport.kind !== "stdio")) return undefined;
      return secretArn(serverId).catch(() => undefined);
    },
  };
}

/** The hash the approval binds, computed the way the broker computes it for what the admin was shown. */
export const toolsHashOf = (tools: Parameters<typeof summariseProbe>[0]): string => summariseProbe(tools, 0).toolsHash;
/** The hash an approval made before descriptions were hashed carries (names and schemas only). */
export const legacyToolsHashOf = (tools: Parameters<typeof summariseProbe>[0]): string => legacyToolsHash(summariseProbe(tools, 0));

export interface ControllerConfig {
  brokerPort: number;
  runnerPort: number;
  cluster: string;
  subnets: string[];
  installSecurityGroupId: string;
  controllerUrl: string;
  controllerCa?: string | undefined;
  npmRegistry: string;
  bundleBucket: string;
  tlsCert: string;
  tlsKey: string;
  /** What a runner's task definition and security group are made from (T7). */
  vpcId: string;
  runnerImage: string;
  executionRoleArn: string;
  logGroup: string;
  region: string;
  endpointGroupIds: string[];
  s3PrefixListId: string;
  controllerGroupId: string;
  /** The install's private ranges (`ROVARA_PRIVATE_MCP_CIDRS`) and Rovara's own network (`ROVARA_VPC_CIDRS`). */
  privateCidrs: string[];
  rovaraCidrs: string[];
}

function port(value: string | undefined, fallback: number, name: string): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 65_535) throw new Error(`${name} is not a port the controller may use`);
  return number;
}

/** Reads and checks the controller's settings. A setting that is missing or not valid stops the start; nothing is defaulted that the infrastructure decides. */
export function controllerConfigFromEnv(env: Record<string, string | undefined>): ControllerConfig {
  const need = (name: string): string => { const value = env[name]; if (value === undefined || value === "") throw new Error(`${name} is not set`); return value; };
  const controllerUrl = need("MCP_CONTROLLER_URL");
  const url = new URL(controllerUrl);
  // The tasks fetch and install over TLS only (their programs refuse plain http except on loopback), so the address they are given must be https.
  if (url.protocol !== "https:") throw new Error("MCP_CONTROLLER_URL must be an https address");
  const registry = new URL(need("ROVARA_MCP_NPM_REGISTRY"));
  if (registry.protocol !== "https:") throw new Error("ROVARA_MCP_NPM_REGISTRY must be an https address");
  const subnets = need("MCP_RUNNER_SUBNETS").split(",").map((item) => item.trim());
  const rovaraCidrs = (env.ROVARA_VPC_CIDRS ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (cidrBlockListOf(rovaraCidrs) === undefined) throw new Error("ROVARA_VPC_CIDRS is not a list of ranges");
  // The same rule as the broker's: ranges set without the network Rovara runs in cannot be checked for overlap, so they are refused.
  const privateCidrs = parseInstallCidrs(env.ROVARA_PRIVATE_MCP_CIDRS, rovaraCidrs);
  if (privateCidrs.length > 0 && rovaraCidrs.length === 0) throw new Error("ROVARA_PRIVATE_MCP_CIDRS needs ROVARA_VPC_CIDRS");
  return {
    brokerPort: port(env.PORT, 8080, "PORT"), runnerPort: port(env.MCP_RUNNER_PORT, 8443, "MCP_RUNNER_PORT"), cluster: need("MCP_ECS_CLUSTER"), subnets,
    installSecurityGroupId: need("MCP_INSTALL_SECURITY_GROUP"), controllerUrl, controllerCa: env.ROVARA_MCP_CONTROLLER_CA, npmRegistry: registry.href, bundleBucket: need("MCP_BUNDLE_BUCKET"),
    tlsCert: need("MCP_CONTROLLER_TLS_CERT"), tlsKey: need("MCP_CONTROLLER_TLS_KEY"),
    vpcId: need("MCP_VPC_ID"), runnerImage: need("MCP_RUNNER_IMAGE"), executionRoleArn: need("MCP_EXECUTION_ROLE_ARN"), logGroup: need("MCP_RUNNER_LOG_GROUP"), region: need("AWS_REGION"),
    endpointGroupIds: need("MCP_ENDPOINT_SECURITY_GROUPS").split(",").map((item) => item.trim()), s3PrefixListId: need("MCP_S3_PREFIX_LIST"), controllerGroupId: need("MCP_CONTROLLER_SECURITY_GROUP"),
    privateCidrs, rovaraCidrs,
  };
}

/** The listeners. Neither shares a route with the other: a task's token reaches the runner listener only. */
export function listen(controller: McpController, ports: { broker: number; runner: number; tls: { cert: string; key: string } }): { close(): void } {
  const broker = createHttpServer((req, res) => { void controller.handleBroker(req, res); });
  const runner = createHttpsServer({ cert: ports.tls.cert, key: ports.tls.key }, (req, res) => { void controller.handleRunner(req, res); });
  broker.listen(ports.broker, "0.0.0.0");
  runner.listen(ports.runner, "0.0.0.0");
  return { close: () => { broker.close(); runner.close(); } };
}

export interface StartDependencies {
  identity?: { getuid(): number | undefined; getgid(): number | undefined; geteuid(): number | undefined; getegid(): number | undefined };
  env?: Record<string, string | undefined>;
}

export async function start(dependencies: StartDependencies = {}): Promise<void> {
  const identity = dependencies.identity ?? { getuid: () => process.getuid?.(), getgid: () => process.getgid?.(), geteuid: () => process.geteuid?.(), getegid: () => process.getegid?.() };
  // Not root, and not group root: the controller runs no customer code and needs no privilege. It refuses before it reads a secret or opens a port.
  if (runsAsRoot(identity)) throw new RootRefusedError("the MCP controller");
  const env = dependencies.env ?? process.env;
  const config = controllerConfigFromEnv(env);
  const token = env.MCP_HOST_TOKEN;
  if (token === undefined || token === "") throw new Error("MCP_HOST_TOKEN is not set");
  // The token is held in this process only; the variable is removed from the environment this process hands on.
  delete env.MCP_HOST_TOKEN;
  delete env.MCP_CONTROLLER_TLS_KEY;
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const ecsModule = "@aws-sdk/client-ecs";
  const sdk = await import(ecsModule) as EcsSdk;
  const instanceId = randomBytes(8).toString("hex");
  const runner = ecsTaskRunner({ instanceId, api: ecsApiFromSdk(sdk, new sdk.ECSClient({})), cluster: config.cluster, subnets: config.subnets, defaultSecurityGroupId: config.installSecurityGroupId });
  const bundles = objectBundleStore(bundleObjectApiFromS3(new S3Client({}), config.bundleBucket));
  const orgId = required(env, "ROVARA_ORG_ID");
  const stateTable = required(env, "STATE_TABLE_NAME");
  const installEnvironment = installEnvironmentName(env);
  const log = (event: string, fields: Record<string, string | number>): void => { console.log(JSON.stringify({ component: "mcp-controller", event, ...fields })); };
  const ecs = new sdk.ECSClient({});
  const events = dynamoControllerEvents({ documentClient, tableName: stateTable, orgId: OrgIdSchema.parse(orgId), log });
  const resources = ecsServerResources({
    definitions: ecsDefinitionApiFromSdk(sdk, ecs), groups: ec2GroupApiFromSdk(new EC2Client({})), vpcId: config.vpcId, image: config.runnerImage, executionRoleArn: config.executionRoleArn,
    logGroup: config.logGroup, region: config.region,
    endpoints: { endpointGroupIds: config.endpointGroupIds, s3PrefixListId: config.s3PrefixListId, controllerGroupId: config.controllerGroupId, controllerPort: config.runnerPort },
    resolveDestinations: destinationResolver({ installCidrs: config.privateCidrs, rovaraCidrs: config.rovaraCidrs }),
    // The log gets counts only; the audit event (with the approved names and the addresses) goes to the broker through the events partition.
    onEgressChange: (change) => { log("mcp_controller.egress_updated", { serverId: change.serverId, added: change.added.length, removed: change.removed.length }); void events.egress(change); },
  });
  const controller = createMcpController({
    token, events: (event) => events.record(event), pauses: dynamoPauses({ documentClient, tableName: stateTable, orgId: OrgIdSchema.parse(orgId) }), bundleMarks: dynamoBundleMarks({ documentClient, tableName: stateTable, orgId: OrgIdSchema.parse(orgId) }), registry: registryFor(dynamoMcpServerStore({ documentClient, tableName: stateTable }), orgId, secretArnResolver(new SecretsManagerClient({}), (serverId) => packageSecretName(installEnvironment, orgId, serverId))), runner, bundles,
    controllerUrl: config.controllerUrl, controllerCa: config.controllerCa, npmRegistry: config.npmRegistry, installSecurityGroupId: config.installSecurityGroupId, toolsHashOf, legacyToolsHashOf, log,
    resources, probeSlots: dynamoProbeSlots({ documentClient, tableName: stateTable, orgId: OrgIdSchema.parse(orgId) }), sweepMs: 60_000,
    leases: dynamoInstanceLeases({ documentClient, tableName: stateTable, orgId: OrgIdSchema.parse(orgId), instanceId }),
  });
  const listeners = listen(controller, { broker: config.brokerPort, runner: config.runnerPort, tls: { cert: config.tlsCert, key: config.tlsKey } });
  const stop = (): void => { listeners.close(); void controller.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((error: unknown) => { console.error(JSON.stringify({ component: "mcp-controller", event: "start_failed", ...(error instanceof RootRefusedError ? { code: error.code } : {}), error: error instanceof Error ? error.message : "unknown" })); process.exit(1); });
}
