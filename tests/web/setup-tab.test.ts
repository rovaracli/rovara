// @vitest-environment jsdom
// The project's Setup tab (FABLE-REVIEW 2026-11-23): one tab, the status card with ONE primary action, the addresses to decide right under it (Allow / Refuse, never red), this run, the extras, and the limits at the
// bottom. Each test opens the real project page on ?tab=setup against a fake host whose setup reads are held in plain objects (support/setup-tab-world.ts).
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expectNoAxeViolations } from "./support/axe.js";
import { stateTime } from "../../packages/ui/src/screens/setup-tab/use-setup-tab.js";
import { ask, apply, entry, err, failedRow, mountSetupTab, PROPOSAL, DIGEST, DEFAULTS, type SetupWorld } from "./support/setup-tab-world.js";

afterEach(cleanup);
const card = async () => within(await screen.findByTestId("setup-status-card"));
const startRequests = (f: SetupWorld) => f.sent("POST", "/setup-agent");
const ready = { status: "ready", basedOnRevision: 3, canManage: true, stop: "proposed", startedAt: "2026-11-24T10:00:00.000Z" };
const approvedRow = (over: Record<string, unknown> = {}) => failedRow({ state: "done", status: "ready", approval: "approved", check: { status: "ready" }, approvedAt: "2026-11-12T10:00:00.000Z", failure: undefined, failedCommand: undefined, testOutcome: "passed", ...over });
const buttonsOf = (scope: HTMLElement) => within(scope).queryAllByRole("button").map(one => one.textContent);

describe("the header's time is the time of the state it names", () => {
  const at = (start: string, over: Record<string, unknown> = {}) => stateTime({ run: { status: "ready", startedAt: start } as never, checklist: { setupRun: { elapsedMs: 600_000, approval: "none", ...over } } as never });
  const ms = (text: string) => Date.parse(text);
  it("a run that is going: its start; a finished run: its start plus how long it took; a setup in use: when it was approved; a newer one waiting: its own run's end, never the old approval", () => {
    expect(stateTime({ run: { status: "running", startedAt: "2026-11-24T10:00:00.000Z" } as never, checklist: undefined })).toBe(ms("2026-11-24T10:00:00.000Z"));
    expect(at("2026-11-24T10:00:00.000Z")).toBe(ms("2026-11-24T10:10:00.000Z"));
    expect(at("2026-11-24T10:00:00.000Z", { approval: "approved", approvedAt: "2026-11-24T10:20:00.000Z" })).toBe(ms("2026-11-24T10:20:00.000Z"));
    expect(at("2026-11-24T10:00:00.000Z", { approval: "approved", approvedAt: "2026-11-12T10:20:00.000Z", newerProposal: "needs_you" })).toBe(ms("2026-11-24T10:10:00.000Z"));
    expect(stateTime({ run: undefined, checklist: undefined })).toBeUndefined();
  });
});

describe("where it lives", () => {
  it("is the tab just before Settings on the project page, at ?tab=setup, with the state as a chip and one line beside the project name", async () => {
    const f = mountSetupTab({ run: { status: "none", basedOnRevision: 3, canManage: true }, row: failedRow({ state: "needs_you", status: "none" }) });
    await card();
    expect(screen.getAllByRole("tab").map(tab => tab.textContent).slice(0, 3)).toEqual(["Overview", "How we work", "Setup"]);
    expect(screen.getByRole("tab", { name: "Setup" }).getAttribute("aria-selected")).toBe("true");
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("img", { name: "Needs you" })).toBeTruthy();
    expect(header.textContent).toContain("Setup hasn't run yet");
    f.close();
  });
  it("hides the checklist and the start box above it, so the card is right under the tabs; the Overview tab keeps them and no longer holds the limits", async () => {
    const f = mountSetupTab();
    await card();
    expect(screen.queryByTestId("project-checklist")).toBeNull();
    f.close(); cleanup();
    const overview = mountSetupTab({}, { path: "/app/projects/payments" });
    await screen.findByTestId("project-checklist");
    expect(screen.queryByRole("heading", { name: "Setup limits" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Limits for a setup run" })).toBeNull();
    overview.close();
  });
  it("status does not vanish when the checklist reaches 100%: the tab still says where setup stands", async () => {
    const f = mountSetupTab({ run: { ...ready, canManage: true }, row: approvedRow() });
    expect((await card()).getByRole("heading").textContent).toBe("Setup approved. Tasks in payments use this setup.");
    expect(screen.getByTestId("setup-run")).toBeTruthy();
    f.close();
  });
  it("a verified setup offers Start a task as the one primary to a person who may start work, and Run setup again is then secondary", async () => {
    const f = mountSetupTab({ run: { ...ready, canManage: true }, row: approvedRow() });
    const c = await card();
    expect(c.getByRole("link", { name: "Start a task" }).className).toContain("rv-button-primary");
    expect(c.getByRole("button", { name: "Run setup again" }).className).not.toContain("rv-button-primary");
    f.close();
  });
  it("Code not serving the setup run says so once, and shows no other section", async () => {
    const f = mountSetupTab({ route: request => request.path.endsWith("/setup-agent") && request.method === "GET" ? err(501, "NOT_ON_CODE_YET", "x") : undefined });
    expect((await screen.findByTestId("setup-run-not-yet")).textContent).toBe("Setup with Rovara isn't available on this Rovara yet.");
    expect(screen.queryByTestId("setup-status-card")).toBeNull();
    f.close();
  });
  it("a run that can't be read says Rovara couldn't read where setup stands, with Read again", async () => {
    const f = mountSetupTab({ route: request => request.path.endsWith("/setup-agent") && request.method === "GET" ? err(503, "RUNTIME_UNAVAILABLE", "boom") : undefined });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("Rovara couldn't read where setup stands");
    expect(c.getByRole("button", { name: "Read again" })).toBeTruthy();
    f.close();
  });
  it("Settings keeps one line that points at the Setup tab, and no Re-run or Re-check", async () => {
    const f = mountSetupTab({}, { path: "/app/projects/payments?tab=settings" });
    const section = await screen.findByTestId("project-settings-setup");
    expect(section.textContent).toContain("Setup is managed on the Setup tab.");
    expect(within(section).getByRole("link", { name: "Open Setup" }).getAttribute("href")).toBe("/app/projects/payments?tab=setup");
    expect(screen.queryByRole("button", { name: /Re-run setup|Re-check setup/u })).toBeNull();
    f.close();
  });
});

describe("start, stop and run again", () => {
  it("Run setup sends exactly the request id once, and the card then says Rovara is setting up", async () => {
    const f = mountSetupTab({ run: { status: "none", basedOnRevision: 3, canManage: true }, row: failedRow({ state: "needs_you", status: "none" }),
      write: (request, world) => { if (request.method === "POST" && request.path.endsWith("/setup-agent")) { world.run = { status: "running", basedOnRevision: 3, canManage: true, startedAt: "2026-11-24T10:00:00.000Z" }; world.row = failedRow({ state: "running", status: "running" }); return { status: 202, body: { ...world.run, limits: DEFAULTS } }; } return undefined; } });
    fireEvent.click(await (await card()).findByRole("button", { name: "Run setup" }));
    await waitFor(() => expect(startRequests(f)).toHaveLength(1));
    expect(Object.keys(startRequests(f)[0]!.body as object)).toEqual(["requestId"]);
    await waitFor(() => expect(screen.getByTestId("setup-status-card").getAttribute("data-state")).toBe("running"));
    expect(screen.getByRole("button", { name: "Stop setup" }).className).toContain("rv-button-danger");
    f.close();
  });
  it("Run setup again is the primary only when it is the next step; Stop is the only danger button", async () => {
    const f = mountSetupTab();
    const c = await card();
    expect(c.getByRole("button", { name: "Run setup again" }).className).toContain("rv-button-primary");
    expect(within(screen.getByTestId("setup-tab")).getAllByRole("button").filter(one => one.className.includes("rv-button-primary"))).toHaveLength(1);
    expect(screen.queryAllByRole("button").filter(one => one.className.includes("rv-button-danger"))).toHaveLength(0);
    f.close();
  });
  it("Stop sends once and the cost line is under every button that starts a run", async () => {
    const f = mountSetupTab({ run: { status: "running", basedOnRevision: 3, canManage: true, startedAt: "2026-11-24T10:00:00.000Z" }, row: failedRow({ state: "running", status: "running" }), write: (request, world) => request.path.endsWith("/setup-agent/stop") ? { status: 202, body: { ...world.run, limits: DEFAULTS } } : undefined });
    fireEvent.click(await (await card()).findByRole("button", { name: "Stop setup" }));
    await waitFor(() => expect(f.sent("POST", "/setup-agent/stop")).toHaveLength(1));
    f.close(); cleanup();
    const failed = mountSetupTab();
    expect((await card()).getByText("Uses up to $4.00 of this project's AI budget.")).toBeTruthy();
    failed.close();
  });
  it("a refused start shows Cloud's fixed words only, never the server's other text", async () => {
    const f = mountSetupTab({ write: request => request.path.endsWith("/setup-agent") ? err(500, "INTERNAL", "SENSITIVE-SERVER-DETAIL") : undefined });
    fireEvent.click(await (await card()).findByRole("button", { name: "Run setup again" }));
    expect((await screen.findByTestId("setup-run-error")).textContent).toBe("Couldn't do that just now. Try again.");
    expect(document.body.textContent).not.toContain("SENSITIVE-SERVER-DETAIL");
    f.close();
  });
  it("a person who may not manage the run sees the same words, no run buttons and who can", async () => {
    const f = mountSetupTab({ run: { status: "failed", basedOnRevision: 3, canManage: false, failure: "A test command failed." } });
    const c = await card();
    expect(c.getByRole("heading").textContent).toContain("Setup failed at:");
    expect(c.queryByRole("button", { name: "Run setup again" })).toBeNull();
    expect(screen.getByTestId("setup-reader-note").textContent).toBe("A project admin, or a company owner or admin, can do this.");
    f.close();
  });
  it("a failed run shows the failing command, three-part words and Show the last lines, which opens the log", async () => {
    const f = mountSetupTab({ entries: [entry(1, "npm ci", 0), entry(2, "npm test", 1, { tail: "FAIL src/app.test.ts" })] });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("Setup failed at: npm test");
    expect(c.getByText("Nothing in payments was changed.")).toBeTruthy();
    fireEvent.click(c.getByRole("button", { name: "Show the last lines" }));
    await waitFor(() => expect(screen.getByTestId<HTMLDetailsElement>("run-log").open).toBe(true));
    f.close();
  });
});

describe("addresses to decide", () => {
  const waiting = () => mountSetupTab({
    run: { status: "failed", basedOnRevision: 3, canManage: true, stop: "hosts_waiting", failure: "x" }, row: failedRow({ stop: "hosts_waiting", failedCommand: undefined }),
    entries: [entry(1, "npm ci", 1, { blockedHosts: ["packages.acme.example"] }), entry(2, "./scripts/fonts.sh", 1, { blockedHosts: ["cdn.fontlib.example"] })],
    asks: [ask("packages.acme.example"), ask("cdn.fontlib.example")],
    write: (request, world) => { if (request.path.endsWith("/host-decide")) { const sent = request.body as { host: string; outcome: string }; world.asks = (world.asks as Array<Record<string, unknown>>).map(one => one["host"] === sent.host ? { host: one["host"], status: sent.outcome === "approve" ? "approved" : "refused", journalN: 1 } : one); return { status: 200, body: { project: "payments", host: sent.host, decision: sent.outcome === "approve" ? "approved" : "refused", replayed: false } }; } return undefined; },
  });
  it("the card, then the addresses, directly under it and never in a fold: the address, the command that asked, Allow and Refuse", async () => {
    const f = waiting();
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("Setup is waiting for you: 2 addresses to allow or refuse");
    const rows = await screen.findAllByTestId("host-ask");
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId("setup-addresses").closest("details")).toBeNull();
    expect(screen.getByTestId("setup-status-card").compareDocumentPosition(screen.getByTestId("setup-addresses")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rows[0]!).getByTestId("host-ask-name").textContent).toBe("packages.acme.example");
    expect(within(rows[0]!).getByTestId("host-ask-by").textContent).toBe("Asked while running: npm ci");
    expect(within(rows[1]!).getByTestId("host-ask-by").textContent).toBe("Asked while running: ./scripts/fonts.sh");
    expect(screen.getByRole("heading", { name: "Addresses to decide" })).toBeTruthy();
    expect(c.getByRole("button", { name: "Review 2 addresses" }).className).toContain("rv-button-primary");
    f.close();
  });
  it("Refuse is not red: Allow and Refuse are plain secondary buttons, and no button on the tab is danger", async () => {
    const f = waiting();
    await screen.findAllByTestId("host-ask");
    for (const button of [...screen.getAllByTestId("host-allow"), ...screen.getAllByTestId("host-refuse")]) { expect(button.className).toContain("rv-button-secondary"); expect(button.className).not.toContain("danger"); }
    expect(document.querySelectorAll(".rv-button-danger")).toHaveLength(0);
    f.close();
  });
  it("Run setup again is locked with its reason beside it until every address is decided", async () => {
    const f = waiting();
    const c = await card();
    const again = await c.findByRole("button", { name: "Run setup again" });
    expect((again as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("setup-status-card").textContent).toContain("Locked: 0 of 2 addresses decided");
    f.close();
  });
  it("Allow sends once, bound to the id, address and the revision and digest offered; both decided: the card says so and Run setup again is the primary", async () => {
    const f = waiting();
    const rows = await screen.findAllByTestId("host-ask");
    fireEvent.click(within(rows[0]!).getByTestId("host-allow"));
    await waitFor(() => expect(f.sent("POST", "/host-decide")).toHaveLength(1));
    expect(f.sent("POST", "/host-decide")[0]!.body).toMatchObject({ host: "packages.acme.example", outcome: "approve", seen: { revision: 1, artifactDigest: DIGEST } });
    await waitFor(() => expect(within(screen.getAllByTestId("host-ask")[0]!).getByTestId("host-ask-state").textContent).toBe("Allowed by you just now."));
    fireEvent.click(within(screen.getAllByTestId("host-ask")[1]!).getByTestId("host-refuse"));
    await waitFor(() => expect(f.sent("POST", "/host-decide")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("setup-status-card").getAttribute("data-state")).toBe("hosts_decided"));
    const c = await card();
    expect(c.getByText("All 2 addresses are decided. Run setup again to carry on.")).toBeTruthy();
    expect(c.getByRole("button", { name: "Run setup again" }).className).toContain("rv-button-primary");
    expect(c.getByRole<HTMLButtonElement>("button", { name: "Run setup again" }).disabled).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("setup-addresses")).toBeNull());
    expect(within(screen.getByTestId("run-addresses")).getByText("Addresses this run asked for (2)")).toBeTruthy();
    f.close();
  });
  it("the scope line says what an allow reaches (this project, machines that start after) and what a refusal does (7 days)", async () => {
    const f = waiting();
    await screen.findAllByTestId("host-ask");
    const note = screen.getByTestId("host-asks-note").textContent;
    expect(note).toContain("Allowing an address lets this project's machines connect to it. It applies to this project only, and to machines that start after you allow it.");
    expect(note).toContain("Refusing keeps it blocked for this project for 7 days.");
    expect(note).not.toMatch(/website|company-wide/iu);
    f.close();
  });
  it("a person who may not decide sees who can, and no buttons", async () => {
    const f = mountSetupTab({ run: { status: "failed", basedOnRevision: 3, canManage: false, stop: "hosts_waiting", failure: "x" }, row: failedRow({ stop: "hosts_waiting" }), asks: [ask("packages.acme.example", { canDecide: false, approval: undefined })], entries: [] });
    const rows = await screen.findAllByTestId("host-ask");
    expect(within(rows[0]!).getByTestId("host-ask-state").textContent).toBe("Waiting for a company owner or admin to decide.");
    expect(screen.queryByTestId("host-allow")).toBeNull(); expect(screen.queryByTestId("host-refuse")).toBeNull();
    f.close();
  });
  it("no command is shown for an address that no command could not reach: the line is left out, never invented", async () => {
    const f = mountSetupTab({ run: { status: "failed", basedOnRevision: 3, canManage: true, stop: "hosts_waiting", failure: "x" }, row: failedRow({ stop: "hosts_waiting" }), asks: [ask("packages.acme.example")], entries: [entry(1, "npm ci", 1)] });
    await screen.findAllByTestId("host-ask");
    expect(screen.queryByTestId("host-ask-by")).toBeNull();
    f.close();
  });
  it("an address stop with none open (a limit) says so, with Run setup again primary and Change the new-address limit", async () => {
    const f = mountSetupTab({ run: { status: "failed", basedOnRevision: 3, canManage: true, stop: "hosts_waiting", failure: "x" }, row: failedRow({ stop: "hosts_waiting" }), asks: [{ host: "a.example", status: "approved", journalN: 1 }] });
    const c = await card();
    expect((await c.findByRole("heading")).textContent).toContain("Setup stopped: it asked for more addresses than it is allowed");
    expect(c.getByRole("button", { name: "Change the new-address limit" })).toBeTruthy();
    expect(screen.queryByTestId("setup-addresses")).toBeNull();
    f.close();
  });
  it("has no accessibility violations", async () => {
    const f = waiting();
    await screen.findAllByTestId("host-ask");
    await expectNoAxeViolations(document.body);
    f.close();
  });
});

describe("review and approve", () => {
  const reviewing = (over: Record<string, unknown> = {}) => mountSetupTab({
    run: { ...ready, proposal: PROPOSAL, verified: true, verification: { "setup-payments": "verified", "tests-payments": "verified" }, ...over }, row: failedRow({ state: "needs_you", status: "ready", failure: undefined, failedCommand: undefined, testOutcome: "passed", commandsFound: { setup: 1, tests: 1 } }),
    route: request => request.path === "/v1/app/projects/payments" ? { status: 200, body: { name: "payments", status: "active", latestRevision: 7, repositories: [{ fullName: "acme/payments", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" }, requestId: "gw" } } : undefined,
  });
  it("a setup Rovara found: Review the setup is the one primary; The setup Rovara found groups To install and To test; Check this setup proposes against the project's current revision", async () => {
    const f = reviewing({});
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("Rovara found how to set up payments. Review it.");
    expect(c.getByRole("button", { name: "Review the setup" }).className).toContain("rv-button-primary");
    const found = await screen.findByTestId("setup-found");
    expect(within(found).getByRole("heading", { name: "The setup Rovara found" })).toBeTruthy();
    expect(within(within(found).getByTestId("found-setup")).getByText("To install")).toBeTruthy();
    expect(within(within(found).getByTestId("found-tests")).getByText("To test")).toBeTruthy();
    expect(within(found).getByTestId("found-next").textContent).toBe("Next, Rovara checks this on a second machine. Nothing changes in payments until you approve.");
    const check = within(found).getByRole("button", { name: "Check this setup" });
    expect(check.className).not.toContain("rv-button-primary");
    f.world.write = request => request.path.endsWith("/setup-agent/confirm") ? { status: 200, body: { project: "payments", state: "candidate", left: [] } } : undefined;
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(check);
    await waitFor(() => expect(f.sent("POST", "/setup-agent/confirm")).toHaveLength(1));
    expect(f.sent("POST", "/setup-agent/confirm")[0]!.body).toMatchObject({ expectedRevision: 7, itemIds: ["setup-payments", "tests-payments"] });
    f.close();
  });
  it("a person who may not manage reads one line, no Check this setup", async () => {
    const f = reviewing({ canManage: false });
    await card();
    expect((await screen.findByTestId("setup-review-read-only")).textContent).toContain("A project admin, or a company owner or admin, reviews and approves it.");
    expect(screen.queryByRole("button", { name: "Check this setup" })).toBeNull();
    f.close();
  });
  it("while the check goes on a second machine the card says so, shows no decision and no second card", async () => {
    const f = mountSetupTab({ run: { ...ready, apply: apply({ check: { status: "checking" }, approval: undefined, canApprove: false, canReject: false }) }, row: failedRow({ state: "running", status: "ready", approval: "checking" }) });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("Rovara is checking the setup on a second machine");
    expect(buttonsOf(screen.getByTestId("setup-status-card"))).toEqual([]);
    expect(screen.queryByTestId("setup-approval")).toBeNull();
    f.close();
  });
  it("checked: Approve this setup is the primary in the status card; it decides with one press bound to the read's revision and digest, and the card says Setup is done", async () => {
    const f = mountSetupTab({
      run: { ...ready, apply: apply() }, row: failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "ready" } }),
      write: (request, world) => { if (request.path.endsWith("/setup-agent/decide")) { world.run = { ...ready }; world.row = approvedRow(); return { status: 200, body: { project: "payments", decision: "approved", risk: "low", revision: 4, replayed: false } }; } return undefined; },
    });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("The setup works. Approve it to finish.");
    const approve = await c.findByRole("button", { name: "Approve this setup" });
    expect(approve.className).toContain("rv-button-primary");
    const approval = await screen.findByTestId("setup-approval");
    expect(within(approval).getByRole("heading", { name: "What you are approving" })).toBeTruthy();
    expect(within(approval).getByText("Passed on a second machine.")).toBeTruthy();
    expect(within(approval).queryByRole("button", { name: /Approve|Don't use/u })).toBeNull();
    fireEvent.click(approve);
    await waitFor(() => expect(f.sent("POST", "/setup-agent/decide")).toHaveLength(1));
    expect(f.sent("POST", "/setup-agent/decide")[0]!.body).toEqual({ requestId: `setup-${DIGEST.slice(0, 40)}-4`, outcome: "approve", seen: { revision: 4, artifactDigest: DIGEST } });
    await waitFor(() => expect(screen.getByTestId("setup-status-card").getAttribute("data-state")).toBe("verified"));
    f.close();
  });
  it("Don't use it sends the other answer and the card says the project keeps the setup it had", async () => {
    const f = mountSetupTab({
      run: { ...ready, apply: apply() }, row: failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "ready" } }),
      write: (request, world) => { if (request.path.endsWith("/setup-agent/decide")) { world.run = { ...ready, proposal: undefined }; world.row = failedRow({ state: "needs_you", status: "ready", approval: "none", failure: undefined, failedCommand: undefined }); return { status: 200, body: { project: "payments", decision: "rejected", risk: "low", revision: 4, replayed: false } }; } return undefined; },
    });
    fireEvent.click(await (await card()).findByRole("button", { name: "Don't use it" }));
    await waitFor(() => expect((f.sent("POST", "/setup-agent/decide")[0]!.body as { outcome: string }).outcome).toBe("reject"));
    await waitFor(() => expect(screen.getByTestId("setup-status-card").textContent).toContain("Not used. This project keeps the setup it had."));
    f.close();
  });
  it("a person who may not decide sees who approves, no Approve, no Don't use it", async () => {
    const f = mountSetupTab({ run: { ...ready, canManage: false, apply: apply({ canApprove: false, canReject: false, approver: "admin" }) }, row: failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "ready" } }) });
    await card();
    expect(screen.queryByRole("button", { name: /Approve this setup|Don't use it/u })).toBeNull();
    expect((await screen.findByTestId("setup-approval-who")).textContent).toBe("A company owner or admin approves high-risk changes.");
    f.close();
  });
  it("a check that failed: the card says Failed with the step; a manager can choose Don't use it below", async () => {
    const f = mountSetupTab({ run: { ...ready, apply: apply({ check: { status: "failed", failedStep: "npm test" }, approval: undefined, canApprove: false, canReject: false }) }, row: failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "failed", failedStep: "npm test" } }),
      write: (request, world) => { if (request.path.endsWith("/setup-agent/discard")) { world.run = { ...ready }; return { status: 200, body: { discarded: true } }; } return undefined; } });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("The setup didn't pass on a second machine");
    expect(screen.getByTestId("setup-approval").textContent).toContain("Failed on a second machine at: npm test. Nothing was applied.");
    fireEvent.click(await screen.findByRole("button", { name: "Don't use it" }));
    await waitFor(() => expect(f.sent("POST", "/setup-agent/discard")).toHaveLength(1));
    f.close();
  });
  it("a stale decision shows Cloud's refusal and Refresh reads again", async () => {
    const f = mountSetupTab({ run: { ...ready, apply: apply() }, row: failedRow({ state: "needs_you", status: "ready", approval: "candidate", failure: undefined, failedCommand: undefined, check: { status: "ready" } }),
      write: request => request.path.endsWith("/setup-agent/decide") ? err(409, "CHANGE_STALE", "This setup changed or is no longer waiting for a decision. Refresh to see where it stands.") : undefined });
    fireEvent.click(await (await card()).findByRole("button", { name: "Approve this setup" }));
    expect((await screen.findByTestId("setup-approval-problem")).textContent).toContain("This setup changed or is no longer waiting");
    expect(screen.getByTestId("setup-approval-refresh")).toBeTruthy();
    f.close();
  });
  it("a newer setup waiting: the card below is The newer setup and holds the answer as plain buttons (Approve the newer setup, Don't use it) while the status card's one primary only brings the person there", async () => {
    const f = mountSetupTab({ run: { ...ready, apply: apply() }, row: approvedRow({ newerProposal: "needs_you" }), write: request => request.path.endsWith("/setup-agent/decide") ? { status: 200, body: { project: "payments", decision: "approved", risk: "low", revision: 4, replayed: false } } : undefined });
    const approval = await screen.findByTestId("setup-approval");
    expect(within(approval).getByRole("heading", { name: "The newer setup" })).toBeTruthy();
    const approve = within(approval).getByRole("button", { name: "Approve the newer setup" });
    expect(approve.className).not.toContain("primary");
    fireEvent.click(approve);
    await waitFor(() => expect(f.sent("POST", "/setup-agent/decide")).toHaveLength(1));
    f.close();
  });
  it("verified with a newer setup waiting: the one in use still works, Review the newer setup is the primary, and the card below holds its approval", async () => {
    const f = mountSetupTab({ run: { ...ready, apply: apply() }, row: approvedRow({ newerProposal: "needs_you" }) });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("A newer setup is waiting for your review");
    expect(c.getByText("The setup in use still works.")).toBeTruthy();
    expect(c.getByRole("button", { name: "Review the newer setup" }).className).toContain("rv-button-primary");
    expect(await screen.findByTestId("setup-approval")).toBeTruthy();
    f.close();
  });
});

describe("the setup broke later, and the company's switch", () => {
  const broken = (over: Record<string, unknown> = {}) => ({ state: "failed", canManage: true, repair: { step: "npm test", changed: "dependency files", at: "2026-11-24T09:05:00.000Z", fixReady: false, actions: [{ id: "fix_setup", label: "Fix setup" }] }, ...over });
  it("the banner above the tabs is short with one link, Open Setup; on the tab the status card does the work: Fix setup, with its cost in the muted line, and Check again without AI", async () => {
    const f = mountSetupTab({ run: { ...ready }, row: approvedRow(), repair: broken() }, { path: "/app/projects/payments" });
    const banner = await screen.findByTestId("setup-repair-card");
    expect(within(banner).getByRole("heading").textContent).toBe("Setup needs repair: work continues; results may be less reliable until setup is fixed.");
    expect(within(banner).getByTestId("setup-repair-body").textContent).toBe("The project's setup stopped working after recent code changes (npm test).");
    expect(within(banner).getByRole("link", { name: "Open Setup" }).getAttribute("href")).toBe("/app/projects/payments?tab=setup");
    expect(within(banner).queryAllByRole("button")).toHaveLength(0);
    f.close(); cleanup();
    const g = mountSetupTab({ run: { ...ready }, row: approvedRow(), repair: broken() });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("Setup stopped working after recent code changes");
    expect(c.getByRole("button", { name: "Fix setup" }).className).toContain("rv-button-primary");
    expect(c.getByText("Uses your AI, up to $4.00.")).toBeTruthy();
    expect(c.getByText("Runs the saved setup once more. Free.")).toBeTruthy();
    expect(screen.queryByTestId("setup-repair-card")).toBeNull();
    g.close();
  });
  it("the run below a repair card is named for what it is, and says the failing check is not in its log", async () => {
    const f = mountSetupTab({ run: { ...ready }, row: approvedRow(), repair: broken(), entries: [entry(1, "npm test", 0)] });
    await card();
    const section = await screen.findByTestId("setup-run");
    expect(within(section).getByRole("heading", { name: "The run behind the setup in use" })).toBeTruthy();
    expect(within(section).getByTestId("setup-run-note").textContent).toBe("The check that failed ran later, on the saved setup. It is not in this log.");
    f.close();
  });
  it("Fix setup starts the setup run and nothing else; Check again without AI sends exactly a request id", async () => {
    const f = mountSetupTab({ run: { ...ready }, row: approvedRow(), repair: broken(),
      write: (request, world) => request.path.endsWith("/setup-repair/recheck") ? { status: 202, body: { started: true } } : request.path.endsWith("/setup-agent") ? { status: 202, body: { ...world.run, limits: DEFAULTS, status: "running" } } : undefined });
    fireEvent.click(await (await card()).findByRole("button", { name: "Check again without AI" }));
    await waitFor(() => expect(f.sent("POST", "/setup-repair/recheck")).toHaveLength(1));
    expect(Object.keys(f.sent("POST", "/setup-repair/recheck")[0]!.body as object)).toEqual(["requestId"]);
    expect((await screen.findByTestId("setup-recheck-started")).textContent).toBe("Checking setup again.");
    fireEvent.click(screen.getByRole("button", { name: "Fix setup" }));
    await waitFor(() => expect(startRequests(f)).toHaveLength(1));
    expect(Object.keys(startRequests(f)[0]!.body as object)).toEqual(["requestId"]);
    f.close();
  });
  it("a recheck refusal is a fixed sentence, never the server's text", async () => {
    const f = mountSetupTab({ run: { ...ready }, row: approvedRow(), repair: broken(), write: request => request.path.endsWith("/setup-repair/recheck") ? err(409, "WORKSPACE_BUSY", "SENSITIVE") : undefined });
    fireEvent.click(await (await card()).findByRole("button", { name: "Check again without AI" }));
    expect((await screen.findByTestId("setup-run-error")).textContent).toBe("Couldn't start the check just now. Try again.");
    expect(document.body.textContent).not.toContain("SENSITIVE");
    f.close();
  });
  it("turned off for the company: Blocked, and the Company settings button for an owner or admin only", async () => {
    const f = mountSetupTab({ run: { status: "none", basedOnRevision: 3, canManage: true, companySetupOff: true }, row: failedRow({ state: "needs_you", status: "none" }) });
    const c = await card();
    expect(c.getByRole("heading").textContent).toBe("Setup runs are turned off for Acme");
    expect(c.getByRole("link", { name: "Open Company settings" })).toBeTruthy();
    expect(c.queryByRole("button", { name: /Run setup/u })).toBeNull();
    f.close();
  });
});

describe("this run, the extras and the limits", () => {
  it("this run: the facts in one line, then the log folded with its count; a command is Worked or Failed (code 1); the output is a nested fold", async () => {
    const f = mountSetupTab({ entries: [entry(1, "npm ci", 0), entry(2, "npm test", 1, { tail: "FAIL x", blockedHosts: ["cdn.fontlib.example"] }), entry(3, "echo hi", 0, { source: "person" })] });
    await card();
    expect((await screen.findByTestId("setup-run-facts")).textContent).toMatch(/^Started .+ · 3 min 12 s · \$0\.40 · 3\u00a0commands$/u);
    const log = await screen.findByTestId<HTMLDetailsElement>("run-log");
    expect(log.open).toBe(false);
    expect(within(log).getByText("What Rovara ran (3 commands)")).toBeTruthy();
    const results = within(log).getAllByTestId("run-log-result").map(one => one.textContent);
    expect(results).toEqual(["Worked", "Failed (code 1)", "Worked"]);
    expect(log.textContent).toContain("You ran");
    expect(log.textContent).toContain("Couldn't reach: cdn.fontlib.example");
    expect(log.textContent).not.toMatch(/Exit \d|exit 0/u);
    f.close();
  });
  it("an empty log says No commands yet; a log that can't be read says so with Read again", async () => {
    const f = mountSetupTab({ entries: [] });
    expect((await screen.findByTestId("run-log-empty")).textContent).toBe("No commands yet.");
    f.close(); cleanup();
    const g = mountSetupTab({ route: request => request.path.endsWith("/journal") ? err(503, "RUNTIME_UNAVAILABLE", "x") : undefined });
    const failed = await screen.findByTestId("run-log-failed");
    expect(failed.textContent).toContain("Rovara couldn't read what this run did.");
    expect(within(failed).getByRole("button", { name: "Read again" })).toBeTruthy();
    g.close();
  });
  it("while a run goes, Help Rovara along (optional) holds the steer box only: no Run a command box is drawn", async () => {
    const f = mountSetupTab({ run: { status: "running", basedOnRevision: 3, canManage: true, startedAt: "2026-11-24T10:00:00.000Z", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" }, row: failedRow({ state: "running", status: "running" }) });
    const help = await screen.findByTestId("run-help");
    expect(within(help).getByText("Help Rovara along (optional)")).toBeTruthy();
    expect(within(help).getByLabelText("Tell Rovara something about this project")).toBeTruthy();
    expect(within(help).queryByLabelText("Run a command yourself")).toBeNull();
    expect(within(help).queryByRole("button", { name: "Run command" })).toBeNull();
    expect(screen.queryByText("Run a command yourself")).toBeNull();
    expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/setup-agent/command"))).toBe(false);
    f.close();
  });
  it("Also for this project: Optional, Setup is complete without these; the rows say one line each", async () => {
    const f = mountSetupTab({ route: request => request.path.endsWith("/browser-testing") || request.path.endsWith("/wiki-build") || request.path.endsWith("/ci-eval-check") ? err(501, "NOT_ON_CODE_YET", "x") : undefined });
    const also = await screen.findByTestId("setup-also");
    expect(within(also).getByRole("heading", { name: "Also for this project" })).toBeTruthy();
    expect(also.textContent).toContain("Optional. Setup is complete without these.");
    expect(within(also).getByTestId("also-evals-line").textContent).toBe("Looked for after setup finishes.");
    expect(within(also).queryByRole("button", { name: "Review" })).toBeNull();
    f.close();
  });
  it("the limits are five read-only lines with the value in force and a helper line; Change limits is the only control and the form is hidden", async () => {
    const f = mountSetupTab();
    const section = await screen.findByTestId("setup-limits");
    expect(within(section).getByRole("heading", { name: "Limits for a setup run" })).toBeTruthy();
    expect(section.textContent).toContain("Rovara stops a setup run when it reaches any of these, so a stuck run can't keep spending.");
    const value = (name: string) => within(section).getByTestId(`limit-${name}-value`).textContent;
    expect([value("budgetCents"), value("wallClockMin"), value("commands"), value("sameStepTries"), value("hostAsks")]).toEqual(["Up to $4.00 a run", "Up to 45 minutes a run", "Up to 40 commands a run", "Up to 3 tries at a step that keeps failing", "Up to 5 addresses it can ask you to allow"]);
    expect(within(section).getByTestId("limit-budgetCents").textContent).toContain("Rovara's standard. Can be set up to $20.00.");
    expect(within(section).getByTestId("limit-wallClockMin").textContent).toContain("Rovara's standard. Can be set up to 120 minutes.");
    expect(within(section).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(section).getAllByRole("button")).toHaveLength(1);
    expect(section.textContent).not.toMatch(/No company cap|Default|Most|model spend|Setup limits/u);
    f.close();
  });
  it("a reader sees the five lines and no Change limits button; a Code that does not serve them leaves no section", async () => {
    const reader = mountSetupTab({ canEdit: false });
    expect(await screen.findByTestId("setup-limits")).toBeTruthy();
    expect(screen.queryByTestId("limits-change")).toBeNull();
    reader.close(); cleanup();
    for (const limits of [undefined, "unavailable", "forbidden"] as const) {
      const f = mountSetupTab({ limits }); await card();
      await waitFor(() => expect(f.sent("GET", "/setup-agent/limits").length).toBeGreaterThan(0));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      expect(screen.queryByTestId("setup-limits")).toBeNull();
      f.close(); cleanup();
    }
  });
});
