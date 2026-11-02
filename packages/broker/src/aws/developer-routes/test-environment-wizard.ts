// Setup wizard (E4), the parts of the test-environment routes that go beyond propose / prove / approve:
//   edit              a maintainer's EDITED proposal body: validated like any environment, then stored as a proposal (never approved by it)
//   apply-commands    put the APPROVED environment's commands into the project's settings, through the settings save every other change uses. Refused for any proposal that is not approved yet (TE-2): tasks read the
//                     applied settings, so a command reaches them only after a candidate check ran it, a Prove read that check, and an approval re-verified it (`approveChecked` calls this after approving)
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
import { refusedCommand } from "../../test-env/draft.js";
import { commandsToApply } from "../../test-env/candidate-commands.js";
import { TEST_ENV_REFUSAL_WORDS, selectionFieldsAreSafe } from "../../test-env/prove-from-setup-check.js";
import { getSignIn } from "./authentication.js";
import { startProjectSetupCheck } from "./project-archive-setup.js";
import { putProjectSettings } from "./project-settings.js";
import { CANDIDATE_APPLY_WORDS, deriveCandidateProve } from "./test-environment-candidate.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TEST_ENV_EDIT_WORDS = {
  unchanged: "This is already the approved test environment.",
  selection: "A way of narrowing the tests other than the approved placeholder is not accepted: a check's arguments are `{tests}` and nothing else, only on a test runner that takes test ids (pytest, jest, vitest or mocha, run directly, through `python -m pytest`, `npx`, `bunx`, or `pnpm`/`yarn` `exec` or `dlx`) and never with a flag that lets a run with no tests pass, and the selection method is full or a coverage map.",
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

// `commandsToApply` and the lists a candidate check runs live in `test-env/candidate-commands.ts` (both the check and the approval's write use them); it is re-exported here.
export { commandsToApply };

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
 * Puts the APPROVED environment's commands into the project's settings, after the commands already there (a command a person typed is never replaced), through the settings save every other change uses: the maintainer's
 * role, the revision they looked at, the command rules and the meta repo's ownership of a setting all apply, and what it changes is marked as set by Rovara. Refused unless the environment is approved, and unless a
 * candidate check at this settings revision ran exactly these commands (TE-2). Then the project's own setup check starts, so its status follows the new settings.
 * Nothing is saved when there is nothing to add.
 */
export async function applyProposalCommands(
  deps: DeveloperRouteDependencies, caller: DeveloperCaller,
  input: { name: string; role: ProjectRole | undefined; body: TestEnvironmentBody; requestId: string; expectedRevision: number; /** The proposal is a maintainer's own edit, so its commands are theirs. */ edited: boolean; definition: { revision: number; repositories: ReadonlyArray<{ path: string }>; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[]; origins?: ProjectOrigins | undefined } },
): Promise<Omit<TestEnvApplyAnswer, "state">> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change the project's settings");
  // TE-2: tasks read the applied settings, so a proposal's commands are never applied before it is approved (every kind of proposal: the detectors', an edit, a setup run's).
  const approved = await readApprovedTestEnvironment({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, caller.orgId, input.name);
  if (approved === undefined || testEnvDigest(approved.environment) !== testEnvDigest(input.body)) throw agentXError("CONFIG_INVALID", CANDIDATE_APPLY_WORDS.notApproved);
  const { definition } = input;
  if (definition.revision !== input.expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", "The project's settings changed since you looked. Reload and try again.");
  const first = definition.repositories[0]?.path;
  if (first === undefined) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.oneDirectory);
  // The settings save writes every command with the first repository's directory: commands that already run elsewhere would be moved by it.
  if ([...definition.setup, ...definition.readiness].some((command) => command.cwd !== first)) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.oneDirectory);
  const plan = commandsToApply(input.body, definition, first);
  const added = [...plan.setup, ...plan.readiness];
  if (added.length === 0) return { added: [], skipped: plan.skipped, settingsRevision: definition.revision, setupCheck: "not_needed" };
  // What is written is what a candidate check ran, at this settings revision: the Prove is read again here, and the lists must be the check's own.
  const proven = await deriveCandidateProve(deps, caller.orgId, input.name, input.body, definition);
  if (!proven.ok) throw agentXError("CONFIG_INVALID", TEST_ENV_REFUSAL_WORDS[proven.refusal]);
  const saved = await putProjectSettings(deps, caller, encodeURIComponent(input.name), {
    requestId: input.requestId, expectedRevision: input.expectedRevision,
    ...(plan.setup.length === 0 ? {} : { setupCommands: [...definition.setup, ...plan.setup].map(formatCommandLine) }),
    ...(plan.readiness.length === 0 ? {} : { testCommands: [...definition.readiness, ...plan.readiness].map(formatCommandLine) }),
  }, { origin: originOfSave(input.definition, plan, input.edited) });
  let setupCheck: TestEnvApplyAnswer["setupCheck"] = "started";
  try { await startProjectSetupCheck(deps, caller, encodeURIComponent(input.name), { requestId: derivedRequestId(input.requestId, "test-env-setup-check") }); } catch { setupCheck = "not_started"; }
  return { added: added.map(formatCommandLine), skipped: plan.skipped, settingsRevision: saved.project.latestRevision, setupCheck };
}
