import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { visibleAdminGroups } from "./admin-nav.js";
import "./admin.css";
import { useAdminContext as scopedAdminContext, type AdminContext } from "./admin-context.js";
export function useAdminContext() { return scopedAdminContext(); }
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
 // Remembered once the page has been shown on a large screen: from then on a narrow window only hides it (see the return below); a phone that never had a large screen never mounts it, so reads that are not made on phones are still not made.
 const [wasLarge, setWasLarge] = useState(largeScreen);
 if (largeScreen && !wasLarge) setWasLarge(true);
 const location = useLocation();
 const modelOnly = /^\/app\/admin\/(?:ai-spending|models(?:\/[^/]+)?|agent-ai|learning-ai|second-review)\/?$/u.test(location.pathname);
 const supported = host.kind === "web" && (host.features.admin || modelOnly);
 // A cached navigation role is not authority to open the directory. Recheck on entry and window focus.
 const identity = useQuery({ queryKey: ["admin", "identity"], queryFn: () => api.get("/v1/app/me", AppMeResponseReaderSchema), enabled: supported, staleTime: 0, gcTime: 0, refetchOnMount: "always" });
 const state = location.state as { roleChange?: { orgId?: string; developerId?: string; role?: string } } | null;
 const receipt = state?.roleChange;
 const ownReceipt = identity.isSuccess && receipt?.orgId === identity.data?.org.orgId && receipt?.developerId === identity.data?.developer.id && receipt?.role === identity.data?.developer.orgRole && receipt?.role === "member";
 const role = identity.data?.developer.orgRole;
 // Lane C: the permitted waiting queue is also available to ordinary members.
 const companyAdmin = role === "owner" || role === "admin";
 const waitingOnly = location.pathname === "/app/admin/waiting" && role === "member";
 const allowed = supported && identity.isSuccess && (companyAdmin || waitingOnly || (modelOnly && role === "member"));
 useEffect(() => {
  // Access lost (or not yet proven): drop the whole admin cache area, lane B project data included. Only the identity check that decides access is kept, or this purge would cancel the recheck itself.
  if (!allowed || (modelOnly && !companyAdmin)) { const adminData = { queryKey: ["admin"], predicate: (entry: { queryKey: readonly unknown[] }) => entry.queryKey[1] !== "identity" }; void query.cancelQueries(adminData); query.removeQueries(adminData); }
 }, [allowed, modelOnly, companyAdmin, query]);
 if (supported && identity.isPending) return <section className="rv-admin-plain" aria-label="Administration access" aria-busy="true"><Skeleton label="Checking administration access" /></section>;
 if (!allowed || identity.data === undefined) return <section className="rv-admin-plain"><PageHeader focusOnMount title="Administration unavailable" /><p>Administration is available to company owners and admins in the web app.</p>{identity.isSuccess && role === "member" && <OwnRoleReceipt key={`${location.pathname}:${identity.data.org.orgId}:${identity.data.developer.id}`} initial={ownReceipt} />}<NavLink to="/app">Go to Home</NavLink>{supported && identity.isError && <><p role="alert">{identity.dataUpdatedAt > 0 ? "Couldn't re-check your administration access. Try again." : "Couldn't verify your administration access. Try again."}</p><Button onClick={() => { void identity.refetch(); }}>Try again</Button></>}</section>;
 const outlet = <Outlet context={{ orgId: identity.data.org.orgId, company: identity.data.org.name, developerId: identity.data.developer.id, role, checking: identity.isFetching } satisfies AdminContext} />;
 // A member reaches only the read-only model card, without the admin menu; owners and admins keep the full layout.
 if (modelOnly && !companyAdmin) return <div className="rv-admin-surface">{outlet}</div>;
 const groups = visibleAdminGroups(role === "owner" || role === "admin" ? role : "member", true);
 // A window that gets narrow after the page was shown (or a screenshot tool that briefly makes it narrow) must not unmount the page: the layout stays mounted, only hidden, so an
 // open dialog, a picker or a half-typed form keeps its state, and the message shows beside it. Access is decided above: losing it still leaves the page.
 if (!largeScreen && !wasLarge) return <section className="rv-admin-plain" data-testid="admin-narrow"><PageHeader focusOnMount title="Administration" /><p>Open this on a larger screen to use it. <NavLink to="/app">Go to Home</NavLink></p></section>;
 return <>{!largeScreen && <section className="rv-admin-plain" data-testid="admin-narrow"><PageHeader focusOnMount title="Administration" /><p>Open this on a larger screen to use it. <NavLink to="/app">Go to Home</NavLink></p></section>}<div className="rv-admin" hidden={!largeScreen} aria-busy={identity.isFetching}><nav aria-label="Administration" className="rv-admin-nav"><p className="rv-admin-context">Administration · <VisibleText text={identity.data.org.name} /></p>{companyAdmin && <NavLink to="/app/admin" end>Overview</NavLink>}{groups.map(group => <section key={group.id} aria-labelledby={`rv-admin-group-${group.id}`}><h2 id={`rv-admin-group-${group.id}`}>{group.title}</h2>{group.links.map(link => <NavLink key={link.to} to={link.to}>{link.label}</NavLink>)}</section>)}</nav><div className="rv-admin-surface"><Outlet context={{ orgId: identity.data.org.orgId, company: identity.data.org.name, developerId: identity.data.developer.id, role, checking: identity.isFetching } satisfies AdminContext} /></div></div></>;
}
