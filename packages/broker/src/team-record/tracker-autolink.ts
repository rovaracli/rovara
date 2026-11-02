// Opt-in automatic tracker linking (owner, 2026-11-02, lane team-record-links). A company owner or admin can turn on a switch, OFF by default, that links a Linear or Jira user to a company member by themselves, and only
// when ALL THREE hold for that person:
//   1. the domain of the person's email is one the company has VERIFIED for its Rovara sign-in (`VerifiedDomainsPort`). Where the company has no such list, this is never true: nothing is guessed from members' emails;
//   2. the tool account is company-controlled: a Jira account the company manages (not readable with the connection Rovara has: recorded as UNAVAILABLE, so no Jira person links), or a Linear workspace that enforces
//      the company's SAML sign-in, and the person is never a guest;
//   3. the email equals, normalised and case-insensitive, the verified sign-in email of a member of the SAME company (`linkTrackerByVerifiedEmail`).
// Everyone else is listed for the admin to map by hand, with the first reason they were not linked (a fixed code, shown on the page). Turning the switch off stops new automatic links; links already made stay until
// an admin unmaps them.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type OrgId } from "@agentx/contracts";
import { normalizeEmailDomain } from "../org/company-domains/normalize.js";
import type { TeamRecordTable } from "./types.js";

/** The domains a company has verified for its Rovara sign-in. `undefined`: the company has none recorded (nothing is guessed). */
export interface VerifiedDomainsPort {
  domainsOf(orgId: OrgId): Promise<ReadonlySet<string> | undefined>;
}

export type CompanyControl = "yes" | "no" | "unavailable";

/** The fixed codes for why a person was or was not linked automatically. The admin page turns each into words. */
export const AUTOLINK_REASONS = [
  "switch_off", "no_email", "no_verified_domains", "domain_not_verified", "guest", "company_control_unavailable", "not_company_controlled", "unmapped_by_admin", "no_matching_member",
] as const;
export type AutoLinkReason = (typeof AUTOLINK_REASONS)[number];
/** The code a linked person carries. */
export const AUTOLINK_LINKED_WHY = "domain_company_account_exact_email";

export interface AutoLinkFacts {
  enabled: boolean;
  email: string | undefined;
  /** `undefined`: the company has no verified domains recorded. */
  domains: ReadonlySet<string> | undefined;
  guest: boolean;
  control: CompanyControl;
  suppressed: boolean;
}

/** The domain of an email in the stored form of a company domain (lower-case, punycode), or undefined when it is none, or is an IP address, a public suffix or a lookalike. */
export const emailDomain = (email: string): string | undefined => email.includes("@") ? normalizeEmailDomain(email.trim()) : undefined;

/** Conditions 1 and 2, and the switch, in order; the first that fails is the reason. `undefined` means conditions 1 and 2 hold: the exact-member match (3) is the next step. */
export function autoLinkRefusal(facts: AutoLinkFacts): AutoLinkReason | undefined {
  if (!facts.enabled) return "switch_off";
  if (facts.email === undefined || facts.email.trim() === "") return "no_email";
  if (facts.domains === undefined || facts.domains.size === 0) return "no_verified_domains";
  const domain = emailDomain(facts.email);
  if (domain === undefined || !facts.domains.has(domain)) return "domain_not_verified";
  if (facts.guest) return "guest";
  if (facts.control === "unavailable") return "company_control_unavailable";
  if (facts.control === "no") return "not_company_controlled";
  if (facts.suppressed) return "unmapped_by_admin";
  return undefined;
}

// ---- the switch (one small item in the org's record partition; absent means off)

const settingKey = (orgId: OrgId): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: "TRAUTOLINK" });

export async function autoLinkEnabled(table: TeamRecordTable, orgId: OrgId): Promise<boolean> {
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: settingKey(orgId), ConsistentRead: true }))) as { Item?: { enabled?: unknown } }).Item;
  return item?.enabled === true;
}

export async function setAutoLinkEnabled(table: TeamRecordTable, orgId: OrgId, input: { enabled: boolean; by: string; at: string }): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...settingKey(orgId), entityType: "TEAM_RECORD_AUTOLINK_SETTING", orgId, enabled: input.enabled, changedBy: input.by, at: input.at } }));
}
