// @vitest-environment jsdom
// Release 0.4.16: the account header names a person without their email, and a person whose name is not chosen yet is asked once what teammates should call them.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, type AppNav } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { NAME_PROMPT_KEY } from "../../packages/ui/src/shell/NamePrompt.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
const features = { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false };
const ID = "a".repeat(64);
const navWith = (me: { name: string; nameChosen?: boolean }): AppNav => AppNavSchema.parse({ me: { developerId: ID, orgRole: "member", ...me }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
const QUESTION = "What should teammates call you?";
function shell(initial: AppNav, options: { failSave?: { status: number; body: unknown }; storage?: Map<string, string> } = {}) {
 let current = initial;
 const f = fakeHost(async request => {
  if (request.method === "PUT" && request.path === "/v1/app/me/name") {
   if (options.failSave !== undefined) return options.failSave;
   const name = (request.body as { name: string }).name;
   current = navWith({ name, nameChosen: true });
   return { status: 200, body: { name, nameChosen: true } };
  }
  return { status: 200, body: current };
 });
 for (const [key, value] of options.storage ?? []) f.host.storage.set(key, value);
 const query = createQueryClient();
 const router = createMemoryRouter(appRoutes(features), { initialEntries: ["/app"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...ui, ...f, query, close: () => { ui.unmount();router.dispose();query.clear(); } };
}
const saves = (f: ReturnType<typeof shell>) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "PUT");

it("asks once what teammates should call a person whose name is not chosen, and shows the safe name in the header", async () => {
 const f = shell(navWith({ name: "Member 3fa9", nameChosen: false }));
 await screen.findByRole("heading", { name: "Home", level: 1 });
 expect(screen.getByRole("complementary", { name: "Your name" })).toBeTruthy();expect(screen.getByLabelText(QUESTION)).toBeTruthy();
 expect(screen.getByRole("button", { name: "Open account menu" }).textContent).toBe("Member 3fa9");
 expect(document.querySelector(".rv-app-shell")?.textContent).not.toContain("@");f.close();
});
it("fills in the provider's real name, and leaves the field empty for a placeholder", async () => {
 const named = shell(navWith({ name: "Priya Raman", nameChosen: false }));await screen.findByLabelText(QUESTION);expect(screen.getByLabelText<HTMLInputElement>(QUESTION).value).toBe("Priya Raman");named.close();
 const unnamed = shell(navWith({ name: "Member 3fa9", nameChosen: false }));await screen.findByLabelText(QUESTION);expect(screen.getByLabelText<HTMLInputElement>(QUESTION).value).toBe("");unnamed.close();
});
it("does not ask a person who chose their name, or when the server does not say", async () => {
 for (const me of [{ name: "Priya", nameChosen: true }, { name: "Priya" }]) { const f = shell(navWith(me));await screen.findByRole("heading", { name: "Home", level: 1 });expect(screen.queryByLabelText(QUESTION)).toBeNull();f.close(); }
});
it("saves the name, hides the question and updates the header", async () => {
 const f = shell(navWith({ name: "Member 3fa9", nameChosen: false }));await screen.findByLabelText(QUESTION);
 fireEvent.change(screen.getByLabelText(QUESTION), { target: { value: "  Priya R  " } });fireEvent.click(screen.getByRole("button", { name: "Save name" }));
 await waitFor(() => expect(screen.queryByLabelText(QUESTION)).toBeNull());
 expect(saves(f)).toEqual([expect.objectContaining({ path: "/v1/app/me/name", body: { name: "Priya R" } })]);
 // The header follows the refetched navigation; on a loaded full-suite run the 1 s window, then the 5 s one, was missed (passes alone, 3 of 3, and 6 at once under CPU load). The test itself had vitest's 5 s default, which ended it as the 5 s wait did, so both are given room.
 await waitFor(() => expect(screen.getByRole("button", { name: "Open account menu" }).textContent).toBe("Priya R"), { timeout: 20_000 });f.close();
}, 30_000);
it("refuses an email address or an empty name without sending anything, and says why", async () => {
 const f = shell(navWith({ name: "Member 3fa9", nameChosen: false }));await screen.findByLabelText(QUESTION);
 for (const value of ["priya@example.com", "   "]) {
  fireEvent.change(screen.getByLabelText(QUESTION), { target: { value } });fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect((await within(screen.getByRole("complementary", { name: "Your name" })).findByRole("alert")).textContent).toBe("Use 1 to 80 characters. A name can't be an email address.");
 }
 expect(saves(f)).toEqual([]);f.close();
});
it("shows the server's refusal and keeps the question", async () => {
 const f = shell(navWith({ name: "Member 3fa9", nameChosen: false }), { failSave: { status: 400, body: { error: { code: "CONFIG_INVALID", message: "name: must have 1 to 80 characters" } } } });await screen.findByLabelText(QUESTION);
 fireEvent.change(screen.getByLabelText(QUESTION), { target: { value: "Priya" } });fireEvent.click(screen.getByRole("button", { name: "Save name" }));
 expect((await within(screen.getByRole("complementary", { name: "Your name" })).findByRole("alert")).textContent).toBe("name: must have 1 to 80 characters");expect(screen.getByLabelText(QUESTION)).toBeTruthy();f.close();
});
it("can be dismissed, and stays dismissed on this device for this person only", async () => {
 const first = shell(navWith({ name: "Member 3fa9", nameChosen: false }));await screen.findByLabelText(QUESTION);
 fireEvent.click(screen.getByRole("button", { name: "Not now" }));await waitFor(() => expect(screen.queryByLabelText(QUESTION)).toBeNull());
 expect(first.storage.get(NAME_PROMPT_KEY)).toBe(ID);expect(saves(first)).toEqual([]);first.close();
 const again = shell(navWith({ name: "Member 3fa9", nameChosen: false }), { storage: new Map([[NAME_PROMPT_KEY, ID]]) });await screen.findByRole("heading", { name: "Home", level: 1 });expect(screen.queryByLabelText(QUESTION)).toBeNull();again.close();
 const other = shell(navWith({ name: "Member 3fa9", nameChosen: false }), { storage: new Map([[NAME_PROMPT_KEY, "b".repeat(64)]]) });await screen.findByLabelText(QUESTION);other.close();
});
it("lets a person change their name later from the account menu", async () => {
 const f = shell(navWith({ name: "Priya", nameChosen: true }));await screen.findByRole("heading", { name: "Home", level: 1 });
 fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
 const dialog = await screen.findByRole("dialog", { name: "Your account" });const field = within(dialog).getByLabelText<HTMLInputElement>("Your name");expect(field.value).toBe("Priya");
 fireEvent.change(field, { target: { value: "Priya Raman" } });fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
 await waitFor(() => expect(saves(f)).toEqual([expect.objectContaining({ body: { name: "Priya Raman" } })]));
 expect(await within(dialog).findByText("Saved.")).toBeTruthy();f.close();
});
it("starts the account menu's field empty while the name is not chosen, so a placeholder is not saved by accident", async () => {
 const f = shell(navWith({ name: "Member 3fa9", nameChosen: false }));await screen.findByRole("heading", { name: "Home", level: 1 });
 fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
 const dialog = await screen.findByRole("dialog", { name: "Your account" });expect(within(dialog).getByLabelText<HTMLInputElement>("Your name").value).toBe("");f.close();
});
for (const theme of ["light", "dark"] as const) it("has no automated accessibility violations with the question showing in " + theme, async () => {
 const f = shell(navWith({ name: "Member 3fa9", nameChosen: false }));await screen.findByLabelText(QUESTION);document.documentElement.setAttribute("data-theme", theme);await expectNoAxeViolations(f.container);f.close();
});

// QA6-10: the account menu shows the release the deploy carries, and nothing when the deploy does not say.
it("shows the release in the account menu when the navigation carries one, and no release line when it does not", async () => {
 const withRelease = shell({ ...navWith({ name: "Priya", nameChosen: true }), release: "0.5.8" });await screen.findByRole("heading", { name: "Home", level: 1 });
 fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
 const dialog = await screen.findByRole("dialog", { name: "Your account" });expect(within(dialog).getByText("Rovara 0.5.8")).toBeTruthy();withRelease.close();
 const without = shell(navWith({ name: "Priya", nameChosen: true }));await screen.findByRole("heading", { name: "Home", level: 1 });
 fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
 const plain = await screen.findByRole("dialog", { name: "Your account" });expect(within(plain).queryByText(/^Rovara \d/)).toBeNull();without.close();
});
