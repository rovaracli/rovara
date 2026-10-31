// Stdio MCP host redesign (T6), design sections 2 and 3: the process the MCP controller service runs (infra/lib/mcp-host.ts). It is NOT root and refuses to start as root (this inverts the
// lane E host, which refused to start as anything else): it runs no customer code and starts no uid. It reads the registry of approved stdio servers from the install's own table,
// starts and stops the install, probe and serve tasks through ECS, and keeps the bundles in the install's bucket.
//
// Two listeners: the broker's (plain HTTP on PORT, behind the load balancer's TLS) and the tasks' (TLS, on RUNNER_PORT, certificate and key from the environment). They share no route.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { OrgIdSchema, stdioSpecIfComplete } from "@agentx/contracts";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { createMcpController, ecsServerResources, ecsTaskRunner, objectBundleStore, runsAsRoot, type ApprovedServer, type ControllerRegistry, type McpController } from "@agentx/gateway";
import { orgMcpServerSecretName } from "../connections/org-secrets.js";
import { cidrBlockListOf, parseInstallCidrs } from "../connections/private-endpoints.js";
import { installEnvironmentName } from "../org/resolve.js";
import { bundleObjectApiFromS3, ec2GroupApiFromSdk, ecsApiFromSdk, ecsDefinitionApiFromSdk, type EcsSdk } from "./aws-adapters.js";
import { destinationResolver } from "./destinations.js";
import { dynamoProbeSlots } from "./probe-slots.js";
import { dynamoMcpServerStore, summariseProbe } from "../context-sources/mcp-servers.js";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** An Enterprise install has one org; the controller serves that org's approved stdio entries and nothing else. */
export function registryFor(store: ReturnType<typeof dynamoMcpServerStore>, orgId: string, secretRef?: (serverId: string) => string): ControllerRegistry {
  const org = OrgIdSchema.parse(orgId);
  return {
    async approved(serverId): Promise<ApprovedServer | undefined> {
      const entry = await store.get(org, serverId);
      // Only an approved entry with its install pinned is served; a needs_reapproval or incomplete one is not.
      if (entry?.status !== "approved") return undefined;
      const spec = stdioSpecIfComplete(entry);
      if (spec === undefined) return undefined;
      return { spec, toolsHash: entry.probe.toolsHash, secretVersion: entry.secretVersion, secretRef: secretRef?.(serverId) };
    },
  };
}

/** The hash the approval binds, computed the way the broker computes it for what the admin was shown. */
export const toolsHashOf = (tools: Parameters<typeof summariseProbe>[0]): string => summariseProbe(tools, 0).toolsHash;

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
  if (runsAsRoot(identity)) throw new Error("the MCP controller must not run as root");
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
  const runner = ecsTaskRunner({ api: ecsApiFromSdk(sdk, new sdk.ECSClient({})), cluster: config.cluster, subnets: config.subnets, defaultSecurityGroupId: config.installSecurityGroupId });
  const bundles = objectBundleStore(bundleObjectApiFromS3(new S3Client({}), config.bundleBucket));
  const orgId = required(env, "ROVARA_ORG_ID");
  const stateTable = required(env, "STATE_TABLE_NAME");
  const installEnvironment = installEnvironmentName(env);
  const log = (event: string, fields: Record<string, string | number>): void => { console.log(JSON.stringify({ component: "mcp-controller", event, ...fields })); };
  const ecs = new sdk.ECSClient({});
  const resources = ecsServerResources({
    definitions: ecsDefinitionApiFromSdk(sdk, ecs), groups: ec2GroupApiFromSdk(new EC2Client({})), vpcId: config.vpcId, image: config.runnerImage, executionRoleArn: config.executionRoleArn,
    logGroup: config.logGroup, region: config.region,
    endpoints: { endpointGroupIds: config.endpointGroupIds, s3PrefixListId: config.s3PrefixListId, controllerGroupId: config.controllerGroupId, controllerPort: config.runnerPort },
    resolveDestinations: destinationResolver({ installCidrs: config.privateCidrs, rovaraCidrs: config.rovaraCidrs }),
    // Counts only: the audit event with the host names is the audit task's (T10).
    onEgressChange: (change) => log("mcp_controller.egress_updated", { serverId: change.serverId, added: change.added.length, removed: change.removed.length }),
  });
  const controller = createMcpController({
    token, registry: registryFor(dynamoMcpServerStore({ documentClient, tableName: stateTable }), orgId, (serverId) => orgMcpServerSecretName(installEnvironment, orgId, serverId)), runner, bundles,
    controllerUrl: config.controllerUrl, controllerCa: config.controllerCa, npmRegistry: config.npmRegistry, installSecurityGroupId: config.installSecurityGroupId, toolsHashOf, log,
    resources, probeSlots: dynamoProbeSlots({ documentClient, tableName: stateTable, orgId: OrgIdSchema.parse(orgId) }), sweepMs: 60_000,
  });
  const listeners = listen(controller, { broker: config.brokerPort, runner: config.runnerPort, tls: { cert: config.tlsCert, key: config.tlsKey } });
  const stop = (): void => { listeners.close(); void controller.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((error: unknown) => { console.error(JSON.stringify({ component: "mcp-controller", event: "start_failed", error: error instanceof Error ? error.message : "unknown" })); process.exit(1); });
}
