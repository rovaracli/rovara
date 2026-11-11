import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OrgSlackWorkspaceEvidenceResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { useAdminContext } from "../AdminLayout.js";
import { checkedTime } from "../models/read.js";

const unavailable = "Slack workspace details aren't available here yet.";
/** Stored company associations only. Rollout and installed grants are verified by the release controller. */
export function SlackWorkspaceEvidence() {
 const { role } = useAdminContext();
 return role === "owner" || role === "admin" ? <SlackWorkspaceEvidenceRead /> : <p>{unavailable}</p>;
}
/** The stored Slack associations of this company, read once per page (admin only). The Connections page and the evidence panel share it. */
export function useSlackEvidence() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const { orgId, developerId, role } = useAdminContext();
 const key = useMemo(() => ["admin", "lane-c", "slack-workspace-evidence", orgId, developerId, role], [orgId, developerId, role]);
 const reader = useMemo(() => OrgSlackWorkspaceEvidenceResponseReaderSchema.refine(value => value.orgId === orgId), [orgId]);
 useEffect(() => () => { void query.cancelQueries({ queryKey: key, exact: true });query.removeQueries({ queryKey: key, exact: true }); }, [query, key]);
 return useQuery({ queryKey: key, queryFn: async () => {
  try { return await api.get("/v1/app/org/slack-workspace-evidence", reader); }
  catch (error) {
   // Do not retain server/vendor messages in the query cache, even when rendering fixed copy.
   throw new ApiError(error instanceof ApiError ? error.status : 0, error instanceof ApiError && error.code === "INVALID_RESPONSE" ? "INVALID_RESPONSE" : "REQUEST_FAILED", unavailable);
  }
 }, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
function SlackWorkspaceEvidenceRead() {
 const read = useSlackEvidence();
 const refused = read.error instanceof ApiError && ([401, 403, 404, 503].includes(read.error.status) || read.error.code === "INVALID_RESPONSE");
 const data = !refused ? read.data : undefined;
 return <section aria-label="Slack workspace details" aria-busy={read.isFetching}>
 <h3>Stored workspace associations</h3>
 {read.isPending ? <Skeleton label="Loading Slack workspace details" /> : <>
 {read.isError && <p role="alert">{data === undefined ? unavailable : "Stored Slack evidence is stale. Refresh failed; try again."}</p>}
 {data !== undefined && <>
 <p>{data.associationCount} stored associations observed in this read.</p>
 <p>{data.coverage === "partial" ? "Coverage: Partial. Counts are observations, not company totals." : "Coverage: Complete for this bounded read."}</p>
 {data.unavailableCount > 0 && <p>{data.unavailableCount} examined {data.unavailableCount === 1 ? "association could" : "associations could"} not be used.</p>}
 {data.associationCount === 0 && <p>No matching stored associations were observed. This does not mean Slack is uninstalled.</p>}
 <p>Current Slack health: Unverified.</p>
 <p>Observed at {checkedTime(data.checkedAt)}. This is not an atomic configuration snapshot.</p>
 <p>Installation, permissions, channel bindings and delivery remain unknown.</p>
 </>}
 </>}
 <Button aria-disabled={read.isFetching} onClick={() => { if (!read.isFetching) void read.refetch({ cancelRefetch: false }); }}>Refresh Slack workspace details</Button>
 </section>;
}
