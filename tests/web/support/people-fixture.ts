// Fixtures for the project People tab, the collaborator approvals switch and the product decisions panel (lane exp/project-people): the project page mounted with the server's answers for
// `GET .../people`, `.../code-settings`, `.../collaborator-approvals`, `.../product-decisions` and the company's people, and a hook for whatever a write answers.
import { vi } from "vitest";
import { act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../../packages/ui/src/screens/project/ProjectScreen.js";
import { PEOPLE_STORAGE_KEY } from "../../../packages/ui/src/people-flags.js";
import { AppHostProvider, type ApiRequest } from "../../../packages/ui/src/host.js";
import { Announcer } from "../../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import { renderUi } from "../support/render.js";
import { fakeHost } from "../support/fake-host.js";
import { h } from "../support/h.js";
import { projectFixture } from "../support/project-fixture.js";

export type Answer = { status: number; body: unknown };
export const ID = { maya: "a".repeat(64), priya: "b".repeat(64), sam: "c".repeat(64), lee: "d".repeat(64), ana: "e".repeat(64), admin: "f".repeat(64) };
export const member = (developerId: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({ developerId, name, role: role === "collaborator" ? "viewer" : role, projectRole: role, source: "grant", ...extra });
export const viewerPowers = (over: Record<string, unknown> = {}) => ({ role: "maintainer", canManageMembers: true, assignableRoles: ["maintainer", "contributor", "collaborator", "viewer"], canInvite: true, invitableRoles: ["maintainer", "contributor", "viewer"], canEditCodeSettings: true, canConfirmSelfApproval: false, ...over });
export const peopleView = (over: Record<string, unknown> = {}, power: Record<string, unknown> = {}) => ({
  project: "payments", revision: 7, viewer: viewerPowers(power),
  members: [member(ID.maya, "Maya Chen", "maintainer"), member(ID.priya, "Priya Rao", "collaborator"), member(ID.sam, "Sam Ortiz", "contributor"), member(ID.lee, "Lee Park", "viewer"), member(ID.admin, "Dana Admin", "maintainer", { source: "org_role" })], ...over });
export const settings = (over: Record<string, unknown> = {}) => ({ settings: { allowSelfApproval: false, mergeMethod: "squash", codeReviewers: ["acme/payments-team"], revision: 3, ...over } });
export const approvals = (over: Record<string, unknown> = {}) => ({ collaboratorApprovals: { enabled: true, revision: 2, isDefault: false, canChange: true, ...over } });
export const DECISION_ID = "pdq_" + "A".repeat(20);
export const decision = (over: Record<string, unknown> = {}) => ({ decisionId: DECISION_ID, taskId: "11111111-1111-4111-8111-111111111111", project: "payments", question: "Which wording should the refund button use?", options: [{ id: "o1", label: "Refund now" }, { id: "o2", label: "Request a refund" }], risk: "low", status: "open", revision: 4, raisedAt: "2026-11-10T10:00:00.000Z", answers: [], you: { canAnswer: true, canApprove: true }, ...over });

/**
 * Waits until every lazy chunk the page asked for has loaded and rendered: the dynamic imports have settled, a few macrotask turns have passed, and (only as a backstop) a short wait. A test that says a screen is NOT there
 * must call this first, or it can pass because the chunk was merely late.
 */
export async function settleLazy(backstopMs = 20): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => { await vi.dynamicImportSettled();await new Promise(resolve => setTimeout(resolve, 0)); });
  if (backstopMs > 0) await act(async () => { await new Promise(resolve => setTimeout(resolve, backstopMs)); });
}

export interface Options {
  on?: boolean; path?: string; people?: Answer; settings?: Answer; approvals?: Answer; decisions?: Answer; members?: Answer; orgRole?: "owner" | "admin" | "member";
  /** What a write answers; undefined falls through to a plain 200 `{}`. */
  write?: (request: ApiRequest) => Answer | undefined;
  /** Called with every request, before anything answers it. */
  seen?: (request: ApiRequest) => void;
}
export function mountProject(options: Options = {}) {
  const base = projectFixture();
  const f = fakeHost(async request => {
    options.seen?.(request);
    if (request.path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
    if (request.path.endsWith("/start-preview")) return { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } };
    if (request.method !== "GET") { const answered = options.write?.(request);if (answered !== undefined) return answered; return { status: 200, body: {} }; }
    if (request.path === "/v1/app/projects/payments/people") return options.people ?? { status: 200, body: peopleView() };
    if (request.path === "/v1/app/projects/payments/code-settings") return options.settings ?? { status: 200, body: settings() };
    if (request.path === "/v1/app/projects/payments/collaborator-approvals") return options.approvals ?? { status: 200, body: approvals() };
    if (request.path === "/v1/app/projects/payments/product-decisions") return options.decisions ?? { status: 200, body: { decisions: [] } };
    if (request.path === "/v1/app/org/members") return options.members ?? { status: 200, body: { members: [{ developerId: ID.ana, name: "Ana Silva", role: "member" }, { developerId: ID.sam, name: "Sam Ortiz", role: "member" }, { developerId: ID.admin, name: "Dana Admin", role: "admin" }] } };
    return { status: 200, body: base };
  });
  if (options.on !== false) f.storage.set(PEOPLE_STORAGE_KEY, "v2");
  const query = createQueryClient();
  query.setQueryData(["nav"], { me: { developerId: ID.maya, name: "Maya Chen", orgRole: options.orgRole ?? "member" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: {} });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app/projects/payments?tab=people"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }));
  const calls = (match: (request: ApiRequest) => boolean) => f.request.mock.calls.map(([request]) => request).filter(match);
  return { ...f, ...ui, query, calls, close() { ui.unmount();query.clear(); } };
}
