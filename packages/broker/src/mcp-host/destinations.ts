// Stdio MCP host redesign (T7), design section 7: the destinations an admin approves for a package-run server ("this server talks to jira.corp.example:443"), resolved and checked with
// the same rules the HTTP private servers use. The result is what the server's security group allows, as /32 addresses; nothing else is reachable.
//
//   - each address must be inside ROVARA_PRIVATE_MCP_CIDRS (no ranges set: every destination is refused);
//   - none may be on the never-called list (this machine, link-local and metadata addresses, multicast, the IPv6 forms that carry an IPv4 address);
//   - none may be inside the network Rovara itself runs in (ROVARA_VPC_CIDRS);
//   - IPv4 only (the runner subnets have no IPv6 rule to allow), and a name that resolves to no IPv4 address is refused.
import { isIP } from "node:net";
import type { ResolvedDestination } from "@agentx/gateway";
import { cidrBlockListOf, isNeverCalledAddress } from "../connections/private-endpoints.js";
import { dnsResolveHost, type ResolveHost } from "../connections/endpoint-check.js";

/** A destination that is not allowed. The message is one fixed sentence: no address or name is in it. */
export class DestinationRefused extends Error {
  constructor() {
    super("This address is outside the ranges your install allows.");
    this.name = "DestinationRefused";
  }
}

export function destinationResolver(options: { installCidrs: readonly string[]; rovaraCidrs?: readonly string[] | undefined; resolveHost?: ResolveHost | undefined }): (destinations: ReadonlyArray<{ host: string; port: number }>) => Promise<ResolvedDestination[]> {
  const resolveHost = options.resolveHost ?? dnsResolveHost;
  // No ranges, or a range that does not parse, is a refusal: a name is never trusted to resolve inside the network.
  const allowed = options.installCidrs.length === 0 ? undefined : cidrBlockListOf(options.installCidrs);
  const rovara = options.rovaraCidrs === undefined || options.rovaraCidrs.length === 0 ? undefined : cidrBlockListOf(options.rovaraCidrs);
  if (options.rovaraCidrs !== undefined && options.rovaraCidrs.length > 0 && rovara === undefined) throw new Error("ROVARA_VPC_CIDRS does not parse");
  return async (destinations) => {
    const resolved: ResolvedDestination[] = [];
    for (const destination of destinations) {
      let addresses: readonly string[];
      try { addresses = isIP(destination.host) === 4 ? [destination.host] : await resolveHost(destination.host); } catch { throw new DestinationRefused(); }
      const v4 = [...new Set(addresses)].filter((address) => isIP(address) === 4);
      // An address of another family cannot be allowed, so a name that has one is judged by all of its answers: any that is never-called refuses the destination.
      if (v4.length === 0 || allowed === undefined || addresses.some((address) => isNeverCalledAddress(address))) throw new DestinationRefused();
      if (!v4.every((address) => allowed.check(address, "ipv4") && !(rovara?.check(address, "ipv4") ?? false))) throw new DestinationRefused();
      resolved.push({ host: destination.host, port: destination.port, addresses: v4 });
    }
    return resolved;
  };
}
