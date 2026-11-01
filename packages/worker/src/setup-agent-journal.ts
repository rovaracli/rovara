// Setup agent (design setup-test-health 3.2, task SH8): the journal and the governor. The journal records every command the run ran (the live view and the evidence on the confirm card); the governor
// holds the run to its limits and is where the money, time and attempt bounds are enforced IN CODE, whatever the model does:
//   - commands in all: the next command after the limit is not run, and the run ends `attempts_used`;
//   - tries of the same failing step: a further try of a step that already failed that many times, with nothing changed in between, ends the run `attempts_used`;
//   - wall clock (not counting the time spent parked on a host nobody has answered yet): a deadline timer ends the run `time_used` even while the model is only thinking, and no command is given more
//     time than is left;
//   - model spend: read from the session at every check, and a spend that cannot be read is treated as used up (fail closed); the run ends `budget_used`;
//   - new host asks: one more than the limit ends the run `hosts_waiting`, and so does a host ask that nobody answered in 24 hours;
//   - the first reason wins and is final; when two limits are met at once the order is money, time, attempts, hosts, so the same facts always give the same word.
// A limit stop keeps everything learned: `finishStoppedRun` reads whatever proposal block the model had given (and what the folders show), and the journal lists the commands that worked.
// Nothing here reads a command's output for meaning: the exit code, the time and the command's own words are all it looks at.
import {
  SETUP_AGENT_LIMITS_DEFAULT, SETUP_BLOCKED_HOSTS_MAX, SETUP_JOURNAL_MAX_ENTRIES, SETUP_JOURNAL_TAIL_BYTES, SETUP_HOST_WAIT_MAX_HOURS, SetupAgentLimitsSchema, SetupHostSchema, SetupJournalEntrySchema, SetupRunSummarySchema,
  oneLineText, type SetupAgentLimits, type SetupJournalEntry, type SetupProposal, type SetupRunEndWord, type SetupRunSummary,
} from "@agentx/contracts";
import type { SetupAgentHooks, SetupCommandDecision, SetupCommandRecord } from "./setup-agent.js";
import { readSetupProposalAnswer, type SetupDraftRepository } from "./setup-draft.js";

const MINUTE_MS = 60_000;
const COMMAND_CHARS = 2_000;

/** Whole cents from the dollars a session reports; undefined when the figure cannot be trusted (not a finite, non-negative number). Rounds up, so a part of a cent is a cent. */
export function centsFromDollars(dollars: unknown): number | undefined {
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0 || dollars > 1_000_000) return undefined;
  return Math.max(0, Math.ceil(dollars * 100 - 1e-9));
}

// ---- what counts as "the same step"

/** Commands that only look: running one is not progress, so it does not clear a step's failed tries. */
const PROBES = new Set(["ls", "cat", "echo", "pwd", "which", "type", "env", "printenv", "head", "tail", "grep", "rg", "find", "wc", "file", "stat", "uname", "id", "whoami", "date", "sleep", "true", "false", "test", "[", "diff", "tree", "du", "df", "ps"]);
const GIT_READS = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "remote", "describe"]);

/** Programs whose first words after the name (leaving out flags) say what step it is: `npm ci`, `uv sync`, `python -m pytest`. */
const SUBCOMMAND_PROGRAMS = new Set(["npm", "pnpm", "yarn", "uv", "pip", "pip3", "poetry", "pipenv", "cargo", "go", "mvn", "gradle", "gradlew", "./gradlew", "./mvnw", "mvnw", "make", "git", "docker", "apt", "apt-get", "bundle", "gem", "dotnet", "brazil-build", "bun", "npx", "python", "python3"]);

function tokensOf(command: string): string[] {
  return command.trim().replace(/\s+/gu, " ").split(" ").filter((token) => token !== "");
}

/**
 * The step a command belongs to: the first command of the line (after a leading `cd <dir> &&` and variable assignments), reduced to its program and, for a program that takes a subcommand, the
 * subcommand and the first thing after it; a trailing `2>&1` and a pipe into `tail`/`head`/`tee` are not part of it. `uv sync --frozen` and `uv sync` are one step; `pytest tests/a` and
 * `pytest tests/b` are two. Lower-case; at most 120 characters.
 */
export function stepKeyOf(command: string): string {
  let text = command.replace(/\s2>&1/gu, " ").replace(/\|\s*(?:tail|head|tee)\b.*$/u, " ");
  text = text.replace(/^\s*cd\s+\S+\s*&&\s*/u, "");
  const first = text.split(/&&|\|\||;|\|/u)[0] ?? text;
  const tokens = tokensOf(first).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
  const program = tokens[0] ?? "";
  const rest = tokens.slice(1);
  const parts = SUBCOMMAND_PROGRAMS.has(program) ? [program, ...rest.filter((token) => !token.startsWith("-")).slice(0, 2)] : [program, ...rest.slice(0, 1)];
  return parts.join(" ").toLowerCase().slice(0, 120);
}

/** True for a command that only looks at things. */
export function isProbeCommand(command: string): boolean {
  const key = stepKeyOf(command);
  const [program, sub] = key.split(" ");
  if (program === undefined) return true;
  if (program === "git") return GIT_READS.has(sub ?? "");
  if (/(^|\s)(--version|-v|-V|--help|-h)(\s|$)/u.test(command) && command.length < 80) return true;
  return PROBES.has(program);
}

// ---- the governor and the journal

export interface SetupGovernorInput {
  limits: SetupAgentLimits;
  /** A millisecond clock. Default: `Date.now`. */
  now?: () => number;
  /** The model spend so far, in whole cents (`centsFromDollars` of the session's cost); undefined when it cannot be read. Read at every check. */
  spendCents: () => number | undefined;
  /** The hosts the DNS watch (SH9) saw blocked since the last call, cleared by the call. Default: none. */
  takeBlockedHosts?: () => readonly string[];
  /** Called once, when the run must end: the caller aborts the model session. */
  onStop?: (word: SetupRunEndWord) => void;
  /** Called for each journal entry as it is written: the live view. */
  onEntry?: (entry: SetupJournalEntry) => void;
  /** Test seam for the deadline timer. Default: `setTimeout`, unref'd. */
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
}

/** What a run learned, for a partial proposal and the confirm card: the commands that worked, by journal position. Download-and-run commands are never listed. */
export interface LearnedCommand { n: number; command: string }

export class SetupAgentGovernor implements SetupAgentHooks {
  private readonly limits: SetupAgentLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly journal: SetupJournalEntry[] = [];
  private readonly failures = new Map<string, number>();
  private readonly hosts = new Set<string>();
  private parkedAt: number | undefined;
  private parkedTotalMs = 0;
  private stopped: SetupRunEndWord | undefined;
  private timer: { cancel(): void } | undefined;

  constructor(private readonly input: SetupGovernorInput) {
    // The limits are read through the contract's own bounds: a number that is not a whole number from 1 up to the maximum (a NaN would never be reached) does not start a run.
    this.limits = SetupAgentLimitsSchema.parse(input.limits);
    this.now = input.now ?? Date.now;
    this.startedAt = this.now();
    this.armDeadline();
  }

  // ---- state

  /** Why the run ended, once it has; undefined while it can go on. */
  ended(): SetupRunEndWord | undefined {
    return this.stopped;
  }

  entries(): readonly SetupJournalEntry[] {
    return this.journal.map((entry) => ({ ...entry, blockedHosts: [...entry.blockedHosts] }));
  }

  /** The milliseconds of the run so far, without the time spent parked on host asks. */
  elapsedMs(): number {
    const parked = this.parkedTotalMs + (this.parkedAt === undefined ? 0 : this.now() - this.parkedAt);
    return Math.max(0, this.now() - this.startedAt - parked);
  }

  /** The seconds of wall clock left (at least 0). */
  secondsLeft(): number {
    return Math.max(0, Math.floor((this.limits.wallClockMin * MINUTE_MS - this.elapsedMs()) / 1_000));
  }

  /** Cuts the timer. Safe to call again. */
  dispose(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  // ---- stopping

  /** Ends the run with `word`, once: the first reason is final. Cuts the deadline timer and tells the caller. */
  stop(word: SetupRunEndWord): void {
    if (this.stopped !== undefined) return;
    this.stopped = word;
    this.dispose();
    this.input.onStop?.(word);
  }

  /**
   * Looks at every limit that does not need a command, and stops the run with the first one that is used up (money, time, commands, in that order). Called before each command, when the model's
   * usage changes, and by the deadline timer. Returns the word when the run has ended.
   */
  check(): SetupRunEndWord | undefined {
    if (this.stopped !== undefined) return this.stopped;
    const spend = this.input.spendCents();
    if (spend === undefined || spend >= this.limits.budgetCents) this.stop("budget_used");
    else if (this.elapsedMs() >= this.limits.wallClockMin * MINUTE_MS) this.stop("time_used");
    else if (this.waitedOnHostsTooLong()) this.stop("hosts_waiting");
    return this.stopped;
  }

  // ---- the shell's hooks (setup-agent.ts)

  beforeCommand(command: string): SetupCommandDecision {
    if (this.check() !== undefined) return { allow: false };
    const agentCommands = this.journal.filter((entry) => entry.source === "agent").length;
    if (agentCommands >= this.limits.commands || this.journal.length >= SETUP_JOURNAL_MAX_ENTRIES) { this.stop("attempts_used"); return { allow: false }; }
    // A further try of a step that already failed this many times with nothing changed in between.
    if ((this.failures.get(stepKeyOf(command)) ?? 0) >= this.limits.sameStepTries) { this.stop("attempts_used"); return { allow: false }; }
    return { allow: true };
  }

  maxTimeoutSeconds(): number {
    return this.secondsLeft();
  }

  afterCommand(record: SetupCommandRecord): void {
    this.append("agent", record);
    const key = stepKeyOf(record.command);
    if (record.exitCode === 0 && !record.timedOut) {
      this.failures.delete(key);
      // A command that changed something is progress: the other steps get their tries back. A command that only looked is not.
      if (!isProbeCommand(record.command)) this.failures.clear();
    } else {
      this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    }
    this.check();
  }

  /** The shell found the repositories changed (setup-agent.ts). */
  onEnded(word: "changed_repository_files"): void {
    this.stop(word);
  }

  // ---- a person's command (SH13), recorded with the same bounds

  /** Records a command a person typed (it ran in the setup sandbox; it is shown to the agent as a result, not an instruction). It does not use the agent's command limit, and it cannot overflow the journal. */
  recordPersonCommand(record: SetupCommandRecord): SetupJournalEntry | undefined {
    return this.append("person", record);
  }

  // ---- host asks

  /**
   * A host the run needs. A name that is not a plain DNS name is `invalid` (and is not counted; the host-ask card refuses it). The same host again is `duplicate`. A new host over the limit ends the
   * run `hosts_waiting`.
   */
  requestHost(host: string): "new" | "duplicate" | "invalid" | "stopped" {
    if (this.stopped !== undefined) return "stopped";
    if (!SetupHostSchema.safeParse(host).success) return "invalid";
    if (this.hosts.has(host)) return "duplicate";
    if (this.hosts.size >= this.limits.hostAsks) { this.stop("hosts_waiting"); return "stopped"; }
    this.hosts.add(host);
    return "new";
  }

  /** Nothing else is left to do and a host ask is open: the run parks. The wall clock stops while it is parked; 24 hours parked ends the run `hosts_waiting`. */
  parkOnHosts(): void {
    if (this.stopped !== undefined || this.parkedAt !== undefined) return;
    this.parkedAt = this.now();
    this.armDeadline();
  }

  /** An admin answered (or the run has other work): the wall clock runs again. */
  resumeFromHosts(): void {
    if (this.parkedAt === undefined) return;
    this.parkedTotalMs += this.now() - this.parkedAt;
    this.parkedAt = undefined;
    this.armDeadline();
  }

  private waitedOnHostsTooLong(): boolean {
    return this.parkedAt !== undefined && this.now() - this.parkedAt >= SETUP_HOST_WAIT_MAX_HOURS * 3_600_000;
  }

  // ---- the deadline

  private armDeadline(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped !== undefined) return;
    const ms = this.parkedAt === undefined
      ? this.limits.wallClockMin * MINUTE_MS - this.elapsedMs()
      : SETUP_HOST_WAIT_MAX_HOURS * 3_600_000 - (this.now() - this.parkedAt);
    const set = this.input.setTimer ?? ((callback, wait) => { const handle = setTimeout(callback, wait); handle.unref(); return { cancel: () => { clearTimeout(handle); } }; });
    this.timer = set(() => {
      // A timer that fires early (the clock moved) checks again rather than ending the run on its word.
      if (this.parkedAt !== undefined) { if (this.waitedOnHostsTooLong()) this.stop("hosts_waiting"); }
      else if (this.elapsedMs() >= this.limits.wallClockMin * MINUTE_MS) this.stop("time_used");
      else this.armDeadline();
    }, Math.max(1, Math.min(ms, 2_147_000_000)));
  }

  // ---- the journal

  private append(source: "agent" | "person", record: SetupCommandRecord): SetupJournalEntry | undefined {
    if (this.journal.length >= SETUP_JOURNAL_MAX_ENTRIES) return undefined;
    const hosts = [...new Set(this.input.takeBlockedHosts?.() ?? [])].filter((host) => SetupHostSchema.safeParse(host).success).slice(0, SETUP_BLOCKED_HOSTS_MAX);
    const parsed = SetupJournalEntrySchema.safeParse({
      n: this.journal.length + 1,
      source,
      command: oneLineText(record.command, COMMAND_CHARS) || "(empty command)",
      exitCode: record.exitCode === null ? null : Math.max(-1, Math.min(255, Math.trunc(record.exitCode))),
      durationMs: Math.max(0, Math.min(7_200_000, Math.round(record.durationMs))),
      timedOut: record.timedOut,
      flagged: record.flagged,
      blockedHosts: hosts,
      tail: record.tail.slice(0, SETUP_JOURNAL_TAIL_BYTES),
      startedAt: new Date(Number.isFinite(record.startedAt) ? record.startedAt : this.now()).toISOString(),
    });
    if (!parsed.success) return undefined;
    this.journal.push(parsed.data);
    this.input.onEntry?.(parsed.data);
    return parsed.data;
  }

  /** The commands that exited 0 and do not download code, in order: what the partial proposal and the confirm card cite as "worked when run". */
  learned(): LearnedCommand[] {
    return this.journal.filter((entry) => entry.source === "agent" && entry.exitCode === 0 && !entry.timedOut && !entry.flagged && !isProbeCommand(entry.command)).map((entry) => ({ n: entry.n, command: entry.command }));
  }

  /** The run's report. A limit stop, a person's stop, a changed repository and an infrastructure fault are partial; `proposed` and `needs_code_change` are not. */
  summary(): SetupRunSummary {
    const stop: SetupRunEndWord = this.stopped ?? "proposed";
    const spend = this.input.spendCents();
    return SetupRunSummarySchema.parse({
      stop,
      commandsRun: this.journal.length,
      spendCents: Math.min(1_000_000, spend ?? this.limits.budgetCents),
      elapsedMs: Math.min(24 * 3_600_000, Math.round(this.elapsedMs())),
      hostAsks: this.hosts.size,
      partial: stop !== "proposed" && stop !== "needs_code_change",
    });
  }
}

/** The limits a caller uses when it has none to pass (the contract's defaults). */
export const SETUP_GOVERNOR_DEFAULT_LIMITS: SetupAgentLimits = SETUP_AGENT_LIMITS_DEFAULT;

// ---- a run that stopped early keeps what it learned

export interface StoppedRunResult {
  end: SetupRunEndWord;
  summary: SetupRunSummary;
  /** The proposal read from the last block the model gave, with what the folders show; undefined when there is neither. */
  proposal: SetupProposal | undefined;
  learned: LearnedCommand[];
}

/**
 * A run that ended before the model's final answer (a limit, a person's stop, a fault): reads whatever the model last said as a proposal block (and the folders' own findings), and adds the commands
 * that worked. It is never an error to have little: a run with nothing readable returns no proposal, a summary that says `partial`, and the journal. The proposal is the same bounded, cited, redacted
 * object a finished run gives; its commands are only what the model cited.
 */
export async function finishStoppedRun(input: {
  governor: SetupAgentGovernor;
  lastText: string;
  basedOnRevision: number;
  rootPath: string;
  repositories: ReadonlyArray<SetupDraftRepository>;
  metaRepo?: string | undefined;
}): Promise<StoppedRunResult> {
  const summary = input.governor.summary();
  const read = await readSetupProposalAnswer(input.lastText, {
    basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories: input.repositories, ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }),
  }).catch(() => ({ ok: false as const, errors: ["unreadable"] }));
  return { end: summary.stop, summary, proposal: read.ok ? read.proposal : undefined, learned: input.governor.learned() };
}
