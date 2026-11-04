// @vitest-environment jsdom
// T10: the Add form's Slack, Linear and Jira kinds show a searchable list read from the server (`.../record/sources/options`) instead of asking for a typed id. Unavailable options are disabled with their reason;
// the typed field stays as "Enter an ID instead" and is what the screen falls back to when the list cannot be read. The server still checks everything on save.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SourceOptionsViewSchema } from "@agentx/contracts/web";
import { adminView, flat } from "./support/sources-fixture.js";
import { ok } from "./support/lessons-fixture.js";
import { openSources } from "./support/sources-render.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(() => { cleanup(); });
type Raw = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const slackOption = (id: string, name: string, over: Raw = {}) => ({ scope: `slack:T1/${id}`, name, state: "available", slackKind: "public", ...over });
const list = (kind: string, options: Raw[], next?: string) => ok(SourceOptionsViewSchema.parse({ kind, options, ...(next === undefined ? {} : { next }) }));
const SLACK = [
  slackOption("C0GENERAL", "general"),
  slackOption("C0PRIVATE", "secret-plans", { slackKind: "private" }),
  slackOption("C0MINE001", "payments", { state: "added" }),
  slackOption("C0TAKEN01", "platform", { state: "taken" }),
  slackOption("C0SHARED1", "partners", { state: "slack_connect" }),
  slackOption("D0DIRECT1", "U0PERSON1", { slackKind: "im" }),
  slackOption("G0GROUPDM", "mpdm-a--b-1", { slackKind: "mpim" }),
];
const pick = (label: string, value: string, scope: HTMLElement = document.body) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const open = async (options: Parameters<typeof openSources>[0] = {}) => { const f = openSources(options); await screen.findByRole("heading", { name: "Add a source" }); return { f, form: screen.getByRole("region", { name: "Add a source" }) }; };
const radio = (form: HTMLElement, name: RegExp | string) => within(form).getByRole<HTMLInputElement>("radio", { name });

describe("the Slack channel picker", () => {
  it("reads the list once the kind is chosen (and not before), and shows each channel by its name", async () => {
    const { f, form } = await open({ options: () => list("slack", SLACK) });
    expect(f.optionReads).toEqual([]);
    pick("What to add", "repository");
    pick("What to add", "rovara");
    expect(f.optionReads).toEqual([]);
    pick("What to add", "slack");
    expect(await within(form).findByRole("radio", { name: /general/u })).toBeTruthy();
    expect(f.optionReads).toEqual(["?kind=slack"]);
    expect(within(form).getAllByRole("radio")).toHaveLength(SLACK.length);
    expect(within(form).queryByLabelText("Slack channel")).toBeNull(); // the typed field is not there while the list is
    expect(within(form).getByRole("button", { name: "Enter an ID instead" })).toBeTruthy();
  });

  it("shows a name with its hidden control characters spelled out", async () => {
    const { form } = await open({ options: () => list("slack", [slackOption("C0ODDNAME", "pay‮ments")]) });
    pick("What to add", "slack");
    expect(await within(form).findByText("pay[U+202E]ments")).toBeTruthy();
  });

  it("searches by name, case-insensitively, and says when nothing matches", async () => {
    const { form } = await open({ options: () => list("slack", SLACK) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /general/u });
    fireEvent.change(within(form).getByLabelText("Find a channel"), { target: { value: "GENE" } });
    expect(within(form).getAllByRole("radio").map(item => item.getAttribute("value"))).toEqual(["slack:T1/C0GENERAL"]);
    fireEvent.change(within(form).getByLabelText("Find a channel"), { target: { value: "zzz" } });
    expect(within(form).queryAllByRole("radio")).toHaveLength(0);
    expect(within(form).getByText("No channel matches that.")).toBeTruthy();
  });

  it("marks what already is a source, what another project holds (not named), and Slack Connect as disabled, each with its reason; tags private and direct conversations", async () => {
    const { form } = await open({ options: () => list("slack", SLACK) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /general/u });
    expect(radio(form, /payments/u).disabled).toBe(true);
    expect(within(form).getByText("Already a source of this project")).toBeTruthy();
    expect(radio(form, /platform/u).disabled).toBe(true);
    expect(within(form).getByText("Used by another project")).toBeTruthy();
    expect(radio(form, /partners/u).disabled).toBe(true);
    expect(within(form).getByText("Slack Connect channels can't be used")).toBeTruthy();
    expect(radio(form, /general/u).disabled).toBe(false);
    expect(radio(form, /secret-plans/u).disabled).toBe(false);
    expect(within(form).getByText("Private")).toBeTruthy();
    expect(within(form).getByText("Direct message")).toBeTruthy();
    expect(within(form).getByText("Group message")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/other project's name|api/u);
  });

  it("a place whose removal is still being cleared is disabled too", async () => {
    const { form } = await open({ view: adminView({ clearing: [{ source: "slack", scope: "slack:T1/C0GENERAL", since: "2026-10-30T10:00:00.000Z" }] }), options: () => list("slack", SLACK) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /general/u });
    expect(radio(form, /general/u).disabled).toBe(true);
    expect(within(form).getByText("Being removed")).toBeTruthy();
  });

  it("picking a channel and a retention adds that channel: the body carries the listed place, once, with a fresh id", async () => {
    const { f, form } = await open({ options: () => list("slack", SLACK) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("radio", { name: /general/u }));
    expect(radio(form, /general/u).checked).toBe(true);
    const add = within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" });
    expect(add.disabled).toBe(true); // a retention is still needed
    pick("How long Rovara keeps it", "B", form);
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(await screen.findByText("Source added.")).toBeTruthy();
    expect(f.posts).toEqual([{ action: "add", requestId: expect.stringMatching(UUID) as string, source: "slack", scope: "slack:T1/C0GENERAL", retention: "B", audienceDefault: "maintainers", enabled: true }]);
  });

  it("without a pick the add button stays off, and a disabled option cannot be picked", async () => {
    const { f, form } = await open({ options: () => list("slack", SLACK) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /general/u });
    pick("How long Rovara keeps it", "B", form);
    expect(within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" }).disabled).toBe(true);
    fireEvent.click(radio(form, /partners/u));
    expect(radio(form, /partners/u).disabled).toBe(true);
    expect(within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" }).disabled).toBe(true); // nothing was picked
    expect(f.posts).toEqual([]);
  });

  it("reads the next pages by the cursor it was given (encoded) and shows every page once", async () => {
    const seen: string[] = [];
    const { form } = await open({
      options: (url) => {
        seen.push(url.search);
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) return list("slack", [slackOption("C0PAGE001", "one"), slackOption("C0PAGE002", "two")], "1.ab+/=");
        return list("slack", [slackOption("C0PAGE002", "two"), slackOption("C0PAGE003", "three")]);
      },
    });
    pick("What to add", "slack");
    expect(await within(form).findByRole("radio", { name: /three/u })).toBeTruthy();
    expect(seen).toEqual(["?kind=slack", "?kind=slack&cursor=1.ab%2B%2F%3D"]);
    expect(within(form).getAllByRole("radio").map(item => item.getAttribute("value"))).toEqual(["slack:T1/C0PAGE001", "slack:T1/C0PAGE002", "slack:T1/C0PAGE003"]);
  });

  it("is accessible, light and dark", async () => {
    for (const theme of ["light", "dark"] as const) {
      openSources({ options: () => list("slack", SLACK) }, theme);
      await screen.findByRole("heading", { name: "Add a source" });
      const form = screen.getByRole("region", { name: "Add a source" });
      pick("What to add", "slack");
      await within(form).findByRole("radio", { name: /general/u });
      await expectNoAxeViolations(document.body);
      cleanup();
    }
  });
});

describe("falling back to the typed place", () => {
  it("an unreadable list (503) shows the typed field with one fixed line, and the typed place is what is added", async () => {
    const { f, form } = await open({ options: () => flat("RUNTIME_UNAVAILABLE", "slack said: token abc", 503) });
    pick("What to add", "slack");
    const typed = await within(form).findByLabelText("Slack channel");
    expect(within(form).getByText("Rovara can't load the list right now. Enter an ID instead.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("token abc");
    fireEvent.change(typed, { target: { value: "slack:T1/C9" } });
    pick("How long Rovara keeps it", "A", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    expect(await screen.findByText("Source added.")).toBeTruthy();
    expect(f.posts[0]).toMatchObject({ source: "slack", scope: "slack:T1/C9" });
  });

  it("a bot without the listing scopes says so in fixed words, then offers the typed field", async () => {
    const { form } = await open({ options: () => flat("SLACK_SCOPE_MISSING", "Rovara can't list channels. Ask an admin to reinstall the Slack app.", 503) });
    pick("What to add", "slack");
    expect(await within(form).findByText("Rovara can't list channels. Ask an admin to reinstall the Slack app.")).toBeTruthy();
    expect(within(form).getByLabelText("Slack channel")).toBeTruthy();
  });

  it("an unreadable reply, a network failure or a refusal is the same fall back; the list is never retried behind the person's back", async () => {
    for (const answer of [ok({ kind: "slack", options: "nope" }), flat("FORBIDDEN", "no", 403), { status: 404, body: {} }]) {
      const { f, form } = await open({ options: () => answer });
      pick("What to add", "slack");
      expect(await within(form).findByLabelText("Slack channel")).toBeTruthy();
      expect(f.optionReads).toHaveLength(1);
      cleanup();
    }
  });

  it("a list with nothing in it falls back to the typed field with a line that says why", async () => {
    const { form } = await open({ options: () => list("slack", []) });
    pick("What to add", "slack");
    expect(await within(form).findByLabelText("Slack channel")).toBeTruthy();
    expect(within(form).getByText("There is nothing to pick from yet. Enter an ID instead.")).toBeTruthy();
  });

  it("\"Enter an ID instead\" swaps the list for the typed field, and \"Pick from the list instead\" swaps back; the place typed is what is sent", async () => {
    const { f, form } = await open({ options: () => list("slack", SLACK) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("radio", { name: /general/u }));
    fireEvent.click(within(form).getByRole("button", { name: "Enter an ID instead" }));
    const typed = within(form).getByLabelText<HTMLInputElement>("Slack channel");
    expect(typed.value).toBe(""); // what was picked is not carried over
    expect(within(form).queryAllByRole("radio")).toHaveLength(0);
    fireEvent.click(within(form).getByRole("button", { name: "Pick from the list instead" }));
    expect(within(form).getAllByRole("radio")).toHaveLength(SLACK.length);
    expect(f.optionReads).toHaveLength(1); // the same read, not another
    fireEvent.click(within(form).getByRole("button", { name: "Enter an ID instead" }));
    fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: " slack:T1/C7 " } });
    pick("How long Rovara keeps it", "A", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    await waitFor(() => { expect(f.posts).toHaveLength(1); });
    expect(f.posts[0]).toMatchObject({ source: "slack", scope: "slack:T1/C7" });
  });
});

describe("the Linear and Jira pickers", () => {
  it("Linear: lists the company's teams by name; picking one adds that team", async () => {
    const { f, form } = await open({ options: (url) => (url.searchParams.get("kind") === "linear" ? list("linear", [{ scope: "linear:team/aaaa-1111", name: "Platform (PLT)", state: "available" }, { scope: "linear:team/bbbb-2222", name: "Web (WEB)", state: "taken" }]) : undefined) });
    pick("What to add", "linear");
    fireEvent.click(await within(form).findByRole("radio", { name: /Platform \(PLT\)/u }));
    expect(radio(form, /Web \(WEB\)/u).disabled).toBe(true);
    expect(within(form).getByText("Used by another project")).toBeTruthy();
    expect(within(form).getByLabelText("Find a team")).toBeTruthy();
    pick("How long Rovara keeps it", "C", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    expect(await screen.findByText("Source added.")).toBeTruthy();
    expect(f.optionReads).toEqual(["?kind=linear"]);
    expect(f.posts[0]).toMatchObject({ source: "linear", scope: "linear:team/aaaa-1111", retention: "C" });
  });

  it("Jira: lists the projects by name; one already added is disabled; picking another adds it; the search label says projects", async () => {
    const { f, form } = await open({ options: (url) => (url.searchParams.get("kind") === "jira" ? list("jira", [{ scope: "jira:project/ENG", name: "Engineering (ENG)", state: "added" }, { scope: "jira:project/OPS", name: "Operations (OPS)", state: "available" }]) : undefined) });
    pick("What to add", "jira");
    fireEvent.click(await within(form).findByRole("radio", { name: /Operations/u }));
    expect(radio(form, /Engineering/u).disabled).toBe(true);
    expect(within(form).getByText("Already a source of this project")).toBeTruthy();
    expect(within(form).getByLabelText("Find a project")).toBeTruthy();
    pick("How long Rovara keeps it", "A", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    await waitFor(() => { expect(f.posts).toHaveLength(1); });
    expect(f.posts[0]).toMatchObject({ source: "jira", scope: "jira:project/OPS" });
  });

  it("changing the kind drops the pick and reads the other list", async () => {
    const { f, form } = await open({ options: (url) => list(url.searchParams.get("kind") ?? "slack", url.searchParams.get("kind") === "slack" ? SLACK : [{ scope: "jira:project/OPS", name: "Operations (OPS)", state: "available" }]) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("radio", { name: /general/u }));
    pick("What to add", "jira");
    expect(await within(form).findByRole("radio", { name: /Operations/u })).toBeTruthy();
    expect(within(form).getAllByRole("radio")).toHaveLength(1);
    expect(radio(form, /Operations/u).checked).toBe(false);
    expect(f.optionReads).toEqual(["?kind=slack", "?kind=jira"]);
  });
});
