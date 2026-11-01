// Test environment (wire-testenv): the setup routes. Rovara PROPOSES the project's test environment from what the setup draft found in the default branch, a maintainer PROVES it with the project's setup check,
// and APPROVES it; each approval is a new immutable revision (org/test-environment.ts). The routes exist only while the switch is on: with it off every path falls through as any unknown path.
//
//   GET  /v1/app/projects/{name}/test-environment            where it stands: the approved revision, the draft the latest setup draft found, the proposal and whether it is proved
//   POST /v1/app/projects/{name}/test-environment/propose    store the proposal for the latest setup draft (the body comes from the stored draft, never from the request)
//   POST /v1/app/projects/{name}/test-environment/prove      derive the Prove report of a proposal from the project's setup check (prove-from-setup-check.ts)
//   POST /v1/app/projects/{name}/test-environment/approve    approve a proved proposal as the next revision
//
// What the routes do NOT do (the approval card, E4, does): take an edited body, ask for a fresh sign-in or a second person, or approve anything that is less safe than the sandbox. A DRAFT is the sandbox tier with no
// services, accounts, preview, shared environment, video, traces or nightly run (a draft with more is refused when it is stored). A PROPOSAL on a project that already has an approved environment also keeps what a person
// set there (tier, services, accounts, nightly run, production list), which can be less safe: `approveTestEnvironment` itself refuses a less-safe or high-risk change that comes without the second person and the fresh
// sign-in, and these routes never supply either, so such a proposal cannot be approved here (REAUTH_REQUIRED or FORBIDDEN).
import {
  projectAllows,
  TestEnvApproveBodySchema,
  TestEnvProposeBodySchema,
  TestEnvProveBodySchema,
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
import { setupStateOf } from "../../org/project-setup-check.js";
import { latestRevision } from "../../org/project-settings.js";
import { readProjectMeta } from "../../developer/project-roles.js";
import {
  approveTestEnvironment, proposeTestEnvironment, readApprovedTestEnvironment, readProposal, readTestEnvProveReport, recordTestEnvProveReport, testEnvRequestId, type TestEnvDeps,
} from "../../org/test-environment.js";
import { setupDraftState } from "../../rovara-code/setup-draft.js";
import { readTestEnvDraft, readTestEnvDraftNote } from "../../test-env/draft.js";
import { TEST_ENV_REFUSAL_WORDS, proveReportFromSetupCheck } from "../../test-env/prove-from-setup-check.js";
import { testEnvironmentEnabled } from "../../test-env/switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { setupCheckDepsOf } from "./project-list.js";
import { projectRoleForRoute } from "./project-members.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TEST_ENV_PATH = /^\/v1\/app\/projects\/([^/]+)\/test-environment(?:\/(propose|prove|approve))?$/u;
export const isTestEnvironmentPath = (pathname: string): boolean => TEST_ENV_PATH.test(pathname);

/** What the routes do after an approval (the nightly schedule follows the approved environment). A failure here never undoes the approval. */
export interface TestEnvRouteHooks { onApproved?(orgId: OrgId, project: string, approved: TestEnvironment): Promise<void> }

export function testEnvStoreOf(deps: DeveloperRouteDependencies): TestEnvDeps {
  return { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
}

const refuse = (refusal: TestEnvRefusal): AgentXError => agentXError(refusal === "no_draft" || refusal === "stale_draft" || refusal === "no_proposal" ? "CHANGE_STALE" : "CONFIG_INVALID", TEST_ENV_REFUSAL_WORDS[refusal]);

/**
 * The draft environment merged onto the approved one, so a new proposal replaces what the detectors own (the repositories' setup commands and checks, and which checks always run) and keeps what a person set
 * (tier, services, accounts, the production deny list, the nightly run, capture, the round budget). Without an approved environment the draft is the proposal. Undefined when the merge is not a valid environment.
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

interface ProjectView { orgId: OrgId; name: string; role: Parameters<typeof proposeTestEnvironment>[1]["role"] }

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

async function stateOf(deps: DeveloperRouteDependencies, project: ProjectView): Promise<TestEnvironmentState> {
  const store = testEnvStoreOf(deps);
  const latest = await latestOf(deps, project.orgId, project.name);
  const approved = await readApprovedTestEnvironment(store, project.orgId, project.name);
  const draft = await currentDraft(deps, project.orgId, project.name, latest.definition.revision);
  const candidate = draft.status === "ready" ? mergeDraftWithApproved(draft.draft.environment, approved?.environment) : undefined;
  let proposal: TestEnvironmentState["proposal"];
  if (candidate !== undefined) {
    const digest = testEnvDigest(candidate);
    if (await readProposal(store, project.orgId, project.name, digest) !== undefined) {
      const report = await readTestEnvProveReport(store, project.orgId, project.name, digest);
      const lessSafe = testEnvLessSafeChanges(approved?.environment, candidate);
      proposal = {
        digest, risk: lessSafe.length > 0 ? "high" : testEnvApprovalRisk(candidate), lessSafe, summary: testEnvSummaryOf(candidate),
        proved: testEnvIsProved(report, digest), proveSteps: (report?.steps ?? []).map((step) => ({ step: step.step, status: step.status })),
      };
    }
  }
  return {
    ...(approved === undefined ? {} : { approved: { revision: approved.revision, approvedAt: approved.approvedAt, digest: testEnvDigest(approved.environment), summary: testEnvSummaryOf(approved.environment) } }),
    draft: draft.status === "ready"
      ? { status: "ready", notes: draft.draft.notes, questions: draft.draft.questions, pendingServices: draft.draft.pendingServices }
      : { status: draft.status, notes: draft.note === undefined ? [] : [draft.note], questions: [], pendingServices: [] },
    ...(proposal === undefined ? {} : { proposal }),
  };
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
  const project: ProjectView = { orgId: caller.orgId, name, role };
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
    logDeveloperEvent({ event: "developer.test_env_proposed", orgId: caller.orgId, project: name, digest: proposed.digest, lessSafe: String(proposed.lessSafe.length) });
    return new StatusReply(200, await stateOf(deps, project));
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

  const parsed = TestEnvApproveBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const requestId = parsed.data.requestId ?? testEnvRequestId(parsed.data.digest, parsed.data.expectedRevision, caller.developerId);
  // The proof is read again NOW: a proposal proved at an earlier settings revision is not approved after a command it was proved with was removed. (A replay of an approval already made skips this: it changes nothing.)
  const current = await readApprovedTestEnvironment(store, caller.orgId, name);
  if (current === undefined || testEnvDigest(current.environment) !== parsed.data.digest) {
    const proposal = await readProposal(store, caller.orgId, name, parsed.data.digest);
    if (proposal !== undefined) {
      const again = await deriveProve(deps, caller.orgId, name, proposal);
      if (!again.ok) throw refuse(again.refusal);
    }
  }
  // No second person and no fresh sign-in are supplied here, on purpose: a change that needs them is refused by `approveTestEnvironment`.
  const approvedNow = await approveTestEnvironment(store, { orgId: caller.orgId, project: name, digest: parsed.data.digest, expectedRevision: parsed.data.expectedRevision, requestId, approvedBy: caller.developerId, role });
  logDeveloperEvent({ event: "developer.test_env_approved", orgId: caller.orgId, project: name, revision: String(approvedNow.revision), replayed: String(approvedNow.replayed) });
  if (hooks.onApproved !== undefined) {
    try {
      const approved = await readApprovedTestEnvironment(store, caller.orgId, name, approvedNow.revision);
      if (approved !== undefined) await hooks.onApproved(caller.orgId, name, approved);
    } catch (error) {
      logDeveloperEvent({ event: "developer.test_env_after_approval_failed", orgId: caller.orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return new StatusReply(200, { revision: approvedNow.revision, digest: approvedNow.digest, replayed: approvedNow.replayed, state: await stateOf(deps, project) });
}
