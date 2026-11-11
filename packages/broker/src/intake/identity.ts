// Slice 5 "Outside tools": who a Linear or Jira account is, for intake. Only a link the company already holds counts: the tracker links of the Team record (`team-record/identity-links.ts`), made at
// connect or sign-in, by an email the tracker reported as VERIFIED, or by a company admin on the Tracker people page. Nothing here reads a name or an email from the ticket, and nothing guesses: an
// account with no link has no member, and its ticket waits with the reason `unlinked`.
//
// A Jira account id is unique per Atlassian site, and the links are kept per site (`jira:<host>`). The site is the host of the ticket's own link, which must be an Atlassian site (`*.atlassian.net`):
// a link anywhere else names no site, so no member.
import type { OrgId } from "@rovara-code/contracts";
import { developerOfTrackerAuthor } from "../team-record/identity-links.js";
import type { TeamRecordTable } from "../team-record/types.js";

export type TrackerAccountResolver = (orgId: OrgId, accountId: string, ticketUrl?: string) => Promise<string | undefined>;

const ATLASSIAN_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/u;

/** The Atlassian site of a ticket's link (`acme.atlassian.net`), or undefined for any other link. */
export function jiraSiteOf(ticketUrl: string | undefined): string | undefined {
  if (ticketUrl === undefined) return undefined;
  try {
    const url = new URL(ticketUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && ATLASSIAN_HOST.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The resolvers of the trackers other than GitHub, over the company's tracker links. Each answers the linked member's id or undefined; the caller checks the member is live. */
export function trackerAccountResolvers(links: TeamRecordTable): Readonly<Record<string, TrackerAccountResolver>> {
  return {
    linear: async (orgId, accountId) => developerOfTrackerAuthor(links, orgId, { system: "linear", sourceId: accountId }),
    jira: async (orgId, accountId, ticketUrl) => {
      const site = jiraSiteOf(ticketUrl);
      return site === undefined ? undefined : developerOfTrackerAuthor(links, orgId, { system: `jira:${site}`, sourceId: accountId });
    },
  };
}
