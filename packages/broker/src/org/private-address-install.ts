// What the broker knows about its own install for the internal address list (owner decision 123).
//   - the network Rovara runs in: ROVARA_VPC_CIDRS when the install sets it (Enterprise private MCP and model endpoints, infra/lib/private-mcp.ts), else the production foundation's VPC (infra/lib/production-foundation.ts
//     AGENTX_PRODUCTION_VPC_CIDR; tests/contract/private-addresses.test.ts keeps the two equal). The model proxy's load balancer, its database, the VPC resolver and the broker's own network interfaces all live there.
//   - its own services: the model proxy's host (MODEL_PROXY_URL) and the control plane's host (CONTROL_PLANE_URL), when set.
//   - ranges other settings own (review M2): ROVARA_PRIVATE_MCP_CIDRS and ROVARA_MODEL_ENDPOINT_CIDRS. Those servers are reached through their own settings and guards, never opened to a task.
//   - where workers can go (review H1): ROVARA_PRIVATE_ADDRESS_CIDRS, the Enterprise install's routed private ranges (its enterpriseEgressCidrs), and ROVARA_PRIVATE_ADDRESS_PORTS, the ports the worker security group opens to
//     them (443 and the operator's rovaraPrivateAddressPorts; infra/lib/private-addresses.ts). An install without routed ranges (a hosted install) has nowhere private to go: the setting is not offered there.
// ASSUMPTION (documented in docs/enterprise/internal-addresses.md): an Enterprise install serves ONE company, so the peered or Transit Gateway ranges it routes to are that company's. A multi-company install would need
// per-company routed ranges before this setting could be offered on it.
// An entry inside the install's network or naming one of its services is refused here and at launch; the worker repeats the network check on resolved addresses with the VPC ranges it reads from its own instance metadata.
import type { PrivateAddressInstall } from "@agentx/cloud-contracts";

/** infra/lib/production-foundation.ts AGENTX_PRODUCTION_VPC_CIDR. */
export const INSTALL_VPC_CIDR_DEFAULT = "10.42.0.0/16";
export const PRIVATE_ADDRESS_CIDRS_ENV = "ROVARA_PRIVATE_ADDRESS_CIDRS";
export const PRIVATE_ADDRESS_PORTS_ENV = "ROVARA_PRIVATE_ADDRESS_PORTS";

const hostOf = (url: string | undefined): string[] => {
  if (url === undefined || url === "") return [];
  try { return [new URL(url).hostname.toLowerCase()]; } catch { return []; }
};
const listOf = (value: string | undefined): string[] => (value ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");

/** The install's network and its own services: the base both the route and a launch build on (a launch uses `privateAddressRouteInstallOf`, which adds the reserved and routed ranges and the open ports). */
export function privateAddressInstallOf(env: NodeJS.ProcessEnv = process.env): PrivateAddressInstall {
  const listed = listOf(env.ROVARA_VPC_CIDRS);
  return { vpcCidrs: listed.length > 0 ? listed : [INSTALL_VPC_CIDR_DEFAULT], serviceHosts: [...hostOf(env.MODEL_PROXY_URL), ...hostOf(env.CONTROL_PLANE_URL)] };
}

/**
 * The install as the route AND a launch see it (the Steps function is given the same settings, infra/lib/control-plane.ts), or undefined when it has no routed private ranges: the setting is then not offered, and a launch
 * sends no list (review L3). Reserved ranges and routed ranges apply to every entry at the route, at launch and (as the launch settings AGENTX_PRIVATE_ADDRESS_RESERVED_CIDRS and AGENTX_PRIVATE_ADDRESS_ROUTED_CIDRS) on
 * the worker. A port list that does not parse offers 443 only.
 */
export function privateAddressRouteInstallOf(env: NodeJS.ProcessEnv = process.env): PrivateAddressInstall | undefined {
  const routed = listOf(env[PRIVATE_ADDRESS_CIDRS_ENV]);
  if (routed.length === 0) return undefined;
  const ports = listOf(env[PRIVATE_ADDRESS_PORTS_ENV]).map(Number);
  const openPorts = ports.length > 0 && ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65_535) ? [...new Set([443, ...ports])].sort((a, b) => a - b) : [443];
  return { ...privateAddressInstallOf(env), reservedCidrs: [...listOf(env.ROVARA_PRIVATE_MCP_CIDRS), ...listOf(env.ROVARA_MODEL_ENDPOINT_CIDRS)], routedCidrs: routed, openPorts };
}
