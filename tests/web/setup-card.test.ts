// The Setup tab's status card, every state of FABLE-REVIEW 3.5, as a pure function: the chip, the title, the body, the ONE primary action, the secondary ones and the muted lines. No page, no network.
import { describe, expect, it } from "vitest";
import { statusCardOf, durationWords, type CardInput, type StatusCardModel } from "../../packages/ui/src/screens/setup-tab/setup-card.js";
import { ACTIONS, OPEN_POINTS } from "../../packages/ui/src/screens/setup-tab/setup-tab-text.js";

const row = (over: Record<string, unknown> = {}) => ({ state: "failed", status: "failed", approval: "none", startedAt: "2026-11-24T10:00:00.000Z", elapsedMs: 192_000, costCents: 40, commandsRun: 12, ...over }) as NonNullable<CardInput["row"]>;
const run = (over: Record<string, unknown> = {}) => ({ status: "failed", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, canManage: true, ...over }) as NonNullable<CardInput["run"]>;
const ask = (host: string, over: Record<string, unknown> = {}) => ({ host, status: "open", canDecide: true, approval: { requestId: `host-${host.replace(/[^a-z]/gu, "")}aaaa`, revision: 1, artifactDigest: "ab".repeat(32), kind: "setup_host", risk: "high" }, ...over }) as NonNullable<CardInput["asks"]>[number];
const apply = (over: Record<string, unknown> = {}) => ({ candidateRevision: 4, baseRevision: 3, setup: [], readiness: [], check: { status: "ready" }, risk: "low", changes: [], approver: "maintainer", canApprove: true, canReject: true, approval: { requestId: "setup-x-4", revision: 4, artifactDigest: "ab".repeat(32), kind: "setup", risk: "low" }, ...over });
const input = (over: Partial<CardInput> = {}): CardInput => ({ project: "acme/payments", company: "Acme", row: undefined, run: run(), stage: "none", asks: undefined, limits: { budgetCents: 400, wallClockMin: 45 }, repair: undefined, decided: undefined, mayAct: true, mayStartTask: false, companyAdmin: true, ...over });
const card = (over: Partial<CardInput> = {}) => statusCardOf(input(over));
const labels = (model: StatusCardModel) => [model.primary, ...model.secondary].filter(Boolean).map(action => action!.label);
const rowsText = (model: StatusCardModel) => (model.rows ?? []).map(one => `${one.label}: ${one.text}`).join(" | ");
const ONE_PRIMARY = (model: StatusCardModel) => expect(model.primary === undefined || model.secondary.every(action => action.id !== model.primary!.id)).toBe(true);

describe("the status card, every state (3.5)", () => {
  it("no run yet: Needs you, the cost in the body, ONE primary Run setup and the cost line under it", () => {
    const model = card({ run: run({ status: "none" }), row: row({ state: "needs_you", status: "none" }) });
    expect(model.state).toBe("none"); expect(model.chip.state).toBe("needs_you");
    expect(model.title).toBe("Set up acme/payments so Rovara can work on it");
    expect(model.body).toBe("Rovara installs the project and runs its tests once, on a separate machine. Nothing in your repo is changed, and no secrets are used. It usually takes a few minutes and uses up to $4.00 of this project's AI budget.");
    expect(model.primary).toMatchObject({ id: "run", label: ACTIONS.run }); expect(model.secondary).toEqual([]);
    expect(model.notes).toEqual([]); expect(model.primary!.hints).toEqual(["Uses up to $4.00 of this project's AI budget."]);
  });
  it("no run yet, limits not served: the amount is dropped from the words", () => {
    const model = card({ run: run({ status: "none" }), limits: undefined });
    expect(model.body).toContain("and uses this project's AI budget.");
    expect(model.body).not.toContain("$");
    expect(model.primary!.hints).toEqual(["Uses this project's AI budget."]);
  });
  it("running: Setting up, nothing needed from you, Stop is the only action", () => {
    const model = card({ run: run({ status: "running" }) });
    expect(model.state).toBe("running"); expect(model.chip.state).toBe("setting_up");
    expect(model.title).toBe("Rovara is setting up acme/payments");
    expect(model.body).toBe("Nothing is needed from you. You can leave; this page shows the same run when you come back.");
    expect(model.primary).toBeUndefined(); expect(model.secondary.map(action => action.id)).toEqual(["stop"]);
  });
  it("addresses waiting: Needs you, three-part words, Review n addresses primary, Run setup again held with its reason", () => {
    const model = card({ run: run({ stop: "hosts_waiting" }), asks: [ask("packages.acme.example"), ask("cdn.fontlib.example")] });
    expect(model.state).toBe("hosts_open"); expect(model.chip.state).toBe("needs_you");
    expect(model.title).toBe("Setup is waiting for you: 2 addresses to allow or refuse");
    expect(rowsText(model)).toBe("What happened: While installing, acme/payments asked for 2 addresses that are not on its allowed list. Rovara did not connect to them. | What is safe: Nothing reached those addresses. Nothing in acme/payments was changed. | What to do: Decide each address below, then run setup again.");
    expect(model.primary).toMatchObject({ id: "review_addresses", label: "Review 2 addresses" });
    expect(model.secondary).toEqual([{ id: "run_again", label: ACTIONS.runAgain, lockedReason: "0 of 2 addresses decided", hints: ["Uses up to $4.00 of this project's AI budget."] }]);
    expect(JSON.stringify(model)).not.toMatch(/website|site\b|host request/iu);
  });
  it("one address waiting says address, and a reader who may not decide has no Review button and is told who can", () => {
    const one = card({ run: run({ stop: "hosts_waiting" }), asks: [ask("packages.acme.example")] });
    expect(one.title).toBe("Setup is waiting for you: 1 address to allow or refuse");
    const reader = card({ run: run({ stop: "hosts_waiting", canManage: false }), mayAct: false, asks: [ask("packages.acme.example", { canDecide: false })] });
    expect(reader.primary).toBeUndefined(); expect(labels(reader)).toEqual([]); expect(reader.readerNote).toBe(true);
  });
  it("all addresses decided here: the card says so and unlocks Run setup again as the primary", () => {
    const model = card({ run: run({ stop: "hosts_waiting" }), asks: [ask("a.example", { status: "approved" }), ask("b.example", { status: "refused" })], decidedHere: 2 });
    expect(model.state).toBe("hosts_decided");
    expect(model.title).toBe("Your decisions are in");
    expect(model.body).toBe("All 2 addresses are decided. Run setup again to carry on.");
    expect(model.primary).toMatchObject({ id: "run_again" }); expect(model.primary!.lockedReason).toBeUndefined();
  });
  it("stopped on addresses with none open: the limit words, Run setup again primary, Change the address limit", () => {
    const model = card({ run: run({ stop: "hosts_waiting" }), asks: [ask("a.example", { status: "approved" })] });
    expect(model.state).toBe("hosts_limit"); expect(model.chip.state).toBe("stopped");
    expect(model.title).toBe("Setup stopped: it asked for more addresses than it is allowed, or waited too long for a decision");
    expect(rowsText(model)).toContain("The run reached its limit of 5 new addresses, or waited 2 hours for a decision. No address is waiting now.");
    expect(model.primary).toMatchObject({ id: "run_again" }); expect(model.secondary).toEqual([{ id: "change_limit", label: ACTIONS.changeLimit.hostAsks, limit: "hostAsks" }]);
  });
  it("stopped on addresses with the list unread: words true of every cause, nothing is guessed", () => {
    const model = card({ run: run({ stop: "hosts_waiting" }), asks: undefined });
    expect(model.state).toBe("hosts_unknown");
    expect(rowsText(model)).not.toContain("No address is waiting now");
  });
  it("finished, to review: Needs you, the counts, the outcome and the time and cost; Review the setup primary, Run setup again", () => {
    const model = card({ run: run({ status: "ready", stop: "proposed", proposal: {} }), stage: "review", row: row({ state: "needs_you", status: "ready", commandsFound: { setup: 3, tests: 2 }, testOutcome: "passed", elapsedMs: 660_000, costCents: 160 }) });
    expect(model.state).toBe("review"); expect(model.chip.state).toBe("needs_you");
    expect(model.title).toBe("Rovara found how to set up acme/payments. Review it.");
    expect(model.body).toBe("It found 3 commands to install and 2 to test. Tests passed. Took 11 min 00 s, cost $1.60.");
    expect(model.primary).toMatchObject({ id: "review_setup", label: "Review the setup" }); expect(model.secondary.map(action => action.label)).toEqual(["Run setup again"]);
  });
  it("being checked: Checking, nothing is needed, no action", () => {
    const model = card({ run: run({ status: "ready", stop: "proposed", apply: apply({ check: { status: "checking" } }) }), stage: "checking" });
    expect(model.state).toBe("checking"); expect(model.chip.state).toBe("checking");
    expect(model.title).toBe("Rovara is checking the setup on a second machine");
    expect(model.body).toContain("Nothing is needed from you.");
    expect(labels(model)).toEqual([]);
  });
  it("checked, to approve: Needs you, Approve this setup primary and Don't use it", () => {
    const model = card({ run: run({ status: "ready", stop: "proposed", apply: apply() }), stage: "approve" });
    expect(model.state).toBe("approve");
    expect(model.title).toBe("The setup works. Approve it to finish.");
    expect(model.body).toBe("It passed on a second machine. Approving makes it the setup every task in acme/payments uses.");
    expect(model.primary).toMatchObject({ id: "approve", label: "Approve this setup" }); expect(model.secondary.map(action => action.label)).toEqual(["Don't use it"]);
  });
  it("checked, to approve, for a person who may not decide: no buttons, who decides is told", () => {
    const model = card({ run: run({ status: "ready", stop: "proposed", apply: apply({ canApprove: false, canReject: false }), canManage: false }), stage: "approve", mayAct: false });
    expect(labels(model)).toEqual([]); expect(model.readerNote).toBe(true);
  });
  it("verified: Done, the day it was approved, the time and cost; Start a task only when the person may; Run setup again is secondary", () => {
    const verified = row({ state: "done", status: "ready", approval: "approved", check: { status: "ready" }, approvedAt: "2026-11-12T10:00:00.000Z", elapsedMs: 680_000, costCents: 160 });
    const model = card({ run: run({ status: "ready", stop: "proposed" }), row: verified, mayStartTask: true });
    expect(model.state).toBe("verified"); expect(model.chip.state).toBe("done");
    expect(model.title).toBe("Setup is done. acme/payments can run tasks.");
    expect(model.body).toMatch(/^Approved on .+\. Took 11 min 20 s, cost \$1\.60\.$/u);
    expect(model.primary).toMatchObject({ id: "start_task", label: "Start a task" }); expect(model.secondary.map(action => action.label)).toEqual(["Run setup again"]);
    expect(model.secondary[0]!.hints).toEqual(["Uses up to $4.00 of this project's AI budget.", "Running again doesn't change the setup in use. You approve a new one first."]);
    const none = card({ run: run({ status: "ready", stop: "proposed" }), row: verified, mayStartTask: false });
    expect(none.primary).toBeUndefined();
    expect(JSON.stringify(model)).not.toContain(" by ");
  });
  it("verified, a newer setup waiting: Needs you, the one in use still works, Review the newer setup", () => {
    const verified = row({ state: "done", status: "ready", approval: "approved", check: { status: "ready" }, newerProposal: "needs_you" });
    const model = card({ run: run({ status: "ready", stop: "proposed", apply: apply() }), stage: "approve", row: verified });
    expect(model.state).toBe("newer"); expect(model.chip.state).toBe("needs_you");
    expect(model.title).toBe("A newer setup is waiting for your review"); expect(model.body).toBe("The setup in use still works.");
    expect(model.primary).toMatchObject({ id: "review_newer", label: "Review the newer setup" });
    const checking = card({ run: run({ status: "ready", stop: "proposed", apply: apply({ check: { status: "checking" } }) }), stage: "checking", row: row({ ...verified, newerProposal: "checking" }) });
    expect(checking.state).toBe("newer_checking"); expect(checking.chip.state).toBe("checking"); expect(labels(checking)).toEqual([]);
  });
  it("failed, the project's own fault: Failed, the failing command, what happened, what is safe, what to do; Run setup again primary, Show the last lines", () => {
    const model = card({ run: run({ failure: "A test command failed." }), row: row({ failure: "A test command failed.", failedCommand: { n: 2, command: "npm test", exitCode: 1, timedOut: false, lastLines: [] } }) });
    expect(model.state).toBe("failed"); expect(model.chip.state).toBe("failed");
    expect(model.title).toBe("Setup failed at:"); expect(model.titleCode).toBe("npm test");
    expect(rowsText(model)).toBe("What happened: A test command failed. | What is safe: Nothing in acme/payments was changed. | What to do: Fix the cause, then run setup again.");
    expect(model.primary).toMatchObject({ id: "run_again" }); expect(model.secondary.map(action => action.label)).toEqual(["Show the last lines"]);
  });
  it("the setup's check on a second machine failed: Failed, the failing step, nothing applied", () => {
    const model = card({ run: run({ status: "ready", stop: "proposed", apply: apply({ check: { status: "failed", failedStep: "npm test" } }) }), stage: "review" });
    expect(model.state).toBe("check_failed"); expect(model.chip.state).toBe("failed");
    expect(rowsText(model)).toContain("The setup Rovara found failed on a second machine at: npm test");
    expect(rowsText(model)).toContain("Nothing was applied.");
    expect(model.primary).toMatchObject({ id: "run_again" });
  });
  it("Rovara's side: Could not run, not your repo, nothing changed, Run setup again", () => {
    const model = card({ run: run({ stop: "infrastructure", failure: "x" }) });
    expect(model.state).toBe("infrastructure"); expect(model.chip.state).toBe("could_not_run");
    expect(model.title).toBe("Rovara couldn't run setup. This is on our side.");
    expect(model.body).toBe("This is not your repo or your settings. Nothing was changed.");
    expect(model.primary).toMatchObject({ id: "run_again" });
  });
  it("needs a code change: Blocked, the server's sentence, no primary, Run setup again secondary", () => {
    const model = card({ run: run({ stop: "needs_code_change", failure: "The install script needs a database." }) });
    expect(model.state).toBe("code_change"); expect(model.chip.state).toBe("blocked");
    expect(model.title).toBe("acme/payments needs a change in its code before it can be set up");
    expect(model.body).toBe("The install script needs a database."); expect(model.primary).toBeUndefined();
    expect(model.secondary.map(action => action.label)).toEqual(["Run setup again"]);
  });
  it("a command changed repo files: Stopped, nothing was pushed, Run setup again and Show what Rovara ran", () => {
    const model = card({ run: run({ stop: "changed_repository_files" }) });
    expect(model.state).toBe("changed_files"); expect(model.chip.state).toBe("stopped");
    expect(model.title).toBe("Setup stopped: a command changed the project's files");
    expect(model.body).toBe("Setup must not change your code, so Rovara ended the run. Nothing was pushed.");
    expect(model.primary).toMatchObject({ id: "run_again" }); expect(model.secondary.map(action => action.label)).toEqual(["Show what Rovara ran"]);
  });
  it("stopped by a person: Stopped, the stopper's name as the server serves it, never a blank", () => {
    const named = card({ run: run({ stop: "stopped_by_person", stoppedBy: { name: "Ana", at: "2026-11-24T10:00:00.000Z" } }) });
    expect(named.state).toBe("stopped_person"); expect(named.title).toBe("Setup was stopped by Ana");
    expect(named.body).toBe("The commands it ran are kept below. Nothing was checked or applied.");
    const unnamed = card({ run: run({ stop: "stopped_by_person" }) });
    expect(unnamed.title).toBe("Setup was stopped");
  });
  it("stopped at a limit (spend, time, commands or retries): Stopped, the number from the limits read, the commands are kept, Run setup again primary, Change that limit", () => {
    const spend = card({ run: run({ stop: "budget_used" }) });
    expect(spend.state).toBe("limit_budget"); expect(spend.chip.state).toBe("stopped");
    expect(spend.title).toBe("Setup stopped: it reached its $4.00 spend limit");
    expect(rowsText(spend)).toContain("Rovara used the $4.00 acme/payments allows for one setup run before it finished.");
    expect(rowsText(spend)).toContain("Nothing in acme/payments was changed. The commands it ran are kept below.");
    expect(rowsText(spend)).toContain("Run setup again, or allow more first.");
    expect(spend.primary).toMatchObject({ id: "run_again" }); expect(spend.secondary).toEqual([{ id: "change_limit", label: "Change the spend limit", limit: "budgetCents" }]);
    const time = card({ run: run({ stop: "time_used" }) });
    expect(time.title).toBe("Setup stopped: it reached its 45 minute limit");
    expect(time.secondary[0]).toMatchObject({ label: "Change the time limit", limit: "wallClockMin" });
    const attempts = card({ run: run({ stop: "attempts_used" }) });
    expect(attempts.title).toBe("Setup stopped: it reached its limit on commands or retries");
    expect(attempts.secondary[0]).toMatchObject({ label: "Change the limits", limit: "commands" });
    expect(OPEN_POINTS.attemptsSplitServed).toBe(false);
    // The stop names the limit the run ended against (the run read carries it), not the limit saved since; the cost line under Run setup again is the next run's.
    const raised = card({ run: run({ stop: "budget_used" }), limits: { budgetCents: 700, wallClockMin: 45 } });
    expect(raised.title).toBe("Setup stopped: it reached its $4.00 spend limit");
    expect(raised.primary!.hints).toEqual(["Uses up to $7.00 of this project's AI budget."]);
  });
  it("a limit stop that kept a proposal also says what it found", () => {
    const model = card({ run: run({ stop: "attempts_used", status: "ready", proposal: {} }) });
    expect(rowsText(model)).toContain("The commands it ran are kept below. What it found so far is kept below too.");
  });
  it("the setup broke later (the repair read): a warning (Needs you, never Blocked; work continues), Fix setup primary with its cost in the muted line, Check again without AI free", () => {
    const repair = { state: "failed", canManage: true, repair: { step: "npm test", at: "2026-11-24T09:05:00.000Z", fixReady: false, actions: [{ id: "fix_setup", label: "Fix setup" }] } } as CardInput["repair"];
    const model = card({ run: run({ status: "ready", stop: "proposed" }), repair, row: row({ state: "done", status: "ready", approval: "approved", check: { status: "failed", failedStep: "npm test" } }) });
    expect(model.state).toBe("repair"); expect(model.chip.state).toBe("needs_you");
    expect(model.title).toBe("Setup stopped working after recent code changes");
    expect(model.body).toBe("It fails at: npm test. Work on acme/payments continues; results may be less reliable until setup is fixed.");
    expect(model.primary).toMatchObject({ id: "fix", label: "Fix setup", hints: ["Uses your AI, up to $4.00."] }); expect(model.secondary).toEqual([{ id: "recheck", label: "Check again without AI", hints: ["Runs the saved setup once more. Free."] }]);
    expect(model.notes).toEqual([]);
    expect(model.primary!.label).not.toContain("$");
    const ready = card({ run: run({ status: "ready", stop: "proposed" }), repair: { ...repair!, repair: { ...repair!.repair!, fixReady: true } } });
    expect(ready.state).toBe("repair_fix_ready"); expect(ready.primary).toMatchObject({ id: "review_newer", label: "Approve new setup" });
    const reader = card({ run: run({ status: "ready", stop: "proposed" }), repair: { ...repair!, canManage: false }, mayAct: false });
    expect(labels(reader)).toEqual([]);
  });
  it("DEC 254zzz447 review: every repair state (fix ready, reader, no run to act on) is a warning chip (Needs you), never Blocked, and none says work cannot continue", () => {
    const repair = { state: "failed", canManage: true, repair: { step: "npm test", at: "2026-11-24T09:05:00.000Z", fixReady: false, actions: [{ id: "fix_setup", label: "Fix setup" }] } } as CardInput["repair"];
    const approvedRow = row({ state: "done", status: "ready", approval: "approved", check: { status: "failed", failedStep: "npm test" } });
    const models = [
      card({ run: run({ status: "ready", stop: "proposed" }), repair, row: approvedRow }),
      card({ run: run({ status: "ready", stop: "proposed" }), repair: { ...repair!, repair: { ...repair!.repair!, fixReady: true } }, row: approvedRow }),
      card({ run: run({ status: "ready", stop: "proposed" }), repair: { ...repair!, canManage: false }, mayAct: false, row: approvedRow }),
    ];
    expect(models.map(model => model.state)).toEqual(["repair", "repair_fix_ready", "repair"]);
    for (const model of models) {
      expect(model.chip.state).toBe("needs_you");
      expect(model.body).toContain("continues; results may be less reliable until setup is fixed.");
      expect(`${model.headline} ${model.title} ${model.body ?? ""}`).not.toMatch(/can't build|cannot build|can't continue|paused|blocked/iu);
    }
  });
  it("turned off for the company: Blocked, who can turn it on; the Company settings button only for an owner or admin", () => {
    const off = card({ run: run({ status: "none", companySetupOff: true }) });
    expect(off.state).toBe("off"); expect(off.chip.state).toBe("blocked");
    expect(off.title).toBe("Setup runs are turned off for Acme");
    expect(off.body).toBe("A company owner or admin can turn them on in Company settings.");
    expect(off.primary).toMatchObject({ id: "open_company", label: "Open Company settings" });
    expect(card({ run: run({ status: "none", companySetupOff: true }), companyAdmin: false }).primary).toBeUndefined();
    const held = card({ run: run({ status: "none", companyLocksUnreadable: true }) });
    expect(held.state).toBe("held");
    const verified = card({ run: run({ status: "ready", stop: "proposed", companySetupOff: true }), row: row({ state: "done", status: "ready", approval: "approved", check: { status: "ready" } }) });
    expect(verified.state).toBe("verified"); expect(verified.secondary.every(action => action.id !== "run_again")).toBe(true);
  });
  it("can't be read: Unknown, that doesn't mean setup failed, Read again", () => {
    const model = card({ run: undefined });
    expect(model.state).toBe("unreadable"); expect(model.chip.state).toBe("unknown");
    expect(model.title).toBe("Rovara couldn't read where setup stands"); expect(model.body).toBe("That doesn't mean setup failed.");
    expect(model.primary).toMatchObject({ id: "read_again", label: "Read again" });
  });
  it("a reader who can't act: the same words, no button, and who can", () => {
    const model = card({ run: run({ stop: "budget_used", canManage: false }), mayAct: false });
    expect(model.title).toBe("Setup stopped: it reached its $4.00 spend limit");
    expect(labels(model)).toEqual([]); expect(model.readerNote).toBe(true);
  });
  it("a run that finished with nothing waiting says so, and after a refusal says what was decided", () => {
    const model = card({ run: run({ status: "ready", stop: "proposed" }), decided: "rejected" });
    expect(model.state).toBe("idle"); expect(model.body).toBe("Not used. This project keeps the setup it had.");
    expect(model.primary).toMatchObject({ id: "run_again" });
  });
  it("the cost line stays with the button that starts a run, wherever it stands: Run setup again when it is secondary, and held with its reason when locked", () => {
    const review = card({ run: run({ status: "ready", stop: "proposed", proposal: {} }), stage: "review", row: row({ state: "needs_you", status: "ready" }) });
    expect(review.primary!.hints).toBeUndefined(); expect(review.secondary[0]).toMatchObject({ id: "run_again", hints: ["Uses up to $4.00 of this project's AI budget."] });
    const held = card({ run: run({ stop: "hosts_waiting" }), asks: [ask("a.example")] });
    expect(held.secondary[0]).toMatchObject({ id: "run_again", lockedReason: "0 of 1 addresses decided", hints: ["Uses up to $4.00 of this project's AI budget."] });
    const limit = card({ run: run({ stop: "budget_used" }) });
    expect(limit.primary!.hints).toEqual(["Uses up to $4.00 of this project's AI budget."]); expect(limit.secondary[0]!.hints).toBeUndefined();
    expect(limit.notes).toEqual([]);
  });
  it("the server's sentence for a needed code change starts with a capital and does not repeat the title", () => {
    expect(card({ run: run({ stop: "needs_code_change", failure: "The project needs a change in its code before it can be set up: its install script needs a database." }) }).body).toBe("Its install script needs a database.");
    expect(card({ run: run({ stop: "needs_code_change", failure: "The project needs a change in its code before it can be set up." }) }).body).toBeUndefined();
  });
  it("an address stop with none open names the limit's number when the limits were read, and the button is named after the row", () => {
    const model = card({ run: run({ stop: "hosts_waiting" }), asks: [ask("a.example", { status: "approved" })], limits: { budgetCents: 400, wallClockMin: 45, hostAsks: 5 } });
    expect(rowsText(model)).toContain("The run reached its limit of 5 new addresses, or waited 2 hours for a decision.");
    expect(model.secondary[0]).toMatchObject({ label: "Change the new-address limit", limit: "hostAsks" });
  });
  it("a stopped run says only what is true: the commands are kept, nothing was checked; never that what it found is below", () => {
    const model = card({ run: run({ stop: "stopped_by_person", proposal: {} }) });
    expect(model.body).toBe("The commands it ran are kept below. Nothing was checked or applied.");
    expect(JSON.stringify(model)).not.toMatch(/found so far|had found/u);
  });
  it("never more than one primary, and no state names a sandbox, a proposal, a candidate or a fresh machine", () => {
    const every: Array<Partial<CardInput>> = [
      { run: run({ status: "none" }) }, { run: run({ status: "running" }) }, { run: run({ stop: "hosts_waiting" }), asks: [ask("a.example")] }, { run: run({ stop: "budget_used" }) }, { run: run({ stop: "infrastructure" }) },
      { run: run({ status: "ready", stop: "proposed", apply: apply() }), stage: "approve" }, { run: run({ status: "ready", stop: "proposed", apply: apply({ check: { status: "checking" } }) }), stage: "checking" },
    ];
    for (const over of every) { const model = card(over); ONE_PRIMARY(model); expect(JSON.stringify(model)).not.toMatch(/sandbox|proposal|candidate|fresh (machine|workspace)|throw-away|model spend/iu); }
  });
  it("time is said as minutes and seconds", () => { expect(durationWords(42_000)).toBe("42 s"); expect(durationWords(192_000)).toBe("3 min 12 s"); });
});
