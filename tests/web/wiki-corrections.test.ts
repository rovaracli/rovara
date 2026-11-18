// @vitest-environment jsdom
// Lead 4 slice C1: how people correct a wiki page in the app: Add a note (pinned at the top), Mark wrong on a paragraph or the page (optional reason), approve, remove, suggest a rule-like note as
// a lesson, the "may be out of date" note, and the disputed list. Every control is drawn from what Code says THIS person may do, so a person who cannot do something is never shown the button.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { WikiTab } from "../../packages/ui/src/screens/project/wiki/WikiTab.js";
import { WIKI_CORRECTION_WORDS, type WikiCorrectionsResponse } from "@agentx/contracts/web";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { projectFixture } from "./support/project-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { wikiIndex, wikiPage, wikiSources } from "./support/wiki-fixture.js";

const LEAK = "SENSITIVE-SERVER-DETAIL";
const W = WIKI_CORRECTION_WORDS;
const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refuse = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const BILLING = "beacon-api--billing";
type Role = "maintainer" | "contributor" | "viewer";

const corrections = (role: Role, over: Partial<{ stale: boolean; lessons: boolean; mineOnly: boolean }> = {}): WikiCorrectionsResponse => ({
  project: "payments", pageId: BILLING,
  you: { role, addNote: role !== "viewer", markWrong: role !== "viewer", approveNotes: role === "maintainer", resolveMarks: role === "maintainer", seeDisputed: role === "maintainer" },
  notes: [
    // "Always run the refund tests ..." (Priya, pending, a rule), and Sam's approved note tied to webhooks.ts.
    { noteId: "note-pending-1", mine: role === "contributor", canDelete: role === "maintainer" || role === "contributor", canApprove: role === "maintainer", canSuggestLesson: over.lessons !== false && role !== "viewer", mayBeOutOfDate: false },
    { noteId: "note-approved-1", mine: false, canDelete: role === "maintainer", canApprove: false, canSuggestLesson: false, mayBeOutOfDate: over.stale === true && role === "maintainer" },
  ],
});

interface Options { role?: Role | "none"; corrections?: () => ApiResponse; stale?: boolean; lessons?: boolean; write?: (request: ApiRequest) => ApiResponse | undefined; disputed?: () => ApiResponse; gaps?: () => ApiResponse; initial?: string }
function mount(options: Options = {}) {
  const overview = projectFixture();
  overview.project.repositories = [{ name: "beacon-api", fullName: "acme/beacon-api", defaultBranch: "main" }] as unknown as typeof overview.project.repositories;
  const writes: ApiRequest[] = [];
  const f = fakeHost(async (request: ApiRequest) => {
    const path = request.path;
    if (request.method !== "GET") {
      writes.push(request);
      return options.write?.(request) ?? json(200, path.endsWith("/notes") ? { note: { noteId: "note-new-0001", text: "x", author: "Me", createdAt: "2026-11-17T10:00:00.000Z", approval: "pending" } } : path.endsWith("/approve") ? { noteId: "note-pending-1", approval: "approved" } : path.endsWith("/delete") ? { deleted: true } : path.endsWith("/suggest-lesson") ? { state: "proposed", lessonId: "wn_abc123abc123" } : path.endsWith("/resolve") ? { resolved: 1 } : { flagId: "flag-0001", pageId: BILLING });
    }
    if (path === "/v1/app/projects/payments/wiki") return json(200, wikiIndex("payments"));
    if (path === "/v1/app/projects/payments/wiki/gaps") return options.gaps?.() ?? json(200, { project: "payments", more: false, items: [{ topic: "How do refunds work", kind: "partly", people: 2, questions: 3, lastAskedAt: "2026-11-17" }, { topic: "Where is the <b>retry</b> policy", kind: "not_found", people: 1, questions: 1, lastAskedAt: "2026-11-16" }] });
    if (path === "/v1/app/projects/payments/wiki/disputed") return options.disputed?.() ?? json(200, { project: "payments", more: false, items: [{ flagId: "flag-0009", pageId: BILLING, pageTitle: "billing", claimId: "c-charge", claimText: "Charges go through chargeCustomer.", markedBy: "Priya", markedAt: "2026-11-16T10:00:00.000Z", reason: "It moved to charge_v2.ts" }] });
    const page = /^\/v1\/app\/projects\/payments\/wiki\/pages\/([^/]+)$/u.exec(path);
    if (page !== null) { const one = wikiPage("payments", page[1]!); return one === undefined ? refuse(404, "NOT_FOUND", "That wiki page is not there.") : json(200, one); }
    if (/\/corrections$/u.test(path)) {
      if (options.corrections !== undefined) return options.corrections();
      return options.role === "none" ? refuse(404, "NOT_FOUND", "route not found") : json(200, corrections(options.role ?? "maintainer", { stale: options.stale === true, lessons: options.lessons !== false }));
    }
    const sources = /^\/v1\/app\/projects\/payments\/wiki\/pages\/([^/]+)\/sources$/u.exec(path);
    if (sources !== null) { const one = wikiSources("payments", sources[1]!); return one === undefined ? refuse(404, "NOT_FOUND", "x") : json(200, one); }
    if (path === "/v1/app/projects/payments/overview") return json(200, overview);
    return refuse(404, "NOT_FOUND", "route not found");
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.initial ?? `/app/projects/payments?tab=wiki&page=${BILLING}`], children: h(Routes, null, h(Route, { path: "/app/projects/:name", element: h(WikiTab, { project: "payments" }) })) }) }) }), { theme: "light" });
  return { ...f, ...ui, writes, close() { ui.unmount(); query.clear(); } };
}
const article = async () => within(await screen.findByTestId("wiki-page"));
const body = (request: ApiRequest | undefined) => request?.body as Record<string, unknown> | undefined;
const markButtons = () => screen.queryAllByRole("button", { name: /^Mark wrong/ });

describe("what each role is offered (no dead buttons)", () => {
  it("a maintainer: Add a note, Mark wrong on paragraphs that can still be marked, approve and remove, the lesson offer, the disputed list", async () => {
    const f = mount();
    const a = await article();
    await waitFor(() => expect(screen.getByTestId("wiki-add-note")).toBeTruthy());
    // Four paragraphs rest on claims not yet marked wrong; the one resting on the marked claim has no button.
    expect(markButtons()).toHaveLength(4);
    expect(a.getByRole("button", { name: "Mark this page wrong" })).toBeTruthy();
    expect(a.getByRole("button", { name: "Approve for agents" })).toBeTruthy();
    expect(a.getAllByRole("button", { name: /^Remove/ })).toHaveLength(2);
    expect(a.getByTestId("wiki-lesson-offer")).toBeTruthy();
    expect(screen.getByTestId("wiki-disputed-link")).toBeTruthy();
    f.close();
  });

  it("a contributor: Add a note and Mark wrong, but no approve and no disputed list; Remove only where Code says so", async () => {
    const f = mount({ role: "contributor" });
    const a = await article();
    await waitFor(() => expect(screen.getByTestId("wiki-add-note")).toBeTruthy());
    expect(markButtons().length).toBeGreaterThan(0);
    expect(a.queryByRole("button", { name: "Approve for agents" })).toBeNull();
    expect(a.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    expect(screen.queryByTestId("wiki-disputed-link")).toBeNull();
    f.close();
  });

  it("a viewer: reads everything, no write control at all, and is told why", async () => {
    const f = mount({ role: "viewer" });
    const a = await article();
    await screen.findByTestId("wiki-readonly");
    expect(screen.queryByTestId("wiki-add-note")).toBeNull();
    expect(markButtons()).toHaveLength(0);
    expect(a.queryByRole("button", { name: "Mark this page wrong" })).toBeNull();
    expect(a.queryByRole("button", { name: /Approve|Remove|Suggest/ })).toBeNull();
    expect(screen.queryByTestId("wiki-disputed-link")).toBeNull();
    expect(a.getByText(/Always run the refund tests/u)).toBeTruthy();
    f.close();
  });

  it("when the corrections cannot be read the page still shows, with no control (never a button that would be refused)", async () => {
    for (const read of [() => refuse(404, "NOT_FOUND", "route not found"), () => refuse(503, "RUNTIME_UNAVAILABLE", W.unavailable), () => json(200, { project: "payments", pageId: BILLING, you: { role: "owner" }, notes: [] })]) {
      const f = mount({ corrections: read });
      const a = await article();
      expect(a.getByText(/Always run the refund tests/u)).toBeTruthy();
      await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/corrections"))).toBe(true));
      expect(screen.queryByTestId("wiki-add-note")).toBeNull();
      expect(markButtons()).toHaveLength(0);
      expect(screen.queryByTestId("wiki-readonly")).toBeNull();
      f.close();
    }
  });

  it("the lesson offer is not shown where Code does not offer it (lessons off, or a note that is not a rule)", async () => {
    const f = mount({ lessons: false });
    await article();
    await screen.findByTestId("wiki-add-note");
    expect(screen.queryByTestId("wiki-lesson-offer")).toBeNull();
    f.close();
  });

  it("each note control follows its own flag: approve without remove, remove without approve", async () => {
    const f = mount({ corrections: () => json(200, { ...corrections("maintainer"), notes: [{ noteId: "note-pending-1", mine: false, canDelete: false, canApprove: true, canSuggestLesson: false, mayBeOutOfDate: false }, { noteId: "note-approved-1", mine: false, canDelete: true, canApprove: false, canSuggestLesson: false, mayBeOutOfDate: false }] }) });
    const a = await article();
    await screen.findByTestId("wiki-add-note");
    expect(a.getAllByRole("button", { name: "Approve for agents" })).toHaveLength(1);
    expect(a.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    const pending = document.querySelector('[data-note="note-pending-1"]') as HTMLElement;
    expect(within(pending).queryByRole("button", { name: /^Remove/ })).toBeNull();
    const approved = document.querySelector('[data-note="note-approved-1"]') as HTMLElement;
    expect(within(approved).queryByRole("button", { name: "Approve for agents" })).toBeNull();
    f.close();
  });

  it("a page already marked wrong is not offered Mark this page wrong again", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=repo-beacon-agents" });
    const a = await article();
    await screen.findByTestId("wiki-add-note");
    expect(a.queryByRole("button", { name: "Mark this page wrong" })).toBeNull();
    f.close();
  });

  it("a note whose file changed says so, for those Code names", async () => {
    const f = mount({ stale: true });
    await article();
    expect(await screen.findByTestId("wiki-note-stale")).toBeTruthy();
    f.close();
    const g = mount({ role: "contributor", stale: true });
    await article();
    await screen.findByTestId("wiki-add-note");
    expect(screen.queryByTestId("wiki-note-stale")).toBeNull();
    g.close();
  });
});

describe("Add a note", () => {
  it("sends exactly the text and the chosen file; the answer is shown after the page is read again", async () => {
    const f = mount();
    await article();
    fireEvent.click(await screen.findByTestId("wiki-add-note"));
    const form = within(screen.getByTestId("wiki-note-form"));
    fireEvent.change(form.getByLabelText(/Your note/u), { target: { value: "  Never call billing from web.  " } });
    fireEvent.change(form.getByLabelText(/Point this note at a file/u), { target: { value: "beacon-api/src/billing/charge.ts" } });
    fireEvent.click(form.getByRole("button", { name: "Pin note" }));
    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/payments/wiki/pages/beacon-api--billing/notes" });
    expect(body(f.writes[0])).toEqual({ text: "Never call billing from web.", file: { repo: "beacon-api", path: "src/billing/charge.ts" } });
    await waitFor(() => expect(screen.queryByTestId("wiki-note-form")).toBeNull());
    f.close();
  });

  it("an empty note cannot be sent; a refusal is shown in Code's fixed words and the form stays; other server text is never shown", async () => {
    const f = mount({ write: (request) => (request.path.endsWith("/notes") ? refuse(403, "FORBIDDEN", W.needsWorkingRole) : undefined) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-add-note"));
    const form = within(screen.getByTestId("wiki-note-form"));
    expect(form.getByRole("button", { name: "Pin note" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(form.getByLabelText(/Your note/u), { target: { value: "hello" } });
    fireEvent.click(form.getByRole("button", { name: "Pin note" }));
    expect((await screen.findByRole("alert")).textContent).toBe(W.needsWorkingRole);
    expect(screen.getByTestId("wiki-note-form")).toBeTruthy();
    f.close();
    const g = mount({ write: () => refuse(500, "X", `a cause ${LEAK}`) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-add-note"));
    const form2 = within(screen.getByTestId("wiki-note-form"));
    fireEvent.change(form2.getByLabelText(/Your note/u), { target: { value: "hello" } });
    fireEvent.click(form2.getByRole("button", { name: "Pin note" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That could not be done just now. Try again.");
    expect(document.body.textContent).not.toContain(LEAK);
    g.close();
  });
});

describe("Mark wrong", () => {
  it("on a paragraph marks each claim it rests on with the optional reason; nothing else is sent", async () => {
    const f = mount();
    await article();
    await screen.findByTestId("wiki-add-note");
    const para = document.querySelector('[data-block="p-does-1"]') as HTMLElement;
    fireEvent.click(within(para).getByRole("button", { name: /^Mark wrong/ }));
    const form = within(screen.getByTestId("wiki-mark-form"));
    fireEvent.change(form.getByLabelText(/What is wrong/u), { target: { value: "It moved to charge_v2.ts" } });
    fireEvent.click(form.getByRole("button", { name: "Mark wrong" }));
    await waitFor(() => expect(f.writes).toHaveLength(3));
    expect(f.writes.map((w) => [w.path, body(w)])).toEqual(["c-charge", "c-refund", "c-webhook"].map((claimId) => ["/v1/app/projects/payments/wiki/pages/beacon-api--billing/flags", { claimId, reason: "It moved to charge_v2.ts" }]));
    f.close();
  });

  it("with no reason sends just the claim; on the page sends just the reason, or nothing", async () => {
    const f = mount();
    const a = await article();
    await screen.findByTestId("wiki-add-note");
    const para = document.querySelector('[data-block="p-does-4"]') as HTMLElement;
    fireEvent.click(within(para).getByRole("button", { name: /^Mark wrong/ }));
    fireEvent.click(within(screen.getByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(body(f.writes[0])).toEqual({ claimId: "c-gone" });
    await waitFor(() => expect(screen.queryByTestId("wiki-mark-form")).toBeNull());
    fireEvent.click(a.getByRole("button", { name: "Mark this page wrong" }));
    fireEvent.click(within(screen.getByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
    await waitFor(() => expect(f.writes).toHaveLength(2));
    expect(body(f.writes[1])).toEqual({});
    f.close();
  });

  it("a refusal is shown in fixed words", async () => {
    const f = mount({ write: () => refuse(403, "FORBIDDEN", W.needsWorkingRole) });
    await article();
    await screen.findByTestId("wiki-add-note");
    fireEvent.click(screen.getAllByRole("button", { name: /^Mark wrong/ })[0]!);
    fireEvent.click(within(screen.getByTestId("wiki-mark-form")).getByRole("button", { name: "Mark wrong" }));
    expect((await screen.findByRole("alert")).textContent).toBe(W.needsWorkingRole);
    f.close();
  });
});

describe("notes: approve, remove, suggest as a lesson", () => {
  it("each sends its own empty body to its own path", async () => {
    const f = mount();
    const a = await article();
    await screen.findByTestId("wiki-add-note");
    fireEvent.click(a.getByRole("button", { name: "Approve for agents" }));
    await waitFor(() => expect(f.writes).toHaveLength(1));
    fireEvent.click(a.getByRole("button", { name: "Suggest as a lesson" }));
    await waitFor(() => expect(f.writes).toHaveLength(2));
    expect(await screen.findByText(/Sent to Lessons for an admin to approve/u)).toBeTruthy();
    fireEvent.click(a.getAllByRole("button", { name: /^Remove/ })[0]!);
    await waitFor(() => expect(f.writes).toHaveLength(3));
    expect(f.writes.map((w) => [w.method, w.path.replace("/v1/app/projects/payments/wiki/pages/beacon-api--billing", ""), body(w)])).toEqual([
      ["POST", "/notes/note-pending-1/approve", {}], ["POST", "/notes/note-pending-1/suggest-lesson", {}], ["POST", "/notes/note-pending-1/delete", {}],
    ]);
    f.close();
  });

  it("a refusal to suggest is shown in Code's fixed words", async () => {
    const f = mount({ write: () => refuse(400, "CONFIG_INVALID", W.notARule) });
    const a = await article();
    await screen.findByTestId("wiki-add-note");
    fireEvent.click(a.getByRole("button", { name: "Suggest as a lesson" }));
    expect((await screen.findByRole("alert")).textContent).toBe(W.notARule);
    f.close();
  });
});

describe("B17: acknowledge a changed-file note, and the questions the wiki could not answer", () => {
  it("a note whose file changed offers I've checked it to the people Code names; it sends one empty acknowledge to the note's own path", async () => {
    const f = mount({ stale: true, write: (request) => (request.path.endsWith("/acknowledge") ? json(200, { noteId: "note-approved-1", acknowledged: true }) : undefined) });
    await article();
    fireEvent.click(await screen.findByRole("button", { name: /^I've checked it/u }));
    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/payments/wiki/pages/beacon-api--billing/notes/note-approved-1/acknowledge", body: {}, retry: "never" });
    f.close();
    const g = mount({ role: "contributor", stale: true });
    await article();
    await screen.findByTestId("wiki-add-note");
    expect(screen.queryByRole("button", { name: /^I've checked it/u })).toBeNull();
    g.close();
    // No changed-file reminder, no button, even for a maintainer.
    const n = mount();
    await article();
    await screen.findByTestId("wiki-add-note");
    expect(screen.queryByRole("button", { name: /^I've checked it/u })).toBeNull();
    n.close();
    const k = mount({ stale: true, write: () => refuse(403, "FORBIDDEN", W.noteNotYours) });
    await article();
    fireEvent.click(await screen.findByRole("button", { name: /^I've checked it/u }));
    expect((await screen.findAllByRole("alert")).map((one) => one.textContent)).toContain(W.noteNotYours);
    k.close();
  });

  it("a maintainer opens the questions list from the navigation: topics, who-asked counts, the day, in plain text, no name", async () => {
    const f = mount();
    await article();
    fireEvent.click(await screen.findByTestId("wiki-gaps-link"));
    const list = within(await screen.findByTestId("wiki-gaps"));
    expect(list.getByText("How do refunds work")).toBeTruthy();
    expect(list.getByText(/Answered partly\. Asked by 2 people, 3 times; last on 2026-11-17\./u)).toBeTruthy();
    expect(list.getByText("Where is the <b>retry</b> policy")).toBeTruthy();
    expect(list.getByText(/Not found\. Asked by 1 person, 1 time/u)).toBeTruthy();
    expect(document.querySelector("[data-testid=wiki-gaps] b b")).toBeNull();
    await expectNoAxeViolations(f.container);
    f.close();
  });

  it("is not offered to a contributor, says when there is nothing or the list was cut, and a refusal reads in fixed words", async () => {
    const c = mount({ role: "contributor" });
    await article();
    await screen.findByTestId("wiki-add-note");
    expect(screen.queryByTestId("wiki-gaps-link")).toBeNull();
    c.close();
    const f = mount({ gaps: () => json(200, { project: "payments", more: false, items: [] }) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-gaps-link"));
    expect(await screen.findByTestId("wiki-gaps-empty")).toBeTruthy();
    f.close();
    const g = mount({ gaps: () => json(200, { project: "payments", more: true, items: [{ topic: "t", kind: "wiki_empty", people: 1, questions: 1, lastAskedAt: "2026-11-17" }] }) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-gaps-link"));
    expect(await screen.findByTestId("wiki-gaps-more")).toBeTruthy();
    g.close();
    const k = mount({ gaps: () => refuse(403, "FORBIDDEN", W.needsMaintainer) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-gaps-link"));
    expect((await screen.findByTestId("wiki-gaps-error")).textContent).toBe(W.needsMaintainer);
    k.close();
  });
});

describe("the disputed list", () => {
  it("opens from the navigation for a maintainer, names the claim, who and why; closing the marks sends the page's resolve", async () => {
    const f = mount();
    await article();
    fireEvent.click(await screen.findByTestId("wiki-disputed-link"));
    const list = within(await screen.findByTestId("wiki-disputed"));
    expect(list.getByText("Charges go through chargeCustomer.")).toBeTruthy();
    expect(list.getByText(/Priya/u)).toBeTruthy();
    expect(list.getByText(/It moved to charge_v2\.ts/u)).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Close the marks on this page" }));
    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]).toMatchObject({ method: "POST", path: "/v1/app/projects/payments/wiki/pages/beacon-api--billing/flags/resolve" });
    expect(await screen.findByTestId("wiki-disputed-closed")).toBeTruthy();
    f.close();
  });

  it("says when nothing is disputed and when the list was cut; a refusal reads in fixed words", async () => {
    const f = mount({ disputed: () => json(200, { project: "payments", more: false, items: [] }) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-disputed-link"));
    expect(await screen.findByTestId("wiki-disputed-empty")).toBeTruthy();
    f.close();
    const g = mount({ disputed: () => json(200, { project: "payments", more: true, items: [{ flagId: "flag-0009", pageId: BILLING, pageTitle: "billing", markedBy: "Priya", markedAt: "2026-11-16T10:00:00.000Z" }] }) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-disputed-link"));
    expect(await screen.findByTestId("wiki-disputed-more")).toBeTruthy();
    g.close();
    const k = mount({ disputed: () => refuse(403, "FORBIDDEN", W.needsMaintainer) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-disputed-link"));
    expect((await screen.findByTestId("wiki-disputed-error")).textContent).toBe(W.needsMaintainer);
    k.close();
  });
});

describe("untrusted text and accessibility", () => {
  it("a note and a reason are drawn as plain text, never as markup or a link", async () => {
    const evil = "<img src=x onerror=alert(1)> [click](https://evil.example) ‮evil";
    const f = mount({ disputed: () => json(200, { project: "payments", more: false, items: [{ flagId: "flag-0009", pageId: BILLING, pageTitle: "billing", markedBy: "Priya", markedAt: "2026-11-16T10:00:00.000Z", reason: evil }] }) });
    await article();
    fireEvent.click(await screen.findByTestId("wiki-disputed-link"));
    const list = await screen.findByTestId("wiki-disputed");
    expect(list.querySelector("img")).toBeNull();
    expect(list.querySelector('a[href^="https://evil"]')).toBeNull();
    expect(list.textContent).toContain("<img src=x");
    f.close();
  });

  it("the page with its correction controls has no accessibility violations; Mark wrong is reachable by keyboard", async () => {
    const f = mount();
    await article();
    await screen.findByTestId("wiki-add-note");
    await expectNoAxeViolations(document.body);
    const first = screen.getAllByRole("button", { name: /^Mark wrong/ })[0]!;
    first.focus();
    expect(document.activeElement).toBe(first);
    f.close();
  });
});
