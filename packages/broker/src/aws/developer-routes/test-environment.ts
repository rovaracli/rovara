// Test environment (wire-testenv, setup wizard E4): the setup routes. Rovara PROPOSES the project's test environment from what the setup draft found in the default branch (or a maintainer edits it), a maintainer
// PROVES it with the project's setup check, and APPROVES it; each approval is a new immutable revision (org/test-environment.ts). The routes exist only while the switch is on: with it off every path falls through
// as any unknown path.
//
//   GET  /v1/app/projects/{name}/test-environment                where it stands: the approved revision, the draft, the proposal (what will run, where each value came from, whether it is proved, what approving needs)
//   POST /v1/app/projects/{name}/test-environment/propose        store the proposal for the latest setup draft (the body comes from the stored draft, never from the request)
//   POST /v1/app/projects/{name}/test-environment/edit           a maintainer's edited body, stored as a proposal (test-environment-wizard.ts)
//   POST /v1/app/projects/{name}/test-environment/check          run the proposal's CANDIDATE check: a fresh workspace prepared from the commands the proposal would put in the settings, before any is applied (TE-2)
//   POST /v1/app/projects/{name}/test-environment/apply-commands put the APPROVED environment's commands into the settings (refused for a proposal that is not approved; the approval does this itself)
//   POST /v1/app/projects/{name}/test-environment/prove          derive the Prove report of a proposal from ITS candidate check (prove-from-setup-check.ts)
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
  TestEnvCheckBodySchema,
  TestEnvEditBodySchema,
  TestEnvSeedBodySchema,
  TestEnvProposeBodySchema,
  TestEnvProveBodySchema,
  TestEnvRequestApprovalBodySchema,
  TestEnvDependenciesSchema,
  TestEnvironmentBodySchema,
  EDITION_ENV_VAR,
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
import { latestRevision } from "../../org/project-settings.js";
import {
  approveTestEnvironment, clearEditedProposal, isSetupRunProposal, proposalIsSetupRun, proposalSeedTrust, proposeTestEnvironment, TEST_ENV_PROPOSAL_TTL_MS, readApprovedTestEnvironment, readEditedProposal, readProposal, readProposalSources, readTestEnvProveReport, recordTestEnvProveReport,
  secondPersonFromRecords, testEnvRequestId, type TestEnvDeps,
} from "../../org/test-environment.js";
import { testEnvChangeLines } from "../../org/test-env-diff.js";
import { confirmedTestEnvApproval, recordTestEnvAsk, requestTestEnvCard, testEnvCardViewOf } from "../../org/test-env-approval.js";
import { derivedRequestId, setupDraftState } from "../../rovara-code/setup-draft.js";
import { readSetupRunProposal } from "../../rovara-code/setup-run-proposal.js";
import { DRAFT_ABSENCE_NOTES, readTestEnvDraft, readTestEnvDraftNote } from "../../test-env/draft.js";
import { commandsMissingFromSettings } from "../../test-env/candidate-commands.js";
import { lookIsStale, readOwnSettingsWrite } from "../../test-env/own-settings-write.js";
import { TEST_ENV_REFUSAL_WORDS, commandsNotRun } from "../../test-env/prove-from-setup-check.js";
import { testEnvironmentEnabled } from "../../test-env/switch.js";
import { testServicesEnabled } from "../../test-env/test-services-switch.js";
import { lockLookSeeds, lockedLookOf, recordLockedLook, seedRisksOf } from "../../test-env/seed-lock.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { projectRoleForRoute } from "./project-members.js";
import { jsonBody } from "./organization.js";
import { startCandidateSetupCheck } from "./project-archive-setup.js";
import { candidateStateOf, deriveCandidateProve } from "./test-environment-candidate.js";
import { TEST_ENV_EDIT_WORDS, applyProposalCommands, dependencySeedsOf, editTestEnvironment, requireFreshSignIn, runsOf, setDependencySeed } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TEST_ENV_PATH = /^\/v1\/app\/projects\/([^/]+)\/test-environment(?:\/(propose|prove|approve|edit|seed|apply-commands|request-approval|check))?$/u;
export const isTestEnvironmentPath = (pathname: string): boolean => TEST_ENV_PATH.test(pathname);

/** What the routes do after an approval (the nightly schedule follows the approved environment). A failure here never undoes the approval. */
export interface TestEnvRouteHooks { onApproved?(orgId: OrgId, project: string, approved: TestEnvironment, approval?: { replayed: boolean }): Promise<void> }

export function testEnvStoreOf(deps: DeveloperRouteDependencies): TestEnvDeps {
  return { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }), ...(deps.fixtureStore === undefined ? {} : { fixtureStore: deps.fixtureStore }) };
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
/** The note when a dependency the detectors found clashes with the approved ones and is left out of the proposal. */
export const LOOK_FOUND_NOTHING_NOTE = DRAFT_ABSENCE_NOTES.no_test_command;
export const DEPENDENCY_CLASH_NOTE = "A dependency that was found clashes with one already approved (the same name, address or setting), so it is not part of the proposal.";

export function mergeDraftWithApproved(draft: TestEnvironmentBody, approved: TestEnvironmentBody | undefined, notes?: string[]): TestEnvironmentBody | undefined {
  if (approved === undefined) return draft;
  const ids = new Set(draft.repos.flatMap((repo) => repo.checks.map((check) => check.id)));
  // Test services: the approved environment's dependencies stay exactly as a person set them. A dependency the detectors found and it does not have is added when the list stays one the contract accepts (unique ids,
  // aliases and variables; at most 12 started); one that would clash is left out and said so once, in fixed words, instead of making the whole proposal unprovable.
  const dependencies = [...(approved.dependencies ?? [])];
  const known = new Set(dependencies.map((dependency) => dependency.id));
  let clashed = false;
  for (const dependency of draft.dependencies ?? []) {
    if (known.has(dependency.id)) continue;
    if (TestEnvDependenciesSchema.safeParse([...dependencies, dependency]).success) dependencies.push(dependency);
    else clashed = true;
  }
  if (clashed) notes?.push(DEPENDENCY_CLASH_NOTE);
  const merged = {
    ...approved,
    repos: draft.repos,
    selection: {
      ...approved.selection,
      alwaysRun: draft.selection.alwaysRun.filter((id) => ids.has(id)),
      fullSuiteOn: [...new Set([...approved.selection.fullSuiteOn, ...draft.selection.fullSuiteOn])].slice(0, 100),
    },
    ...(dependencies.length === 0 ? {} : { dependencies }),
  };
  const parsed = TestEnvironmentBodySchema.safeParse(merged);
  return parsed.success ? parsed.data : undefined;
}

interface ProjectView { orgId: OrgId; name: string; role: Parameters<typeof proposeTestEnvironment>[1]["role"]; developerId: string; /** The viewer, for the card they see (item 1). */ caller: DeveloperCaller }

async function latestOf(deps: DeveloperRouteDependencies, orgId: OrgId, name: string) {
  const latest = await latestRevision({ documentClient: deps.documentClient, tableName: deps.tableName }, orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  return latest;
}

/** The latest setup draft's environment draft when it is ready and was written for the project's current settings; otherwise why not. */
async function currentDraft(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, revision: number): Promise<{ status: "ready"; draft: TestEnvDraft; looked: true } | { status: "none" | "stale"; note?: string; looked: boolean }> {
  const state = await setupDraftState({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId, name, revision);
  if (state.status !== "ready" || state.pointer === undefined) return { status: "none", looked: false };
  // Test services: the dependencies the detectors found become proposed ones here, from the signed catalog (none without it, or with the switch off).
  const catalog = testServicesEnabled() ? await Promise.resolve(deps.serviceCatalog?.()).catch(() => undefined) : undefined;
  const stored = await readTestEnvDraft(deps.documentClient, deps.tableName, orgId, name, state.pointer.taskId, deps.now(), { propose: { catalog, edition: process.env[EDITION_ENV_VAR] === "enterprise" ? "enterprise" : "public", projectId: name } });
  if (stored === undefined) {
    // The look ran and no test environment came of it: one plain note for each cause, with what to do (TS-UX-1 item 6).
    return { status: "none", note: await readTestEnvDraftNote(deps.documentClient, deps.tableName, orgId, name, state.pointer.taskId, deps.now()), looked: true };
  }
  // TS-UX-1 item 5: the test environment's own write into the settings (its approval) does not make the look stale.
  const own = state.basedOnRevision < revision ? await readOwnSettingsWrite(deps.documentClient, deps.tableName, orgId, name).catch(() => undefined) : undefined;
  return lookIsStale(state.basedOnRevision, revision, own) ? { status: "stale", looked: true } : { status: "ready", draft: stored.draft, looked: true };
}

/** The stored proposal of a digest, or (after its 7 days) the approved environment it became. */
async function proposalOrApproved(store: TestEnvDeps, orgId: OrgId, name: string, digest: string): Promise<TestEnvironmentBody | undefined> {
  const stored = await readProposal(store, orgId, name, digest);
  if (stored !== undefined) return stored;
  const approved = await readApprovedTestEnvironment(store, orgId, name);
  return approved !== undefined && testEnvDigest(approved.environment) === digest ? approved.environment : undefined;
}

/** The proposal the wizard shows: a maintainer's edit when there is one that is still stored, else the one the latest setup draft makes (when it was proposed). */
async function shownProposal(deps: DeveloperRouteDependencies, project: ProjectView, approved: TestEnvironment | undefined, draft: Awaited<ReturnType<typeof currentDraft>>): Promise<{ body: TestEnvironmentBody; digest: string; source: "setup" | "edited" } | undefined> {
  const store = testEnvStoreOf(deps);
  const edited = await readEditedProposal(store, project.orgId, project.name);
  const approvedDigest = approved === undefined ? undefined : testEnvDigest(approved.environment);
  // What is already approved is not a proposal (after the approval's own settings write the look reads as current again, item 5).
  if (edited !== undefined && edited.digest !== approvedDigest) {
    const body = await readProposal(store, project.orgId, project.name, edited.digest).catch(() => undefined);
    if (body !== undefined) return { body, digest: edited.digest, source: "edited" };
  }
  // A setup run's proposal (SH15): shown as Rovara's, never as a person's edit.
  const fromRun = await readSetupRunProposal(store, project.orgId, project.name);
  const runBody = fromRun === undefined ? undefined : await readProposal(store, project.orgId, project.name, fromRun.digest).catch(() => undefined);
  if (fromRun !== undefined && runBody !== undefined && fromRun.digest !== approvedDigest) return { body: runBody, digest: fromRun.digest, source: "setup" };
  const candidate = draft.status === "ready" ? mergeDraftWithApproved(draft.draft.environment, approved?.environment) : undefined;
  if (candidate === undefined) return undefined;
  const digest = testEnvDigest(candidate);
  if (digest === approvedDigest) return undefined;
  // SEED-RISK-1: the look's proposal as the broker stored it, with the seed locks it put on (the candidate recomputed from the draft has none).
  const locked = await lockedLookOf(store, { orgId: project.orgId, project: project.name, lookDigest: digest, nowMs: deps.now() }).catch(() => undefined);
  if (locked !== undefined && locked !== digest) {
    if (locked === approvedDigest) return undefined;
    const body = await readProposal(store, project.orgId, project.name, locked).catch(() => undefined);
    if (body !== undefined) return { body, digest: locked, source: "setup" };
  }
  return await readProposal(store, project.orgId, project.name, digest) === undefined ? undefined : { body: candidate, digest, source: "setup" };
}

/** The notes the merge onto the approved environment adds (a dependency left out because it clashes). */
function mergeNotesOf(draft: TestEnvironmentBody, approved: TestEnvironmentBody | undefined): string[] {
  const notes: string[] = [];
  mergeDraftWithApproved(draft, approved, notes);
  return notes;
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
    const { valueSources, origin, seedChecks } = await readProposalSources(store, project.orgId, project.name, shown.digest);
    // SEED-RISK-1: only the broker's own seed checks on the proposal item can make a seed command medium.
    const trust = await proposalSeedTrust(store, project.orgId, project.name, shown.digest, shown.body);
    const lessSafe = testEnvLessSafeChanges(approved?.environment, shown.body, trust);
    const risk = lessSafe.length > 0 ? "high" : testEnvApprovalRisk(shown.body, trust);
    const candidate = await candidateStateOf(deps, project.orgId, project.name, shown.digest, latest.definition);
    // TS-UX-1 item 2: a passed check proves the proposal with no press. A read keeps nothing: it shows the report derived from the check now (the approval keeps it).
    const kept = testEnvIsProved(report, shown.digest, shown.body);
    const derived = !kept && candidate.setup.status === "ready" ? await deriveCandidateProve(deps, project.orgId, project.name, shown.body, latest.definition) : undefined;
    const shownReport = kept ? report : derived?.ok === true ? derived.report : report;
    // TS-UX-1 item 1: the second person's card on THIS screen: whoever asked sees who it waits for, and a person who may confirm it sees the card itself.
    let approval: NonNullable<TestEnvironmentState["proposal"]>["approval"] = { status: "none" };
    if (lessSafe.length > 0 && deps.agents !== undefined) {
      const view = await testEnvCardViewOf(deps.agents, { documentClient: deps.documentClient, tableName: deps.tableName }, { orgId: project.orgId, project: project.name, digest: shown.digest, expectedRevision: approved?.revision ?? 0 }, project.caller)
        .catch(() => ({ status: "none" as const, askedByYou: false, youConfirm: false }));
      approval = { ...view, ...(view.status === "pending" && view.askedByYou ? { waitingFor: await waitingForOf(deps, project) } : {}) };
    }
    proposal = {
      digest: shown.digest, source: shown.source, risk, lessSafe, summary: testEnvSummaryOf(shown.body), environment: shown.body, runs: runsOf(shown.body),
      valueSources: valueSources.flatMap((entry) => { const parsed = valueSourceOf(entry); return parsed === undefined ? [] : [parsed]; }),
      proved: testEnvIsProved(shownReport, shown.digest, shown.body), proveSteps: (shownReport?.steps ?? []).map((step) => ({ step: step.step, status: step.status })),
      needs: { freshSignIn: lessSafe.length > 0 || risk === "high" || origin === "setup_run" || candidate.check?.origin === "setup_run" || isSetupRunProposal(valueSources), secondPerson: lessSafe.length > 0 },
      approval,
      dependencySeeds: dependencySeedsOf(shown.body),
      seedRisks: seedRisksOf(seedChecks, shown.body),
      commandsNotInSettings: commandsNotRun(shown.body, latest.definition),
      check: checkOf(candidate.setup),
    };
  }
  return {
    ...(approved === undefined ? {} : { approved: { revision: approved.revision, approvedAt: approved.approvedAt, digest: testEnvDigest(approved.environment), summary: testEnvSummaryOf(approved.environment), ...await approvedGapOf(deps, project, approved.environment, latest.definition) } }),
    draft: draft.status === "ready"
      ? { looked: true, status: "ready", notes: [...draft.draft.notes, ...mergeNotesOf(draft.draft.environment, approved?.environment)], questions: draft.draft.questions, pendingServices: draft.draft.pendingServices }
      : { looked: draft.looked, status: draft.status, notes: draft.note === undefined ? [] : [draft.note], questions: [], pendingServices: [] },
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

/** S2: an approved environment whose commands are not all in the settings (the write after the approval did not land, or the settings changed since), and where the check of THAT digest stands at the settings revision as it is now. */
async function approvedGapOf(deps: DeveloperRouteDependencies, project: ProjectView, environment: TestEnvironmentBody, definition: Awaited<ReturnType<typeof latestOf>>["definition"]): Promise<{ commandsNotInSettings: number; check: NonNullable<TestEnvironmentState["proposal"]>["check"] }> {
  const missing = commandsMissingFromSettings(environment, definition);
  return { commandsNotInSettings: missing, check: missing === 0 ? { status: "unchecked" } : checkOf((await candidateStateOf(deps, project.orgId, project.name, testEnvDigest(environment), definition)).setup) };
}

/** Where the proposal's candidate check stands at the settings as they are now (a failing step is a redacted one-liner, cut to what the page shows). */
function checkOf(setup: Awaited<ReturnType<typeof candidateStateOf>>["setup"]): NonNullable<TestEnvironmentState["proposal"]>["check"] {
  const failedStep = setup.failedStep === undefined ? undefined : [...setup.failedStep].slice(0, 400).join("");
  return { status: setup.status, ...(failedStep === undefined || failedStep === "" ? {} : { failedStep }) };
}

/** The Prove report of a proposal from its own candidate check as it stands NOW (TE-2: never from the applied settings or the project's own setup check). */
async function deriveProve(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, proposal: TestEnvironmentBody) {
  const latest = await latestOf(deps, orgId, name);
  return deriveCandidateProve(deps, orgId, name, proposal, latest.definition);
}

/**
 * Who a waiting card waits for, as the page says it (item 1): the asker themselves when the company's records give the sole-owner exception (one owner, nobody else eligible, nobody eligible left in the last day,
 * and the company switch on), else a second person. Read from the same decision the card's rule and the approval use; any failure to read is "a second person" (the exception is never assumed).
 */
async function waitingForOf(deps: DeveloperRouteDependencies, project: ProjectView): Promise<"second_person" | "you_sole_owner"> {
  const check = testEnvApprovalStoreOf(deps).secondPerson;
  if (check === undefined) return "second_person";
  try {
    const decided = await check({ orgId: project.orgId, project: project.name, proposerId: project.developerId, approverId: project.developerId });
    return decided.mode === "sole_owner_exception" ? "you_sole_owner" : "second_person";
  } catch {
    return "second_person";
  }
}

/** Stores the proposal the latest look makes (merged onto the approved environment) and answers its digest: `propose`, and the first half of a "Check it works" press with nothing proposed yet. */
async function proposeFromLook(deps: DeveloperRouteDependencies, caller: DeveloperCaller, role: ProjectView["role"], name: string): Promise<string> {
  const store = testEnvStoreOf(deps);
  const latest = await latestOf(deps, caller.orgId, name);
  const draft = await currentDraft(deps, caller.orgId, name, latest.definition.revision);
  if (draft.status !== "ready") throw refuse(draft.status === "stale" ? "stale_draft" : "no_draft");
  const approved = await readApprovedTestEnvironment(store, caller.orgId, name);
  const candidate = mergeDraftWithApproved(draft.draft.environment, approved?.environment);
  if (candidate === undefined) throw refuse("not_provable");
  // SEED-RISK-1: the broker locks the seed commands the detectors found, from the repository as the code host gives it (never the worker's word); one it cannot lock stays HIGH.
  const locked = await lockLookSeeds(candidate, draft.draft.seedCommands, deps.seedRepoSources, { orgId: caller.orgId, project: name });
  const proposed = await proposeTestEnvironment(store, { orgId: caller.orgId, project: name, proposedBy: caller.developerId, role, body: locked.body, valueSources: draft.draft.valueSources, seedChecks: locked.checks });
  // Always written (also when nothing was locked), so a look whose seeds can no longer be locked never keeps showing an older locked proposal.
  const lookDigest = testEnvDigest(candidate);
  await recordLockedLook(store, { orgId: caller.orgId, project: name, lookDigest, lockedDigest: proposed.digest, expiresAtMs: deps.now() + TEST_ENV_PROPOSAL_TTL_MS });
  // Going back to what Rovara found: an earlier edit no longer stands in front of it.
  await clearEditedProposal(store, caller.orgId, name);
  logDeveloperEvent({ event: "developer.test_env_proposed", orgId: caller.orgId, project: name, digest: proposed.digest, lessSafe: String(proposed.lessSafe.length) });
  return proposed.digest;
}

/**
 * TS-UX-1 item 2: the Prove of a proposal is a pure derivation of its passed candidate check, so it needs no press: when the check passed and no report is kept yet, the report is derived NOW and kept (the same
 * derivation and record as the `prove` route). Answers whether the proposal is proved. A check that has not passed, or a derivation that refuses, proves nothing and keeps nothing.
 */
async function provedFromCheck(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, digest: string, proposal: TestEnvironmentBody): Promise<boolean> {
  const store = testEnvStoreOf(deps);
  if (testEnvIsProved(await readTestEnvProveReport(store, orgId, name, digest), digest, proposal)) return true;
  const derived = await deriveProve(deps, orgId, name, proposal);
  if (!derived.ok) return false;
  return (await recordTestEnvProveReport(store, { orgId, project: name, report: derived.report })).proved;
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
  const project: ProjectView = { orgId: caller.orgId, name, role, developerId: caller.developerId, caller };
  const store = testEnvStoreOf(deps);
  if (action === undefined) return new StatusReply(200, await stateOf(deps, project));
  if (request.method !== "POST") return undefined;
  const body = jsonBody(request);

  if (action === "propose") {
    const parsed = TestEnvProposeBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw bodyError(parsed.error);
    await proposeFromLook(deps, caller, role, name);
    return new StatusReply(200, await stateOf(deps, project));
  }

  if (action === "edit") {
    const parsed = TestEnvEditBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    const edited = await editTestEnvironment(store, { orgId: caller.orgId, developerId: caller.developerId, project: name, role, environment: parsed.data.environment });
    logDeveloperEvent({ event: "developer.test_env_edited", orgId: caller.orgId, project: name, digest: edited.digest });
    return new StatusReply(200, await stateOf(deps, project));
  }

  if (action === "seed") {
    // The role is checked before anything else is read or parsed: a person who may not edit learns nothing about the proposal or the dependency.
    if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can edit a test environment");
    const parsed = TestEnvSeedBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    const proposal = await proposalOrApproved(store, caller.orgId, name, parsed.data.digest);
    if (proposal === undefined) throw refuse("no_proposal");
    const edited = await setDependencySeed(store, { orgId: caller.orgId, developerId: caller.developerId, project: name, role, body: proposal, dependencyId: parsed.data.dependencyId, lines: parsed.data.commands });
    logDeveloperEvent({ event: "developer.test_env_seed_set", orgId: caller.orgId, project: name, digest: edited.digest, dependencyId: parsed.data.dependencyId, change: edited.cleared ? "cleared" : "set", commands: String(edited.commands) });
    return new StatusReply(200, await stateOf(deps, project));
  }

  if (action === "apply-commands") {
    const parsed = TestEnvApplyBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change the project's settings");
    // The proposal is read from its stored copy, or (after its 7 days) from the approved revision it became. Nothing is applied for a proposal that is not approved: `applyProposalCommands` refuses it.
    const proposal = await proposalOrApproved(store, caller.orgId, name, parsed.data.digest);
    if (proposal === undefined) throw refuse("no_proposal");
    const latest = await latestOf(deps, caller.orgId, name);
    const applied = await applyProposalCommands(deps, caller, { name, role, body: proposal, requestId: parsed.data.requestId, expectedRevision: parsed.data.expectedRevision, edited: (await readEditedProposal(store, caller.orgId, name))?.digest === parsed.data.digest, definition: latest.definition });
    logDeveloperEvent({ event: "developer.test_env_commands_applied", orgId: caller.orgId, project: name, digest: parsed.data.digest, added: String(applied.added.length) });
    return new StatusReply(200, { ...applied, state: await stateOf(deps, project) });
  }

  if (action === "check") {
    const parsed = TestEnvCheckBodySchema.safeParse(body);
    if (!parsed.success) throw bodyError(parsed.error);
    if (!projectAllows(role, "setup_check")) throw agentXError("FORBIDDEN", "only a project maintainer can run a check of a test environment");
    // TS-UX-1 item 2: "Check it works" with no digest proposes what the look found first (the shown proposal when one stands), so one press proposes and checks.
    const digest = parsed.data.digest ?? (await stateOf(deps, project)).proposal?.digest ?? await proposeFromLook(deps, caller, role, name);
    // The proposal, or the approved environment it became (to run its check again after the settings changed).
    const proposal = await proposalOrApproved(store, caller.orgId, name, digest);
    if (proposal === undefined) throw refuse("no_proposal");
    const started = await startCandidateSetupCheck(deps, caller, encodeURIComponent(name), { requestId: parsed.data.requestId, digest, body: proposal, ...(await proposalIsSetupRun(store, caller.orgId, name, digest) ? { origin: "setup_run" as const } : {}) });
    logDeveloperEvent({ event: "developer.test_env_check_requested", orgId: caller.orgId, project: name, digest, replayed: String(started.statusCode === 200) });
    return new StatusReply(started.statusCode, await stateOf(deps, project));
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
    const lessSafe = testEnvLessSafeChanges(current?.environment, proposal, await proposalSeedTrust(store, caller.orgId, name, parsed.data.digest, proposal));
    if (lessSafe.length === 0) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.secondPersonNotNeeded);
    if (!await provedFromCheck(deps, caller.orgId, name, parsed.data.digest, proposal)) throw agentXError("CONFIG_INVALID", TEST_ENV_EDIT_WORDS.provedFirst);
    if (deps.agents === undefined) throw agentXError("RUNTIME_UNAVAILABLE", TEST_ENV_EDIT_WORDS.unavailable);
    const asked = await requestTestEnvCard(deps.agents, caller, { project: name, digest: parsed.data.digest, expectedRevision: parsed.data.expectedRevision, lessSafe, diff: testEnvChangeLines(current?.environment, proposal) });
    // Item 1: the setup page of every viewer finds this card (who asked is kept for the proposal and revision).
    await recordTestEnvAsk({ documentClient: deps.documentClient, tableName: deps.tableName }, { orgId: caller.orgId, project: name, digest: parsed.data.digest, expectedRevision: parsed.data.expectedRevision, askedBy: caller.developerId });
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
  let setupRunMark = false;
  let seedFileHashes: ReadonlyArray<{ id: string; path: string; sha256: string }> | undefined;
  if (current === undefined || testEnvDigest(current.environment) !== input.digest) {
    const proposal = await readProposal(store, caller.orgId, name, input.digest);
    if (proposal !== undefined) {
      // TE-2: the proof is the proposal's own candidate check, read again now (a check that failed or went out of date since the Prove stops the approval before anything is written).
      const again = await deriveProve(deps, caller.orgId, name, proposal);
      if (!again.ok) throw refuse(again.refusal);
      seedFileHashes = again.candidate?.usage?.seedFiles;
      // TS-UX-1 item 2: no Prove press: the passed check's report is kept here when none is yet (the approval reads the kept one).
      if (!testEnvIsProved(await readTestEnvProveReport(store, caller.orgId, name, input.digest), input.digest, proposal)) await recordTestEnvProveReport(store, { orgId: caller.orgId, project: name, report: again.report });
      const trust = await proposalSeedTrust(store, caller.orgId, name, input.digest, proposal);
      const lessSafe = testEnvLessSafeChanges(current?.environment, proposal, trust);
      // A proposal a setup RUN made (the agent ran commands) is approved only by a person who signed in just now, in a browser, as a less-safe change is.
      const setupRun = again.candidate?.origin === "setup_run" || await proposalIsSetupRun(store, caller.orgId, name, input.digest);
      setupRunMark = setupRun;
      if (lessSafe.length > 0 || testEnvApprovalRisk(proposal, trust) === "high" || setupRun) approvedBySignedInAtMs = await requireFreshSignIn(deps, caller);
      if (lessSafe.length > 0 && deps.agents !== undefined) {
        approval = await confirmedTestEnvApproval(deps.agents, { orgId: caller.orgId, project: name, digest: input.digest, expectedRevision: input.expectedRevision, askedBy: caller.developerId });
      }
    }
  }
  const approvedNow = await approveTestEnvironment(testEnvApprovalStoreOf(deps), {
    orgId: caller.orgId, project: name, digest: input.digest, expectedRevision: input.expectedRevision, requestId: input.requestId, approvedBy: caller.developerId, role,
    // Review I3: the seed files' content the proposal's own check loaded is what is approved.
    ...(seedFileHashes === undefined ? {} : { seedFileHashes }),
    ...(approval === undefined ? {} : { approval }), ...(approvedBySignedInAtMs === undefined ? {} : { approvedBySignedInAtMs }), ...(setupRunMark ? { setupRun: true } : {}),
  });
  logDeveloperEvent({ event: "developer.test_env_approved", orgId: caller.orgId, project: name, revision: String(approvedNow.revision), replayed: String(approvedNow.replayed) });
  // TE-2: only now do the approved environment's commands reach the settings, and only as the candidate check ran them. A failure here never undoes the approval: the commands stay out of the settings (the
  // state says how many are not in yet), and the apply can be asked for again once the check is run again.
  const approved = await readApprovedTestEnvironment(store, caller.orgId, name, approvedNow.revision);
  if (approved !== undefined) await applyApprovedCommands(deps, caller, role, name, approved.environment, input.requestId);
  if (hooks.onApproved !== undefined) {
    try {
      if (approved !== undefined) await hooks.onApproved(caller.orgId, name, approved, { replayed: approvedNow.replayed });
    } catch (error) {
      logDeveloperEvent({ event: "developer.test_env_after_approval_failed", orgId: caller.orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return approvedNow;
}

/** Writes the approved environment's commands into the settings (a no-op when they are already there). Never throws: the approval stands. */
async function applyApprovedCommands(deps: DeveloperRouteDependencies, caller: DeveloperCaller, role: ProjectView["role"], name: string, environment: TestEnvironmentBody, requestId: string): Promise<void> {
  const store = testEnvStoreOf(deps);
  try {
    const latest = await latestOf(deps, caller.orgId, name);
    const digest = testEnvDigest(environment);
    const applied = await applyProposalCommands(deps, caller, {
      name, role, body: environment, requestId: derivedRequestId(requestId, "test-env-apply"), expectedRevision: latest.definition.revision,
      edited: (await readEditedProposal(store, caller.orgId, name))?.digest === digest, definition: latest.definition,
    });
    logDeveloperEvent({ event: "developer.test_env_commands_applied", orgId: caller.orgId, project: name, digest, added: String(applied.added.length), by: "approval" });
  } catch (error) {
    logDeveloperEvent({ event: "developer.test_env_commands_not_applied", orgId: caller.orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
  }
}
