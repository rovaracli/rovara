// @vitest-environment jsdom
// Experience lane exp/continue-in-tool: the "Continue in your own tool" button and panel on the real session screen (switch `rovara.continue` = "v2").
import { afterEach, expect, it, vi } from "vitest";
import { act, screen, within, waitFor, fireEvent } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CLI_PACKAGE_NAME } from "@rovara-code/contracts";
import type { SessionView } from "@agentx/cloud-contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { CONTINUE_STORAGE_KEY, isContinueInToolOn } from "../../packages/ui/src/screens/session/continue-flags.js";
import { CLI_PACKAGE, continueOffer, installCommand, lessonsLine, loadPrompt, NO_BRANCH_YET, PUSH_EXPLAINER } from "../../packages/ui/src/screens/session/continue-in-tool.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

afterEach(() => { vi.unstubAllGlobals();vi.useRealTimers(); });
const TASK = "11111111-1111-4111-8111-111111111111";
type Lessons = { enabled: boolean; reason?: string; preset: string; companyStays: boolean } | "missing";
function setup(session: SessionView, options: { on?: boolean; lessons?: Lessons; copyText?: (text: string) => Promise<void> } = {}) {
 const f = fakeHost(async request => {
  const path = request.path.split("?", 1)[0]!;
  if (path.endsWith("/lessons/local-tools")) return options.lessons === undefined || options.lessons === "missing" ? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } } : { status: 200, body: options.lessons };
  if (path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
  return { status: 200, body: { session } };
 });
 if (options.on !== false) f.storage.set(CONTINUE_STORAGE_KEY, "v2");
 if (options.copyText !== undefined) f.host.copyText = options.copyText;
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();router.dispose();query.clear(); } };
}
const base = (overrides: Partial<SessionView> = {}, task: Record<string, unknown> = {}) => workspaceFixture({ ...overrides }, { pullRequests: undefined, ...task });
const open = async () => { await userEvent.click(await screen.findByRole("button", { name: "Continue in your own tool" }));return screen.findByRole("dialog", { name: "Continue in your own tool" }); };

it("keeps the command in step with the published CLI package name", () => {
 expect(CLI_PACKAGE).toBe(DEFAULT_CLI_PACKAGE_NAME);
 expect(installCommand("claude-code")).toBe("npx @preplabsai/rovara-code mcp install --client claude-code");
 expect(installCommand("codex")).toBe("npx @preplabsai/rovara-code mcp install --client codex");
 expect(installCommand("cursor")).toBe("npx @preplabsai/rovara-code mcp install --client cursor");
});
it("reads the switch from device storage only: off unless it says v2", () => {
 const store = new Map<string, string>(), host = { storage: { get: (key: string) => store.get(key), set: (key: string, value: string) => { store.set(key, value); } } };
 expect(isContinueInToolOn(host)).toBe(false);
 for (const value of ["", "v1", "true", "V2", "1"]) { store.set(CONTINUE_STORAGE_KEY, value);expect(isContinueInToolOn(host)).toBe(false); }
 store.set(CONTINUE_STORAGE_KEY, "v2");expect(isContinueInToolOn(host)).toBe(true);
 expect(isContinueInToolOn({ storage: { get: () => { throw new Error("blocked"); }, set: () => undefined } })).toBe(false);
});

it("switch off: no button, no panel, and no read of the lessons setting", async () => {
 const f = setup(base(), { on: false, lessons: { enabled: true, preset: "standard", companyStays: false } });
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });await screen.findByRole("button", { name: "Conversation" });
 expect(screen.queryByRole("button", { name: /Continue in your own tool/u })).toBeNull();
 expect(f.container.querySelector(".rv-session-work-actions")).toBeNull();
 expect(f.request.mock.calls.some(([request]) => request.path.includes("local-tools"))).toBe(false);
 f.close();
});
it("switch on: the button sits beside Conversation, and nothing is read until it is opened", async () => {
 const f = setup(base(), { lessons: { enabled: true, preset: "standard", companyStays: false } });
 const button = await screen.findByRole("button", { name: "Continue in your own tool" });
 expect(button.parentElement?.className).toBe("rv-session-work-actions");
 expect(within(button.parentElement!).getByRole("button", { name: "Conversation" })).toBeTruthy();
 expect(f.request.mock.calls.some(([request]) => request.path.includes("local-tools"))).toBe(false);
 f.close();
});

it("shows each tool's own install command, and the load prompt with the tool names", async () => {
 const f = setup(base());
 const dialog = await open();
 expect(within(dialog).getByRole("radio", { name: "Claude Code" })).toHaveProperty("checked", true);
 expect(dialog.querySelector("code")?.textContent).toContain("login");
 expect(within(dialog).getByLabelText("Install command for Claude Code").textContent).toBe("npx @preplabsai/rovara-code mcp install --client claude-code");
 expect(within(dialog).getByText(/Rovara runs claude mcp add for you/u)).toBeTruthy();
 await userEvent.click(within(dialog).getByRole("radio", { name: "Codex" }));
 expect(within(dialog).getByLabelText("Install command for Codex").textContent).toBe("npx @preplabsai/rovara-code mcp install --client codex");
 expect(within(dialog).getByText(/~\/\.codex\/config\.toml/u)).toBeTruthy();
 await userEvent.click(within(dialog).getByRole("radio", { name: "Cursor" }));
 expect(within(dialog).getByLabelText("Install command for Cursor").textContent).toBe("npx @preplabsai/rovara-code mcp install --client cursor");
 expect(within(dialog).getByText(/~\/\.cursor\/mcp\.json/u)).toBeTruthy();
 expect(within(dialog).getByText("Fix duplicate refunds")).toBeTruthy();
 expect(within(dialog).getByText(TASK)).toBeTruthy();
 expect(within(dialog).getByText("agentx_get_task")).toBeTruthy();expect(within(dialog).getByText("agentx_get_plan")).toBeTruthy();
 expect(within(dialog).getByLabelText("Prompt to paste into your tool").textContent).toBe(loadPrompt({ taskId: TASK, branch: undefined }));
 expect(within(dialog).getByText(PUSH_EXPLAINER)).toBeTruthy();
 f.close();
});

it("copies the command and the prompt through the host's clipboard and says Copied", async () => {
 const copied: string[] = [], f = setup(base(), { copyText: async text => { copied.push(text); } });
 const dialog = await open();
 await userEvent.click(within(dialog).getByRole("button", { name: "Copy install command" }));
 await waitFor(() => expect(within(dialog).getByRole("button", { name: "Copied" })).toBeTruthy());
 expect(copied).toEqual(["npx @preplabsai/rovara-code mcp install --client claude-code"]);
 expect(dialog.textContent).toContain("Copied the install command");
 await userEvent.click(within(dialog).getByRole("button", { name: "Copy prompt" }));
 expect(copied[1]).toBe("Load Rovara task " + TASK + " (call agentx_get_task, then agentx_get_plan) and continue it.");
 f.close();
});
it("returns the button to its name after a moment, and says so when copying fails", async () => {
 vi.useFakeTimers({ shouldAdvanceTime: true });
 const f = setup(base(), { copyText: async () => undefined });
 const dialog = await open();
 fireEvent.click(within(dialog).getByRole("button", { name: "Copy install command" }));
 await waitFor(() => expect(within(dialog).getByRole("button", { name: "Copied" })).toBeTruthy());
 await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
 expect(within(dialog).getByRole("button", { name: "Copy install command" })).toBeTruthy();
 f.close();
 const g = setup(base(), { copyText: async () => { throw new Error("denied"); } });
 const second = await open();
 fireEvent.click(within(second).getByRole("button", { name: "Copy prompt" }));
 await waitFor(() => expect(second.textContent).toContain("Couldn't copy. Select the text above and copy it yourself."));
 expect(within(second).queryByRole("button", { name: "Copied" })).toBeNull();
 g.close();
});

it("branch unknown: says when it appears; with a pull request it links the pull request and does not invent a branch name", async () => {
 const f = setup(base());
 let dialog = await open();
 expect(dialog.textContent).toContain(NO_BRANCH_YET);
 f.close();
 const g = setup(workspaceFixture());
 dialog = await open();
 expect(dialog.textContent).not.toContain(NO_BRANCH_YET);
 const link = within(dialog).getByRole("link", { name: "acme/payments #42" });
 expect(link.getAttribute("href")).toBe("https://github.com/acme/payments/pull/42");expect(link.getAttribute("rel")).toBe("noopener noreferrer");
 expect(within(dialog).getByLabelText("Prompt to paste into your tool").textContent).not.toContain("branch");
 g.close();
});
it("branch known (an agent-step run's chosen branch): shown, and in the prompt; an unsafe name is treated as unknown", async () => {
 const run = (branch: string) => ({ run: { state: "RUNNING", steps: [], pendingApprovals: [], branch } });
 const f = setup(base({}, run("agentx/refund-fix_1")));
 const dialog = await open();
 expect(within(dialog).getByText("agentx/refund-fix_1")).toBeTruthy();
 expect(within(dialog).getByLabelText("Prompt to paste into your tool").textContent).toBe("Load Rovara task " + TASK + " (call agentx_get_task, then agentx_get_plan) and continue it on branch agentx/refund-fix_1.");
 f.close();
 for (const bad of ["x; rm -rf /", "-evil", "a b", "x\ny", "$(id)"]) expect(continueOffer(base({}, run(bad)) as never)?.branch, bad).toBeUndefined();
});

it("never offers a Recheck button: the outside-push state and a manual recheck route do not exist yet", async () => {
 // A server that later adds the state is read tolerantly (the status reader keeps unknown states); even then there is no route to call, so no button.
 const f = setup({ ...base(), display: { state: "changed_outside", reason: "Someone pushed to the branch.", next: "Recheck." } } as never);
 const dialog = await open();
 expect(within(dialog).queryByRole("button", { name: /recheck/iu })).toBeNull();
 expect(dialog.textContent).toContain("Changed outside Rovara · checks needed");
 expect(f.request.mock.calls.some(([request]) => /recheck/iu.test(request.path))).toBe(false);
 f.close();
});

it("lessons: shown only where the setting says, per preset", async () => {
 const on = setup(base(), { lessons: { enabled: true, preset: "standard", companyStays: false } });
 let dialog = await open();
 await within(dialog).findByText(/trusted, project-wide lessons/u);expect(dialog.textContent).toContain("rovara_lessons");
 on.close();
 const regulated = setup(base(), { lessons: { enabled: false, reason: "regulated", preset: "regulated", companyStays: false } });
 dialog = await open();
 await within(dialog).findByText("This project uses the Regulated preset, so your tool gets no lessons.");
 regulated.close();
 const none = setup(base(), { lessons: "missing" });
 dialog = await open();
 await waitFor(() => expect(none.request.mock.calls.some(([request]) => request.path.includes("local-tools"))).toBe(true));
 await waitFor(() => expect(none.request.mock.results.every(result => result.type === "return")).toBe(true));
 expect(within(dialog).queryByRole("region", { name: "Lessons in your tool" })).toBeNull();
 expect(lessonsLine({ enabled: false, reason: "company_stays" })).toBe("Your company keeps lessons inside Rovara, so your tool gets no lessons.");
 expect(lessonsLine({ enabled: false, reason: "project_setting" })).toMatch(/switched off/u);
 expect(lessonsLine({ enabled: false })).toBeUndefined();expect(lessonsLine(undefined)).toBeUndefined();
 none.close();
});

it("role: the owner and anyone who can steer see the button; a reader who may only watch or comment does not; nor does an ended task", async () => {
 const you = (owner: boolean, actions: string[]) => ({ you: { level: owner ? "edit" : "use", owner, following: false, actions } }) as Partial<SessionView>;
 expect(continueOffer(base(you(true, ["watch"])))).toBeDefined();
 expect(continueOffer(base(you(false, ["watch", "comment", "steer"])))).toBeDefined();
 expect(continueOffer(base(you(false, ["watch", "comment"])))).toBeUndefined();
 expect(continueOffer(base(you(false, [])))).toBeUndefined();
 expect(continueOffer(base({}, { status: "CLOSED" }))).toBeUndefined();
 expect(continueOffer(base({ display: { state: "merged" } } as never))).toBeUndefined();
 expect(continueOffer(workspaceFixture({ kind: "local", body: { kind: "local", tool: "codex" } } as never))).toBeUndefined();
 const watcher = setup(base(you(false, ["watch", "comment"])));
 await screen.findByRole("button", { name: "Conversation" });
 expect(screen.queryByRole("button", { name: /Continue in your own tool/u })).toBeNull();
 watcher.close();
 const worker = setup(base(you(false, ["watch", "comment", "steer"])));
 expect(await screen.findByRole("button", { name: "Continue in your own tool" })).toBeTruthy();
 worker.close();
});

it("the sheet traps focus, Escape closes it and focus returns to the button, and axe finds nothing", async () => {
 const f = setup(base(), { lessons: { enabled: true, preset: "standard", companyStays: false } });
 const button = await screen.findByRole("button", { name: "Continue in your own tool" });
 const dialog = await open();
 await within(dialog).findByText(/trusted, project-wide lessons/u);
 await expectNoAxeViolations(document.body);
 // Tab and Shift+Tab never leave the dialog.
 for (let step = 0; step < 14; step += 1) { await userEvent.tab();expect(dialog.contains(document.activeElement), "forward step " + String(step)).toBe(true); }
 for (let step = 0; step < 14; step += 1) { await userEvent.tab({ shift: true });expect(dialog.contains(document.activeElement), "back step " + String(step)).toBe(true); }
 await userEvent.keyboard("{Escape}");
 await waitFor(() => expect(screen.queryByRole("dialog", { name: "Continue in your own tool" })).toBeNull());
 expect(document.activeElement).toBe(button);
 f.close();
});
