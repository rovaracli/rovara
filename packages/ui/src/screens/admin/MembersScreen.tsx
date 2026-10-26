import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { DataTable } from "../../design/DataTable.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useAdminContext } from "./AdminLayout.js";
const roleNames: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const methodNames: Record<string, string> = { cloud: "Rovara sign-in", github: "GitHub", slack: "Slack", oidc: "Organization sign-in" };
function joinedDate(value: string) { const date = new Date(value);return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Date unavailable"; }
export function MembersScreen() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), { orgId, developerId } = useAdminContext(), [params, setParams] = useSearchParams();
 const search = params.get("q") ?? "";
 const read = useQuery({ queryKey: ["admin", "members", orgId, developerId], queryFn: () => api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema), gcTime: 0 });
 const members = read.data?.members ?? [], term = search.trim().toLocaleLowerCase("en-US");
 const matches = members.filter(member => member.name.toLocaleLowerCase("en-US").includes(term));
 return <section><PageHeader focusOnMount title="People" description="Company membership and sign-in methods. Project access also depends on project roles." actions={<Link to={"/app/admin/people/roles" + (search ? "?q=" + encodeURIComponent(search) : "")}>Roles explained</Link>} />{read.isPending || read.isFetching ? <Skeleton label="Loading company members" /> : read.isError ? <div><p role="alert">Couldn't load company members. Try again.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <><p className="rv-muted rv-admin-note">Sign-in methods do not verify GitHub or Slack connection health.</p>{members.length === 0 ? <p>No company members were returned.</p> : <><div className="rv-field rv-admin-search"><label htmlFor="admin-member-search">Find in this member list</label><input id="admin-member-search" type="search" value={search} maxLength={200} onChange={event => { const next = event.target.value;setParams(next ? { q: next } : {}, { replace: true }); }} aria-describedby="admin-search-help" /><p id="admin-search-help" className="rv-muted">Search names in the loaded company member list.</p></div><p role="status" className="rv-muted">{matches.length} of {members.length} members</p>{matches.length === 0 ? <p>No matching members in this list.</p> : <DataTable caption="Company members" rows={matches} rowKey={member => member.developerId} columns={[
 { key: "name", title: "Person", render: member => <><VisibleText text={member.name} />{member.developerId === developerId && <span className="rv-muted"> (you)</span>}</> },
 { key: "role", title: "Company role", render: member => roleNames[member.role] ?? "Role unavailable" },
 { key: "methods", title: "Sign-in methods", render: member => member.identities.length === 0 ? "No linked methods returned" : member.identities.map(method => methodNames[method] ?? "Other sign-in method").join(", ") },
 { key: "joined", title: "Joined (UTC)", render: member => joinedDate(member.joinedAt) },
 ]} />}</>}</>}</section>;
}
