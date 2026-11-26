// The Setup tab's fixed words, in one place (FABLE-REVIEW 2026-11-23, sections 2 and 3; the owner chose "address" for an outside destination a setup run asks to reach). Nothing here is built from server text: a name, a
// command or a sentence that comes from the server is shown through VisibleText next to these words, never inside them.
//
// MIRROR LIST (words Cloud copies from Rovara Code byte for byte; left as Code has them until Code's own copy lane lands, then re-mirrored):
//   - packages/contracts `SETUP_REPAIR_SENTENCES` (title, body, readerNote, changedLabel): the "Setup needs repair" card's words, pinned against Code's fixture by a test.
//   - packages/ui `HOSTS_STOP_WORDS.decisionOpen` (Code's SETUP_OPEN_HOST_NOTE) in screens/setup/words.ts.
// Everything else on the tab is Cloud's own wording.

/**
 * Sentences whose truth depends on a fact Code has to confirm (FABLE-REVIEW "Open points"). Each is kept behind its flag: a `false` drops the sentence from the page. They are read from
 * briefs/codex/setup-tab/OPEN-POINTS.md when Code's answer arrives; until then each holds the value the contracts and the reads support (the comment says what supports it).
 */
import { MISMATCH_WORDS } from "../setup/words.js";

export const OPEN_POINTS = Object.freeze({
  /** Checked in Code (OPEN-POINTS.md, point 1): the commands a limit stop ran are ALWAYS kept; a proposal only when one could be read (the read then says `ready`). So "The commands it ran are kept below." is said always, "What it found so far" only with a proposal. */
  limitStopKeepsCommands: true,
  /** Point 2, TRUE: a saved limit applies to runs that start later; a run that is going keeps the limits it began with. */
  savedLimitsApplyToLaterRuns: true,
  /** Point 3: an allow is for THIS PROJECT only, and covers machines that start after it (tasks as well as setup); not company-wide. A refusal lasts 7 days. */
  allowIsThisProjectOnly: true,
  /** Point 4: the stopper's name is served (`stoppedBy.name`, "Unknown" when Code has none); who allowed, refused or approved is NOT, so no such name is ever shown. */
  approverNameServed: false,
  /** Point 5: `attempts_used` covers three causes (commands, retries of one failing step, a full 400-entry journal) and the server cannot say which: never split. */
  attemptsSplitServed: false,
  /** Point 6: the server has no spend floor (it accepts 1 cent). The page makes no promise of one; the field only suggests a sensible amount. */
  serverSpendFloor: false,
});

export const TAB = Object.freeze({
  tabLabel: "Setup",
  loading: "Reading setup",
  notAvailable: "Setup with Rovara isn't available on this Rovara yet.",
  reconnecting: "Reconnecting. What you see may be a few seconds old.",
  readerNote: "A project admin, or a company owner or admin, can do this.",
  uses: (spend: string | undefined) => spend === undefined ? "Uses this project's AI budget." : `Uses up to ${spend} of this project's AI budget.`,
  usesFix: (spend: string | undefined) => spend === undefined ? "Uses your AI." : `Uses your AI, up to ${spend}.`,
  recheckHint: "Runs the saved setup once more. Free.",
  againKeepsSetup: "Running again doesn't change the setup in use. You approve a new one first.",
  whatHappened: "What happened", whatIsSafe: "What is safe", whatToDo: "What to do",
  nothingChanged: (project: string) => `Nothing in ${project} was changed.`,
  commandsKept: "The commands it ran are kept below.",
  foundKept: "What it found so far is kept below too.",
});

/** Buttons. One name per thing (3.6). */
export const ACTIONS = Object.freeze({
  openSetup: "Open Setup", run: "Run setup", runAgain: "Run setup again", stop: "Stop setup", fix: "Fix setup", recheck: "Check again without AI",
  reviewAddresses: (n: number) => `Review ${String(n)} ${n === 1 ? "address" : "addresses"}`,
  reviewSetup: "Review the setup", checkSetup: "Check this setup", approve: "Approve this setup", dontUse: "Don't use it", reviewNewer: "Review the newer setup",
  startTask: "Start a task", readAgain: "Read again", openCompany: "Open Company settings", showLog: "Show the last lines", showRan: "Show what Rovara ran",
  changeLimit: { budgetCents: "Change the spend limit", wallClockMin: "Change the time limit", commands: "Change the limits", sameStepTries: "Change the limits", hostAsks: "Change the new-address limit" },
});

/** The chip words are the design system's (`StatusChip`); these are the title and body of the status card for each state (3.5). */
export const CARD = Object.freeze({
  none: { title: (p: string) => `Set up ${p} so Rovara can work on it`, body: (spend: string | undefined) => `Rovara installs the project and runs its tests once, on a separate machine. Nothing in your repo is changed, and no secrets are used. It usually takes a few minutes and uses ${spend === undefined ? "this project's AI budget" : `up to ${spend} of this project's AI budget`}.` },
  running: { title: (p: string) => `Rovara is setting up ${p}`, body: "Nothing is needed from you. You can leave; this page shows the same run when you come back." },
  review: { title: (p: string) => `Rovara found how to set up ${p}. Review it.`, body: (found: string | undefined, tests: string | undefined, took: string | undefined) => [found, tests, took].filter((one): one is string => one !== undefined).join(" ") },
  checking: { title: "Rovara is checking the setup on a second machine", body: "It runs the setup from nothing to make sure it works every time. This can take a few minutes. Nothing is needed from you." },
  approve: { title: "The setup works. Approve it to finish.", body: (p: string) => `It passed on a second machine. Approving makes it the setup every task in ${p} uses.` },
  verified: { title: (p: string) => `Setup approved. Tasks in ${p} use this setup.`, body: (when: string | undefined, took: string | undefined) => [when === undefined ? undefined : `Approved ${when}.`, took].filter((one): one is string => one !== undefined).join(" ") },
  newer: { title: "A newer setup is waiting for your review", body: "The setup in use still works." },
  newerChecking: { title: "A newer setup is being checked on a second machine", body: "The setup in use still works. Nothing is needed from you." },
  failed: { title: (step: string | undefined) => step === undefined ? "Setup failed" : "Setup failed at:", safe: (p: string) => `Nothing in ${p} was changed.`, todo: "Fix the cause, then run setup again." },
  checkFailed: { title: "The setup didn't pass on a second machine", todo: "Run setup again, or discard this setup below." },
  infrastructure: { title: "Rovara couldn't run setup. This is on our side.", body: "This is not your repo or your settings. Nothing was changed." },
  codeChange: { title: (p: string) => `${p} needs a change in its code before it can be set up` },
  changedFiles: { title: "Setup stopped: a command changed the project's files", body: "Setup must not change your code, so Rovara ended the run. Nothing was pushed." },
  stoppedPerson: { title: (by: string | undefined) => by === undefined ? "Setup was stopped" : `Setup was stopped by ${by}`, body: "The commands it ran are kept below. Nothing was checked or applied." },
  repair: { title: "Setup stopped working after recent code changes", body: (step: string, p: string) => `It fails at: ${step}. Work on ${p} continues; results may be less reliable until setup is fixed.` },
  off: { title: (company: string) => `Setup runs are turned off for ${company}`, body: "A company owner or admin can turn them on in Company settings." },
  held: { title: (company: string) => `Setup runs are on hold for ${company}`, body: "The company's setup locks can't be read, so setup runs are held. Contact Rovara support to get them running again." },
  unreadable: { title: "Rovara couldn't read where setup stands", body: "That doesn't mean setup failed." },
  approvedFailed: { title: "The setup in use failed its check", body: "The setup you approved no longer passes on a second machine." },
  approvedUnchecked: { title: "The setup in use hasn't been checked on a second machine", body: "Run setup again to check it from nothing." },
  idle: { title: "No setup is waiting for you", body: "Run setup again to look for a new setup." },
  decided: { approved: "Approved. This project now uses this setup.", rejected: "Not used. This project keeps the setup it had.", discarded: "Discarded. This project keeps the setup it had." },
});

/** Stops (2, "When a limit is hit"): three-part error, each with the limit to change. The numbers come from the limits read; unread, they are dropped. */
export const STOPS = Object.freeze({
  budget_used: { title: (n: string | undefined) => n === undefined ? "Setup stopped: it reached its spend limit" : `Setup stopped: it reached its ${n} spend limit`, happened: (n: string | undefined, p: string) => n === undefined ? `Rovara used the AI spend ${p} allows for one setup run before it finished.` : `Rovara used the ${n} ${p} allows for one setup run before it finished.`, todo: "Run setup again, or allow more first." },
  time_used: { title: (n: string | undefined) => n === undefined ? "Setup stopped: it reached its time limit" : `Setup stopped: it reached its ${n} minute limit`, happened: (p: string) => `The run took longer than ${p} allows for one setup run.`, todo: "Run setup again, or allow more time first." },
  attempts_used: { title: "Setup stopped: it reached its limit on commands or retries", happened: "Rovara ran the most commands it is allowed in one run, or kept failing at the same step.", todo: "Look at the last command below. If the project needs a longer setup, allow more and run setup again." },
  hosts_open: { title: (n: number) => `Setup is waiting for you: ${String(n)} ${n === 1 ? "address" : "addresses"} to allow or refuse`, happened: (n: number, p: string) => `While installing, ${p} asked for ${String(n)} ${n === 1 ? "address" : "addresses"} that ${n === 1 ? "is" : "are"} not on its allowed list. Rovara did not connect to ${n === 1 ? "it" : "them"}.`, safe: (p: string) => `Nothing reached those addresses. Nothing in ${p} was changed.`, todo: (n: number) => `Decide ${n === 1 ? "the address" : "each address"} below, then run setup again.`, locked: (decided: number, n: number) => `${String(decided)} of ${String(n)} addresses decided` },
  hosts_decided: { title: () => "Your decisions are in" },
  hosts_limit: { title: "Setup stopped: it asked for more addresses than it is allowed, or waited too long for a decision", happened: (n: number | undefined) => `The run reached its limit of ${n === undefined ? "new addresses" : `${String(n)} new addresses`}, or waited 2 hours for a decision. No address is waiting now.`, todo: "Run setup again. It picks up with the addresses you allowed." },
  hosts_unknown: { title: "Setup stopped because of the addresses it needed", happened: "The run reached a limit on address requests or on waiting, or an address decision was still open.", todo: "Run setup again to go on." },
});

/** The five limits (2): label, the line at rest, the unit beside the field in edit mode. */
export const LIMIT_ROWS = Object.freeze({
  budgetCents: { label: "AI spend", unit: "a run", rest: (v: string) => `Up to ${v} a run` },
  wallClockMin: { label: "Time", unit: "minutes", rest: (v: string) => `Up to ${v} minutes a run` },
  commands: { label: "Commands", unit: "commands", rest: (v: string) => `Up to ${v} commands a run` },
  sameStepTries: { label: "Retries", unit: "tries at a step that keeps failing", rest: (v: string) => `Up to ${v} tries at a step that keeps failing` },
  hostAsks: { label: "New addresses", unit: "addresses it can ask you to allow", rest: (v: string) => `Up to ${v} addresses it can ask you to allow` },
} as const);
export const LIMIT_ORDER = ["budgetCents", "wallClockMin", "commands", "sameStepTries", "hostAsks"] as const;

export const LIMITS = Object.freeze({
  heading: "Limits for a setup run",
  intro: "Rovara stops a setup run when it reaches any of these, so a stuck run can't keep spending.",
  introKept: " The commands it ran are kept.",
  change: "Change limits", save: "Save limits", cancel: "Cancel", standard: "Use Rovara's standard",
  loading: "Reading the limits",
  loadFailed: "Rovara couldn't read this project's limits. That doesn't mean there are none.", readAgain: "Read again",
  applies: "Applies to setup runs that start after you save.", appliesRunning: " A run that is going now keeps its limits.",
  saved: "Saved. Setup runs that start from now use these limits.",
  stale: "These limits were changed by someone else while you were editing. The current values are shown. Check them and save again if you still want your change.",
  staleUnread: "These limits were changed by someone else, and Rovara couldn't read the new values.", readLimitsAgain: "Read the limits again",
  noReply: "Rovara didn't hear back, so your change may or may not be saved. The values shown now are what Rovara reads. Saving the same change again is safe.",
  noReplyUnread: "Rovara didn't hear back, and couldn't read the limits. Don't save again yet.", checkLimits: "Check the limits",
  // helper lines at rest
  standardRest: (max: string) => `Rovara's standard. Can be set up to ${max}.`,
  spendHint: "A very small amount stops the run at once.",
  own: (standard: string) => `Set for this project. Rovara's standard is ${standard}.`,
  capInForce: (company: string, cap: string) => `${company} allows up to ${cap}.`,
  capIsValue: (company: string) => `Set by ${company} for every project.`,
  // helper lines in edit mode
  fieldHint: (standard: string, most: string) => `Rovara's standard is ${standard}. Up to ${most}.`,
  fieldHintCap: (standard: string, company: string, cap: string) => `Rovara's standard is ${standard}. ${company} allows up to ${cap}.`,
  errNumber: "Enter a whole number.", errSpend: "Enter an amount in dollars, like 4 or 4.50.", errSmall: "Enter 1 or more.", errSmallSpend: "Enter an amount above $0.",
  errMost: (most: string) => `Rovara allows up to ${most}.`, errCap: (company: string, cap: string) => `${company} allows up to ${cap}. A company owner or admin can raise it.`,
});

export const ADDRESSES = Object.freeze({
  heading: "Addresses to decide",
  decidedHeading: (n: number) => `Addresses this run asked for (${String(n)})`,
  askedWhile: "Asked while running:",
  allow: "Allow", refuse: "Refuse",
  scope: "Allowing an address lets this project's machines connect to it. It applies to this project only, and to machines that start after you allow it.",
  refuseNote: "Refusing keeps it blocked for this project for 7 days. Setup carries on without it and may stop again if it truly needs it.",
  waitingAdmin: "Waiting for a company owner or admin to decide.",
  waitingYou: "Waiting for your decision.",
  youAllowed: "Allowed by you just now.", youRefused: "Refused by you just now.", allowed: "Allowed.", refused: "Refused.",
  noReply: "Rovara didn't hear back, so it doesn't know if your answer was saved.", check: "Check", checking: "Checking",
  checkFailed: "Couldn't check just now. Nothing more can be decided until this page reads again.",
  moved: "Someone already decided this address. The list has been read again.",
  stale: "Couldn't refresh the list, so nothing was sent. Reconnecting.",
  reconnecting: "Couldn't refresh; reconnecting.", savedReconnecting: "Saved. Couldn't refresh; reconnecting.", wentThrough: "Your change went through.",
  allDecided: (n: number) => `All ${String(n)} ${n === 1 ? "address is" : "addresses are"} decided. Run setup again to carry on.`,
  failed: "Couldn't send that. Check before deciding again.",
});

export const RUN = Object.freeze({
  heading: "This run", headingLast: "Last run", headingSetupInUse: "The run behind the setup in use", laterCheck: "The check that failed ran later, on the saved setup. It is not in this log.",
  ran: (n: number) => `What Rovara ran (${String(n)} ${n === 1 ? "command" : "commands"})`,
  empty: "No commands yet.", emptyRunning: "Rovara hasn't run a command yet.",
  loading: "Reading what Rovara ran", failed: "Rovara couldn't read what this run did.",
  rovaraRan: "Rovara ran", youRan: "You ran", worked: "Worked", timedOut: "Timed out", failedCode: (code: number | null) => code === null ? "Failed" : `Failed (code ${String(code)})`,
  flagged: "Downloads and runs code (ran only on the separate machine)", couldntReach: "Couldn't reach:", output: "Output",
  help: "Help Rovara along (optional)",
  steerLabel: "Tell Rovara something about this project", steerHint: "For example, which command builds it. This guides Rovara; it can't change the limits or the allowed addresses.", steerSend: "Send to Rovara", steerSent: "Sent. Rovara reads it before its next step.",
  started: (when: string) => `Started ${when}`,
});

export const FOUND = Object.freeze({
  heading: "The setup Rovara found", install: "To install", test: "To test", none: "Rovara found no setup or test commands to use.",
  next: (p: string) => `Next, Rovara checks this on a second machine. Nothing changes in ${p} until you approve.`,
  checking: "Rovara is still checking where each suggestion came from.", saved: "Rovara is checking it on a second machine. When the check passes, approve it here.",
  leftOut: { unverified: "Left out: it doesn't match the code.", refused_command: "Left out: it downloads and runs code, or holds a secret.", not_a_command_item: "Left out: it isn't a command.", too_many: "Left out: there are too many commands.", invalid_command: "Left out: it couldn't be read as a command." },
  unmatchedBefore: MISMATCH_WORDS.before, unmatchedAfter: MISMATCH_WORDS.after,
  useAnyway: MISMATCH_WORDS.useAnyway, chosenAnyway: MISMATCH_WORDS.chosenAnyway, tickOne: MISMATCH_WORDS.tickOne,
  noInstall: "No install commands are ticked. The check runs the tests with the install commands this project already has, or with none if it has none.",
  readOnly: "Rovara has a setup waiting. A project admin, or a company owner or admin, reviews and approves it.",
});

export const APPROVE = Object.freeze({
  heading: "What you are approving", headingNewer: "The newer setup", approveNewer: "Approve the newer setup", headingFailed: "The check on a second machine", headingStale: "Not checked yet", passed: "Passed on a second machine.", failed: (step: string | undefined) => step === undefined ? "Failed on a second machine. Nothing was applied." : "Failed on a second machine at:",
  failedTail: "Nothing was applied.", stale: "The check has not run on this setup yet.", checking: "Rovara is checking it on a second machine. This can take a few minutes.",
  discard: "Don't use it", details: "Details", whatChanged: "What changed",
  approved: "Approved. This project now uses this setup.", rejected: "Not used. This project keeps the setup it had.", discarded: "Discarded. This project keeps the setup it had.",
});

export const ALSO = Object.freeze({
  heading: "Also for this project", optional: "Optional. Setup is complete without these.",
  open: "Open", review: "Review",
  wiki: { title: "Project wiki", none: "Not built.", building: (written: number, planned: number) => planned > 0 ? `Building, ${String(written)} of ${String(planned)} pages.` : "Building.", pages: (n: number) => `${String(n)} ${n === 1 ? "page" : "pages"}.`, unknown: "Couldn't read it just now." },
  browser: { title: "Browser testing" },
  evals: { title: "AI evals", before: "Looked for after setup finishes.", none: "None found. Rovara checks work with the project's own tests.", noEvals: "None. Rovara checks work with the project's own tests.", waiting: "Rovara found checks to review.", confirmed: (sel: string) => `Runs ${sel} before every pull request.`, reported: "Found checks. A project admin confirms them." },
  evalCheck: { title: "Eval check from your CI" },
});

/** Page chrome. */
export const HEADER = Object.freeze({
  none: "Setup hasn't run yet", running: "Setting up", verified: "Setup is verified", unknown: "Setup status unknown",
});

/** The right-hand help column: it changes with the state (3.4). Absent for a state with nothing to add. The wording follows mocks 11c and 15e. */
export const HELP: Readonly<Partial<Record<string, { heading: string; text: string }>>> = Object.freeze({
  none: { heading: "What happens", text: "Rovara reads the repos, installs the project and runs its tests once. Tasks start only after setup is verified." },
  running: { heading: "If you leave", text: "This page shows the same run when you come back." },
  hosts_open: { heading: "When every address is decided", text: "Press Run setup again. It starts from the top as a new run and picks up with the addresses you allowed. A refused address can make it stop again, and it says so." },
  hosts_decided: { heading: "What happens next", text: "Run setup again starts from the top as a new run. A refused address can make it stop again, and it says so." },
  review: { heading: "What happens next", text: "Rovara checks the setup it found on a second machine, from nothing. Nothing in the project changes until you approve." },
  checking: { heading: "If you leave", text: "This page shows the same check when you come back." },
  failed: { heading: "If it keeps failing", text: "Look at the last command in the log. Setup never changes your repo, so nothing needs undoing." },
  infrastructure: { heading: "Rovara's machine couldn't run it", text: "This was not your repo or your settings. Run setup again; if it repeats, tell us what the log says." },
  hosts_limit: { heading: "Picking up again", text: "Run setup again. It starts from the top as a new run and picks up with the addresses you allowed. To allow more new addresses in one run, change the new-address limit." },
  approve: { heading: "What approving does", text: "The setup becomes the one every task in this project uses. Until you approve, the setup in use is unchanged, and nothing in the repo is touched." },
  check_failed: { heading: "What happens to it", text: "Nothing was applied. Run setup again to look for a new setup, or choose Don't use it to drop this one." },
  code_change: { heading: "What to do", text: "Make the change in the project's code, then run setup again. Setup never edits your code itself." },
  changed_files: { heading: "Why Rovara stops", text: "Setup is only allowed to read and run commands. If a command changes tracked files, Rovara ends the run so nothing is pushed by mistake." },
  stopped_person: { heading: "Starting again", text: "Run setup again starts a new run from the top." },
  limit_budget: { heading: "Allowing more", text: "A project admin, or a company owner or admin, can change the spend limit below. A saved limit applies to runs that start after it is saved." },
  limit_time: { heading: "Allowing more", text: "A project admin, or a company owner or admin, can change the time limit below. A saved limit applies to runs that start after it is saved." },
  limit_attempts: { heading: "Allowing more", text: "Look at the last command in the log. If the project needs a longer setup, a project admin, or a company owner or admin, can change the limits below." },
  repair: { heading: "Two ways forward", text: "Fix setup asks Rovara to work out a fixed setup, which uses your AI. Check again without AI only runs the saved setup once more." },
  off: { heading: "Who can turn it on", text: "Setup runs are a company setting. A company owner or admin turns them on in Company settings." },
  verified: { heading: "What this means", text: "Only a passed run on a second machine makes a project ready." },
});
