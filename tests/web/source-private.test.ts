// @vitest-environment jsdom
// Task 11: the Add form makes a private Slack channel easy to add. (A) "Your private channels": a group in the Slack picker that comes only from the editor's own read (`...options?kind=slack-private`);
// (B) a pasted Slack link or a bare channel ID fills the ID, with fixed help for finding either; (C) one fixed line says to type /invite @Rovara first, and the server's "Rovara isn't in that channel" and
// "different workspace" answers have their own fixed sentences.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SourceOptionsViewSchema } from "@agentx/cloud-contracts/web";
import { adminView, flat } from "./support/sources-fixture.js";
import { ok } from "./support/lessons-fixture.js";
import { openSources } from "./support/sources-render.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(() => { cleanup(); });
type Raw = Record<string, unknown>;
const option = (id: string, name: string, over: Raw = {}) => ({ scope: `slack:T1/${id}`, name, state: "available", joined: true, ...over });
const list = (kind: string, options: Raw[], extra: Raw = {}) => ok(SourceOptionsViewSchema.parse({ kind, options, ...extra }));
const PUBLIC = [option("C0GENERAL", "general"), option("C0RANDOM1", "random")];
const PRIVATE = [
  option("C0SECRET1", "reorg-planning"),
  option("G0SECRET2", "payroll"),
  option("C0CLEAR01", "cleanup", { state: "clearing" }),
  option("C0MINE001", "my-source", { state: "added" }),
  option("C0TAKEN01", "other-project", { state: "taken" }),
  option("C0SHARED1", "partner-private", { state: "slack_connect" }),
];
const pick = (label: string, value: string, scope: HTMLElement = document.body) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const open = async (options: Parameters<typeof openSources>[0] = {}) => { const f = openSources({ options: () => list("slack", PUBLIC), privateOptions: () => list("slack-private", PRIVATE), ...options }); await screen.findByRole("heading", { name: "Add a source" }); return { f, form: screen.getByRole("region", { name: "Add a source" }) }; };
const group = (form: HTMLElement) => within(form).findByRole("group", { name: "Your private channels" });
const radio = (scope: HTMLElement, name: RegExp | string) => within(scope).getByRole<HTMLInputElement>("radio", { name });
const INVITE_LINE = "Rovara can only read channels it's in. For a private channel, first type /invite @Rovara in that channel.";
const ONLY_YOU = "Only you see this list: these are private channels you're in.";
const NOT_LINKED = "Link your Slack account to see your private channels here: the ones you and Rovara are both in.";
const HELP = "To get a link: in Slack, right-click the channel and choose Copy link. To find the ID: open the channel, click its name at the top, and the Channel ID is at the bottom of the About tab.";
const INVITE_NEEDED = "Rovara can't use that channel yet. Check the link is for a channel in your company's Slack, that you're in the channel, and that Rovara is in it. For a private channel Rovara never says which, so the channel stays private.";
const WRONG_WORKSPACE = "That link is for a different Slack workspace.";

describe("A: your private channels", () => {
  it("reads the group only when Slack is chosen (not for other kinds, not before), and shows the fixed line with the names", async () => {
    const { f, form } = await open();
    expect(f.privateReads).toEqual([]);
    pick("What to add", "rovara");
    pick("What to add", "repository");
    expect(f.privateReads).toEqual([]);
    pick("What to add", "slack");
    expect(await within(await group(form)).findByRole("radio", { name: /reorg-planning/u })).toBeTruthy();
    expect(f.privateReads).toEqual(["?kind=slack-private"]);
    expect(f.optionReads).toEqual(["?kind=slack"]);
    expect(within(await group(form)).getByText(ONLY_YOU)).toBeTruthy();
    expect(within(await group(form)).getAllByRole("radio").map((item) => item.getAttribute("value"))).toEqual(PRIVATE.map((item) => item.scope));
    // The public list is its own group: none of the private names is in it, and none of the public names is in the private group.
    expect(within(form).queryAllByText("reorg-planning")).toHaveLength(1);
    expect(within(await group(form)).queryByText("general")).toBeNull();
    pick("What to add", "linear");
    expect(within(form).queryByRole("group", { name: "Your private channels" })).toBeNull();
  });

  it("the private names come only from that read: when it fails the group says so in one fixed line and shows no name at all, whatever the public list holds", async () => {
    const { form } = await open({ options: () => list("slack", [...PUBLIC, option("C0SECRET1", "reorg-planning")]), privateOptions: () => flat("RUNTIME_UNAVAILABLE", "slack said: token abc", 503) });
    pick("What to add", "slack");
    expect(await within(form).findByText("Rovara can't load your private channels right now. You can still paste a channel link below.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("token abc");
    expect(within(form).queryByText(ONLY_YOU)).toBeNull();
    expect(within(form).queryByRole("group", { name: "Your private channels" })).toBeNull();
    // Positive control: the public list still works.
    expect(await within(form).findByRole("radio", { name: /general/u })).toBeTruthy();
  });

  it("an unreadable reply, a refusal or a bot without the scope is the same fixed line (the server's text is never shown)", async () => {
    for (const answer of [ok({ kind: "slack-private", options: "nope" }), flat("FORBIDDEN", "no", 403), flat("SLACK_SCOPE_MISSING", "Rovara can't list channels.", 503), { status: 404, body: {} }]) {
      const { form } = await open({ privateOptions: () => answer });
      pick("What to add", "slack");
      expect(await within(form).findByText("Rovara can't load your private channels right now. You can still paste a channel link below.")).toBeTruthy();
      cleanup();
    }
  });

  it("an editor with no linked Slack account sees the fixed not-linked line, and no list", async () => {
    const { form } = await open({ privateOptions: () => list("slack-private", [], { notLinked: true }) });
    pick("What to add", "slack");
    expect(await within(form).findByText(NOT_LINKED)).toBeTruthy();
    expect(within(form).queryByText(ONLY_YOU)).toBeNull();
    expect(within(form).queryByRole("group", { name: "Your private channels" })).toBeNull();
    expect(await within(form).findByRole("radio", { name: /general/u })).toBeTruthy();
    // UX-4b: the next step is in place, not in the account menu.
    expect(within(form).getByRole("button", { name: "Link your Slack account" })).toBeTruthy();
  });

  it("a person who is in no private channel with Rovara sees a fixed line, not a claim about any channel", async () => {
    const { f, form } = await open({ privateOptions: () => list("slack-private", []) });
    pick("What to add", "slack");
    expect(await within(form).findByText("None yet. A private channel shows here once you and Rovara are both in it.")).toBeTruthy();
    // UX-4b: how to add Rovara to a channel, and reading the list again, right there.
    expect(within(form).getByText("In Slack, open the channel and type /invite @Rovara.")).toBeTruthy();
    const before = f.privateReads.length;
    fireEvent.click(within(form).getByRole("button", { name: "Read the list again" }));
    await waitFor(() => { expect(f.privateReads.length).toBeGreaterThan(before); });
  });

  it("the same states apply: already a source, used by another project (not named), Slack Connect and still clearing are disabled with their reasons", async () => {
    const { form } = await open();
    pick("What to add", "slack");
    const box = await within(form).findByRole("group", { name: "Your private channels" });
    await within(box).findByRole("radio", { name: /reorg-planning/u });
    expect(radio(box, /reorg-planning/u).disabled).toBe(false);
    expect(radio(box, /my-source/u).disabled).toBe(true);
    expect(within(box).getByText("Already a source of this project")).toBeTruthy();
    expect(radio(box, /other-project/u).disabled).toBe(true);
    expect(within(box).getByText("Used by another project")).toBeTruthy();
    expect(radio(box, /partner-private/u).disabled).toBe(true);
    expect(within(box).getByText("Slack Connect channels can't be used")).toBeTruthy();
    expect(radio(box, /cleanup/u).disabled).toBe(true);
    expect(within(box).getByText("Still being cleared after a removal. Try again in about an hour.")).toBeTruthy();
    expect(within(box).queryByText("Invite Rovara to this channel so it can read it.")).toBeNull(); // Rovara is in every one of them
  });

  it("names show through VisibleText (hidden characters spelled out)", async () => {
    const { form } = await open({ privateOptions: () => list("slack-private", [option("C0ODDNAME", "pay‮roll")]) });
    pick("What to add", "slack");
    expect(await within(form).findByText("pay[U+202E]roll")).toBeTruthy();
  });

  it("picking one and a retention adds that channel: the body carries the listed place, once; the public pick is cleared by it (one radio group)", async () => {
    const { f, form } = await open();
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("radio", { name: /general/u }));
    fireEvent.click(await within(await group(form)).findByRole("radio", { name: /reorg-planning/u }));
    expect(radio(form, /general/u).checked).toBe(false);
    expect(radio(form, /reorg-planning/u).checked).toBe(true);
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    expect(await screen.findByText("Source added.")).toBeTruthy();
    expect(f.posts).toEqual([{ action: "add", requestId: expect.any(String) as string, source: "slack", scope: "slack:T1/C0SECRET1", retention: "B", audienceDefault: "maintainers", enabled: true }]);
  });

  it("searching narrows both groups; pages of the private list are read when asked (Show more)", async () => {
    const page1 = list("slack-private", [option("C0SECRET1", "reorg-planning")], { next: "11111111-2222-4333-8444-555555555555.abc=" });
    const page2 = list("slack-private", [option("G0SECRET2", "payroll")]);
    const { f, form } = await open({ privateOptions: (url) => (url.searchParams.get("cursor") === null ? page1 : page2) });
    pick("What to add", "slack");
    await within(await group(form)).findByRole("radio", { name: /reorg-planning/u });
    expect(f.privateReads).toHaveLength(1);
    fireEvent.click(within(await group(form)).getByRole("button", { name: "Show more" }));
    expect(await within(await group(form)).findByRole("radio", { name: /payroll/u })).toBeTruthy();
    expect(f.privateReads).toEqual(["?kind=slack-private", "?kind=slack-private&cursor=11111111-2222-4333-8444-555555555555.abc%3D"]);
    fireEvent.change(within(form).getByLabelText("Find a channel"), { target: { value: "PAYR" } });
    expect(within(await group(form)).getAllByRole("radio").map((item) => item.getAttribute("value"))).toEqual(["slack:T1/G0SECRET2"]);
  });

  it("the list is not kept: it goes with the form after an add, so the next time it is read again", async () => {
    const { f, form } = await open();
    pick("What to add", "slack");
    fireEvent.click(await within(await group(form)).findByRole("radio", { name: /reorg-planning/u }));
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    await screen.findByText("Source added.");
    pick("What to add", "slack");
    await waitFor(() => { expect(f.privateReads).toHaveLength(2); });
  });

  it("is accessible in light and dark", async () => {
    for (const theme of ["light", "dark"] as const) {
      const f = openSources({ options: () => list("slack", PUBLIC), privateOptions: () => list("slack-private", PRIVATE) }, theme);
      await screen.findByRole("heading", { name: "Add a source" });
      const form = screen.getByRole("region", { name: "Add a source" });
      pick("What to add", "slack");
      await within(await group(form)).findByRole("radio", { name: /reorg-planning/u });
      await expectNoAxeViolations(document.body);
      expect(f.privateReads.length).toBeGreaterThan(0);
      cleanup();
    }
  });
});

describe("B: a pasted link or ID fills the ID", () => {
  const typed = async (options: Parameters<typeof openSources>[0] = {}) => {
    const ctx = await open(options);
    pick("What to add", "slack");
    fireEvent.click(await within(ctx.form).findByRole("button", { name: "Enter an ID or link instead" }));
    return { ...ctx, field: within(ctx.form).getByLabelText<HTMLInputElement>("Slack channel") };
  };

  it("shows the fixed help under the field, in the typed field and when the list cannot be read", async () => {
    const { form } = await typed();
    expect(within(form).getByText(HELP)).toBeTruthy();
    cleanup();
    const down = await open({ options: () => flat("RUNTIME_UNAVAILABLE", "x", 503) });
    pick("What to add", "slack");
    await within(down.form).findByLabelText("Slack channel");
    expect(within(down.form).getByText(HELP)).toBeTruthy();
  });

  it.each([
    ["a workspace link", "https://acme.slack.com/archives/C0123ABCD", "C0123ABCD"],
    ["a message link", "https://acme.slack.com/archives/G0123ABCD/p1700000000123456?thread_ts=1700000000.123456", "G0123ABCD"],
    ["an app link keeps its workspace", "https://app.slack.com/client/T0AAAAAAA/C0123ABCD", "slack:T0AAAAAAA/C0123ABCD"],
    ["a link with spaces around it", "   https://acme.slack.com/archives/C0123ABCD  ", "C0123ABCD"],
    ["a bare ID", " C0123ABCD ", "C0123ABCD"],
  ])("pasting %s fills the field with the ID the server will use", async (_name, pasted, filled) => {
    const { field } = await typed();
    fireEvent.change(field, { target: { value: pasted } });
    expect(field.value).toBe(filled);
  });

  it("an Enterprise app link (E...) fills the bare ID, not a place the server would call another workspace; the ID is what is sent", async () => {
    const { f, form, field } = await typed();
    fireEvent.change(field, { target: { value: "https://app.slack.com/client/E0ENTERPR/C0123ABCD" } });
    expect(field.value).toBe("C0123ABCD");
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    await waitFor(() => { expect(f.posts).toHaveLength(1); });
    expect(f.posts[0]).toMatchObject({ source: "slack", scope: "C0123ABCD" });
  });

  it("anything else is left as typed (a channel name, another site, the full place): the server decides", async () => {
    const { field } = await typed();
    for (const text of ["general", "#general", "https://example.com/archives/C0123ABCD", "slack:T1/C9", "https://acme.slack.com/team/U0123ABCD"]) {
      fireEvent.change(field, { target: { value: text } });
      expect(field.value, text).toBe(text);
    }
  });

  it("the ID that was filled is what is sent", async () => {
    const { f, form, field } = await typed();
    fireEvent.change(field, { target: { value: "https://acme.slack.com/archives/G0123ABCD" } });
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    await waitFor(() => { expect(f.posts).toHaveLength(1); });
    expect(f.posts[0]).toMatchObject({ source: "slack", scope: "G0123ABCD" });
  });
});

describe("C: invite Rovara first", () => {
  it("one fixed line above the Slack form, for Slack only, whether the list loads or not", async () => {
    const { form } = await open();
    expect(within(form).queryByText(INVITE_LINE)).toBeNull();
    pick("What to add", "slack");
    expect(within(form).getByText(INVITE_LINE)).toBeTruthy();
    pick("What to add", "linear");
    expect(within(form).queryByText(INVITE_LINE)).toBeNull();
    cleanup();
    const down = await open({ options: () => flat("RUNTIME_UNAVAILABLE", "x", 503) });
    pick("What to add", "slack");
    expect(within(down.form).getByText(INVITE_LINE)).toBeTruthy();
  });

  it("the server's 'Rovara isn't in that channel' answer shows its fixed sentence (never the server's own text) and the form stays", async () => {
    const { f, form } = await open({ write: () => flat("SLACK_INVITE_NEEDED", "server text that must not show", 422) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("button", { name: "Enter an ID or link instead" }));
    fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: "C0NOTIN001" } });
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    expect(await screen.findByText(INVITE_NEEDED)).toBeTruthy();
    expect(document.body.textContent).not.toContain("server text that must not show");
    expect(f.posts).toHaveLength(1);
    expect(within(form).getByLabelText<HTMLInputElement>("Slack channel").value).toBe("C0NOTIN001");
  });

  it("UX-4b: after 'Rovara can't use that channel' it shows how to add Rovara to the channel and the Slack-side shortcut, in place", async () => {
    const { form } = await open({ write: () => flat("SLACK_INVITE_NEEDED", "x", 422) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("button", { name: "Enter an ID or link instead" }));
    fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: "C0NOTIN001" } });
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    await screen.findByText(INVITE_NEEDED);
    expect(screen.getAllByText("In Slack, open the channel and type /invite @Rovara.").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/type @Rovara learn from this channel and press Add to project/u).length).toBeGreaterThan(0);
  });

  it("UX-4b: an editor with no linked Slack account is told so and can link it in place", async () => {
    const { form } = await open({ write: () => flat("SLACK_NOT_LINKED", "x", 422) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("button", { name: "Enter an ID or link instead" }));
    fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: "C0NOTIN001" } });
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    expect(await screen.findByText("Rovara needs your linked Slack account to check you're in that channel. Link it, then try again.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Link your Slack account" }).length).toBeGreaterThan(0);
  });

  it("a link for another workspace shows its fixed sentence", async () => {
    const { form } = await open({ write: () => flat("SLACK_WRONG_WORKSPACE", "x", 422) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("button", { name: "Enter an ID or link instead" }));
    fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: "https://app.slack.com/client/T0OTHER99/C0123ABCD" } });
    pick("How long Rovara keeps it", "B", form);
    fireEvent.click(within(form).getByRole("button", { name: "Add source" }));
    expect(await screen.findByText(WRONG_WORKSPACE)).toBeTruthy();
  });
});

describe("a place that was just removed is recognised by its channel ID, however it was written", () => {
  const CLEARING = [{ source: "slack", scope: "slack:T0TEAM01/C0GONE001", since: "2026-10-30T10:00:00.000Z" }];
  const REMOVAL = "This source was just removed and its stored data is still being deleted. You can add it again in about an hour.";
  it.each([
    ["a bare ID", "C0GONE001"],
    ["a workspace link", "https://acme.slack.com/archives/C0GONE001"],
    ["an Enterprise app link", "https://app.slack.com/client/E0ENTERPR/C0GONE001"],
    ["an app link of the workspace", "https://app.slack.com/client/T0TEAM01/C0GONE001"],
    ["the full place of another team", "slack:T0OTHER99/C0GONE001"],
  ])("%s: the same removal line shows and Add stays off", async (_name, text) => {
    const { f, form } = await open({ view: adminView({ clearing: CLEARING }) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("button", { name: "Enter an ID or link instead" }));
    fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: text } });
    expect(await within(form).findByText(REMOVAL)).toBeTruthy();
    pick("How long Rovara keeps it", "B", form);
    expect(within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" }).disabled).toBe(true);
    expect(f.posts).toEqual([]);
  });

  it("another channel is not held back (positive control), and a Linear place is not matched by the ID rule", async () => {
    const { form } = await open({ view: adminView({ clearing: CLEARING }) });
    pick("What to add", "slack");
    fireEvent.click(await within(form).findByRole("button", { name: "Enter an ID or link instead" }));
    fireEvent.change(within(form).getByLabelText("Slack channel"), { target: { value: "C0OTHER001" } });
    expect(within(form).queryByText(REMOVAL)).toBeNull();
    pick("How long Rovara keeps it", "B", form);
    expect(within(form).getByRole<HTMLButtonElement>("button", { name: "Add source" }).disabled).toBe(false);
  });
});
