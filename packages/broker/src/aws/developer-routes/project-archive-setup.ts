import { WorkingBranchNameSchema } from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentXNameSchema,
  DEFAULT_AGENT_ALLOW_DOMAINS,
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
  agentXError,
  formatCommandLine,
  projectAllows,
  type AppProjectDetail,
  type WorkspaceInstance,
  type TestEnvironmentBody,
  ProjectSetupCheckBodySchema,
  workerProjectDefinition,
} from "@agentx/contracts";
import { readEgressDomains, type EgressDomainsDependencies } from "../../org/egress-domains.js";
import { applyArchiveRequest, type ProjectArchiveDependencies } from "../../org/project-archive.js";
import { readProjectMeta, requireNewWorkAllowed } from "../../developer/project-roles.js";
import { developerTaskIdentity, type WorkspaceCharge } from "../../developer/task-records.js";
import { developerCharge, limitReached, readWorkspaceLimits, type WorkspaceLimits } from "../../developer/limits.js";
import { STUCK_SETUP_MS } from "../stuck-setup.js";
import { closeSetupCheck } from "../setup-check-close.js";
import { admitMachineTime, admitTrial } from "../../org/trial.js";
import { commitSetupCheck, setupCheckLimitMessage, setupCheckReplay, setupStateOfCheck } from "../../org/project-setup-check.js";
import { readCandidateCheck } from "../../org/test-env-candidate.js";
import { candidateListsChecked } from "../../test-env/candidate-commands.js";
import { setupRunCommitsOf } from "../../test-env/setup-run-pin.js";
import { SETUP_PIN_MOVED } from "../broker/setup-pins.js";
import { StatusReply } from "../status-reply.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";
import { PROJECT_NOT_FOUND_IN_APP, bodyError, signInStoreOf } from "./common.js";
import { appProjectSummary, latestProjectRecord, repositoryFullName, setupCheckDepsOf, visibleProjectRoles } from "./project-list.js";
import { projectRoleForRoute } from "./project-members.js";
import { type OrgId, type ProjectCommand } from "@agentx/contracts";
import { clearArchivedProjectLearning as clearArchivedProject } from "../../learning/cleanup.js";
import { requirePricedTaskStopAdmission } from "../../org/task-stop-unpriced.js";

const ArchiveBodySchema = z.object({ requestId: z.string().uuid() }).strict();

/** What archiving and restoring write and flip: the project's META, and its egress item through the same firewall sync as a settings save. */
export function archiveDepsOf(deps: DeveloperRouteDependencies): ProjectArchiveDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, egress: egressDepsOf(deps), now: () => new Date(deps.now()) };
}

/** Where egress items are kept and how a change reaches the firewall (Plan 2, Task 18). */
export function egressDepsOf(deps: DeveloperRouteDependencies): EgressDomainsDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, cloud: deps.cloud === true, now: () => new Date(deps.now()), sync: deps.egressSync ?? (async () => ({ ok: false })), ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
}

/** `GET /v1/app/projects/{name}`: no access, no such project and another org's project all answer the same 404 PROJECT_NOT_FOUND. */
export async function getAppProject(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<AppProjectDetail> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) throw notFound();
  const [record, meta] = await Promise.all([latestProjectRecord(deps, caller.orgId, name), readProjectMeta(deps, caller.orgId, name)]);
  if (record === undefined) throw notFound();
  const { definition } = record;
  const createdBy = meta?.createdBy ?? "unknown";
  const creator = createdBy === "unknown" ? undefined : await signInStoreOf(deps).getDeveloper(createdBy);
  const egress = await readEgressDomains(deps, caller.orgId, { kind: "project", project: name });
  return {
    ...await appProjectSummary(deps, name, role, record, meta),
    ...(record.workingBranchSelections===undefined?{}:{savedWorkingBranches: (()=>{
      const selections=z.record(AgentXNameSchema,z.object({branch:WorkingBranchNameSchema,commit:z.string().regex(/^[a-f0-9]{40}$/),installationId:z.number().int().positive(),repositoryId:z.number().int().positive()}).strict()).safeParse(record.workingBranchSelections);
      if(!selections.success)throw agentXError("RUNTIME_UNAVAILABLE","Saved working branch settings could not be read.");
      return Object.entries(selections.data).map(([repository,value])=>{const repo=definition.repositories.find(r=>r.name===repository);if(repo===undefined||repo.installationId!==value.installationId||repo.githubRepositoryId!==value.repositoryId)throw agentXError("RUNTIME_UNAVAILABLE","Saved working branch settings could not be read.");return{repository,fullName:repositoryFullName(repo),branch:value.branch,commit:value.commit};});
    })()}),
    settings: {
      setupCommands: definition.setup.map(formatCommandLine),
      testCommands: definition.readiness.map(formatCommandLine),
      devcontainer: definition.devcontainer === undefined ? null
        : { repository: definition.devcontainer.repository, configPath: definition.devcontainer.configPath ?? DEFAULT_DEVCONTAINER_CONFIG_PATH },
      // A domain every project has is approved. Any other is as its egress item says; one the item does not list was never asked for (a
      // project that stored it before approvals existed), so on cloud it serves nothing and reads as pending until the next save asks.
      allowedDomains: (definition.network?.allowedDomains ?? []).map((domain) => {
        if (DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain)) return { domain, status: "approved" as const };
        const entry = egress?.domains.find((candidate) => candidate.domain === domain);
        if (entry === undefined) return { domain, status: deps.cloud === true ? "pending" as const : "approved" as const };
        return { domain, status: entry.status, ...(entry.status === "rejected" && entry.reason !== undefined ? { reason: entry.reason } : {}) };
      }),
    },
    createdAt: meta?.createdAt ?? record.registeredAt,
    createdBy: { developerId: createdBy, name: creator?.displayName ?? "Unknown" },
  };
}

/**
 * v1.2 learning loop: an archived project's learning data (people's words) is deleted with it. Best effort, bounded, and run after the archive has applied: a failure logs the error's name only
 * and never undoes or fails the archive. It does ONE bounded page inline so the request answers quickly; a project with more leaves an entry in the index of open walks and the broker's scheduled
 * run finishes it (`resumeOpenLearningWalks`). What is left meanwhile is ignored by every read of a project created again.
 */
export async function clearArchivedProjectLearning(deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "teamRecord" | "evidenceErase">, orgId: OrgId, project: string, onEvidenceUnfinished?: () => void): Promise<void> {
  try {
    await clearArchivedProject({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId, project);
  } catch (error) {
    logDeveloperEvent({ event: "developer.project_archived_learning_failed", orgId, project, error: error instanceof Error ? error.name : "unknown" });
  }
  // Team record (wire-team-record): the project's record goes with it (where the record's switch is on). Best effort like the line above: an unfinished erase leaves its rows hidden by their tombstones.
  try {
    await deps.teamRecord?.erase.project(orgId, project, "project_archived");
  } catch (error) {
    logDeveloperEvent({ event: "developer.project_archived_record_failed", orgId, project, error: error instanceof Error ? error.name : "unknown" });
  }
  // Proof and evidence (wire-proof fix round 1): the project's stored evidence goes with it. Best effort like the lines above; the tags expire what is left.
  try {
    await deps.evidenceErase?.project(orgId, project);
  } catch (error) {
    logDeveloperEvent({ event: "developer.project_archived_evidence_failed", orgId, project, error: error instanceof Error ? error.name : "unknown" });
    // The erase left its pending record, which the broker's every-minute recovery run finishes (it runs on every install); the caller tells the person.
    onEvidenceUnfinished?.();
  }
}

/** The archive answer's warning when the project's stored proof evidence could not all be removed in the request. The erase is finished by the broker's every-minute recovery run on every install, and archiving again continues it from where it stopped. */
export const EVIDENCE_ERASE_PENDING_WARNING = "Some of this project's stored proof evidence is still being removed. It finishes on its own within a few minutes; archiving the project again also continues it.";

/**
 * `POST /v1/app/projects/{name}/archive` and `.../restore` (Plan 2, Task 20): a maintainer of the project (an org owner or admin, or the
 * project's own maintainer) archives it or brings it back, and the answer is the project as the app now shows it. No access is a 404 and a
 * role without `archive` a 403. Repeating either call on a project already in that state answers 200 and changes nothing (it does run the
 * firewall step again, which finishes a call that stopped half-way). The request id is stored: a replay of it applies nothing, even after the
 * opposite action. `warnings` says when the firewall could not be told at once. Archiving refuses only new work; it stops nothing that is running.
 */
export async function changeProjectArchive(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown, change: "archive" | "restore"): Promise<{ project: AppProjectDetail; warnings: string[] }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) throw notFound();
  if (!projectAllows(role, "archive")) throw agentXError("FORBIDDEN", "only a project maintainer can archive or restore a project");
  const parsed = ArchiveBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  if (await latestProjectRecord(deps, caller.orgId, name) === undefined) throw notFound();
  const { warnings, replayed } = await applyArchiveRequest(archiveDepsOf(deps), caller.orgId, name, change, parsed.data.requestId, { developerId: caller.developerId });
  if (!replayed) logDeveloperEvent({ event: change === "archive" ? "developer.project_archived" : "developer.project_restored", orgId: caller.orgId, project: name });
  if (!replayed && change === "archive" && deps.projectArchived !== undefined) {
    // Plan 3: the agents platform reacts to the archive. The project is archived whatever this does.
    try { await deps.projectArchived(caller.orgId, name); } catch (error) {
      logDeveloperEvent({ event: "developer.project_archived_hook_failed", orgId: caller.orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  const answered = [...warnings];
  if (!replayed && change === "archive") await clearArchivedProjectLearning(deps, caller.orgId, name, () => { answered.push(EVIDENCE_ERASE_PENDING_WARNING); });
  return { project: await getAppProject(deps, caller, name), warnings: answered };
}

/**
 * What a setup check must pass: the admissions of a task start except the model budget (no model runs). The org's GitHub connection must still
 * reach every repository, a cloud org's trial must be unlocked and its month of machine time not used up, and the person must be under the
 * workspace limits; the check then takes a slot (`commitSetupCheck`). Everything is read before anything is written, so a refused check leaves
 * nothing behind.
 */
async function admitSetupCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, definition: Parameters<NonNullable<DeveloperRouteDependencies["requireRepositoriesConnected"]>>[1], limitDefaults: { member: number; organization: number }): Promise<{ charge: WorkspaceCharge; limits: WorkspaceLimits }> {
  if (deps.requireRepositoriesConnected !== undefined) await deps.requireRepositoriesConnected(caller.orgId, definition);
  if (deps.cloud === true) {
    const trial = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
    await admitTrial(trial, caller.orgId);
    await admitMachineTime(trial, caller.orgId);
  }
  const limits = await readWorkspaceLimits(deps.documentClient, deps.tableName, caller.orgId, limitDefaults);
  const charge = developerCharge({ orgId: caller.orgId, teamId: deps.developer.slackTeamId, slackUserId: caller.slackUserId, developerId: caller.developerId });
  const full = await limitReached(deps.documentClient, deps.tableName, charge, limits);
  if (full !== undefined) throw agentXError("WORKSPACE_LIMIT", setupCheckLimitMessage(full, limits));
  return { charge, limits };
}

/**
 * The workspace a new check replaces is closed (its machine and volume deleted, its slot given back) before the new one is admitted, so the new
 * check does not count the old. Best effort: a close that cannot land now is left to the sweep, which closes any check older than 50 minutes.
 */
export async function closeSupersededCheck(deps: DeveloperRouteDependencies, tasks: NonNullable<DeveloperRouteDependencies["tasks"]>, previous: { workspaceId: string; startedAt: string } | undefined, options: { stop?: boolean } = {}): Promise<void> {
  if (previous === undefined) return;
  const started = Date.parse(previous.startedAt);
  try {
    await closeSetupCheck(deps.documentClient, deps.tableName, previous.workspaceId, {
      // TE-4: `stop` ends a check that is still running because a newer save replaced it (a prepare not yet started is failed with its outbox record so nothing starts for it; a running one is failed and its machine deleted); otherwise only a finished or stalled one is closed.
      now: new Date(deps.now()), stalled: Number.isFinite(started) && deps.now() - started > STUCK_SETUP_MS, ...(options.stop === true ? { stop: true } : {}), deleteCompute: (workspace) => tasks.deleteCompute(workspace as WorkspaceInstance),
    });
  } catch (error) {
    logDeveloperEvent({ event: "developer.setup_check_supersede_close_failed", workspaceId: previous.workspaceId, error: error instanceof Error ? error.name : "unknown" });
  }
}

const SETUP_CHECK_ATTEMPTS = 3;
const SETUP_CHECK_BUSY = "a setup check is already running for this project";

/**
 * `POST /v1/app/projects/{name}/setup-check` (Plan 2, Task 22): a maintainer of the project (an org owner or admin, or the project's own
 * maintainer; `setup_check` is theirs alone, so a viewer and a contributor are 403) has the project's setup and test commands run on a fresh
 * workspace of theirs at the latest revision. No access, no project and another org's project are the same 404. The role is read live.
 * A repeated request id answers the stored outcome (200, and starts nothing, even if the project has since been archived or locked); a new one
 * is 202. Refused: an archived project (PROJECT_ARCHIVED), a check already running (409 WORKSPACE_BUSY), a locked trial (TRIAL_LOCKED), used-up
 * machine time (MACHINE_TIME_EXCEEDED), a full workspace limit (WORKSPACE_LIMIT) and an unreachable repository.
 * The workspace, META's `setupCheck` and the request record are one transaction; a cancelled one is read again and judged afresh.
 */
export async function startProjectSetupCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown): Promise<StatusReply> {
  const parsed = ProjectSetupCheckBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  return runSetupCheck(deps, caller, rawName, parsed.data.requestId);
}

/**
 * TE-2: the CANDIDATE check of a test-environment proposal. The same admissions, limits and workspace as the project's own check, but the workspace is prepared from the commands the settings WOULD hold once the
 * proposal's are added (never from the applied settings alone), and the result is stored under the proposal's digest and the settings revision, not in the project's own `setupCheck`. Nothing is written to the settings.
 */
export async function startCandidateSetupCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, input: { requestId: string; digest: string; body: TestEnvironmentBody; origin?: "setup_run" }): Promise<StatusReply> {
  return runSetupCheck(deps, caller, rawName, input.requestId, { digest: input.digest, body: input.body, ...(input.origin === undefined ? {} : { origin: input.origin }) });
}

/**
 * TE-3: the CANDIDATE check of the exact command lists a setup draft would save. The same admissions, limits, workspace and stored result (per project, digest and settings revision) as a test environment's
 * candidate check, but the lists are given (built by the settings save's own rule), not derived from a proposal. `expectedRevision` is the revision the lists were built against: a project whose settings have
 * moved since is refused (PROJECT_REVISION_MISMATCH) and nothing is started. Nothing is written to the settings.
 */
export async function startListsCandidateSetupCheck(
  deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string,
  input: { requestId: string; digest: string; lists: { setup: ProjectCommand[]; readiness: ProjectCommand[]; devcontainer?: { repository: string; configPath?: string } | null | undefined }; expectedRevision: number },
): Promise<StatusReply> {
  return runSetupCheck(deps, caller, rawName, input.requestId, { digest: input.digest, lists: input.lists, expectedRevision: input.expectedRevision });
}

type CandidateInput = { digest: string; origin?: "setup_run" } & ({ body: TestEnvironmentBody } | { lists: { setup: ProjectCommand[]; readiness: ProjectCommand[]; devcontainer?: { repository: string; configPath?: string } | null | undefined }; expectedRevision: number });

async function runSetupCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, requestId: string, candidate?: CandidateInput): Promise<StatusReply> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "setup_check")) throw agentXError("FORBIDDEN", "only a project maintainer can run a setup check");
  const tasks = deps.tasks;
  if (tasks === undefined) throw agentXError("NOT_FOUND", "setup checks are not set up in this deployment");
  const checks = setupCheckDepsOf(deps);
  for (let attempt = 0; attempt < SETUP_CHECK_ATTEMPTS; attempt += 1) {
    // The replay comes before every admission: an id that was used answers what it started, whatever has changed since.
    if (await setupCheckReplay(checks, caller.orgId, name, requestId, caller.developerId) !== undefined) return new StatusReply(200, { project: await getAppProject(deps, caller, name) });
    await requireNewWorkAllowed(deps, caller.orgId, name, role, "setup_check");
    await requirePricedTaskStopAdmission(deps, { orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, workKind: "project-setup-check" });
    const project = await tasks.latestProject(caller.orgId, name);
    if (project === undefined) throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
    const meta = await readProjectMeta(deps, caller.orgId, name);
    // A candidate check is prepared from the lists the proposal would make; the project's own check from the settings as they are.
    if (candidate !== undefined && "expectedRevision" in candidate && project.definition.revision !== candidate.expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", "someone changed this project's settings; reload and try again");
    const lists = candidate === undefined ? undefined : "lists" in candidate ? candidate.lists : candidateListsChecked(candidate.body, project.definition);
    // SU-1 addendum 3: a setup run's proposal is checked at the commits the run used, never at a head read now. With no complete record of them (the marker names another proposal, the run kept no base) the
    // check is not started: a re-run is asked for.
    const runCommits = candidate?.origin === "setup_run" && "body" in candidate
      ? await setupRunCommitsOf({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, caller.orgId, name, candidate.digest, workerProjectDefinition(project.definition).repositories.map((repository) => repository.name)) : undefined;
    if (candidate?.origin === "setup_run" && runCommits === undefined) throw agentXError("CHANGE_STALE", SETUP_PIN_MOVED);
    // The check this one replaces: the project's own, or the candidate record of the same proposal at the same revision.
    const previousCandidate = candidate === undefined ? undefined : await readCandidateCheck(checks, caller.orgId, name, candidate.digest, project.definition.revision);
    const previous = candidate === undefined ? meta?.setupCheck : previousCandidate;
    if ((await setupStateOfCheck(checks, previous, project.definition)).status === "checking") throw agentXError("WORKSPACE_BUSY", SETUP_CHECK_BUSY);
    await closeSupersededCheck(deps, tasks, previous);
    const { charge, limits } = await admitSetupCheck(deps, caller, project.definition, tasks.limitDefaults);
    // The workspace is the caller's own and fresh: an owner key of its own, derived from the caller (as a task's is), so the check never touches
    // a task's workspace or the caller's default one, and re-checking at a newer revision is a new workspace.
    const identity = developerTaskIdentity({ taskId: randomUUID(), developerId: caller.developerId, provider: caller.amr, developerName: caller.name, client: "Rovara app" }, caller.orgId);
    // TE-2: the preparation is sent the candidate lists in place of the settings' own; the revision stays the settings' revision.
    // TE-3: a setup draft's batch may also set the dev container: the commands are proved in the one they will run in.
    const devcontainer = candidate !== undefined && "lists" in candidate ? candidate.lists.devcontainer : undefined;
    // TE-4: a `null` dev container is a change that removes it, so the check runs without one.
    const withoutDevcontainer = { ...project.definition };
    delete withoutDevcontainer.devcontainer;
    const prepared = lists === undefined ? project : { ...project, definition: { ...(devcontainer === null ? withoutDevcontainer : project.definition), setup: lists.setup, readiness: lists.readiness, ...(devcontainer === undefined || devcontainer === null ? {} : { devcontainer }) } };
    const preparation = await tasks.preparation(identity, prepared, requestId, runCommits === undefined ? undefined : { pins: runCommits });
    const committed = await commitSetupCheck(checks, {
      orgId: caller.orgId, project: name, requestId, actorId: caller.developerId, revision: project.definition.revision,
      workspaceId: preparation.workspace.id, createdAt: preparation.workspace.createdAt, preparation: preparation.items, charge, limits, seenWorkspaceId: previous?.workspaceId,
      ...(candidate === undefined || lists === undefined ? {} : { candidate: { digest: candidate.digest, setup: lists.setup, readiness: lists.readiness, ...(candidate.origin === undefined ? {} : { origin: candidate.origin }), ...(preparation.pins === undefined ? {} : { pins: preparation.pins }) } }),
    });
    if (committed) {
      logDeveloperEvent({ event: candidate === undefined ? "developer.project_setup_check_started" : "developer.test_env_candidate_check_started", orgId: caller.orgId, project: name, workspaceId: preparation.workspace.id });
      return new StatusReply(202, { project: await getAppProject(deps, caller, name) });
    }
  }
  throw agentXError("WORKSPACE_BUSY", "AgentX could not start the setup check just now; try again with the same request id");
}
