// @vitest-environment jsdom
// Approved test images (switches `tx` and `pj`): the card on the company How we work page and the screen behind it: what waits for approval (with the digest an admin approves), approve / dismiss / revoke, and adding an
// image by name. The server decides all of it; the screen shows its answer, in its words.
import { afterEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Outlet, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { CompanyImagesScreen } from "../../packages/ui/src/screens/admin/how-we-work/CompanyImagesScreen.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { companyPolicyRaw } from "./support/company-policy-raw.js";

const PATH = "/v1/app/org/test-images";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const image = (changes: Record<string, unknown> = {}) => ({
 imageId: "img_" + "1".repeat(20), revision: 1, status: "proposed", image: "postgres:18", registry: "docker.io", digest: "d".repeat(64), family: "postgres", version: "18", origin: "setup", project: "orders",
 proposedBy: "Maya Chen", proposedByYou: false, proposedAt: "2026-11-11T09:00:00.000Z", updatedAt: "2026-11-11T09:00:00.000Z", ...changes,
});
type State = { images: Array<Record<string, unknown>>; catalogAvailable: boolean; kinds: string[] };
const initial = (images: Array<Record<string, unknown>> = []): State => ({ images, catalogAvailable: true, kinds: ["mysql", "postgres", "redis"] });
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function mount(options: { state?: State; missing?: boolean; role?: "owner" | "admin" | "member"; post?: Handler; at?: string; theme?: "light" | "dark" } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let state = options.state ?? initial();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === PATH && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === PATH && request.method === "GET") return { status: 200, body: state };
  if (path === PATH && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   const body = request.body as { action: string; imageId?: string; image?: string };
   state = { ...state, images: body.action === "add" ? [...state.images, image({ imageId: "img_" + "2".repeat(20), image: body.image, origin: "admin", proposedByYou: true })] : state.images.flatMap(entry => entry.imageId !== body.imageId ? [entry] : body.action === "approve" ? [{ ...entry, status: "approved", revision: 2 }] : []) };
   return { status: 200, body: { status: "done", ...state } };
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.at ?? "/app/admin/how-we-work/images"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view, posts: () => calls().filter(request => request.method === "POST"), reads: () => calls().filter(request => request.method === "GET" && request.path === PATH) };
}
afterEach(() => { document.body.innerHTML = ""; });

describe("the card on How we work", () => {
 it("shows how many images wait, and goes to the screen", async () => {
  mount({ state: initial([image(), image({ imageId: "img_" + "3".repeat(20) })]), at: "/app/admin/how-we-work" });
  const section = within(await screen.findByRole("region", { name: "Approved test images" }));
  expect(section.getByText("2 images are waiting for approval.")).toBeTruthy();
  expect(section.getByRole("link", { name: "Open approved test images" }).getAttribute("href")).toBe("/app/admin/how-we-work/images");
 });
 it("is absent while a switch is off (the server says not found), with no notice", async () => {
  const f = mount({ missing: true, at: "/app/admin/how-we-work" });
  await screen.findByRole("heading", { name: "How we work (company)" });
  await waitFor(() => expect(f.reads().length).toBeGreaterThan(0));
  expect(screen.queryByRole("region", { name: "Approved test images" })).toBeNull();
 });
});

describe("the screen", () => {
 it("tells a member in words and reads nothing", async () => {
  const f = fakeHost(async () => refuse(404, "NOT_FOUND", "Not found."));
  f.host.kind = "web";
  const router = createMemoryRouter([{ path: "/", element: h(Outlet, { context: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: "a".repeat(64), role: "member", checking: false } }), children: [{ index: true, element: h(CompanyImagesScreen) }] }]);
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(RouterProvider, { router }) }) }));
  await screen.findByText("Only a company owner or admin can see or change approved test images.");
  expect(f.request).not.toHaveBeenCalled();
 });
 it("says the images are not on when the server does not know them", async () => {
  mount({ missing: true });
  await screen.findByText("Approved test images are not turned on for this company.");
 });
 it("shows a waiting image with the digest it pins, and approves exactly the revision and digest it showed, once", async () => {
  const f = mount({ state: initial([image()]) });
  const card = within(await screen.findByRole("region", { name: "postgres:18" }));
  expect(card.getByText("sha256:" + "d".repeat(64))).toBeTruthy();
  expect(card.getByText(/Asked for by the setup of the project orders/)).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Approve this image" }));
  await screen.findByText("Approved.");
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0]!.body).toEqual({ action: "approve", imageId: "img_" + "1".repeat(20), expectedRevision: 1, expectedDigest: "d".repeat(64) });
  expect(f.posts()[0]!.retry).toBe("never");
  await screen.findByRole("button", { name: "Revoke" });
 });
 it("asks for a new sign-in in the server's words when the sign-in is old", async () => {
  const f = mount({ state: initial([image()]), post: () => refuse(403, "REAUTH_REQUIRED", "Sign in again to confirm this company change.") });
  fireEvent.click(await screen.findByRole("button", { name: "Approve this image" }));
  await screen.findByText("Sign in again to confirm this company change.");
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(f.host.signIn).toHaveBeenCalled();
 });
 it("reads the list again and says so when the image changed meanwhile", async () => {
  const f = mount({ state: initial([image()]), post: () => refuse(409, "CHANGE_STALE", "That image changed. Refresh before continuing.") });
  fireEvent.click(await screen.findByRole("button", { name: "Approve this image" }));
  await screen.findByText("That image changed. The list was refreshed: check it and try again.");
  await waitFor(() => expect(f.reads().length).toBeGreaterThan(1));
 });
 it("dismisses a waiting image, revokes an approved one, and names a new image to look up", async () => {
  const f = mount({ state: initial([image(), image({ imageId: "img_" + "4".repeat(20), image: "mysql:9", family: "mysql", status: "approved", revision: 2 })]) });
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await screen.findByText("Dismissed.");
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await screen.findByText("Revoked.");
  fireEvent.change(screen.getByLabelText("Image"), { target: { value: "postgres:17.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Look up this image" }));
  await screen.findByText(/Looked up\./);
  expect(f.posts().map(request => request.body)).toEqual([
   { action: "revoke", imageId: "img_" + "1".repeat(20), expectedRevision: 1 }, { action: "revoke", imageId: "img_" + "4".repeat(20), expectedRevision: 2 }, { action: "add", image: "postgres:17.5" },
  ]);
 });
 it("has no accessibility violations, light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
   const view = mount({ state: initial([image(), image({ imageId: "img_" + "4".repeat(20), image: "mysql:9", status: "approved", revision: 2 })]), theme });
   await screen.findByRole("region", { name: "postgres:18" });
   await expectNoAxeViolations(view.container);
   view.unmount();
  }
 });
});
