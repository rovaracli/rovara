// Company domain verification: the port the tracker linking reads (team-record/tracker-autolink.ts). The domains it gives are the company's VERIFIED ones only (a pending or lost domain, or one another
// company holds, is not in it), each in its stored form, so a person's email domain is compared after `normalizeEmailDomain`.
import type { OrgId } from "@rovara-code/contracts";
import type { VerifiedDomainsPort } from "../../team-record/tracker-autolink.js";
import { listEntries, type CompanyDomainDeps } from "./store.js";

export function companyDomainsPort(deps: Pick<CompanyDomainDeps, "documentClient" | "tableName"> & { now?: () => number }): VerifiedDomainsPort {
  return {
    async domainsOf(orgId: OrgId) {
      const entries = await listEntries({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now ?? Date.now }, orgId);
      return new Set(entries.filter((entry) => entry.holder?.state === "verified").map((entry) => entry.own.domain));
    },
  };
}
