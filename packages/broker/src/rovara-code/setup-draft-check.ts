// Setup draft (TE-3, owner decision 2026-11-02, option A): the commands a setup draft puts into a project's settings are PROVED before they are saved. Applying a draft's setup or test commands first runs
// exactly the commands the settings would hold on a fresh, separate workspace (TE-2's candidate check: `org/test-env-candidate.ts`, one stored result per project, digest and settings revision), and the
// commands are written only when that check passed for this digest at the settings revision as it is now. This module is the pure part: the lists a save would store, their digest, the words, and what a
// stored check means for the apply. The apply itself (setup-draft.ts) asks `gateDraftCommands` and saves nothing unless it answers `passed`.
//
// "Exactly the commands that ran": the lists are built by the same function the settings save uses (`settingsCommands`: one program, the first repository's directory, the list's own timeout, no env; a line that is one of the stored commands is that command, with its own timeout and env), a list the
// draft does not touch stays exactly as stored (env and timeout included), and the stored check's lists must be identical to these, field for field. The digest names those lists, so a check proves one list pair
// and nothing else; a changed settings revision is another key (nothing found), so a check never carries over to settings it did not run against.
import { createHash } from "node:crypto";
import { AgentXError, SETUP_TIMEOUT, TEST_TIMEOUT, agentXError, canonicalJson, type AppProjectSummary, type OrgId, type ProjectCommand, type StoredProjectDefinition } from "@rovara-code/contracts";
import { resolveRepository, settingsCommands } from "../org/project-settings.js";
import { SETUP_CHECK_MAX_AGE_MS } from "../test-env/prove-from-setup-check.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";

/** `devcontainer`: the dev container the batch also saves (as the save stores it), absent when the batch leaves it alone. The check prepares its workspace with it, so the commands are proved in the environment they will run in. */
export interface DraftCommandLists { setup: ProjectCommand[]; readiness: ProjectCommand[]; devcontainer?: { repository: string; configPath?: string } | null | undefined }

/** What a person is told (fixed words). A failure's reason comes from the check itself (a redacted one-liner), never from a model. */
export const DRAFT_CHECK_WORDS = {
  browserOnly: "Check and apply works in the Rovara app, in a browser. Nothing was changed.",
  checking: "Rovara is running these commands on a fresh machine. Nothing is saved until they pass.",
  failed: "These commands did not pass the check on a fresh machine, so nothing was saved.",
  notStarted: "The check of these commands did not start, so nothing was saved.",
  lost: "The check of these commands no longer applies, so nothing was saved. Press Check and apply to run it again.",
  unavailable: "Checking commands on a fresh machine is not set up here, so Rovara saves no commands. Nothing was changed.",
  notTried: "Not tried: the commands in this request are not saved yet.",
} as const;

const REASON_MAX = 400;
const REFUSED_AS_THEY_ARE: readonly string[] = ["PROJECT_REVISION_MISMATCH", "PROJECT_ARCHIVED", "PROJECT_NOT_FOUND", "FORBIDDEN"];

/**
 * The lists the settings would hold once a draft's `setupCommands` / `testCommands` are saved: a list the draft names is rebuilt by the save's own rule, the other is left exactly as stored. Throws what the save
 * would throw for a command it cannot read (CONFIG_INVALID, naming the field and index).
 */
export function draftCommandLists(
  definition: Pick<StoredProjectDefinition, "repositories" | "setup" | "readiness">,
  settings: { setupCommands?: readonly string[] | undefined; testCommands?: readonly string[] | undefined; devcontainer?: { repository: string; configPath?: string | undefined } | null | undefined },
): DraftCommandLists {
  const cwd = definition.repositories[0]?.path;
  if (cwd === undefined) throw agentXError("CONFIG_INVALID", "the project has no repository to run commands in");
  let devcontainer: DraftCommandLists["devcontainer"];
  // TE-4: `null` is a change that removes the dev container: the check then runs without one.
  if (settings.devcontainer === null) devcontainer = null;
  else if (settings.devcontainer !== undefined) {
    // As the settings save stores it: the repository by its name in the project.
    const repository = resolveRepository(definition.repositories, settings.devcontainer.repository);
    if (repository === undefined) throw agentXError("CONFIG_INVALID", "devcontainer.repository: is not a repository of this project");
    devcontainer = { repository: repository.name, ...(settings.devcontainer.configPath === undefined ? {} : { configPath: settings.devcontainer.configPath }) };
  }
  return {
    ...(devcontainer === undefined ? {} : { devcontainer }),
    setup: settings.setupCommands === undefined ? [...definition.setup] : settingsCommands("setupCommands", settings.setupCommands, cwd, SETUP_TIMEOUT, definition.setup),
    readiness: settings.testCommands === undefined ? [...definition.readiness] : settingsCommands("testCommands", settings.testCommands, cwd, TEST_TIMEOUT, definition.readiness),
  };
}

/** The digest a check is stored under: the exact lists and the dev container they run in. A different list pair is another digest, so no check is ever read for commands it did not run. Namespaced, so it cannot meet a test environment's digest. */
export function draftCommandsDigest(lists: DraftCommandLists): string {
  return createHash("sha256").update(canonicalJson({ kind: "setup_draft_commands", version: 1, setup: lists.setup, readiness: lists.readiness, devcontainer: lists.devcontainer }), "utf8").digest("hex");
}

const identical = (left: readonly ProjectCommand[], right: readonly ProjectCommand[]): boolean => left.length === right.length && left.every((command, index) => canonicalJson(command) === canonicalJson(right[index]));

/** What the apply needs from the candidate check, bound to the developer API by `setupDraftDepsOf`. Absent where setup checks are not set up: the apply then saves no commands. */
export interface SetupDraftCandidatePort {
  /** The stored check of `digest` at the definition's settings revision, and where it stands now (derived from its workspace on every read). */
  read(caller: DeveloperCaller, project: string, digest: string, definition: Pick<StoredProjectDefinition, "revision" | "repositories" | "setup" | "readiness">): Promise<{
    check: { workspaceId: string; revision: number; startedAt: string; setup: ProjectCommand[]; readiness: ProjectCommand[] } | undefined; setup: AppProjectSummary["setup"];
  }>;
  /** The check this request id already started, if any. */
  started(caller: DeveloperCaller, project: string, requestId: string): Promise<{ workspaceId: string } | undefined>;
  /**
   * After the commands were saved from a check that passed: makes that check the project's own setup check at the new revision (the same commands, in the same dev container, ran on a fresh workspace), so
   * a second full check is not run. False when it could not (a newer check is there, the project is archived): the caller then starts the project's own check as before.
   */
  adopt(caller: DeveloperCaller, project: string, input: { workspaceId: string; startedAt: string; revision: number }): Promise<boolean>;
  /** Starts the check of exactly `lists` on a fresh workspace at `expectedRevision` (refused when the settings have moved). Nothing is saved. */
  start(caller: DeveloperCaller, project: string, input: { requestId: string; digest: string; lists: DraftCommandLists; expectedRevision: number }): Promise<void>;
}

export type DraftCheckVerdict = { kind: "passed" } | { kind: "checking" } | { kind: "failed"; reason: string | undefined } | { kind: "start" } | { kind: "lost" };

/**
 * What a stored check means for saving `lists` at `definition.revision`:
 *   passed    ready, for exactly these lists, recent
 *   checking  still running (any request: no second check is started)
 *   failed    did not pass (a new press shows the same failure; only an explicit "check again" starts a new check)
 *   start     nothing usable is stored (none, failed earlier, too old, other lists) and this request has started none
 *   lost      this request did start a check, but what is stored now cannot be used
 */
export function judgeDraftCheck(input: {
  state: Awaited<ReturnType<SetupDraftCandidatePort["read"]>>; lists: DraftCommandLists; revision: number; nowMs: number; mine: { workspaceId: string } | undefined; again?: boolean | undefined;
}): DraftCheckVerdict {
  const { state, lists, mine } = input;
  const unusable: DraftCheckVerdict = mine === undefined ? { kind: "start" } : { kind: "lost" };
  const { check, setup } = state;
  if (check === undefined || check.revision !== input.revision || setup.status === "unchecked" || setup.status === "outdated") return unusable;
  if (setup.status === "checking") return { kind: "checking" };
  // A failure of these commands at this revision is shown again to anyone who asks, not run again, until the person asks to check again (or the draft or the settings change, which change the key).
  if (setup.status === "failed") return mine === undefined && input.again === true ? { kind: "start" } : { kind: "failed", reason: setup.failedStep };
  // Ready: for exactly these commands, and recent.
  const checkedAt = Date.parse(check.startedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > input.nowMs + 5 * 60_000 || input.nowMs - checkedAt > SETUP_CHECK_MAX_AGE_MS) return unusable;
  if (!identical(lists.setup, check.setup) || !identical(lists.readiness, check.readiness)) return unusable;
  return { kind: "passed" };
}

/** Why a settings batch with commands did not go on: the outcome every item of the batch gets, with the fixed words and (for a failure) the check's own reason. */
export type DraftGate = { kind: "not_needed" } | { kind: "passed"; check: { workspaceId: string; startedAt: string } } | { kind: "blocked"; outcome: "checking" | "check_failed" | "not_available"; message: string; reason?: string };

/** A passed check is made the project's own check only while it is this fresh (the repository's default branch may have moved since). */
export const ADOPT_MAX_AGE_MS = 60 * 60_000;

export interface DraftGateInput {
  candidate: SetupDraftCandidatePort | undefined; caller: DeveloperCaller & { browserSession?: true | undefined }; orgId: OrgId; project: string; requestId: string; derivedRequestId: (purpose: string) => string;
  definition: StoredProjectDefinition; settings: { setupCommands?: readonly string[] | undefined; testCommands?: readonly string[] | undefined; devcontainer?: { repository: string; configPath?: string | undefined } | undefined }; nowMs: number;
  /** The person asked to run the check again after a failure. */
  again?: boolean | undefined;
}

/**
 * Decides whether a settings batch may be saved. Only a batch that changes setup or test commands needs the check (a dev container alone does not). Such a batch needs a maintainer in a browser session (the
 * route has already required the maintainer), a candidate check port, and a passing check of exactly these lists at the current revision; when none exists it starts one and answers `checking`, saving nothing.
 */
export async function gateDraftCommands(input: DraftGateInput): Promise<DraftGate> {
  if (input.settings.setupCommands === undefined && input.settings.testCommands === undefined) return { kind: "not_needed" };
  // A token (a CLI, an assistant holding one) never counts: a browser is the only thing that can show a person pressed the button.
  if (input.caller.browserSession !== true) throw agentXError("FORBIDDEN", DRAFT_CHECK_WORDS.browserOnly);
  const blocked = (outcome: "checking" | "check_failed" | "not_available", message: string, reason?: string): DraftGate => ({ kind: "blocked", outcome, message, ...(reason === undefined || reason === "" ? {} : { reason: [...reason].slice(0, REASON_MAX).join("") }) });
  if (input.candidate === undefined) return blocked("not_available", DRAFT_CHECK_WORDS.unavailable);
  const lists = draftCommandLists(input.definition, input.settings);
  const digest = draftCommandsDigest(lists);
  const checkRequestId = input.derivedRequestId(`draft-check:${digest.slice(0, 16)}`);
  const state = await input.candidate.read(input.caller, input.project, digest, input.definition);
  const mine = await input.candidate.started(input.caller, input.project, checkRequestId);
  const verdict = judgeDraftCheck({ state, lists, revision: input.definition.revision, nowMs: input.nowMs, mine, again: input.again });
  switch (verdict.kind) {
    case "passed": return { kind: "passed", check: { workspaceId: state.check!.workspaceId, startedAt: state.check!.startedAt } };
    case "checking": return blocked("checking", DRAFT_CHECK_WORDS.checking);
    case "failed": return blocked("check_failed", DRAFT_CHECK_WORDS.failed, verdict.reason);
    case "lost": return blocked("check_failed", DRAFT_CHECK_WORDS.lost);
    case "start": {
      try {
        await input.candidate.start(input.caller, input.project, { requestId: checkRequestId, digest, lists, expectedRevision: input.definition.revision });
      } catch (error) {
        if (!(error instanceof AgentXError)) throw error;
        // Another check of the same commands is already running: this press waits for it.
        if (error.code === "WORKSPACE_BUSY") return blocked("checking", DRAFT_CHECK_WORDS.checking);
        // Refusals that are the same whatever is being saved (the settings moved under the press, an archived project, no right): said as they are, not as a failed check.
        if (REFUSED_AS_THEY_ARE.includes(error.code)) throw error;
        if (error.code === "NOT_FOUND") return blocked("not_available", DRAFT_CHECK_WORDS.unavailable);
        return blocked("check_failed", DRAFT_CHECK_WORDS.notStarted, error.message.replace(/^[A-Z_]+: /u, ""));
      }
      return blocked("checking", DRAFT_CHECK_WORDS.checking);
    }
  }
}
