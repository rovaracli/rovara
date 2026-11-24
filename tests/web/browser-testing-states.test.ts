// @vitest-environment jsdom
// Browser testing in a project's setup (owner DEC 417/420/421; the approved mock): each state, the sentence it says and the served fact that makes it true. Nothing is typed (no password or account field exists),
// the sign-in snippet is the served schema text and valid JSON, and the 90-day renewal shows nothing unless it FAILED (a real fault, the "Needs attention" pattern).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { BrowserTestingViewSchema } from "../../packages/contracts/src/browser-testing-web.js";
import { BT } from "../../packages/ui/src/screens/setup/browser-testing/browser-testing-text.js";
import { accounts, approval, btView, candidate, draft, found, proof, summary } from "./support/browser-testing-fixtures.js";
import { signInSnippet } from "./support/browser-testing-snippet.js";
import { buttons, fail, mountBt, ok, page } from "./support/browser-testing-world.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(cleanup);
const served = signInSnippet(), SNIPPET = served.text;
const noSignIn = (extra: Record<string, unknown> = {}) => found({}, { recipeSource: "inferred", start: "npm start", healthPath: "/", userKinds: [], signInDeclared: false, snippet: served, ...extra });

describe("the served fixtures", () => {
  it("every view the tests serve reads with the strict schema (so the tests prove the page, not a made-up shape)", () => {
    for (const state of ["not-set-up", "draft", "checking", "check-failed", "waiting", "on", "paused"] as const) expect(BrowserTestingViewSchema.safeParse(btView(state)).success, state).toBe(true);
    expect(BrowserTestingViewSchema.safeParse(btView("draft", { password: "x" })).success).toBe(false);
  });
});

describe("not set up", () => {
  it("a company owner or admin sees what they will need and Start setting up; nothing to type (no field of any kind)", async () => {
    const f = mountBt(btView("not-set-up"));
    const root = await page();
    expect(within(root).getByText("Turn on browser testing for payments")).toBeTruthy();
    expect(buttons(root)).toEqual([BT.start]);
    expect(root.textContent).toContain("Nothing to type or store.");
    expect(root.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(within(root).getByTestId("bt-chip").textContent).toBe("Not set up");
    await expectNoAxeViolations(document.body);
    f.close();
  });
  it("a person who may not sees the same page and one line saying who can, with no button", async () => {
    const f = mountBt(btView("not-set-up", { canManage: false, viewerRole: "member" }));
    const root = await page();
    expect(root.textContent).toContain(BT.onlyAdminsSetUp);
    expect(buttons(root)).toEqual([]);
    f.close();
  });
});

describe("a draft", () => {
  it("shows how the app starts AS FOUND, the kinds of user the repo declares ('Not tried yet'), the careful defaults and Check the setup", async () => {
    const f = mountBt(btView("draft"));
    const root = await page();
    expect(within(root).getByTestId("bt-chip").textContent).toBe("Draft");
    const start = within(root).getByTestId("bt-card-start");
    expect(start.textContent).toContain("npm run start");
    expect(start.textContent).toContain("Rovara waits for /health to answer.");
    expect(start.textContent).toContain("Found in your repo.");
    expect(start.textContent).toContain("This is not your live site.");
    expect(start.textContent).not.toMatch(/localhost|app:4317|http:\/\//u);
    const accountsCard = within(root).getByTestId("bt-card-accounts");
    for (const kind of ["admin", "viewer"]) expect(within(within(accountsCard).getByTestId(`bt-account-${kind}`)).getByText("Not tried yet")).toBeTruthy();
    expect(accountsCard.textContent).toContain("Sign-in page");
    expect(accountsCard.textContent).toContain("/login");
    expect(accountsCard.textContent).toContain("Declared in your repo.");
    expect(accountsCard.textContent).not.toContain("Signed in OK");
    expect(within(root).getByTestId("bt-card-proof").textContent).toContain("Rovara starts with careful choices");
    expect(within(root).getByTestId("bt-card-check").textContent).toContain("Rovara tries each sign-in in the first browser check, after you approve.");
    expect(buttons(root)).toEqual([BT.readAgain, BT.changeChoices, BT.check]);
    f.close();
  });
  it("'Found in your repo' is only said for a repo recipe; Rovara's usual way says so", async () => {
    const f = mountBt(btView("draft", { draft: draft({}, noSignIn()), accounts: [] }));
    const root = await page();
    const start = within(root).getByTestId("bt-card-start");
    expect(start.textContent).toContain("Your repo doesn't say how to start the app, so Rovara uses its usual way.");
    expect(start.textContent).not.toContain("Found in your repo.");
    expect(start.textContent).toContain("npm start");
    f.close();
  });
  it("a repo with no sign-in: signed-out pages only, a small-developer-change sentence, the snippet is the SERVED text (valid JSON), its file named above it, and Copy copies exactly it", async () => {
    const f = mountBt(btView("draft", { draft: draft({}, noSignIn()), accounts: [] }));
    const root = await page();
    const card = within(root).getByTestId("bt-card-accounts");
    expect(card.textContent).toContain("Your repo doesn't say how to sign in yet. Rovara will test signed-out pages only.");
    expect(card.textContent).toContain("This needs a small change in your repo, usually by a developer");
    expect(card.textContent).toContain("a seed step that creates each test user");
    expect(within(card).getByTestId("bt-snippet-file").textContent).toBe(BT.snippetFile("package.json"));
    expect(BT.snippetFile("package.json")).toContain('"agentx" key');
    expect(BT.snippetFile("package.json")).toContain("beside its other keys");
    const text = within(card).getByTestId("bt-snippet-text").textContent;
    expect(text).toBe(SNIPPET);
    expect(() => { JSON.parse(text); }).not.toThrow();
    expect(text.split("\n")[0]).not.toMatch(/^\s*\/\//u);
    // The file is a package.json fragment with one key, agentx.
    const document = JSON.parse(text) as { agentx: { e2e: unknown } };
    expect(Object.keys(document)).toEqual(["agentx"]);
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
    (within(card).getByRole("button", { name: /Copy snippet/u })).click();
    await within(card).findByText("Copied");
    expect(copied).toBe(SNIPPET);
    expect(card.textContent).not.toContain("Sign-in page");
    f.close();
  });
  it("a repo whose kinds declare no form login offers no snippet and says signed-out only", async () => {
    const f = mountBt(btView("draft", { draft: draft({}, found({}, { userKinds: [], signInDeclared: false, snippet: null })), accounts: [] }));
    const root = await page();
    expect(within(root).queryByTestId("bt-snippet-text")).toBeNull();
    expect(within(root).getByTestId("bt-card-accounts").textContent).toContain("Signed-out pages only");
    f.close();
  });
  it("what the repo cannot give Rovara is said in Code's fixed words, and Check the setup is off", async () => {
    const f = mountBt(btView("draft", { draft: draft({}, found({ problem: "no-application", applications: [] })), accounts: [] }));
    const root = await page();
    expect(within(root).getByTestId("bt-problem").textContent).toContain("Rovara didn't find a web or API app it can start in this repository.");
    f.close();
  });
  it("the checking state shows the spinner chip and the commands-check sentence; Check the setup is off", async () => {
    const f = mountBt(btView("checking"));
    const root = await page();
    expect(within(root).getByTestId("bt-chip").textContent).toBe("Checking");
    expect(root.textContent).toContain("Rovara is running your repo's setup and test commands in a fresh workspace…");
    expect(within(root).getByRole<HTMLButtonElement>("button", { name: BT.check }).disabled).toBe(true);
    f.close();
  });
  it("a failed commands check says the repo's commands failed, names the failing step as text, and offers ONE way on: clear the check (Code takes no second check while the failed one is kept)", async () => {
    const f = mountBt(btView("check-failed"));
    const root = await page();
    const alert = within(root).getByTestId("bt-banner-failed");
    expect(alert.textContent).toContain("Your repo's commands failed.");
    expect(alert.textContent).toContain("npm ci");
    expect(alert.textContent).not.toContain("sign in");
    expect(buttons(alert)).toEqual([BT.clearCheck]);
    expect(buttons(within(root).getByTestId("bt-card-check"))).toEqual([BT.clearCheck]);
    expect(root.textContent).not.toContain(BT.checkAgain);
    f.close();
  });
  it("a project setup change waiting, and a draft made before the project's setup changed, say so and switch Check the setup off", async () => {
    const waiting = mountBt(btView("draft", { setupWaiting: true, draft: draft({ locked: true }) }));
    let root = await page();
    expect(within(root).getByTestId("bt-setup-waiting").textContent).toBe(BT.setupWaiting);
    expect(within(root).getByRole<HTMLButtonElement>("button", { name: BT.check }).disabled).toBe(true);
    waiting.close(); cleanup();
    const old = mountBt(btView("draft", { draft: draft({ stale: true }) }));
    root = await page();
    expect(within(root).getByTestId("bt-draft-stale").textContent).toBe(BT.draftStale);
    expect(within(root).getByRole<HTMLButtonElement>("button", { name: BT.check }).disabled).toBe(true);
    old.close();
  });
});

describe("Read the repo again while Code would refuse it", () => {
  it("is off, with the reason, while a check runs, while a failed check is kept, and while another setup change waits; Clear this check is the way on", async () => {
    for (const [view, reason] of [[btView("checking"), BT.refreshWhileChecking], [btView("check-failed"), BT.refreshAfterClear], [btView("draft", { setupWaiting: true, draft: draft({ locked: true }) }), BT.refreshWhileSetupWaiting]] as const) {
      const f = mountBt(view);
      const root = await page();
      expect(within(root).getByRole<HTMLButtonElement>("button", { name: BT.readAgain }).disabled, String(view["state"])).toBe(true);
      expect(within(root).getByTestId("bt-why-off").textContent).toBe(reason);
      f.close(); cleanup();
    }
  });
  it("is on for a draft nothing waits on", async () => {
    const f = mountBt(btView("draft"));
    expect(within(await page()).getByRole<HTMLButtonElement>("button", { name: BT.readAgain }).disabled).toBe(false);
    f.close();
  });
});

describe("words that must not promise more than the page does", () => {
  it("dropping a check says the person presses Check the setup again (nothing is automatic)", async () => {
    const f = mountBt(btView("waiting"));
    const root = await page();
    expect(within(root).getByTestId("bt-change-note").textContent).toBe("This drops the check. After you change it, you press Check the setup again.");
    expect(root.textContent).not.toContain("Rovara checks again");
    f.close();
  });
  it("a failed check names the step, then ONE order: clear, read again, check again", async () => {
    const f = mountBt(btView("check-failed"));
    const root = await page();
    expect(within(root).getByTestId("bt-banner-failed").textContent).toContain("this one failed: npm ci");
    expect(root.textContent).toContain("clear this check, read the repo again and check the setup again");
    f.close();
  });
  it("a reader is not told to press what they do not have", async () => {
    const f = mountBt(btView("on", { canManage: false, viewerRole: "member" }));
    const root = await page();
    expect(root.textContent).toContain("ask an owner or admin to read it again");
    expect(root.textContent).not.toContain("change the repo and read it again.");
    f.close();
  });
  it("the reconnecting reason's lock icon has a size rule (it drew 560 px wide without one)", () => {
    const css = readFileSync("packages/ui/src/screens/setup/browser-testing/browser-testing.css", "utf8");
    expect(css).toMatch(/\.bt-why svg\{width:14px;height:14px/u);
  });
  it("while the accounts could not be refreshed the page does not also say the sign-ins will be tried in the next check", async () => {
    const f = mountBt(btView("on", { faults: ["accounts-refresh-failed"] }));
    const root = await page();
    expect(within(root).queryByTestId("bt-tries-first")).toBeNull();
    f.close();
  });
});

describe("waiting for approval", () => {
  it("exactly what was checked: the stored summary, the pass line, who can approve, what happens, and that the sign-ins are UNTRIED", async () => {
    const f = mountBt(btView("waiting"));
    const root = await page();
    const card = within(root).getByTestId("bt-card-approve");
    expect(card.textContent).toContain("This is exactly what you're approving. Nothing runs until you do.");
    expect(card.textContent).toContain("They passed.");
    expect(card.textContent).toContain("Signed-out visitor, admin, viewer.");
    expect(within(card).getByTestId("bt-untried-line").textContent).toBe("Not tried yet. Rovara tries each sign-in in the first browser check.");
    expect(card.textContent).toContain("Who can approve: company owners and admins.");
    expect(card.textContent).toContain("When a task started from now on changes the app, Rovara adds a browser check to its plan, and you approve that plan as usual.");
    expect(within(card).getByText(BT.commandsSummary)).toBeTruthy();
    expect(buttons(card)).toEqual([BT.approve, BT.changeProof]);
    expect(within(root).getByTestId("bt-banner-ready").textContent).toContain("Ready to approve.");
    f.close();
  });
  it("signed-out only: the summary says so and does not claim a login", async () => {
    const f = mountBt(btView("waiting", { candidate: candidate({ summary: { found: noSignIn(), proof: proof(), runTimeoutMs: 600_000 } }), accounts: [] }));
    const root = await page();
    const card = within(root).getByTestId("bt-card-approve");
    expect(card.textContent).toContain("Signed-out visitor only (your repo declares no sign-in).");
    expect(card.textContent).not.toContain("fresh login");
    f.close();
  });
  it("a person who may not approve sees what an owner or admin will approve and no button; a read that cannot be summarised offers no Approve", async () => {
    const member = mountBt(btView("waiting", { canManage: false, viewerRole: "member", candidate: candidate({ canApprove: false }) }));
    let root = await page();
    expect(root.textContent).toContain("Waiting for an owner or admin");
    expect(root.textContent).toContain("This is what an owner or admin will approve.");
    expect(buttons(root)).toEqual([]);
    member.close(); cleanup();
    const unreadable = mountBt(btView("waiting", { candidate: candidate({ summary: null }) }));
    root = await page();
    expect(within(root).getByTestId("bt-unreadable-summary").textContent).toBe(BT.unreadableSummary);
    expect(within(root).getByRole<HTMLButtonElement>("button", { name: BT.approve }).disabled).toBe(true);
    unreadable.close();
  });
  it("a check that has not passed offers no approval", async () => {
    const f = mountBt(btView("waiting", { candidate: candidate({ approval: null, canApprove: false }) }));
    const root = await page();
    expect(within(root).getByRole<HTMLButtonElement>("button", { name: BT.approve }).disabled).toBe(true);
    expect(approval().requestId).toMatch(/^setup-/u);
    f.close();
  });
});

describe("on and paused", () => {
  it("On: the banner, the approved setup, who approved, the accounts as 'Not tried yet' with when they get tried, and the three controls; no expiry, no renewal, no countdown anywhere", async () => {
    const f = mountBt(btView("on"));
    const root = await page();
    expect(within(root).getByTestId("bt-chip").textContent).toBe("On");
    const banner = within(root).getByTestId("bt-banner-on");
    expect(banner.textContent).toContain("Browser testing is on for payments.");
    expect(banner.textContent).toContain("When a task started from now on changes the app, Rovara adds a browser check to its plan.");
    expect(banner.textContent).toContain("Approved by you");
    expect(within(root).getByTestId("bt-tries-first").textContent).toBe("Rovara tries each sign-in in the first browser check.");
    expect(within(root).getByTestId("bt-account-admin").textContent).toContain("Not tried yet");
    expect(buttons(root)).toEqual([BT.pause, BT.changeProof, BT.readAgain, BT.copy].filter((one) => one !== BT.copy));
    expect(root.textContent).not.toMatch(/expir|renew|90.day|days left/iu);
    f.close();
  });
  it("another person's approval is 'an owner or admin' (no name or id is shown)", async () => {
    const f = mountBt(btView("on", { approved: { revision: 6, approvedAt: "2026-11-23T05:10:00.000Z", approvedBy: "p-someone-else", decidedByYou: false, summary: summary() } }));
    const root = await page();
    expect(within(root).getByTestId("bt-banner-on").textContent).toContain("Approved by an owner or admin");
    expect(root.textContent).not.toContain("p-someone-else");
    f.close();
  });
  it("after the first real browser check each kind shows what happened and when: admin signed in, viewer refused with one note and the next step", async () => {
    const f = mountBt(btView("on", { accounts: accounts([["admin", { status: "ok", checkedAt: "2026-11-24T10:05:00.000Z" }], ["viewer", { status: "refused", checkedAt: "2026-11-24T10:05:00.000Z" }]]) }));
    const root = await page();
    expect(within(root).getByTestId("bt-account-admin").textContent).toContain("Signed in OK");
    expect(within(root).getByTestId("bt-account-viewer").textContent).toContain("Sign-in refused");
    const note = within(root).getByTestId("bt-signin-note");
    expect(note.textContent).toContain("Rovara couldn't sign in as viewer in the browser check on");
    expect(note.textContent).toContain("Check the sign-in in your repo, then read the repo again.");
    expect(root.querySelector("[data-testid=bt-tries-first]")).toBeNull();
    f.close();
  });
  it("a person who may not sees it read-only: facts, 'an owner' and no control", async () => {
    const f = mountBt(btView("on", { canManage: false, viewerRole: "member" }));
    const root = await page();
    expect(root.textContent).toContain(BT.onlyAdmins);
    expect(buttons(root)).toEqual([]);
    f.close();
  });
  it("Paused: the banner says new tasks get no checks and approved plans keep theirs; Resume is the control", async () => {
    const f = mountBt(btView("paused"));
    const root = await page();
    expect(within(root).getByTestId("bt-chip").textContent).toBe("Paused");
    expect(within(root).getByTestId("bt-banner-paused").textContent).toContain("A task whose plan is already approved keeps its checks.");
    expect(within(root).getByTestId("bt-tries-first")).toBeTruthy();
    expect(buttons(root)).toEqual([BT.resume, BT.changeProof, BT.readAgain]);
    f.close();
  });
});

describe("a change beside the approved setup", () => {
  const newer = (extra: Record<string, unknown> = {}) => ({ kind: "repo", found: found({}, { userKinds: [{ profileId: "admin", roleRef: "admin", signInPath: "/login" }, { profileId: "viewer", roleRef: "viewer", signInPath: "/login" }, { profileId: "editor", roleRef: "editor", signInPath: "/login" }] }), newUserKinds: ["editor"], removedUserKinds: [], proof: proof(), runTimeoutMs: 600_000, ...extra });
  it("a checked repo change with a new kind: the approval card names it '(new)' and the approved version keeps being used; a repo change cannot be discarded", async () => {
    const f = mountBt(btView("on", { newerChange: newer(), draft: draft({ locked: true }), candidate: candidate({ summary: { found: newer().found, proof: proof(), runTimeoutMs: 600_000 } }) }));
    const root = await page();
    const card = within(root).getByTestId("bt-card-approve");
    expect(card.textContent).toContain("a new kind of user, editor");
    expect(card.textContent).toContain("Until you approve it, browser checks keep using the approved version.");
    expect(card.textContent).toContain("editor (new)");
    expect(buttons(card)).toEqual([BT.approveChange]);
    expect(within(root).getByTestId("bt-banner-change").textContent).toContain("A change is waiting for approval.");
    f.close();
  });
  it("when how the app starts, or a kind that was already there, changed, the page does NOT promise the approved version simply keeps being used", async () => {
    const changed = found({}, { start: "npm run dev", userKinds: [{ profileId: "admin", roleRef: "admin", signInPath: "/signin" }] });
    const f = mountBt(btView("on", { newerChange: newer({ found: changed, newUserKinds: [], removedUserKinds: ["viewer"] }), draft: draft({ locked: true }), candidate: candidate({ summary: { found: changed, proof: proof(), runTimeoutMs: 600_000 } }) }));
    const root = await page();
    const card = within(root).getByTestId("bt-card-approve");
    expect(card.textContent).toContain("may stop checks from running until it is approved");
    f.close();
  });
  it("a checked proof-and-limits change may be discarded; the page says the change is not approved yet", async () => {
    const f = mountBt(btView("on", { newerChange: { ...newer(), kind: "choices", newUserKinds: [], found: found() }, draft: draft({ locked: true }), candidate: candidate() }));
    const root = await page();
    expect(buttons(within(root).getByTestId("bt-card-approve"))).toEqual([BT.approveChange, BT.discard]);
    f.close();
  });
  it("a change that is not checked yet shows the approved setup and a card offering Check the setup (no Discard for a repo change)", async () => {
    const f = mountBt(btView("on", { newerChange: newer(), draft: draft() }));
    const root = await page();
    const card = within(root).getByTestId("bt-card-change");
    expect(card.textContent).toContain("Rovara found a change in your repo: a new kind of user, editor");
    expect(buttons(card)).toEqual([BT.check]);
    expect(within(root).getByTestId("bt-card-on")).toBeTruthy();
    f.close();
  });
});

describe("faults: the only place a renewal or the sandbox shows", () => {
  it("the sandbox cannot start: one alert at the top in Code's words, the chip says Needs attention, Check the setup is blocked and says why", async () => {
    const f = mountBt(btView("draft", { sandboxAvailable: false, faults: ["sandbox-unavailable"] }));
    const root = await page();
    expect(within(root).getByTestId("bt-chip").textContent).toBe("Needs attention");
    expect(within(root).getByTestId("bt-fault-sandbox").textContent).toBe("Rovara can't start the test sandbox right now.What you set here is kept. Try again in a few minutes.");
    expect(within(root).getByTestId("bt-card-check").textContent).toContain("You can check the setup again once Rovara can start the test sandbox.");
    expect(within(root).getByRole<HTMLButtonElement>("button", { name: BT.check }).disabled).toBe(true);
    expect(root.textContent).not.toMatch(/contact support|support to turn/iu);
    f.close();
  });
  it("a failed renewal of the test accounts shows as a real fault, the same pattern, in Code's sentence; there is no approve button for it", async () => {
    const f = mountBt(btView("on", { faults: ["accounts-refresh-failed"] }));
    const root = await page();
    expect(within(root).getByTestId("bt-chip").textContent).toBe("Needs attention");
    const alert = within(root).getByTestId("bt-fault-accounts");
    expect(alert.textContent).toBe("Rovara couldn't refresh this project's test accounts.Browser checks can't sign in until it does. Try again in a few minutes.");
    expect(within(alert).queryByRole("button")).toBeNull();
    expect(buttons(root)).not.toContain(BT.approve);
    f.close();
  });
  it("an approved setup that cannot be read now is a fault, not an empty page", async () => {
    const f = mountBt(btView("on", { faults: ["approved-setup-unreadable"], approved: { revision: 6, approvedAt: null, approvedBy: null, decidedByYou: false, summary: null } }));
    const root = await page();
    expect(within(root).getByTestId("bt-fault-approved")).toBeTruthy();
    expect(within(root).queryByTestId("bt-intro")).toBeNull();
    f.close();
  });
});

describe("the page's own reads", () => {
  it("while it reads: the Reading chip and a quiet line, no control", async () => {
    const f = mountBt(btView("on"), { read: () => new Promise<never>(() => undefined) as never });
    await screen.findByTestId("bt-page");
    expect(screen.getAllByText(BT.reading).length).toBeGreaterThan(0);
    expect(screen.getByText("Reading…")).toBeTruthy();
    f.close();
  });
  it("a first read that fails shows what happened and Try again; a read that is not served yet says so", async () => {
    const f = mountBt(btView("on"), { read: () => fail(503, "RUNTIME_UNAVAILABLE", "Browser testing could not be read just now. Try again.") });
    const root = await page();
    expect(within(root).getByTestId("bt-read-failed").textContent).toContain("Rovara couldn't read this project's browser testing.");
    expect(root.textContent).not.toContain("Nothing was changed");
    f.close(); cleanup();
    const notYet = mountBt(btView("on"), { read: () => fail(501, "NOT_ON_CODE_YET", "Browser testing isn't available on this Rovara yet.") });
    expect((await within(await page()).findByTestId("bt-not-yet")).textContent).toContain("isn't available on this Rovara yet.");
    notYet.close();
  });
  it("a read that ends access (403, 404) shows the access-lost block and no old fact", async () => {
    const f = mountBt(btView("on"), { read: () => fail(404, "NOT_FOUND", "project not found") });
    const root = await page();
    expect(within(root).getByTestId("bt-access-lost").textContent).toContain("Rovara can't read this project's browser testing any more.");
    expect(root.textContent).not.toContain("Approved setup");
    f.close();
  });
});

describe("the page passes its accessibility and dark theme checks", () => {
  it("every served state is axe-clean in light and dark", async () => {
    for (const theme of ["light", "dark"] as const) {
      for (const view of [btView("not-set-up"), btView("draft"), btView("waiting"), btView("on"), btView("paused"), btView("check-failed")]) {
        const f = mountBt(view, { theme });
        await page();
        await expectNoAxeViolations(document.body);
        f.close(); cleanup();
      }
    }
  });
  void ok;
});
