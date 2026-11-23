// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { mount } from "./test-support.js";
import { index, reply } from "./fixtures.js";
import { readFileSync } from "node:fs";
import { day } from "../../../../packages/ui/src/screens/wiki-skills-read/parts.js";
it("preserves page, view, unrelated query parameters and Back", async () => {
 const f = mount("/app/projects/web?tab=wiki&keep=1");
 await screen.findByRole("link", { name: "Disputed sections" });
 fireEvent.click(screen.getByRole("link", { name: "Disputed sections" }));
 await screen.findByText("Check the retry policy");
 expect(f.router.state.location.search).toContain("keep=1");
 expect(f.router.state.location.search).toContain("view=disputed");
 await act(async () => { await f.router.navigate(-1); });
 await screen.findByRole("link", { name: "Product overview" });
 fireEvent.click(screen.getByRole("link", { name: "Product overview" }));
 await screen.findByText("Private page text: requests enter the API.");
 expect(f.router.state.location.search).toContain("page=overview"); f.close();
});
it("ignores unsupported views and tabs instead of creating routes", async () => {
 const f = mount("/app/projects/web?tab=wiki&view=approve");
 await screen.findByRole("link", { name: "Product overview" });
 expect(screen.queryByRole("button", { name: /approve/i })).toBeNull(); f.close();
 const other = mount("/app/projects/web?tab=settings");
 await screen.findByText("Choose Wiki or Skills in the project."); other.close();
});
it("opens skills locally without inventing a skill query parameter", async () => {
 const f = mount("/app/projects/web?tab=skills");
 fireEvent.click((await screen.findAllByRole("button", { name: "Open safe-retries" }))[0]!);
 await screen.findByText("Private skill text: cap retries at three.");
 expect(f.router.state.location.search).toBe("?tab=skills");
 expect(screen.getByText("Decision history: Can't tell yet.")).toBeTruthy(); f.close();
});

it("uses a full-width search followed by All pages without a placeholder reading card", async () => {
 const f = mount();
 const style = document.createElement("style");
 style.textContent = readFileSync("packages/ui/src/screens/wiki-skills-read/wiki-skills-read.css", "utf8");
 document.head.append(style);
 try {
  await screen.findByRole("link", { name: "Product overview" });
  const search = screen.getByRole("searchbox", { name: "Search the wiki" });
  const list = screen.getByRole("list", { name: "All pages" });
  expect(search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Wiki reading pane" })).toBeNull();
  expect(screen.queryByText("Choose a page to read its text and sources.")).toBeNull();
  const layout = f.container.querySelector(".rv-wsr-page");
  if (layout === null) throw new Error("Missing Wiki layout");
  // One column: search, then All pages, then the notes; nothing sits beside the list.
  expect(getComputedStyle(layout).flexDirection).toBe("column");
 } finally { style.remove(); f.close(); }
});
it("keeps the served update time and every repository revision with its own index row", async () => {
 const second = { ...index.pages[0], pageId: "testing", title: "Testing", writtenAt: "2026-11-20T09:30:00.000Z", repos: [{ repo: "beacon-web", commit: "b".repeat(40) }, { repo: "beacon-tests", commit: "c".repeat(64) }], flagged: false, claims: { found: 2, changed: 0 } };
 const f = mount(undefined, r => r.path.endsWith("/wiki") ? { status: 200, body: { ...index, pages: [...index.pages, second] } } : reply(r));
 try {
  await screen.findByRole("link", { name: "Testing" });
  const rows = within(screen.getByRole("list", { name: "All pages" })).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  [index.pages[0], second].forEach((page, i) => {
   if (page === undefined || rows[i] === undefined) throw new Error("Missing Wiki row");
   const row = rows[i];
   expect(within(row).getByRole("link", { name: page.title })).toBeTruthy();
   const time = row.querySelector("time");
   expect(time?.dateTime).toBe(page.writtenAt);
   expect(time?.textContent).toBe(day(page.writtenAt));
   expect(row.textContent).toContain("Updated");
   for (const revision of page.repos) {
    expect(within(row).getByText(revision.repo + " at", { exact: false })).toBeTruthy();
    expect(within(row).getByTitle(revision.commit).textContent).toBe(revision.commit.slice(0, 7));
   }
  });
  expect(within(rows[0]!).getByText("Disputed")).toBeTruthy();
  expect(within(rows[0]!).getByText("Source changed")).toBeTruthy();
  expect(within(rows[1]!).queryByText("Disputed")).toBeNull();
 } finally { f.close(); }
});
it("holds missing index revision metadata rather than inventing a source", async () => {
 const f = mount(undefined, r => r.path.endsWith("/wiki") ? { status: 200, body: { ...index, pages: index.pages.map(row => ({ ...row, repos: [] })) } } : reply(r));
 try {
  await screen.findByRole("link", { name: "Product overview" });
  const row = within(screen.getByRole("list", { name: "All pages" })).getByRole("listitem");
  expect(within(row).getByText("Source revision: Can't tell yet.")).toBeTruthy();
  expect(row.querySelector("abbr")).toBeNull();
 } finally { f.close(); }
});
it.each([false, true])("retains the served empty/building explanation in the list (running=%s)", async running => {
 const f = mount(undefined, r => r.path.endsWith("/wiki") ? { status: 200, body: { ...index, state: "empty", pages: [], ...(running ? { lastBuild: { buildId: "build-001", kind: "first", state: "running", startedAt: "2026-11-21T12:00:00.000Z" } } : {}) } } : reply(r));
 try {
  const list = await screen.findByRole("region", { name: "All pages" });
  expect(within(list).getByText(running ? "The first wiki build is running." : "No wiki pages yet.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Wiki reading pane" })).toBeNull();
 } finally { f.close(); }
});
