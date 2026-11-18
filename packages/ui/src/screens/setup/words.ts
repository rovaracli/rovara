// The Setup screen's fixed words for a setup run. The server's own sentences (a failure, a refusal) are shown as they come; these are for what the page itself says.
import type { SetupAgentView } from "@agentx/contracts/web";

export const STOP_WORDS: Record<NonNullable<SetupAgentView["stop"]>, string> = {
  proposed: "Rovara finished and has a setup for you to look at.",
  attempts_used: "Rovara used up the commands it was allowed. What it learned is below.",
  time_used: "Rovara ran out of time. What it learned is below.",
  budget_used: "Rovara used up its budget for this run. What it learned is below.",
  hosts_waiting: "Rovara was waiting for websites that an administrator has not decided yet.",
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

export const CONFIRM_WORDS = {
  rule: "Using this setup saves it as a proposal in the test environment below; it does not change the project's settings. You approve it there, after a passing proof.",
  next: "Saved as a proposal. In the test environment below, run its check, prove it, then approve it with a fresh sign-in; approving adds the commands to the settings.",
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
  area: { setup_commands: "setup commands", test_commands: "test commands", test_mocks: "test mocks", prompt_locations: "where the AI prompts live", websites: "allowed websites", registries: "package registries", integrations: "integrations", dev_container: "the dev container", other: "something Rovara does not recognise" },
  who: { maintainer: "A project maintainer, or a company owner or admin, approves this.", admin: "A company owner or admin approves high-risk changes." },
  check: {
    checking: "Rovara is checking it on a fresh workspace. This can take a few minutes.",
    ready: "Passed on a fresh workspace.",
    failed: "The check on a fresh workspace failed. Nothing was applied.",
    stale: "The check has not run on this setup yet.",
  },
  stepUp: "Approving or rejecting asks you to confirm it's you first.",
  stepUpDone: "You confirmed it's you. This stays open for a few minutes.",
  stepUpOld: "Your last confirmation is too old. Confirm it's you again, then choose.",
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
  confirmNext: "Saved as a proposal. Rovara is checking it on a fresh machine. When the check passes, approve it here with a fresh sign-in.",
  readOnly: "Rovara has a setup waiting. A project admin, or a company owner or admin, reviews and approves it.",
} as const;
