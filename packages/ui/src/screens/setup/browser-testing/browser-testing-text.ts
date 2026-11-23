// Every sentence of the Browser testing page and its checklist row (owner DEC 417, 420, 421; the approved mock, MOCK-NOTES "Sentence -> served fact"). Each is true for what the page's read serves: nothing says
// a sign-in worked that was not tried, nothing says "nothing was changed", and nothing mentions a password, an address or an account to type (there is none). The start command, the health path, a kind of user's name and
// the sign-in file are the customer's own repository's text and are drawn as text only.
import { BROWSER_TESTING_CODE_SENTENCES as CODE } from "@agentx/contracts/web";

export const BT = {
  title: "Browser testing",
  lede: "Rovara starts your app in a test sandbox and tries each change in a real browser before it reaches review.",
  // the chips
  chipNone: "Not set up", chipDraft: "Draft", chipChecking: "Checking", chipFailed: "Check failed", chipWaiting: "Waiting for approval", chipOn: "On", chipPaused: "Paused", chipFault: "Needs attention", chipReading: "Reading…",
  // reads
  reading: "Reading this project's browser testing…",
  readFailedTitle: "Rovara couldn't read this project's browser testing.", readFailedText: "Try again in a moment.", tryAgain: "Try again",
  notYet: "Browser testing isn't available on this Rovara yet.",
  accessLostTitle: "Rovara can't read this project's browser testing any more.", accessLostText: "Your access may have changed. Reload to check, or ask an owner or admin.", reload: "Reload",
  wentThrough: "Your change went through.",
  stale: "Updated · Reconnecting. Controls are off until Rovara reconnects.",
  offUntilReconnect: "Available again once Rovara reconnects.",
  savedStaleTitle: "Saved. Couldn't refresh; reconnecting.", savedStaleText: "Your change went through. Controls are off until Rovara reconnects.",
  // who
  onlyAdmins: "Only a company owner or admin can change browser testing. Ask your company's admins.",
  onlyAdminsSetUp: "Only a company owner or admin can set up browser testing. Ask your company's admins to set it up.",
  noPermissionTitle: "Only a company owner or admin can change this.", noPermissionText: "Your access may have changed. Nothing was sent. Reload to check your access, or ask an owner or admin.",
  /** The request WAS sent and refused: Code's 403s all come before any change, so this says the true thing. */
  noPermissionSentText: "Your access may have changed. Nothing was changed. Reload to check your access, or ask an owner or admin.",
  // not set up
  introTitle: (project: string) => `Turn on browser testing for ${project}`,
  introLead: "Rovara starts your app in a sandbox, opens it in a real browser and checks that a change works. It reads how to start the app, and which kinds of user it has, from your repo. You'll need:",
  need: [
    ["Your repo to say how the app starts.", "Rovara shows you what it found. If it finds nothing, it uses its usual start command."],
    ["Optional: your repo to say how to sign in.", "Then Rovara tests as each kind of user, with a fresh test login for each check. Nothing to type or store. Without it, Rovara tests signed-out pages only."],
    ["How much proof Rovara keeps and how long a check may run.", "The starting choices are careful."],
    ["An owner's or admin's approval.", "Nothing runs until someone approves what you set here."],
  ] as ReadonlyArray<readonly [string, string]>,
  start: "Start setting up",
  // problems found in the repo
  problem: { "no-application": CODE.needsInput, "needs-input": CODE.needsInput, "too-many-user-kinds": CODE.tooManyKinds, "more-than-one-repository": CODE.oneRepository } as const,
  // card 1
  startTitle: "How your app starts", startFound: "Found in your repo", startUsual: "Rovara's usual way",
  startLead: "Rovara starts your app in the sandbox on its own address. This is not your live site.",
  startCommand: "Start command", waitsFor: (path: string) => `Rovara waits for ${path} to answer.`,
  foundInRepo: "Found in your repo.", usualWay: "Your repo doesn't say how to start the app, so Rovara uses its usual way.",
  startFoot: "To change it, change the repo and read it again.", startFootReader: "To change it, change the repo and ask an owner or admin to read it again.", readAgain: "Read the repo again",
  // card 2
  accountsTitle: "Test accounts", accountsFound: (n: number) => `${n} found in your repo`, signedOutOnly: "Signed-out pages only",
  accountsLead: "These are the kinds of user your repo says the app has. Rovara signs in as each one during a browser check.",
  visitor: "Signed-out visitor", visitorText: "Always included. It needs no account.", alwaysOn: "Always on",
  kindText: "Rovara creates a fresh test login for each check. Nothing to type or store.",
  signInPage: "Sign-in page", declared: "Declared in your repo.",
  accountsFoot: "To add or remove a kind of user, change the repo and read it again.", accountsFootReader: "To add or remove a kind of user, change the repo and ask an owner or admin to read it again.",
  untried: "Not tried yet", signedInOk: (when: string) => `Signed in OK · ${when}`, signInRefused: (when: string) => `Sign-in refused · ${when}`,
  triesFirst: "Rovara tries each sign-in in the first browser check.",
  refusedTitle: (kind: string, when: string) => `Rovara couldn't sign in as ${kind} in the browser check on ${when}.`, refusedText: "Check the sign-in in your repo, then read the repo again.",
  noSignIn: "Your repo doesn't say how to sign in yet. Rovara will test signed-out pages only.",
  toTestSignedIn: "To test as signed-in users",
  snippetLead: "This needs a small change in your repo, usually by a developer: this file, and a seed step that creates each test user from the login Rovara gives it. Then read the repo again.",
  snippetFile: (path: string) => (/(^|\/)package\.json$/u.test(path) ? `Add the "agentx" key below to ${path}, beside its other keys (not the outer braces).` : `Save this as ${path}`), copy: "Copy snippet", copied: "Copied", copyFailed: "Couldn't copy. Select the text and copy it.",
  // card 3
  proofTitle: "Proof and limits", proofSaved: "Saved", proofDefaults: "Careful defaults", proofChanging: "Changing",
  proofLead: "How much proof Rovara keeps and how long a browser check may run.", proofLeadDefaults: "Rovara starts with careful choices. Change any of them.",
  proofKept: "Proof kept", limitEach: "Limit for each check", aiUse: "AI use",
  aiLine: "Rovara's AI writes the browser checks in each plan; that use counts against the project's AI limit.",
  shotsFailed: "A screenshot of each failed step", shotsAll: "A screenshot after every step", withVideo: ", and a screen recording",
  stopsAfter: (minutes: string) => `Stops after ${minutes}`,
  editScreenshots: "Screenshots", editFailed: "Of each failed step", editAll: "After every step", editVideo: "Screen recording", keepVideo: "Keep a screen recording", videoHint: "Screenshots and recordings can show test data on screen.",
  editLimit: "How long a browser check may run", stopAfter: "Stop a check after", saveChoices: "Save choices", cancel: "Cancel", changeChoices: "Change choices",
  // card 4
  approveTitle: "Check and approve", next: "Next", blocked: "Blocked",
  checkLead: "Before you approve, Rovara runs your repo's setup and test commands in a fresh workspace. This takes a few minutes. Nothing is switched on yet.",
  checkLeadSignIns: " Rovara tries each sign-in in the first browser check, after you approve.",
  check: "Check the setup", checkAgain: "Check again",
  checkingText: "Rovara is running your repo's setup and test commands in a fresh workspace…",
  failedTitle: "Your repo's commands failed.", failedText: "Rovara ran your repo's setup and test commands in a fresh workspace, and this one failed:",
  failedNext: "Fix it in your repo, then clear this check, read the repo again and check the setup again.",
  failedLead: "The last check failed. Fix what the message at the top of this page says, then clear this check, read the repo again and check the setup again.",
  refreshWhileChecking: "Available once the check finishes.", refreshAfterClear: "Clear this check first.", refreshWhileSetupWaiting: "Available once the waiting setup change is decided.",
  clearCheck: "Clear this check",
  sandboxBlocked: "You can check the setup again once Rovara can start the test sandbox.",
  setupWaiting: "A change to the project's setup is waiting for approval. Browser testing can't change until it is decided.",
  draftStale: "The project's setup changed after Rovara read your repo. Read the repo again before you check.",
  // approval
  approveCardTitle: "Approve browser testing", approveChangeTitle: "Approve the change", waitingForYou: "Waiting for you", waitingForOwner: "Waiting for an owner or admin", waitingApproval: "Waiting for approval",
  approveLead: "This is exactly what you're approving. Nothing runs until you do.", approveLeadMember: "This is what an owner or admin will approve.",
  checkedLine: (when: string) => `Checked ${when}: Rovara ran your repo's setup and test commands in a fresh workspace. They passed.`,
  howStarts: "How the app starts", signInAs: "Sign in as",
  signedOutOnlyLine: "Signed-out visitor only (your repo declares no sign-in).", freshLogin: "Rovara creates a fresh login for each kind, for each check.",
  commandsSummary: "Commands Rovara will run in the sandbox", cmdBuild: "Build", cmdStart: "Start", cmdWait: "Wait for",
  whoApproves: "Who can approve: company owners and admins.",
  happensTitle: "What happens when you approve",
  happens: (project: string) => `Browser testing turns on for ${project}. When a task started from now on changes the app, Rovara adds a browser check to its plan, and you approve that plan as usual. If you later change proof or limits, or you read the repo again and it has changed, that change needs approving too.`,
  happensChange: "Browser checks switch to this version. If you later change proof or limits, or the repo changes, that change needs approving too.",
  approve: "Approve browser testing", approveChange: "Approve this change", approving: "Approving…", changeProof: "Change proof and limits", changeProofNote: "This drops the check. After you change it, you press Check the setup again.", discard: "Discard this change",
  readyTitle: "Ready to approve.", readyText: "The check passed. Review what you are approving below.",
  conflictTitle: "This changed while you were looking.", conflictText: "Someone just changed the setup, so what you saw may be out of date. Refresh to see the current setup before you approve.", refresh: "Refresh",
  unreadableSummary: "Rovara can't read what was checked just now, so there is nothing to approve. Try again in a minute.",
  // on
  onTitle: (project: string) => `Browser testing is on for ${project}.`,
  onText: "When a task started from now on changes the app, Rovara adds a browser check to its plan.",
  approvedBy: (who: string, when: string) => `Approved by ${who}${when === "" ? "" : ` on ${when}`}.`, byYou: "you", byAdmin: "an owner or admin",
  approvedSetup: "Approved setup", approvedSetupPaused: "Approved setup, paused", approvedLead: "It covers exactly the setup below.",
  pausedBanner: "Browser testing is paused.", pausedText: "Tasks started from now on get no browser checks. A task whose plan is already approved keeps its checks.",
  pausedLead: "Resuming uses this same setup.",
  changeRepoFoot: "To change how the app starts or which users it signs in as, change the repo and read it again.", changeRepoFootReader: "To change how the app starts or which users it signs in as, change the repo and ask an owner or admin to read it again.",
  pause: "Pause browser testing", resume: "Resume browser testing",
  pauseTitle: "Pause browser testing", pauseQuestion: (project: string) => `Pause browser testing for ${project}?`,
  pauseText: "Tasks started from now on get no browser checks. A task whose plan is already approved keeps its checks. Your setup and approval stay as they are, and you can resume any time.", keepOn: "Keep it on",
  // a change beside the approved setup
  changeWaitingTitle: "A change is waiting for approval.",
  changeFoundRepo: "Rovara found a change in your repo", changeFoundChoices: "A change to proof and limits is not approved yet",
  newKinds: (kinds: string[]) => `a new kind of user, ${kinds.join(", ")}`, removedKinds: (kinds: string[]) => `${kinds.join(", ")} no longer declared`,
  newerKeeps: "Until you approve it, browser checks keep using the approved version.",
  newerMaySkip: "Until you approve it, browser checks keep using the approved version. A change to how the app starts or signs in may stop checks from running until it is approved.",
  newerCheck: "Check the setup to approve it.", newMark: "(new)",
  // faults
  sandboxTitle: "Rovara can't start the test sandbox right now.", sandboxText: "What you set here is kept. Try again in a few minutes.",
  accountsFaultTitle: "Rovara couldn't refresh this project's test accounts.", accountsFaultText: "Browser checks can't sign in until it does. Try again in a few minutes.",
  unreadableApprovedTitle: "Rovara can't read the approved setup just now.", unreadableApprovedText: "Try again in a minute.",
  // writes
  sending: "Sending…",
  refusedNothingSent: "Rovara couldn't confirm who you are just now, so nothing was sent. Try again.",
  rereadFailed: "Rovara couldn't read this project's browser testing just now, so nothing was sent. Try again.",
  sendFailed: "That couldn't be done just now. Try again.",
  unknownTitle: "Rovara didn't hear back about that change.", unknownText: "It may or may not have gone through. Check what Rovara has now before you try again.", checkNow: "Check", checkedNow: "Checked. This is what Rovara has now.",
  // checklist row
  rowTitle: "Browser testing",
  rowNone: "Rovara starts your app in a sandbox and tries each change in a real browser, using what your repo says about how the app starts and which users it has. An owner or admin approves.",
  rowSetUp: "Set up browser testing", rowOpen: "Open browser testing", rowReview: "Review and approve", rowReviewChange: "Review the change", rowContinue: "Continue setting up",
  rowChecked: (when: string) => `Checked ${when}. Waiting for an owner or admin to approve.`,
  rowOn: (when: string, kinds: string[]) => `On since ${when}. ${kinds.length === 0 ? "Rovara tests signed-out pages." : `Rovara signs in as ${kinds.join(" and ")}, with a fresh test login for each check.`}`,
  rowOnNoDate: (kinds: string[]) => `On. ${kinds.length === 0 ? "Rovara tests signed-out pages." : `Rovara signs in as ${kinds.join(" and ")}, with a fresh test login for each check.`}`,
  rowNewer: (when: string) => `On with the version approved ${when}. A change is waiting for approval.`, rowNewerUnchecked: (when: string) => `On with the version approved ${when}. Rovara found a change that needs checking and approving.`,
  rowPaused: "Paused. Tasks started from now on get no browser checks.",
  rowDraft: "Set up is started. Check the setup, then an owner or admin approves.", rowChecking: "Rovara is checking the setup.", rowFailed: "The last check of the setup failed.",
  rowFault: "Something needs attention. Open the page to see what.",
} as const;

/** The fixed sentences a refusal may reach the person in are the contract's; the rest of a failure is one line. */
export { BROWSER_TESTING_SENTENCES } from "@agentx/contracts/web";
