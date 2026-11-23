// @vitest-environment jsdom
// Browser testing: who may change what, and what a read that failed, an answer that was lost or a change that moved takes away (rule #14, DEC 254zzz324; the mock's "Reads and writes" table). Every write control is enabled
// only while the page's read is fresh AND says this person may; at send time the read is asked again and a failed, changed or no-longer-allowed read sends NOTHING. A change is never repeated by the page: a lost answer
// locks every change until a read (Check) says what Rovara has.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BT } from "../../packages/ui/src/screens/setup/browser-testing/browser-testing-text.js";
import { BROWSER_TESTING_CLOUD_SENTENCES as CLOUD, BROWSER_TESTING_CODE_SENTENCES as CODE } from "../../packages/contracts/src/browser-testing-web.js";
import { BT_DIGEST, approval, btView, candidate, draft, found, summary } from "./support/browser-testing-fixtures.js";
import { PATH, UUID, buttons, fail, mountBt, ok, page, type Bt } from "./support/browser-testing-world.js";

afterEach(cleanup);
const click = async (name: string | RegExp) => { fireEvent.click((await screen.findAllByRole("button", { name }))[0]!); };
const disabled = (name: string | RegExp) => (screen.getByRole<HTMLButtonElement>("button", { name })).disabled;
const decided = (view: Record<string, unknown>) => ({ project: "payments", decision: "approved", revision: 5, replayed: false, view });
const settle = async (f: Bt) => { await waitFor(() => expect(f.writes().length + f.gets().length).toBeGreaterThan(0)); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

const WRITES: Array<{ name: string; view: Record<string, unknown>; label: string | RegExp; method: string; tail: string; body: Record<string, unknown>; next: Record<string, unknown> }> = [
  { name: "Start setting up", view: btView("not-set-up"), label: BT.start, method: "POST", tail: "/refresh", body: { requestId: UUID }, next: btView("draft") },
  { name: "Read the repo again", view: btView("draft"), label: BT.readAgain, method: "POST", tail: "/refresh", body: { requestId: UUID }, next: btView("draft") },
  { name: "Check the setup", view: btView("draft"), label: BT.check, method: "POST", tail: "/check", body: { requestId: UUID, expectedDraftRevision: 3 }, next: btView("checking") },
  { name: "Approve browser testing", view: btView("waiting"), label: BT.approve, method: "POST", tail: "/decision", body: { requestId: approval().requestId, outcome: "approve", seen: { revision: 5, artifactDigest: BT_DIGEST } }, next: decided(btView("on")) },
  { name: "Change proof and limits (a waiting check)", view: btView("waiting"), label: BT.changeProof, method: "POST", tail: "/discard", body: { requestId: UUID }, next: btView("draft") },
  { name: "Clear this check (a failed check)", view: btView("check-failed"), label: BT.clearCheck, method: "POST", tail: "/discard", body: { requestId: UUID }, next: btView("draft") },
  { name: "Pause browser testing", view: btView("on"), label: BT.pause, method: "POST", tail: "/pause", body: { requestId: UUID }, next: btView("paused") },
  { name: "Resume browser testing", view: btView("paused"), label: BT.resume, method: "POST", tail: "/resume", body: { requestId: UUID }, next: btView("on") },
];

describe("a person who may change (the served read says so)", () => {
  it.each(WRITES)("$name sends exactly ONE request, with the listed members and nothing else", async ({ view, label, method, tail, body, next, name }) => {
    const f = mountBt(view, { write: () => ok(next) });
    await page();
    await click(label);
    // Pause asks first: the dialog's own Pause button is the one that sends.
    if (name === "Pause browser testing") fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: BT.pause }));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    const [sent] = f.writes();
    expect([sent!.method, sent!.path, sent!.body]).toEqual([method, PATH + tail, body]);
    f.close();
  });
  it("the page shows what the change answered (the page's read again) without asking again", async () => {
    const f = mountBt(btView("waiting"), { write: () => ok(decided(btView("on"))) });
    await page();
    const reads = f.gets().length;
    await click(BT.approve);
    await waitFor(() => expect(screen.getByTestId("bt-chip").textContent).toBe("On"));
    expect(f.gets().length).toBe(reads + 1); // the one re-read made before sending
    f.close();
  });
  it("Save choices sends the draft revision the person saw and only the two choices; nothing unchanged is sent as a change", async () => {
    const f = mountBt(btView("draft"), { write: () => ok(btView("draft")) });
    await page();
    await click(BT.changeChoices);
    expect(disabled(BT.saveChoices)).toBe(true);
    fireEvent.click(screen.getByLabelText(BT.editAll));
    fireEvent.click(screen.getByLabelText(BT.keepVideo));
    fireEvent.change(screen.getByLabelText(BT.editLimit), { target: { value: String(20 * 60_000) } });
    await click(BT.saveChoices);
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(f.writes()[0]).toMatchObject({ method: "PUT", path: PATH + "/draft", body: { requestId: UUID, expectedDraftRevision: 3, proof: { screenshotMode: "all", video: true }, runTimeoutMs: 1_200_000 } });
    f.close();
  });
  it("Change proof and limits on the On page reads the repo (one refresh), then edits from the APPROVED choices", async () => {
    const f = mountBt(btView("on"), { write: () => ok(btView("on", { draft: draft() })) });
    await page();
    await click(BT.changeProof);
    await screen.findByRole("button", { name: BT.saveChoices });
    expect(f.writes().map((r) => r.path)).toEqual([PATH + "/refresh"]);
    expect(screen.getByLabelText<HTMLInputElement>(BT.editFailed).checked).toBe(true);
    f.close();
  });
  it("Pause asks first: the dialog says what it does, Keep it on sends nothing, Pause sends one", async () => {
    const f = mountBt(btView("on"), { write: () => ok(btView("paused")) });
    await page();
    await click(BT.pause);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("A task whose plan is already approved keeps its checks.");
    fireEvent.click(within(dialog).getByRole("button", { name: BT.keepOn }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.writes()).toHaveLength(0);
    await click(BT.pause);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: BT.pause }));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("bt-chip").textContent).toBe("Paused"));
    f.close();
  });
  it("a second press while a change is in flight sends nothing more", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const g = mountBt(btView("waiting"));
    await page();
    const original = g.host.transport.request.bind(g.host.transport);
    g.host.transport.request = async (request) => { if (request.method !== "GET") await held; return original(request); };
    await click(BT.approve);
    fireEvent.click(screen.getByRole("button", { name: /Approv/u }));
    release();
    await waitFor(() => expect(g.writes()).toHaveLength(1));
    g.close();
  });
});

describe("a person who may not", () => {
  it.each([["member"], ["project-admin"]])("a %s (the read says canManage false) sees the facts and NO control in any state", async (role) => {
    for (const view of [btView("not-set-up"), btView("draft"), btView("check-failed"), btView("waiting", { candidate: candidate({ canApprove: false }) }), btView("on"), btView("paused")]) {
      const f = mountBt({ ...view, canManage: false, viewerRole: role });
      const root = await page();
      expect(buttons(root), `${role} ${String(view["state"])}`).toEqual([]);
      expect(root.querySelectorAll("input, select, textarea")).toHaveLength(0);
      f.close(); cleanup();
    }
  });
  it("a read that says canManage but a candidate this person cannot approve keeps Approve off", async () => {
    const f = mountBt(btView("waiting", { candidate: candidate({ canApprove: false }) }));
    await page();
    expect(disabled(BT.approve)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: BT.approve }));
    await settle(f);
    expect(f.writes()).toHaveLength(0);
    f.close();
  });
});

describe("a read that failed takes the controls away (never hides them)", () => {
  it("a transient failed re-read keeps the facts and ONE reconnecting line, and every write control is off: a press sends nothing", async () => {
    const f = mountBt(btView("waiting"));
    await page();
    f.serve(fail(503, "RUNTIME_UNAVAILABLE", CLOUD.unavailable));
    await f.refetch();
    await screen.findByTestId("bt-stale");
    expect(screen.getByTestId("bt-stale").textContent).toBe(BT.stale);
    expect(screen.getAllByText(BT.stale)).toHaveLength(1);
    expect(screen.getByTestId("bt-card-approve")).toBeTruthy();
    expect(disabled(BT.approve)).toBe(true);
    expect(disabled(BT.changeProof)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: BT.approve }));
    await settle(f);
    expect(f.writes()).toHaveLength(0);
    f.close();
  });
  it("the same on the On and draft pages: every control is disabled while stale, and comes back when the read does", async () => {
    for (const view of [btView("on"), btView("draft")]) {
      const f = mountBt(view);
      const root = await page();
      const labels = buttons(root).filter((text) => text !== BT.copy);
      f.serve(fail(503, "RUNTIME_UNAVAILABLE", CLOUD.unavailable));
      await f.refetch();
      await screen.findByTestId("bt-stale");
      for (const label of labels) expect(disabled(label), label).toBe(true);
      f.serve(view);
      await f.refetch();
      await waitFor(() => expect(screen.queryByTestId("bt-stale")).toBeNull());
      for (const label of labels) expect(disabled(label), label).toBe(false);
      expect(f.writes()).toHaveLength(0);
      f.close(); cleanup();
    }
  });
  it("an access signal clears the facts (a person whose role ended sees no old controls) and says nothing about a change", async () => {
    const f = mountBt(btView("waiting"));
    await page();
    f.serve(fail(403, "FORBIDDEN", "no"));
    await f.refetch();
    await screen.findByTestId("bt-access-lost");
    expect(screen.queryByTestId("bt-card-approve")).toBeNull();
    expect(screen.getByTestId("bt-access-lost").textContent).not.toContain(BT.wentThrough);
    expect(buttons(screen.getByTestId("bt-page"))).toEqual([BT.reload]);
    f.close();
  });
  it("the identity moved between the read and the press: the re-read says this person may not, NOTHING is sent, and the page says so", async () => {
    const f = mountBt(btView("waiting"));
    await page();
    f.serve(btView("waiting", { canManage: false, viewerRole: "project-admin" }));
    await click(BT.approve);
    await screen.findByTestId("bt-no-permission");
    expect(screen.getByTestId("bt-no-permission").textContent).toContain("Nothing was sent.");
    expect(f.writes()).toHaveLength(0);
    f.close();
  });
  it("review L1: a 403 AFTER the request was sent never says 'Nothing was sent' (it says nothing was changed)", async () => {
    const f = mountBt(btView("waiting"), { write: () => fail(403, "FORBIDDEN", CODE.notAllowed) });
    await page();
    await click(BT.approve);
    await screen.findByTestId("bt-no-permission");
    expect(f.writes()).toHaveLength(1);
    const text = screen.getByTestId("bt-no-permission").textContent ?? "";
    expect(text).not.toContain("Nothing was sent");
    expect(text).toContain("Nothing was changed.");
    f.close();
  });
  it("the re-read at send time fails: NOTHING is sent and the page says what it knows (that nothing was sent)", async () => {
    const f = mountBt(btView("draft"));
    await page();
    f.serve(fail(503, "RUNTIME_UNAVAILABLE", CLOUD.unavailable));
    await click(BT.check);
    await screen.findByTestId("bt-refused");
    expect(screen.getByTestId("bt-refused").textContent).toContain("nothing was sent");
    expect(f.writes()).toHaveLength(0);
    f.close();
  });
  it("Read the repo again is not sent when the re-read shows a check waiting", async () => {
    const f = mountBt(btView("draft"));
    await page();
    f.serve(btView("checking"));
    await click(BT.readAgain);
    await screen.findByTestId("bt-conflict");
    expect(f.writes()).toHaveLength(0);
    f.close();
  });
  it("what the person saw is not what is there now (a new digest, a new draft revision): a conflict, NOTHING is sent", async () => {
    const f = mountBt(btView("waiting"));
    await page();
    f.serve(btView("waiting", { candidate: candidate({ approval: { ...approval(), artifactDigest: "b".repeat(64) } }) }));
    await click(BT.approve);
    await screen.findByTestId("bt-conflict");
    expect(screen.getByTestId("bt-conflict").textContent).toContain("This changed while you were looking.");
    expect(f.writes()).toHaveLength(0);
    cleanup(); f.close();
    const g = mountBt(btView("draft"));
    await page();
    g.serve(btView("draft", { draft: draft({ revision: 4 }) }));
    await click(BT.check);
    await screen.findByTestId("bt-conflict");
    expect(g.writes()).toHaveLength(0);
    g.close();
  });
  it("a check that stopped being allowed (the sandbox went away) is not sent", async () => {
    const f = mountBt(btView("draft"));
    await page();
    f.serve(btView("draft", { sandboxAvailable: false, faults: ["sandbox-unavailable"] }));
    await click(BT.check);
    await screen.findByTestId("bt-conflict");
    expect(f.writes()).toHaveLength(0);
    f.close();
  });
});

describe("a change that was refused, or whose answer was lost", () => {
  it("Code's 409 'changed while you were looking' is the conflict notice (and the page reads again); nothing is repeated", async () => {
    const f = mountBt(btView("draft"), { write: () => fail(409, "CHANGE_STALE", CODE.stale) });
    await page();
    await click(BT.check);
    await screen.findByTestId("bt-conflict");
    expect(f.writes()).toHaveLength(1);
    f.close();
  });
  it("a refusal in Code's fixed words shows those words (the sandbox, another change waiting); any other text of a refusal never reaches the page", async () => {
    const f = mountBt(btView("draft"), { write: () => fail(503, "RUNTIME_UNAVAILABLE", CODE.sandboxUnavailable) });
    await page();
    await click(BT.check);
    expect((await screen.findByTestId("bt-refused")).textContent).toBe(CODE.sandboxUnavailable);
    expect(screen.queryByTestId("bt-unknown")).toBeNull();
    f.close(); cleanup();
    const g = mountBt(btView("draft"), { write: () => fail(409, "WORKSPACE_BUSY", "Code's own words: <script>do-not-echo") });
    await page();
    await click(BT.check);
    await waitFor(() => expect(g.writes()).toHaveLength(1));
    await screen.findByTestId("bt-refused");
    expect(document.body.textContent).not.toContain("do-not-echo");
    g.close();
  });
  it.each([
    ["Cloud's 'outcome is unknown' answer", () => fail(503, "RUNTIME_UNAVAILABLE", CLOUD.outcomeUnknown)],
    ["a dropped connection", () => { throw new TypeError("network"); }],
    ["a server error with words nobody fixed", () => fail(500, "INTERNAL", "boom")],
    ["an answer that is not the page's read", () => ok({ nothing: "useful" })],
  ])("%s: the page says it did not hear back, every change stays OFF, nothing is sent again, and Check is a READ", async (_name, answer) => {
    const f = mountBt(btView("waiting"), { write: answer });
    await page();
    await click(BT.approve);
    await screen.findByTestId("bt-unknown");
    expect(screen.getByTestId("bt-unknown").textContent).toContain("It may or may not have gone through.");
    expect(document.body.textContent).not.toMatch(/nothing was changed|was not made/iu);
    for (const label of [BT.approve, BT.changeProof]) expect(disabled(label), String(label)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: BT.approve }));
    await settle(f);
    expect(f.writes()).toHaveLength(1);
    const reads = f.gets().length;
    f.serve(btView("on"));
    await click(BT.checkNow);
    await screen.findByTestId("bt-checked");
    expect(f.gets().length).toBeGreaterThan(reads);
    expect(f.writes()).toHaveLength(1);
    expect(screen.getByTestId("bt-chip").textContent).toBe("On");
    expect(disabled(BT.pause)).toBe(false);
    f.close();
  });
  it("Check that cannot read leaves the lock on", async () => {
    const f = mountBt(btView("waiting"), { write: () => fail(503, "RUNTIME_UNAVAILABLE", CLOUD.outcomeUnknown) });
    await page();
    await click(BT.approve);
    await screen.findByTestId("bt-unknown");
    f.serve(fail(503, "RUNTIME_UNAVAILABLE", CLOUD.unavailable));
    await click(BT.checkNow);
    await settle(f);
    expect(screen.queryByTestId("bt-checked")).toBeNull();
    expect(disabled(BT.approve)).toBe(true);
    f.close();
  });
  it("after a change went through, a read that then fails transiently says 'Saved. Couldn't refresh; reconnecting.' and keeps every control off", async () => {
    const f = mountBt(btView("waiting"), { write: () => ok(decided(btView("on"))) });
    await page();
    await click(BT.approve);
    await waitFor(() => expect(screen.getByTestId("bt-chip").textContent).toBe("On"));
    f.serve(fail(503, "RUNTIME_UNAVAILABLE", CLOUD.unavailable));
    await f.refetch();
    const saved = await screen.findByTestId("bt-saved-stale");
    expect(saved.textContent).toContain("Your change went through.");
    expect(disabled(BT.pause)).toBe(true);
    f.close();
  });
  it("after a change went through, a read that ends access says 'Your change went through.' in the access-lost block", async () => {
    const f = mountBt(btView("waiting"), { write: () => ok(decided(btView("on"))) });
    await page();
    await click(BT.approve);
    await waitFor(() => expect(screen.getByTestId("bt-chip").textContent).toBe("On"));
    f.serve(fail(404, "NOT_FOUND", "project not found"));
    await f.refetch();
    expect((await screen.findByTestId("bt-access-lost")).textContent).toContain("Your change went through.");
    f.close();
  });
});

describe("nothing typed, nothing remembered", () => {
  it("the page holds no field a person types a login into, in any state, and writes nothing to the browser's storage", async () => {
    const before = JSON.stringify({ ...localStorage });
    for (const view of [btView("draft", { draft: draft({}, found({}, { snippet: { path: "package.json", text: "{}\n", needsSeedStep: true }, signInDeclared: false, userKinds: [] })) }), btView("waiting"), btView("on")]) {
      const f = mountBt(view);
      const root = await page();
      expect(root.querySelectorAll("input[type=password], input[type=email], input[type=text], textarea, input[autocomplete]")).toHaveLength(0);
      expect(JSON.stringify({ ...localStorage })).toBe(before);
      expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/password|secret/iu);
      f.close(); cleanup();
    }
    expect(summary().found.problem).toBeNull();
  });
});
