// @vitest-environment jsdom
// Decision 46b: the two switches for coding tools. The project's (the Lessons tab: anyone sees what it comes to and why; a maintainer switches it) and the company's "lessons stay in Rovara" (How we work: owner or admin).
// The server decides again on every tap; these tests pin what is shown and sent.
import { afterEach, describe, expect, it } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { LocalToolsControl } from "../../packages/ui/src/screens/project/lessons/LocalToolsControl.js";
import LessonsLocalToolsRow from "../../packages/ui/src/screens/admin/how-we-work/LessonsLocalToolsRow.js";

const PROJECT = "/v1/app/projects/payments/lessons/local-tools";
const COMPANY = "/v1/app/org/lessons/local-tools";
type State = { enabled: boolean; own?: boolean; reason?: string; preset: "standard" | "regulated"; companyStays: boolean };
const standard = (over: Partial<State> = {}): State => ({ enabled: true, preset: "standard", companyStays: false, ...over });

function mount(element: (context: unknown) => ReturnType<typeof h>, answer: (request: ApiRequest) => ApiResponse | undefined, role = "owner") {
 const f = fakeHost(async request => answer(request) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });
 const query = createQueryClient();
 const context = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", company: "Acme", developerId: "d1", role, checking: false };
 const router = createMemoryRouter([{ path: "/", element: h(Outlet, { context }), children: [{ index: true, element: element(context) }] }], { initialEntries: ["/"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const writes = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET");
 return { ...f, ...view, writes, close() { view.unmount();router.dispose();query.clear(); } };
}
afterEach(() => { document.body.innerHTML = ""; });

describe("the project's switch for coding tools", () => {
 it("shows it on and lets a maintainer switch it off, sending the project's choice once, and on again", async () => {
  const state = { value: standard() };
  const f = mount(() => h(LocalToolsControl, { project: "payments", canChange: true }), request => {
   if (request.path !== PROJECT) return undefined;
   if (request.method === "POST") { const own = (request.body as { enabled: boolean }).enabled;state.value = standard({ enabled: own, own, ...(own ? {} : { reason: "project_setting" }) }); }
   return { status: 200, body: state.value };
  });
  const region = await screen.findByRole("region", { name: "Lessons in coding tools" });
  expect(within(region).getByText("On: coding tools can fetch this project's lessons.")).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "Turn off for this project" }));
  await within(region).findByText("Off: coding tools get no lessons from this project.");
  fireEvent.click(within(region).getByRole("button", { name: "Turn on for this project" }));
  await within(region).findByText("On: coding tools can fetch this project's lessons.");
  expect(f.writes().map(request => [request.method, request.path, request.body])).toEqual([["POST", PROJECT, { enabled: false }], ["POST", PROJECT, { enabled: true }]]);
  f.close();
 });

 it("a member who cannot change it sees what it comes to and no button; the company's switch and Regulated say why it is off and offer no button", async () => {
  for (const [state, text] of [
   [standard(), "A maintainer of this project can change this."],
   [standard({ enabled: false, reason: "company_stays", companyStays: true }), /Your company keeps lessons inside Rovara/u],
   [standard({ enabled: false, reason: "regulated", preset: "regulated" }), /Regulated preset/u],
  ] as const) {
   const f = mount(() => h(LocalToolsControl, { project: "payments", canChange: state.reason === undefined ? false : true }), request => (request.path === PROJECT ? { status: 200, body: state } : undefined));
   const region = await screen.findByRole("region", { name: "Lessons in coding tools" });
   expect(within(region).getByText(text)).toBeTruthy();
   expect(within(region).queryByRole("button", { name: /Turn o/u })).toBeNull();
   f.close();
   document.body.innerHTML = "";
  }
 });

 it("says a refusal in fixed words (a maintainer is needed), and shows nothing where the installation has no such setting", async () => {
  const refused = mount(() => h(LocalToolsControl, { project: "payments", canChange: true }), request => (request.path === PROJECT ? (request.method === "POST" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a maintainer of this project can change this." } } } : { status: 200, body: standard() }) : undefined));
  fireEvent.click(await screen.findByRole("button", { name: "Turn off for this project" }));
  await screen.findByText("A maintainer of this project can change this.");
  refused.close();
  document.body.innerHTML = "";
  const none = mount(() => h(LocalToolsControl, { project: "payments", canChange: true }), () => undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.queryByRole("region", { name: "Lessons in coding tools" })).toBeNull();
  none.close();
 });
});

describe("the company's 'lessons stay in Rovara' switch", () => {
 const company = (stays: boolean, role?: string) => mount(() => h(LessonsLocalToolsRow, {}), request => {
  if (request.path !== COMPANY) return undefined;
  if (request.method === "POST") stays = (request.body as { stays: boolean }).stays;
  return { status: 200, body: { stays } };
 }, role);

 it("lets an owner keep lessons inside Rovara and allow coding tools again", async () => {
  const f = company(false);
  const region = await screen.findByRole("region", { name: "Lessons: stay in Rovara" });
  fireEvent.click(within(region).getByRole("button", { name: "Keep lessons in Rovara" }));
  await within(region).findByText(/Lessons stay in Rovara: coding tools on your team's computers/u);
  fireEvent.click(within(region).getByRole("button", { name: "Allow coding tools to fetch lessons" }));
  await within(region).findByText(/Coding tools can fetch lessons: a project's team can turn that off/u);
  expect(f.writes().map(request => [request.method, request.path, request.body])).toEqual([["POST", COMPANY, { stays: true }], ["POST", COMPANY, { stays: false }]]);
  f.close();
 });

 it("shows nothing to a member, and no read is made for one", async () => {
  const f = company(false, "member");
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.queryByRole("region", { name: "Lessons: stay in Rovara" })).toBeNull();
  expect(f.request.mock.calls.filter(([request]) => request.path === COMPANY)).toHaveLength(0);
  f.close();
 });
});
