// @vitest-environment jsdom
// SETUP-WIKI-CLOUD-FIXES (a): a website a setup run asked for is allowed or refused on the setup run's journal, by the person Code says may decide it (`canDecide` on the journal read). Rule #14: Allow and Refuse
// are drawn only from a current successful read of the journal, never for a person who may not decide, never for a closed ask; a failed re-read takes them away (the last facts stay with one reconnecting line);
// the press is refused again at send time; one press is one send (double click safe); a send whose outcome nobody can tell is CHECKED through a read, never sent again blind.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { RunJournal, HOST_WORDS as W, journalKey } from "../../packages/ui/src/screens/setup/RunJournal.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

afterEach(cleanup);
const HOST = "registry.example-build.io";
const DIGEST = "ab12".repeat(16);
const REQUEST_ID = `host-${"c".repeat(40)}`;
const ask = (over: Record<string, unknown> = {}) => ({ host: HOST, status: "open", journalN: 1, canDecide: true, approval: { requestId: REQUEST_ID, revision: 1, artifactDigest: DIGEST, kind: "setup_host", risk: "high" }, ...over });
const ERROR = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

interface Options { asks?: unknown[]; decide?: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> }
function mount(options: Options = {}) {
  let asks: unknown[] = options.asks ?? [ask()];
  let failing = false, failure: { status: number; code: string } | undefined;
  const f = fakeHost(async request => {
    if (request.path === "/v1/app/projects/web/setup-agent/journal") return failure !== undefined ? ERROR(failure.status, failure.code, "No.") : failing ? ERROR(503, "RUNTIME_UNAVAILABLE", "The project's setup couldn't be read just now. Try again.") : { status: 200, body: { status: "ready", entries: [], hostAsks: asks, requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent/host-decide") return (await options.decide?.()) ?? { status: 200, body: { project: "web", host: HOST, decision: "approved", replayed: false, requestId: "gw" } };
    return ERROR(404, "NOT_FOUND", "route not found");
  });
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(RunJournal, { project: "web", running: false }) }) }) }), { theme: "light" });
  return { ...f, query, setAsks(value: unknown[]) { asks = value; }, failReads(value: boolean) { failing = value; }, setJournalFailure(status: number, code: string) { failure = { status, code }; }, close() { ui.unmount(); query.clear(); } };
}
const decides = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST" && r.path.endsWith("/host-decide"));
const item = async () => within(await screen.findByTestId("host-ask"));

describe("website asks on the setup run's journal", () => {
  it("a person Code says may decide sees Allow and Refuse on an open ask; Allow sends once, bound to the id, host and the revision and digest the read offered", async () => {
    const f = mount();
    const row = await item();
    fireEvent.click(await row.findByRole("button", { name: `${W.allow} ${HOST}` }));
    await waitFor(() => expect(decides(f)).toHaveLength(1));
    expect(decides(f)[0]!.body).toEqual({ requestId: REQUEST_ID, host: HOST, outcome: "approve", seen: { revision: 1, artifactDigest: DIGEST } });
    await waitFor(() => expect(screen.getByTestId("host-ask-state").textContent).toBe(W.youAllowed));
    expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `${W.refuse} ${HOST}` })).toBeNull();
    f.close();
  });

  it("Allow and Refuse name the website for a screen reader; the journal's own heading can be left out where a summary says it", async () => {
    const f = mount({ asks: [ask(), ask({ host: "cdn.example-files.net", approval: { requestId: `host-${"d".repeat(40)}`, revision: 1, artifactDigest: DIGEST, kind: "setup_host", risk: "high" } })] });
    await screen.findAllByTestId("host-ask");
    expect(screen.getAllByRole("button", { name: /^Allow / }).map(one => one.getAttribute("aria-label"))).toEqual([`Allow ${HOST}`, "Allow cdn.example-files.net"]);
    expect(screen.getAllByRole("button", { name: /^Refuse / })).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "What Rovara ran" })).toBeTruthy();
    f.close(); cleanup();
    const quiet = mount();
    await item();
    quiet.close();
  });

  it("Refuse sends the other answer", async () => {
    const f = mount({ decide: () => ({ status: 200, body: { project: "web", host: HOST, decision: "refused", replayed: false } }) });
    fireEvent.click(await (await item()).findByRole("button", { name: `${W.refuse} ${HOST}` }));
    await waitFor(() => expect(decides(f)).toHaveLength(1));
    expect((decides(f)[0]!.body as { outcome: string }).outcome).toBe("reject");
    await waitFor(() => expect(screen.getByTestId("host-ask-state").textContent).toBe(W.youRefused));
    f.close();
  });

  it("a person Code says may not decide (canDecide false), or a read with no decision binding, or a closed ask, gets no button: read-only words only", async () => {
    for (const asks of [[ask({ canDecide: false })], [ask({ approval: undefined })], [ask({ canDecide: undefined })], [ask({ status: "approved", approval: undefined })], [ask({ status: "refused", approval: undefined })], [ask({ status: "approved" })], [ask({ status: "refused" })]]) {
      const f = mount({ asks });
      await item();
      expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
      expect(screen.queryByRole("button", { name: `${W.refuse} ${HOST}` })).toBeNull();
      f.close();
      cleanup();
    }
    const reader = mount({ asks: [ask({ canDecide: false })] });
    expect((await item()).getByTestId("host-ask-state").textContent).toBe(W.waiting);
    reader.close();
  });

  it("a double click is one send", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = mount({ decide: async () => { await gate; return { status: 200, body: { project: "web", host: HOST, decision: "approved", replayed: false } }; } });
    const button = await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` });
    fireEvent.click(button); fireEvent.click(button);
    // Two clicks in the same instant (before the page has drawn the busy state): still one send.
    const props = (button as unknown as Record<string, { onClick: () => void }>)[Object.keys(button).find(key => key.startsWith("__reactProps"))!]!;
    act(() => { props.onClick(); props.onClick(); });
    await waitFor(() => expect(decides(f)).toHaveLength(1));
    release();
    await waitFor(() => expect(screen.getByTestId("host-ask-state").textContent).toBe(W.youAllowed));
    expect(decides(f)).toHaveLength(1);
    f.close();
  });

  it("a failed re-read takes the buttons away and keeps the last facts with ONE reconnecting line; a read that works brings them back", async () => {
    const f = mount();
    await item();
    expect(screen.getByRole("button", { name: `${W.allow} ${HOST}` })).toBeTruthy();
    f.failReads(true);
    await f.query.invalidateQueries({ queryKey: journalKey("web") });
    await waitFor(() => expect(screen.getByTestId("host-asks-reconnecting").textContent).toBe(W.reconnecting));
    // Nothing was updated (the person did nothing, only the re-read failed): the line never says "Updated".
    expect(screen.getByTestId("host-asks-reconnecting").textContent).toBe("Couldn't refresh; reconnecting.");
    expect(screen.getAllByTestId("host-ask")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `${W.refuse} ${HOST}` })).toBeNull();
    expect(screen.getAllByTestId("host-asks-reconnecting")).toHaveLength(1);
    expect(decides(f)).toHaveLength(0);
    f.failReads(false);
    await f.query.invalidateQueries({ queryKey: journalKey("web") });
    await waitFor(() => expect(screen.getByRole("button", { name: `${W.allow} ${HOST}` })).toBeTruthy());
    expect(screen.queryByTestId("host-asks-reconnecting")).toBeNull();
    f.close();
  });

  it("a press is refused again at send time when the latest read is not a current success (0 sends)", async () => {
    const f = mount();
    const button = await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` });
    // The read fails in the cache in the same instant as the press: the page has not drawn it yet.
    f.query.getQueryCache().find({ queryKey: journalKey("web") })!.setState({ status: "error", fetchFailureCount: 1, error: new Error("boom") });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId("host-ask-problem")?.textContent).toContain(W.readRefused));
    expect(decides(f)).toHaveLength(0);
    f.close();
  });

  it("a press is refused at send time when the latest read no longer offers the ask (0 sends)", async () => {
    const f = mount();
    const button = await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` });
    f.query.setQueryData(journalKey("web"), { status: "ready", entries: [], hostAsks: [ask({ canDecide: false })] });
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId("host-ask-problem")?.textContent).toContain(W.readRefused));
    expect(decides(f)).toHaveLength(0);
    f.close();
  });

  it("after a successful send whose re-read fails, the page says it was saved and is reconnecting; never 'nothing changed'", async () => {
    const f = mount({ decide: () => { f.failReads(true); return { status: 200, body: { project: "web", host: HOST, decision: "approved", replayed: false } }; } });
    fireEvent.click(await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` }));
    await waitFor(() => expect(screen.getByTestId("host-asks-reconnecting").textContent).toBe(W.savedReconnecting));
    expect(document.body.textContent).not.toMatch(/nothing was changed/iu);
    expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
    expect(decides(f)).toHaveLength(1);
    f.close();
  });

  for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "FORBIDDEN"], [404, "NOT_FOUND"]] as const) it(`after a successful send, a ${String(status)} on the re-read wipes the journal but "Your change went through." stays (rule #14)`, async () => {
    const f = mount({ decide: () => { f.setJournalFailure(status, code); return { status: 200, body: { project: "web", host: HOST, decision: "approved", replayed: false } }; } });
    fireEvent.click(await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` }));
    const line = await screen.findByTestId("host-asks-went-through");
    expect(line.textContent).toContain("Your change went through.");
    expect(line.textContent).toContain("Couldn't load what the run did.");
    expect(screen.queryByTestId("host-ask")).toBeNull();
    expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
    expect(decides(f)).toHaveLength(1);
    f.close();
  });

  it("without a send, the same access signal says only that the journal could not load (never 'went through')", async () => {
    const f = mount();
    await item();
    f.setJournalFailure(403, "FORBIDDEN");
    await f.query.invalidateQueries({ queryKey: journalKey("web") });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Couldn't load what the run did."));
    f.close();
  });

  it("Code's refusal (403) says so and sends nothing more; a moved ask says it moved; neither is an unknown outcome", async () => {
    const refused = mount({ decide: () => ERROR(403, "FORBIDDEN", "A website for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.") });
    fireEvent.click(await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` }));
    expect((await screen.findByTestId("host-ask-problem")).textContent).toContain("only a company owner or admin");
    expect(screen.queryByTestId("host-ask-unknown")).toBeNull();
    expect(decides(refused)).toHaveLength(1);
    refused.close(); cleanup();
    const moved = mount({ decide: () => ERROR(409, "CHANGE_STALE", "That website is not waiting for a decision any more. Open the project's setup again.") });
    fireEvent.click(await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` }));
    expect((await screen.findByTestId("host-ask-problem")).textContent).toContain(W.moved);
    expect(screen.queryByTestId("host-ask-unknown")).toBeNull();
    moved.close();
  });

  it("an outcome nobody can tell (a 503 or a lost answer) is held: no button sends again; Check reads, and only a read that works lets the person decide again", async () => {
    const f = mount({ decide: () => ERROR(503, "RUNTIME_UNAVAILABLE", "The request's outcome is unknown. Check its status before trying again.") });
    fireEvent.click(await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` }));
    expect((await screen.findByTestId("host-ask-unknown")).textContent).toContain(W.unknown);
    expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `${W.refuse} ${HOST}` })).toBeNull();
    // The hold names what happened (the answer may not be saved) and does not also say the ask is waiting for a decision.
    expect(screen.getByTestId("host-ask-unknown").textContent).toContain("We couldn't confirm your answer was saved. Press Check to see.");
    expect(screen.queryByTestId("host-ask-state")).toBeNull();
    expect(decides(f)).toHaveLength(1);
    // A check that cannot read changes nothing.
    f.failReads(true);
    fireEvent.click(screen.getByRole("button", { name: W.check }));
    await waitFor(() => expect(screen.getByTestId("host-ask-problem").textContent).toContain(W.notConfirmed));
    expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
    expect(decides(f)).toHaveLength(1);
    // A check that reads: the ask is still open and was not decided, so deciding is open again (still one send so far).
    f.failReads(false);
    fireEvent.click(screen.getByRole("button", { name: W.check }));
    await waitFor(() => expect(screen.getByRole("button", { name: `${W.allow} ${HOST}` })).toBeTruthy());
    expect(screen.queryByTestId("host-ask-unknown")).toBeNull();
    expect(decides(f)).toHaveLength(1);
    f.close();
  });

  it("a check that shows the ask closed leaves no button for it", async () => {
    const f = mount({ decide: () => ERROR(503, "RUNTIME_UNAVAILABLE", "x") });
    fireEvent.click(await (await item()).findByRole("button", { name: `${W.allow} ${HOST}` }));
    await screen.findByTestId("host-ask-unknown");
    f.setAsks([ask({ status: "approved", approval: undefined, canDecide: undefined })]);
    fireEvent.click(screen.getByRole("button", { name: W.check }));
    await waitFor(() => expect(screen.getByTestId("host-ask-state").textContent).toBe(W.allowed));
    expect(screen.queryByRole("button", { name: `${W.allow} ${HOST}` })).toBeNull();
    expect(decides(f)).toHaveLength(1);
    f.close();
  });
});
