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
const SESSION = "11111111-2222-4333-8444-555555555555";
const slackOption = (id: string, name: string, over: Raw = {}) => ({ scope: `slack:T1/${id}`, name, state: "available", joined: true, ...over });
const list = (kind: string, options: Raw[], next?: string) => ok(SourceOptionsViewSchema.parse({ kind, options, ...(next === undefined ? {} : { next }) }));
const SLACK = [
  slackOption("C0GENERAL", "general"),
  slackOption("C0CLEAR01", "cleanup", { state: "clearing" }),
  slackOption("C0MINE001", "payments", { state: "added" }),
  slackOption("C0TAKEN01", "platform", { state: "taken" }),
  slackOption("C0SHARED1", "partners", { state: "slack_connect" }),
  slackOption("C0NOTIN01", "random", { joined: false }),
];
const pick = (label: string, value: string, scope: HTMLElement = document.body) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const open = async (options: Parameters<typeof openSources>[0] = {}) => { const f = openSources(options); await screen.findByRole("heading", { name: "Add a source" }, { timeout: 10_000 }); return { f, form: screen.getByRole("region", { name: "Add a source" }) }; };
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
    expect(within(form).getByRole("button", { name: "Enter an ID or link instead" })).toBeTruthy();
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

  it("marks what already is a source, what another project holds (not named), and Slack Connect as disabled, each with its reason; a place being cleared after a removal is disabled without naming a project", async () => {
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
    expect(radio(form, /cleanup/u).disabled).toBe(true);
    expect(within(form).getByText("Still being cleared after a removal. Try again in about an hour.")).toBeTruthy();
    expect(within(form).queryByText("Private")).toBeNull();
    expect(within(form).queryByText("Direct message")).toBeNull();
    expect(within(form).queryByText("Group message")).toBeNull();
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

  it("an unjoined channel stays pickable and says to invite Rovara; a joined one says nothing; the pick still adds it", async () => {
    const { f, form } = await open({ options: () => list("slack", SLACK) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /general/u });
    expect(within(form).getAllByText("Invite Rovara to this channel so it can read it.")).toHaveLength(1);
    expect(radio(form, /random/u).disabled).toBe(false);
    expect(within(radio(form, /random/u).closest("label")!).getByText("Invite Rovara to this channel so it can read it.")).toBeTruthy();
    expect(within(radio(form, /general/u).closest("label")!).queryByText(/Invite Rovara/u)).toBeNull();
    fireEvent.click(radio(form, /random/u));
    pick("How long Rovara keeps it", "A", form);
    fireEvent.click(within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" }));
    await waitFor(() => { expect(f.posts).toHaveLength(1); });
    expect(f.posts[0]).toMatchObject({ source: "slack", scope: "slack:T1/C0NOTIN01" });
  });

  it("reads one page, and the next only when asked (Show more), by the cursor it was given (encoded); every page shows once and the button goes at the end", async () => {
    const seen: string[] = [];
    const { form } = await open({
      options: (url) => {
        seen.push(url.search);
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) return list("slack", [slackOption("C0PAGE001", "one"), slackOption("C0PAGE002", "two")], `${SESSION}.ab+/=`);
        return list("slack", [slackOption("C0PAGE002", "two"), slackOption("C0PAGE003", "three")]);
      },
    });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /one/u });
    await new Promise(resolve => { setTimeout(resolve, 30); });
    expect(seen).toEqual(["?kind=slack"]); // nothing else is read on its own
    fireEvent.click(within(form).getByRole("button", { name: "Show more" }));
    expect(await within(form).findByRole("radio", { name: /three/u })).toBeTruthy();
    expect(seen).toEqual(["?kind=slack", `?kind=slack&cursor=${SESSION}.ab%2B%2F%3D`]);
    expect(within(form).getAllByRole("radio").map(item => item.getAttribute("value"))).toEqual(["slack:T1/C0PAGE001", "slack:T1/C0PAGE002", "slack:T1/C0PAGE003"]);
    expect(within(form).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(within(form).queryByText(/Showing the first channels only/u)).toBeNull();
  });

  it("the pages already loaded stay while the form is open: switching kinds away and back reads nothing again; an add clears them", async () => {
    const { f, form } = await open({
      options: (url) => (url.searchParams.get("kind") === "jira" ? list("jira", [{ scope: "jira:project/OPS", name: "Operations (OPS)", state: "available" }])
        : url.searchParams.get("cursor") === null ? list("slack", [slackOption("C0PAGE001", "one")], `${SESSION}.x`) : list("slack", [slackOption("C0PAGE002", "two")])),
    });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /one/u });
    fireEvent.click(within(form).getByRole("button", { name: "Show more" }));
    await within(form).findByRole("radio", { name: /two/u });
    pick("What to add", "jira");
    await within(form).findByRole("radio", { name: /Operations/u });
    pick("What to add", "slack");
    expect(within(form).getAllByRole("radio")).toHaveLength(2); // both pages, at once
    expect(f.optionReads).toEqual(["?kind=slack", `?kind=slack&cursor=${SESSION}.x`, "?kind=jira"]);
    fireEvent.click(radio(form, /one/u));
    pick("How long Rovara keeps it", "A", form);
    fireEvent.click(within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" }));
    expect(await screen.findByText("Source added.")).toBeTruthy();
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /one/u });
    expect(f.optionReads.filter(read => read === "?kind=slack")).toHaveLength(2); // read afresh after the add
  });

  it("when the server cut the list at its bound the screen says so, and a search that finds nothing says 'Not in the channels shown so far.'", async () => {
    const { form } = await open({ options: () => ok(SourceOptionsViewSchema.parse({ kind: "slack", options: [slackOption("C0PAGE001", "one")], truncated: true })) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /one/u });
    expect(within(form).getByText("Showing the first channels only. Enter an ID instead to add one that isn't listed.")).toBeTruthy();
    expect(within(form).queryByRole("button", { name: "Show more" })).toBeNull();
    fireEvent.change(within(form).getByLabelText("Find a channel"), { target: { value: "zzz" } });
    expect(within(form).getByText("Not in the channels shown so far.")).toBeTruthy();
    expect(within(form).queryByText("No channel matches that.")).toBeNull();
  });

  it("when a later page fails the screen keeps what it has, says so with the same fixed line, offers no more, and never says the list is complete", async () => {
    const { form } = await open({ options: (url) => (url.searchParams.get("cursor") === null ? list("slack", [slackOption("C0PAGE001", "one")], `${SESSION}.x`) : flat("TOO_MANY_REQUESTS", "slack said: token abc", 429)) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /one/u });
    fireEvent.click(within(form).getByRole("button", { name: "Show more" }));
    expect(await within(form).findByText("Showing the first channels only. Enter an ID instead to add one that isn't listed.")).toBeTruthy();
    expect(within(form).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(within(form).getAllByRole("radio")).toHaveLength(1);
    fireEvent.change(within(form).getByLabelText("Find a channel"), { target: { value: "zzz" } });
    expect(within(form).getByText("Not in the channels shown so far.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("token abc");
  });

  it("with more pages to read, a search that finds nothing says 'Not in the channels shown so far.' and offers Show more; a finished list says 'No channel matches that.'", async () => {
    const { form } = await open({ options: (url) => (url.searchParams.get("cursor") === null ? list("slack", [slackOption("C0PAGE001", "one")], `${SESSION}.x`) : list("slack", [slackOption("C0PAGE002", "two")])) });
    pick("What to add", "slack");
    await within(form).findByRole("radio", { name: /one/u });
    fireEvent.change(within(form).getByLabelText("Find a channel"), { target: { value: "two" } });
    expect(within(form).getByText("Not in the channels shown so far.")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Show more" }));
    expect(await within(form).findByRole("radio", { name: /two/u })).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Find a channel"), { target: { value: "zzz" } });
    expect(within(form).getByText("No channel matches that.")).toBeTruthy();
  });

  it("is accessible, light and dark", async () => {
    for (const theme of ["light", "dark"] as const) {
      openSources({ options: () => list("slack", SLACK) }, theme);
      await screen.findByRole("heading", { name: "Add a source" }, { timeout: 10_000 });
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
    fireEvent.click(within(form).getByRole("button", { name: "Enter an ID or link instead" }));
    const typed = within(form).getByLabelText<HTMLInputElement>("Slack channel");
    expect(typed.value).toBe(""); // what was picked is not carried over
    expect(within(form).queryAllByRole("radio")).toHaveLength(0);
    fireEvent.click(within(form).getByRole("button", { name: "Pick from the list instead" }));
    expect(within(form).getAllByRole("radio")).toHaveLength(SLACK.length);
    expect(f.optionReads).toHaveLength(1); // the same read, not another
    fireEvent.click(within(form).getByRole("button", { name: "Enter an ID or link instead" }));
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
