// "Set a monthly cap to use the model gateway": Cloud's company backend says (on `GET /v1/app/org/settings`, `modelGateway`) whether the model gateway will serve the
// company. It refuses a company with no monthly cap and Cloud picks no default amount, so Spending and the Overview say what to do and link to where the cap is set.
// Silent when Cloud has no company settings, does not say, or says the gateway is ready: this is a nudge, never an error.
import { useEffect } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GATEWAY_CAP_UNSET, GATEWAY_CAP_WORDS, ORG_SETTINGS_PATH, readSettingsReadiness, type GatewayReadiness } from "../../../api/admin-company.js";
import { useAppHost } from "../../../host.js";
import { Banner } from "../../../design/Banner.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";

/**
 * The readiness read, scoped like every admin read. It goes straight to the transport, not through the api client: a late 401 after the company or person
 * changed must never start a sign-in redirect for the new scope, and a refusal here is simply "nothing to say".
 */
export function useGatewayReadiness(): GatewayReadiness | undefined {
 const host = useAppHost(), query = useQueryClient(), { orgId, developerId, role } = useAdminContext(), key = ["admin", "lane-c", "gateway-readiness", orgId, developerId, role];
 useEffect(() => () => { void query.cancelQueries({ queryKey: key, exact: true }); query.removeQueries({ queryKey: key, exact: true }); }, [query, orgId, developerId, role]); // eslint-disable-line react-hooks/exhaustive-deps
 const read = useQuery({
  queryKey: key, gcTime: 0, retry: false, refetchOnWindowFocus: false,
  queryFn: async () => {
   const response = await host.transport.request({ method: "GET", path: ORG_SETTINGS_PATH });
   return response.status >= 200 && response.status < 300 ? (readSettingsReadiness(response.body) ?? null) : null;
  },
 });
 return read.data ?? undefined;
}

export function GatewayReadinessBanner({ readiness }: { readiness: GatewayReadiness | undefined }) {
 if (readiness === undefined || readiness.ready) return null;
 const known = readiness.reason === GATEWAY_CAP_UNSET;
 return <Banner tone="warning" title={known ? GATEWAY_CAP_WORDS : "The model gateway isn't ready for this company"} action={<Link className="rv-button rv-button-secondary" to={known ? "/app/admin/ai-spending" : "/app/admin/settings"}>{known ? "Set the monthly limit" : "Open Company settings"}</Link>}>
  <p>{known ? "Tasks can't use Rovara's model gateway until the company has a monthly limit. Rovara picks no amount for you." : <VisibleText text={readiness.message} />}</p>
 </Banner>;
}
