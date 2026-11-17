// @vitest-environment jsdom
// The repository picker, the one-or-separate question and the bulk progress table (guided onboarding PR 10; design section 2): multi-select with search, "In project X"
// marks and paging; "Do these repos work together?" (one project preselected, separate above 8, with the reason); one project posts one name; separate projects post no
// name and show a table with Code's reasons; nothing here starts a setup run; the browser names no company.
import { expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { OnboardScreen } from "../../packages/ui/src/screens/onboarding/OnboardScreen.js";
import { SEPARATE_ABOVE, answeredTogether, checklistHref, preselected, refusalWords, retryable } from "../../packages/ui/src/screens/onboarding/steps/repo-choice.js";
import type { ApiRequest } from "../../packages/ui/src/host.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = { developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [] };
const NAMES = ["api", "auth", "billing", "design", "docs", "infra", "mobile", "notifier", "payments", "reports", "search", "web"];
const row = (name: string, index: number) => ({ installationId: 55, accountLogin: "acme", fullName: `acme/${name}`, githubRepositoryId: 100 + index, private: index % 2 === 0, defaultBranch: "main", projects: name === "web" ? ["web-app"] : [] });
const project = { name: "web", description: "x", status: "active", latestRevision: 2, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "unchecked" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" } };
interface Options { names?: string[]; create?: (request: ApiRequest) => { status: number; body: unknown }; pageSize?: number }
function setup(options: Options = {}) {
  const names = options.names ?? NAMES;
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: me };
    if (request.path === "/v1/app/github/installations") return { status: 200, body: { installations: [{ installationId: 55, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active" }] } };
    if (request.path.startsWith("/v1/app/github/repository-choices")) {
      const query = new URL(request.path, "https://x.test").searchParams, q = query.get("q") ?? "", after = query.get("after"), size = options.pageSize ?? 50;
      const matching = names.map(row).filter((entry) => entry.fullName.includes(q) && (after === null || entry.fullName > after));
      const page = matching.slice(0, size);
      return { status: 200, body: { repositories: page, ...(matching.length > size ? { next: page.at(-1)!.fullName } : {}), incomplete: false } };
    }
    if (request.method === "POST" && request.path === "/v1/app/projects") return options.create?.(request) ?? { status: 201, body: { duplicate: false, project: { definition: { name: "web" }, registeredAt: "2026-11-17T00:00:00.000Z" } } };
    if (request.path === "/v1/app/projects/web") return { status: 200, body: project };
    return { status: 200, body: { project, warnings: [] } };
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/onboard?github=connected"], children: h(OnboardScreen) }) }) }));
  return { ...f, query, close() { ui.unmount(); query.clear(); } };
}
const posts = (f: ReturnType<typeof setup>) => f.request.mock.calls.map(([r]) => r).filter((r) => r.method === "POST" && r.path === "/v1/app/projects");
const pick = async (...names: string[]) => { for (const name of names) fireEvent.click(await screen.findByRole("checkbox", { name: new RegExp(`^acme/${name}( |$)`, "u") })); };

it("lists the company's repositories with 'In project X' marks, private tags and a search that asks for the matching page", async () => {
  const f = setup();
  await pick("web");
  expect(screen.getByText("In project web-app")).toBeTruthy();
  expect(screen.getAllByText("private").length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "pay" } });
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: /^acme\/api/ })).toBeNull());
  await screen.findByRole("checkbox", { name: /^acme\/payments/ });
  // The ticked repository stays ticked and counted while the search changes.
  expect(screen.getByTestId("picked-count").textContent).toBe("1 repository picked.");
  const reads = f.request.mock.calls.map(([r]) => r.path).filter((path) => path.startsWith("/v1/app/github/repository-choices"));
  expect(reads).toContain("/v1/app/github/repository-choices?q=pay&limit=50");
  f.close();
});

it("pages: 'Show more repositories' reads the next page after the last one shown", async () => {
  const f = setup({ pageSize: 5 });
  await screen.findByRole("checkbox", { name: /^acme\/api/ });
  expect(screen.queryByRole("checkbox", { name: /^acme\/infra/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more repositories" }));
  await screen.findByRole("checkbox", { name: /^acme\/infra/ });
  expect(f.request.mock.calls.map(([r]) => r.path)).toContain("/v1/app/github/repository-choices?limit=50&after=acme%2Fdocs");
  f.close();
});

it("one repository: no question, one name field, one project the one-form way", async () => {
  const f = setup();
  await pick("web");
  expect(screen.queryByRole("group", { name: "Do these repos work together?" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Project name (optional)"), { target: { value: "shop" } });
  fireEvent.click(screen.getByRole("button", { name: "Create 1 project" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toEqual({ requestId: expect.any(String) as string, repositories: ["acme/web"], name: "shop" });
  await screen.findByRole("heading", { name: "Setup" });
  f.close();
});

it("several repositories: 'Yes, one project' is preselected with one name field, and posts all of them without 'separate'", async () => {
  const f = setup();
  await pick("api", "auth");
  const question = screen.getByRole("group", { name: "Do these repos work together?" });
  expect(within(question).getByRole("radio", { name: /Yes, one project/ })).toHaveProperty("checked", true);
  expect(screen.queryByTestId("why-separate")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create project with 2 repos" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]!.body).toEqual({ requestId: expect.any(String) as string, repositories: ["acme/api", "acme/auth"] });
  f.close();
});

it("above 8 repositories 'separate' is preselected and says why; the person can still choose one project", async () => {
  const f = setup();
  await pick(...NAMES.slice(0, SEPARATE_ABOVE));
  expect(screen.getByRole("radio", { name: /Yes, one project/ })).toHaveProperty("checked", true);
  await pick(NAMES[SEPARATE_ABOVE]!);
  expect(screen.getByRole("radio", { name: /No, separate projects/ })).toHaveProperty("checked", true);
  expect(screen.getByTestId("why-separate").textContent).toContain("more than 8 repos");
  expect(screen.queryByLabelText("Project name (optional)")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Yes, one project/ }));
  expect(screen.getByLabelText("Project name (optional)")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create project with 9 repos" })).toBeTruthy();
  f.close();
});

it("separate projects post 'separate: true' with no name, then show a table: created ones open their checklist, refused ones say why", async () => {
  const f = setup({ create: () => ({ status: 200, body: { duplicate: false, results: [
    { repository: "acme/api", outcome: "created", project: "api" }, { repository: "acme/auth", outcome: "refused", reason: "name_taken" },
    { repository: "acme/billing", outcome: "refused", reason: "unavailable" }, { repository: "acme/design", outcome: "refused", reason: "not_available" }, { repository: "acme/docs", outcome: "created", project: "docs" },
  ] } }) });
  await pick("api", "auth", "billing", "design", "docs");
  fireEvent.click(screen.getByRole("radio", { name: /No, separate projects/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create 5 projects" }));
  const table = await screen.findByRole("table", { name: "Projects from your repositories" });
  expect(posts(f)[0]!.body).toEqual({ requestId: expect.any(String) as string, repositories: ["acme/api", "acme/auth", "acme/billing", "acme/design", "acme/docs"], separate: true });
  const rows = within(table).getAllByRole("row").slice(1).map((entry) => within(entry).getAllByRole("cell").map((cell) => cell.textContent));
  expect(rows[0]).toEqual(["api from acme/api", "Waiting for setup", "Open api"]);
  expect(rows[1]![1]).toBe(refusalWords("name_taken"));
  expect(rows[2]![1]).toBe("GitHub couldn't be reached for this one just now.");
  expect(rows[3]![1]).toBe("This repository isn't available through your company's GitHub connection.");
  expect(within(table).getByRole("link", { name: "Open docs" }).getAttribute("href")).toBe(checklistHref("docs"));
  expect(screen.getByText("2 of 5 projects created")).toBeTruthy();
  // It starts nothing: no request to any setup route after the create.
  expect(f.request.mock.calls.map(([r]) => r.path).filter((path) => /setup|runs/u.test(path))).toEqual([]);
  f.close();
});

it("'Try the rest again' sends only the repositories a second try can fix, with a new request id, and keeps the other rows", async () => {
  let call = 0;
  const f = setup({ create: () => ({ status: 200, body: { duplicate: false, results: ++call === 1
    ? [{ repository: "acme/api", outcome: "created", project: "api" }, { repository: "acme/auth", outcome: "refused", reason: "not_started" }, { repository: "acme/billing", outcome: "refused", reason: "name_taken" }]
    : [{ repository: "acme/auth", outcome: "created", project: "auth" }] } }) });
  await pick("api", "auth", "billing");
  fireEvent.click(screen.getByRole("radio", { name: /No, separate projects/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create 3 projects" }));
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "Try the rest again" }));
  await waitFor(() => expect(posts(f)).toHaveLength(2));
  expect(posts(f)[1]!.body).toEqual({ requestId: expect.any(String) as string, repositories: ["acme/auth"], separate: true });
  expect((posts(f)[1]!.body as { requestId: string }).requestId).not.toBe((posts(f)[0]!.body as { requestId: string }).requestId);
  await screen.findByRole("link", { name: "Open auth" });
  expect(screen.getByText(refusalWords("name_taken"))).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try the rest again" })).toBeNull();
  f.close();
});

it("a failed 'Try the rest again' says so, and trying again sends the same request id (so a lost answer is never created twice); a success gets a new one", async () => {
  let call = 0;
  const f = setup({ create: () => {
    call += 1;
    if (call === 1) return { status: 200, body: { duplicate: false, results: [{ repository: "acme/api", outcome: "created", project: "api" }, { repository: "acme/auth", outcome: "refused", reason: "unavailable" }] } };
    if (call === 2) return { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara couldn't create the projects just now. Try again." } } };
    return { status: 200, body: { duplicate: false, results: [{ repository: "acme/auth", outcome: "created", project: "auth" }] } };
  } });
  await pick("api", "auth");
  fireEvent.click(screen.getByRole("radio", { name: /No, separate projects/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create 2 projects" }));
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "Try the rest again" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Rovara couldn't create the projects just now. Try again.");
  fireEvent.click(screen.getByRole("button", { name: "Try the rest again" }));
  await screen.findByRole("link", { name: "Open auth" });
  const ids = posts(f).map((post) => (post.body as { requestId: string }).requestId);
  expect(ids[2]).toBe(ids[1]);
  expect(ids[1]).not.toBe(ids[0]);
  f.close();
});

it("a search with a space or other odd characters is cleaned before it is asked, never an error", async () => {
  const f = setup();
  await pick("web");
  fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "acme web!" } });
  await waitFor(() => expect(f.request.mock.calls.map(([r]) => r.path)).toContain("/v1/app/github/repository-choices?q=acmeweb&limit=50"));
  expect(screen.queryByRole("alert")).toBeNull();
  f.close();
});

it("stops at 32 repositories: the 33rd box is disabled and says so", async () => {
  const names = Array.from({ length: 40 }, (_, index) => `r${String(index).padStart(2, "0")}`);
  const f = setup({ names });
  await pick(...names.slice(0, 32));
  expect(screen.getByRole("checkbox", { name: /^acme\/r32/ })).toHaveProperty("disabled", true);
  expect(screen.getByTestId("picked-count").textContent).toContain("32 repositories picked (the most one step takes)");
  fireEvent.click(screen.getByRole("checkbox", { name: /^acme\/r00/ }));
  expect(screen.getByRole("checkbox", { name: /^acme\/r32/ })).toHaveProperty("disabled", false);
  f.close();
});

it("a name already taken can be created on its own: the picker comes back with that repository and 'one project'", async () => {
  const f = setup({ create: () => ({ status: 200, body: { duplicate: false, results: [{ repository: "acme/api", outcome: "created", project: "api" }, { repository: "acme/auth", outcome: "refused", reason: "name_taken" }] } }) });
  await pick("api", "auth");
  fireEvent.click(screen.getByRole("radio", { name: /No, separate projects/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Create 2 projects/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Create it on its own with another name" }));
  await screen.findByLabelText("Project name (optional)");
  expect(screen.getByTestId("picked-count").textContent).toBe("1 repository picked.");
  f.close();
});

it("Code's refusals are shown as given: the fixed 403 sentence, and a taken name", async () => {
  for (const words of ["Only company owners and admins can create projects.", "a project named web already exists; choose another name", "one or more of these repositories is not available through your company's GitHub connection; nothing was created"]) {
    const f = setup({ create: () => ({ status: words.startsWith("Only") ? 403 : 400, body: { error: { code: words.startsWith("Only") ? "FORBIDDEN" : "CONFIG_INVALID", message: words } } }) });
    await pick("web");
    fireEvent.click(screen.getByRole("button", { name: "Create 1 project" }));
    expect((await screen.findByRole("alert")).textContent).toBe(words);
    f.close();
    cleanup();
  }
});

it("names no company anywhere: not in a read, not in a create", async () => {
  const f = setup();
  await pick("api", "auth");
  fireEvent.click(screen.getByRole("button", { name: "Create project with 2 repos" }));
  await waitFor(() => expect(posts(f)).toHaveLength(1));
  const sent = JSON.stringify(f.request.mock.calls.map(([r]) => [r.path, r.body]));
  expect(sent).not.toMatch(/company|org_|installation=/iu);
  f.close();
});

it("keeps the advanced meta start off the main path, closed", async () => {
  const f = setup();
  await pick("web");
  expect(screen.getByText("Advanced: start from a meta repo").closest("details")!.open).toBe(false);
  f.close();
});

for (const theme of ["light", "dark"] as const) it("keeps the picker, the question and the table accessible in " + theme, async () => {
  const f = setup({ create: () => ({ status: 200, body: { duplicate: false, results: [{ repository: "acme/api", outcome: "created", project: "api" }, { repository: "acme/auth", outcome: "refused", reason: "name_taken" }] } }) });
  await pick("api", "auth");
  await expectNoAxeViolations(document.body);
  fireEvent.click(screen.getByRole("radio", { name: /No, separate projects/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create 2 projects" }));
  await screen.findByRole("table");
  await expectNoAxeViolations(document.body);
  f.close();
});

it("the choices are plain functions: above 8 is separate, an answer wins, the words are fixed", () => {
  expect(preselected(2)).toBe("one"); expect(preselected(8)).toBe("one"); expect(preselected(9)).toBe("separate"); expect(preselected(32)).toBe("separate");
  expect(answeredTogether("one", 20)).toBe("one"); expect(answeredTogether("separate", 2)).toBe("separate"); expect(answeredTogether(undefined, 9)).toBe("separate");
  expect(retryable("unavailable") && retryable("not_started") && !retryable("name_taken") && !retryable("not_available")).toBe(true);
  expect(refusalWords("something new")).toBe("This one couldn't be created.");
  expect(checklistHref("my-app")).toBe("/app/onboard?project=my-app&step=setup");
});
void vi;
