// ME-13 (wire lane C): the install's private MCP settings at synth. They arrive as CDK context (`-c name=value`), only in an Enterprise install, and reach the broker as the
// environment variables it reads at start (packages/broker/src/context-sources/install.ts).
//
//   rovaraPrivateMcpCidrs          comma-separated private ranges outside which no private MCP server is tested or called -> ROVARA_PRIVATE_MCP_CIDRS
//   rovaraStdioMcpServers          package-run servers. OFF: asking for them stops synth until the MCP host is redesigned (register ME-14)
//   rovaraMcpHostCertificateArn    the ACM certificate of the MCP host's HTTPS listener (McpHost refuses to be built without one)
//   rovaraMcpHostName, rovaraMcpHostedZoneId   the DNS name the certificate is for, and the Route 53 zone the alias record goes in
//
// No certificate, name or range is written into the code: each comes from the install's own configuration. Every wrong value stops synth, naming its setting and never echoing a secret.
import type { Edition } from "@agentx/contracts";
import { AGENTX_PRODUCTION_VPC_CIDR } from "./production-foundation.js";
import { ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY, parseEnterpriseEgressCidrs } from "./vpc-endpoints.js";

export const PRIVATE_MCP_CONTEXT_KEYS = {
  cidrs: "rovaraPrivateMcpCidrs",
  stdio: "rovaraStdioMcpServers",
  certificateArn: "rovaraMcpHostCertificateArn",
  hostName: "rovaraMcpHostName",
  hostedZoneId: "rovaraMcpHostedZoneId",
  npmRegistry: "rovaraMcpNpmRegistry",
} as const;
const KEYS = PRIVATE_MCP_CONTEXT_KEYS;

export interface PrivateMcpInstall {
  /** Private ranges for ROVARA_PRIVATE_MCP_CIDRS. Empty: every private server is refused (fail closed). */
  privateCidrs: string[];
  /** The network Rovara itself runs in, given to the broker (`ROVARA_VPC_CIDRS`) so it refuses the same overlap and never tests or calls an address inside it. Set with `privateCidrs`. */
  vpcCidrs?: string[];
  /** Always false in a result: asking for package-run servers stops synth. Kept in the type so a later release can lift the refusal in one place. */
  stdioRequested: boolean;
  certificateArn?: string;
  hostName?: string;
  hostedZoneId?: string;
  /** The package registry (normalised, https, no credentials). Only recorded: it reaches the controller when package-run servers are on. */
  npmRegistry?: string;
}

const ACM_CERTIFICATE_ARN = /^arn:aws(?:-[a-z]+)*:acm:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:certificate\/[0-9A-Za-z-]+$/u;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u;
const AWS_OWN_NAME = /(?:^|\.)amazonaws\.com$/u;
const HOSTED_ZONE_ID = /^Z[0-9A-Z]{1,31}$/u;

const isSet = (value: unknown): boolean => value !== undefined;

/** Whether two IPv4 ranges share an address (ranges nest, so: one contains the other's first address). A range that does not parse overlaps everything. */
function ipv4RangesOverlap(a: string, b: string): boolean {
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

function stdioOf(value: unknown): boolean {
  if (value === undefined || value === false || value === "false" || value === 0 || value === "0" || value === "") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  throw new Error(`${KEYS.stdio} must be true or false`);
}

/**
 * Reads and checks the settings. Outside an Enterprise install none may be set (Public never carries a private network setting). `get` reads one CDK context key
 * (`(key) => app.node.tryGetContext(key)`).
 */
export function parsePrivateMcpContext(input: { edition: Edition | undefined; get: (key: string) => unknown; /** The install's network; default the production foundation's. */ vpcCidrs?: readonly string[] }): PrivateMcpInstall {
  const cidrsValue = input.get(KEYS.cidrs);
  const cidrsGiven = isSet(cidrsValue) && cidrsValue !== "";
  const stdioRequested = stdioOf(input.get(KEYS.stdio));
  const given = [KEYS.certificateArn, KEYS.hostName, KEYS.hostedZoneId, KEYS.npmRegistry].filter((key) => isSet(input.get(key)));
  if ((cidrsGiven || given.length > 0 || stdioRequested) && input.edition !== "enterprise") {
    throw new Error(`the private MCP settings (${[...(cidrsGiven ? [KEYS.cidrs] : []), ...given, ...(stdioRequested ? [KEYS.stdio] : [])].join(", ")}) apply only to an Enterprise install (rovaraEdition=enterprise)`);
  }
  if (stdioRequested) {
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
  const install: PrivateMcpInstall = { privateCidrs, stdioRequested: false, ...(privateCidrs.length === 0 ? {} : { vpcCidrs }) };
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
  return install;
}

/** An https address with no credentials, query or fragment: the install task sends package requests there and nowhere else. */
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
  return install.privateCidrs.length === 0 ? {} : { ROVARA_PRIVATE_MCP_CIDRS: install.privateCidrs.join(","), ...(install.vpcCidrs === undefined || install.vpcCidrs.length === 0 ? {} : { ROVARA_VPC_CIDRS: install.vpcCidrs.join(",") }) };
}

/**
 * The part of `McpHostProps` that comes from the install's configuration. Whoever builds the host (it needs the network and the image) spreads this in. A missing setting stops
 * synth with its name: the host has no plain-HTTP mode.
 */
export function mcpHostPropsFromInstall(install: PrivateMcpInstall): { certificateArn: string; hostName: string; hostedZoneId: string; npmRegistry: string } {
  const { certificateArn, hostName, hostedZoneId, npmRegistry } = install;
  if (certificateArn === undefined) throw new Error(`the MCP host needs a certificate for its HTTPS listener: set ${KEYS.certificateArn}`);
  if (hostName === undefined) throw new Error(`the MCP host needs the DNS name its certificate is for: set ${KEYS.hostName}`);
  if (hostedZoneId === undefined) throw new Error(`the MCP host needs the Route 53 zone for its DNS name: set ${KEYS.hostedZoneId}`);
  if (npmRegistry === undefined) throw new Error(`package-run servers need your package registry (the install task has no internet): set ${KEYS.npmRegistry}`);
  return { certificateArn, hostName, hostedZoneId, npmRegistry };
}

/** The only variables an install's settings may add to the broker's environment. Anything else (a reserved variable such as the callback signing key) is refused, never overwritten. */
export const BROKER_ENVIRONMENT_KEYS = ["ROVARA_PRIVATE_MCP_CIDRS", "ROVARA_VPC_CIDRS"] as const;

/** `environment`, if every name is on the list above; otherwise the first other name stops synth. */
export function checkedBrokerEnvironment(environment: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const allowed: readonly string[] = BROKER_ENVIRONMENT_KEYS;
  for (const name of Object.keys(environment ?? {})) {
    if (!allowed.includes(name)) throw new Error(`the broker's environment variable ${JSON.stringify(name)} is not one an install setting may add (allowed: ${BROKER_ENVIRONMENT_KEYS.join(", ")})`);
  }
  return { ...environment };
}
