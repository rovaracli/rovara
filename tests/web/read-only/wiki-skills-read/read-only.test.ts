// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "./test-support.js";
import { reply } from "./fixtures.js";
type ReadCase = {
 name: string;
 query?: string;
 slot?: "project" | "setup" | "answer";
 select?: "detail";
 marker: string;
 role?: "link" | "heading" | "button";
};
const cases: ReadCase[] = [
 { name: "Wiki index", query: "?tab=wiki", role: "link", marker: "Product overview" },
 { name: "Wiki page", query: "?tab=wiki&page=overview", marker: "Private page text: requests enter the API." },
 { name: "disputed sections", query: "?tab=wiki&view=disputed", marker: "Check the retry policy" },
 { name: "answer gaps", query: "?tab=wiki&view=gaps", role: "heading", marker: "How are retries handled?" },
 { name: "current Skills", query: "?tab=skills", role: "button", marker: "Open safe-retries" },
 { name: "retired Skills", query: "?tab=skills", role: "button", marker: "Open old-retries" },
 { name: "local skill text", query: "?tab=skills", select: "detail", marker: "Private skill text: cap retries at three." },
 { name: "Wiki setup", slot: "setup", marker: "3 of 8 planned pages written" },
 { name: "existing answer fallback", slot: "answer", marker: "Existing answer: Can't tell yet." },
];
function assertNoWrites(f: ReturnType<typeof mount>) {
 expect(f.container.querySelectorAll("form, textarea, [type=submit], [role=switch], [contenteditable=true]")).toHaveLength(0);
 expect(within(f.container).queryByRole("button", { name: /^(save|build|delete|refresh build|approve|retire|edit|ask|regenerate|mark wrong|not right|start|resolve|add note)(?:$|\s)/i })).toBeNull();
 expect(f.calls.every(r => r.method === "GET")).toBe(true);
}
it.each(cases)("zero write controls or mutation requests on $name including refetch", async item => {
 const f = mount("/app/projects/web" + (item.query ?? ""), reply, undefined, item.slot);
 const view = within(f.container);
 async function settleRenderedRead() {
  if (item.select === "detail") {
   // Identity/index refetch can remount the list and close the opened skill; open it again when the list is back.
   await waitFor(() => {
    const open = view.queryAllByRole("button", { name: "Open safe-retries" });
    if (open[0] !== undefined) fireEvent.click(open[0]);
    expect(view.getByText(item.marker)).toBeTruthy();
   });
  }
  await waitFor(() => {
   expect(f.client.isFetching()).toBe(0);
   expect(f.container.querySelector("[role=status], [role=alert]")).toBeNull();
   expect(item.role === undefined ? view.getByText(item.marker) : view.getAllByRole(item.role, { name: item.marker })[0]).toBeTruthy();
  });
 }
 try {
  // Request start or query success alone does not prove React committed the leaf.
  await settleRenderedRead();
  expect(f.calls.length).toBeGreaterThan(item.slot === "answer" ? 0 : 1);
  assertNoWrites(f);
  const before = f.calls.length;
  await act(async () => { await f.client.refetchQueries({ queryKey: ["g3"] }); });
  await settleRenderedRead();
  expect(f.calls.length).toBeGreaterThan(before);
  assertNoWrites(f);
 } finally { f.close(); }
});
// The ONLY files of the area that reach the old live actions, each for the one named reason. Everything else stays a reader.
const ACTION_HOSTS: Record<string, { reason: string; may: RegExp }> = {
 "ProjectAnswerReadPanel.tsx": { reason: "the Ask box (ask, Start a Quick task, Not right)", may: /Answer(Box|View)|api\/(answers|projects)/ },
 "WikiPageReadScreen.tsx": { reason: "Mark wrong, notes, lesson offer, Ask to retire", may: /WikiCorrections|wiki-text|wiki-model|TeamLessons|api\/projects/ },
 "WikiCorrectionsReadScreen.tsx": { reason: "close disputed marks", may: /WikiCorrections|wiki-text|api\/wiki|useWikiRefresh/ },
 "WikiIndexReadScreen.tsx": { reason: "the full-text search words and the answers switch", may: /wiki-text|api\/(wiki|answers)/ },
 "SkillDetailReadPanel.tsx": { reason: "approve, edit and retire a skill", may: /SkillActions|api\/skills/ },
 "ReadEntry.tsx": { reason: "reads the wiki again after a write", may: /api\/wiki/ },
 "read-model.ts": { reason: "the skill readers", may: /api\/skills/ },
};
it("mounted area imports no writer APIs; only the named action hosts reach the old live actions", () => {
 const root = resolve("packages/ui/src/screens/wiki-skills-read");
 for (const file of readdirSync(root).filter(p => /\.tsx?$/.test(p))) {
  const source = readFileSync(resolve(root, file), "utf8"), host = ACTION_HOSTS[file];
  // No file of the area sends a request itself.
  expect(source, file).not.toMatch(/\.(send|sendAnswer)\b|useMutation|create(Wiki|Skills|Answers|Code)Api|dangerouslySetInnerHTML/);
  const old = /Answer(Box|View)|SkillActions|useWikiRefresh|WikiCorrections\.js|TeamLessons|useWikiApi/;
  if (host === undefined) expect(source, file).not.toMatch(old);
  for (const match of source.matchAll(/from ["']([^"']+)["']/g)) {
   const name = match[1] ?? "";
   if (/api\/(wiki|wiki-setup|skills|answers)/.test(name) && host === undefined) throw new Error(file + " imports " + name + " but is not an action host");
   if (host !== undefined && /api\/(wiki|wiki-setup|skills|answers)|screens\/(project|answers)|\.\.\/(project|answers)\//.test(name)) expect(name, file).toMatch(host.may);
  }
 }
});
