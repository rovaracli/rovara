// The Setup screen's fixed words for a setup run. The server's own sentences (a failure, a refusal) are shown as they come; these are for what the page itself says.
import type { SetupAgentView } from "@agentx/contracts/web";

export const STOP_WORDS: Record<NonNullable<SetupAgentView["stop"]>, string> = {
  proposed: "Rovara finished and has a setup for you to look at.",
  attempts_used: "Rovara used up the commands it was allowed. The commands it ran are below.",
  time_used: "Rovara ran out of time. The commands it ran are below.",
  budget_used: "Rovara used up its budget for this run. The commands it ran are below.",
  // The fallback when the cause is not known (no address list was read, or an older Code): true for every cause. The cause-specific words are `hostsStopWords`.
  hosts_waiting: "Rovara ended the run because of the addresses it needed: it reached a limit on address requests or on waiting, or an address decision was still open.",
  stopped_by_person: "The run was stopped.",
  needs_code_change: "The project needs a change in its code before it can be set up.",
  changed_repository_files: "A command changed the project's files, so the run ended.",
  infrastructure: "The run could not go on because of a problem on Rovara's side.",
};

export const VERDICT_WORDS = {
  verified: "Matches the code",
  unchecked: "Not checked against a file",
  unverified: "Does not match the code",
} as const;

/** A command row that does not match the code, on both "use this setup" cards. The check is "the command is not in the lines Rovara quoted", never "it is nowhere in the project" (DEC 540). */
export const MISMATCH_WORDS = {
  before: "Does not match the code: Rovara could not find ", after: " in the lines it quoted.",
  misread: "Rovara misread your files: the lines it quoted for this row are not in them, so it can't be used as it is.",
  runAgain: "Run setup again", changeCommand: "Change a command", changeLocked: "Changing a command is not available yet.",
  useAnyway: "Rovara could not find this command in the lines it quoted; tick to use it anyway.",
  chosenAnyway: "You chose to use this although it does not match the code. The second machine still checks it.",
  tickOne: "Tick at least one command to check this setup.", tickOneUse: "Tick at least one command to use this setup.",
} as const;

export const CONFIRM_WORDS = {
  rule: "Using this setup saves it as a proposal in the test environment below; it does not change the project's settings. You approve it there, after a passing proof.",
  next: "Saved as a proposal. In the test environment below, run its check, prove it, then approve it; approving adds the commands to the settings.",
  checking: "Rovara is still checking where each suggestion came from.",
  leftOut: { unverified: "left out: it does not match the code", refused_command: "left out: it downloads and runs code, or holds a secret", not_a_command_item: "left out: not a command", too_many: "left out: too many commands", invalid_command: "left out: it could not be read as a command" },
} as const;

export const PARTIAL_WORDS = {
  heading: "What Rovara had when it was stopped",
  rule: "This is only what Rovara had so far. It is not proven and nothing was applied. To use a setup, run it again and let it finish.",
  none: "Rovara had no setup to show yet.",
} as const;

/** The approval card's fixed words (L4-D2, DEC 254z b). The server's own refusals are shown as they come (they are Cloud's fixed sentences). */
export const APPROVAL_WORDS = {
  heading: "Use this setup?",
  risk: { low: "Low risk", medium: "Medium risk", high: "High risk" },
  why: {
    low: "It only changes the commands that set up and test the project.",
    medium: "It changes test mocks, the stand-in services the tests use.",
    highUnknown: "Rovara could not tell what it changes, so it is treated as high risk.",
  },
  area: { setup_commands: "setup commands", test_commands: "test commands", test_mocks: "test mocks", prompt_locations: "where the AI prompts live", websites: "allowed addresses", registries: "package registries", integrations: "integrations", dev_container: "the dev container", other: "something Rovara does not recognise" },
  /** A command used with no file evidence behind it (a ticked row that did not match, or one that could not be checked against a file). The check on a fresh workspace and this approval still apply. */
  withoutMatch: { tag: "Not matched to the code", summary: (n: number) => `${String(n)} ${n === 1 ? "command was" : "commands were"} used without a match in the lines Rovara quoted. They are tagged under Details.` },
  who: { maintainer: "A project maintainer, or a company owner or admin, approves this.", admin: "A company owner or admin approves high-risk changes." },
  check: {
    checking: "Rovara is checking it on a fresh workspace. This can take a few minutes.",
    ready: "Passed on a fresh workspace.",
    failed: "The check on a fresh workspace failed. Nothing was applied.",
    stale: "The check has not run on this setup yet.",
  },
  approved: "Approved. The project now uses this setup.",
  rejected: "Rejected. The project keeps its current setup.",
  discarded: "Discarded. The project keeps its current setup.",
  moved: "This setup changed or is no longer waiting.",
} as const;

/** The checklist's Setup run row while a setup of Rovara's waits for a person (L4-T1, G1): what the row says, and what a person who may not decide reads. */
export const REVIEW_WORDS = {
  review: "Needs you: review the setup",
  checking: "Checking on a fresh machine",
  approve: "Needs you: approve",
  /** What "Use this setup" says on the checklist, where the check starts by itself and the approval is on the same card (the Setup step's words point at a test environment section the checklist doesn't have). */
  confirmRule: "Using this setup saves it as a proposal and checks it on a fresh machine. It does not change the project's settings. You approve it here once the check has passed.",
  confirmNext: "Saved as a proposal. Rovara is checking it on a fresh machine. When the check passes, approve it here.",
  readOnly: "Rovara has a setup waiting. A project admin, or a company owner or admin, reviews and approves it.",
} as const;

/**
 * Why a run that stopped on addresses (`stop: "hosts_waiting"`) stopped, in words that are true for THAT cause (rule #14). Code's one stop word covers two causes: an address decision still open (nobody answered
 * the ask), and a limit reached (too many address requests for one run, or the longest wait on a decision). The cause is read from the run's address requests (the journal reply's `hostAsks`, the same list Code's
 * own page uses): one still `open` is a decision waiting; none open means the run ended on a limit and nothing is waiting now. When the list was not read (an older Code, or a read that failed) the cause is
 * unknown and the words say only what is true of both.
 */
export const HOSTS_STOP_WORDS = {
  /** Code's own setup page note, word for word (SETUP_OPEN_HOST_NOTE; Code says "address" since pr/setup-address-copy-20261124). */
  decisionOpen: "An address decision is still open: allow it, then run the setup again to include it.",
  limitReached: "Rovara stopped because it reached its limit on address requests or on waiting for a decision. No address decision is open now. Run the setup again to go on.",
  unknown: STOP_WORDS.hosts_waiting,
} as const;
export type HostsStopCause = "decision_open" | "limit_reached" | "unknown";
export function hostsStopCause(asks: readonly { status: string }[] | undefined): HostsStopCause {
  // No list, or an empty one (a run that stopped on addresses asked for at least one): nothing to tell the cause from.
  if (asks === undefined || asks.length === 0) return "unknown";
  return asks.some(ask => ask.status === "open") ? "decision_open" : "limit_reached";
}
export function hostsStopWords(asks: readonly { status: string }[] | undefined): string {
  const cause = hostsStopCause(asks);
  return cause === "decision_open" ? HOSTS_STOP_WORDS.decisionOpen : cause === "limit_reached" ? HOSTS_STOP_WORDS.limitReached : HOSTS_STOP_WORDS.unknown;
}
