// TE-4 (owner decision 2026-11-02): the project settings PUT does not write commands with no proof, whoever sends it.
//   A person in a BROWSER session saves at once, as before. Rovara then runs a candidate check of exactly the saved commands and dev container on a fresh machine (the TE-2/TE-3 check), in the background, and
//   makes it the project's own setup check (so the project's check is not run twice). The settings show Proven or Unproven. If the check fails the saver is told (the notifier, and a banner on the settings
//   page) and a maintainer in a browser, signed in within ten minutes, may go back to the last proved setup (a new revision, audited).
//   A change made with an API KEY is HELD: nothing is written. Its check runs, and the change is written only if the check passes at the settings revision it was made against (a race writes nothing).
//   Tasks read the project's latest revision, so a held change is never in a task's prepared definition.
// One check in flight per project; a newer save supersedes an older pending one. The check's result is read live from its workspace; it is acted on (proof recorded, failure announced, held change written)
// by `settleSettingsProof`, which runs whenever the project is read or saved, so no timer is needed and a person looking at the page is what drives it.
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError, AgentXNameSchema, StoredProjectDefinitionSchema, projectRevisionKey, type StoredProjectDefinition, ProjectDefinitionSchema, ProjectSettingsBodySchema, ProjectSettingsUndoBodySchema, agentXError, canonicalJson, projectAllows, settingOriginOf, withSettingOrigins,
  formatCommandLine, type AppProjectDetail, type OrgId, type ProjectCommand, type ProjectOriginField, type ProjectRole, type ProjectSettingsBody, type SettingsHeld, type SettingsProof,
} from "@agentx/contracts";
import { auditedWrite } from "../../playbook/project-settings-audit.js";
import type { TransactItem } from "../../audit/outbox.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditOccurrence, auditProjectSetupRestored } from "../../audit/events.js";
import { readProjectMeta } from "../../developer/project-roles.js";
import { logDeveloperEvent } from "../../developer/log.js";
import { ManagedByFileError, PROJECT_SETTINGS_ADMIN_MANAGED, SETTINGS_STALE_MESSAGE, latestRevision, type LatestRevision } from "../../org/project-settings.js";
import { adoptCandidateAsProjectCheck, setupCheckRecordKey, setupStateOfCheck } from "../../org/project-setup-check.js";
import { readCandidateCheck, type CandidateCheck } from "../../org/test-env-candidate.js";
import {
  PROOF_WORDS, dropWatch, heldAsLists, settingsProofKey, waitingOn, watchedProofs, listsOfDefinition, provenNotNewerThan, readProof, reasonLine, sameProofLists, whileStill, writePart,
  type HeldBody, type HeldChange, type ProofItem, type ProofLists, type SavedProof,
} from "../../org/settings-proof.js";
import { draftCommandLists, draftCommandsDigest, type DraftCommandLists } from "../../rovara-code/setup-draft-check.js";
import { SETUP_CHECK_MAX_AGE_MS } from "../../test-env/prove-from-setup-check.js";
import { testEnvironmentEnabled } from "../../test-env/switch.js";
import { PROJECT_NOT_FOUND_IN_APP, signInStoreOf } from "./common.js";
import { authenticateSession } from "./authentication.js";
import { freshSignInOf } from "./test-environment-wizard.js";
import { setupCheckDepsOf, visibleProjectRoles } from "./project-list.js";
import { closeSupersededCheck, getAppProject, startListsCandidateSetupCheck } from "./project-archive-setup.js";
import { putProjectSettings } from "./project-settings.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";
import type { UpdateProjectSettingsOptions } from "../../org/project-settings.js";

type Result = { project: AppProjectDetail; warnings: string[]; held?: SettingsHeld };
type Fields = Array<"setupCommands" | "testCommands" | "devcontainer">;

/** A held change whose claim is older than this was left by a reader that died between claiming and writing; another reader may take it. */
const CLAIM_MS = 2 * 60_000;
/** A held change whose check has not reported by now is dropped, with a notice. A check is failed at 50 minutes by the sweep; this leaves room for that. */
const HOLD_MAX_MS = 3 * 60 * 60_000;

const storeOf = (deps: DeveloperRouteDependencies) => ({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now });
const nowIso = (deps: DeveloperRouteDependencies) => new Date(deps.now()).toISOString();
const decodeName = (rawName: string): string => {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  return name;
};
const heldFieldsOf = (body: ProjectSettingsBody): Fields => [
  ...(body.setupCommands === undefined ? [] : ["setupCommands" as const]),
  ...(body.testCommands === undefined ? [] : ["testCommands" as const]),
  ...(body.devcontainer === undefined ? [] : ["devcontainer" as const]),
];
/** The Slack user to tell: the one the caller signed in with, else the first Slack sign-in linked to them. None means the banner is the only notice. */
async function slackUserOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<string | undefined> {
  if (caller.slackUserId !== undefined) return caller.slackUserId;
  try { return (await signInStoreOf(deps).slackUserIdsOf(caller.developerId))[0]; } catch { return undefined; }
}
const code = (error: unknown): string | undefined => (error instanceof AgentXError ? error.code : undefined);
const messageOf = (error: unknown): string => (error instanceof AgentXError ? error.message.replace(/^[A-Z_]+: /u, "") : "the check could not be started");

/** The candidate check of `digest` at `revision`, and where it stands. Judged at its own revision, so a later revision that changed nothing about the commands does not make it outdated. */
async function checkOf(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, digest: string, revision: number): Promise<{ check: CandidateCheck | undefined; state: Awaited<ReturnType<typeof setupStateOfCheck>> }> {
  const checks = setupCheckDepsOf(deps);
  const check = await readCandidateCheck(checks, orgId, name, digest, revision);
  if (check === undefined) return { check, state: { status: "unchecked" } };
  return { check, state: await setupStateOfCheck(checks, check, { revision: check.revision, setup: check.setup, readiness: check.readiness }) };
}

/** The dev container a check is prepared with: as the lists carry it. */
const draftListsOf = (lists: ProofLists | HeldChange["lists"]): DraftCommandLists => ({
  setup: lists.setup, readiness: lists.readiness,
  ...(lists.devcontainer === undefined ? {} : lists.devcontainer === null ? { devcontainer: null } : { devcontainer: { repository: lists.devcontainer.repository, ...(lists.devcontainer.configPath === undefined ? {} : { configPath: lists.devcontainer.configPath }) } }),
});

/** Closes the workspace of a check that is no longer wanted (best effort: the sweep closes any check older than 50 minutes). */
async function closeWorkspace(deps: DeveloperRouteDependencies, part: { workspaceId?: string | undefined; startedAt?: string | undefined } | undefined): Promise<void> {
  if (part?.workspaceId === undefined || part.startedAt === undefined || deps.tasks === undefined) return;
  await closeSupersededCheck(deps, deps.tasks, { workspaceId: part.workspaceId, startedAt: part.startedAt }, { stop: true });
}

/**
 * Starts the candidate check of `lists` at `revision` and answers the stored record, or the reason it did not start. Never throws an AgentXError (the save it follows has been made); anything else is a bug and goes up.
 */
async function startCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, name: string, lists: DraftCommandLists, revision: number): Promise<{ digest: string; checkRequestId: string; check: CandidateCheck } | { digest: string; checkRequestId: string; reason: string }> {
  const digest = draftCommandsDigest(lists);
  const checkRequestId = randomUUID();
  try {
    await startListsCandidateSetupCheck(deps, caller, encodeURIComponent(name), { requestId: checkRequestId, digest, lists, expectedRevision: revision });
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    logDeveloperEvent({ event: "developer.settings_proof_check_not_started", orgId: caller.orgId, project: name, code: error.code });
    return { digest, checkRequestId, reason: reasonLine(error.code === "WORKSPACE_BUSY" ? PROOF_WORDS.heldBusy : messageOf(error)) ?? PROOF_WORDS.notStarted };
  }
  const check = await readCandidateCheck(setupCheckDepsOf(deps), caller.orgId, name, digest, revision);
  return check === undefined ? { digest, checkRequestId, reason: PROOF_WORDS.notStarted } : { digest, checkRequestId, check };
}

// ---- settling: what a finished check means

/**
 * The person a held change is written as: who sent it, as that sign-in stands NOW. The key's session must be live (not revoked or expired), the developer not revoked, the sign-in method still allowed and the person
 * still in the organization, with the role they hold today (`authenticateSession`, the check every request makes). Undefined otherwise: the change is then never written. Whether they may still edit this project's
 * settings is the settings save's own check, made when it is written.
 */
async function heldCaller(deps: DeveloperRouteDependencies, orgId: OrgId, held: HeldChange): Promise<DeveloperCaller | undefined> {
  try {
    const caller = await authenticateSession(deps, { developerId: held.by, sessionId: held.sessionId, amr: held.amr as DeveloperCaller["amr"] });
    return caller.orgId === orgId ? caller : undefined;
  } catch (error) {
    if (error instanceof AgentXError) return undefined;
    throw error;
  }
}

/** The definition stored at one revision, if it reads. */
async function definitionAt(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, revision: number): Promise<StoredProjectDefinition | undefined> {
  const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectRevisionKey(orgId, name, revision), ConsistentRead: true }))) as { Item?: { definition?: unknown } }).Item;
  const parsed = StoredProjectDefinitionSchema.safeParse(item?.definition);
  return parsed.success ? parsed.data : undefined;
}

/** A held change that ended without being written: the state, why, and the mark that makes the notifier tell the person who sent it. */
const endedHeld = (deps: DeveloperRouteDependencies, held: HeldChange, status: HeldChange["status"], reason: string | undefined): HeldChange => ({ ...held, status, ...(reason === undefined ? {} : { reason }), noticeAt: nowIso(deps) });

/** Commits with the held change's write only while that change is still the one being applied: a newer change that replaced it makes this write land nowhere. */
const heldGuard = (deps: DeveloperRouteDependencies, orgId: OrgId, name: string, held: HeldChange): TransactItem => ({ ConditionCheck: {
  TableName: deps.tableName, Key: settingsProofKey(orgId, name),
  ConditionExpression: "#held.checkRequestId = :guardId AND #held.#guardStatus = :guardStatus",
  ExpressionAttributeNames: { "#held": "held", "#guardStatus": "status" },
  ExpressionAttributeValues: { ":guardId": held.checkRequestId, ":guardStatus": "applying" },
} });

async function recordProven(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, lists: ProofLists, revision: number): Promise<void> {
  const provenAt = nowIso(deps);
  await writePart(storeOf(deps), orgId, name, "proven", { setup: lists.setup, readiness: lists.readiness, ...(lists.devcontainer === undefined ? {} : { devcontainer: lists.devcontainer }), revision, provenAt }, provenNotNewerThan(provenAt));
}

/** The held change whose check passed: written as the person who sent it, at the revision it was made against, or not at all. */
async function applyHeld(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, held: HeldChange, check: CandidateCheck): Promise<void> {
  const store = storeOf(deps);
  const claimedAt = nowIso(deps);
  // One reader writes it: the claim holds only while the change is still waiting, or its claim was left long ago.
  const claimed = await writePart(store, orgId, name, "held", { ...held, status: "applying", claimedAt }, held.status === "applying"
    ? { expression: "#part.checkRequestId = :guardId AND #part.#guardStatus = :guardStatus AND #part.claimedAt = :claimed", names: { "#guardStatus": "status" }, values: { ":guardId": held.checkRequestId, ":guardStatus": "applying", ":claimed": held.claimedAt ?? "" } }
    : whileStill(held.checkRequestId, "checking"));
  if (!claimed) return;
  const applying: HeldChange = { ...held, status: "applying", claimedAt };
  const end = (status: HeldChange["status"], reason?: string) => writePart(store, orgId, name, "held", status === "applied" ? { ...applying, status } : endedHeld(deps, applying, status, reason), whileStill(held.checkRequestId, "applying"));
  const caller = await heldCaller(deps, orgId, held);
  if (caller === undefined) { await end("refused", PROOF_WORDS.heldGone); return; }
  const body = { requestId: held.requestId, expectedRevision: held.baseRevision, ...held.body } as ProjectSettingsBody;
  const writtenRevision = held.baseRevision + 1;
  /** What the revision this change wrote holds is what was held, and nothing else was recorded in its place. */
  const isTheChange = (definition: StoredProjectDefinition | undefined): definition is StoredProjectDefinition => definition !== undefined && sameProofLists(listsOfDefinition(definition), heldAsLists(held.lists, listsOfDefinition(definition)));
  try {
    await putProjectSettings(deps, caller, encodeURIComponent(name), body, { guardItems: [heldGuard(deps, orgId, name, applying)] });
    // The revision this very write made, not whatever is latest by now: a save that landed after it is not what was checked.
    const written = await definitionAt(deps, orgId, name, writtenRevision);
    if (!isTheChange(written)) { await end("refused", PROOF_WORDS.heldRefused); return; }
    await recordProven(deps, orgId, name, listsOfDefinition(written), writtenRevision);
    // The check ran exactly what was written: it is the project's own check at the new revision, so the project's check is not run twice.
    await adoptCandidateAsProjectCheck(setupCheckDepsOf(deps), { orgId, project: name, workspaceId: check.workspaceId, startedAt: check.startedAt, actorId: held.by, revision: writtenRevision });
    await end("applied");
  } catch (error) {
    if (code(error) === "PROJECT_REVISION_MISMATCH") {
      // The revision moved: nothing is written unless a repeat of this very write already landed (the claim was taken over after a reader died).
      const landed = isTheChange(await definitionAt(deps, orgId, name, writtenRevision));
      if (landed) {
        const written = (await definitionAt(deps, orgId, name, writtenRevision))!;
        await recordProven(deps, orgId, name, listsOfDefinition(written), writtenRevision);
      }
      await end(landed ? "applied" : "stale", landed ? undefined : PROOF_WORDS.heldStale);
      return;
    }
    logDeveloperEvent({ event: "developer.settings_proof_held_refused", orgId, project: name, code: code(error) ?? (error instanceof Error ? error.name : "unknown") });
    await end("refused", reasonLine(code(error) === undefined ? PROOF_WORDS.heldRefused : messageOf(error)) ?? PROOF_WORDS.heldRefused);
  }
}

/**
 * Acts on what the checks have become: a passed browser save is recorded as the last proved setup, a failed one is announced to the person who saved it, a held change whose check passed is written (and one
 * whose check failed, or whose revision moved, is dropped). Safe to run at any time and from any reader: every step is conditional on the state it read. Never throws; a failure is logged and the next read tries again.
 */
export async function settleSettingsProof(deps: DeveloperRouteDependencies, orgId: OrgId, name: string): Promise<boolean> {
  let acted = false;
  try {
    const store = storeOf(deps);
    const proof = await readProof(store, orgId, name);
    const latest = await latestRevision(store, orgId, name);
    if (latest === undefined) return false;
    const current = listsOfDefinition(latest.definition);
    const { saved } = proof ?? {};
    if (saved?.status === "checking") {
      const { check, state } = await checkOf(deps, orgId, name, saved.digest, saved.revision);
      if (check === undefined) { acted = true; await writePart(store, orgId, name, "saved", { ...saved, status: "not_started", reason: PROOF_WORDS.notStarted }, whileStill(saved.checkRequestId, "checking")); }
      else if (state.status === "ready") {
        acted = true;
        await recordProven(deps, orgId, name, saved, saved.revision);
        // Only the part this reader read is replaced: a newer save (a different check id) is left alone.
        await writePart(store, orgId, name, "saved", { ...saved, status: "proven" }, whileStill(saved.checkRequestId, "checking"));
      } else if (state.status === "failed") {
        acted = true;
        await writePart(store, orgId, name, "saved", { ...saved, status: "failed", reason: reasonLine(state.failedStep) ?? PROOF_WORDS.failed, noticeAt: nowIso(deps) }, whileStill(saved.checkRequestId, "checking"));
      }
    }
    // The project's own check at the revision in force (a check the person pressed, or an adopted one) proves what it ran.
    const meta = await readProjectMeta(store, orgId, name);
    if (meta?.setupCheck !== undefined && meta.setupCheck.revision === latest.definition.revision && (proof?.proven === undefined || !sameProofLists(proof.proven, current))) {
      const own = await setupStateOfCheck(setupCheckDepsOf(deps), meta.setupCheck, latest.definition);
      if (own.status === "ready") { acted = true; await recordProven(deps, orgId, name, current, latest.definition.revision); }
    }
    const held = proof?.held;
    if (held !== undefined && (held.status === "checking" || (held.status === "applying" && Date.parse(held.claimedAt ?? "") + CLAIM_MS < deps.now()))) {
      const drop = async (status: HeldChange["status"], reason: string) => { acted = true; await writePart(store, orgId, name, "held", endedHeld(deps, held, status, reason), whileStill(held.checkRequestId, held.status)); };
      if (latest.definition.revision !== held.baseRevision) {
        await drop("stale", PROOF_WORDS.heldStale);
        await closeWorkspace(deps, held);
        return acted;
      }
      const { check, state } = await checkOf(deps, orgId, name, held.digest, held.baseRevision);
      if (check === undefined) await drop("not_started", PROOF_WORDS.heldNotStarted);
      else if (state.status === "failed") await drop("failed", reasonLine(state.failedStep) ?? PROOF_WORDS.heldFailed);
      else if (state.status === "ready") {
        // The check must have run exactly what is held (the lists, and the dev container through the digest it was stored under), recently, at this revision; anything else is never written.
        const checkedAt = Date.parse(check.startedAt);
        const exact = sameProofLists({ setup: check.setup, readiness: check.readiness }, { setup: held.lists.setup, readiness: held.lists.readiness })
          && draftCommandsDigest(draftListsOf(held.lists)) === check.digest && check.revision === held.baseRevision
          && Number.isFinite(checkedAt) && deps.now() - checkedAt <= SETUP_CHECK_MAX_AGE_MS;
        if (exact) { acted = true; await applyHeld(deps, orgId, name, held, check); }
        else await drop("failed", PROOF_WORDS.heldFailed);
      } else if (deps.now() - Date.parse(held.heldAt) > HOLD_MAX_MS) {
        // A held change does not wait for ever: past this its check should long have reported, and the person who sent it is told.
        await drop("failed", PROOF_WORDS.heldTimedOut);
        await closeWorkspace(deps, held);
      }
    }
  } catch (error) {
    logDeveloperEvent({ event: "developer.settings_proof_settle_failed", orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
  }
  return acted;
}

/**
 * The broker's hook (aws/developer-routes/settings-proof-hook.ts): a setup check's prepare has reported and its workspace is closed. The check record names the project, and its proof is settled now, so a held change
 * is written (or dropped) and a failed save's message is sent without waiting for anyone to open the page. A workspace that is not a check, or a check of no project's settings, settles nothing.
 */
export async function settleSettingsProofOfCheck(routeDeps: () => DeveloperRouteDependencies | undefined, workspaceId: string): Promise<void> {
  const deps = routeDeps();
  if (deps === undefined) return;
  const record = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: setupCheckRecordKey(workspaceId), ConsistentRead: true }))) as { Item?: { orgId?: unknown; project?: unknown } }).Item;
  if (typeof record?.orgId !== "string" || typeof record.project !== "string") return;
  await settleSettingsProof(deps, record.orgId, record.project);
}

/**
 * The periodic settle (the broker's every-minute recovery run): every project with a check being waited on is settled, so a check that ended without a result callback (the 50-minute sweep, a prepare that could
 * not be dispatched, a cancel), or a held change whose check never reported, is acted on and its sender told without anyone opening the page. Bounded: at most `limit` projects and `budgetMs`, oldest first; a
 * project whose checks are all settled leaves the watch. Never throws.
 */
export async function sweepSettingsProofs(routeDeps: () => DeveloperRouteDependencies | undefined, options: { limit?: number; budgetMs?: number } = {}): Promise<{ settled: number; left: number }> {
  const deps = routeDeps();
  if (deps === undefined) return { settled: 0, left: 0 };
  const store = storeOf(deps);
  const deadline = Date.now() + (options.budgetMs ?? 5_000);
  let settled = 0;
  let left = 0;
  try {
    for (const { orgId, project } of await watchedProofs(store, options.limit ?? 25)) {
      if (settled > 0 && Date.now() >= deadline) { left += 1; continue; }
      await settleSettingsProof(deps, orgId, project);
      settled += 1;
      if (!waitingOn(await readProof(store, orgId, project))) await dropWatch(store, orgId, project);
      else left += 1;
    }
  } catch (error) {
    logDeveloperEvent({ event: "developer.settings_proof_sweep_failed", error: error instanceof Error ? error.name : "unknown" });
  }
  return { settled, left };
}

// ---- what the page is told

function heldOf(held: HeldChange | undefined): SettingsHeld | undefined {
  if (held === undefined || held.status === "applied") return undefined;
  const status = held.status === "applying" ? "checking" : held.status;
  const reason = status === "checking" ? undefined : status === "failed" ? held.reason ?? PROOF_WORDS.heldFailed : status === "stale" ? PROOF_WORDS.heldStale : status === "not_started" ? held.reason ?? PROOF_WORDS.heldNotStarted : held.reason ?? PROOF_WORDS.heldRefused;
  return { status, fields: held.fields, heldAt: held.heldAt, ...(reason === undefined ? {} : { reason }) };
}

/** Whether the commands now in the settings are proved, and what a maintainer may do about it. */
async function proofOf(deps: DeveloperRouteDependencies, orgId: OrgId, name: string, role: ProjectRole, latest: LatestRevision): Promise<SettingsProof> {
  const store = storeOf(deps);
  const proof: ProofItem = (await readProof(store, orgId, name)) ?? {};
  const current = listsOfDefinition(latest.definition);
  const meta = await readProjectMeta(store, orgId, name);
  const matching = proof.saved !== undefined && sameProofLists(proof.saved, current) ? proof.saved : undefined;
  const provenNow = proof.proven !== undefined && sameProofLists(proof.proven, current);
  const own = meta?.setupCheck !== undefined && meta.setupCheck.revision === latest.definition.revision ? await setupStateOfCheck(setupCheckDepsOf(deps), meta.setupCheck, latest.definition) : undefined;
  let status: SettingsProof["status"] = "unproven";
  let reason: string | undefined = PROOF_WORDS.notChecked;
  if (matching?.status === "checking") { status = "checking"; reason = undefined; }
  else if (matching?.status === "failed") reason = matching.reason ?? PROOF_WORDS.failed;
  else if (matching?.status === "not_started") reason = matching.reason ?? PROOF_WORDS.notStarted;
  else if (matching?.status === "superseded") reason = PROOF_WORDS.superseded;
  else if (own?.status === "failed") reason = reasonLine(own.failedStep) ?? PROOF_WORDS.failed;
  else if (own?.status === "checking") { status = "checking"; reason = undefined; }
  else if (provenNow || own?.status === "ready" || matching?.status === "proven") { status = "proven"; reason = undefined; }
  const maintainer = projectAllows(role, "edit_settings");
  const canUndo = proof.proven !== undefined && !sameProofLists(proof.proven, current) && maintainer;
  // The banner is for the people who can act on it; who saved is not shown to the rest.
  const failed = maintainer && matching?.status === "failed" ? matching : undefined;
  const held = heldOf(proof.held);
  return {
    status, canUndo,
    ...(status === "proven" && proof.proven !== undefined && provenNow ? { provenAt: proof.proven.provenAt } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(proof.proven === undefined ? {} : { lastProvenAt: proof.proven.provenAt }),
    ...(failed === undefined ? {} : { notice: { message: proof.proven === undefined ? PROOF_WORDS.failedNoUndo : PROOF_WORDS.failedWithUndo, at: failed.noticeAt ?? failed.savedAt, savedBy: failed.byName } }),
    ...(held === undefined ? {} : { held }),
  };
}

/** `GET /v1/app/projects/{name}` with the settings' proof: first settles what the checks have become, then reads the project. */
export async function getAppProjectWithProof(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<AppProjectDetail> {
  const name = decodeName(rawName);
  const first = await getAppProject(deps, caller, name);
  // Only a deployment that can run a check has anything to say about proof.
  if (deps.tasks === undefined) return first;
  // The project is read again only when settling changed something (a held change written, a check adopted).
  const project = await settleSettingsProof(deps, caller.orgId, name) ? await getAppProject(deps, caller, name) : first;
  const latest = await latestRevision(storeOf(deps), caller.orgId, name);
  if (latest === undefined) return project;
  try { return { ...project, settingsProof: await proofOf(deps, caller.orgId, name, project.myRole, latest) }; } catch (error) {
    logDeveloperEvent({ event: "developer.settings_proof_read_failed", orgId: caller.orgId, project: name, error: error instanceof Error ? error.name : "unknown" });
    return project;
  }
}

// ---- the PUT

/**
 * `PUT /v1/app/projects/{name}/settings` with TE-4's proof. A body that changes no commands and no dev container goes through `putProjectSettings` untouched. One that does is saved at once for a person in a browser
 * session (and checked in the background), and held for any other caller (and checked before it is written).
 */
export async function putProjectSettingsChecked(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, rawBody: unknown, options: UpdateProjectSettingsOptions = {}): Promise<Result> {
  const plain = async (): Promise<Result> => {
    const done = await putProjectSettings(deps, caller, rawName, rawBody, options);
    return { ...done, project: deps.tasks === undefined ? done.project : await getAppProjectWithProof(deps, caller, rawName) };
  };
  const parsed = ProjectSettingsBodySchema.safeParse(rawBody);
  // A body that is not valid, an install that does not change projects here (another install's are changed by an administrator) and a deployment with no settings save are the save's own refusals.
  if (!parsed.success || deps.projectSettings === undefined || deps.cloud !== true) return plain();
  const body = parsed.data;
  const fields = heldFieldsOf(body);
  if (fields.length === 0) return plain();
  // Who may change settings, and that the project exists, are the settings save's own refusals, in its own order.
  const name = decodeName(rawName);
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) return plain();
  if (!projectAllows(role, "edit_settings")) return plain();
  const store = storeOf(deps);
  const latest = await latestRevision(store, caller.orgId, name);
  if (latest === undefined || latest.definition.revision !== body.expectedRevision) return plain();
  const current = latest.definition;
  const changesRepositories = body.addRepositories !== undefined || body.removeRepositories !== undefined;
  // Never the old save once commands or the dev container are in the body: whatever else is wrong with it, the save refuses it in its own words, with a check of what is saved, or a hold.
  if (caller.browserSession !== true) {
    // A key's commands are held against the repositories the project has now; a body that also changes them cannot be checked as one piece.
    if (changesRepositories) throw agentXError("CONFIG_INVALID", PROOF_WORDS.needsOwnRequest);
    // An unreadable command or a dev container that is not a repository of the project is the save's own CONFIG_INVALID, raised here.
    const lists = draftCommandLists(current, body);
    const before = listsOfDefinition(current);
    const after: ProofLists = { setup: lists.setup, readiness: lists.readiness, ...(lists.devcontainer === undefined ? (before.devcontainer === undefined ? {} : { devcontainer: before.devcontainer }) : lists.devcontainer === null ? {} : { devcontainer: lists.devcontainer }) };
    // The commands and the dev container the save would store are the ones already there: nothing to prove.
    if (sameProofLists(before, after)) return plain();
    return heldSave(deps, caller, rawName, name, body, fields, latest);
  }
  // UX-4b review I1 (owner decision 11): where the test environment is on, setup and test commands are proved in its sandbox before they are used, so a browser save that changes them is refused
  // here, the server's own rule, whatever the page is. The commands go to `POST .../setup-draft/typed` (the person's edited proposal: check, Prove, Approve). A body whose commands are what is there goes on.
  // Review R3: compared as the lines a person sees and sends (a stored command's own timeout or env is not on its line), so a page that resends the commands unchanged beside a dev container change goes on.
  if (testEnvironmentEnabled()) {
    const sameLines = (sent: readonly string[] | undefined, stored: readonly ProjectCommand[]) => sent === undefined || (sent.length === stored.length && sent.every((line, index) => line.trim() === formatCommandLine(stored[index]!)));
    if (!sameLines(body.setupCommands, current.setup) || !sameLines(body.testCommands, current.readiness)) throw agentXError("CONFIG_INVALID", PROOF_WORDS.provedInTestEnvironment);
    // Review R4: the lines are the stored ones, so the stored commands are kept exactly (their own timeout and env): the lines are not saved again, which would re-parse them with the defaults.
    if (body.setupCommands !== undefined || body.testCommands !== undefined) {
      const { setupCommands: _setup, testCommands: _tests, ...rest } = rawBody as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
      return putProjectSettingsChecked(deps, caller, rawName, rest, options);
    }
  }
  // A browser saves what it sent; what was saved is compared with what was there, after the save (a repository change can move where commands run).
  return browserSave(deps, caller, rawName, name, rawBody, options);
}

/** A person in a browser: saved at once; the check of exactly what was saved starts, and is the project's own check. */
async function browserSave(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, name: string, rawBody: unknown, options: UpdateProjectSettingsOptions): Promise<Result> {
  if (deps.tasks === undefined) {
    // No check can be run here: the save is made as always, and the page says it is unproven.
    return { ...await putProjectSettings(deps, caller, rawName, rawBody, options) };
  }
  // What was proved before this save is recorded first, so going back has something to go back to.
  await settleSettingsProof(deps, caller.orgId, name);
  const store = storeOf(deps);
  const before = await readProof(store, caller.orgId, name);
  const previous = await latestRevision(store, caller.orgId, name);
  const done = await putProjectSettings(deps, caller, rawName, rawBody, options);
  const saved = await latestRevision(store, caller.orgId, name);
  // A save that raced this one and moved the revision on is the one that gets a check; one that left the commands and the dev container as they were has nothing to prove.
  if (saved !== undefined && saved.definition.revision === done.project.latestRevision && (previous === undefined || !sameProofLists(listsOfDefinition(previous.definition), listsOfDefinition(saved.definition)))) {
    // One check in flight per project: the earlier ones are stopped.
    const meta = await readProjectMeta(store, caller.orgId, name);
    await closeWorkspace(deps, before?.saved?.status === "checking" ? before.saved : undefined);
    if (before?.held?.status === "checking") {
      await closeWorkspace(deps, before.held);
      await writePart(store, caller.orgId, name, "held", endedHeld(deps, before.held, "stale", PROOF_WORDS.heldStale), whileStill(before.held.checkRequestId, "checking"));
    }
    if (meta?.setupCheck !== undefined && meta.setupCheck.workspaceId !== before?.saved?.workspaceId) await closeSupersededCheck(deps, deps.tasks, meta.setupCheck, { stop: true });
    const lists = listsOfDefinition(saved.definition);
    const slackUser = await slackUserOf(deps, caller);
    const started = await startCheck(deps, caller, name, draftListsOf(lists), saved.definition.revision);
    const base: Omit<SavedProof, "status"> = {
      ...lists, revision: saved.definition.revision, digest: started.digest, checkRequestId: started.checkRequestId, by: caller.developerId, byName: caller.name,
      ...(slackUser === undefined ? {} : { slackUserId: slackUser }), savedAt: nowIso(deps),
    };
    if ("check" in started) {
      await writePart(store, caller.orgId, name, "saved", { ...base, status: "checking", workspaceId: started.check.workspaceId, startedAt: started.check.startedAt });
      await adoptCandidateAsProjectCheck(setupCheckDepsOf(deps), { orgId: caller.orgId, project: name, workspaceId: started.check.workspaceId, startedAt: started.check.startedAt, actorId: caller.developerId, revision: saved.definition.revision });
    } else {
      await writePart(store, caller.orgId, name, "saved", { ...base, status: "not_started", reason: started.reason });
    }
  }
  return { project: await getAppProjectWithProof(deps, caller, rawName), warnings: done.warnings };
}

/** An API key: nothing is written. The change is held, its check is started, and it is written only when the check passes. */
async function heldSave(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, name: string, body: ProjectSettingsBody, fields: Fields, latest: LatestRevision): Promise<Result> {
  if (deps.tasks === undefined) throw agentXError("RUNTIME_UNAVAILABLE", PROOF_WORDS.noCheck);
  const store = storeOf(deps);
  const current = latest.definition;
  // The refusals the save itself would make are made now, so a change that could never be written is not held.
  if (body.addRepositories !== undefined || body.removeRepositories !== undefined) throw agentXError("CONFIG_INVALID", PROOF_WORDS.needsOwnRequest);
  // An archived project and an end-to-end policy are refused by the save itself, in its words.
  if ((await readProjectMeta(store, caller.orgId, name))?.status === "archived" || current.e2e !== undefined || latest.setupApproval !== undefined) return { ...await putProjectSettings(deps, caller, rawName, body) };
  const touched: ProjectOriginField[] = [...(body.setupCommands === undefined ? [] : ["setup" as const]), ...(body.testCommands === undefined ? [] : ["readiness" as const]), ...(body.devcontainer === undefined ? [] : ["devcontainer" as const])];
  const managed = touched.filter((field) => settingOriginOf(current, field) === "file");
  if (managed.length > 0) throw new ManagedByFileError(managed);

  await settleSettingsProof(deps, caller.orgId, name);
  const proof = (await readProof(store, caller.orgId, name)) ?? {};
  // The same request again: what it started goes on (a repeat starts no second check).
  if (proof.held !== undefined && proof.held.requestId === body.requestId) return { project: await getAppProjectWithProof(deps, caller, rawName), warnings: [], ...(heldOf(proof.held) === undefined ? {} : { held: heldOf(proof.held)! }) };
  // A browser save under its check is the settings now; a held change waits for it rather than racing it. So does a held change being written this moment: it is not replaced under its writer.
  if (proof.saved?.status === "checking") throw agentXError("WORKSPACE_BUSY", PROOF_WORDS.heldBusy);
  if (proof.held?.status === "applying" && Date.parse(proof.held.claimedAt ?? "") + CLAIM_MS >= deps.now()) throw agentXError("WORKSPACE_BUSY", PROOF_WORDS.heldBusy);

  // Everything else the request asks for changes as it always did, at once.
  const rest: Record<string, unknown> = { requestId: body.requestId, expectedRevision: body.expectedRevision };
  for (const key of ["description", "allowedDomains"] as const) if (body[key] !== undefined) rest[key] = body[key];
  let warnings: string[] = [];
  let baseRevision = current.revision;
  let definition = current;
  if (Object.keys(rest).length > 2) {
    const done = await putProjectSettings(deps, caller, rawName, rest);
    warnings = done.warnings;
    const moved = await latestRevision(store, caller.orgId, name);
    if (moved !== undefined) { baseRevision = moved.definition.revision; definition = moved.definition; }
  }
  const heldLists = draftCommandLists(definition, body);
  const started = await startCheck(deps, caller, name, heldLists, baseRevision);
  const slackUser = await slackUserOf(deps, caller);
  const held: HeldChange = {
    requestId: body.requestId, checkRequestId: started.checkRequestId, digest: started.digest, by: caller.developerId, byName: caller.name, amr: caller.amr, sessionId: caller.sessionId,
    ...(slackUser === undefined ? {} : { slackUserId: slackUser }), heldAt: nowIso(deps), baseRevision, fields,
    body: { ...(body.setupCommands === undefined ? {} : { setupCommands: body.setupCommands }), ...(body.testCommands === undefined ? {} : { testCommands: body.testCommands }), ...(body.devcontainer === undefined ? {} : { devcontainer: body.devcontainer }) } satisfies HeldBody,
    lists: { setup: heldLists.setup, readiness: heldLists.readiness, ...(heldLists.devcontainer === undefined ? {} : { devcontainer: heldLists.devcontainer }) },
    status: "checking",
  };
  if (!("check" in started)) {
    // Not held: nothing is stored, and the person is told it did not start.
    const reply: SettingsHeld = { status: "not_started", fields, heldAt: held.heldAt, reason: started.reason };
    return { project: await getAppProjectWithProof(deps, caller, rawName), warnings, held: reply };
  }
  // The earlier held change is superseded, unless it began to be written since it was read: then this change is not held and the person sends it again.
  const replaced = proof.held === undefined
    ? { expression: "attribute_not_exists(#part)", values: {} }
    : { expression: "#part.checkRequestId = :guardId AND #part.#guardStatus <> :guardApplying", names: { "#guardStatus": "status" }, values: { ":guardId": proof.held.checkRequestId, ":guardApplying": "applying" } };
  if (!await writePart(store, caller.orgId, name, "held", { ...held, workspaceId: started.check.workspaceId, startedAt: started.check.startedAt }, replaced)) {
    await closeWorkspace(deps, started.check);
    throw agentXError("WORKSPACE_BUSY", PROOF_WORDS.heldBusy);
  }
  // Its check is stopped: one check in flight per project.
  if (proof.held?.status === "checking") await closeWorkspace(deps, proof.held);
  return { project: await getAppProjectWithProof(deps, caller, rawName), warnings, held: heldOf({ ...held })! };
}

// ---- going back

/**
 * `POST /v1/app/projects/{name}/settings/undo`: writes the last proved setup back as a new revision. A project maintainer, in a browser session, signed in within the last ten minutes; audited. When no setup was
 * ever proved there is nothing to go back to and nothing is offered.
 */
export async function undoToProvenSetup(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, rawBody: unknown): Promise<Result> {
  const name = decodeName(rawName);
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", PROOF_WORDS.undoMaintainer);
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", PROOF_WORDS.undoBrowser);
  if (await freshSignInOf(deps, caller) === undefined) throw agentXError("REAUTH_REQUIRED", PROOF_WORDS.undoSignIn);
  const parsed = ProjectSettingsUndoBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const body = parsed.data;
  if (deps.projectSettings === undefined) throw agentXError("NOT_FOUND", "project settings are not set up in this deployment");
  const store = storeOf(deps);
  if ((await readProjectMeta(store, caller.orgId, name))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", "this project is archived; restore it first");
  await settleSettingsProof(deps, caller.orgId, name);
  const proof = await readProof(store, caller.orgId, name);
  // The same press again answers what it did.
  if (proof?.lastUndo?.requestId === body.requestId) return { project: await getAppProjectWithProof(deps, caller, rawName), warnings: [] };
  if (proof?.proven === undefined) throw agentXError("CONFIG_INVALID", PROOF_WORDS.undoNone);
  const latest = await latestRevision(store, caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  const current = latest.definition;
  if (current.revision !== body.expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
  if (current.e2e !== undefined || latest.setupApproval !== undefined) throw agentXError("FORBIDDEN", PROJECT_SETTINGS_ADMIN_MANAGED);
  const proven = proof.proven;
  if (sameProofLists(proven, listsOfDefinition(current))) return { project: await getAppProjectWithProof(deps, caller, rawName), warnings: [] };
  const fieldsBack: ProjectOriginField[] = ["setup", "readiness", "devcontainer"];
  const restored: Record<ProjectOriginField & ("setup" | "readiness" | "devcontainer"), unknown> = { setup: proven.setup, readiness: proven.readiness, devcontainer: proven.devcontainer };
  const changing = fieldsBack.filter((field) => canonicalJson((current as Record<string, unknown>)[field] ?? null) !== canonicalJson(restored[field as "setup" | "readiness" | "devcontainer"] ?? null));
  // A setting the meta repo's config file manages is changed by changing the file.
  const managed = changing.filter((field) => settingOriginOf(current, field) === "file");
  if (managed.length > 0) throw new ManagedByFileError(managed);
  const next: Record<string, unknown> = { ...current, revision: current.revision + 1, setup: proven.setup, readiness: proven.readiness };
  if (proven.devcontainer === undefined) delete next.devcontainer; else next.devcontainer = proven.devcontainer;
  // The setup being restored must still fit the project: its repositories are there.
  const repositories = current.repositories;
  const inside = (cwd: string) => repositories.some((repository) => cwd === repository.path || cwd.startsWith(`${repository.path}/`));
  if (![...proven.setup, ...proven.readiness].every((command) => inside(command.cwd)) || (proven.devcontainer !== undefined && !repositories.some((repository) => repository.name === proven.devcontainer!.repository))) {
    throw agentXError("CONFIG_INVALID", "A repository of this project changed since that setup was proved, so it cannot be restored. Change the commands by hand.");
  }
  const origins = withSettingOrigins(current.origins, changing, "person");
  if (origins === undefined) delete next.origins; else next.origins = origins;
  const definition = ProjectDefinitionSchema.safeParse(next);
  if (!definition.success) throw agentXError("CONFIG_INVALID", `${definition.error.issues[0]?.path.join(".") || "body"}: ${definition.error.issues[0]?.message ?? "invalid"}`);
  const audit = await auditedWrite(deps.audit === undefined ? {} : { audit: deps.audit }, () => [auditProjectSetupRestored({
    orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: nowIso(deps), occurrence: auditOccurrence(name, String(definition.data.revision)),
    projectName: name, revision: definition.data.revision, fromRevision: current.revision, provenRevision: proven.revision,
  })]);
  try {
    await deps.projectSettings.registerRevision({ orgId: caller.orgId, ownerKey: caller.developerId }, { definition: definition.data, runtimeBinding: latest.runtimeBinding }, audit.items);
  } catch (error) {
    if (code(error) === "PROJECT_REVISION_MISMATCH") throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
    throw error;
  }
  if (deps.audit !== undefined) await flushAuditEvents({ audit: deps.audit }, audit.events);
  // The restored setup is the one that was proved; a check still running for the failed save is stopped.
  if (proof.saved?.status === "checking") { await closeWorkspace(deps, proof.saved); await writePart(store, caller.orgId, name, "saved", { ...proof.saved, status: "superseded" }, whileStill(proof.saved.checkRequestId, "checking")); }
  await writePart(store, caller.orgId, name, "lastUndo", { requestId: body.requestId, revision: definition.data.revision, at: nowIso(deps) });
  logDeveloperEvent({ event: "developer.project_setup_restored", orgId: caller.orgId, project: name, revision: String(definition.data.revision) });
  return { project: await getAppProjectWithProof(deps, caller, rawName), warnings: [] };
}
