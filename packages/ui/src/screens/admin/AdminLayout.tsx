import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet, useOutletContext, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { SECOND_REVIEW_PATH } from "../../api/second-review.js";
import { APPROVAL_WINDOW_PATH } from "../../api/approval-window.js";
import { PRIVATE_ADDRESSES_PATH } from "../../api/private-addresses.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isBillingV2On } from "../../billing-flags.js";
import { AdminNav } from "./AdminNav.js";
import "./admin.css";
/** Whether the second opinion page exists on this install, asked once per session and kept, and asked again when the scope (company, person, role) changes. */
const secondReviewProbeKey = ["second-review-probe"] as const;
/** The same question for the recent sign-in window page: the server answers its read with 404 while it is not turned on, and the link is then not shown. */
const approvalWindowProbeKey = ["approval-window-probe"] as const;
/** The same question for internal addresses: the server answers its read with 404 on an install with no route to a private network (every hosted install), and the link is then not shown. */
const privateAddressesProbeKey = ["private-addresses-probe"] as const;
interface AdminContext { orgId: string; company: string; developerId: string; role: "owner" | "admin" | "member"; checking: boolean; approvalWindowOff: boolean; privateAddressesOff: boolean }
export function useAdminContext() { return useOutletContext<AdminContext>(); }
// UX3: company settings work on a phone. A narrow screen only changes how the menu and the tables are laid out; it never hides a setting.
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
 // The second opinion page exists only while the install's `cr` switch is on: with it off the broker answers the page's read with 404, as for any unknown path, and the link is not shown. (There is no per-page flag in
 // the host's features for it, so the read itself is the switch.) The answer is asked once per session and kept (its own key, outside the admin cache that is purged when access is lost): entering the admin area again does not
 // ask again, and switching `cr` on while the app is open shows the link after a reload. Any other answer, an error included, keeps the link: the page then says what is wrong.
 // The probe goes straight to the transport, not through the api client: a probe answering 401 must never start a sign-in redirect (the page's own reads do that). When the company, person or role changes, the probe is reset, and
 // an answer that arrives after that is dropped, never read for the new scope.
 const scope = identity.data === undefined ? undefined : `${identity.data.org.orgId}:${identity.data.developer.id}:${identity.data.developer.orgRole}`;
 const scopeNow = useRef(scope), scopeSeen = useRef(scope);
 useEffect(() => {
  scopeNow.current = scope;
  if (scope !== undefined && scopeSeen.current !== undefined && scopeSeen.current !== scope) { void query.resetQueries({ queryKey: secondReviewProbeKey });void query.resetQueries({ queryKey: approvalWindowProbeKey });void query.resetQueries({ queryKey: privateAddressesProbeKey }); }
  if (scope !== undefined) scopeSeen.current = scope;
 }, [scope, query]);
 const secondReview = useQuery({
  queryKey: secondReviewProbeKey, enabled: supported && identity.isSuccess && (identity.data?.developer.orgRole === "owner" || identity.data?.developer.orgRole === "admin"), staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, retry: false,
  queryFn: async () => { const asked = scope; const response = await host.transport.request({ method: "GET", path: SECOND_REVIEW_PATH }); if (scopeNow.current !== asked) throw new Error("The scope changed."); return response.status !== 404; },
 });
 const approvalWindow = useQuery({
  queryKey: approvalWindowProbeKey, enabled: supported && identity.isSuccess && (identity.data?.developer.orgRole === "owner" || identity.data?.developer.orgRole === "admin"), staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, retry: false,
  queryFn: async () => { const asked = scope; const response = await host.transport.request({ method: "GET", path: APPROVAL_WINDOW_PATH }); if (scopeNow.current !== asked) throw new Error("The scope changed."); return response.status !== 404; },
 });
 const privateAddresses = useQuery({
  queryKey: privateAddressesProbeKey, enabled: supported && identity.isSuccess && (identity.data?.developer.orgRole === "owner" || identity.data?.developer.orgRole === "admin"), staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, retry: false,
  queryFn: async () => { const asked = scope; const response = await host.transport.request({ method: "GET", path: PRIVATE_ADDRESSES_PATH }); if (scopeNow.current !== asked) throw new Error("The scope changed."); return response.status !== 404; },
 });
 const secondReviewOff = secondReview.data === false, approvalWindowOff = approvalWindow.data === false, privateAddressesOff = privateAddresses.data === false;
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
 return <div className="rv-admin" aria-busy={identity.isFetching}><p className="rv-admin-context">Company settings · <VisibleText text={identity.data.org.name} /></p><div className="rv-admin-content"><AdminNav role={role} secondReviewOff={secondReviewOff} companyAdmin={companyAdmin} compact={!largeScreen} billingOn={isBillingV2On(host)} approvalWindowOff={approvalWindowOff} privateAddressesOff={privateAddressesOff} /><div className="rv-admin-surface"><Outlet context={{ orgId: identity.data.org.orgId, company: identity.data.org.name, developerId: identity.data.developer.id, role, checking: identity.isFetching, approvalWindowOff, privateAddressesOff } satisfies AdminContext} /></div></div></div>;
}
