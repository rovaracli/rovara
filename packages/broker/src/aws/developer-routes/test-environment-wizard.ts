// Setup wizard (E4), the parts of the test-environment routes that go beyond propose / prove / approve:
//   edit              a maintainer's EDITED proposal body: validated like any environment, then stored as a proposal (never approved by it)
//   apply-commands    put the proposal's commands into the project's settings, through the settings save every other change uses, so the setup check can run them
//   request-approval  ask a second person to confirm a less-safe change, on the confirmation page (a fresh sign-in)
// and the facts the wizard shows: what will run, where each value came from, what approving needs, and how the second person's card stands.
//
// Authority, in one place:
//   propose / edit / apply-commands   a project maintainer (`edit_settings`); the project's role comes from `projectRoleForRoute`, so an Auditor, who has no project role, finds nothing
//   approve                           a project maintainer; a less-safe or high-risk change also needs the approver's own fresh browser sign-in (read from their session here, never from the request)
//                                     and, when less safe, a second person's confirmation card (`org/test-env-approval.ts`) whose proof and live authority `approveTestEnvironment` checks again
// A browser session is the only thing that can show a fresh sign-in: a token (a CLI, an assistant holding one) never counts.
import {
  TestEnvironmentBodySchema,
  agentXError,
  formatCommandLine,
  projectAllows,
  settingOriginOf,
  type ProjectOrigins,
  testEnvDigest,
  type OrgId,
  type ProjectCommand,
  type ProjectRole,
  type TestEnvApplyAnswer,
  type TestEnvRuns,
  type TestEnvironmentBody,
} from "@agentx/contracts";
import { isFreshSignIn, type SessionRecord } from "../../developer/store.js";
import type { TestEnvDeps } from "../../org/test-environment.js";
import { setEditedProposal, proposeTestEnvironment, readApprovedTestEnvironment } from "../../org/test-environment.js";
import { shownLine } from "../../org/shown-line.js";
import { derivedRequestId } from "../../rovara-code/setup-draft.js";
import { refuseSetupRunProposal } from "../../rovara-code/setup-run-proposal.js";
import { refusedCommand } from "../../test-env/draft.js";
import { PROVED_CHECK_KINDS, selectionFieldsAreSafe } from "../../test-env/prove-from-setup-check.js";
import { getSignIn } from "./authentication.js";
import { startProjectSetupCheck } from "./project-archive-setup.js";
import { putProjectSettings } from "./project-settings.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TEST_ENV_EDIT_WORDS = {
  unchanged: "This is already the approved test environment.",
  selection: "A way of narrowing the tests other than the approved placeholder is not accepted: a check's arguments are `{tests}` and nothing else, and the selection method is full or a coverage map.",
  remoteCode: "A command downloads and runs code, or holds something secret-shaped, so it can't be part of a test environment.",
  oneDirectory: "The project's commands run in more than one directory, so they can't be changed from here. Ask an administrator.",
  secondPersonNotNeeded: "This change doesn't need a second person's confirmation.",
  provedFirst: "Prove this environment before asking for a second person.",
  browserOnly: "Approve this change in the Rovara app, in a browser.",
  signInAgain: "Sign in again to approve this change.",
  unavailable: "Confirmation cards are not set up in this deployment.",
} as const;

// ---- what will run

const LINE_MAX = 600;
export { shownLine };

/** The commands of an environment as lines a person reads (formatted by the broker, so the page shows what the server would run, not what a browser rebuilt). */
export function runsOf(body: TestEnvironmentBody): TestEnvRuns[] {
  return body.repos.map((repo) => ({
    repositoryId: shownLine(repo.repositoryId, 200),
    setup: repo.setupCommands.map((command) => shownLine(formatCommandLine(command), LINE_MAX)),
    checks: repo.checks.map((check) => ({ id: check.id, label: shownLine(check.label, 80), kind: check.kind, command: shownLine(formatCommandLine(check.command), LINE_MAX), ...(check.selectArgs === undefined ? {} : { selectArgs: [...check.selectArgs] }) })),
  }));
}

// ---- a fresh sign-in

/**
 * When the caller signed in, if that was within the fresh window and they are in a browser session. A token, a session with no readable sign-in time, or one that cannot be read, is not fresh.
 */
export async function freshSignInOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<number | undefined> {
  if (caller.browserSession !== true) return undefined;
  let session: Pick<SessionRecord, "authTime"> | undefined;
  try { session = await getSignIn<Pick<SessionRecord, "authTime">>(deps, `SESSION#${caller.sessionId}`); } catch { return undefined; }
  if (session === undefined || !isFreshSignIn(session, deps.now())) return undefined;
  const at = Date.parse(session.authTime!);
  return Number.isFinite(at) ? at : undefined;
}

/** Throws unless the caller has a fresh browser sign-in; answers when they signed in. */
export async function requireFreshSignIn(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<number> {
  const at = await freshSignInOf(deps, caller);
  if (at !== undefined) return at;
  throw agentXError(caller.browserSession === true ? "REAUTH_REQUIRED" : "FORBIDDEN", caller.browserSession === true ? TEST_ENV_EDIT_WORDS.signInAgain : TEST_ENV_EDIT_WORDS.browserOnly);
}

// ---- an edited proposal

/**
 * What an EDITED body must be before it is stored as a proposal: it parses as an environment (strict), narrows tests only by the approved placeholder, and holds no command that downloads and runs code. Whatever
 * else it asks for (production, a recording in the shared tier) is refused by `proposeTestEnvironment`; whether it is less safe is read against the approved environment by the same function every proposal uses.
 */
export function refuseUnsafeEdit(body: TestEnvironmentBody): void {
  if (!selectionFieldsAreSafe(body)) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.selection);
  const commands = body.repos.flatMap((repo) => [...repo.setupCommands, ...repo.checks.map((check) => check.command)]);
  if (commands.some(refusedCommand)) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.remoteCode);
}

/** Stores a maintainer's edited body as a proposal and makes it the one the wizard shows. The body is re-parsed here: a request body is never trusted to be what the schema already saw. */
export async function editTestEnvironment(
  store: TestEnvDeps, input: { orgId: OrgId; project: string; developerId: string; role: ProjectRole | undefined; environment: unknown },
): Promise<{ digest: string }> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can edit a test environment");
  const parsed = TestEnvironmentBodySchema.safeParse(input.environment);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "environment"}: ${issue?.message ?? "invalid"}`);
  }
  const body = parsed.data;
  refuseUnsafeEdit(body);
  const approved = await readApprovedTestEnvironment(store, input.orgId, input.project);
  if (approved !== undefined && testEnvDigest(approved.environment) === testEnvDigest(body)) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.unchanged);
  const proposed = await proposeTestEnvironment(store, { orgId: input.orgId, project: input.project, proposedBy: input.developerId, role: input.role, body });
  await setEditedProposal(store, { orgId: input.orgId, project: input.project, digest: proposed.digest, editedBy: input.developerId });
  return { digest: proposed.digest };
}

// ---- apply the proposal's commands to the project's settings

type Skipped = TestEnvApplyAnswer["skipped"][number];

const sameCommand = (left: ProjectCommand, right: ProjectCommand): boolean => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);
const SETTINGS_COMMANDS_MAX = 16;

/** What a proposal adds to a project's commands, and what it leaves out and why. Pure: the project's settings save does the rest. */
export function commandsToApply(
  body: TestEnvironmentBody, current: { setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }, firstRepositoryPath: string,
): { setup: ProjectCommand[]; readiness: ProjectCommand[]; skipped: Skipped[] } {
  const skipped = new Map<Skipped["reason"], number>();
  const skip = (reason: Skipped["reason"]) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const wanted = (command: ProjectCommand, have: ProjectCommand[]): boolean => {
    if (refusedCommand(command)) { skip("download_and_run"); return false; }
    // The settings save runs every command in the project's first repository: a command for another directory can't be put there.
    if (command.cwd !== firstRepositoryPath) { skip("different_directory"); return false; }
    return !have.some((candidate) => sameCommand(candidate, command));
  };
  const setup = [...current.setup], readiness = [...current.readiness];
  const added = { setup: [] as ProjectCommand[], readiness: [] as ProjectCommand[] };
  const add = (target: ProjectCommand[], fresh: ProjectCommand[], command: ProjectCommand) => {
    if (!wanted(command, target)) return;
    if (target.length >= SETTINGS_COMMANDS_MAX) { skip("too_many"); return; }
    target.push(command); fresh.push(command);
  };
  for (const repo of body.repos) {
    for (const command of repo.setupCommands) add(setup, added.setup, command);
    for (const check of repo.checks) {
      if (!PROVED_CHECK_KINDS.includes(check.kind)) { skip("not_needed"); continue; }
      add(readiness, added.readiness, check.command);
    }
  }
  return { setup: added.setup, readiness: added.readiness, skipped: [...skipped].map(([reason, count]) => ({ reason, count })) };
}

/**
 * Who the save is credited to. The mark is what protects a person's value: a later suggestion or meta-repo plan that would replace a value a person set is flagged as a conflict. So the commands stay a person's when
 * the maintainer wrote the proposal (an edit), or when the list already held commands a person set; only commands Rovara drafted, added to lists that hold nothing of a person's, are marked as Rovara's.
 */
export function originOfSave(definition: { setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[]; origins?: ProjectOrigins | undefined }, plan: { setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[] }, edited: boolean): "person" | "agent" {
  if (edited) return "person";
  const personHolds = (field: "setup" | "readiness") => plan[field].length > 0 && definition[field].length > 0 && settingOriginOf(definition, field) === "person";
  return personHolds("setup") || personHolds("readiness") ? "person" : "agent";
}

/**
 * Puts the proposal's commands into the project's settings, after the commands already there (a command a person typed is never replaced), through the settings save every other change uses: the maintainer's
 * role, the revision they looked at, the command rules and the meta repo's ownership of a setting all apply, and what it changes is marked as set by Rovara. Then the setup check starts, so it can run them.
 * Nothing is saved when there is nothing to add.
 */
export async function applyProposalCommands(
  deps: DeveloperRouteDependencies, caller: DeveloperCaller,
  input: { name: string; role: ProjectRole | undefined; body: TestEnvironmentBody; requestId: string; expectedRevision: number; /** The proposal is a maintainer's own edit, so its commands are theirs. */ edited: boolean; definition: { revision: number; repositories: ReadonlyArray<{ path: string }>; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[]; origins?: ProjectOrigins | undefined } },
): Promise<Omit<TestEnvApplyAnswer, "state">> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change the project's settings");
  const { definition } = input;
  await refuseSetupRunProposal({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, caller.orgId, input.name, input.body);
  if (definition.revision !== input.expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", "The project's settings changed since you looked. Reload and try again.");
  const first = definition.repositories[0]?.path;
  if (first === undefined) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.oneDirectory);
  // The settings save writes every command with the first repository's directory: commands that already run elsewhere would be moved by it.
  if ([...definition.setup, ...definition.readiness].some((command) => command.cwd !== first)) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.oneDirectory);
  const plan = commandsToApply(input.body, definition, first);
  const added = [...plan.setup, ...plan.readiness];
  if (added.length === 0) return { added: [], skipped: plan.skipped, settingsRevision: definition.revision, setupCheck: "not_needed" };
  const saved = await putProjectSettings(deps, caller, encodeURIComponent(input.name), {
    requestId: input.requestId, expectedRevision: input.expectedRevision,
    ...(plan.setup.length === 0 ? {} : { setupCommands: [...definition.setup, ...plan.setup].map(formatCommandLine) }),
    ...(plan.readiness.length === 0 ? {} : { testCommands: [...definition.readiness, ...plan.readiness].map(formatCommandLine) }),
  }, { origin: originOfSave(input.definition, plan, input.edited) });
  let setupCheck: TestEnvApplyAnswer["setupCheck"] = "started";
  try { await startProjectSetupCheck(deps, caller, encodeURIComponent(input.name), { requestId: derivedRequestId(input.requestId, "test-env-setup-check") }); } catch { setupCheck = "not_started"; }
  return { added: added.map(formatCommandLine), skipped: plan.skipped, settingsRevision: saved.project.latestRevision, setupCheck };
}
