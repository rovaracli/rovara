// @vitest-environment jsdom
// UX-4b, owner decision 3: the team record search on the project page, over the record's own search and past-work routes (the same read authority).
import { expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";

const notFound: ApiResponse = { status: 404, body: { code: "NOT_FOUND", message: "x" } };

function setup(options: { overview?: ReturnType<typeof projectFixture>; route?: (request: ApiRequest, path: string) => ApiResponse | undefined; theme?: "light" | "dark" } = {}) {
 const overview = options.overview ?? projectFixture();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0]!;
  const custom = options.route?.(request, path);
  if (custom !== undefined) return custom;
  if (path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (path.endsWith("/start-preview")) return { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } };
  if (path === "/v1/app/projects/payments/overview") return { status: 200, body: overview };
  if (path === "/v1/app/projects/payments/record/learning-mode") return { status: 200, body: { mode: "off", effective: "off", canChange: true } };
  if (path === "/v1/app/projects/payments/lessons/sources") return { status: 200, body: { sources: [], otherPaused: 0 } };
  return notFound;
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
it("searches the team record and links each result to its source and each past task to the task", async () => {
 const reads: string[] = [];
 const f = setup({ route: (request, path) => {
  if (path === "/v1/app/projects/payments/record/search") { reads.push(request.path);return { status: 200, body: { hits: [{ id: "h1", kind: "slack.message", source: "slack", occurredAt: "2026-10-30T10:00:00.000Z", title: "Retry decision", snippet: "We agreed to retry twice.", link: "https://acme.slack.com/archives/C1/p1", trust: "member", audienceKind: "project" }, { id: "h2", kind: "fact", source: "rovara", occurredAt: "2026-10-31T10:00:00.000Z", title: "Bad link", snippet: "", link: "javascript:alert(1)", trust: "member", audienceKind: "project" }], someHidden: true } }; }
  if (path === "/v1/app/projects/payments/record/past-work") return { status: 200, body: { items: [{ taskId: "t1", title: "Add retries", status: "done", link: "https://cell.example/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", pullRequests: [], planSummary: "Wrap calls in withRetry.", trust: "member", outcome: { merged: true, sendBacks: 0, reverted: false }, lessonsLearned: [] }], someHidden: false } };
  return undefined;
 } });
 const search = await screen.findByRole("search");
 fireEvent.change(within(search).getByRole("searchbox"), { target: { value: "retry" } });
 fireEvent.click(within(search).getByRole("button", { name: "Search" }));
 expect(await screen.findByText("Retry decision")).toBeTruthy();
 expect(reads[0]).toContain("query=retry");
 expect(screen.getByRole("link", { name: "Open in Slack" }).getAttribute("href")).toBe("https://acme.slack.com/archives/C1/p1");
 expect(screen.getByRole("link", { name: "Open in Slack" }).getAttribute("rel")).toBe("noopener noreferrer");
 // A link that is not https is not a link.
 expect(screen.getAllByRole("link", { name: /^Open in/u })).toHaveLength(1);
 expect(screen.getByRole("link", { name: "Open the task" }).getAttribute("href")).toBe("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa");
 expect(screen.getByText(/Some results are left out/u)).toBeTruthy();
 f.close();
});

it("says the team record isn't set up when its search route is absent", async () => {
 const f = setup();
 const search = await screen.findByRole("search");
 fireEvent.change(within(search).getByRole("searchbox"), { target: { value: "retry" } });
 fireEvent.click(within(search).getByRole("button", { name: "Search" }));
 expect(await screen.findByText("The team record isn't set up here yet, so there is nothing to search.")).toBeTruthy();
 f.close();
});

it("UX-4b review M3: says the team record is paused when its search answers paused", async () => {
 const f = setup({ route: (_request, path) => path.endsWith("/record/search") || path.endsWith("/record/past-work") ? { status: 503, body: { code: "TEAM_RECORD_PAUSED", message: "x" } } : undefined });
 const search = await screen.findByRole("search");
 fireEvent.change(within(search).getByRole("searchbox"), { target: { value: "retry" } });
 fireEvent.click(within(search).getByRole("button", { name: "Search" }));
 expect(await screen.findByText("The team record is paused in this installation, so nothing can be searched until it is resumed.")).toBeTruthy();
 f.close();
});
