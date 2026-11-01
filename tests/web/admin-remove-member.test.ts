// @vitest-environment jsdom
// Member removal (v1.1), task 5: the People screen's "Remove from company" action. A preview first (who takes over, what moves, what ends, what is left to reassign), one confirm
// that sends the removal with a request id, and a retry that reuses that id so a repeat can never remove or hand over twice.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa", me = "a".repeat(64), ana = "b".repeat(64), sam = "c".repeat(64), cal = "d".repeat(64);
const joinedAt = "2026-10-01T00:00:00.000Z";
const members = [
 { developerId: me, name: "Priya", role: "owner", joinedAt }, { developerId: ana, name: "Ana", role: "admin", joinedAt }, { developerId: sam, name: "Sam", role: "member", joinedAt }, { developerId: cal, name: "Cal", role: "member", joinedAt },
];
const preview = (successorId: string, name: string) => ({
 member: { developerId: sam, name: "Sam", role: "member" }, successor: { developerId: successorId, name },
 moves: { agents: 2, skills: 0, chains: 1, triggers: 0, approvals: 3, spendRequests: 0 },
 ends: ["Their sign-in on the web, in the CLI and in Slack ends, and so do their device sessions.", "Their running tasks stop after their current step. None of them will open a pull request."],
 duties: { wasRole: "member", projectGrants: 2, maintainerProjects: 1, invitesCreated: 1 }, warnings: [],
});
function mount(options: { role?: "owner" | "admin"; theme?: "light" | "dark" } = {}) {
 const role = options.role ?? "owner", self = role === "owner" ? me : ana;
 const nav = AppNavSchema.parse({ me: { developerId: self, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 const state = { removed: false, postError: undefined as { status: number; code: string } | undefined, postHang: false };
 async function respond(r: ApiRequest): Promise<ApiResponse> {
  if (r.path.endsWith("/me")) return { status: 200, body: { developer: { id: self, name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] } };
  if (r.path.endsWith("/nav")) return { status: 200, body: nav };
  if (r.path.includes("/removal-preview")) { const successor = new URL(r.path, "https://x.test").searchParams.get("successorId") ?? self; return { status: 200, body: preview(successor, members.find((m) => m.developerId === successor)?.name ?? "Priya") }; }
  if (r.method === "POST" && r.path.endsWith("/removal")) {
   if (state.postError !== undefined) return { status: state.postError.status, body: { error: { code: state.postError.code, message: "private fixture" } } };
   state.removed = true;
   return { status: 200, body: { removalId: (r.body as { requestId: string }).requestId, state: "STARTED", message: "Sam's running tasks will stop after their current step. None of them will open a pull request." } };
  }
  return { status: 200, body: { members: state.removed ? members.filter((m) => m.developerId !== sam) : members } };
 }
 const f = fakeHost(respond);f.host.kind = "web";f.storage.set("rovara.theme", options.theme ?? "light");
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/people"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const posts = () => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "POST");
 return { ...f, ...view, state, posts, async open(name = "Sam") { fireEvent.click(await screen.findByRole("button", { name: `Remove ${name} from company` }));await screen.findByRole("dialog", { name: "Remove from company" });await screen.findByText(/Goes to /); }, close() { view.unmount();router.dispose();query.clear(); } };
}

it("shows an owner a remove action for everyone but themselves, and an admin only for members", async () => {
 const owner = mount();
 try { await screen.findByText("Sam");expect(screen.queryByRole("button", { name: "Remove Priya from company" })).toBeNull();for (const name of ["Ana", "Sam", "Cal"]) expect(screen.getByRole("button", { name: `Remove ${name} from company` })).toBeTruthy(); } finally { owner.close(); }
 const admin = mount({ role: "admin" });
 try { await screen.findByText("Sam");expect(screen.getByRole("button", { name: "Remove Sam from company" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Remove Priya from company" })).toBeNull(); } finally { admin.close(); }
});

it("previews before anything is sent: who takes over (you by default), what moves, what ends, and what is left to reassign", async () => {
 const f = mount();
 try {
  await f.open();
  expect(screen.getByLabelText<HTMLSelectElement>("Who takes over?").value).toBe(me);
  expect(screen.getByText("Goes to Priya")).toBeTruthy();
  expect(screen.getByText(/2 agents/)).toBeTruthy();expect(screen.getByText(/3 approvals waiting on them/)).toBeTruthy();
  expect(screen.getByText(/Their running tasks stop after their current step/)).toBeTruthy();
  expect(screen.getByText(/You'll need to reassign/)).toBeTruthy();expect(screen.getByText(/maintainer of 1 project/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Roles" })).toBeTruthy();expect(screen.getByRole("link", { name: "Projects" })).toBeTruthy();expect(screen.getByRole("link", { name: "Invites" })).toBeTruthy();
  expect(f.posts()).toHaveLength(0);
 } finally { f.close(); }
});

it("sends one removal with the chosen successor, the role the screen showed and a request id, then shows the receipt and reloads the list", async () => {
 const f = mount();
 try {
  await f.open();
  fireEvent.change(screen.getByLabelText("Who takes over?"), { target: { value: cal } });
  await screen.findByText("Goes to Cal");
  fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
  await screen.findByText(/running tasks will stop after their current step/);
  const [post] = f.posts();
  expect(f.posts()).toHaveLength(1);
  expect(post?.path).toBe(`/v1/app/org/members/${sam}/removal`);
  expect(post?.body).toMatchObject({ expectedRole: "member", successorId: cal });
  expect(typeof (post?.body as { requestId: unknown }).requestId).toBe("string");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Sam from company" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Remove Sam" })).toBeNull();
 } finally { f.close(); }
});

it("says plainly when the company changed or the person to take over left, and sends nothing more", async () => {
 for (const [status, code, text] of [[409, "CHANGE_STALE", /Company members changed/], [409, "SUCCESSOR_INVALID", /Pick someone who is still in the company/], [409, "LAST_OWNER", /at least one owner/]] as const) {
  const f = mount();
  try { await f.open();f.state.postError = { status, code };fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));await screen.findByText(text);expect(f.posts()).toHaveLength(1);expect(screen.queryByText(/was removed/)).toBeNull(); } finally { f.close(); }
 }
});

it("after an unknown outcome a deliberate retry sends the same request id, so a repeat cannot remove or hand over twice", async () => {
 const f = mount();
 try {
  await f.open();
  f.state.postError = { status: 503, code: "RUNTIME_UNAVAILABLE" };
  fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
  await screen.findByText(/outcome is unknown|did not finish/i);
  expect(f.posts()).toHaveLength(1);
  f.state.postError = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Try the removal again" }));
  await screen.findByText(/running tasks will stop after their current step/);
  const [first, second] = f.posts();
  expect((second?.body as { requestId: string }).requestId).toBe((first?.body as { requestId: string }).requestId);
 } finally { f.close(); }
});

for (const theme of ["light", "dark"] as const) it(`has an accessible removal review in ${theme}`, async () => {
 const f = mount({ theme });
 try { await f.open();await expectNoAxeViolations(screen.getByRole("dialog")); } finally { f.close(); }
});
