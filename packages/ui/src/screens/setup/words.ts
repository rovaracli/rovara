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
  next: "Saved as a proposal. Approve it in the test environment below, after a passing proof.",
  checking: "Rovara is still checking where each suggestion came from.",
  leftOut: { unverified: "left out: it does not match the code", refused_command: "left out: it downloads and runs code, or holds a secret", not_a_command_item: "left out: not a command", too_many: "left out: too many commands", invalid_command: "left out: it could not be read as a command" },
} as const;
