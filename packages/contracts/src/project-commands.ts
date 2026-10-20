// How a project's repository and its typed setup and test commands become a project definition: shared by the CLI's
// `project add` and the control plane's project creation for a cloud org, so both read a command the same way.
import { agentXError } from "./errors.js";
import type { ProjectCommand } from "./project.js";

/** Seconds a setup command may run (the proposal's and a typed command's alike). */
export const SETUP_TIMEOUT = 900;
/** Seconds a test (readiness) command may run. */
export const TEST_TIMEOUT = 1800;
export function agentxRepositoryName(githubName: string): string {
  const cleaned = githubName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return /^[a-z]/.test(cleaned) ? cleaned : `repo-${cleaned}`.slice(0, 63);
}

export function parseCommandLine(line: string, cwd: string, timeoutSeconds: number): ProjectCommand {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const character of line.trim()) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined; else current += character;
    } else if (character === '"' || character === "'") {
      quote = character; started = true;
    } else if (/\s/.test(character)) {
      if (started) { words.push(current); current = ""; started = false; }
    } else {
      current += character; started = true;
    }
  }
  if (quote !== undefined) throw agentXError("CONFIG_INVALID", "the command has an unclosed quote");
  if (started) words.push(current);
  if (words.length === 0) throw agentXError("CONFIG_INVALID", "the command is empty");
  if (words.some((word) => ["&&", "||", "|", ";"].includes(word))) {
    throw agentXError("CONFIG_INVALID", "a command runs one program; put && , | and ; steps in a script or Makefile target and call that");
  }
  const [executable, ...args] = words as [string, ...string[]];
  return { cwd, executable, args, timeoutSeconds };
}

