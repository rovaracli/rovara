// @vitest-environment jsdom
// SH26: the project's saved environment panel. It shows health, the saved copy's age and why the last rebuild started in the app's fixed words; Reset is offered to a maintainer only (the server says so), is sent once
// per press, and its answer is the new panel; where the route answers 404 (saved environments off) the panel shows nothing, and the project page does not break.
import { expect, it } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SavedEnvPanelSchema } from "@agentx/contracts/web";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { EnvironmentPanel } from "../../packages/ui/src/screens/project/EnvironmentPanel.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";

const PATH = "/v1/app/projects/payments/environment-image";
const panel = (over: Record<string, unknown> = {}) => SavedEnvPanelSchema.parse({
  health: "healthy", image: { builtAt: "2026-10-30T10:00:00.000Z", ageDays: 3, status: "ready" }, lastRebuildReason: "key_changed", canReset: true, ...over,
});
type Handler = (request: ApiRequest) => Promise<ApiResponse | undefined> | ApiResponse | undefined;

function setup(options: { panel?: ReturnType<typeof panel>; read?: ApiResponse; post?: Handler; put?: Handler; page?: boolean } = {}) {
 let state = options.panel ?? panel();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (path === "/v1/app/projects/payments/overview") return { status: 200, body: projectFixture() };
  if (path === PATH && request.method === "GET") return options.read ?? { status: 200, body: state };
  if (path === PATH && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   state = panel({ rebuild: { state: "queued", reason: "reset" }, lastRebuildReason: "reset" });
   return { status: 200, body: { status: "queued", panel: state } };
  }
  if (path === PATH + "/setting" && request.method === "PUT") {
   const custom = await options.put?.(request);
   if (custom !== undefined) return custom;
   const enabled = (request.body as { enabled: boolean }).enabled;
   state = { ...state, enabled };
   return { status: 200, body: { enabled, changed: true } };
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 const query = createQueryClient();
 const element = options.page === true
  ? h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) })
  : h(EnvironmentPanel, { project: "payments" });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: element }) }), { theme: "light" });
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
 const puts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "PUT");
 return { ...f, ...ui, query, posts, puts };
}
const region = async () => within(await screen.findByRole("region", { name: "Saved environment" }));

it("shows health, the age of the saved copy and why the last rebuild started, in fixed words", async () => {
 setup();
 const section = await region();
 expect(await section.findByText("Healthy. New tasks start from the saved copy.")).toBeTruthy();
 expect(section.getByText("Saved copy built 3 days ago (2026-10-30).")).toBeTruthy();
 expect(section.getByText("The last rebuild was started because the setup files changed.")).toBeTruthy();
 expect(section.getByRole("button", { name: "Reset" })).toBeTruthy();
});

it("says what a waiting or running rebuild is for, a stale copy, and the last failure", async () => {
 setup({ panel: panel({ health: "needs_repair", image: { builtAt: "2026-10-20T10:00:00.000Z", ageDays: 13, status: "stale" }, rebuild: { state: "running", reason: "stale" }, lastFailure: { at: "2026-11-01T09:00:00.000Z", reason: "secrets_found" } }) });
 const section = await region();
 expect(await section.findByText("Needs repair. New tasks set up fresh until the next build works.")).toBeTruthy();
 expect(section.getByText("Saved copy built 13 days ago (2026-10-20). A task could not use it, so a new one is due.")).toBeTruthy();
 expect(section.getByText("Building a new saved copy now because a task could not use the saved copy.")).toBeTruthy();
 expect(section.getByText("The last build failed on 2026-11-01 (secrets found).")).toBeTruthy();
});

it("says so when there is no saved copy yet", async () => {
 setup({ panel: panel({ health: "never_proved", image: undefined, lastRebuildReason: undefined }) });
 const section = await region();
 expect(await section.findByText("No saved copy yet.")).toBeTruthy();
 expect(section.getByText("Not set up yet. A saved copy is built after the first passing setup check.")).toBeTruthy();
});

it("a word a newer server sends is shown as a plain sentence, not as a blank or the raw word", async () => {
 setup({ read: { status: 200, body: { ...panel(), health: "future_state", lastRebuildReason: "future_reason" } } });
 const section = await region();
 expect(await section.findByText("The saved environment's state is not known to this version of the app.")).toBeTruthy();
 expect(section.getByText("The last rebuild was started because of a reason this version of the app does not know.")).toBeTruthy();
 expect(document.body.textContent).not.toContain("future_state");
});

it("offers no Reset to a person who cannot reset, and says who can", async () => {
 setup({ panel: panel({ canReset: false }) });
 const section = await region();
 expect(await section.findByText("Only a maintainer of this project can reset it.")).toBeTruthy();
 expect(section.queryByRole("button", { name: "Reset" })).toBeNull();
});

it("Reset is sent once per press, with a request id, and the answer is the new panel", async () => {
 let release: (() => void) | undefined;
 const f = setup({ post: () => new Promise<ApiResponse>(resolve => { release = () => resolve({ status: 200, body: { status: "queued", panel: panel({ rebuild: { state: "queued", reason: "reset" }, lastRebuildReason: "reset" }) } }); }) });
 const section = await region();
 const button = await section.findByRole("button", { name: "Reset" });
 act(() => { button.click();button.click(); });
 await waitFor(() => expect(f.posts()).toHaveLength(1));
 release?.();
 expect(await section.findByText("A new saved copy is waiting to be built because a maintainer pressed Reset.")).toBeTruthy();
 expect(section.getByText("A new saved environment is being built.")).toBeTruthy();
 expect(f.posts()).toHaveLength(1);
 expect(f.posts()[0]!.body).toMatchObject({ action: "reset" });
 expect(typeof (f.posts()[0]!.body as { requestId: string }).requestId).toBe("string");
});

it("says when a rebuild is already waiting or a reset was just asked, and keeps what the server answered", async () => {
 for (const [status, text] of [["in_flight", "A new saved environment is already waiting to be built or being built."], ["cooldown", "A reset was asked a few minutes ago. Wait a little before asking again."]] as const) {
  const f = setup({ post: () => ({ status: 200, body: { status, panel: panel() } }) });
  fireEvent.click(await (await region()).findByRole("button", { name: "Reset" }));
  expect(await screen.findByText(text)).toBeTruthy();
  f.unmount();
 }
});

it("each press carries its own request id", async () => {
 const f = setup();
 const section = await region();
 fireEvent.click(await section.findByRole("button", { name: "Reset" }));
 await waitFor(() => expect(f.posts()).toHaveLength(1));
 await waitFor(() => expect(section.getByRole("button", { name: "Reset" }).hasAttribute("disabled")).toBe(false));
 fireEvent.click(section.getByRole("button", { name: "Reset" }));
 await waitFor(() => expect(f.posts()).toHaveLength(2));
 expect((f.posts()[0]!.body as { requestId: string }).requestId).not.toBe((f.posts()[1]!.body as { requestId: string }).requestId);
});

it("says when there was nothing to build, and shows a refusal as one fixed sentence", async () => {
 const nothing = setup({ post: () => ({ status: 200, body: { status: "nothing_to_do", panel: panel() } }) });
 fireEvent.click(await (await region()).findByRole("button", { name: "Reset" }));
 expect(await screen.findByText("Nothing to build right now. The project needs an approved test environment and code to build from.")).toBeTruthy();
 nothing.unmount();
 setup({ post: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "server words that are not shown <b>x</b>" } } }) });
 fireEvent.click(await (await region()).findByRole("button", { name: "Reset" }));
 expect((await screen.findByRole("alert")).textContent).toBe("Only a maintainer of this project can reset the saved environment.");
 expect(document.querySelector("b")).toBeNull();
});

it("shows nothing at all where saved environments are off (404) or the person may not see them (403)", async () => {
 for (const status of [404, 403]) {
  const f = setup({ read: { status, body: { error: { code: "NOT_FOUND", message: "Not found." } } } });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === PATH)).toBe(true));
  await waitFor(() => expect(screen.queryByLabelText("Loading the saved environment")).toBeNull());
  expect(screen.queryByRole("region", { name: "Saved environment" })).toBeNull();
  f.unmount();
 }
});

it("a read that fails says so and can be tried again", async () => {
 setup({ read: { status: 400, body: { error: { code: "CONFIG_INVALID", message: "boom" } } } });
 expect(await screen.findByText("Couldn't load the saved environment. Try again.")).toBeTruthy();
 expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("the project page shows the panel, and a project page whose route answers 404 shows no panel and no error", async () => {
 const on = setup({ page: true });
 expect(await screen.findByRole("heading", { name: "Saved environment" })).toBeTruthy();
 on.unmount();
 setup({ page: true, read: { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } } });
 await screen.findByRole("heading", { name: "payments" });
 await waitFor(() => expect(screen.queryByRole("heading", { name: "Saved environment" })).toBeNull());
});

it("has no accessibility violations", async () => {
 const f = setup();
 await (await region()).findByText("Healthy. New tasks start from the saved copy.");
 await expectNoAxeViolations(f.container);
});

// SV-1l: the project's on/off setting, in the Saved environment section.
const SWITCH = "Use a saved environment for new tasks";
it("a maintainer turns it off with one switch and one Save: one PUT, then the section says it is off and offers no Reset", async () => {
 const f = setup({ panel: panel({ enabled: true, canChangeSetting: true }) });
 const section = await region();
 expect(await section.findByText(/New tasks in this project only\./u)).toBeTruthy();
 expect(section.getByText("A maintainer of this project.")).toBeTruthy();
 const save = section.getByRole("button", { name: "Save" });
 expect(save.hasAttribute("disabled")).toBe(true);
 fireEvent.click(section.getByRole("switch", { name: SWITCH }));
 expect(save.hasAttribute("disabled")).toBe(false);
 act(() => { save.click();save.click(); });
 expect(await section.findByText("Saved. New tasks set up fresh.")).toBeTruthy();
 expect(f.puts()).toHaveLength(1);
 expect(f.puts()[0]!.path).toBe(PATH + "/setting");
 expect(f.puts()[0]!.body).toEqual({ enabled: false });
 expect(await section.findByText("Off for this project. Every new task sets up fresh, and no saved copy is built.")).toBeTruthy();
 expect(section.queryByRole("button", { name: "Reset" })).toBeNull();
 expect(section.getByText("Turn the saved environment on to build a new saved copy.")).toBeTruthy();
 expect(section.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
});

it("turns it back on from off", async () => {
 const f = setup({ panel: panel({ enabled: false, canChangeSetting: true }) });
 const section = await region();
 fireEvent.click(await section.findByRole("switch", { name: SWITCH }));
 fireEvent.click(section.getByRole("button", { name: "Save" }));
 expect(await section.findByText("Saved. New tasks start from the saved copy.")).toBeTruthy();
 expect(f.puts()[0]!.body).toEqual({ enabled: true });
});

it("a person who can't change it reads the value and is told who can, with no switch and no Save", async () => {
 setup({ panel: panel({ enabled: false, canChangeSetting: false, canReset: false }) });
 const section = await region();
 expect(await section.findByText("You can see this setting but not change it. Ask a maintainer of this project.")).toBeTruthy();
 expect(section.getByText("Off")).toBeTruthy();
 expect(section.queryByRole("switch")).toBeNull();
 expect(section.queryByRole("button", { name: "Save" })).toBeNull();
});

it("an older server that sends no setting gets no control", async () => {
 setup();
 const section = await region();
 await section.findByText("Healthy. New tasks start from the saved copy.");
 expect(section.queryByRole("switch")).toBeNull();
 expect(section.queryByText(/New tasks in this project only\./u)).toBeNull();
});

it("a refusal and a lost race are fixed sentences; the choice stays after a failure, and a lost race reads the panel again", async () => {
 const refused = setup({ panel: panel({ enabled: true, canChangeSetting: true }), put: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "server words <b>x</b>" } } }) });
 fireEvent.click(await (await region()).findByRole("switch", { name: SWITCH }));
 fireEvent.click(screen.getByRole("button", { name: "Save" }));
 expect((await screen.findByRole("alert")).textContent).toBe("Only a maintainer of this project can change this setting.");
 expect(document.querySelector("b")).toBeNull();
 expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
 refused.unmount();
 const stale = setup({ panel: panel({ enabled: true, canChangeSetting: true }), put: () => ({ status: 409, body: { error: { code: "CHANGE_STALE", message: "x" } } }) });
 fireEvent.click(await (await region()).findByRole("switch", { name: SWITCH }));
 const reads = () => stale.request.mock.calls.filter(([request]) => request.path === PATH && request.method === "GET").length;
 const before = reads();
 fireEvent.click(screen.getByRole("button", { name: "Save" }));
 expect((await screen.findByRole("alert")).textContent).toBe("Someone changed the saved environment meanwhile. It was read again; check it and save again.");
 await waitFor(() => expect(reads()).toBeGreaterThan(before));
 expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
});

it("the setting has no accessibility violations, for a maintainer and for a viewer", async () => {
 for (const canChangeSetting of [true, false]) {
  const f = setup({ panel: panel({ enabled: true, canChangeSetting }) });
  await (await region()).findByText("A maintainer of this project.");
  await expectNoAxeViolations(f.container);
  f.unmount();
 }
});
