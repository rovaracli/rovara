// The setup run, worker side (sh-setup-wire, SH14; design setup-test-health 3.1 to 3.4): puts the parts together. Called by `run-task.ts` in ONE early hunk for `workflowMode: "SETUP_AGENT"`, when the broker
// (switch `su`) sent the run and this worker lists "task.setupAgent.v1". Everything that touches the outside (Docker, the model session, the broker) is a port, so the whole run is tested without any of them.
//
// What this module guarantees (each is a test):
//   - ED-1: the repositories are read at the commit the BROKER resolved for the project's default branch (the preparation manifest), never a ref or SHA from the invocation; a workspace that has a pull request
//     head checked out is refused. `checkTrackedFiles` is given the manifest's directories, never a path from task input.
//   - the sandbox is the setup sandbox (guarded Docker seam, no secret), on the run's own network with the DNS-watch helper (option A); the worker itself is never on that network;
//   - the agent's shell and a person's command share ONE serialized base, so they never run at once, and a person's command goes through the same shell rules (time limit, tail, tracked-file check);
//   - the model session is sequential, output-capped and watched by the governor on every turn, with the next turn's most cost passed in (`nextTurnCents`, required);
//   - the journal, host asks and person commands travel over the broker's one setup callback; the requester of an ask is never sent (the broker knows who started the run);
//   - at the end the sandbox is removed (which kills every process in it) BEFORE the last tracked-files check, and that last verdict is what `finishSetupAgent` / `finishStoppedRun` use;
//   - a repository with a nested repository or LFS files, or a project whose setup rewrites a tracked file, ends the run `changed_repository_files` with no proposal (the person is told, by the broker's fixed words).
// NOT in this module (listed in the lane report): parking on open host asks, the in-run fresh Prove (the confirm card's Prove is the broker's own, on a workspace it prepares anew), and the test-environment
// merge of the agent's findings.
import { resolve } from "node:path";
import {
  SetupRunSummarySchema, agentXError, effectiveSetupAgentLimits, type SetupAgentLimits, type SetupJournalEntry, type SetupProposal, type SetupRunSummary,
} from "@agentx/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { checkTrackedFiles, finishSetupAgent, setupAgentShell, setupAgentSessionParts, type SetupAgentRepository, type SetupCommandRecord, type TrackedFilesVerdict } from "./setup-agent.js";
import { SETUP_AGENT_MAX_OUTPUT_TOKENS, SetupAgentGovernor, centsFromDollars, estimateNextTurnCents, finishStoppedRun, governorSessionListener } from "./setup-agent-journal.js";
import { setupAgentInstructions } from "./setup-agent-prompt.js";
import { createPersonCommandRunner } from "./setup-command-runner.js";
import type { PiSessionHandle } from "./pi-session.js";
import type { RunNetwork } from "./setup-network.js";
import type { TaskSandbox } from "./task-sandbox.js";

/** A ceiling for the next model turn's price, dollars per million tokens: above the list price of the models a setup run uses, so the governor stops BEFORE a turn could cross the budget. */
export const SETUP_AGENT_PRICE_CEILING = { inputPerMTok: 6, outputPerMTok: 30 } as const;

/** What the preparation manifest says about a repository (the broker's own record of the default branch's head). */
export interface SetupManifestRepository { name: string; path: string; resolvedCommit: string; checkedOut?: unknown }

export interface SetupRunPorts {
  /** The run's own network and helper (setup-network.ts `startRunNetwork` in production). */
  startNetwork(): Promise<RunNetwork>;
  /** The setup sandbox on that network, with the helper as its only DNS server (`createSetupSandbox` in production). */
  createSandbox(network: RunNetwork): TaskSandbox;
  /** Opens the model session with the parts the setup run needs. */
  openSession(parts: ReturnType<typeof setupAgentSessionParts>): Promise<PiSessionHandle>;
  /** The broker's setup callback (`POST .../setup-agent`). Throws on a refusal. */
  callback(body: unknown): Promise<unknown>;
  /** Where the run is visible while it goes (progress lines); fixed words only. */
  progress(message: string): Promise<void>;
  /** Registers the run so a cancel aborts it and a live message reaches the model. Returns the unregister. */
  register(control: { abort(): Promise<void>; steer(text: string): Promise<boolean>; streaming(): boolean }): () => void;
  /** The tracked-files check (`checkTrackedFiles` in production). */
  checkFiles?: (repositories: ReadonlyArray<SetupAgentRepository>) => Promise<TrackedFilesVerdict>;
  now?: () => number;
  /** How often the run talks to the broker. Default 3 s. */
  tickMs?: number;
}

export interface SetupRunInput {
  rootPath: string;
  operationId: string;
  basedOnRevision: number;
  limits: SetupAgentLimits;
  repositories: readonly SetupManifestRepository[];
  metaRepo?: string | undefined;
  ports: SetupRunPorts;
}

export interface SetupRunResult {
  workflowMode: "SETUP_AGENT";
  setupProposal?: SetupProposal;
  setupRunSummary: SetupRunSummary;
}

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * Runs `base` one command at a time: a second `exec` waits for the first to end. The agent's shell and a person's command both run through the same serialized base, so two commands never share the
 * sandbox at once (the tracked-files check after each would otherwise see the other's half-done work).
 */
export function serialize(base: BashOperations, after?: () => Promise<void>): BashOperations {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exec(command, cwd, options) {
      const run = tail.then(async () => {
        try { return await base.exec(command, cwd, options); } finally { await after?.().catch(() => undefined); }
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** The repositories of the run, from the manifest only. A workspace with a pull request head checked out, or a commit that is not a full hash, is refused: the run reads the default branch's head and nothing else (ED-1). */
export function setupRepositoriesOf(rootPath: string, manifest: readonly SetupManifestRepository[]): SetupAgentRepository[] {
  if (manifest.length === 0) throw agentXError("CONFIG_INVALID", "a setup run needs a prepared repository");
  return manifest.map((repository) => {
    if (repository.checkedOut !== undefined) throw agentXError("CONFIG_INVALID", "a setup run reads the default branch only, never a pull request head");
    if (!COMMIT.test(repository.resolvedCommit)) throw agentXError("CONFIG_INVALID", "a setup run needs the commit the broker resolved");
    return { name: repository.name, path: repository.path, resolvedCommit: repository.resolvedCommit, directory: resolve(rootPath, repository.path) };
  });
}

export async function runSetupAgent(input: SetupRunInput): Promise<SetupRunResult> {
  const { ports } = input;
  const now = ports.now ?? Date.now;
  const limits = effectiveSetupAgentLimits(input.limits);
  const repositories = setupRepositoriesOf(input.rootPath, input.repositories);
  const checkFiles = ports.checkFiles ?? ((list) => checkTrackedFiles(list));
  const lastFiles = (): Promise<TrackedFilesVerdict> => checkFiles(repositories);

  let session: PiSessionHandle | undefined;
  let finalText = "";
  let lastInputTokens = 20_000;
  const pendingEntries: SetupJournalEntry[] = [];
  const seenHosts = new Set<string>();
  const told = new Set<string>();
  let blocked: string[] = [];
  let delivered: string[] = [];
  let personSeq: number | undefined;
  /** The command place of each journal entry a person's command wrote (so a website it hit is asked for with the command's place, from which the broker finds who typed it). */
  const seqOfEntry = new Map<number, number>();

  const network = await ports.startNetwork();
  let sandbox: TaskSandbox | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let unregister: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    sandbox = ports.createSandbox(network);
    const refreshBlocked = async (): Promise<void> => { blocked = await network.readBlocked(); };
    const base = serialize(sandbox.bashOperations(), refreshBlocked);
    const governor = new SetupAgentGovernor({
      limits, now,
      spendCents: () => (session === undefined ? 0 : centsFromDollars(session.getSessionStats().cost)),
      nextTurnCents: () => estimateNextTurnCents({ inputTokens: lastInputTokens, maxOutputTokens: SETUP_AGENT_MAX_OUTPUT_TOKENS, ...SETUP_AGENT_PRICE_CEILING }),
      // The names the helper saw refused since the last entry: from the helper's file, never from any output.
      takeBlockedHosts: () => { const fresh = blocked.filter((name) => !delivered.includes(name)); delivered = [...delivered, ...fresh]; return fresh; },
      onStop: () => { void session?.abort().catch(() => undefined); },
      onEntry: (entry) => { pendingEntries.push(entry); if (entry.source === "person" && personSeq !== undefined) seqOfEntry.set(entry.n, personSeq); },
    });
    const shell = setupAgentShell({ base, hooks: governor, checkFiles: lastFiles });
    const runner = createPersonCommandRunner({
      base, cwd: resolve(input.rootPath), checkFiles: lastFiles, alive: () => governor.ended() === undefined,
      maxTimeoutSeconds: () => governor.secondsLeft(), onEnded: (word) => governor.onEnded(word),
      record: (record: SetupCommandRecord) => governor.recordPersonCommand(record),
      tellAgent: async (text) => (session?.steer === undefined || session.isStreaming?.() !== true ? false : (await session.steer(text), true)),
      report: async (done) => { await ports.callback({ kind: "command_done", seq: done.seq, ...(done.journalN === undefined ? {} : { journalN: done.journalN }) }); personSeq = undefined; },
    });
    session = await ports.openSession(setupAgentSessionParts({ sandbox, shell }));
    unsubscribe = session.subscribe((event) => {
      governorSessionListener(governor)(event);
      const message = (event as { type?: unknown; message?: { role?: unknown; content?: unknown; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } }).message;
      if ((event as { type?: unknown }).type === "message_end" && message?.role === "assistant") {
        finalText = textOf(message.content) ?? finalText;
        const used = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0);
        if (used > 0) lastInputTokens = used;
      }
    });
    unregister = ports.register({
      abort: async () => { governor.stop("infrastructure"); await session?.abort(); },
      steer: async (text) => (session?.steer === undefined || session.isStreaming?.() !== true ? false : (await session.steer(text), true)),
      streaming: () => session?.isStreaming?.() === true,
    });

    // ---- the run's talk with the broker, every few seconds: journal, host asks, a person's command, answers.
    let talking = false;
    const talk = async (): Promise<void> => {
      if (talking) return;
      talking = true;
      try {
        while (pendingEntries.length > 0) {
          const batch = pendingEntries.slice(0, 20);
          await ports.callback({ kind: "journal", entries: batch });
          pendingEntries.splice(0, batch.length);
          for (const entry of batch) {
            for (const host of entry.blockedHosts) {
              if (seenHosts.has(host)) continue;
              seenHosts.add(host);
              if (governor.requestHost(host) === "new") {
                await ports.callback({ kind: "host", host, journalN: entry.n, ...(seqOfEntry.get(entry.n) === undefined ? {} : { viaCommandSeq: seqOfEntry.get(entry.n)! }) });
              }
            }
          }
        }
        const polled = await ports.callback({ kind: "poll" }) as { command?: { seq: number; command: string }; hosts?: Array<{ host: string; state: string }> };
        for (const answer of polled.hosts ?? []) {
          if (answer.state === "approved" && !told.has(answer.host)) {
            told.add(answer.host);
            await session?.steer?.(`Rovara note: an admin allowed the website ${answer.host} for this project. Rovara staff may still need to approve it, so it may not work for a few minutes.`).catch(() => undefined);
          }
        }
        if (polled.command !== undefined) { personSeq = polled.command.seq; void runner.run(polled.command); }
      } catch {
        // A broker that cannot be reached for one tick is tried again at the next; the run goes on.
      } finally {
        talking = false;
      }
    };
    tick = setInterval(() => { void talk(); }, ports.tickMs ?? 3_000);
    tick.unref?.();

    await ports.progress("The setup run started.");
    let failed = false;
    try {
      await session.prompt(setupAgentInstructions({ repositories, limits, ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }) }));
    } catch {
      failed = true;
    }
    clearInterval(tick);
    tick = undefined;
    await runner.settled();
    if (failed && governor.ended() === undefined) governor.stop("infrastructure");

    // ---- the end. Order matters: every process in the sandbox is killed (the container is removed) BEFORE the last look at the tracked files.
    governor.dispose();
    await sandbox.dispose();
    const verdict = await lastFiles();
    let proposal: SetupProposal | undefined;
    let summary: SetupRunSummary;
    if (governor.ended() === undefined && shell.ended() === undefined) {
      const finished = await finishSetupAgent({
        finalText, verdict, basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories,
        ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }),
        records: governor.entries().filter((entry) => entry.source === "agent"),
      });
      if (finished.ok) {
        proposal = finished.proposal;
        summary = SetupRunSummarySchema.parse({ ...governor.summary(), stop: finished.end, partial: false });
      } else {
        if (finished.end === "changed_repository_files") governor.onEnded("changed_repository_files"); else governor.stop("infrastructure");
        summary = governor.summary();
      }
    } else {
      const stopped = await finishStoppedRun({
        governor, trackedFiles: verdict, shell, lastText: finalText, basedOnRevision: input.basedOnRevision, rootPath: input.rootPath, repositories,
        ...(input.metaRepo === undefined ? {} : { metaRepo: input.metaRepo }),
      });
      proposal = stopped.proposal;
      summary = stopped.summary;
    }
    // What is left unsent goes now, once; the broker keeps the first entry for a position.
    await flushLast(ports, pendingEntries);
    return { workflowMode: "SETUP_AGENT", ...(proposal === undefined ? {} : { setupProposal: proposal }), setupRunSummary: summary };
  } finally {
    if (tick !== undefined) clearInterval(tick);
    unsubscribe?.();
    unregister?.();
    session?.dispose();
    await sandbox?.dispose().catch(() => undefined);
    await network.stop().catch(() => undefined);
  }
}

async function flushLast(ports: SetupRunPorts, entries: SetupJournalEntry[]): Promise<void> {
  while (entries.length > 0) {
    const batch = entries.slice(0, 20);
    try { await ports.callback({ kind: "journal", entries: batch }); } catch { return; }
    entries.splice(0, batch.length);
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
  return parts.length === 0 ? undefined : parts.join("\n");
}
