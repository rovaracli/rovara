import { createElement as h, type ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
// UX3 item 4: every settings page opens with SettingsNote, which reads the admin layout's outlet context (company, role).
// Screens rendered on their own need the same context; this is a MemoryRouter whose single route supplies it.
export const adminContext = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: "a".repeat(64), role: "owner" as const, checking: false };
export function AdminRouter({ children }: { children?: ReactNode }) {
 return h(MemoryRouter, { children: h(Routes, { children: h(Route, { element: h(Outlet, { context: adminContext }), children: h(Route, { path: "*", element: children }) }) }) });
}
