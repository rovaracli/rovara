// @vitest-environment jsdom
// G1 Opus fix round (REVIEW-OPUS-cdb1a2dfe): F1 the shared stale-by-error rule (DEC 254zzz324) incl. the read that fails after a SAVED write, F2 audit paging
// (the reviewer's two tests, taken as written), P3 a later 404. Mutants: MUTANTS.md "Opus fix round".
import { expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ApiRequest, ApiResponse } from "../../../../packages/ui/src/host.js";
import { mount } from "./mount.js";
import { identity, pendingSettings, refused, reply, settings } from "./fixtures.js";

const row = (id: string, action: string) => ({ id, source: "cloud", at: "2026-11-21T10:00:00Z", actor: { developerId: "a".repeat(64), name: "Ana" }, action, subject: "Company policy", outcome: "recorded" });
const AUDIT = "/v1/app/company/audit";
function pages(next: Record<string, string | undefined>) {
 return (request: ApiRequest): ApiResponse => {
  if (request.path.split("?")[0] !== AUDIT) return reply(request);
  const cursor = new URL(request.path, "https://x.test").searchParams.get("cursor") ?? "";
  const after = next[cursor];
  return { status: 200, body: { records: [row(`r-${cursor || "first"}`, `action at ${cursor || "first"}`)], ...(after === undefined ? {} : { next: after }), engine: { state: "connected" } } };
 };
}
const status = () => screen.getByRole("status", { name: "Audit records shown on this page" }).textContent;
const cursors = (app: { request: { mock: { calls: readonly (readonly [ApiRequest])[] } } }) => app.request.mock.calls.map(([r]) => r.path).filter(p => p.startsWith(AUDIT)).map(p => new URL(p, "https://x.test").searchParams.get("cursor") ?? "");
const SETTINGS = "/v1/app/org/settings";
const down = (): ApiResponse => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Try again." } } });
const writes = (app: { request: { mock: { calls: readonly (readonly [ApiRequest])[] } } }) => app.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");
const getsOf = (app: { request: { mock: { calls: readonly (readonly [ApiRequest])[] } } }) => app.request.mock.calls.filter(([r]) => r.path === SETTINGS && r.method === "GET").length;

// ---------- F2 (the reviewer's two audit-paging tests) ----------
it("Next, Previous, Next, Next reads each page once in order: no page is skipped or read twice as another", async () => {
 const app = await mount("/app/admin/audit", pages({ "": "c1", c1: "c2" }));
 await screen.findByText("action at first");
 const next = () => fireEvent.click(screen.getByRole("button", { name: "Next page" }));
 next(); await screen.findByText("action at c1"); await waitFor(() => expect(status()).toMatch(/^Page 2:/));
 fireEvent.click(screen.getByRole("button", { name: "Previous page" })); await screen.findByText("action at first");
 await waitFor(() => expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(false));
 next(); await screen.findByText("action at c1"); await waitFor(() => expect(status()).toMatch(/^Page 2:/));
 await waitFor(() => expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(false));
 next(); await screen.findByText("action at c2"); await waitFor(() => expect(status()).toMatch(/^Page 3:/));
 expect(screen.queryByText("action at c1")).toBeNull();
 expect(cursors(app).at(-1)).toBe("c2");
 app.close();
});
it("an empty next cursor on a later page is refused: it would re-read the first page as the next one", async () => {
 const app = await mount("/app/admin/audit", pages({ "": "c1", c1: "" }));
 await screen.findByText("action at first");
 fireEvent.click(screen.getByRole("button", { name: "Next page" }));
 await screen.findByText("Rovara couldn't read this page");
 expect(screen.queryByText("action at c1")).toBeNull();
 expect(cursors(app)).toEqual(["", "c1"]);
 app.close();
});

// ---------- F1 (the reviewer's two probes, now passing) ----------
it("a 503 on the settings re-read keeps the rules with one Reconnecting line", async () => {
 let failing = false;
 const app = await mount("/app/admin/settings", r => r.path.split("?")[0] === SETTINGS ? (failing ? down() : { status: 200, body: settings }) : reply(r));
 await screen.findByText("Review changes before merging");
 failing = true;
 fireEvent.click(await screen.findByRole("button", { name: "Read company settings again" }));
 await waitFor(() => expect(getsOf(app)).toBe(2));
 await waitFor(() => expect(screen.queryByText(/Reconnecting/)).not.toBeNull());
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
 expect(screen.getByText("Review changes before merging")).toBeTruthy();
 expect(screen.queryByText("Rovara couldn't read this page")).toBeNull();
 // The kept facts are display only: Change rules is not usable while they are stale.
 expect(screen.getByRole("button", { name: "Change rules" }).hasAttribute("disabled")).toBe(true);
 app.close();
});
it("a successful Save whose re-read fails shows the success and 'Couldn't refresh; reconnecting', never 'Nothing was changed', and no pre-save rules", async () => {
 let saved = false;
 const app = await mount("/app/admin/settings", r => r.method === "PUT" ? (saved = true, { status: 200, body: { companyId: settings.companyId, settings: settings.settings, version: 4 } }) : r.path.split("?")[0] === SETTINGS ? (saved ? down() : { status: 200, body: settings }) : reply(r));
 await screen.findByText("Review changes before merging");
 fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
 fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "Review every change twice" } });
 fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
 await screen.findByText(/Saved\. The new rules apply/);
 await screen.findByText(/Couldn't refresh this page; reconnecting/);
 expect(document.body.textContent).not.toMatch(/Nothing was changed/);
 expect(screen.queryByText("Rovara couldn't read this page")).toBeNull();
 expect(screen.queryByText("Review changes before merging")).toBeNull();
 expect(writes(app)).toHaveLength(1);
 // Reading again: the page answers, the facts are the post-save ones, the line is gone.
 saved = false;
 fireEvent.click(screen.getByRole("button", { name: "Read company settings again" }));
 await screen.findByText("Review changes before merging");
 expect(screen.queryByText(/Couldn't refresh this page/)).toBeNull();
 app.close();
});
it.each([["Approve this change", "approved", /^Approved\./], ["Reject this change", "withdrawn", /^Withdrawn\./]] as const)("%s followed by a failed re-read keeps the success and never says 'Nothing was changed'", async (button, _kind, text) => {
 let done = false;
 const app = await mount("/app/admin/settings", r => r.method === "POST" ? (done = true, { status: 200, body: {} }) : r.path.split("?")[0] === SETTINGS ? (done ? down() : { status: 200, body: pendingSettings }) : reply(r));
 fireEvent.click(await screen.findByRole("button", { name: button }));
 await screen.findByText(text);
 await screen.findByText(/Couldn't refresh this page; reconnecting/);
 expect(document.body.textContent).not.toMatch(/Nothing was changed/);
 expect(screen.queryByText("Review every change")).toBeNull();
 expect(writes(app)).toHaveLength(1);
 app.close();
});
it("a write that succeeds and whose re-read then answers an ACCESS signal shows access lost, and its 'What is safe' line does not say nothing was changed", async () => {
 let saved = false;
 const app = await mount("/app/admin/settings", r => r.method === "PUT" ? (saved = true, { status: 200, body: { companyId: identity.org.orgId, settings: settings.settings, version: 4 } }) : r.path.split("?")[0] === SETTINGS ? (saved ? refused(403) : { status: 200, body: settings }) : reply(r));
 fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
 fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "Another rule" } });
 fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
 const block = (await screen.findByText("Rovara couldn't read this page")).closest("section")!;
 expect(block.textContent).toMatch(/ACCESS-LOST/);
 expect(block.textContent).not.toMatch(/Nothing was changed/);
 expect(block.textContent).toMatch(/Your change went through\./);
 app.close();
});
// WORDING ROUND (controller 2026-11-23): one probe per G1 write type. A write succeeds in this view, then the re-read answers 401: the block says "Your change went through.", never "Nothing was changed".
it.each([
 ["Save rules", "PUT", settings, { companyId: identity.org.orgId, settings: settings.settings, version: 4 }],
 ["Save rules (sent for approval)", "PUT", settings, { pending: { changeId: "change-9" } }],
 ["Approve this change", "POST", pendingSettings, {}],
 ["Reject this change", "POST", pendingSettings, {}],
] as const)("%s then a 401 on the re-read: access lost says 'Your change went through.' and never 'Nothing was changed'", async (name, method, before, answer) => {
 let done = false;
 const app = await mount("/app/admin/settings", r => r.method === method ? (done = true, { status: 200, body: answer }) : r.path.split("?")[0] === SETTINGS ? (done ? refused(401) : { status: 200, body: before }) : reply(r));
 if (name.startsWith("Save")) {
  fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
  fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "Another rule" } });
  fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
 } else fireEvent.click(await screen.findByRole("button", { name }));
 const block = (await screen.findByText("Rovara couldn't read this page")).closest("section")!;
 expect(block.textContent).toMatch(/ACCESS-LOST/);
 expect(block.querySelector("dl")!.textContent).toContain("What is safeYour change went through.");
 expect(document.body.textContent).not.toMatch(/Nothing was changed/);
 expect(writes(app)).toHaveLength(1);
 app.close();
});
it("a plain read failure with no write shows the neutral default, never 'Nothing was changed'", async () => {
 const app = await mount("/app/admin/settings", r => r.path.split("?")[0] === SETTINGS ? down() : reply(r));
 const block = (await screen.findByText("Rovara couldn't read this page")).closest("section")!;
 expect(block.textContent).not.toMatch(/ACCESS-LOST/);
 expect(block.querySelector("dl")!.textContent).toContain("What is safeRovara couldn't read this page.");
 expect(document.body.textContent).not.toMatch(/Nothing was changed|Your change went through/);
 expect(writes(app)).toHaveLength(0);
 app.close();
});
it("an Audit and an Overview re-read that fails transiently keep their facts with the Reconnecting line", async () => {
 for (const [path, fact, url] of [["/app/admin/audit", "Updated company rules", AUDIT], ["/app/admin", "Open People", "/v1/app/org/members"]] as const) {
  let failing = false;
  const app = await mount(path, r => r.path.split("?")[0] === url && failing ? down() : reply(r));
  const label = path === "/app/admin/audit" ? "Read audit again" : "Read company overview again";
  const button = await screen.findByRole("button", { name: label });
  failing = true; fireEvent.click(button);
  await screen.findByText(/Updated .* · Reconnecting/);
  expect(screen.queryByText("Rovara couldn't read this page")).toBeNull();
  if (path === "/app/admin/audit") expect(screen.getByText(fact)).toBeTruthy(); else expect(screen.getByRole("link", { name: fact })).toBeTruthy();
  app.close();
 }
});
it.each([401, 403, 404])("the page itself clears the facts on a %s re-read even when the query client keeps data on error (the shared rule lives in the page, not only in the client)", async code => {
 let failing = false;
 // A bare client: no access eviction in the cache, so only the page's own use of the shared access rule can hide the facts.
 const app = await mount("/app/admin/settings", r => r.path.split("?")[0] === SETTINGS && failing ? refused(code) : reply(r), new QueryClient({ defaultOptions: { queries: { retry: false } } }));
 await screen.findByText("Review every change");
 failing = true;
 fireEvent.click(screen.getByRole("button", { name: "Read company settings again" }));
 const block = (await screen.findByText("Rovara couldn't read this page")).closest("section")!;
 expect(block.textContent).toMatch(/ACCESS-LOST/);
 expect(screen.queryByText("Review every change")).toBeNull();
 expect(screen.queryByText(/Reconnecting/)).toBeNull();
 app.close();
});

// ---------- G1 add-on (controller ruling): the last good facts stay VISIBLE while a read is fetched again; actions are governed by the SEND-TIME fresh check ----------
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const approvePath = `${SETTINGS}/pending/change-1/approve`;
/** Reads and writes as the fixtures answer them; the next settings GET after `start()` waits until `answer(...)` releases it. */
async function mountHeld(path: string, body: unknown, write: (r: ApiRequest) => ApiResponse = () => ok({})) {
 const app = await mount(path, r => (r.method !== "GET" ? write(r) : r.path.split("?")[0] === SETTINGS ? ok(body) : reply(r)));
 const respond = app.request.getMockImplementation()!;
 let on = false, release: ((r: ApiResponse) => void) | undefined;
 app.request.mockImplementation(async r => (on && r.method === "GET" && r.path.split("?")[0] === SETTINGS ? new Promise<ApiResponse>(done => { on = false; release = done; }) : respond(r)));
 return { app, start: () => { on = true; }, answer: async (r: ApiResponse) => { await waitFor(() => expect(release).toBeDefined()); const done = release!; release = undefined; await act(async () => { done(r); }); } };
}
const rereading = () => screen.findByRole("button", { name: "Read company settings again" }).then(button => waitFor(() => expect(button.hasAttribute("disabled")).toBe(true)));
const reread = async (held: { start: () => void }) => { held.start(); fireEvent.click(await screen.findByRole("button", { name: "Read company settings again" })); await rereading(); };
const bare = (text: string) => screen.queryByText(text);

it("a settings re-read in flight keeps the page title, the facts and the sections on screen (no blank, no Loading)", async () => {
 const held = await mountHeld("/app/admin/settings", pendingSettings);
 await screen.findByText("Review every change");
 await reread(held);
 expect(screen.getByRole("heading", { level: 1, name: "Company settings" })).toBeTruthy();
 expect(screen.getByText("Review every change")).toBeTruthy();
 expect(screen.getByRole("heading", { name: "Company policy" })).toBeTruthy();
 expect(screen.getByRole("heading", { name: "Monthly limit" })).toBeTruthy();
 expect(bare("Checking current details; earlier details are hidden.")).toBeNull();
 expect(document.querySelector(".rv-car-state [aria-busy='true'], .rv-car-loading")).toBeNull();
 expect(screen.queryByText(/Reconnecting/)).toBeNull();
 await held.answer(ok(pendingSettings));
 await screen.findByText("Review every change");
 held.app.close();
});
it("the same for Audit and Overview: the facts stay while the page is read again", async () => {
 for (const [path, fact, url, label] of [["/app/admin/audit", "Updated company rules", AUDIT, "Read audit again"], ["/app/admin", "Open People", "/v1/app/org/members", "Read company overview again"]] as const) {
  let holdIt = false; const slot: { release?: (r: ApiResponse) => void } = {};
  const app = await mount(path, r => (r.path.split("?")[0] === url && holdIt ? new Promise<ApiResponse>(done => { holdIt = false; slot.release = done; }) : reply(r)));
  const button = await screen.findByRole("button", { name: label });
  holdIt = true; fireEvent.click(button);
  await waitFor(() => expect(slot.release).toBeDefined());
  if (path === "/app/admin/audit") expect(screen.getByText(fact)).toBeTruthy(); else expect(screen.getByRole("link", { name: fact })).toBeTruthy();
  expect(bare("Checking current details; earlier details are hidden.")).toBeNull();
  await act(async () => { slot.release?.(reply({ method: "GET", path: url })); });
  app.close();
 }
});
it("Approve pressed during the re-read waits for the fresh read and sends ONE POST when the change is still the same", async () => {
 const held = await mountHeld("/app/admin/settings", pendingSettings);
 await screen.findByText("Review every change");
 await reread(held);
 const approve = screen.getByRole("button", { name: "Approve this change" });
 expect(approve.hasAttribute("disabled")).toBe(false);
 fireEvent.click(approve);
 expect(writes(held.app)).toHaveLength(0);
 await held.answer(ok(pendingSettings));
 await waitFor(() => expect(writes(held.app)).toHaveLength(1));
 expect(writes(held.app)[0]!.path).toBe(approvePath);
 await screen.findByText(/^Approved\./);
 expect(writes(held.app)).toHaveLength(1);
 held.app.close();
});
it("Approve and Reject pressed during the re-read send NOTHING when the fresh read shows another change, a changed read that no longer has one, or fails", async () => {
 const another = { ...pendingSettings, pending: { ...pendingSettings.pending, changeId: "change-2" } };
 for (const [fresh, name] of [[ok(another), "Approve this change"], [ok(settings), "Reject this change"], [down(), "Approve this change"], [ok(another), "Reject this change"]] as const) {
  const held = await mountHeld("/app/admin/settings", pendingSettings);
  await screen.findByText("Review every change");
  await reread(held);
  fireEvent.click(screen.getByRole("button", { name }));
  await held.answer(fresh);
  await waitFor(() => expect(held.app.request.mock.calls.filter(([r]) => r.path.split("?")[0] === SETTINGS && r.method === "GET").length).toBeGreaterThan(1));
  await screen.findByRole("heading", { level: 1, name: "Company settings" });
  expect(writes(held.app)).toHaveLength(0);
  if (fresh.status === 503) expect(await screen.findByText(/Updated .* · Reconnecting/)).toBeTruthy();
  else expect((await screen.findByTestId("settings-error")).textContent).toMatch(/nothing was sent/i);
  held.app.close();
 }
});
it("Save rules pressed during the re-read sends ONE PUT with the read's version when it is unchanged, and nothing when the version moved or the read failed", async () => {
 for (const [fresh, sends] of [[ok(settings), 1], [ok({ ...settings, version: 4 }), 0], [down(), 0]] as const) {
  const held = await mountHeld("/app/admin/settings", settings, () => ok({ companyId: identity.org.orgId, settings: settings.settings, version: 4 }));
  fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
  fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "Typed during read" } });
  await reread(held);
  // The draft survives the re-read (the page is not blanked).
  expect(screen.getByLabelText<HTMLTextAreaElement>("Rule 1").value).toBe("Typed during read");
  fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
  expect(writes(held.app)).toHaveLength(0);
  await held.answer(fresh);
  await waitFor(() => expect(held.app.request.mock.calls.filter(([r]) => r.path.split("?")[0] === SETTINGS && r.method === "GET").length).toBeGreaterThan(1));
  await screen.findByRole("heading", { level: 1, name: "Company settings" });
  if (sends === 1) { await waitFor(() => expect(writes(held.app)).toHaveLength(1)); expect(JSON.stringify(writes(held.app)[0]!.body)).toContain("Typed during read"); expect((writes(held.app)[0]!.body as { expectedVersion: number }).expectedVersion).toBe(3); }
  else await screen.findByTestId("settings-error");
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(writes(held.app)).toHaveLength(sends);
  held.app.close();
 }
});
it("a re-read in flight that then FAILS keeps the facts with ONE Reconnecting line and disables the actions; an ACCESS signal clears them", async () => {
 const failed = await mountHeld("/app/admin/settings", pendingSettings);
 await screen.findByText("Review every change");
 await reread(failed);
 await failed.answer(down());
 await screen.findByText(/Updated .* · Reconnecting/);
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
 expect(screen.getByText("Review every change")).toBeTruthy();
 expect(screen.getByRole("button", { name: "Approve this change" }).hasAttribute("disabled")).toBe(true);
 failed.app.close();
 const lost = await mountHeld("/app/admin/settings", pendingSettings);
 await screen.findByText("Review every change");
 await reread(lost);
 await lost.answer(refused(403));
 expect((await screen.findByText("Rovara couldn't read this page")).closest("section")!.textContent).toMatch(/ACCESS-LOST/);
 expect(bare("Review every change")).toBeNull();
 lost.app.close();
});

// ---------- Lead 4 Opus delta round: three display-only wording / UX items (no new send path) ----------
it("a press DROPPED by the identity re-check says so: nothing was sent, try again in a moment", async () => {
 const held = await mountHeld("/app/admin/settings", pendingSettings);
 const respond = held.app.request.getMockImplementation()!;
 await screen.findByText("Review every change");
 let holdMe = false, releaseMe: ((r: ApiResponse) => void) | undefined;
 held.app.request.mockImplementation(async r => (holdMe && r.path === "/v1/app/me" ? new Promise<ApiResponse>(done => { holdMe = false; releaseMe = done; }) : respond(r)));
 await reread(held);
 fireEvent.click(screen.getByRole("button", { name: "Approve this change" }));
 holdMe = true;
 await act(async () => { void held.app.query.refetchQueries({ queryKey: ["admin", "identity"] }); });
 await waitFor(() => expect(releaseMe).toBeDefined());
 await held.answer(ok(pendingSettings));
 expect((await screen.findByTestId("settings-checking")).textContent).toBe("Rovara is checking your access; nothing was sent. Try again in a moment.");
 expect(writes(held.app)).toHaveLength(0);
 await act(async () => { releaseMe!(ok(identity)); });
 await new Promise(resolve => setTimeout(resolve, 30));
 expect(writes(held.app)).toHaveLength(0);
 held.app.close();
});
it("a newer settings version read while a rule draft is open KEEPS the draft, says the rules changed elsewhere, and Save still sends nothing on the old version", async () => {
 const held = await mountHeld("/app/admin/settings", settings, () => ok({ companyId: identity.org.orgId, settings: settings.settings, version: 5 }));
 fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
 fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "My half typed rule" } });
 expect(screen.queryByTestId("rules-changed-elsewhere")).toBeNull();
 await reread(held);
 await held.answer(ok({ ...settings, version: 4, settings: { ...settings.settings, instructions: [{ text: "Someone else's rule", priority: "preferred" }] } }));
 const note = await screen.findByTestId("rules-changed-elsewhere");
 expect(note.textContent).toContain("These rules were changed elsewhere. Review the latest before saving.");
 expect(note.textContent).toContain("Someone else's rule");
 expect(screen.getByLabelText<HTMLTextAreaElement>("Rule 1").value).toBe("My half typed rule");
 fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
 expect((await screen.findByTestId("settings-error")).textContent).toMatch(/nothing was sent/i);
 expect(writes(held.app)).toHaveLength(0);
 expect(screen.getByLabelText<HTMLTextAreaElement>("Rule 1").value).toBe("My half typed rule");
 held.app.close();
});
it("with no draft open, a newer version simply replaces the rules (no changed-elsewhere note)", async () => {
 const held = await mountHeld("/app/admin/settings", settings);
 await screen.findByText("Review changes before merging");
 await reread(held);
 await held.answer(ok({ ...settings, version: 4, settings: { ...settings.settings, instructions: [{ text: "Newest rule", priority: "required" }] } }));
 await screen.findByText("Newest rule");
 expect(screen.queryByTestId("rules-changed-elsewhere")).toBeNull();
 held.app.close();
});
it("a Save that needs approval says 'Your change was sent for approval.', never saved, also when the re-read that follows fails", async () => {
 let proposed = false;
 const app = await mount("/app/admin/settings", r => r.method === "PUT" ? (proposed = true, ok({ pending: { changeId: "change-9" } })) : r.path.split("?")[0] === SETTINGS ? (proposed ? down() : ok(settings)) : reply(r));
 fireEvent.click(await screen.findByRole("button", { name: "Change rules" }));
 fireEvent.change(await screen.findByLabelText("Rule 1"), { target: { value: "Looser rule" } });
 fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
 const notices = await screen.findAllByText("Your change was sent for approval.");
 expect(notices.length).toBeGreaterThan(0);
 expect(await screen.findByText(/Couldn't refresh this page; reconnecting\. Your change was sent for approval\./)).toBeTruthy();
 expect(screen.queryByText(/saved/i)).toBeNull();
 app.close();
});
