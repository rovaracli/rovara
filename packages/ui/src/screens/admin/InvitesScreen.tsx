import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppOrgInvitesResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { DataTable } from "../../design/DataTable.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useAdminContext } from "./AdminLayout.js";
function utc(value: string) { return new Date(value).toLocaleString("en-US", { timeZone: "UTC" }); }
export function InvitesScreen() {
 const { orgId, developerId } = useAdminContext();
 return <InviteDirectory key={`${orgId}:${developerId}`} orgId={orgId} developerId={developerId} />;
}
function InviteDirectory({ orgId, developerId }: { orgId: string; developerId: string }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient(), { checking } = useAdminContext();
 const [cursors, setCursors] = useState<string[]>([]), pageFocus = useRef(false), summary = useRef<HTMLParagraphElement>(null), cursor = cursors.at(-1);
 useEffect(() => () => { const key = ["admin", "invites", orgId, developerId];void query.cancelQueries({ queryKey: key });query.removeQueries({ queryKey: key }); }, [query, orgId, developerId]);
 const read = useQuery({ queryKey: ["admin", "invites", orgId, developerId, cursor ?? "first"], gcTime: 0, refetchOnWindowFocus: false, queryFn: async () => {
  const response = await api.get("/v1/app/org/invites?limit=25" + (cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor)), AppOrgInvitesResponseReaderSchema);
  const unavailableCount = response.unavailableCount ?? 0;
  if ((response.coverage !== "indexed_only" && response.coverage !== "indexed_only_partial") || (response.coverage === "indexed_only_partial") !== (unavailableCount > 0)) throw new ApiError(502, "INVALID_RESPONSE", "Invite coverage could not be verified.");
  return { unavailableCount, checkedAt: response.checkedAt, nextCursor: response.nextCursor, invites: response.invites.map(invite => ({ inviteId: invite.inviteId, role: invite.role, createdAt: invite.createdAt, expiresAt: invite.expiresAt, destination: invite.destination.kind === "link" ? { kind: "link" as const } : invite.destination.kind === "email" && typeof invite.destination.label === "string" ? { kind: "email" as const, label: invite.destination.label } : { kind: "unknown" as const } })) };
 } });
 useEffect(() => { if (pageFocus.current && read.isSuccess && !read.isFetching) { summary.current?.focus();pageFocus.current = false; } }, [cursor, read.isSuccess, read.isFetching]);
 const terminal = read.error instanceof ApiError && ([401, 403, 404].includes(read.error.status) || read.error.code === "INVALID_RESPONSE");
 const stale = read.isError && read.data !== undefined && !terminal, hidden = read.isError && !stale;
 const locked = checking || read.isFetching || read.isError, nextCursor = read.data?.nextCursor;
 const errorCopy = read.error instanceof ApiError && read.error.status === 403 ? "You don't have permission to view company invites." : read.error instanceof ApiError && read.error.status === 429 ? "Too many invite checks. Wait a minute before retrying." : "Couldn't check invites. Try again. If this keeps happening, ask an installation administrator to check the invite directory.";
 return <section aria-busy={read.isFetching}>
  <PageHeader focusOnMount title="Invites" description="Pending invites in this directory. Destinations are masked." actions={<Button aria-disabled={locked} onClick={() => { if (!locked) void read.refetch(); }}>Refresh invites</Button>} />
  <p className="rv-admin-note">Older invite links may still exist outside this directory. An empty page does not mean there are no pending invites.</p>
  <p className="rv-muted">This directory is read-only. Creating or revoking invites is not available here.</p>
  {checking && <p role="status">Checking company access...</p>}{!checking && read.isFetching && read.data !== undefined && <p role="status">Checking invites...</p>}
  {read.isPending ? <Skeleton label="Loading company invites" /> : <>
   {read.isError && <div><p role="alert">{stale && "Invite list is stale. "}{errorCopy}</p><Button disabled={read.isFetching || checking} onClick={() => { void read.refetch(); }}>Retry invites</Button></div>}
   {!hidden && read.data !== undefined && <>
    {read.data.unavailableCount > 0 && <p role="alert">{read.data.unavailableCount} invite {read.data.unavailableCount === 1 ? "entry" : "entries"} could not be checked. Ask an installation administrator to review the directory. These results are incomplete.</p>}
    <p ref={summary} tabIndex={-1} role="status">Page {cursors.length + 1}: {read.data.invites.length}{read.data.unavailableCount > 0 ? " confirmed pending invites shown." : " pending invites on this page."} Checked at <time dateTime={read.data.checkedAt}>{utc(read.data.checkedAt)}</time> UTC.</p>
    {read.data.invites.length === 0 ? <p>{read.data.unavailableCount > 0 ? "No usable invites on this page." : "No pending invites on this page."}</p> : <DataTable caption="Pending invites on this page" rows={read.data.invites} rowKey={invite => invite.inviteId} columns={[
     { key: "destination", title: "Destination", render: invite => invite.destination.kind === "link" ? "Invite link" : invite.destination.kind === "email" ? <VisibleText text={invite.destination.label} /> : "Destination unavailable" },
     { key: "role", title: "Company role", render: invite => invite.role === "admin" ? "Admin" : invite.role === "member" ? "Member" : "Role unavailable" },
     { key: "created", title: "Created (UTC)", render: invite => <time dateTime={invite.createdAt}>{utc(invite.createdAt)}</time> },
     { key: "expires", title: "Expires (UTC)", render: invite => <time dateTime={invite.expiresAt}>{utc(invite.expiresAt)}</time> },
    ]} />}
    <div className="rv-admin-role-actions"><Button disabled={cursors.length === 0} aria-disabled={locked || cursors.length === 0} onClick={() => { if (locked) return;setCursors(old => old.slice(0, -1));pageFocus.current = true; }}>Previous page</Button><Button disabled={nextCursor === undefined} aria-disabled={locked || nextCursor === undefined} onClick={() => { if (!locked && nextCursor !== undefined) { setCursors(old => [...old, nextCursor]);pageFocus.current = true; } }}>Next page</Button></div>
   </>}
  </>}
 </section>;
}
