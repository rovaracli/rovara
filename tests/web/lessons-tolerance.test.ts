// @vitest-environment jsdom
// L4-CLS: the Sources tab and the lessons the agent loaded keep drawing when Code sends a kind, a value or a field Cloud does not know: a source of an unknown kind is "Other source",
// an unknown reason, citation state or step is a calm fixed word, an unknown retention is never offered, and the rest of the screen is still there (nothing blanks).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture as fixture } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { loadedRow } from "./support/lessons-fixture.js";
import { adminRow } from "./support/sources-fixture.js";
import { openSources } from "./support/sources-render.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

afterEach(() => { cleanup(); });
type Raw = Record<string, unknown>;
const SOURCE_KINDS = ["send_back", "plan_comment", "design_comment", "other", "made_up_future_kind"];
const memberRow = (over: Raw = {}) => ({ kind: "github", scope: "github:acme/payments", enabled: true, retention: "D", health: "ok", audience: "project", updatedAt: "2026-10-30T10:00:00.000Z", paused: false, ...over });

describe("the read-only Sources tab", () => {
  it("draws a source of a kind, health, audience and retention Cloud does not know as plain fixed words, keeps the known row, and ignores fields it does not have", async () => {
    openSources({ canEdit: false, readable: { sources: [memberRow({ kind: "plan_comment", scope: "future:1", health: "degraded", audience: "team", retention: "E", sourceKinds: SOURCE_KINDS, extra: { a: 1 } }), memberRow()], otherPaused: 0, more: true } });
    const list = await screen.findByRole("list", { name: "Sources" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("heading").textContent).toContain("Other source");
    expect(rows[0]!.textContent).toContain("Not checked yet");
    expect(rows[0]!.textContent).toContain("Rovara keeps: Unknown");
    expect(rows[0]!.textContent).toContain("Who sees it: Other");
    expect(rows[0]!.textContent).not.toContain("plan_comment");
    expect(rows[0]!.textContent).not.toContain("degraded");
    expect(within(rows[1]!).getByRole("heading").textContent).toContain("GitHub");
    expect(rows[1]!.textContent).toContain("Who sees it: Everyone on this project");
    expect(screen.queryByText("Couldn't load the sources. Try again.")).toBeNull();
  });
  it("still refuses a row that is not a row: the tab says it could not load instead of drawing a half row", async () => {
    openSources({ canEdit: false, readable: { sources: [memberRow({ enabled: "yes" })], otherPaused: 0 } });
    expect(await screen.findByText("Couldn't load the sources. Try again.")).toBeTruthy();
  });
});

describe("the editors' Sources tab", () => {
  it("never offers a retention it does not know, shows a row of an unknown kind as Other source, and keeps the known retentions", async () => {
    openSources({ view: { sources: [{ ...adminRow({ kind: "zendesk", scope: "zendesk:1", retention: "E" }) }, adminRow()], otherPaused: 0, canEdit: true, offered: { github: ["A", "E", "C", "D"], zendesk: ["A", "F"], slack: ["A", "B"] }, repositories: [], newer: { x: 1 } } });
    await screen.findByRole("heading", { name: "Add a source" });
    const zendesk = screen.getByRole("region", { name: /Other source zendesk:1/u });
    expect(zendesk).toBeTruthy();
    const github = screen.getByRole("region", { name: /GitHub github:repo\/9/u });
    const options = [...within(github).getByLabelText<HTMLSelectElement>("How long Rovara keeps it").options].map(option => option.value).filter(value => value !== "");
    expect(options).toEqual(["A", "C", "D"]);
    const other = [...within(zendesk).getByLabelText<HTMLSelectElement>("How long Rovara keeps it").options].map(option => option.value).filter(value => value !== "");
    expect(other).toEqual(["A"]);
  });
});

describe("the lessons the agent loaded", () => {
  const body = (rows: Raw[]) => ({ lessons: rows, canThumbsDown: true, newer: [1] });
  function setup(respond: (request: ApiRequest) => ApiResponse) {
    const session = SessionViewReaderSchema.parse(fixture()), f = fakeHost(async request => respond(request)), query = createQueryClient();
    const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session, onComment: () => undefined })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
    const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
    return { ...ui, close() { ui.unmount(); router.dispose(); query.clear(); } };
  }
  const answer = (rows: Raw[]) => (request: ApiRequest): ApiResponse => request.path.endsWith("/loaded-knowledge") ? { status: 200, body: { stages: [], requestId: "r" } } : request.path.endsWith("/lessons") ? { status: 200, body: body(rows) } : { status: 404, body: {} };
  const open = async () => { const details = (await screen.findByText("What the agent loaded")).closest("details")!;details.open = true;fireEvent(details, new Event("toggle")); };

  it("lists a lesson with a reason, a citation state, a type and a step Cloud does not know, in fixed words, with the plan-comment source kinds ignored", async () => {
    const s = setup(answer([
      loadedRow({ why: "future_reason", citation: "future_state", type: "recipe", stage: "PLAN_REVIEW", trial: "trial", sourceKinds: SOURCE_KINDS, provenance: { sourceKinds: SOURCE_KINDS } }),
      loadedRow({ lessonId: "les_bbbb2222", title: "A known one", why: "path", citation: "moved", type: "pitfall" }),
    ]));
    await open();
    const section = await screen.findByRole("region", { name: "Lessons the agent loaded" });
    const text = section.textContent ?? "";
    expect(text).toContain("Use the shared retry helper");
    expect(text).toContain("A known one");
    expect(text).toContain("Chosen because it matched");
    expect(text).toContain("Not checked");
    expect(section.querySelectorAll("li")[0]!.textContent).toContain("Lesson · Chosen because it matched · Not checked");
    expect(text).not.toContain("unknown");
    expect(text).toContain("Other");
    expect(text).toContain("Chosen because it matched a file the task touches");
    expect(text).toContain("Its code moved; the new place was used");
    expect(text).not.toContain("future_reason");
    expect(text).not.toContain("future_state");
    expect(text).not.toContain("plan_comment");
    expect(screen.queryByText("The lessons could not be loaded right now.")).toBeNull();
    await expectNoAxeViolations(s.container);
    s.close();
  });
  it("still says the lessons could not be loaded when a row is not a row", async () => {
    const s = setup(answer([loadedRow({ lessonId: undefined })]));
    await open();
    expect(await screen.findByText("The lessons could not be loaded right now.")).toBeTruthy();
    s.close();
  });
});
