// Internal addresses a company's tasks may reach (owner decision 123, review H1): which ports the worker security group opens toward an Enterprise install's routed private ranges, and what the broker is told.
//
// The worker security group allows outbound TCP 443 only (ec2-workers.ts `egressRules`; on Enterprise, 443 to the VPC and the `rovaraEnterpriseEgressCidrs` ranges). A package mirror on another port (Nexus on 8081,
// Artifactory on 8082) would time out however the sandbox wall is opened. The operator lists the extra ports once, at install: `-c rovaraPrivateAddressPorts=8081,8443`. Each becomes one egress rule per routed range
// (never toward the install's own VPC). Why a fixed list and not a group the broker edits when a list is approved: the broker gets no EC2 write permission at all (an approval can never widen a security group), the set
// of rules is bounded and visible in the template, and an admin's approval stays inside what the operator allowed. The cost: a new port needs the operator to redeploy; the route refuses an entry on a port that is not open
// and says so.
// The broker is told the routed ranges and the open ports (ROVARA_PRIVATE_ADDRESS_CIDRS, ROVARA_PRIVATE_ADDRESS_PORTS): an install without routed ranges (every hosted install) does not offer the setting at all.
import { ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY } from "./vpc-endpoints.js";

export const PRIVATE_ADDRESS_PORTS_CONTEXT_KEY = "rovaraPrivateAddressPorts";
/** At most this many extra ports: each one is one rule per routed range, and a security group holds 60 egress rules by default. */
export const PRIVATE_ADDRESS_PORTS_MAX = 8;
/** The security group's egress rule budget kept for these rules (the 443 rules, one per range, come first). */
const EGRESS_RULES_BUDGET = 50;

/** The extra ports (443 is always open), sorted and once each. Refused off Enterprise, without routed ranges, or when the rules would not fit. */
export function parsePrivateAddressPorts(value: unknown, install: { enterprise: boolean; routedCidrs: readonly string[] }): number[] {
  if (value === undefined || value === "") return [];
  if (!install.enterprise) throw new Error(`${PRIVATE_ADDRESS_PORTS_CONTEXT_KEY} is an Enterprise edition setting`);
  if (install.routedCidrs.length === 0) throw new Error(`${PRIVATE_ADDRESS_PORTS_CONTEXT_KEY} needs ${ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY}: workers can only reach internal addresses inside the routed ranges`);
  if (typeof value !== "string" || !/^[0-9]+(?:,[0-9]+)*$/u.test(value)) throw new Error(`${PRIVATE_ADDRESS_PORTS_CONTEXT_KEY} is a comma-separated list of ports, such as 8081,8443`);
  const ports = [...new Set(value.split(",").map(Number))].filter((port) => port !== 443).sort((a, b) => a - b);
  for (const port of ports) if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${PRIVATE_ADDRESS_PORTS_CONTEXT_KEY}: ${String(port)} is not a port`);
  if (ports.length > PRIVATE_ADDRESS_PORTS_MAX) throw new Error(`${PRIVATE_ADDRESS_PORTS_CONTEXT_KEY} holds at most ${String(PRIVATE_ADDRESS_PORTS_MAX)} ports`);
  if ((ports.length + 1) * install.routedCidrs.length + 1 > EGRESS_RULES_BUDGET) throw new Error(`${PRIVATE_ADDRESS_PORTS_CONTEXT_KEY}: ${String(ports.length)} ports to ${String(install.routedCidrs.length)} ranges would not fit the worker security group`);
  return ports;
}

/** What the broker is told: the routed ranges and the open ports, on an Enterprise install with routed ranges only. */
export function privateAddressBrokerEnvironment(install: { enterprise: boolean; routedCidrs: readonly string[]; ports: readonly number[] }): Record<string, string> {
  if (!install.enterprise || install.routedCidrs.length === 0) return {};
  return { ROVARA_PRIVATE_ADDRESS_CIDRS: install.routedCidrs.join(","), ROVARA_PRIVATE_ADDRESS_PORTS: [443, ...install.ports].join(",") };
}
