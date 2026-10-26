import { useEffect, useMemo, useSyncExternalStore } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./admin.css";
interface AdminContext { orgId: string; company: string; developerId: string; role: "owner" | "admin" }
export function useAdminContext() { return useOutletContext<AdminContext>(); }
const narrowViewport = () => false;
export function AdminLayout() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const viewport = useMemo(() => ({ subscribe: (listener: () => void) => host.viewport?.subscribe(listener) ?? (() => undefined), snapshot: () => (host.viewport?.width() ?? 0) >= 1024 }), [host]);
 const largeScreen = useSyncExternalStore(viewport.subscribe, viewport.snapshot, narrowViewport);
 const supported = host.kind === "web" && host.features.admin;
 // A cached navigation role is not authority to open the directory. Recheck on entry and window focus.
 const identity = useQuery({ queryKey: ["admin", "identity"], queryFn: () => api.get("/v1/app/me", AppMeResponseReaderSchema), enabled: supported, staleTime: 0, gcTime: 0, refetchOnMount: "always" });
 const role = identity.data?.developer.orgRole;
 const allowed = supported && identity.isSuccess && (role === "owner" || role === "admin");
 useEffect(() => {
  if (!allowed) { void query.cancelQueries({ queryKey: ["admin", "members"] });query.removeQueries({ queryKey: ["admin", "members"] }); }
 }, [allowed, query]);
 if (supported && identity.isPending) return <section aria-label="Administration access" aria-busy="true"><Skeleton label="Checking administration access" /></section>;
 if (!allowed || identity.data === undefined) return <section><PageHeader focusOnMount title="Administration unavailable" /><p>Administration is available to company owners and admins in the web app.</p>{supported && identity.isError && <><p role="alert">{identity.dataUpdatedAt > 0 ? "Couldn't re-check your administration access. Try again." : "Couldn't verify your administration access. Try again."}</p><Button onClick={() => { void identity.refetch(); }}>Try again</Button></>}</section>;
 if (!largeScreen) return <section><PageHeader focusOnMount title="Administration" /><p>Open this on a larger screen to use it. <NavLink to="/app">Go to Home</NavLink></p></section>;
 return <div className="rv-admin" aria-busy={identity.isFetching}><p className="rv-admin-context">Administration · <VisibleText text={identity.data.org.name} /></p><div className="rv-admin-content"><nav aria-label="Administration" className="rv-admin-nav"><NavLink to="/app/admin" end>Overview</NavLink><NavLink to="/app/admin/people">People</NavLink></nav><div className="rv-admin-surface"><Outlet context={{ orgId: identity.data.org.orgId, company: identity.data.org.name, developerId: identity.data.developer.id, role } satisfies AdminContext} /></div></div></div>;
}
