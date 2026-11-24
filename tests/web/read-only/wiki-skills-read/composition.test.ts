// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { mount } from "./test-support.js";
import { reply } from "./fixtures.js";

const fail = (status: number) => ({ status, body: { error: { code: status === 501 ? "NOT_ON_CODE_YET" : status === 503 ? "UNAVAILABLE" : "FORBIDDEN", message: "unsafe raw server text" } } });
const noWrites = (container: HTMLElement) => expect(container.querySelectorAll("form, textarea, [type=submit], [role=switch], [contenteditable=true]")).toHaveLength(0);

it("Wiki index: header, one chip per row from served facts, All pages list and the trust line", async () => {
 const f = mount();
 try {
  await screen.findByRole("link", { name: "Product overview" });
  expect(screen.getByRole("heading", { level: 1, name: "web" })).toBeTruthy();
  expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Wiki").getAttribute("aria-current")).toBe("page");
  const row = within(screen.getByRole("list", { name: "All pages" })).getByRole("listitem");
  expect(within(row).getByText("Disputed")).toBeTruthy();
  expect(within(row).getByText("Source changed")).toBeTruthy();
  expect(within(row).queryByText("Sources found")).toBeNull();
  expect(screen.getByText(/The code is the truth/)).toBeTruthy();
  noWrites(f.container);
 } finally { f.close(); }
});
it("Wiki page: sections with their claims and sources, disputed section outlined, no write controls", async () => {
 const f = mount("/app/projects/web?tab=wiki&page=overview");
 try {
  await screen.findByText("Private page text: requests enter the API.");
  expect(screen.getByRole("heading", { name: "The system at a glance" })).toBeTruthy();
  const section = screen.getByText("Private page text: requests enter the API.").closest("section");
  expect(section?.getAttribute("data-tone")).toBe("attention");
  expect(within(section as HTMLElement).getByText("Requests enter the API")).toBeTruthy();
  expect(within(section as HTMLElement).getByText("beacon-api/src/server.ts · line 22")).toBeTruthy();
  expect(screen.getByText("1 open disputed mark")).toBeTruthy();
  noWrites(f.container);
 } finally { f.close(); }
});
it("Skills: the newer version waits under Waiting for a decision while the version in use stays in the In use table", async () => {
 const f = mount("/app/projects/web?tab=skills");
 try {
  await screen.findAllByRole("button", { name: "Open safe-retries" });
  const waiting = within(screen.getByRole("list", { name: "Waiting for a decision" }));
  expect(waiting.getByText("Version 2 to review")).toBeTruthy();
  expect(waiting.getByText("1 of 2 approvals · you approved")).toBeTruthy();
  const row = within(screen.getByRole("table", { name: "Skills in use" })).getByRole("row", { name: /safe-retries/ });
  expect(within(row).getByText("v1")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Retired" })).toBeTruthy();
  noWrites(f.container);
 } finally { f.close(); }
});
it("a failed read shows the 4e error block with Load again and a copyable reference, never raw server text", async () => {
 const f = mount("/app/projects/web?tab=wiki", r => r.path.endsWith("/wiki") ? fail(503) : reply(r));
 try {
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Rovara couldn't read this page")).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Load again" })).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Copy reference" })).toBeTruthy();
  expect(within(alert).getByText("WIKI-INDEX-READ-FAILED")).toBeTruthy();
  expect(screen.queryByText(/unsafe raw/)).toBeNull();
  expect(screen.queryByText("Product overview")).toBeNull();
  noWrites(f.container);
 } finally { f.close(); }
});
it.each([501])("an unavailable (%s) read is one held line, not an error block or retry", async status => {
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => r.path.endsWith("/wiki") ? fail(status) : reply(r));
 try {
  const line = (await screen.findByText(/Can't tell yet/)).closest("[role=status]") as HTMLElement;
  expect(line).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: /load again|try again/i })).toBeNull();
  expect(within(line).getByRole("link", { name: "Back to Wiki" })).toBeTruthy();
 } finally { f.close(); }
});
const accessEnded = async () => {
 const alert = await screen.findByRole("alert");
 expect(within(alert).getByRole("heading", { name: "Access ended" })).toBeTruthy();
 for (const heading of ["What happened", "What is safe", "What to do"]) expect(within(alert).getByText(heading)).toBeTruthy();
 expect(within(alert).getByText("WIKI-ACCESS-ENDED")).toBeTruthy();
 expect(within(alert).getByRole("button", { name: "Load again" })).toBeTruthy();
 expect(within(alert).getByRole("button", { name: "Copy reference" })).toBeTruthy();
 // One frame for every page: breadcrumb, project tabs and pills, and never the project name.
 expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
 expect(screen.getByRole("navigation", { name: "Project sections" })).toBeTruthy();
 expect(screen.getByRole("navigation", { name: "How we work" })).toBeTruthy();
 expect(screen.queryByRole("heading", { level: 1, name: "web" })).toBeNull();
 expect(screen.queryByText("web")).toBeNull();
 return alert;
};
it("a refused read shows the Access ended 4e block and nothing private", async () => {
 const f = mount("/app/projects/web?tab=skills", r => r.path.endsWith("/skills") ? fail(403) : reply(r));
 try {
  await accessEnded();
  expect(screen.queryByText("safe-retries")).toBeNull();
  noWrites(f.container);
 } finally { f.close(); }
});
it("Access ended is one form on the wiki, the open skill and the ask slot, and Load again re-reads", async () => {
 let refused = true;
 const wiki = mount("/app/projects/web?tab=wiki", r => refused && r.path.endsWith("/wiki") ? fail(403) : reply(r));
 try {
  await accessEnded();
  expect(screen.queryByText("Product overview")).toBeNull();
  refused = false;
  fireEvent.click(screen.getByRole("button", { name: "Load again" }));
  await screen.findByRole("link", { name: "Product overview" });
 } finally { wiki.close(); }
 const ask = mount("/app/projects/web", r => r.path === "/v1/app/me" ? fail(403) : reply(r), undefined, "answer");
 try { await accessEnded(); } finally { ask.close(); }
 const skill = mount("/app/projects/web?tab=skills", r => r.path.includes("/skills/") ? fail(403) : reply(r));
 try {
  fireEvent.click((await screen.findAllByRole("button", { name: "Open safe-retries" }))[0]!);
  await accessEnded();
  expect(screen.queryByText("Bound retries before sending")).toBeNull();
 } finally { skill.close(); }
});
it("the corrections read failure has its own text and reference", async () => {
 const f = mount("/app/projects/web?tab=wiki&view=disputed", r => r.path.endsWith("/wiki") ? fail(503) : reply(r));
 try {
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("WIKI-CORRECTIONS-READ-FAILED")).toBeTruthy();
  expect(within(alert).getByText(/Rovara did not return the wiki corrections/)).toBeTruthy();
 } finally { f.close(); }
});
it("shared policy: on 5xx, the page stays with one 'Updated HH:MM · Reconnecting' line and no header meta", async () => {
 let failing = false;
 const f = mount("/app/projects/web?tab=skills", r => failing && r.path.endsWith("/skills") ? fail(503) : reply(r));
 try {
  await screen.findAllByRole("button", { name: "Open safe-retries" });
  failing = true;
  await act(async () => { await f.client.refetchQueries({ queryKey: ["g3"] }); });
  const line = await screen.findByText(/^Updated .* · Reconnecting$/);
  expect(line).toBeTruthy();
  expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Open safe-retries" }).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Read from Rovara/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  // A refusal still wipes earlier details, whatever the policy keeps.
  failing = false;
  const denied = mount("/app/projects/web?tab=skills", r => r.path.endsWith("/skills") && failing ? fail(403) : reply(r));
  await screen.findAllByRole("button", { name: "Open safe-retries" });
  failing = true;
  await act(async () => { await denied.client.refetchQueries({ queryKey: ["g3"] }); });
  expect((await screen.findAllByRole("heading", { name: "Access ended" })).length).toBeGreaterThan(0);
  fireEvent.click(document.body);
  denied.close();
 } finally { f.close(); }
});

it("Project frame: the sections row and How we work pills sit under the header with the current ones marked", async () => {
 const f = mount("/app/projects/web?tab=skills");
 try {
  await screen.findAllByRole("button", { name: "Open safe-retries" });
  const tabs = within(screen.getByRole("navigation", { name: "Project sections" }));
  expect(tabs.getAllByRole("link").map(link => link.textContent)).toEqual(["Tasks", "How we work", "People", "Setup", "Settings"]);
  expect(tabs.getByRole("link", { name: "How we work" }).getAttribute("aria-current")).toBe("page");
  const pills = within(screen.getByRole("navigation", { name: "How we work" }));
  expect(pills.getByRole("link", { name: "Skills" }).getAttribute("aria-current")).toBe("page");
  expect(pills.getByRole("link", { name: "Wiki" }).getAttribute("aria-current")).toBeNull();
  noWrites(f.container);
 } finally { f.close(); }
});
it("Wiki index search: a results bar over the matches, All pages kept below, Clear empties the search", async () => {
 const f = mount();
 try {
  await screen.findByRole("link", { name: "Product overview" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search the wiki" }), { target: { value: "overview" } });
  const bar = await screen.findByRole("status");
  // From two characters on Code's full-text search answers (after a short pause), as the old Wiki tab did.
  expect(await within(bar).findByText(/1 result for “overview”/)).toBeTruthy();
  expect(f.calls.some(r => r.path.includes("/wiki/search?q=overview"))).toBe(true);
  expect(within(screen.getByRole("list", { name: "Search results" })).getByRole("link", { name: "Product overview" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "All pages" })).getByRole("link", { name: "Product overview" })).toBeTruthy();
  fireEvent.click(within(bar).getByRole("button", { name: "Clear" }));
  expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  noWrites(f.container);
 } finally { f.close(); }
});
it("Wiki index: Scope and build and Existing answers open read views of the same tab, with no ask control", async () => {
 const f = mount();
 try {
  fireEvent.click(await screen.findByRole("link", { name: "Scope and build" }));
  await screen.findByRole("heading", { name: "What the wiki is built from" });
  expect(f.router.state.location.search).toContain("view=setup");
  await act(async () => { await f.router.navigate(-1); });
  fireEvent.click(await screen.findByRole("link", { name: "Existing answers" }));
  await screen.findByText("Existing answer: Can't tell yet.");
  expect(f.router.state.location.search).toContain("view=ask");
  expect(screen.queryByRole("button", { name: /ask/i })).toBeNull();
  noWrites(f.container);
 } finally { f.close(); }
});
it("Wiki corrections: disputed cards first, then the gaps, then one held line for decided corrections", async () => {
 const f = mount("/app/projects/web?tab=wiki&view=disputed");
 try {
  await screen.findByRole("heading", { name: "Corrections to decide" });
  const headings = screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent);
  expect(headings.indexOf("Corrections to decide")).toBeLessThan(headings.indexOf("Gaps: questions the wiki couldn't answer"));
  expect(headings.indexOf("Gaps: questions the wiki couldn't answer")).toBeLessThan(headings.indexOf("Decided in the last 30 days"));
  expect(within(screen.getByRole("region", { name: "Decided in the last 30 days" })).getByText("Can't tell yet.")).toBeTruthy();
  await screen.findByText("How are retries handled?");
  noWrites(f.container);
 } finally { f.close(); }
});
it("Skill text opens as its own page with a Back link, the versions rail and one held decision-history line", async () => {
 const f = mount("/app/projects/web?tab=skills");
 try {
  fireEvent.click((await screen.findAllByRole("button", { name: "Open safe-retries" }))[0]!);
  await screen.findByText("Private skill text: cap retries at three.");
  expect(screen.getByRole("heading", { level: 2, name: "safe-retries" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Versions" })).getByText("Decision history: Can't tell yet.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Waiting for a decision" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to Skills" }));
  await screen.findByRole("list", { name: "Waiting for a decision" });
  noWrites(f.container);
 } finally { f.close(); }
});
