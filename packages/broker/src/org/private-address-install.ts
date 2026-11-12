// What the broker knows about its own install for the internal address list (owner decision 123): the network Rovara runs in and the host names of its own services. An entry inside that network or naming one of
// those services is refused at the route and at launch; the worker repeats the network check on resolved addresses with the VPC ranges it reads from its own instance metadata, which is the authority.
//   - the network: ROVARA_VPC_CIDRS when the install sets it (Enterprise private MCP and model endpoints, infra/lib/private-mcp.ts), else the production foundation's VPC (infra/lib/production-foundation.ts
//     AGENTX_PRODUCTION_VPC_CIDR; tests/contract/private-addresses.test.ts keeps the two equal). The model proxy's load balancer, its database, the VPC resolver and the broker's own network interfaces all live there.
//   - the services: the model proxy's host (MODEL_PROXY_URL) and the control plane's host (CONTROL_PLANE_URL), when set.
import type { PrivateAddressInstall } from "@agentx/cloud-contracts";

/** infra/lib/production-foundation.ts AGENTX_PRODUCTION_VPC_CIDR. */
export const INSTALL_VPC_CIDR_DEFAULT = "10.42.0.0/16";

const hostOf = (url: string | undefined): string[] => {
  if (url === undefined || url === "") return [];
  try { return [new URL(url).hostname.toLowerCase()]; } catch { return []; }
};

export function privateAddressInstallOf(env: NodeJS.ProcessEnv = process.env): PrivateAddressInstall {
  const listed = (env.ROVARA_VPC_CIDRS ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  return { vpcCidrs: listed.length > 0 ? listed : [INSTALL_VPC_CIDR_DEFAULT], serviceHosts: [...hostOf(env.MODEL_PROXY_URL), ...hostOf(env.CONTROL_PLANE_URL)] };
}
