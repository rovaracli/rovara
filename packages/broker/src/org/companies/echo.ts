// Company memberships (srv/company-memberships; briefs/company-memberships-api.md section 4): the `x-rovara-company` response header on every browser answer while the switch `cw` is on. It names the company the
// request was answered in (the session's active company when the request came in), which the web app compares with the company the page is in (ui/src/api/company-context.ts). Never another company's id.
import { COMPANY_REQUEST_HEADER } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";

export function withCompanyEcho<Reply extends { headers: Record<string, string> }>(reply: Reply, orgId: OrgId): Reply {
  return { ...reply, headers: { ...reply.headers, [COMPANY_REQUEST_HEADER]: orgId } };
}
