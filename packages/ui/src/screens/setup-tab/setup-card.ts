// The Setup tab's status card as a pure function (FABLE-REVIEW 3.5, 3.3): the reads in, ONE model out (a chip, a title, the body, at most one primary action, the secondary ones and the muted lines).
// Nothing here reads, sends or renders; the card draws the model and wires each action id. Every state of 3.5 is one branch below and one test (tests/web/setup-card.test.ts).
import type { ProjectSetupChecklist, SetupAgentView, SetupHostAskView, SetupRepairView } from "@agentx/contracts/web";
import { SETUP_REPAIR_SENTENCES } from "@agentx/contracts/web";
import type { StatusChipProps } from "../../design/StatusChip.js";
import type { SetupLimitName } from "../../api/setup-limits.js";
import type { ReviewStage } from "../setup/SetupReview.js";
import { ACTIONS, ADDRESSES, CARD, OPEN_POINTS, STOPS, TAB } from "./setup-tab-text.js";

export type ActionId = "run" | "run_again" | "stop" | "review_addresses" | "review_setup" | "approve" | "dont_use" | "review_newer" | "start_task" | "read_again" | "fix" | "recheck" | "open_company" | "show_log" | "change_limit";
export interface CardAction { id: ActionId; label: string; /** A muted line under this button alone (when two buttons have different things to say). */ hints?: string[]; /** `change_limit`: the limit whose field gets the focus. */ limit?: SetupLimitName; /** A button that is held shows why, beside it. */ lockedReason?: string }
export type SetupState = "none" | "running" | "hosts_open" | "hosts_decided" | "hosts_limit" | "hosts_unknown" | "review" | "checking" | "approve" | "verified" | "newer" | "newer_checking" | "failed" | "check_failed" | "infrastructure" | "code_change" | "changed_files" | "stopped_person" | "limit_budget" | "limit_time" | "limit_attempts" | "repair" | "repair_fix_ready" | "off" | "held" | "unreadable" | "approved_failed" | "approved_unchecked" | "idle";

export interface StatusCardModel {
  state: SetupState;
  chip: StatusChipProps;
  /** The one-line state for the page header (beside the project name). */
  headline: string;
  title: string;
  /** A command or step that goes in code font after the title ("Setup failed at:"). */
  titleCode?: string | undefined;
  /** Plain body (a line of text), or the three-part rows of the design system's error block. */
  body?: string | undefined;
  rows?: ReadonlyArray<{ label: string; text: string }> | undefined;
  primary?: CardAction | undefined;
  secondary: CardAction[];
  /** Muted lines under the buttons, in order. */
  notes: string[];
  /** A person who may not act reads who can. */
  readerNote: boolean;
}

export interface CardInput {
  project: string;
  company: string | undefined;
  /** The checklist's Setup run row, when that read answered. */
  row: ProjectSetupChecklist["setupRun"] | undefined;
  /** The setup run's own read. Without it nothing can be said: the card is "Rovara couldn't read where setup stands". */
  run: SetupAgentView | undefined;
  stage: ReviewStage;
  /** The run's address asks, when the journal was read (undefined: not read). */
  asks: readonly SetupHostAskView[] | undefined;
  /** What a run started now would use. Undefined when the limits are not served or not read: the amounts are dropped from the words. */
  limits: { budgetCents: number; wallClockMin: number; hostAsks?: number } | undefined;
  repair: SetupRepairView | undefined;
  decided: "approved" | "rejected" | "discarded" | undefined;
  /** Address decisions that went through in this view: once none is open, "all decided" is true now, whatever Code's one stop word says. */
  decidedHere?: number;
  /** Code says this person may start and stop setup runs. */
  mayAct: boolean;
  /** The person may start a task (the checklist's firstTask.canStart) and the page can say so. */
  mayStartTask: boolean;
  /** A company owner or admin: the one who can open Company settings. */
  companyAdmin: boolean;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
export const spendWords = (limits: CardInput["limits"]): string | undefined => limits === undefined ? undefined : dollars(limits.budgetCents);
/** "11 min 02 s" or "42 s": the run's time as the card says it. */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000)), m = Math.floor(total / 60), s = total % 60;
  return m === 0 ? `${String(s)} s` : `${String(m)} min ${String(s).padStart(2, "0")} s`;
}
const A = (id: ActionId, label: string, extra: Partial<CardAction> = {}): CardAction => ({ id, label, ...extra });

const CHIP: Record<string, StatusChipProps> = {
  needs_you: { state: "needs_you" }, setting_up: { state: "setting_up" }, checking: { state: "checking" }, done: { state: "done" }, failed: { state: "failed" },
  could_not_run: { state: "could_not_run" }, blocked: { state: "blocked" }, stopped: { state: "stopped" }, unknown: { state: "unknown" },
};

/** The asks still open, the ones decided, and how many an owner or admin may decide right now. */
export function askCounts(asks: readonly SetupHostAskView[] | undefined): { open: number; decided: number; total: number; mayDecide: number } {
  const list = asks ?? [];
  return { open: list.filter(ask => ask.status === "open").length, decided: list.filter(ask => ask.status !== "open").length, total: list.length, mayDecide: list.filter(ask => ask.status === "open" && ask.canDecide === true).length };
}

export function statusCardOf(input: CardInput): StatusCardModel {
  const { project, run, row } = input;
  const base = (state: SetupState, chip: StatusChipProps, headline: string, title: string, rest: Partial<StatusCardModel> = {}): StatusCardModel => ({ state, chip, headline, title, secondary: [], notes: [], readerNote: false, ...rest });
  if (run === undefined) return base("unreadable", CHIP["unknown"]!, HEADLINE.unknown, CARD.unreadable.title, { body: CARD.unreadable.body, primary: A("read_again", ACTIONS.readAgain) });

  const spend = spendWords(input.limits), mayAct = input.mayAct;
  const company = input.company ?? "your company";
  const counts = askCounts(input.asks);
  const approved = row?.approval === "approved";
  const failedStep = row?.check?.failedStep ?? run.apply?.check.failedStep;
  const runAgainNotes = (...extra: string[]): string[] => [TAB.uses(spend), ...extra];
  const again = (primary: boolean, extra: string[] = []): Pick<StatusCardModel, "primary" | "secondary" | "notes"> => {
    if (!mayAct) return { secondary: [], notes: [] };
    const action = A("run_again", ACTIONS.runAgain);
    return primary ? { primary: action, secondary: [], notes: runAgainNotes(...extra) } : { secondary: [action], notes: runAgainNotes(...extra) };
  };
  const finish = (model: StatusCardModel): StatusCardModel => {
    // The muted lines belong to the button that starts a run (3.5: "under every button that starts a run"), wherever it stands among the others.
    const starts = (action: CardAction) => action.id === "run" || action.id === "run_again" || action.id === "fix";
    if (model.notes.length > 0) {
      if (model.primary !== undefined && starts(model.primary)) model = { ...model, primary: { ...model.primary, hints: [...(model.primary.hints ?? []), ...model.notes] }, notes: [] };
      else if (model.secondary.some(starts)) model = { ...model, secondary: model.secondary.map(action => starts(action) && model.notes.length > 0 ? { ...action, hints: [...(action.hints ?? []), ...model.notes] } : action), notes: [] };
    }
    // A person who may not act reads who can (3.5, "Reader who can't act"). Nothing is added where nothing is needed from anyone.
    const quiet = model.state === "running" || model.state === "checking" || model.state === "newer_checking" || model.state === "unreadable";
    return { ...model, readerNote: !mayAct && !quiet };
  };
  const off = run.companySetupOff === true, held = run.companyLocksUnreadable === true;
  const gate = (model: StatusCardModel): StatusCardModel => {
    // Setup runs are off (or held) for the company: no start is offered anywhere; a run already going keeps its Stop.
    if (!off && !held) return model;
    const isStart = (action: CardAction | undefined) => action !== undefined && (action.id === "run" || action.id === "run_again" || action.id === "fix");
    const secondary = model.secondary.filter(action => !isStart(action));
    const note = held ? CARD.held.body : CARD.off.body;
    if (model.state === "none" || isStart(model.primary)) {
      const title = held ? CARD.held.title(company) : CARD.off.title(company);
      return { ...model, state: held ? "held" : "off", chip: CHIP["blocked"]!, headline: held ? "Setup runs are on hold" : "Setup runs are turned off", title, titleCode: undefined, body: note, rows: undefined, primary: input.companyAdmin ? A("open_company", ACTIONS.openCompany) : undefined, secondary, notes: [] };
    }
    return { ...model, secondary, notes: [...model.notes.filter(one => one !== TAB.uses(spend) && one !== TAB.againKeepsSetup), note] };
  };

  // ---- a run is going
  if (run.status === "running") {
    return finish(base("running", CHIP["setting_up"]!, HEADLINE.running, CARD.running.title(project), { body: CARD.running.body, ...(mayAct ? { secondary: [A("stop", ACTIONS.stop)] } : {}) }));
  }
  const apply = run.apply, stage = input.stage;
  // ---- a setup of Rovara's waits beside the one in use (L4-T2c)
  if (approved && row?.newerProposal === "checking" && stage === "checking") return finish(base("newer_checking", CHIP["checking"]!, HEADLINE.newerChecking, CARD.newerChecking.title, { body: CARD.newerChecking.body }));
  if (approved && (stage === "review" || stage === "approve" || row?.newerProposal === "needs_you")) {
    return finish(gate(base("newer", CHIP["needs_you"]!, HEADLINE.newer, CARD.newer.title, { body: CARD.newer.body, ...(mayAct || apply?.canApprove === true ? { primary: A("review_newer", ACTIONS.reviewNewer) } : {}) })));
  }
  // ---- the setup broke later (the repair read), or the approved setup's check says so
  if (input.repair?.repair !== undefined) {
    const repair = input.repair.repair, actor = input.repair.canManage;
    const title = CARD.repair.title;
    // On this tab the card says it in Fable's words (the failing step, then why it matters); Code's own sentence (SETUP_REPAIR_SENTENCES.body, a byte mirror) is the banner above the tabs.
    const bodyWords = CARD.repair.body(repair.step, project);
    if (repair.fixReady) return finish(gate(base("repair_fix_ready", CHIP["blocked"]!, HEADLINE.repair, title, { body: bodyWords, ...(actor ? { primary: A("review_newer", SETUP_REPAIR_SENTENCES.approveNewSetup) } : {}) })));
    return finish(gate(base("repair", CHIP["blocked"]!, HEADLINE.repair, title, {
      body: bodyWords,
      ...(actor ? { primary: A("fix", ACTIONS.fix, { hints: [TAB.usesFix(spend)] }), secondary: [A("recheck", ACTIONS.recheck, { hints: [TAB.recheckHint] })] } : {}),
    })));
  }
  // ---- the candidate's check, then its approval
  if (apply !== undefined || stage !== "none") {
    if (stage === "checking") return finish(base("checking", CHIP["checking"]!, HEADLINE.checking, CARD.checking.title, { body: CARD.checking.body }));
    if (stage === "approve") {
      const mayApprove = apply?.canApprove === true && apply.approval !== undefined, mayReject = apply?.canReject === true && apply.approval !== undefined;
      return finish(base("approve", CHIP["needs_you"]!, HEADLINE.approve, CARD.approve.title, { body: CARD.approve.body(project), ...(mayApprove ? { primary: A("approve", ACTIONS.approve) } : {}), secondary: mayReject ? [A("dont_use", ACTIONS.dontUse)] : [] }));
    }
    if (apply !== undefined && (apply.check.status === "failed")) {
      return finish(gate(base("check_failed", CHIP["failed"]!, HEADLINE.checkFailed, CARD.checkFailed.title, {
        rows: [
          { label: TAB.whatHappened, text: failedStep === undefined ? "The setup Rovara found failed on a second machine." : `The setup Rovara found failed on a second machine at: ${failedStep}` },
          { label: TAB.whatIsSafe, text: `Nothing was applied. ${TAB.nothingChanged(project)}` },
          { label: TAB.whatToDo, text: CARD.checkFailed.todo },
        ],
        ...again(true),
      })));
    }
  }
  // ---- how the run ended
  const stop = run.stop;
  if (stage === "review" && (apply !== undefined || stop === undefined || stop === "proposed")) {
    return finish(gate(base("review", CHIP["needs_you"]!, HEADLINE.review, CARD.review.title(project), {
      body: CARD.review.body(row?.commandsFound === undefined ? undefined : `It found ${plural(row.commandsFound.setup, "command")} to install and ${String(row.commandsFound.tests)} to test.`, row?.testOutcome === "passed" ? "Tests passed." : row?.testOutcome === "failed" ? "Tests failed." : undefined, tookWords(row, run)),
      ...(mayAct ? { primary: A("review_setup", ACTIONS.reviewSetup), secondary: [A("run_again", ACTIONS.runAgain)], notes: runAgainNotes() } : {}),
    })));
  }
  if (stop === "hosts_waiting") {
    if (counts.open > 0) {
      const mayReview = counts.mayDecide > 0;
      return finish(gate(base("hosts_open", CHIP["needs_you"]!, HEADLINE.hostsOpen(counts.open), STOPS.hosts_open.title(counts.open), {
        rows: [
          { label: TAB.whatHappened, text: STOPS.hosts_open.happened(counts.open, project) },
          { label: TAB.whatIsSafe, text: STOPS.hosts_open.safe(project) },
          { label: TAB.whatToDo, text: STOPS.hosts_open.todo(counts.open) },
        ],
        ...(mayReview ? { primary: A("review_addresses", ACTIONS.reviewAddresses(counts.open)) } : {}),
        secondary: mayAct ? [A("run_again", ACTIONS.runAgain, { lockedReason: STOPS.hosts_open.locked(counts.decided, counts.total) })] : [],
        notes: mayAct ? runAgainNotes() : [],
      })));
    }
    if ((input.decidedHere ?? 0) > 0) {
      return finish(gate(base("hosts_decided", CHIP["needs_you"]!, HEADLINE.hostsDecided, STOPS.hosts_decided.title(), { body: ADDRESSES.allDecided(counts.total), ...again(true) })));
    }
    if (input.asks === undefined || counts.total === 0) {
      return finish(gate(base("hosts_unknown", CHIP["stopped"]!, HEADLINE.stoppedLimit, STOPS.hosts_unknown.title, {
        rows: [{ label: TAB.whatHappened, text: STOPS.hosts_unknown.happened }, { label: TAB.whatIsSafe, text: safeLine(project, run.proposal !== undefined) }, { label: TAB.whatToDo, text: STOPS.hosts_unknown.todo }],
        ...again(true),
        secondary: limitChange("hostAsks", mayAct),
      })));
    }
    return finish(gate(base("hosts_limit", CHIP["stopped"]!, HEADLINE.stoppedLimit, STOPS.hosts_limit.title, {
      rows: [{ label: TAB.whatHappened, text: STOPS.hosts_limit.happened(run.limits.hostAsks) }, { label: TAB.whatIsSafe, text: safeLine(project, run.proposal !== undefined) }, { label: TAB.whatToDo, text: STOPS.hosts_limit.todo }],
      ...again(true), secondary: limitChange("hostAsks", mayAct),
    })));
  }
  if (stop === "budget_used" || stop === "time_used" || stop === "attempts_used") {
    const kind = stop === "budget_used" ? "limit_budget" : stop === "time_used" ? "limit_time" : "limit_attempts";
    // A stop names the limit the run ENDED against (the run read carries the limits it started with), never the limit saved since.
    const ended = run.limits, endedSpend = dollars(ended.budgetCents);
    const title = stop === "budget_used" ? STOPS.budget_used.title(endedSpend) : stop === "time_used" ? STOPS.time_used.title(String(ended.wallClockMin)) : STOPS.attempts_used.title;
    const happened = stop === "budget_used" ? STOPS.budget_used.happened(endedSpend, project) : stop === "time_used" ? STOPS.time_used.happened(project) : STOPS.attempts_used.happened;
    const todo = stop === "budget_used" ? STOPS.budget_used.todo : stop === "time_used" ? STOPS.time_used.todo : STOPS.attempts_used.todo;
    const limit: SetupLimitName = stop === "budget_used" ? "budgetCents" : stop === "time_used" ? "wallClockMin" : "commands";
    return finish(gate(base(kind, CHIP["stopped"]!, HEADLINE.stoppedLimit, title, {
      rows: [{ label: TAB.whatHappened, text: happened }, { label: TAB.whatIsSafe, text: safeLine(project, run.proposal !== undefined) }, { label: TAB.whatToDo, text: todo }],
      ...again(true), secondary: limitChange(limit, mayAct),
    })));
  }
  if (stop === "stopped_by_person") {
    return finish(gate(base("stopped_person", CHIP["stopped"]!, HEADLINE.stoppedPerson, CARD.stoppedPerson.title(run.stoppedBy?.name), { body: CARD.stoppedPerson.body, ...again(true) })));
  }
  if (stop === "changed_repository_files") {
    return finish(gate(base("changed_files", CHIP["stopped"]!, HEADLINE.stoppedFiles, CARD.changedFiles.title, { body: CARD.changedFiles.body, ...again(true), secondary: [A("show_log", ACTIONS.showRan)] })));
  }
  if (stop === "needs_code_change") {
    return finish(gate(base("code_change", CHIP["blocked"]!, HEADLINE.codeChange, CARD.codeChange.title(project), { ...(extraOf(serverSentence(run, row)) === undefined ? {} : { body: extraOf(serverSentence(run, row))! }), ...(mayAct ? { secondary: [A("run_again", ACTIONS.runAgain)], notes: runAgainNotes() } : {}) })));
  }
  if (stop === "infrastructure") {
    return finish(gate(base("infrastructure", CHIP["could_not_run"]!, HEADLINE.infrastructure, CARD.infrastructure.title, { body: CARD.infrastructure.body, ...again(true) })));
  }
  if (run.status === "failed") {
    const command = row?.failedCommand?.command;
    return finish(gate(base("failed", CHIP["failed"]!, HEADLINE.failed, CARD.failed.title(command), {
      ...(command === undefined ? {} : { titleCode: command }),
      rows: [
        { label: TAB.whatHappened, text: serverSentence(run, row) ?? "A command of the setup failed." },
        { label: TAB.whatIsSafe, text: CARD.failed.safe(project) },
        { label: TAB.whatToDo, text: CARD.failed.todo },
      ],
      ...again(true), secondary: row?.failedCommand === undefined ? [] : [A("show_log", ACTIONS.showLog)],
    })));
  }
  // ---- no run, or a run that finished with nothing waiting
  if (run.status === "none") {
    return finish(gate(base("none", CHIP["needs_you"]!, HEADLINE.none, CARD.none.title(project), { body: CARD.none.body(spend), ...(mayAct ? { primary: A("run", ACTIONS.run), notes: [TAB.uses(spend)] } : {}) })));
  }
  if (approved) {
    const check = row?.check?.status;
    if (check === "ready" && row?.state === "done") {
      const when = row.approvedAt === undefined ? undefined : approvedWhen(row.approvedAt);
      return finish(gate(base("verified", CHIP["done"]!, HEADLINE.verified, CARD.verified.title(project), {
        ...(when === undefined && tookWords(row, run) === undefined ? {} : { body: CARD.verified.body(when, tookWords(row, run)) }),
        ...(input.mayStartTask ? { primary: A("start_task", ACTIONS.startTask) } : {}),
        secondary: mayAct ? [A("run_again", ACTIONS.runAgain)] : [], notes: mayAct ? [TAB.uses(spend), TAB.againKeepsSetup] : [],
      })));
    }
    if (check === "failed") return finish(gate(base("approved_failed", CHIP["failed"]!, HEADLINE.failed, CARD.approvedFailed.title, { rows: [{ label: TAB.whatHappened, text: failedStep === undefined ? CARD.approvedFailed.body : `${CARD.approvedFailed.body} It fails at: ${failedStep}` }, { label: TAB.whatIsSafe, text: CARD.failed.safe(project) }, { label: TAB.whatToDo, text: CARD.failed.todo }], ...again(true) })));
    return finish(gate(base("approved_unchecked", CHIP["needs_you"]!, HEADLINE.review, CARD.approvedUnchecked.title, { body: CARD.approvedUnchecked.body, ...again(true, [TAB.againKeepsSetup]) })));
  }
  const decided = input.decided === undefined ? undefined : CARD.decided[input.decided];
  return finish(gate(base("idle", decided === undefined ? CHIP["needs_you"]! : CHIP["stopped"]!, HEADLINE.idle, CARD.idle.title, { body: decided ?? CARD.idle.body, ...again(true) })));
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
/** What a server sentence says beyond the title's own words ("The project needs a change in its code before it can be set up."). */
const extraOf = (text: string | undefined): string | undefined => { if (text === undefined) return undefined; const rest = text.replace(/^The project needs a change in its code before it can be set up\.?:?\s*/u, "").trim(); return rest === "" ? undefined : rest.charAt(0).toUpperCase() + rest.slice(1); };
const safeLine = (project: string, hasProposal: boolean): string => OPEN_POINTS.limitStopKeepsCommands ? `${TAB.nothingChanged(project)} ${TAB.commandsKept}${hasProposal ? ` ${TAB.foundKept}` : ""}` : TAB.nothingChanged(project);
const limitChange = (limit: SetupLimitName, mayAct: boolean): CardAction[] => mayAct ? [A("change_limit", ACTIONS.changeLimit[limit], { limit })] : [];
function serverSentence(run: SetupAgentView, row: CardInput["row"]): string | undefined {
  const text = run.failure ?? row?.failure;
  return text === undefined || text === "" ? undefined : text;
}
function tookWords(row: CardInput["row"], run: SetupAgentView): string | undefined {
  const ms = row?.elapsedMs ?? run.summary?.elapsedMs, cents = row?.costCents ?? run.summary?.spendCents;
  if (ms === undefined) return undefined;
  return `Took ${durationWords(ms)}${cents === undefined ? "" : `, cost ${dollars(cents)}`}.`;
}
function approvedWhen(at: string): string | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : `on ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export const HEADLINE = {
  unknown: "Setup status unknown", none: "Setup hasn't run yet", running: "Setting up", checking: "Checking the setup", newerChecking: "Checking a newer setup", newer: "A newer setup is waiting",
  review: "Setup found, needs review", approve: "Setup waits for approval", verified: "Setup is verified", failed: "Setup failed", checkFailed: "Setup failed its check", repair: "Setup stopped working",
  stoppedLimit: "Setup stopped at a limit", stoppedPerson: "Setup was stopped", stoppedFiles: "Setup stopped", codeChange: "Setup needs a code change", infrastructure: "Setup could not run", idle: "No setup is waiting",
  hostsDecided: "Addresses are decided", hostsOpen: (n: number) => `Setup is waiting for ${String(n)} ${n === 1 ? "address" : "addresses"}`,
} as const;
