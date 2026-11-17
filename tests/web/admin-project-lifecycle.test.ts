// @vitest-environment jsdom
// Guided onboarding PR 17 (DEC 254n item 3): the project page's Archive and Restore against Cloud's real routes. Which control shows comes from the
// lifecycle read (Code's previews): none for a person Code offers no action, "Archiving isn't available yet." while Code doesn't serve the routes,
// the impact in plain words, and only Cloud's fixed sentences on a refusal.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { PROJECT_LIFECYCLE_WORDS } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture, meFixture } from "./support/fixtures.js";

const project = { name: "payments", description: "Payment service", status: "active", latestRevision: 3, repositories: [{ fullName: "Acme/payments", defaultBranch: "main" }], myRole: "contributor", setup: { status: "ready" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-01T00:00:00Z", createdBy: { developerId: "a".repeat(64), name: "Priya" } };
const refuse = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });

interface Options { manage?: boolean; lifecycle?: () => ApiResponse; post?: (r: ApiRequest) => ApiResponse }
function mount(options: Options = {}) {
  const me = meFixture(); me.developer.orgRole = "admin";
  const nav = navFixture({ features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
  let status: "active" | "archived" = "active", revision = 0;
  const manage = options.manage ?? true;
  const archivePreview = () => ({ orgId: me.org.orgId, project: "payments", status, expectedRevision: revision, expectedProjectRevision: 3, checkedAt: "2026-11-17T10:00:00.000Z", access: { actions: manage && status === "active" ? ["archive"] : [] }, impact: { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 2, slackChannelsStayLinked: true, deletesNothing: true } });
  const restorePreview = () => ({ orgId: me.org.orgId, project: "payments", status, expectedRevision: revision, expectedProjectRevision: 3, checkedAt: "2026-11-17T10:00:00.000Z", prerequisites: "not_required", access: { actions: manage && status === "archived" ? ["restore"] : [] }, impact: { allowsNewWork: true, linkedSlackChannels: 1 } });
  const f = fakeHost(async (r) => {
    if (r.path.endsWith("/me")) return { status: 200, body: structuredClone(me) };
    if (r.path.endsWith("/nav")) return { status: 200, body: nav };
    if (r.path.endsWith("/lifecycle")) return options.lifecycle?.() ?? { status: 200, body: { status, actions: manage ? [status === "active" ? "archive" : "restore"] : [] } };
    if (r.path.endsWith("/archive-preview")) return { status: 200, body: archivePreview() };
    if (r.path.endsWith("/restore-preview")) return { status: 200, body: restorePreview() };
    if (r.method === "POST") {
      if (options.post) return options.post(r);
      const kind = r.path.endsWith("reviewed-archive") ? "archive" : "restore";
      status = kind === "archive" ? "archived" : "active"; revision += 1;
      const receipt = { project: "payments", status, revision, projectRevision: 3, [kind === "archive" ? "archivedAt" : "restoredAt"]: "2026-11-17T10:01:00.000Z", egressReconciliation: "pending" };
      return { status: 200, body: { replayed: false, receipt, current: kind === "archive" ? archivePreview() : restorePreview(), effects: kind === "archive" ? { egress: "not_attempted", archiveHook: "not_configured" } : { egress: "not_attempted" } } };
    }
    return { status: 200, body: r.path.endsWith("/members") ? { members: [] } : { ...project, status: "active" } };
  });
  const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/projects/payments"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, posts: () => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "POST"), close() { view.unmount(); router.dispose(); query.clear(); } };
}
async function openArchive() { fireEvent.click(await screen.findByRole("button", { name: "Review archive" })); await screen.findByRole("checkbox"); }

it("a company admin who isn't the project's maintainer may archive when Code offers it (DEC 254n), and sees what archiving does", async () => {
  const f = mount();
  try {
    await openArchive();
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain("New work stops: nobody can start a task in this project.");
    expect(text).toContain("A task that is running now stops at its next step.");
    expect(text).toContain("Its 2 linked Slack channels stay linked, but start nothing.");
    expect(text).toContain("Nothing is deleted. You can restore the project later.");
    expect(screen.getByRole("checkbox").parentElement?.textContent).toContain("I understand that new work stops and a running task stops at its next step.");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    await screen.findAllByText("Current project status: Archived.");
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0]?.body).toMatchObject({ acknowledgeNewWorkStops: true, expectedRevision: 0, expectedProjectRevision: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    // The page follows the checked state: Restore is offered next.
    await screen.findByRole("button", { name: "Review restore" });
    expect(screen.getByText(/Status: Archived/)).toBeTruthy();
  } finally { f.close(); }
});

it("a person Code offers no action (a plain member) sees no Archive or Restore control", async () => {
  const f = mount({ manage: false });
  try {
    await screen.findByText(/Status: Active/);
    await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/lifecycle"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Review archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review restore" })).toBeNull();
    expect(f.posts()).toEqual([]);
  } finally { f.close(); }
});

it("says \"Archiving isn't available yet.\" and offers nothing while Code doesn't serve the routes", async () => {
  const f = mount({ lifecycle: () => refuse(501, "NOT_ON_CODE_YET", PROJECT_LIFECYCLE_WORDS.notYet) });
  try {
    await screen.findByText("Archiving isn't available yet.");
    expect(screen.queryByRole("button", { name: "Review archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review restore" })).toBeNull();
  } finally { f.close(); }
});

it("hides the archive control inside the review when the fresh preview offers no action", async () => {
  const f = mount();
  try {
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (r: ApiRequest) => r.path.endsWith("/archive-preview")
      ? { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", status: "active", expectedRevision: 0, expectedProjectRevision: 3, checkedAt: "2026-11-17T10:00:00.000Z", access: { actions: [] } } }
      : original(r));
    fireEvent.click(await screen.findByRole("button", { name: "Review archive" }));
    await screen.findByText("Archiving isn't available to you for this project right now.");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive project" })).toBeNull();
  } finally { f.close(); }
});

for (const [what, response, sentence] of [
  ["a refused change (403)", refuse(403, "FORBIDDEN", PROJECT_LIFECYCLE_WORDS.notAllowed), PROJECT_LIFECYCLE_WORDS.notAllowed],
  ["another company's or a missing project (404)", refuse(404, "NOT_FOUND", PROJECT_LIFECYCLE_WORDS.notFound), PROJECT_LIFECYCLE_WORDS.notFound],
  ["a company not on the engine (503)", refuse(503, "ARCHIVE_NOT_AVAILABLE", PROJECT_LIFECYCLE_WORDS.notOnEngine), PROJECT_LIFECYCLE_WORDS.notOnEngine],
] as const) {
  it(`shows Cloud's fixed sentence for ${what}, and records nothing as unconfirmed`, async () => {
    const f = mount({ post: () => response });
    try {
      await openArchive();
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
      await screen.findByText(sentence);
      expect(screen.getByText("This submission was refused. No new archive was recorded by this submission.")).toBeTruthy();
      expect(screen.queryByText(/outcome is unconfirmed/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry same archive request" })).toBeNull();
    } finally { f.close(); }
  });
}

it("never shows a refusal's text that isn't one of Cloud's fixed sentences", async () => {
  const f = mount({ post: () => refuse(403, "FORBIDDEN", "SENSITIVE detail from somewhere") });
  try {
    await openArchive();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    await screen.findByText("This submission was refused. No new archive was recorded by this submission.");
    expect(document.body.textContent).not.toContain("SENSITIVE");
  } finally { f.close(); }
});

it("the stale flow with Cloud's real sentence: one message, a fresh review, no automatic write", async () => {
  const f = mount({ post: () => refuse(409, "CHANGE_STALE", PROJECT_LIFECYCLE_WORDS.stale) });
  try {
    await openArchive();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    await screen.findByText(/The project changed/);
    expect(screen.getAllByText(/The project changed/)).toHaveLength(1);
    expect(screen.getByText(PROJECT_LIFECYCLE_WORDS.stale)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review latest state" }));
    await screen.findByRole("checkbox");
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
    expect(f.posts()).toHaveLength(1);
  } finally { f.close(); }
});

it("shows Code's not-found sentence when the review's preview is refused", async () => {
  const f = mount();
  try {
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (r: ApiRequest) => r.path.endsWith("/archive-preview") ? refuse(404, "NOT_FOUND", PROJECT_LIFECYCLE_WORDS.notFound) : original(r));
    fireEvent.click(await screen.findByRole("button", { name: "Review archive" }));
    await screen.findByText(PROJECT_LIFECYCLE_WORDS.notFound);
    expect(screen.queryByRole("checkbox")).toBeNull();
  } finally { f.close(); }
});
