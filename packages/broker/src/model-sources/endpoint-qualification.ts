// N8 (Enterprise): a company's own model endpoint, such as an internal gateway or a private Bedrock-compatible endpoint. This file holds the pure parts of
// letting one be used: what "qualified" means, whether this install may have one at all, and the address check an Enterprise endpoint passes.
//
// An endpoint is used only when ALL of these hold at the moment of the call (routing.ts reads them; none is remembered from an earlier moment):
//   1. the install's edition has the `customModelEndpoint` feature (Enterprise) AND the operator switched custom endpoints on for this install;
//   2. its host is approved in the source's own egress item (the customer's admin approves on save, the normal path) and the firewall item is active;
//   3. it is QUALIFIED: a check passed for exactly these settings. The check is a probe call per declared model through the model proxy, so a model id the
//      endpoint does not serve fails it. The server stores the digest of the settings that passed; any later change leaves the digest stale.
// Anything missing, unreadable or stale is "not usable", never "usable".
import { isIP } from "node:net";
import { agentXError } from "@rovara-code/contracts";
import { featureEnabled, type EditionPolicy } from "@agentx/cloud-contracts";
import { isPublicAddress } from "@agentx/gateway";
import { cidrBlockListOf, isNeverCalledAddress, parseInstallCidrs } from "../connections/private-endpoints.js";
import { dnsResolveHost, type ResolveHost } from "../connections/endpoint-check.js";

export { endpointQualificationDigest, endpointQualified, type EndpointSource } from "./endpoint-digest.js";

/** The environment switch that turns custom model endpoints on for an install. Off unless exactly "1". */
export const CUSTOM_MODEL_ENDPOINTS_ENV = "ROVARA_CUSTOM_MODEL_ENDPOINTS";
/** The private ranges (comma separated CIDRs) in which an endpoint's host may resolve besides public addresses. Unset: public addresses only. */
export const MODEL_ENDPOINT_CIDRS_ENV = "ROVARA_MODEL_ENDPOINT_CIDRS";
/** The network Rovara itself runs in (the same variable the private MCP servers use): an endpoint may never resolve into it. */
export const ROVARA_VPC_CIDRS_ENV = "ROVARA_VPC_CIDRS";

/** Whether the edition has custom model endpoints. No policy (an install deployed before editions) is no. */
export function customEndpointsAllowed(policy: EditionPolicy | undefined): boolean {
  return policy !== undefined && featureEnabled(policy, "customModelEndpoint");
}

// ---- the address an Enterprise endpoint may resolve to

export interface EndpointAddressOptions {
  /** Private ranges an endpoint may resolve into (`ROVARA_MODEL_ENDPOINT_CIDRS`). None: public addresses only. */
  privateCidrs?: readonly string[] | undefined;
  /** Rovara's own network: never an endpoint's place. */
  rovaraCidrs?: readonly string[] | undefined;
  resolveHost?: ResolveHost | undefined;
}

const blockLists = new Map<string, ReturnType<typeof cidrBlockListOf>>();
/** The ranges as a block list, built once per distinct list. */
function blockListMemo(cidrs: readonly string[]): ReturnType<typeof cidrBlockListOf> {
  const key = cidrs.join(",");
  if (!blockLists.has(key)) blockLists.set(key, cidrBlockListOf(cidrs));
  return blockLists.get(key);
}

/**
 * The refusal (CONFIG_INVALID, text safe to show) for an endpoint whose host resolves where a model call must not go, or undefined when it may be used. Every address
 * the name gives is judged: the never-called list (this machine, link-local and metadata addresses, multicast and the IPv6 forms that carry an IPv4 address) and
 * Rovara's own network are refused whatever else is set; a public address passes; a private one passes only inside a range the operator set for model endpoints.
 * A name that cannot be looked up is a retryable refusal, never a pass.
 */
export async function checkModelEndpointHost(host: string, options: EndpointAddressOptions = {}): Promise<void> {
  const resolveHost = options.resolveHost ?? dnsResolveHost;
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "the endpoint host could not be looked up; try again");
  }
  if (addresses.length === 0) throw agentXError("CONFIG_INVALID", "the endpoint host did not resolve to any address");
  const own = options.rovaraCidrs === undefined || options.rovaraCidrs.length === 0 ? undefined : blockListMemo(options.rovaraCidrs);
  if (options.rovaraCidrs !== undefined && options.rovaraCidrs.length > 0 && own === undefined) throw agentXError("CONFIG_INVALID", "the endpoint host can't be checked on this install");
  const privateRanges = options.privateCidrs === undefined || options.privateCidrs.length === 0 ? undefined : blockListMemo(options.privateCidrs);
  if (options.privateCidrs !== undefined && options.privateCidrs.length > 0 && privateRanges === undefined) throw agentXError("CONFIG_INVALID", "the endpoint host can't be checked on this install");
  for (const address of addresses) {
    const family = isIP(address);
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)?.[1];
    const effective = mapped ?? address;
    const kind = family === 0 ? undefined : isIP(effective) === 4 ? "ipv4" : "ipv6";
    if (kind === undefined || isNeverCalledAddress(address) || own?.check(effective, kind) === true) throw agentXError("CONFIG_INVALID", "the endpoint host resolves to an address Rovara never calls");
    if (isPublicAddress(effective)) continue;
    if (privateRanges?.check(effective, kind) === true) continue;
    throw agentXError("CONFIG_INVALID", "the endpoint host resolves to a private address outside the ranges set for model endpoints on this install");
  }
}

/** The ranges from the environment, parsed once at wiring. A range that is not private, or that overlaps Rovara's own network, stops the install: never a silent widening. */
export function endpointRangesFromEnvironment(env: Record<string, string | undefined>): { privateCidrs: string[]; rovaraCidrs: string[] } {
  // Parsed once for the settings a process has: the same settings give the same answer (or the same error) without parsing again.
  const key = JSON.stringify([env[MODEL_ENDPOINT_CIDRS_ENV] ?? null, env[ROVARA_VPC_CIDRS_ENV] ?? null]);
  if (rangesMemo?.key === key) {
    if (rangesMemo.error !== undefined) throw rangesMemo.error;
    return rangesMemo.value!;
  }
  try {
    const value = parseEndpointRanges(env);
    rangesMemo = { key, value };
    return value;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("the endpoint ranges are not valid");
    rangesMemo = { key, error: failure };
    throw failure;
  }
}

let rangesMemo: { key: string; value?: { privateCidrs: string[]; rovaraCidrs: string[] }; error?: Error } | undefined;

function parseEndpointRanges(env: Record<string, string | undefined>): { privateCidrs: string[]; rovaraCidrs: string[] } {
  const rovaraCidrs = (env[ROVARA_VPC_CIDRS_ENV] ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  const privateCidrs = parseInstallCidrs(env[MODEL_ENDPOINT_CIDRS_ENV], rovaraCidrs, MODEL_ENDPOINT_CIDRS_ENV);
  if (privateCidrs.length > 0 && rovaraCidrs.length === 0) throw agentXError("CONFIG_INVALID", `${MODEL_ENDPOINT_CIDRS_ENV} needs ${ROVARA_VPC_CIDRS_ENV}, the network Rovara itself runs in, so that an overlap can be refused`);
  return { privateCidrs, rovaraCidrs };
}

/**
 * The checker the admin routes call with an endpoint's base URL (at save and at every check): https on the standard port with no user info, a DNS name rather than an
 * address literal, then `checkModelEndpointHost`. The routes have refused the shape already; this is the same rule where the host is resolved.
 */
export function modelEndpointChecker(options: EndpointAddressOptions = {}): (url: string) => Promise<void> {
  return async (value) => {
    let url: URL;
    try { url = new URL(value); } catch { throw agentXError("CONFIG_INVALID", "the endpoint is not a valid URL"); }
    if (url.protocol !== "https:") throw agentXError("CONFIG_INVALID", "the endpoint must use https");
    if (url.username !== "" || url.password !== "") throw agentXError("CONFIG_INVALID", "the endpoint must not carry a username or password");
    if (url.port !== "" && url.port !== "443") throw agentXError("CONFIG_INVALID", "the endpoint must use the standard https port");
    const host = url.hostname.toLowerCase();
    if (host.startsWith("[") || isIP(host) !== 0) throw agentXError("CONFIG_INVALID", "the endpoint host must be a DNS name, not an IP address");
    await checkModelEndpointHost(host, options);
  };
}

/**
 * What an install does with custom model endpoints, decided once at wiring: on only when the edition has the feature AND the operator set the switch. The checker is
 * built here so the ranges are read and validated once.
 */
export function modelEndpointInstall(env: Record<string, string | undefined>, policy: EditionPolicy | undefined, resolveHost?: ResolveHost): { enabled: false } | { enabled: true; checkEndpoint: (url: string) => Promise<void> } {
  if (!customEndpointsAllowed(policy) || env[CUSTOM_MODEL_ENDPOINTS_ENV] !== "1") return { enabled: false };
  const ranges = endpointRangesFromEnvironment(env);
  return { enabled: true, checkEndpoint: modelEndpointChecker({ ...ranges, ...(resolveHost === undefined ? {} : { resolveHost }) }) };
}
