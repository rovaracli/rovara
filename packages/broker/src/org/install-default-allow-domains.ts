import { installDefaultAllowDomains, narrowedDefaultAllowDomains } from "@agentx/cloud-contracts";

/**
 * The names every project may already reach on this install, as the DNS firewall has them (the same function builds both, hosted-allow-domains.ts): the default list without
 * its broad entries plus the install's own regional AWS hosts. A Lambda's AWS_REGION names the install's region.
 */
export const installDefaultDomains = (): string[] => installDefaultAllowDomains(process.env.AWS_REGION);

/**
 * The list a person is shown as "allowed for every project": the default list without its broad entries, not the platform's own regional AWS service names (nobody asks for those).
 */
export const shownDefaultDomains = (): string[] => narrowedDefaultAllowDomains();
