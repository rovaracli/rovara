import { createContext, useContext, type ReactNode } from "react";
import { useAdminContext } from "../admin/admin-context.js";
import { Notice } from "./parts.js";
import type { ReadScope } from "./read-model.js";

const Scope = createContext<ReadScope | undefined>(undefined);
export function useCompanyReadScope() {
 const scope = useContext(Scope);
 if (scope === undefined) throw new Error("Company read requires current administration access.");
 return scope;
}
/**
 * G1 SHIP: the rebuilt company pages are mounted inside the real admin area (AdminLayout), so their authority is the SAME one the pages they replace used:
 * AdminLayout's fresh /v1/app/me read (re-read on entry and window focus, every admin cache purged on loss). A background re-check (`checking`) keeps the page
 * mounted, so a half-typed rule or an open confirm survives a window refocus, but every action refuses to send while it is true.
 * A change of company, person or role remounts the whole page (the provider's key).
 */
export function ReadEntry({ children }: { children: ReactNode }) {
 const admin = useAdminContext();
 const role = admin.role;
 return <section className="rv-company-admin-read" aria-label="Company administration">
  {(role !== "owner" && role !== "admin") || admin.orgId === "" ? <Notice role="alert">Company administration is available to current company owners and admins.</Notice>
   : <Scope.Provider key={`${admin.orgId}:${admin.developerId}:${role}`} value={{ orgId: admin.orgId, personId: admin.developerId, company: admin.company, role, checking: admin.checking }}>{children}</Scope.Provider>}
 </section>;
}
