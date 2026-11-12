// ME-13 (wire lane C): the install's private MCP settings at synth. They arrive as CDK context (`-c name=value`), only in an Enterprise install, and reach the broker as the
// environment variables it reads at start (packages/broker/src/context-sources/install.ts).
//
//   rovaraPrivateMcpCidrs          comma-separated private ranges outside which no private MCP server is tested or called -> ROVARA_PRIVATE_MCP_CIDRS
//   rovaraStdioMcpServers          package-run servers. Stops synth unless the release flag STDIO_MCP_RELEASED is true (it is false); then every setting below is required
//   rovaraMcpPublicNpm             optional, default false: the install task fetches packages from PUBLIC npm instead of the customer's own registry mirror. Only then is a NAT gateway made (and only the install task may use it)
//   rovaraMcpRunnerRoutes          optional: routes from the runner subnets to the customer's own private ranges, `<cidr>=<tgw-...|pcx-...>`, comma-separated, at most 8
//   rovaraMcpRunnerSubnetCidrs, rovaraMcpRegistryCidrs, rovaraMcpControllerTlsSecretArn, rovaraMcpControllerDnsNamespace, rovaraMcpControllerCa   the runner network, the registry's ranges, the controller's certificate
//   rovaraMcpHostCertificateArn    the ACM certificate of the MCP host's HTTPS listener (McpHost refuses to be built without one)
//   rovaraMcpHostName, rovaraMcpHostedZoneId   the DNS name the certificate is for, and the Route 53 zone the alias record goes in
//
// No certificate, name or range is written into the code: each comes from the install's own configuration. Every wrong value stops synth, naming its setting and never echoing a secret.
import type { Edition } from "@rovara-code/contracts";
import { AGENTX_PRODUCTION_VPC_CIDR } from "./production-foundation.js";
import { ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY, parseEnterpriseEgressCidrs } from "./vpc-endpoints.js";

export const PRIVATE_MCP_CONTEXT_KEYS = {
  cidrs: "rovaraPrivateMcpCidrs",
  stdio: "rovaraStdioMcpServers",
  certificateArn: "rovaraMcpHostCertificateArn",
  hostName: "rovaraMcpHostName",
  hostedZoneId: "rovaraMcpHostedZoneId",
  npmRegistry: "rovaraMcpNpmRegistry",
  publicNpm: "rovaraMcpPublicNpm",
  runnerSubnetCidrs: "rovaraMcpRunnerSubnetCidrs",
  runnerRoutes: "rovaraMcpRunnerRoutes",
  registryCidrs: "rovaraMcpRegistryCidrs",
  controllerTlsSecretArn: "rovaraMcpControllerTlsSecretArn",
  controllerDnsNamespace: "rovaraMcpControllerDnsNamespace",
  controllerCa: "rovaraMcpControllerCa",
} as const;

/**
 * THE RELEASE FLAG for package-run MCP servers (stdio MCP host redesign, register ME-14). False: asking for them (`rovaraStdioMcpServers`) stops synth. It is flipped, in one commit, by the
 * release that contains tasks T1 to T12, after the final review and the staging smoke have passed (the turn-on checklist). Replaces: the unconditional refusal.
 */
export const STDIO_MCP_RELEASED = false;
/**
 * The build does not yet put the MCP host in a stack of its own (the foundation does not expose the ids it needs). Until it does, a released flag still stops synth with a clear sentence
 * rather than build a broker that points at a host that does not exist. Removed by the turn-on release together with the wiring.
 */
export const STDIO_MCP_HOST_STACK_BUILT = false;
const KEYS = PRIVATE_MCP_CONTEXT_KEYS;

export interface PrivateMcpInstall {
  /** Private ranges for ROVARA_PRIVATE_MCP_CIDRS. Empty: every private server is refused (fail closed). */
  privateCidrs: string[];
  /** The network Rovara itself runs in, given to the broker (`ROVARA_VPC_CIDRS`) so it refuses the same overlap and never tests or calls an address inside it. Set with `privateCidrs`. */
  vpcCidrs?: string[];
  /** False unless the release flag is true AND the install asked for package-run servers. */
  stdioRequested: boolean;
  certificateArn?: string;
  hostName?: string;
  hostedZoneId?: string;
  /** The package registry (normalised, https, no credentials). Only recorded: it reaches the controller when package-run servers are on. */
  npmRegistry?: string;
  runnerSubnetCidrs?: string[];
  runnerRoutes?: Array<{ cidr: string; transitGatewayId?: string; vpcPeeringConnectionId?: string }>;
  /** Fix round 2: the install fetches from public npm (the explicit setting). Then no registry ranges are given and the registry defaults to https://registry.npmjs.org/. */
  publicNpm?: boolean;
  registryCidrs?: string[];
  controllerTlsSecretArn?: string;
  controllerDnsNamespace?: string;
  controllerCa?: string;
}

const ACM_CERTIFICATE_ARN = /^arn:aws(?:-[a-z]+)*:acm:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:certificate\/[0-9A-Za-z-]+$/u;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u;
const AWS_OWN_NAME = /(?:^|\.)amazonaws\.com$/u;
const HOSTED_ZONE_ID = /^Z[0-9A-Z]{1,31}$/u;
const SECRET_ARN = /^arn:aws(?:-[a-z]+)*:secretsmanager:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/u;

const isSet = (value: unknown): boolean => value !== undefined;

/** Whether two IPv4 ranges share an address (ranges nest, so: one contains the other's first address). A range that does not parse overlaps everything. */
export function ipv4RangesOverlap(a: string, b: string): boolean {
  const parse = (cidr: string): { first: number; mask: number } | undefined => {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(cidr);
    if (match === null) return undefined;
    const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map(Number);
    const prefix = Number(match[5]);
    if (octets.some((octet) => octet > 255) || prefix > 32) return undefined;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { first: (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0, mask };
  };
  const left = parse(a), right = parse(b);
  if (left === undefined || right === undefined) return true;
  const inside = (outer: { first: number; mask: number }, address: number) => ((address & outer.mask) >>> 0) === ((outer.first & outer.mask) >>> 0);
  return inside(left, right.first) || inside(right, left.first);
}

/** `10.60.0.0/16=tgw-0123456789abcdef0, 10.70.0.0/16=pcx-0123456789abcdef0`: a private range and the transit gateway or peering connection that reaches it. At most 8. Whether the range is private is checked where the route is made. */
function parseRunnerRoutes(value: unknown): Array<{ cidr: string; transitGatewayId?: string; vpcPeeringConnectionId?: string }> {
  const fail = (): never => { throw new Error(`${KEYS.runnerRoutes} must be a comma-separated list of <range>=<tgw-id or pcx-id>, at most 8, such as 10.60.0.0/16=tgw-0123456789abcdef0`); };
  if (typeof value !== "string") return fail();
  const items = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (items.length < 1 || items.length > 8) return fail();
  return items.map((item) => {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})=(tgw|pcx)-([0-9a-f]{8,17})$/u.exec(item);
    if (match === null || (match[1]!.endsWith("/0"))) return fail();
    return match[2] === "tgw" ? { cidr: match[1]!, transitGatewayId: `tgw-${match[3]!}` } : { cidr: match[1]!, vpcPeeringConnectionId: `pcx-${match[3]!}` };
  });
}

/** A comma-separated list of 1 to `count` IPv4 ranges for a setting, each between /16 and /`maxPrefix` (a runner subnet), no repeats. */
function cidrList(key: string, value: unknown, count: number, maxPrefix: number): string[] {
  if (typeof value !== "string") throw new Error(`${key} must be a comma-separated string of IPv4 ranges`);
  const items = [...new Set(value.split(",").map((part) => part.trim()).filter((part) => part !== ""))];
  if (items.length < 1 || items.length > count) throw new Error(`${key} needs between 1 and ${count} ranges`);
  for (const item of items) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(item);
    const prefix = match === null ? Number.NaN : Number(match[5]);
    if (match === null || [match[1], match[2], match[3], match[4]].some((octet) => Number(octet) > 255) || !(prefix >= 16 && prefix <= maxPrefix)) throw new Error(`${key} entry ${JSON.stringify(item)} is not an IPv4 range between /16 and /${maxPrefix}`);
  }
  return items;
}

function publicNpmOf(value: unknown): boolean {
  if (value === undefined || value === false || value === "false" || value === 0 || value === "0" || value === "") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  throw new Error(`${KEYS.publicNpm} must be true or false`);
}

function stdioOf(value: unknown): boolean {
  if (value === undefined || value === false || value === "false" || value === 0 || value === "0" || value === "") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  throw new Error(`${KEYS.stdio} must be true or false`);
}

/**
 * Reads and checks the settings. Outside an Enterprise install none may be set (Public never carries a private network setting). `get` reads one CDK context key
 * (`(key) => app.node.tryGetContext(key)`).
 */
export function parsePrivateMcpContext(input: { edition: Edition | undefined; get: (key: string) => unknown; /** The install's network; default the production foundation's. */ vpcCidrs?: readonly string[]; /** The release flag. Default `STDIO_MCP_RELEASED`; a test passes the other value. */ stdioReleased?: boolean }): PrivateMcpInstall {
  const cidrsValue = input.get(KEYS.cidrs);
  const cidrsGiven = isSet(cidrsValue) && cidrsValue !== "";
  const stdioRequested = stdioOf(input.get(KEYS.stdio));
  const given = [KEYS.certificateArn, KEYS.hostName, KEYS.hostedZoneId, KEYS.npmRegistry, KEYS.publicNpm, KEYS.runnerSubnetCidrs, KEYS.runnerRoutes, KEYS.registryCidrs, KEYS.controllerTlsSecretArn, KEYS.controllerDnsNamespace, KEYS.controllerCa].filter((key) => isSet(input.get(key)));
  if ((cidrsGiven || given.length > 0 || stdioRequested) && input.edition !== "enterprise") {
    throw new Error(`the private MCP settings (${[...(cidrsGiven ? [KEYS.cidrs] : []), ...given, ...(stdioRequested ? [KEYS.stdio] : [])].join(", ")}) apply only to an Enterprise install (rovaraEdition=enterprise)`);
  }
  const released = input.stdioReleased ?? STDIO_MCP_RELEASED;
  if (stdioRequested && !released) {
    throw new Error(`${KEYS.stdio}: servers run from a package are switched off in this release; add a server that has an address instead (the MCP host is redesigned first, register ME-14)`);
  }

  let privateCidrs: string[] = [];
  if (cidrsGiven) {
    try {
      privateCidrs = parseEnterpriseEgressCidrs(cidrsValue);
    } catch (error) {
      // The shared parser names its own key; this setting has its own.
      throw new Error((error instanceof Error ? error.message : "is not valid").split(ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY).join(KEYS.cidrs), { cause: error });
    }
  }

  // A range that shares an address with the network Rovara runs in would let a test of a pasted address find the install's own services.
  const vpcCidrs = [...(input.vpcCidrs ?? [AGENTX_PRODUCTION_VPC_CIDR])];
  for (const cidr of privateCidrs) {
    if (vpcCidrs.some((own) => ipv4RangesOverlap(cidr, own))) throw new Error(`${KEYS.cidrs} entry ${JSON.stringify(cidr)} overlaps the network Rovara itself runs in (${vpcCidrs.join(", ")}); list the customer's own ranges only`);
  }
  const install: PrivateMcpInstall = { privateCidrs, stdioRequested, ...(privateCidrs.length === 0 ? {} : { vpcCidrs }) };
  const certificateArn = input.get(KEYS.certificateArn);
  if (isSet(certificateArn)) {
    if (typeof certificateArn !== "string" || !ACM_CERTIFICATE_ARN.test(certificateArn)) throw new Error(`${KEYS.certificateArn} must be the ARN of an ACM certificate (arn:aws:acm:<region>:<account>:certificate/<id>)`);
    install.certificateArn = certificateArn;
  }
  const hostName = input.get(KEYS.hostName);
  if (isSet(hostName)) {
    if (typeof hostName !== "string" || !DNS_NAME.test(hostName) || AWS_OWN_NAME.test(hostName)) throw new Error(`${KEYS.hostName} must be a DNS name of your own that the certificate is for (not an amazonaws.com name or an address)`);
    install.hostName = hostName;
  }
  const hostedZoneId = input.get(KEYS.hostedZoneId);
  if (isSet(hostedZoneId)) {
    if (typeof hostedZoneId !== "string" || !HOSTED_ZONE_ID.test(hostedZoneId)) throw new Error(`${KEYS.hostedZoneId} must be a Route 53 hosted zone id such as Z0123456789ABCDEFGHIJ`);
    install.hostedZoneId = hostedZoneId;
  }
  const npmRegistry = input.get(KEYS.npmRegistry);
  if (isSet(npmRegistry)) install.npmRegistry = parseNpmRegistry(npmRegistry);
  const publicNpm = input.get(KEYS.publicNpm);
  if (isSet(publicNpm) && publicNpmOf(publicNpm)) install.publicNpm = true;
  const runnerSubnets = input.get(KEYS.runnerSubnetCidrs);
  if (isSet(runnerSubnets)) install.runnerSubnetCidrs = cidrList(KEYS.runnerSubnetCidrs, runnerSubnets, 2, 26);
  const runnerRoutes = input.get(KEYS.runnerRoutes);
  if (isSet(runnerRoutes)) install.runnerRoutes = parseRunnerRoutes(runnerRoutes);
  const registryCidrs = input.get(KEYS.registryCidrs);
  if (isSet(registryCidrs)) {
    try {
      install.registryCidrs = parseEnterpriseEgressCidrs(registryCidrs);
    } catch (error) {
      // The shared parser names its own key; this setting has its own.
      throw new Error((error instanceof Error ? error.message : "is not valid").split(ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY).join(KEYS.registryCidrs), { cause: error });
    }
  }
  const tlsSecret = input.get(KEYS.controllerTlsSecretArn);
  if (isSet(tlsSecret)) {
    if (typeof tlsSecret !== "string" || !SECRET_ARN.test(tlsSecret)) throw new Error(`${KEYS.controllerTlsSecretArn} must be the ARN of a Secrets Manager secret (arn:aws:secretsmanager:<region>:<account>:secret:<name>) holding {"cert": ..., "key": ...}`);
    install.controllerTlsSecretArn = tlsSecret;
  }
  const namespace = input.get(KEYS.controllerDnsNamespace);
  if (isSet(namespace)) {
    if (typeof namespace !== "string" || !DNS_NAME.test(namespace) || AWS_OWN_NAME.test(namespace)) throw new Error(`${KEYS.controllerDnsNamespace} must be a private DNS name of your own, such as mcp.rovara.internal`);
    install.controllerDnsNamespace = namespace;
  }
  const ca = input.get(KEYS.controllerCa);
  if (isSet(ca)) {
    if (typeof ca !== "string" || !ca.startsWith("-----BEGIN CERTIFICATE-----") || Buffer.byteLength(ca) > 7_000 || /PRIVATE KEY/u.test(ca)) throw new Error(`${KEYS.controllerCa} must be one PEM certificate (the public certificate of your authority), at most 7000 bytes, and never a key`);
    install.controllerCa = ca;
  }
  // Package-run servers (only past the release flag) need every setting the host is built from: a missing one stops synth by name, here, not at deploy.
  if (stdioRequested) mcpHostPropsFromInstall(install);
  return install;
}

/** An https address with no credentials, query or fragment: the install task sends package requests there and nowhere else. */
/** The registry of an install that sets `rovaraMcpPublicNpm` and names none. */
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

export function parseNpmRegistry(value: unknown): string {
  const fail = (): never => { throw new Error(`${KEYS.npmRegistry} must be an https address without credentials, such as https://registry.corp.example.net/npm/`); };
  if (typeof value !== "string" || value.length > 2_000) return fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.hostname === "" || /^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname) || url.hostname.includes(":")) return fail();
  return url.href;
}

/** The environment variables the broker reads. Only what was set; package-run servers are never switched on from here. */
export function privateMcpBrokerEnvironment(install: PrivateMcpInstall): Record<string, string> {
  return {
    ...(install.privateCidrs.length === 0 ? {} : { ROVARA_PRIVATE_MCP_CIDRS: install.privateCidrs.join(","), ...(install.vpcCidrs === undefined || install.vpcCidrs.length === 0 ? {} : { ROVARA_VPC_CIDRS: install.vpcCidrs.join(",") }) }),
    // Only past the release flag, and only with a host name to reach it by (the broker refuses an address that is not https).
    ...(install.stdioRequested && install.hostName !== undefined ? { ROVARA_STDIO_MCP_SERVERS: "1", MCP_HOST_URL: `https://${install.hostName}` } : {}),
  };
}

/**
 * The part of `McpHostProps` that comes from the install's configuration. Whoever builds the host (it needs the network and the image) spreads this in. A missing setting stops
 * synth with its name: the host has no plain-HTTP mode.
 */
export function mcpHostPropsFromInstall(install: PrivateMcpInstall): {
  certificateArn: string; hostName: string; hostedZoneId: string; npmRegistry: string; runnerSubnetCidrs: string[]; registryEgressCidrs: string[]; controllerTlsSecretArn: string; controllerDnsNamespace: string;
  publicNpm?: boolean; controllerCaPem?: string; privateMcpCidrs: string[]; vpcCidrs: string[]; runnerRoutes?: Array<{ cidr: string; transitGatewayId?: string; vpcPeeringConnectionId?: string }>;
} {
  const { certificateArn, hostName, hostedZoneId, npmRegistry, runnerSubnetCidrs, registryCidrs, controllerTlsSecretArn, controllerDnsNamespace, controllerCa } = install;
  if (certificateArn === undefined) throw new Error(`the MCP host needs a certificate for its HTTPS listener: set ${KEYS.certificateArn}`);
  if (hostName === undefined) throw new Error(`the MCP host needs the DNS name its certificate is for: set ${KEYS.hostName}`);
  if (hostedZoneId === undefined) throw new Error(`the MCP host needs the Route 53 zone for its DNS name: set ${KEYS.hostedZoneId}`);
  const publicNpm = install.publicNpm === true;
  if (npmRegistry === undefined && !publicNpm) throw new Error(`package-run servers need your package registry (the install task has no internet): set ${KEYS.npmRegistry}, or fetch from public npm by setting ${KEYS.publicNpm}`);
  if (runnerSubnetCidrs === undefined) throw new Error(`package-run servers need ranges for their own subnets inside the network: set ${KEYS.runnerSubnetCidrs}`);
  if (publicNpm && registryCidrs !== undefined) throw new Error(`${KEYS.publicNpm} and ${KEYS.registryCidrs} are two ways to install; set one`);
  if (!publicNpm && registryCidrs === undefined) throw new Error(`package-run servers need the ranges your package registry is reached at: set ${KEYS.registryCidrs}`);
  if (controllerTlsSecretArn === undefined) throw new Error(`the MCP controller needs a certificate for the runner tasks to trust: set ${KEYS.controllerTlsSecretArn}`);
  if (controllerDnsNamespace === undefined) throw new Error(`the MCP controller needs a private DNS name: set ${KEYS.controllerDnsNamespace}`);
  if (install.privateCidrs.length === 0 || install.vpcCidrs === undefined) throw new Error(`package-run servers need ${KEYS.cidrs}: a server can only be given addresses inside your private ranges`);
  return {
    certificateArn, hostName, hostedZoneId, npmRegistry: npmRegistry ?? PUBLIC_NPM_REGISTRY, runnerSubnetCidrs, registryEgressCidrs: registryCidrs ?? [], controllerTlsSecretArn, controllerDnsNamespace,
    ...(publicNpm ? { publicNpm: true } : {}), ...(controllerCa === undefined ? {} : { controllerCaPem: controllerCa }), ...(install.runnerRoutes === undefined ? {} : { runnerRoutes: install.runnerRoutes }), privateMcpCidrs: install.privateCidrs, vpcCidrs: install.vpcCidrs,
  };
}

/** Stops synth for a released flag whose host stack is not part of the build: a broker must never point at a host that does not exist. */
export function assertStdioHostStackBuilt(install: PrivateMcpInstall, built: boolean = STDIO_MCP_HOST_STACK_BUILT): void {
  if (install.stdioRequested && !built) throw new Error(`${KEYS.stdio}: this build does not yet contain the MCP host's stack; the release that turns package-run servers on adds it (turn-on checklist, step 1)`);
}

/** The only variables an install's settings may add to the broker's environment. Anything else (a reserved variable such as the callback signing key) is refused, never overwritten. */
export const BROKER_ENVIRONMENT_KEYS = ["ROVARA_PRIVATE_MCP_CIDRS", "ROVARA_VPC_CIDRS", "ROVARA_CUSTOM_MODEL_ENDPOINTS", "ROVARA_MODEL_ENDPOINT_CIDRS", "ROVARA_PRIVATE_ADDRESS_CIDRS", "ROVARA_PRIVATE_ADDRESS_PORTS"] as const;
/** The two more a package-run install adds, allowed only past the release flag. */
export const STDIO_BROKER_ENVIRONMENT_KEYS = ["ROVARA_STDIO_MCP_SERVERS", "MCP_HOST_URL"] as const;

/** `environment`, if every name is on the list above (and, past the release flag, the two package-run ones); otherwise the first other name stops synth. */
export function checkedBrokerEnvironment(environment: Readonly<Record<string, string>> | undefined, stdioReleased: boolean = STDIO_MCP_RELEASED): Record<string, string> {
  const allowed: readonly string[] = stdioReleased ? [...BROKER_ENVIRONMENT_KEYS, ...STDIO_BROKER_ENVIRONMENT_KEYS] : BROKER_ENVIRONMENT_KEYS;
  for (const name of Object.keys(environment ?? {})) {
    if (!allowed.includes(name)) throw new Error(`the broker's environment variable ${JSON.stringify(name)} is not one an install setting may add (allowed: ${BROKER_ENVIRONMENT_KEYS.join(", ")})`);
  }
  return { ...environment };
}
