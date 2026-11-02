import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet, useOutletContext, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./admin.css";
interface AdminContext { orgId: string; company: string; developerId: string; role: "owner" | "admin" | "member"; checking: boolean }
export function useAdminContext() { return useOutletContext<AdminContext>(); }
const narrowViewport = () => false;
function OwnRoleReceipt({ initial }: { initial: boolean }) {
 const [show] = useState(initial), location = useLocation(), navigate = useNavigate();
 const state = location.state as { roleChange?: unknown } | null;
 useEffect(() => { if (show && state?.roleChange !== undefined) { void navigate(location.pathname + location.search + location.hash, { replace: true, state: null }); } }, [show, state, navigate, location.pathname, location.search, location.hash]);
 return show ? <p role="status">Your company role is now Member. Administration access has ended.</p> : null;
}

export function AdminLayout() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const viewport = useMemo(() => ({ subscribe: (listener: () => void) => host.viewport?.subscribe(listener) ?? (() => undefined), snapshot: () => (host.viewport?.width() ?? 0) >= 1024 }), [host]);
 const largeScreen = useSyncExternalStore(viewport.subscribe, viewport.snapshot, narrowViewport);
 const supported = host.kind === "web" && host.features.admin;
 // A cached navigation role is not authority to open the directory. Recheck on entry and window focus.
 const identity = useQuery({ queryKey: ["admin", "identity"], queryFn: () => api.get("/v1/app/me", AppMeResponseReaderSchema), enabled: supported, staleTime: 0, gcTime: 0, refetchOnMount: "always" });
 const location = useLocation();
 const state = location.state as { roleChange?: { orgId?: string; developerId?: string; role?: string } } | null;
 const receipt = state?.roleChange;
 const ownReceipt = identity.isSuccess && receipt?.orgId === identity.data?.org.orgId && receipt?.developerId === identity.data?.developer.id && receipt?.role === identity.data?.developer.orgRole && receipt?.role === "member";
 const role = identity.data?.developer.orgRole;
 // Lane C: the permitted waiting queue is also available to ordinary members.
 const companyAdmin = role === "owner" || role === "admin";
 const waitingOnly = location.pathname === "/app/admin/waiting" && role === "member";
 const allowed = supported && identity.isSuccess && (companyAdmin || waitingOnly);
 useEffect(() => {
  // Access lost (or not yet proven): drop the whole admin cache area, lane B project data included. Only the identity check that decides access is kept, or this purge would cancel the recheck itself.
  if (!allowed) { const adminData = { queryKey: ["admin"], predicate: (entry: { queryKey: readonly unknown[] }) => entry.queryKey[1] !== "identity" }; void query.cancelQueries(adminData); query.removeQueries(adminData); }
 }, [allowed, query]);
 if (supported && identity.isPending) return <section aria-label="Administration access" aria-busy="true"><Skeleton label="Checking administration access" /></section>;
 if (!allowed || identity.data === undefined) return <section><PageHeader focusOnMount title="Administration unavailable" /><p>Administration is available to company owners and admins in the web app.</p>{identity.isSuccess && role === "member" && <OwnRoleReceipt key={`${location.pathname}:${identity.data.org.orgId}:${identity.data.developer.id}`} initial={ownReceipt} />}<NavLink to="/app">Go to Home</NavLink>{supported && identity.isError && <><p role="alert">{identity.dataUpdatedAt > 0 ? "Couldn't re-check your administration access. Try again." : "Couldn't verify your administration access. Try again."}</p><Button onClick={() => { void identity.refetch(); }}>Try again</Button></>}</section>;
 if (!largeScreen) return <section><PageHeader focusOnMount title="Administration" /><p>Open this on a larger screen to use it. <NavLink to="/app">Go to Home</NavLink></p></section>;
 return <div className="rv-admin" aria-busy={identity.isFetching}><p className="rv-admin-context">Administration · <VisibleText text={identity.data.org.name} /></p><div className="rv-admin-content"><nav aria-label="Administration" className="rv-admin-nav">{companyAdmin && <><NavLink to="/app/admin" end>Overview</NavLink><NavLink to="/app/admin/people">People</NavLink><NavLink to="/app/admin/invites">Invites</NavLink><NavLink to="/app/admin/money/budgets">Spending</NavLink>{/* Lane B: project settings; Agents screens stay held (no nav, no route). */}<NavLink to="/app/admin/projects">Projects</NavLink>{/* Lane C: read-only areas. */}<NavLink to="/app/admin/models/sources">AI models</NavLink><NavLink to="/app/admin/connections">Connections</NavLink><NavLink to="/app/admin/tracker-people">Tracker people</NavLink>{/* Lane C2: company audit, owner/admin gate retained. */}<NavLink to="/app/admin/audit">Audit</NavLink>{/* Company domain verification: owner only (the page and the routes refuse an admin). */}{role === "owner" && <NavLink to="/app/admin/domains">Company domains</NavLink>}</>}<NavLink to="/app/admin/waiting">Waiting for people</NavLink></nav><div className="rv-admin-surface"><Outlet context={{ orgId: identity.data.org.orgId, company: identity.data.org.name, developerId: identity.data.developer.id, role, checking: identity.isFetching } satisfies AdminContext} /></div></div></div>;
}
