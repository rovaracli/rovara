// The scope an admin-area control acts in: the company, the person, their role, and whether that is being re-checked. The admin area gives it through its
// outlet; Project settings (guided onboarding PR 9, outside the admin area) gives the same scope through ProjectScopeContext, so the shared project controls
// (Archive, Restore) work in both places without loading the admin area.
import { createContext, useContext } from "react";
import { useOutletContext } from "react-router";

export interface AdminContext { orgId: string; company: string; developerId: string; role: "owner" | "admin" | "member"; checking: boolean }
export const ProjectScopeContext = createContext<AdminContext | undefined>(undefined);
export function useAdminContext(): AdminContext {
 const scoped = useContext(ProjectScopeContext), outlet = useOutletContext<AdminContext | undefined>(), scope = scoped ?? outlet;
 if (scope === undefined) throw new Error("An admin-area control was used outside the admin area and outside Project settings.");
 return scope;
}
