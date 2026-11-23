import { viewerTime } from "../../../design/viewer-time.js";
// Sign-in clients (Hybrid 1, DEC 223): the apps and company logins that can sign people in to this company. Read only here: a client is made and changed in Rovara Code.
// Cloud passes the list through once Code serves it; until then the page says "not connected yet" (proposed route in api/admin-company.ts).
import { Link } from "react-router";
import { SIGN_IN_CLIENTS_PATH, isNotConnected, readSignInClients, type SignInClient } from "../../../api/admin-company.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { DataTable, type Column } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { useAdminRead } from "../models/read.js";
import { AdminSection, NotConnected } from "../parts.js";

const reader = { parse: readSignInClients };
const KINDS: Record<string, string> = { web: "Web app", cli: "Command line", slack: "Slack", oidc: "Company login", other: "Other" };
const when = (value: string | undefined) => { const at = value === undefined ? Number.NaN : Date.parse(value); return Number.isNaN(at) ? "Never" : viewerTime(new Date(at), { year: "numeric", month: "short", day: "numeric" }); };
const columns: readonly Column<SignInClient>[] = [
 { key: "name", title: "Client", render: client => <b><VisibleText text={client.name} /></b> },
 { key: "kind", title: "Kind", render: client => KINDS[client.kind] ?? "Other" },
 { key: "created", title: "Added", render: client => when(client.createdAt) },
 { key: "used", title: "Last used", render: client => when(client.lastUsedAt) },
];

export function SignInClientsScreen() {
 const { role } = useAdminContext(), read = useAdminRead("sign-in-clients", SIGN_IN_CLIENTS_PATH, reader);
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Sign-in clients" /><p role="alert">Only current company owners and admins can view sign-in clients.</p></section>;
 return <section><PageHeader focusOnMount title="Sign-in clients" description="The apps and company logins that can sign people in. A client is added or changed in Rovara Code." />
  {read.isPending ? <Skeleton label="Loading sign-in clients" />
   : read.isError ? (isNotConnected(read.error) ? <NotConnected what="Sign-in clients" />
     : <div role="alert" className="rv-banner rv-banner-danger"><span><b>{read.error instanceof ApiError && read.error.status === 403 ? "You don't have permission to view sign-in clients." : "Couldn't load sign-in clients."}</b></span><Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Try again</Button></div>)
   : read.data.length === 0 ? <p className="rv-muted">This company has no sign-in client of its own. People sign in through Rovara's own clients.</p>
   : <DataTable caption="Sign-in clients" columns={columns} rows={read.data} rowKey={client => client.clientId} />}
  <AdminSection title="Who may sign in"><p>A person joins the company only through an invite or a pre-approved email. <Link to="/app/admin/invites">Open Invites</Link> to add one.</p></AdminSection>
 </section>;
}
