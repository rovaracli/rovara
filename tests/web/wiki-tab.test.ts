// @vitest-environment jsdom
// Lead 4 slice W5: the project Wiki tab, read from Code's wiki routes (W2) through Cloud. Tree, one page at reading width, numbered sources in a popover, one freshness
// chip, a thin note only on the paragraph that needs it, pinned notes (read only), search over titles and summaries, empty and edge states, fixed refusal words, and the
// untrusted-text rule (wiki text is drawn as plain text, never as markup or a link). No Mark wrong or Add a note control exists until C1 wires it.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { WikiTab } from "../../packages/ui/src/screens/project/wiki/WikiTab.js";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { wikiOffered } from "../../packages/ui/src/api/wiki.js";
import { hostLink } from "../../packages/ui/src/screens/project/wiki/wiki-model.js";
import { chipOf, dotOf, treeOf } from "../../packages/ui/src/screens/project/wiki/wiki-text.js";
import { WIKI_WORDS } from "@agentx/contracts/web";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { projectFixture } from "./support/project-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { commitOf, wikiIndex, wikiPage, wikiSources, type WikiFixtureOptions } from "./support/wiki-fixture.js";

const LEAK = "SENSITIVE-SERVER-DETAIL";
const WORDS = WIKI_WORDS;
const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refusal = (status: number, code: string, message: string) => json(status, { error: { code, message } });

interface Options { state?: WikiFixtureOptions["state"]; index?: () => ApiResponse; page?: (id: string) => ApiResponse | undefined; sources?: () => ApiResponse; initial?: string; repositories?: Array<{ name?: string; fullName: string; defaultBranch: string }> }
function Where() { const location = useLocation(); return h("output", { "data-testid": "where" }, location.pathname + location.search); }
function mount(options: Options = {}, element: "tab" | "screen" = "tab") {
  const overview = projectFixture();
  overview.project.repositories = options.repositories ?? [{ name: "beacon-api", fullName: "acme/beacon-api", defaultBranch: "main" }];
  const f = fakeHost(async (request: ApiRequest) => {
    const path = request.path;
    if (path === "/v1/app/projects/payments/wiki") return options.index?.() ?? json(200, wikiIndex("payments", { ...(options.state === undefined ? {} : { state: options.state }) }));
    const page = /^\/v1\/app\/projects\/payments\/wiki\/pages\/([^/]+)$/u.exec(path);
    if (page !== null) return options.page?.(page[1]!) ?? (() => { const one = wikiPage("payments", page[1]!); return one === undefined ? refusal(404, "NOT_FOUND", WORDS.noPage) : json(200, one); })();
    const sources = /^\/v1\/app\/projects\/payments\/wiki\/pages\/([^/]+)\/sources$/u.exec(path);
    if (sources !== null) return options.sources?.() ?? (() => { const one = wikiSources("payments", sources[1]!); return one === undefined ? refusal(404, "NOT_FOUND", WORDS.noPage) : json(200, one); })();
    if (path === "/v1/app/projects/payments/overview") return json(200, overview);
    return refusal(404, "NOT_FOUND", "route not found");
  });
  const query = createQueryClient();
  const body = element === "tab" ? h(WikiTab, { project: "payments" }) : h(ProjectScreen);
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.initial ?? "/app/projects/payments?tab=wiki"], children: h("div", null, h(Routes, null, h(Route, { path: "/app/projects/:name", element: body })), h(Where)) }) }) }), { theme: "light" });
  return { ...f, ...ui, calls: (suffix: string) => f.request.mock.calls.map(([request]) => request).filter((request) => request.path.endsWith(suffix)), close() { ui.unmount(); query.clear(); } };
}
const article = async () => within(await screen.findByTestId("wiki-page"));

describe("the page tree and a page", () => {
  it("shows the project pages, then each repo with its modules, and opens the overview with one meta line and one chip", async () => {
    const f = mount();
    const a = await article();
    expect(a.getByRole("heading", { level: 2, name: "Product overview" })).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "Wiki pages" }));
    for (const name of ["Product overview", "How the repos connect", "Glossary", "beacon-api", "billing", "beacon-agents", "beacon-legacy"]) expect(nav.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    expect(nav.getByRole("button", { name: /^Product overview/ }).getAttribute("aria-current")).toBe("page");
    const meta = screen.getByTestId("wiki-meta");
    expect(meta.textContent).toMatch(/^Written by Rovara from the code\|as of 4 commits, one per repo, \d+d ago1 of 5 cited claims may be out of date$/u);
    expect(within(meta).getAllByText(/cited claims may be out of date|Up to date|Out of date/u)).toHaveLength(1);
    expect(screen.getByTestId("wiki-truth").textContent).toContain("Written by Rovara from the code. It can be wrong. The code is the truth.");
    expect(screen.queryByText(/verified/iu)).toBeNull();
    // A page shown as the tab opens does not take focus from the tab.
    expect(document.activeElement?.id).not.toBe("rv-wiki-title");
    f.close();
  });

  it("opens another page from the tree, moves focus to its title and keeps the page in the address", async () => {
    const f = mount();
    await article();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Wiki pages" })).getByRole("button", { name: /^billing/ }));
    await waitFor(() => expect(screen.getByTestId("wiki-page").getAttribute("data-page")).toBe("beacon-api--billing"));
    expect(screen.getByTestId("where").textContent).toContain("page=beacon-api--billing");
    await waitFor(() => expect(document.activeElement?.id).toBe("rv-wiki-title"));
    expect(within(screen.getByTestId("wiki-page")).getByText("beacon-api", { selector: ".rv-wiki-crumb" })).toBeTruthy();
    f.close();
  });

  it("opens the page named in the address, and the first page when the address names one that is not there", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=glossary" });
    expect(within(await screen.findByTestId("wiki-page")).getByRole("heading", { level: 2, name: "Glossary" })).toBeTruthy();
    f.close();
    const g = mount({ initial: "/app/projects/payments?tab=wiki&page=nothing-here" });
    expect(within(await screen.findByTestId("wiki-page")).getByRole("heading", { level: 2, name: "Product overview" })).toBeTruthy();
    g.close();
  });

  it("builds its tree from parents and order, and its dots and chips from the claim counts", () => {
    const pages = wikiIndex("payments").pages;
    const tree = treeOf([...pages].reverse());
    expect(tree.project.map((p) => p.pageId)).toEqual(["overview", "connections", "glossary"]);
    expect(tree.repos.map((r) => [r.page.pageId, r.children.map((c) => c.pageId)])).toEqual([["repo-beacon-api", ["beacon-api--billing"]], ["repo-beacon-agents", []], ["repo-beacon-legacy", []]]);
    expect(chipOf({ found: 10, changed: 0 })).toMatchObject({ tone: "ok", short: "Up to date" });
    expect(chipOf({ found: 9, changed: 3 })).toMatchObject({ tone: "warn", short: "3 of 12 cited claims may be out of date" });
    expect(chipOf({ found: 1, changed: 1 })).toMatchObject({ tone: "bad", short: "Out of date" });
    expect(dotOf({ claims: { found: 3, changed: 0 }, flagged: false })).toBeUndefined();
    expect(dotOf({ claims: { found: 3, changed: 0 }, flagged: true })?.words).toBe("Marked wrong");
  });

  it("scrolls to a section from 'On this page', and the rail says how the page was written", async () => {
    const f = mount();
    await article();
    const rail = within(screen.getByRole("complementary", { name: "About this page" }));
    expect(rail.getByRole("navigation", { name: "On this page" })).toBeTruthy();
    fireEvent.click(rail.getByRole("button", { name: "Where the docs and the code disagree" }));
    expect(rail.getByText("Written by Rovara from the code. It can be wrong. The code is the truth.")).toBeTruthy();
    expect(rail.getByText("beacon-agents")).toBeTruthy();
    f.close();
  });
});

describe("numbered sources", () => {
  it("numbers sources in reading order and opens one in a popover: file, lines, commit, 'Source found' and a link built from the project's own repository", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=beacon-api--billing" });
    const a = await article();
    const first = a.getAllByRole("button", { name: /^Source 1: beacon-api\/src\/billing\/charge\.ts, lines 42-67$/u })[0]!;
    expect(first.textContent).toBe("1");
    fireEvent.click(first);
    const pop = await screen.findByRole("dialog", { name: "Source 1" });
    expect(within(pop).getByText("beacon-api/src/billing/charge.ts")).toBeTruthy();
    expect(pop.textContent).toContain(commitOf("beacon-api").slice(0, 7));
    expect(within(pop).getByText("Source found")).toBeTruthy();
    const link = within(pop).getByRole("link", { name: "Open on the code host" });
    expect(link.getAttribute("href")).toBe(`https://github.com/acme/beacon-api/blob/${commitOf("beacon-api")}/src/billing/charge.ts#L42-L67`);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    f.close();
  });

  it("gives no link for a repository the project does not list, and says plainly when a source changed", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=beacon-api--billing", repositories: [{ name: "other", fullName: "acme/other", defaultBranch: "main" }] });
    const a = await article();
    fireEvent.click(a.getAllByRole("button", { name: /^Source 2: beacon-api\/src\/billing\/refund\.ts, lines 12-40$/u })[0]!);
    const pop = await screen.findByRole("dialog", { name: "Source 2" });
    expect(within(pop).queryByRole("link")).toBeNull();
    expect(within(pop).getByText("A file this claim cites changed since the page was written. The claim may be out of date.")).toBeTruthy();
    f.close();
  });

  it("builds a code-host link only from a listed repository, with the path and lines encoded", () => {
    const cite = { repo: "beacon-api", path: "src/a b/c#d.ts", commit: "a".repeat(40), line: 3 };
    expect(hostLink([{ name: "beacon-api", fullName: "acme/beacon-api" }], cite)).toBe(`https://github.com/acme/beacon-api/blob/${"a".repeat(40)}/src/a%20b/c%23d.ts#L3`);
    expect(hostLink([{ name: "beacon-api", fullName: "acme/beacon-api" }], { ...cite, lineEnd: 9 })).toMatch(/#L3-L9$/u);
    expect(hostLink([], cite)).toBeUndefined();
    expect(hostLink([{ fullName: "acme/beacon-api" }], cite)).toBeUndefined();
    expect(hostLink([{ name: "beacon-api", fullName: "acme/../evil" }], cite)).toBeUndefined();
    expect(hostLink([{ name: "beacon-api", fullName: "javascript:alert(1)//x" }], cite)).toBeUndefined();
  });

  it("lists a page's cited files only when the fold is opened, once", async () => {
    const f = mount();
    await article();
    expect(f.calls("/sources")).toHaveLength(0);
    const fold = screen.getByText("Relevant source files").closest("details")!;
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    await screen.findByText(/beacon-web\/src\/routes\/index\.tsx/u);
    expect(f.calls("/sources")).toHaveLength(1);
    expect(screen.getByText(/beacon-legacy\/app\/Jobs\/CreateInvoice\.php/u)).toBeTruthy();
    f.close();
  });

  it("says the cited files could not be read in fixed words when that read fails", async () => {
    const f = mount({ sources: () => refusal(403, "FORBIDDEN", LEAK) });
    await article();
    const fold = screen.getByText("Relevant source files").closest("details")!;
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    expect((await screen.findByRole("alert")).textContent).toBe("The cited files could not be read just now.");
    expect(document.body.textContent).not.toContain(LEAK);
    f.close();
  });
});

describe("what needs a warning, and only there", () => {
  it("puts a thin note on the paragraph whose source changed, is not found or was marked wrong, and on no other", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=beacon-api--billing" });
    const a = await article();
    expect(a.getAllByText("May be stale.")).toHaveLength(2);
    expect(a.getByText("A file this paragraph cites changed since this page was written.")).toBeTruthy();
    expect(a.getByRole("region", { name: "Pinned notes" })).toBeTruthy();
    expect(a.getByText("A source was not found when this was last checked.")).toBeTruthy();
    expect(a.getAllByText("Marked wrong.")).toHaveLength(1);
    const wrong = a.getByText("Refund amounts are rounded to the nearest 5 cents.").closest(".rv-wiki-para")!;
    expect(wrong.className).toContain("rv-wiki-struck");
    const fine = a.getByText(/^Charges go through/u).closest(".rv-wiki-para")!;
    expect(fine.querySelector(".rv-wiki-pnote")).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    f.close();
  });

  it("shows pinned notes read only: a pending note says agents wait for a maintainer, an approved one says it is pinned for both; no write control exists", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=beacon-api--billing" });
    const a = await article();
    const pending = a.getByRole("group", { name: "Note from Priya" });
    expect(pending.textContent).toContain("Agents get it after a maintainer approves it.");
    expect(pending.textContent).toContain("Always run the refund tests before changing refund.ts.");
    const approved = a.getByRole("group", { name: "Note from Sam" });
    expect(approved.textContent).toContain("Pinned for people and agents.");
    expect(approved.textContent).toContain("beacon-api/src/billing/webhooks.ts");
    for (const name of [/mark wrong/iu, /add a note/iu, /pin note/iu, /^ask/iu]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /note|ask/iu })).toBeNull();
    f.close();
  });

  it("says once, above the page, that a page marked wrong is hidden from agents, and warns when most claims changed", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=repo-beacon-agents" });
    const a = await article();
    expect(a.getByText("Someone marked this page wrong. It is hidden from agents until the next refresh rewrites it.")).toBeTruthy();
    expect(within(screen.getByTestId("wiki-meta")).getByText("Out of date")).toBeTruthy();
    f.close();
  });

  it("draws a diagram as plain text in a fold and never as a picture", async () => {
    const f = mount();
    const a = await article();
    const fold = a.getByText("Diagram (text form)").closest("details")!;
    expect(fold.querySelector("pre")?.textContent).toContain("flowchart LR");
    expect(a.queryByRole("img")).toBeNull();
    expect(document.querySelector("svg[role=img], iframe, script")).toBeNull();
    f.close();
  });
});

describe("wiki text is untrusted", () => {
  it("draws markup, links and script-looking text as plain text, and hidden characters as visible marks", async () => {
    const hostile = wikiPage("payments", "overview")!;
    hostile.page.title = "Title <b>bold</b>";
    hostile.page.blocks[1] = { kind: "paragraph", blockId: "p-glance-1", text: "<img src=x onerror=alert(1)> [click](javascript:alert(1)) <a href=\"https://evil.example\">go</a> `code <script>`", claimIds: [] };
    hostile.notes = [{ noteId: "note-x1", text: "<iframe src=//evil></iframe>", author: "<i>Eve</i>", createdAt: "2026-11-16T00:00:00.000Z", approval: "pending" }];
    const f = mount({ page: () => json(200, hostile) });
    const a = await article();
    expect(a.getByRole("heading", { level: 2 }).textContent).toBe("Title <b>bold</b>");
    expect(a.getByText(/<img src=x onerror=alert\(1\)>/u)).toBeTruthy();
    expect(document.querySelector("img, iframe, script")).toBeNull();
    expect([...document.querySelectorAll("b, i")].map((node) => node.textContent)).not.toContain("bold");
    expect(document.querySelectorAll("article a").length).toBe(0);
    expect(a.getByText("code <script>").tagName).toBe("CODE");
    f.close();
  });

  it("draws a hidden or control character in a title as a visible mark, not as itself", async () => {
    const odd = wikiIndex("payments");
    odd.pages[0]!.title = "Over" + String.fromCharCode(0x202e) + "view";
    const f = mount({ index: () => json(200, odd) });
    // The index title is a plain string in Code's contract, so the tab reads it; the hidden character is drawn as a visible mark and never as itself.
    await article();
    expect(screen.getAllByText("Over[U+202E]view").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x202e));
    f.close();
  });
});

describe("search", () => {
  it("looks through titles and summaries, shows the match, opens the page and clears itself", async () => {
    const f = mount();
    await article();
    const box = screen.getByRole("searchbox", { name: "Search the wiki" });
    fireEvent.change(box, { target: { value: "refund" } });
    const results = within(await screen.findByTestId("wiki-results"));
    expect(results.getByRole("heading", { level: 2, name: "refund" })).toBeTruthy();
    const hit = results.getByRole("button", { name: /beacon-api \/ billing/u });
    expect(hit.querySelector("mark")?.textContent?.toLowerCase()).toBe("refund");
    fireEvent.click(hit);
    await waitFor(() => expect(screen.getByTestId("wiki-page").getAttribute("data-page")).toBe("beacon-api--billing"));
    expect((screen.getByRole<HTMLInputElement>("searchbox", { name: "Search the wiki" })).value).toBe("");
    f.close();
  });

  it("says so when nothing matches, and never guesses", async () => {
    const f = mount();
    await article();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the wiki" }), { target: { value: "zzzqqq" } });
    expect((await screen.findByText("No page mentions that. The wiki does not guess. Try another word.")).textContent).toBeTruthy();
    f.close();
  });
});

describe("empty and edge states", () => {
  it("no wiki yet: one calm sentence, no tree, no search", async () => {
    const f = mount({ state: "none" });
    const empty = within(await screen.findByTestId("wiki-empty"));
    expect(empty.getByRole("heading", { name: "No wiki yet" })).toBeTruthy();
    expect(empty.getByText(/A project admin builds the wiki on Project setup/u)).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(await (async () => { await expectNoAxeViolations(document.body); return true; })()).toBe(true);
    f.close();
  });

  it("a build is running: says pages show when it ends", async () => {
    const f = mount({ state: "building" });
    expect(within(await screen.findByTestId("wiki-empty")).getByRole("heading", { name: "The wiki is being built" })).toBeTruthy();
    f.close();
  });

  it("a build that stopped before any page says why, in fixed words", async () => {
    const stopped = wikiIndex("payments", { state: "none" });
    const f = mount({ index: () => json(200, { ...stopped, lastBuild: { buildId: "build-0009", kind: "first", state: "stopped", startedAt: "2026-11-17T00:00:00.000Z", endedAt: "2026-11-17T00:10:00.000Z", stopReason: "no_ai_key" } }) });
    const empty = within(await screen.findByTestId("wiki-empty"));
    expect(empty.getByText("The last build did not run: no AI key is connected.")).toBeTruthy();
    f.close();
  });

  it("pages exist and the last build stopped at its cap: one quiet line in the nav", async () => {
    const f = mount({ state: "stopped" });
    expect((await screen.findByTestId("wiki-build-notice")).textContent).toBe("The last build stopped at its cost limit.");
    f.close();
  });

  it("a refusal or failure reads in Cloud's fixed words, never the server's own text, with Try again for a failure", async () => {
    const f = mount({ index: () => refusal(403, "FORBIDDEN", WORDS.forbidden) });
    expect((await screen.findByTestId("wiki-error")).textContent).toBe(WORDS.forbidden);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    f.close();
    const g = mount({ index: () => refusal(403, "FORBIDDEN", LEAK) });
    expect((await screen.findByTestId("wiki-error")).textContent).toBe(WORDS.unavailable);
    expect(document.body.textContent).not.toContain(LEAK);
    g.close();
  });

  it("a page that is gone says so, without a retry; a page that fails to load offers one, and never shows the server's words", async () => {
    const gone = mount({ page: () => refusal(404, "NOT_FOUND", LEAK) });
    expect((await screen.findByTestId("wiki-page-error")).textContent).toBe("That page isn't in this wiki.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(document.body.textContent).not.toContain(LEAK);
    gone.close();
    const down = mount({ page: () => refusal(403, "X", LEAK) });
    expect((await screen.findByTestId("wiki-page-error")).textContent).toBe(WORDS.unavailable);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(LEAK);
    down.close();
  });

  it("an answer that does not read shows the unreadable-response words, not the answer", async () => {
    const f = mount({ page: () => json(200, { project: "payments", page: { title: "x" } }) });
    const alert = await screen.findByTestId("wiki-page-error");
    expect(alert.textContent).toBe(WORDS.unavailable);
    f.close();
  });
});

describe("review fixes", () => {
  it("drops a cited file at a commit the page was not written from, and lists a file Code names twice twice without a key clash", async () => {
    const good = wikiSources("payments", "beacon-api--billing")!;
    const odd = { ...good, files: [{ ...good.files[0]!, commit: "f".repeat(40) }, good.files[1]!, good.files[1]!] };
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=beacon-api--billing", sources: () => json(200, odd) });
    await article();
    const fold = screen.getByText("Relevant source files").closest("details")!;
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    await within(fold).findAllByText(/src\/billing\/refund\.ts/u);
    expect(within(fold).queryByText(/src\/billing\/charge\.ts/u)).toBeNull();
    expect(fold.querySelectorAll("li")).toHaveLength(2);
    f.close();
  });

  it("search finds the match on the original text, with regular-expression characters in the query taken literally, and announces the count", async () => {
    const f = mount();
    await article();
    const box = screen.getByRole("searchbox", { name: "Search the wiki" });
    fireEvent.change(box, { target: { value: "(" } });
    expect((await screen.findByText("No page mentions that. The wiki does not guess. Try another word.")).textContent).toBeTruthy();
    expect(within(screen.getByTestId("wiki-results")).getByRole("status").textContent).toBe("0 pages match");
    fireEvent.change(box, { target: { value: "REFUND" } });
    await waitFor(() => expect(within(screen.getByTestId("wiki-results")).getByRole("status").textContent).toMatch(/^\d+ pages? match(es)?$/u));
    expect(within(screen.getByTestId("wiki-results")).getByRole("status").textContent).not.toBe("0 pages match");
    f.close();
  });

  it("a deep link to the Wiki tab does not show Overview first", async () => {
    const f = mount({}, "screen");
    await screen.findByRole("heading", { name: "payments" });
    expect(screen.queryByRole("heading", { name: "Running now" })).toBeNull();
    expect(await screen.findByTestId("wiki")).toBeTruthy();
    f.close();
  });

  it("shows a pinned note whose author name is not readable as 'a former member'", async () => {
    const page = wikiPage("payments", "beacon-api--billing")!;
    page.notes = [{ ...page.notes[0]!, author: "a former member" }];
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=beacon-api--billing", page: () => json(200, page) });
    expect((await article()).getByRole("group", { name: "Note from a former member" })).toBeTruthy();
    f.close();
  });
});

describe("the tab on the project page", () => {
  it("is offered when Code serves a wiki, opens from the address, and is hidden when Code has none or the person has none", async () => {
    const on = mount({}, "screen");
    expect(await screen.findByRole("tab", { name: "Wiki" })).toBeTruthy();
    expect(await screen.findByTestId("wiki")).toBeTruthy();
    on.close();
    for (const answer of [refusal(501, "NOT_ON_CODE_YET", WORDS.notYet), refusal(404, "NOT_FOUND", WORDS.notFound), refusal(403, "FORBIDDEN", WORDS.forbidden)]) {
      const off = mount({ index: () => answer, initial: "/app/projects/payments?tab=wiki" }, "screen");
      await screen.findByRole("heading", { name: "payments" });
      await waitFor(() => expect(off.calls("/wiki").length).toBeGreaterThan(0));
      expect(screen.queryByRole("tab", { name: "Wiki" })).toBeNull();
      expect(screen.queryByTestId("wiki")).toBeNull();
      off.close();
    }
  });

  it("is kept, with its error and Try again, when the list could not be read for a reason worth retrying, and dropped for a 4xx or a Code with no wiki", () => {
    const failed = (status: number, code = "X") => ({ isSuccess: false, isError: true, error: new ApiError(status, code, "x") });
    expect(wikiOffered({ isSuccess: true, isError: false, error: null })).toBe(true);
    expect(wikiOffered(failed(503))).toBe(true);
    expect(wikiOffered(failed(0, "NETWORK_ERROR"))).toBe(true);
    for (const status of [400, 403, 404]) expect(wikiOffered(failed(status)), String(status)).toBe(false);
    expect(wikiOffered(failed(501, "NOT_ON_CODE_YET"))).toBe(false);
    expect(wikiOffered({ isSuccess: false, isError: false, error: null })).toBe(false);
  });
});

describe("accessibility", () => {
  it("a page has no axe violations, its tree is real buttons, and its popover markers are labelled buttons", async () => {
    const f = mount({ initial: "/app/projects/payments?tab=wiki&page=beacon-api--billing" });
    await article();
    await expectNoAxeViolations(document.body);
    for (const button of screen.getAllByRole("button", { name: /^Source \d+:/u })) expect(button.getAttribute("aria-label")).toMatch(/^Source \d+: .+, (line|lines) /u);
    f.close();
  });
});
