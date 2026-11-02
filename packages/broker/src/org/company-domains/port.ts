// Company domain verification: the port the tracker linking reads (team-record/tracker-autolink.ts). The domains it gives are the company's VERIFIED ones only (a pending or lost domain, or one another
// company holds, is not in it), each in its stored form, so a person's email domain is compared after `normalizeEmailDomain`.
import type { OrgId } from "@agentx/contracts";
import type { VerifiedDomainsPort } from "../../team-record/tracker-autolink.js";
import { listClaims, type CompanyDomainDeps } from "./store.js";

export function companyDomainsPort(deps: Pick<CompanyDomainDeps, "documentClient" | "tableName"> & { now?: () => number }): VerifiedDomainsPort {
  return {
    async domainsOf(orgId: OrgId) {
      const claims = await listClaims({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now ?? Date.now }, orgId);
      return new Set(claims.filter((claim) => claim.state === "verified").map((claim) => claim.domain));
    },
  };
}
