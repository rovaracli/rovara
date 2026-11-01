// Test environment (wire-testenv, setup wizard E4): the setup routes. Rovara PROPOSES the project's test environment from what the setup draft found in the default branch (or a maintainer edits it), a maintainer
// PROVES it with the project's setup check, and APPROVES it; each approval is a new immutable revision (org/test-environment.ts). The routes exist only while the switch is on: with it off every path falls through
// as any unknown path.
//
//   GET  /v1/app/projects/{name}/test-environment                where it stands: the approved revision, the draft, the proposal (what will run, where each value came from, whether it is proved, what approving needs)
//   POST /v1/app/projects/{name}/test-environment/propose        store the proposal for the latest setup draft (the body comes from the stored draft, never from the request)
//   POST /v1/app/projects/{name}/test-environment/edit           a maintainer's edited body, stored as a proposal (test-environment-wizard.ts)
//   POST /v1/app/projects/{name}/test-environment/apply-commands put the proposal's commands into the project's settings, so the setup check can run them
//   POST /v1/app/projects/{name}/test-environment/prove          derive the Prove report of a proposal from the project's setup check (prove-from-setup-check.ts)
//   POST /v1/app/projects/{name}/test-environment/request-approval  make the second person's confirmation card for a less-safe change
//   POST /v1/app/projects/{name}/test-environment/approve        approve a proved proposal as the next revision
//
// Approval authority: a maintainer approves. A change that is HIGH risk or less safe than the sandbox is approved only with the approver's own fresh browser sign-in (read from their session, never from the request);
// a less-safe one also needs a second person, who confirms a card on the confirmation page (their fresh sign-in is recorded there) and whom `approveTestEnvironment` checks against the company's records. A DRAFT is
// the sandbox tier with no services, accounts, preview, shared environment, video, traces or nightly run (a draft with more is refused when it is stored). A PROPOSAL on a project that already has an approved
// environment also keeps what a person set there (tier, services, accounts, nightly run, production list), which can be less safe.
import {
  projectAllows,
  TestEnvApplyBodySchema,
  TestEnvApproveBodySchema,
  TestEnvEditBodySchema,
  TestEnvProposeBodySchema,
  TestEnvProveBodySchema,
  TestEnvRequestApprovalBodySchema,
  TestEnvironmentBodySchema,
  agentXError,
  testEnvApprovalRisk,
  testEnvDigest,
  testEnvIsProved,
  testEnvLessSafeChanges,
  testEnvSummaryOf,
  type AgentXError,
  type TestEnvDraft,
  type TestEnvRefusal,
  type TestEnvironment,
  type TestEnvironmentBody,
  type TestEnvironmentState,
  type OrgId,
} from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { confirmationReply } from "../../agent-sessions/shares.js";
import { setupStateOf } from "../../org/project-setup-check.js";
import { latestRevision } from "../../org/project-settings.js";
import { readProjectMeta } from "../../developer/project-roles.js";
import {
  approveTestEnvironment, clearEditedProposal, proposeTestEnvironment, readApprovedTestEnvironment, readEditedProposal, readProposal, readProposalSources, readTestEnvProveReport, recordTestEnvProveReport,
  secondPersonFromRecords, testEnvRequestId, type TestEnvDeps,
} from "../../org/test-environment.js";
import { testEnvChangeLines } from "../../org/test-env-diff.js";
import { confirmedTestEnvApproval, requestTestEnvCard, testEnvCardStateOf } from "../../org/test-env-approval.js";
import { setupDraftState } from "../../rovara-code/setup-draft.js";
import { readTestEnvDraft, readTestEnvDraftNote } from "../../test-env/draft.js";
import { TEST_ENV_REFUSAL_WORDS, commandsNotRun, proveReportFromSetupCheck } from "../../test-env/prove-from-setup-check.js";
import { testEnvironmentEnabled } from "../../test-env/switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { setupCheckDepsOf } from "./project-list.js";
import { projectRoleForRoute } from "./project-members.js";
import { jsonBody } from "./organization.js";
import { TEST_ENV_EDIT_WORDS, applyProposalCommands, editTestEnvironment, requireFreshSignIn, runsOf } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TEST_ENV_PATH = /^\/v1\/app\/projects\/([^/]+)\/test-environment(?:\/(propose|prove|approve|edit|apply-commands|request-approval))?$/u;
export const isTestEnvironmentPath = (pathname: string): boolean => TEST_ENV_PATH.test(pathname);

/** What the routes do after an approval (the nightly schedule follows the approved environment). A failure here never undoes the approval. */
export interface TestEnvRouteHooks { onApproved?(orgId: OrgId, project: string, approved: TestEnvironment): Promise<void> }

export function testEnvStoreOf(deps: DeveloperRouteDependencies): TestEnvDeps {
  return { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
}

/** The store with the second-person check bound to the company's records, for an approval. Without the sign-in table there is no second person, and a less-safe approval is refused. */
export function testEnvApprovalStoreOf(deps: DeveloperRouteDependencies): TestEnvDeps {
  const signInTableName = deps.developer?.signInTableName;
  return {
    ...testEnvStoreOf(deps),
    ...(signInTableName === undefined || signInTableName === "" ? {} : { secondPerson: secondPersonFromRecords({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now, soleOwnerTable: deps.teamRecord?.table }) }),
  };
}

const refuse = (refusal: TestEnvRefusal): AgentXError => agentXError(refusal === "no_draft" || refusal === "stale_draft" || refusal === "no_proposal" ? "CHANGE_STALE" : "CONFIG_INVALID", TEST_ENV_REFUSAL_WORDS[refusal]);

/**
 * The draft environment merged onto the approved one, so a new proposal replaces what the detectors own (the repositories' setup commands and checks, and which checks always run) and keeps what a person
 * set (tier, services, accounts, the production deny list, the nightly run, capture, the round budget). Without an approved environment the draft is the proposal. Undefined when the merge is not a valid environment.
 */
export function mergeDraftWithApproved(draft: TestEnvironmentBody, approved: TestEnvironmentBody | undefined): TestEnvironmentBody | undefined {
  if (approved === undefined) return draft;
  const ids = new Set(draft.repos.flatMap((repo) => repo.checks.map((check) => check.id)));
  const merged = {
    ...approved,
    repos: draft.repos,
    selection: {
      ...approved.selection,
      alwaysRun: draft.selection.alwaysRun.filter((id) => ids.has(id)),
      fullSuiteOn: [...new Set([...approved.selection.fullSuiteOn, ...draft.selection.fullSuiteOn])].slice(0, 100),
    },
  };
  const parsed = TestEnvironmentBodySchema.safeParse(merged);
  return parsed.success ? parsed.data : undefined;
}

interface ProjectView { orgId: OrgId; name: string; role: Parameters<typeof proposeTestEnvironment>[1]["role"]; developerId: string }

async function latestOf(deps: DeveloperRouteDependencies, orgId: OrgId, name: string) {
  const latest = await latestRevision({ documentClient: deps.documentClient, tableName: deps.tableName }, orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  return latest;
}

/** The latest setup draft's environment draft when it is ready and was written for the project's current settings; otherwise why not. */
async function currentDraft(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, revision: number): Promise<{ status: "ready"; draft: TestEnvDraft } | { status: "none" | "stale"; note?: string }> {
  const state = await setupDraftState({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId, name, revision);
  if (state.status !== "ready" || state.pointer === undefined) return { status: "none" };
  const stored = await readTestEnvDraft(deps.documentClient, deps.tableName, orgId, name, state.pointer.taskId, deps.now());
  if (stored === undefined) {
    const note = await readTestEnvDraftNote(deps.documentClient, deps.tableName, orgId, name, state.pointer.taskId, deps.now());
    return note === undefined ? { status: "none" } : { status: "none", note };
  }
  return state.basedOnRevision < revision ? { status: "stale" } : { status: "ready", draft: stored.draft };
}

/** The proposal the wizard shows: a maintainer's edit when there is one that is still stored, else the one the latest setup draft makes (when it was proposed). */
async function shownProposal(deps: DeveloperRouteDependencies, project: ProjectView, approved: TestEnvironment | undefined, draft: Awaited<ReturnType<typeof currentDraft>>): Promise<{ body: TestEnvironmentBody; digest: string; source: "setup" | "edited" } | undefined> {
  const store = testEnvStoreOf(deps);
  const edited = await readEditedProposal(store, project.orgId, project.name);
  if (edited !== undefined) {
    const body = await readProposal(store, project.orgId, project.name, edited.digest).catch(() => undefined);
    if (body !== undefined) return { body, digest: edited.digest, source: "edited" };
  }
  const candidate = draft.status === "ready" ? mergeDraftWithApproved(draft.draft.environment, approved?.environment) : undefined;
  if (candidate === undefined) return undefined;
  const digest = testEnvDigest(candidate);
  return await readProposal(store, project.orgId, project.name, digest) === undefined ? undefined : { body: candidate, digest, source: "setup" };
}

async function stateOf(deps: DeveloperRouteDependencies, project: ProjectView): Promise<TestEnvironmentState> {
  const store = testEnvStoreOf(deps);
  const latest = await latestOf(deps, project.orgId, project.name);
  const approved = await readApprovedTestEnvironment(store, project.orgId, project.name);
  const draft = await currentDraft(deps, project.orgId, project.name, latest.definition.revision);
  const shown = await shownProposal(deps, project, approved, draft);
  let proposal: TestEnvironmentState["proposal"];
  if (shown !== undefined) {
    const report = await readTestEnvProveReport(store, project.orgId, project.name, shown.digest);
    const lessSafe = testEnvLessSafeChanges(approved?.environment, shown.body);
    const risk = lessSafe.length > 0 ? "high" : testEnvApprovalRisk(shown.body);
    const { valueSources } = await readProposalSources(store, project.orgId, project.name, shown.digest);
    let approval: "none" | "pending" | "approved" | "expired" = "none";
    if (lessSafe.length > 0 && deps.agents !== undefined) {
      approval = await testEnvCardStateOf(deps.agents, { orgId: project.orgId, project: project.name, digest: shown.digest, expectedRevision: approved?.revision ?? 0, askedBy: project.developerId }).catch(() => "none" as const);
    }
    proposal = {
      digest: shown.digest, source: shown.source, risk, lessSafe, summary: testEnvSummaryOf(shown.body), environment: shown.body, runs: runsOf(shown.body),
      valueSources: valueSources.flatMap((entry) => { const parsed = valueSourceOf(entry); return parsed === undefined ? [] : [parsed]; }),
      proved: testEnvIsProved(report, shown.digest), proveSteps: (report?.steps ?? []).map((step) => ({ step: step.step, status: step.status })),
      needs: { freshSignIn: lessSafe.length > 0 || risk === "high", secondPerson: lessSafe.length > 0 },
      approval: { status: approval },
      commandsNotInSettings: commandsNotRun(shown.body, latest.definition),
    };
  }
  return {
    ...(approved === undefined ? {} : { approved: { revision: approved.revision, approvedAt: approved.approvedAt, digest: testEnvDigest(approved.environment), summary: testEnvSummaryOf(approved.environment) } }),
    draft: draft.status === "ready"
      ? { status: "ready", notes: draft.draft.notes, questions: draft.draft.questions, pendingServices: draft.draft.pendingServices }
      : { status: draft.status, notes: draft.note === undefined ? [] : [draft.note], questions: [], pendingServices: [] },
    ...(proposal === undefined ? {} : { proposal }),
  };
}

/** A stored value source as the wire carries it: the stored shape is read again (a damaged entry is left out, never shown). */
function valueSourceOf(entry: { field: string; source: unknown }): { field: string; source: string | { path: string; line: number } } | undefined {
  const { field, source } = entry;
  if (field.length < 1 || field.length > 200 || /[\p{Cc}\p{Cf}]/u.test(field)) return undefined;
  if (source === "model" || (typeof source === "string" && /^detector:[a-z0-9_-]{1,40}$/u.test(source))) return { field, source };
  if (typeof source === "object" && source !== null) {
    const { path, line } = source as { path?: unknown; line?: unknown };
    if (typeof path === "string" && path.length >= 1 && path.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(path) && typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= 10_000_000) return { field, source: { path, line } };
  }
  return undefined;
}

const bodyError = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) => {
  const issue = error.issues[0];
  // Field names only: the values are the person's.
  return agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};

/** The Prove report of a proposal from the project's setup check as it stands NOW. */
async function deriveProve(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, proposal: TestEnvironmentBody) {
  const latest = await latestOf(deps, orgId, name);
  const meta = await readProjectMeta({ documentClient: deps.documentClient, tableName: deps.tableName }, orgId, name);
  const setup = await setupStateOf(setupCheckDepsOf(deps), meta, latest.definition);
  return proveReportFromSetupCheck({ environment: proposal, definition: { revision: latest.definition.revision, setup: latest.definition.setup, readiness: latest.definition.readiness }, setup, nowMs: deps.now() });
}

/** `/v1/app/projects/{name}/test-environment*`: the reply, or undefined when the switch is off or the path is not one of these. */
export async function routeTestEnvironment(
  deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, hooks: TestEnvRouteHooks = {}, env: NodeJS.ProcessEnv = process.env,
): Promise<StatusReply | undefined> {
  if (!testEnvironmentEnabled(env)) return undefined;
  const match = TEST_ENV_PATH.exec(url.pathname);
  if (match === null) return undefined;
  const action = match[2];
  if ((action === undefined) !== (request.method === "GET")) return undefined;
  const { name, role } = await projectRoleForRoute(deps, caller, match[1]!);
  const project: ProjectView = { orgId: caller.orgId, name, role, developerId: caller.developerId };
  const store = testEnvStoreOf(deps);
  if (action === undefined) return new StatusReply(200, await stateOf(deps, project));
  if (request.method !== "POST") return undefined;
  const body = jsonBody(request);

  if (action === "propose") {
    const parsed = TestEnvProposeBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw bodyError(parsed.error);
    const latest = await latestOf(deps, caller.orgId, name);
    const draft = await currentDraft(deps, caller.orgId, name, latest.definition.revision);
    if (draft.status !== "ready") throw refuse(draft.status === "stale" ? "stale_draft" : "no_draft");
    const approved = await readApprovedTestEnvironment(store, caller.orgId, name);
    const candidate = mergeDraftWithApproved(draft.draft.environment, approved?.environment);
    if (candidate === undefined) throw refuse("not_provable");
    const proposed = await proposeTestEnvironment(store, { orgId: caller.orgId, project: name, proposedBy: caller.developerId, role, body: candidate, valueSources: draft.draft.valueSources });
    // Going back to what Rovara found: an earlier edit no longer stands in front of it.
    await clearEditedProposal(store, caller.orgId, name);
    logDeveloperEvent({ event: "developer.test_env_proposed", orgId: caller.orgId, project: name, digest: proposed.digest, lessSafe: String(proposed.lessSafe.length) });
    return new StatusReply(200, await stateOf(deps, project));
  }

  if (action === "edit") {
    const parsed = TestEnvEditBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    const edited = await editTestEnvironment(store, { orgId: caller.orgId, developerId: caller.developerId, project: name, role, environment: parsed.data.environment });
    logDeveloperEvent({ event: "developer.test_env_edited", orgId: caller.orgId, project: name, digest: edited.digest });
    return new StatusReply(200, await stateOf(deps, project));
  }

  if (action === "apply-commands") {
    const parsed = TestEnvApplyBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change the project's settings");
    const proposal = await readProposal(store, caller.orgId, name, parsed.data.digest);
    if (proposal === undefined) throw refuse("no_proposal");
    const latest = await latestOf(deps, caller.orgId, name);
    const applied = await applyProposalCommands(deps, caller, { name, role, body: proposal, requestId: parsed.data.requestId, expectedRevision: parsed.data.expectedRevision, edited: (await readEditedProposal(store, caller.orgId, name))?.digest === parsed.data.digest, definition: latest.definition });
    logDeveloperEvent({ event: "developer.test_env_commands_applied", orgId: caller.orgId, project: name, digest: parsed.data.digest, added: String(applied.added.length) });
    return new StatusReply(200, { ...applied, state: await stateOf(deps, project) });
  }

  if (action === "prove") {
    const parsed = TestEnvProveBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    if (!projectAllows(role, "setup_check")) throw agentXError("FORBIDDEN", "only a project maintainer can prove a test environment");
    const proposal = await readProposal(store, caller.orgId, name, parsed.data.digest);
    if (proposal === undefined) throw refuse("no_proposal");
    const derived = await deriveProve(deps, caller.orgId, name, proposal);
    if (!derived.ok) throw refuse(derived.refusal);
    const recorded = await recordTestEnvProveReport(store, { orgId: caller.orgId, project: name, report: derived.report });
    logDeveloperEvent({ event: "developer.test_env_proved", orgId: caller.orgId, project: name, digest: parsed.data.digest, proved: String(recorded.proved) });
    return new StatusReply(200, await stateOf(deps, project));
  }

  if (action === "request-approval") {
    const parsed = TestEnvRequestApprovalBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can ask for a test environment to be approved");
    const proposal = await readProposal(store, caller.orgId, name, parsed.data.digest);
    if (proposal === undefined) throw refuse("no_proposal");
    const current = await readApprovedTestEnvironment(store, caller.orgId, name);
    if ((current?.revision ?? 0) !== parsed.data.expectedRevision) throw agentXError("CHANGE_STALE", "someone changed the test environment; reload and review again");
    const lessSafe = testEnvLessSafeChanges(current?.environment, proposal);
    if (lessSafe.length === 0) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.secondPersonNotNeeded);
    if (!testEnvIsProved(await readTestEnvProveReport(store, caller.orgId, name, parsed.data.digest), parsed.data.digest)) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.provedFirst);
    if (deps.agents === undefined) throw agentXError("RUNTIME_UNAVAILABLE", TEST_ENV_EDIT_WORDS.unavailable);
    const asked = await requestTestEnvCard(deps.agents, caller, { project: name, digest: parsed.data.digest, expectedRevision: parsed.data.expectedRevision, lessSafe, diff: testEnvChangeLines(current?.environment, proposal) });
    const confirmUrl = asked.state === "pending" ? (await confirmationReply(deps.agents, caller, { approvalId: asked.record.approvalId, changes: asked.record.changes })).body.confirmUrl : undefined;
    logDeveloperEvent({ event: "developer.test_env_second_person_asked", orgId: caller.orgId, project: name, digest: parsed.data.digest, status: asked.state });
    return new StatusReply(200, { status: asked.state, ...(confirmUrl === undefined ? {} : { confirmUrl }), state: await stateOf(deps, project) });
  }

  const parsed = TestEnvApproveBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const approvedNow = await approveChecked(deps, caller, role, name, { digest: parsed.data.digest, expectedRevision: parsed.data.expectedRevision, requestId: parsed.data.requestId ?? testEnvRequestId(parsed.data.digest, parsed.data.expectedRevision, caller.developerId) }, hooks);
  return new StatusReply(200, { revision: approvedNow.revision, digest: approvedNow.digest, replayed: approvedNow.replayed, state: await stateOf(deps, project) });
}

/**
 * Approves a proved proposal as the project's next revision, for the setup wizard's Approve and for the decision card's. The proof is read again NOW: a proposal proved at an earlier settings revision is not approved
 * after a command it was proved with was removed (a replay of an approval already made skips this: it changes nothing). A change that is less safe, or high risk, is approved only by a person who signed in just now,
 * in a browser (read from their session, never from the request); a less-safe one also needs the second person's confirmation card, asked by THIS person for this proposal and revision, as the confirmation page
 * recorded it. `approveTestEnvironment` then reads both people's live authority and the proof's age again.
 */
export async function approveChecked(
  deps: DeveloperRouteDependencies, caller: DeveloperCaller, role: ProjectView["role"], name: string, input: { digest: string; expectedRevision: number; requestId: string }, hooks: TestEnvRouteHooks = {},
) {
  const store = testEnvStoreOf(deps);
  const current = await readApprovedTestEnvironment(store, caller.orgId, name);
  let approvedBySignedInAtMs: number | undefined;
  let approval: Awaited<ReturnType<typeof confirmedTestEnvApproval>>;
  if (current === undefined || testEnvDigest(current.environment) !== input.digest) {
    const proposal = await readProposal(store, caller.orgId, name, input.digest);
    if (proposal !== undefined) {
      const again = await deriveProve(deps, caller.orgId, name, proposal);
      if (!again.ok) throw refuse(again.refusal);
      const lessSafe = testEnvLessSafeChanges(current?.environment, proposal);
      if (lessSafe.length > 0 || testEnvApprovalRisk(proposal) === "high") approvedBySignedInAtMs = await requireFreshSignIn(deps, caller);
      if (lessSafe.length > 0 && deps.agents !== undefined) {
        approval = await confirmedTestEnvApproval(deps.agents, { orgId: caller.orgId, project: name, digest: input.digest, expectedRevision: input.expectedRevision, askedBy: caller.developerId });
      }
    }
  }
  const approvedNow = await approveTestEnvironment(testEnvApprovalStoreOf(deps), {
    orgId: caller.orgId, project: name, digest: input.digest, expectedRevision: input.expectedRevision, requestId: input.requestId, approvedBy: caller.developerId, role,
    ...(approval === undefined ? {} : { approval }), ...(approvedBySignedInAtMs === undefined ? {} : { approvedBySignedInAtMs }),
  });
  logDeveloperEvent({ event: "developer.test_env_approved", orgId: caller.orgId, project: name, revision: String(approvedNow.revision), replayed: String(approvedNow.replayed) });
  if (hooks.onApproved !== undefined) {
    try {
      const approved = await readApprovedTestEnvironment(store, caller.orgId, name, approvedNow.revision);
      if (approved !== undefined) await hooks.onApproved(caller.orgId, name, approved);
    } catch (error) {
      logDeveloperEvent({ event: "developer.test_env_after_approval_failed", orgId: caller.orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return approvedNow;
}
