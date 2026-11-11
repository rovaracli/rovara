import { useEffect, useId, useMemo, useRef, useState } from "react";
import { SettingsNote } from "./SettingsNote.js";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { DataTable } from "../../design/DataTable.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useAdminContext } from "./AdminLayout.js";
import { RoleChangeDialog } from "./RoleChangeDialog.js";
import { RemoveMemberDialog } from "./RemoveMemberDialog.js";
const roleNames: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", auditor: "Auditor" };
const methodNames: Record<string, string> = { cloud: "Rovara sign-in", github: "GitHub", slack: "Slack", oidc: "Organization sign-in" };
type Role = "owner" | "admin" | "member";
type Receipt = { scope: string; focus: boolean } & ({ kind: "verified"; person: string; role: Role; checkedAt: string } | { kind: "denied" });
function joinedDate(value: string) { const date = new Date(value);return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Date unavailable"; }
export function MembersScreen() {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const { orgId, developerId, company, role, checking } = useAdminContext(), [params, setParams] = useSearchParams(), navigate = useNavigate();
 const [removalReceipt, setRemovalReceipt] = useState<string>(), [receipt, setReceipt] = useState<Receipt>(), receiptElement = useRef<HTMLParagraphElement>(null), reasonId = useId();
 const scope = `${orgId}:${developerId}`, search = params.get("q") ?? "";
 useEffect(() => () => { const key = ["admin", "members", orgId, developerId];void query.cancelQueries({ queryKey: key, exact: true });query.removeQueries({ queryKey: key, exact: true }); }, [query, orgId, developerId]);
 useEffect(() => {
  if (receipt?.focus && receipt.scope === scope && role === "admin") { const timer = setTimeout(() => { receiptElement.current?.focus(); }, 0);return () => { clearTimeout(timer); }; }
 }, [receipt, role, scope]);
 const read = useQuery({ queryKey: ["admin", "members", orgId, developerId], queryFn: async () => {
  const response = await api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema);
  return { members: response.members.map(member => ({ developerId: member.developerId, name: member.name, role: member.role, ...(member.joinedAt === undefined ? {} : { joinedAt: member.joinedAt }), ...(member.identities === undefined ? {} : { identities: member.identities }) })) };
 }, gcTime: 0 });
 const forbiddenRead = read.error instanceof ApiError && ([401, 403, 404].includes(read.error.status) || read.error.code === "INVALID_RESPONSE");
 const dataStale = read.isError && read.data !== undefined && !forbiddenRead, fatal = read.isError && !dataStale;
 const members = read.data?.members ?? [], term = search.trim().toLocaleLowerCase("en-US"), matches = members.filter(member => member.name.toLocaleLowerCase("en-US").includes(term));
 const accessChecking = checking || read.isFetching;
 function action(member: (typeof members)[number]) {
  if (member.role === "unknown") return "Role unavailable";
  // The Auditor is set by the company sign-in mapping or by an owner through the API; this screen does not change it.
  if (member.role === "auditor") return "Set outside this screen";
  return <RoleChangeDialog key={`${scope}:${role}:${member.developerId}`} company={company} member={{ developerId: member.developerId, name: member.name, role: member.role }} self={member.developerId === developerId} ownerCount={members.filter(person => person.role === "owner").length} checking={accessChecking} staleData={dataStale} checkingReasonId={reasonId}
   verify={async () => { const result = await read.refetch({ throwOnError: true });const actual = result.data?.members.find(person => person.developerId === member.developerId)?.role;return actual === "owner" || actual === "admin" || actual === "member" ? actual : undefined; }}
   onDenied={() => { void query.invalidateQueries({ queryKey: ["admin", "identity"] }).then(() => { setReceipt({ scope, focus: true, kind: "denied" }); });void query.invalidateQueries({ queryKey: ["nav"] }); }}
   onApplied={next => {
    setReceipt({ scope, focus: member.developerId === developerId && next === "admin", kind: "verified", person: member.name, role: next, checkedAt: new Date().toISOString() });
    if (member.developerId === developerId) { if (next === "member") { void navigate("/app/admin", { state: { roleChange: { orgId, developerId, role: next } } }); }void query.invalidateQueries({ queryKey: ["admin", "identity"] });void query.invalidateQueries({ queryKey: ["nav"] }); }
   }} />;
 }
 function removeAction(member: (typeof members)[number]) {
  if (member.developerId === developerId) return <span className="rv-muted">You</span>;
  if (member.role === "unknown") return "Role unavailable";
  if (role === "admin" && member.role !== "member") return <span className="rv-muted">Owners only</span>;
  const others = members.filter(person => person.developerId !== member.developerId).map(person => ({ developerId: person.developerId, name: person.name }));
  return <RemoveMemberDialog key={`${scope}:${role}:remove:${member.developerId}`} company={company} member={{ developerId: member.developerId, name: member.name, role: member.role }} self={{ developerId, name: members.find(person => person.developerId === developerId)?.name ?? "you" }} people={others} checking={accessChecking} staleData={dataStale} checkingReasonId={reasonId}
   onDenied={() => { void query.invalidateQueries({ queryKey: ["admin", "identity"] });void query.invalidateQueries({ queryKey: ["nav"] }); }}
   onRemoved={text => { setRemovalReceipt(text);void read.refetch(); }} />;
 }
 return <section aria-busy={read.isFetching}>
  {!fatal && removalReceipt !== undefined && <p role="status">{removalReceipt}</p>}
  {!fatal && receipt?.scope === scope && <p ref={receiptElement} tabIndex={-1} role="status">{receipt.kind === "denied" ? "Role change refused. Company access was checked again." : <><VisibleText text={`${receipt.person}: company role verified: ${roleNames[receipt.role]}.`} /> Checked at <time dateTime={receipt.checkedAt}>{new Date(receipt.checkedAt).toLocaleString("en-US", { timeZone: "UTC" })}</time> UTC.</>}</p>}
  <PageHeader focusOnMount title="People" description="Company membership and sign-in methods. Project access also depends on project roles." actions={<Link to={"/app/admin/people/roles" + (search ? "?q=" + encodeURIComponent(search) : "")}>Roles explained</Link>} /><SettingsNote area="people" />
  {read.isPending ? <Skeleton label="Loading company members" /> : fatal ? <div><p role="alert">{read.error instanceof ApiError && read.error.status === 403 ? "You don't have permission to view company members." : "Couldn't load company members. Try again."}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <>
   {read.data !== undefined && (accessChecking || dataStale) && <p id={reasonId} role={dataStale ? "alert" : "status"}>{dataStale ? "Member list is stale. Changes are disabled until a successful check." : "Checking company access..."}</p>}
   {dataStale && <Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Retry member list</Button>}
   <p className="rv-muted rv-admin-note">Sign-in methods do not verify GitHub or Slack connection health.</p>
   {members.length === 0 ? <p>No company members were returned.</p> : <>
    <div className="rv-field rv-admin-search"><label htmlFor="admin-member-search">Find in this member list</label><input id="admin-member-search" type="search" value={search} maxLength={200} onChange={event => { const next = event.target.value;setParams(next ? { q: next } : {}, { replace: true }); }} aria-describedby="admin-search-help" /><p id="admin-search-help" className="rv-muted">Search names in the loaded company member list.</p></div>
    <p role="status" className="rv-muted">{matches.length} of {members.length} members</p>
    {matches.length === 0 ? <p>No matching members in this list.</p> : <DataTable caption="Company members" rows={matches} rowKey={member => member.developerId} columns={[
     { key: "name", title: "Person", render: member => <><VisibleText text={member.name} />{member.developerId === developerId && <span className="rv-muted"> (you)</span>}</> },
     { key: "role", title: "Company role", render: member => roleNames[member.role] ?? "Role unavailable" },
     { key: "methods", title: "Sign-in methods", render: member => member.identities === undefined ? "Unavailable" : member.identities.length === 0 ? "None returned" : member.identities.map(method => methodNames[method] ?? "Other sign-in method").join(", ") },
     { key: "joined", title: "Joined (UTC)", render: member => member.joinedAt === undefined ? "Date unavailable" : joinedDate(member.joinedAt) },
     ...(role === "owner" ? [{ key: "action", title: "Role action", render: action }] : []),
     ...(role === "owner" || role === "admin" ? [{ key: "remove", title: "Remove", render: removeAction }] : []),
    ]} />}
   </>}
  </>}
 </section>;
}
