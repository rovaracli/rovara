// @vitest-environment jsdom
// K1 C5b: "What the agent loaded" on the Pipeline tab: closed by default, reads nothing until opened, shows references in words,
// and fetches a rule file's text only when someone asks for it.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema, LoadedKnowledgeResponseReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture as fixture } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const D = "a".repeat(64);
const record = {
 stage: "plan", operationId: "op1", recordedAt: "2026-10-30T12:00:00.000Z",
 manifest: {
  schemaVersion: 1, stage: "plan", metaRepo: { name: "service-meta", knowledgeCommit: "7c41e9a" + "0".repeat(33) }, repos: [{ name: "engine", commit: "f".repeat(40), readAt: "base" }],
  items: [
   { layer: "meta", repo: "service-meta", path: ".kiro/steering/product.md", scopeDir: "", format: "kiro_steering", activation: "always", bytes: 3174, digest: D, fileDigest: D, readAt: "knowledgeCommit", status: "loaded", why: { kind: "always" } },
   { layer: "meta", repo: "service-meta", path: ".kiro/steering/python-style.md", scopeDir: "", format: "kiro_steering", activation: "fileMatch", patterns: ["**/*.py"], bytes: 900, digest: D, fileDigest: D, readAt: "knowledgeCommit", status: "loaded", why: { kind: "matched", detail: "src/match/rank.py" } },
   { layer: "meta", repo: "service-meta", path: ".kiro/steering/oncall.md", scopeDir: "", format: "kiro_steering", activation: "manual", bytes: 0, status: "skipped", reason: "not_requested" },
   { layer: "repo", repo: "engine", path: ".kiro/hooks/lint.json", scopeDir: "", format: "kiro_hook", bytes: 0, status: "skipped", reason: "found_not_run" },
  ],
  omitted: { skipped: 0, available: 0 },
  skills: [{ source: "meta", repo: "service-meta", path: ".agents/skills/brazil-build", commit: "7c41e9a" + "0".repeat(33), digest: "b".repeat(64) }], skippedSkills: [], sources: [{ label: "SIM", count: 2 }],
  budget: { alwaysOnBytes: 41 * 1024, alwaysOnLimitBytes: 128 * 1024, additionsBytes: 0, additionsLimitBytes: 131072, skipped: 0 },
 },
};
function setup(respond: (request: ApiRequest) => Promise<ApiResponse>) {
 const session = SessionViewReaderSchema.parse(fixture()), f = fakeHost(respond), query = createQueryClient();
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session, onComment: () => undefined })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...ui, f, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

it("is closed and reads nothing until it is opened", async () => {
 const s = setup(async () => ({ status: 200, body: { stages: [record], requestId: "r" } }));
 await screen.findByText("What the agent loaded");
 expect(s.f.request).not.toHaveBeenCalled();
 s.close();
});

it("lists what a stage loaded and left out in words, with skills, sources and the budget", async () => {
 expect(LoadedKnowledgeResponseReaderSchema.safeParse({ stages: [record] }).success).toBe(true);
 const s = setup(async request => request.path.endsWith("/loaded-knowledge") ? { status: 200, body: { stages: [record], requestId: "r" } } : { status: 404, body: {} });
 const summary = await screen.findByText("What the agent loaded");
 const details = summary.closest("details")!;
 details.open = true; fireEvent(details, new Event("toggle"));
 const region = await screen.findByRole("region", { name: "What Plan loaded" });
 const text = region.textContent ?? "";
 expect(text).toContain("meta repo service-meta @ 7c41e9a");
 expect(text).toContain(".kiro/steering/product.md");
 expect(text).toContain("always");
 expect(text).toContain("3.1 KB");
 expect(text).toContain("Loaded: matched src/match/rank.py");
 expect(text).toContain("Not asked for");
 expect(text).toContain("Found, not run (Rovara does not run repository hooks)");
 expect(text).toContain("brazil-build");
 expect(text).toContain("no tools");
 expect(text).toContain("SIM (2)");
 expect(text).toContain("Budget: 41 KB of 128 KB always-on, 0 left out for size");
 await expectNoAxeViolations(s.container);
 s.close();
});

it("fetches the text of one file only when asked, and says in words when it is refused or has changed", async () => {
 const paths: string[] = [];
 const s = setup(async request => {
  paths.push(request.path);
  if (request.path.endsWith("/loaded-knowledge")) return { status: 200, body: { stages: [record], requestId: "r" } };
  if (request.path.endsWith("/items/0/text")) return { status: 200, body: { available: true, repo: "service-meta", path: ".kiro/steering/product.md", commit: "7c41e9a", truncated: false, text: "Product rules go here", requestId: "r" } };
  if (request.path.endsWith("/items/1/text")) return { status: 200, body: { available: false, reason: "changed", requestId: "r" } };
  return { status: 403, body: { code: "FORBIDDEN", message: "You can't read this repository, so you can't read its rule text." } };
 });
 const details = (await screen.findByText("What the agent loaded")).closest("details")!;
 details.open = true; fireEvent(details, new Event("toggle"));
 await screen.findByRole("region", { name: "What Plan loaded" });
 expect(paths.filter(path => path.includes("/text"))).toEqual([]);
 fireEvent.click(screen.getByRole("button", { name: "Show the text of .kiro/steering/product.md" }));
 expect(await screen.findByText("Product rules go here")).toBeTruthy();
 expect(paths.filter(path => path.includes("/text"))).toEqual(["/v1/app/tasks/" + (paths[0]!.split("/")[4]!) + "/loaded-knowledge/op1/plan/items/0/text"]);
 fireEvent.click(screen.getByRole("button", { name: "Show the text of .kiro/steering/python-style.md" }));
 await waitFor(() => { expect(screen.getByText("That file no longer matches what the agent saw, so it is not shown.")).toBeTruthy(); });
 s.close();
});

it("says so when the record cannot be loaded", async () => {
 const s = setup(async () => ({ status: 500, body: {} }));
 const details = (await screen.findByText("What the agent loaded")).closest("details")!;
 details.open = true; fireEvent(details, new Event("toggle"));
 await waitFor(() => { expect(screen.getByRole("alert").textContent).toContain("could not be loaded"); }, { timeout: 8000 });
 s.close();
});

it("says it is not recorded for this task (not a failed load) when the record is not served, as on a project with learning off (QA6-08)", async () => {
 const s = setup(async () => ({ status: 404, body: {} }));
 const details = (await screen.findByText("What the agent loaded")).closest("details")!;
 details.open = true; fireEvent(details, new Event("toggle"));
 await waitFor(() => { expect(screen.getByRole("status").textContent).toContain("not recorded for this task"); }, { timeout: 8000 });
 expect(screen.getByRole("status").textContent).toContain("learning was off");
 expect(screen.queryByText(/could not be loaded/u)).toBeNull();
 s.close();
});

it("says plainly that lessons are switched off for the installation when the install's lessons switch is off, and keeps the other wording for a plain 404", async () => {
 const s = setup(async () => ({ status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are switched off for this installation." } } }));
 const details = (await screen.findByText("What the agent loaded")).closest("details")!;
 details.open = true; fireEvent(details, new Event("toggle"));
 await waitFor(() => { expect(screen.getByRole("status").textContent).toBe("Lessons are switched off for this installation."); }, { timeout: 8000 });
 expect(screen.queryByText(/learning was off/u)).toBeNull();
 expect(screen.queryByRole("link", { name: "Turn learning on for this project" })).toBeNull();
 s.close();
});

it("UX-4b: with learning off for the project it explains why and links to turning learning on, not a dead end", async () => {
 const s = setup(async () => ({ status: 404, body: { error: { code: "LEARNING_OFF", message: "Learning is off for this project." } } }));
 const details = (await screen.findByText("What the agent loaded")).closest("details")!;
 details.open = true; fireEvent(details, new Event("toggle"));
 await waitFor(() => { expect(screen.getByRole("status").textContent).toContain("because learning is off for its project"); }, { timeout: 8000 });
 const link = screen.getByRole("link", { name: "Turn learning on for this project" });
 expect(link.getAttribute("href")).toMatch(/^\/app\/projects\/[^/?]+\?tab=lessons$/u);
 s.close();
});

it("keeps 'could not be loaded' for a real failure, and explains an empty record in words (QA6-08)", async () => {
 const failed = setup(async () => ({ status: 500, body: {} }));
 const details = (await screen.findByText("What the agent loaded")).closest("details")!;
 details.open = true; fireEvent(details, new Event("toggle"));
 await waitFor(() => { expect(screen.getByRole("alert").textContent).toContain("could not be loaded"); }, { timeout: 8000 });
 failed.close();
 const empty = setup(async request => request.path.endsWith("/loaded-knowledge") ? { status: 200, body: { stages: [], requestId: "r" } } : { status: 404, body: {} });
 const again = (await screen.findByText("What the agent loaded")).closest("details")!;
 again.open = true; fireEvent(again, new Event("toggle"));
 await waitFor(() => { expect(screen.getByText(/Nothing was recorded for this task/u).textContent).toContain("before"); });
 empty.close();
});
