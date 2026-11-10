import { META_FEATURE_MISSING } from "../meta-repo/prepare-meta.js";
import { REGISTRY_FEATURE_MISSING } from "../project-registries/prepare.js";
import { nonLegacyCredentialKindsOfGrant } from "../repository-access.js";
import {
  AGENT_RUN_FEATURE,
  AGENT_STEP_FEATURE,
  AGENT_WORKER_OUTDATED,
  LEARNED_CONTEXT_FEATURE,
  EVAL_FILES_FEATURE,
  MODEL_ROUTE_FEATURE,
  E2E_AGENT_MODEL_CHOICE_FEATURE,
  E2E_AGENT_STEPS_FEATURE,
  E2E_CAPTURE_EXTRAS_FEATURE,
  E2E_MODEL_SESSION_SYNC_FEATURE,
  E2E_AGENT_UNAVAILABLE_REASONS,
  E2E_MODEL_FREE_LIMITS_FEATURE,
  E2E_REPLAY_CHECKS_FEATURE,
  GROUNDING_CHECKS_FEATURE,
  DIAGNOSIS_WORKER_FEATURE,
  SETUP_AGENT_FEATURE,
  NIGHTLY_RUN_FEATURE,
  STANDING_INSTRUCTIONS_FEATURE,
  SETUP_RECIPES_FEATURE,
  EVIDENCE_CAPTURE_FEATURE,
  TEST_ENV_COVERAGE_PATH_FEATURE,
  TEST_ENV_DETECT_FEATURE,
  SECOND_REVIEWER_FEATURE,
  DESIGN_REVIEW_WORKER_FEATURE,
  TEST_ENV_PLAN_FEATURE,
  TEST_SERVICES_AWS_PLAN_FEATURE,
  TEST_SERVICES_FAKE_PLAN_FEATURE,
  TEST_SERVICES_FILE_SEED_FEATURE,
  TEST_SERVICES_SEED_LOCK_FEATURE,
  TEST_SERVICES_PLAN_FEATURE,
  PREPARE_REGISTRIES_FEATURE,
  PREPARE_SAVED_ENV_FEATURE,
  PREPARE_SAVED_ENV_BUILD_FEATURE,
  PREPARE_PINS_FEATURE,
  credentialKindsOfWorkerFeatures,
  OWNER_REDIRECT_FEATURE,
  PLAN_DRY_RUN_FEATURE,
  E2E_APPLICATION_ADMISSION_SCHEMA_V2,
  WORKER_INVOKE_AUTHORIZATION_SCHEME,
  WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED,
  agentXError,
  isE2EApplicationAdmissionSchemaVersion,
  modelSelectionFor,
  workerInvokeToken,
  workerInvokeTokenPayload,
  workflowPublicationContext,
  workflowPublicationContextDigest,
  type E2EWorkflowAdmissionRef,
  type Ec2RuntimeBinding,
  type EvalFilesPayload,
  type LearnedContext,
  type LearnedRefs,
  type WorkerInvocation,
} from "@agentx/contracts";
import { asksForApplicationPlan, asksForCodeAnchors, asksForPlanQuality, withoutApplicationPlanText, withoutCodeAnchorText, withoutPlanQualityText } from "./broker-shared.js";
import type { Ec2OutboxRecord } from "./lambda.js";
import { serialWorkerCanResume } from "../rovara-code/parallel-parts.js";
import type { SessionManager } from "./sessions.js";
import type { TaskDispatchClosed } from "./task-dispatch-access.js";

/** The worker's port; its /invocations accepts only KMS-signed tokens (#80). */
const WORKER_PORT = 8080;
/** A token outlives one delivery attempt and nothing more (design in #76). */
const TOKEN_LIFETIME_SECONDS = 60;
/** P8: said when a repository's code host needs a credential kind the worker has not said it takes. Fixed; names no host and no credential. */
export const CREDENTIAL_KIND_FEATURE_MISSING = "This repository's code host needs a newer worker. Ask an admin to upgrade Rovara.";
export const STARTING_COMPUTE_MESSAGE = "Starting workspace compute";

/** `taskClosed`: the guard found the task (or its operation) definitively closed; nothing was sent, and the caller acknowledges the message as done (failing the operation if it is still active). */
export type Ec2Delivery = "DELIVERED" | "WAITING_FOR_SESSION" | "WAITING_FOR_TASK_ACCESS" | { taskClosed: TaskDispatchClosed } | { readinessGeneration: number };

export interface ProjectSetupSessionPort {
  ensureSession(input: { setupExecutionId: string; subjectId: string; approvalRevision: number; transportCorrelationId: string; binding: Ec2RuntimeBinding; waitingOutboxId: string }):
    Promise<{ ready: true; generation: number; privateIp: string } | { ready: false; generation: number; state: string }>;
}

export interface Ec2DeliveryDependencies {
  sessions: Pick<SessionManager, "ensureSession">;
  binding: (workspaceId: string) => Promise<Ec2RuntimeBinding | undefined>;
  /** Project setup has a separate lease namespace and never calls SessionManager.ensureSession. */
  projectSetupSessions?: ProjectSetupSessionPort;
  /** Reads the registered default binding only after stored setup authority is rechecked. */
  projectSetupBinding?: (input: { setupExecutionId: string; subjectId: string }) => Promise<Ec2RuntimeBinding | undefined>;
  /** KMS Sign, ECDSA_SHA_256 over the message bytes; returns the DER signature. */
  sign: (message: Uint8Array) => Promise<Uint8Array>;
  post: (url: string, init: { authorization: string; body: string }) => Promise<{ status: number; body: string }>;
  /** Records a progress event on the operation, once per outbox record. */
  progress: (record: Ec2OutboxRecord, message: string) => Promise<void>;
  /**
   * GET on the worker's /ping; resolves to the invocation features it reports (spec 053), none for a
   * worker built before them. Without it, no optional field is sent.
   */
  workerFeatures?: (url: string) => Promise<readonly string[]>;
  /**
   * Called, before the invocation is posted, when a planning run's schema-v2 application plan was dropped for a worker that does not list
   * "task.workflowE2EApplicationPlan": the operation record must stop saying the version was offered, so the broker refuses a v2 plan it uploads.
   * A failure fails the attempt (the run must not go out with the record still saying 2).
   */
  applicationPlanNotNegotiated: (record: Ec2OutboxRecord) => Promise<void>;
  /**
   * Called, before the invocation is posted, when a planning run's plan quality guidance was dropped for a worker that does not list the plan-quality feature:
   * the operation record then stops saying the planner was asked for the new plan members, so the broker never sends that planner a revision that names them.
   */
  planQualityNotNegotiated: (record: Ec2OutboxRecord) => Promise<void>;
  /**
   * Called, before the invocation is posted, when the company recipes offered to a setup draft were dropped for a worker that does not list them: the operation record then stops saying which recipes were offered (the
   * run cannot have used any). Required like its siblings: a missing recorder is a wiring error (`CONFIG_INVALID`), not a draft that goes out with the record still saying recipes were offered.
   */
  setupRecipesNotNegotiated: (record: Ec2OutboxRecord) => Promise<void>;
  /**
   * Saved project images: the lease token of the rebuild job a preparation was made for (`leaseForDispatch`), taken ONCE here, when the invocation is delivered, and put into the payload the worker is sent. The stored
   * invocation never holds it. Undefined: the lease is gone (expired, already handed out, the project deleted or turned off) and the job is not delivered. A preparation that carries a build and has no such function is a wiring error.
   */
  savedEnvBuildLease?: (record: Ec2OutboxRecord, jobId: string) => Promise<string | undefined>;
  /**
   * The schemaVersion of the admission a CHECKS invocation's reference names, read from the stored object and held to the reference's content address; undefined when it
   * cannot be read. With it, the dispatcher does not trust the reference's `kind` alone: a reference whose kind disagrees with its admission is refused before delivery.
   * Without it (a deployment that cannot read admissions) only the kind decides, and the worker still cross-checks.
   */
  workflowE2EAdmissionSchemaVersion?: (reference: E2EWorkflowAdmissionRef) => Promise<string | undefined>;
  /**
   * Whether an application admission has an `agent` step in its scenarios, read the same way. With it, the dispatcher also holds the reference's `agentSteps` flag to the admission: the
   * flag decides whether the worker must list the agent-steps feature, so a reference that understated it would skip that gate. Undefined when it cannot be read.
   */
  workflowE2EAdmissionUsesAgentSteps?: (reference: E2EWorkflowAdmissionRef) => Promise<boolean | undefined>;
  /**
   * Whether the route an application admission pins is one a worker built before the model choice (Task 4.10) cannot serve: a model other than the recommended one, or the minimal
   * request shape. Undefined when it cannot be read. With it, a round with AI navigation steps is never sent to a worker that does not list `task.workflowE2EAgentModelChoice.v1`
   * when the route needs it, and a route that cannot be read is refused rather than assumed to be the default.
   */
  workflowE2EAdmissionNeedsModelChoice?: (reference: E2EWorkflowAdmissionRef) => Promise<boolean | undefined>;
  /**
   * Whether an application admission relies on the normal no-model limits for a group (RUN-1, Ruling DV), read from the admission itself. With it, the dispatcher hands such a round only to a
   * worker that lists `task.workflowE2EModelFreeLimits.v1`. Undefined when it cannot be read, which refuses the attempt; absent in a deployment that cannot read admissions.
   */
  workflowE2EAdmissionNeedsModelFreeLimits?: (reference: E2EWorkflowAdmissionRef) => Promise<boolean | undefined>;
  /** Rechecks fresh PEOPLE authority after compute is ready, immediately before signing and POST. */
  guardTaskDispatch?: (record: Ec2OutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED" | TaskDispatchClosed>;
  /** Loads and validates the durable internal readiness marker before any session provisioning. */
  validateWorkflowE2EReadiness?: (record: Ec2OutboxRecord, invocation: WorkerInvocation) => Promise<"ORDINARY" | "READINESS" | "PARKED">;
  /** Rechecks stored project setup authority independently from feature-task access. */
  guardProjectSetupDispatch?: (record: Ec2OutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">;
  /**
   * Builds a stage's lessons from the lesson store at delivery (WL-6). The stored and queued stage carries only lesson ids and versions (`payload.learnedRefs`); this turns them into the
   * `learnedContext` the worker gets, from the lessons as they are NOW: an erased, retired, expired or edited lesson is left out, a reader who lost access gets none, and an answer that cannot be had
   * is no lessons (the stage still runs, as without memory). Without it no lessons are sent.
   */
  learnedFromRefs?: (refs: LearnedRefs) => Promise<LearnedContext | undefined>;
  /** Lane 7, the file arm: builds the files a replay copy's checkout is given, from its refs, at delivery. Without it a copy that asks for files is not sent (see `withLearnedContext`). */
  evalFilesFromRefs?: (refs: LearnedRefs) => Promise<EvalFilesPayload | undefined>;
  remainingTimeMs?: () => number;
  now?: () => number;
}

/**
 * Delivers one ec2-ebs invocation (flows 1 to 3 in #76). When the workspace's session is not ready,
 * ensureSession starts it and parks the outbox record, and this returns WAITING_FOR_SESSION: the
 * caller acknowledges the message without using a retry attempt, and markReady re-queues it.
 */
export function createEc2Delivery(dependencies: Ec2DeliveryDependencies) {
  return async (record: Ec2OutboxRecord, invocation: WorkerInvocation, context?: { remainingTimeMs: () => number }): Promise<Ec2Delivery> => {
    const remainingTimeMs = context?.remainingTimeMs ?? dependencies.remainingTimeMs;
    const hasReadinessMarker = record.workflowE2EReadiness !== undefined;
    if (invocation.kind === "resume" && hasReadinessMarker && dependencies.validateWorkflowE2EReadiness === undefined) {
      throw agentXError("CALLBACK_FORBIDDEN", "the internal E2E readiness operation cannot be verified by this dispatcher");
    }
    const storedReadiness = invocation.kind === "resume"
      ? dependencies.validateWorkflowE2EReadiness === undefined
        ? "ORDINARY"
        : await dependencies.validateWorkflowE2EReadiness(record, invocation)
      : "ORDINARY";
    if (storedReadiness === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const guardCurrentAuthority = async () => {
      if (invocation.kind === "project-setup-smoke") {
        if (dependencies.guardProjectSetupDispatch === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "project setup smoke authority is not configured");
        return dependencies.guardProjectSetupDispatch(record, remainingTimeMs === undefined ? undefined : { remainingTimeMs });
      }
      return dependencies.guardTaskDispatch?.(record, remainingTimeMs === undefined ? undefined : { remainingTimeMs });
    };
    // A guard that stops the delivery says why: parked (acknowledged, waits for access) or closed (acknowledged as done).
    const stoppedByGuard = async (): Promise<"WAITING_FOR_TASK_ACCESS" | { taskClosed: TaskDispatchClosed } | undefined> => {
      const outcome = await guardCurrentAuthority();
      return outcome === "PARKED" ? "WAITING_FOR_TASK_ACCESS" : typeof outcome === "object" ? { taskClosed: outcome } : undefined;
    };
    const workflowE2EReadiness = storedReadiness === "READINESS";
    if (workflowE2EReadiness) {
      const stopped = await stoppedByGuard();
      if (stopped !== undefined) return stopped;
    }
    if (invocation.kind === "project-setup-smoke" && await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const admissionSchemaVersion = await checkAdmissionKind(invocation, dependencies.workflowE2EAdmissionSchemaVersion);
    await checkAdmissionAgentSteps(invocation, dependencies.workflowE2EAdmissionUsesAgentSteps);
    const needsModelFreeLimits = await admissionNeedsModelFreeLimits(invocation, dependencies.workflowE2EAdmissionNeedsModelFreeLimits);
    let binding: Ec2RuntimeBinding | undefined;
    let session: { ready: true; generation: number; privateIp: string } | { ready: false; generation: number; state: string };
    if (invocation.kind === "project-setup-smoke") {
      if (dependencies.projectSetupSessions === undefined || dependencies.projectSetupBinding === undefined) {
        throw agentXError("RUNTIME_UNAVAILABLE", "project setup session transport is not configured");
      }
      binding = await dependencies.projectSetupBinding({ setupExecutionId: invocation.payload.setupExecutionId, subjectId: invocation.payload.subjectId });
      if (binding === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup default runtime binding is unavailable");
      session = await dependencies.projectSetupSessions.ensureSession({
        setupExecutionId: invocation.payload.setupExecutionId, subjectId: invocation.payload.subjectId,
        approvalRevision: invocation.payload.approvalRevision,
        transportCorrelationId: invocation.payload.transportCorrelationId, binding, waitingOutboxId: record.id,
      });
    } else {
      binding = await dependencies.binding(record.workspaceId);
      if (binding === undefined) throw agentXError("CONFIG_INVALID", `workspace ${record.workspaceId} has no ec2-ebs runtime binding`);
      session = await dependencies.sessions.ensureSession({ workspaceId: record.workspaceId, binding, waitingOutboxId: record.id });
    }
    if (!session.ready) {
      if (invocation.kind !== "project-setup-smoke") await dependencies.progress(record, STARTING_COMPUTE_MESSAGE);
      return "WAITING_FOR_SESSION";
    }
    // The broker uses this existing dispatcher/session path to warm compute before it admits an
    // immutable feature-E2E deadline. A resume invocation is an internal readiness signal only;
    // it must never reach the worker.
    if (workflowE2EReadiness) {
      const stopped = await stoppedByGuard();
      if (stopped !== undefined) return stopped;
      if (await dependencies.validateWorkflowE2EReadiness?.(record, invocation) !== "READINESS") {
        throw agentXError("CALLBACK_FORBIDDEN", "the stored E2E readiness operation changed while compute was starting");
      }
      return { readinessGeneration: session.generation };
    }
    {
      const stopped = await stoppedByGuard();
      if (stopped !== undefined) return stopped;
    }
    const applicationAdmission = invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.kind === "application" ? invocation.payload.workflowE2EAdmission : undefined;
    const modelChoice = applicationAdmission === undefined || dependencies.workflowE2EAdmissionNeedsModelChoice === undefined ? undefined
      : () => dependencies.workflowE2EAdmissionNeedsModelChoice!(applicationAdmission);
    const sent = await forWorker(invocation, `http://${session.privateIp}:${WORKER_PORT}/ping`, dependencies.workerFeatures, admissionSchemaVersion, needsModelFreeLimits, modelChoice, dependencies.learnedFromRefs, dependencies.evalFilesFromRefs);
    if (invocation.kind === "task" && invocation.payload.workflowE2EPlanVersion !== undefined
      && !(sent.kind === "task" && sent.payload.workflowE2EPlanVersion !== undefined)) {
      // Without the recorder the operation record would keep saying version 2 was offered while the worker was sent a portable-only run, so the broker would
      // accept a v2 plan it never asked for: a missing recorder is a wiring error, and the run does not go out.
      if (dependencies.applicationPlanNotNegotiated === undefined) {
        throw agentXError("CONFIG_INVALID", "the application plan version was dropped for this worker but no applicationPlanNotNegotiated recorder is configured");
      }
      await dependencies.applicationPlanNotNegotiated(record);
    }
    if (invocation.kind === "task" && invocation.payload.testEnvRecipes !== undefined && !(sent.kind === "task" && sent.payload.testEnvRecipes !== undefined)) {
      if (dependencies.setupRecipesNotNegotiated === undefined) {
        throw agentXError("CONFIG_INVALID", "the company recipes were dropped for this worker but no setupRecipesNotNegotiated recorder is configured");
      }
      await dependencies.setupRecipesNotNegotiated(record);
    }
    if (invocation.kind === "task" && asksForPlanQuality(invocation.payload.prompt)
      && !(sent.kind === "task" && asksForPlanQuality(sent.payload.prompt))) {
      // Without the recorder the operation would keep saying the planner was asked for the new plan members while this worker was sent a prompt without them, and a revision prompt
      // would then name members its strict parser rejects: a missing recorder is a wiring error, and the run does not go out (the same as the application plan above).
      if (dependencies.planQualityNotNegotiated === undefined) {
        throw agentXError("CONFIG_INVALID", "the plan quality guidance was dropped for this worker but no planQualityNotNegotiated recorder is configured");
      }
      await dependencies.planQualityNotNegotiated(record);
    }
    {
      const stopped = await stoppedByGuard();
      if (stopped !== undefined) return stopped;
    }
    // Saved project images: the lease token goes into what the worker is sent, not into what is stored.
    let outgoing: WorkerInvocation = sent;
    if (sent.kind === "prepare" && sent.payload.savedEnvBuild !== undefined) {
      if (dependencies.savedEnvBuildLease === undefined) throw agentXError("CONFIG_INVALID", "a saved image rebuild is being delivered but no savedEnvBuildLease is configured");
      const leaseToken = await dependencies.savedEnvBuildLease(record, sent.payload.savedEnvBuild.jobId);
      if (leaseToken === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the saved image rebuild's lease is no longer available");
      outgoing = { ...sent, payload: { ...sent.payload, savedEnvBuild: { ...sent.payload.savedEnvBuild, leaseToken } } };
    }
    const payload = workerInvokeTokenPayload({
      workspaceId: record.workspaceId,
      generation: session.generation,
      operationId: invocation.operationId,
      fence: invocation.fence,
      expiresAt: Math.floor((dependencies.now?.() ?? Date.now()) / 1_000) + TOKEN_LIFETIME_SECONDS,
      ...(invocation.kind === "project-setup-smoke" ? { purpose: "PROJECT_SETUP" as const,
        setupExecutionId: invocation.payload.setupExecutionId, setupSubjectId: invocation.payload.subjectId,
        setupApprovalRevision: invocation.payload.approvalRevision } : { purpose: "WORKSPACE" as const,
        ...(invocation.kind === "publish" && invocation.payload.publicationMode !== undefined
          ? { publicationMode: invocation.payload.publicationMode,
            publicationContextDigest: invocation.payload.publicationContextDigest } : {}) }),
    });
    const signature = await dependencies.sign(Buffer.from(payload, "ascii"));
    // Signing may cross an authority revocation boundary. Recheck setup approval immediately before
    // the transport side effect; the opaque worker correlation is not durable setup authority.
    if (invocation.kind === "project-setup-smoke" && await guardCurrentAuthority() === "PARKED") return "WAITING_FOR_TASK_ACCESS";
    const response = await dependencies.post(`http://${session.privateIp}:${WORKER_PORT}/invocations`, {
      authorization: `${WORKER_INVOKE_AUTHORIZATION_SCHEME} ${workerInvokeToken(payload, signature)}`,
      body: JSON.stringify(outgoing),
    });
    if (response.status >= 300) {
      throw agentXError("RUNTIME_UNAVAILABLE", `EC2 worker returned HTTP ${response.status}: ${response.body.slice(0, 512)}`);
    }
    return "DELIVERED";
  };
}

/** What a worker that cannot run a version 2 application admission (web and API runtime bindings keyed by kind) is told; the feature it must list is `task.workflowE2EApplicationChecks.v2`. */
export const COMBINED_CHECKS_WORKER_REFUSAL = "This worker can't run combined browser and API checks yet; retry once it restarts.";
const PORTABLE_ADMISSION_SCHEMA = "workflow-e2e-admission/v1";

/**
 * The reference's `kind` decides which worker may receive an application round, so it is checked against the admission it names before any compute is started: a reference
 * without `kind` that names an application admission would bypass the gate, and one marked application that names a portable admission is a broker defect. Both are refused.
 */
async function checkAdmissionKind(invocation: WorkerInvocation, read: Ec2DeliveryDependencies["workflowE2EAdmissionSchemaVersion"]): Promise<string | undefined> {
  if (invocation.kind !== "task" || invocation.payload.workflowE2EAdmission === undefined) return undefined;
  const reference = invocation.payload.workflowE2EAdmission;
  // Fail closed: with no reader wired the version of an application admission is unknown, so it is treated as needing the newest worker feature.
  if (read === undefined) return reference.kind === "application" ? E2E_APPLICATION_ADMISSION_SCHEMA_V2 : undefined;
  let schemaVersion: string | undefined;
  try { schemaVersion = await read(reference); } catch { schemaVersion = undefined; }
  if (schemaVersion === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "could not read the E2E admission to check its kind against the reference; no round was sent");
  if (!isE2EApplicationAdmissionSchemaVersion(schemaVersion) && schemaVersion !== PORTABLE_ADMISSION_SCHEMA) {
    throw agentXError("CONFIG_INVALID", "the E2E admission is of a kind this dispatcher does not know; no round was sent");
  }
  if (isE2EApplicationAdmissionSchemaVersion(schemaVersion) !== (reference.kind === "application")) {
    throw agentXError("CONFIG_INVALID", "the E2E admission reference's kind does not match the admission it names; no round was sent");
  }
  return schemaVersion;
}

async function checkAdmissionAgentSteps(invocation: WorkerInvocation, read: Ec2DeliveryDependencies["workflowE2EAdmissionUsesAgentSteps"]): Promise<void> {
  if (read === undefined || invocation.kind !== "task" || invocation.payload.workflowE2EAdmission?.kind !== "application") return;
  const reference = invocation.payload.workflowE2EAdmission;
  let uses: boolean | undefined;
  try { uses = await read(reference); } catch { uses = undefined; }
  if (uses === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "could not read the E2E admission to check its agent steps against the reference; no round was sent");
  if (uses !== (reference.agentSteps === true)) {
    throw agentXError("CONFIG_INVALID", "the E2E admission reference's agentSteps flag does not match the admission it names; no round was sent");
  }
}

async function admissionNeedsModelFreeLimits(invocation: WorkerInvocation, read: Ec2DeliveryDependencies["workflowE2EAdmissionNeedsModelFreeLimits"]): Promise<boolean> {
  if (read === undefined || invocation.kind !== "task" || invocation.payload.workflowE2EAdmission?.kind !== "application") return false;
  let relies: boolean | undefined;
  try { relies = await read(invocation.payload.workflowE2EAdmission); } catch { relies = undefined; }
  if (relies === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "could not read the E2E admission to check the time limits it relies on; no round was sent");
  return relies;
}

/**
 * Spec 053: the invocation as the worker can parse it. Worker payloads are strict and a running
 * worker keeps its image after a release (or after a worker-image rollback), so a thinking level goes
 * only to a worker whose /ping lists it. A task's level is dropped and the worker runs at its own
 * default level. Prepare, publish and maintain carry the whole stored project definition, whose
 * models carry levels the worker does not use there, so those are stripped. Spec 051: a task's
 * readiness goes only to a worker whose /ping lists "task.readiness"; one built before spec 051 has no
 * verification at all, so it neither checks nor reports (it is a new worker under an old broker, which sends no
 * readiness, that checks the agent's own test commands), and a publication's reportChecks goes only to one whose /ping lists
 * "publish.reportChecks". A review's workflowReviewChecks goes only to one whose /ping lists "task.workflowReviewChecks";
 * an older one reviews without being told which checks ran, and its workflowReviewPlan goes only to one whose /ping lists
 * "task.workflowReviewPlan"; an older one reviews without seeing the approved plan, and its workflowReviewFeedback goes only to one whose
 * /ping lists "task.workflowReviewFeedback"; an older one judges a feedback fix against the plan alone. The retry note goes only to one whose /ping lists "task.workflowReviewNote"; older workers review without it. A Rovara Code version 2 review's workflowReviewRisk (the code reviewer states a risk level) goes only to one whose /ping lists "task.workflowReviewRisk"; an older one reviews as before, and the risk comes from the paths, the size and the checks alone. A planning run's workflowPhase and planFormat go only to one whose /ping lists
 * "task.structuredPlans"; an older one plans without checking the answer's format. A planning run's workflowE2EPlanVersion (the schema-v2 application plan)
 * goes only to one whose /ping lists "task.workflowE2EApplicationPlan"; an older one is sent the portable-only prompt, and its review plan without a v2 intent. A planning prompt asks for anchor lines on
 * code citations only on one whose /ping lists "task.codeAnchors"; for an older one that text is left out of the prompt. The invoke token signs the operation, not the payload, so
 * dropping a field leaves it valid. A ping that fails fails the attempt: the worker journals a hash of
 * the whole invocation, so a retry must send what the first attempt would have, and a blip must not
 * run a capable worker at the default level.
 */
async function forWorker(
  invocation: WorkerInvocation,
  pingUrl: string,
  workerFeatures: Ec2DeliveryDependencies["workerFeatures"],
  admissionSchemaVersion?: string,
  needsModelFreeLimits = false,
  modelChoice?: () => Promise<boolean | undefined>,
  learnedFromRefs?: Ec2DeliveryDependencies["learnedFromRefs"],
  evalFilesFromRefs?: Ec2DeliveryDependencies["evalFilesFromRefs"],
): Promise<WorkerInvocation> {
  // The CLI's stored model check results (`lastCheck`) are not for workers, and a worker built before them refuses the whole invocation for an unknown key: they never go out.
  return forWorkerFeatures(withoutLastCheck(invocation), pingUrl, workerFeatures, admissionSchemaVersion, needsModelFreeLimits, modelChoice, learnedFromRefs, evalFilesFromRefs);
}

async function forWorkerFeatures(
  invocation: WorkerInvocation,
  pingUrl: string,
  workerFeatures: Ec2DeliveryDependencies["workerFeatures"],
  admissionSchemaVersion?: string,
  needsModelFreeLimits = false,
  modelChoice?: () => Promise<boolean | undefined>,
  learnedFromRefs?: Ec2DeliveryDependencies["learnedFromRefs"],
  evalFilesFromRefs?: Ec2DeliveryDependencies["evalFilesFromRefs"],
): Promise<WorkerInvocation> {
  const requestedThinkingLevel = carriedThinkingLevel(invocation);
  const carriesReadiness = invocation.kind === "task" && invocation.payload.readiness !== undefined;
  const carriesReviewChecks = invocation.kind === "task" && (invocation.payload.workflowReviewChecks !== undefined || invocation.payload.workflowReviewPlan !== undefined
    || invocation.payload.workflowReviewFeedback !== undefined || invocation.payload.workflowReviewNote !== undefined);
  const carriesWorkflowMode = invocation.kind === "task" && invocation.payload.workflowMode !== undefined;
  const carriesFeedbackReview = invocation.kind === "task" && invocation.payload.workflowMode === "FEEDBACK_REVIEW";
  const carriesFeedbackApproval = invocation.kind === "task" && invocation.payload.workflowFeedbackApproval !== undefined;
  const carriesFeedbackAutonomy = invocation.kind === "task" && invocation.payload.workflowFeedbackApproval?.autonomy !== undefined;
  const carriesWorkflowDependencies = invocation.kind === "task" && invocation.payload.workflowDependencies !== undefined;
  const carriesWorkflowBase = invocation.kind === "task" && invocation.payload.workflowBase !== undefined;
  const carriesStructuredPlans = invocation.kind === "task" && (invocation.payload.workflowPhase !== undefined || invocation.payload.planFormat !== undefined);
  const carriesCodeAnchors = invocation.kind === "task" && asksForCodeAnchors(invocation.payload.prompt);
  const carriesPlanQuality = invocation.kind === "task" && asksForPlanQuality(invocation.payload.prompt);
  const carriesApplicationPlans = invocation.kind === "task" && (invocation.payload.workflowE2EPlanVersion !== undefined || asksForApplicationPlan(invocation.payload.prompt)
    || invocation.payload.workflowReviewPlan?.e2eIntent?.schemaVersion === 2);
  const carriesApplicationAdmission = invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.kind === "application";
  const carriesAgentSteps = invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.agentSteps === true;
  const carriesCaptureExtras = invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.captureExtras === true;
  const carriesReportChecks = invocation.kind === "publish" && invocation.payload.reportChecks !== undefined;
  const carriesCandidateTree = invocation.kind === "publish" && invocation.payload.candidateTreeSha !== undefined;
  const carriesPublicationMode = invocation.kind === "publish" && invocation.payload.publicationMode !== undefined;
  const carriesPublicationContextDigest = invocation.kind === "publish" && invocation.payload.publicationContextDigest !== undefined;
  const carriesPublishBase = invocation.kind === "publish" && invocation.payload.workflowBaseCommit !== undefined;
  const carriesAttribution = invocation.kind === "publish" && invocation.payload.attribution !== undefined;
  // Meta repo lane D: the spec write mode and the spec publication's files.
  const carriesSpec = (invocation.kind === "task" && (invocation.payload.workflowMode === "SPEC_WRITE" || invocation.payload.specWrite !== undefined || invocation.payload.workflowReviewSpec !== undefined));
  const carriesPullRequestUpdate = invocation.kind === "maintain" && invocation.payload.workflowCandidateTreeSha !== undefined;
  // Plan 6 Task 17: a merge of the base branch, and a fix pushed as a merge commit. An older worker would merge whatever the base is by now, or push a commit with one parent.
  const carriesBranchSync = invocation.kind === "maintain" && (invocation.payload.workflowSync !== undefined || invocation.payload.workflowMergeBase !== undefined);
  const carriesChatGpt = invocation.kind === "task" && invocation.payload.chatgpt !== undefined;
  const carriesProjectSetupSmoke = invocation.kind === "project-setup-smoke";
  const agentStep = invocation.kind === "task" ? invocation.payload.agentStep : undefined;
  const carriesAgentStep = agentStep !== undefined;
  const carriesModelPolicy=invocation.kind==="task"&&invocation.payload.modelPolicy!==undefined;
  const carriesModelRoute = invocation.kind === "task" && invocation.payload.modelRoute !== undefined;
  // A preparation that checks a pull request's head out is the agent-step engine's: only a worker that runs agent steps does it.
  // Its read-only form (clone and checkout, nothing of the repository run) is the same: a worker that does not know the field would run the setup.
  const carriesCheckout = invocation.kind === "prepare" && (invocation.payload.checkout !== undefined || invocation.payload.readOnly === true);
  // Meta repo lane A: a preparation that brings the project's meta repository. A worker that does not know the field would refuse it (strict payload) or run without the team's rules.
  const carriesMeta = invocation.kind === "prepare" && invocation.payload.meta !== undefined;
  const carriesRegistries = invocation.kind === "prepare" && invocation.payload.registries !== undefined;
  const carriesSavedEnv = invocation.kind === "prepare" && invocation.payload.savedEnv !== undefined;
  const carriesPins = invocation.kind === "prepare" && invocation.payload.pins !== undefined;
  const carriesSavedEnvBuild = invocation.kind === "prepare" && invocation.payload.savedEnvBuild !== undefined;
  // P8: a grant that names a credential kind beyond the legacy two (an ssh key). A worker that does not list repository.credentialKinds.v1 would be sent a shape it cannot take, so the run is refused here.
  const credentialKindsNeeded = invocation.kind === "prepare" || invocation.kind === "publish" || invocation.kind === "maintain" ? nonLegacyCredentialKindsOfGrant(invocation.payload.repositoryGrant) : [];
  const carriesCredentialKinds = credentialKindsNeeded.length > 0;
  const carriesReviewers = invocation.kind === "task" && invocation.payload.workflowReviewers !== undefined;
  const carriesFix = invocation.kind === "task" && invocation.payload.workflowFix !== undefined;
  const carriesContextSources = invocation.kind === "task" && invocation.payload.contextSources === true;
  const carriesOwnerRedirect = invocation.kind === "task" && invocation.payload.ownerRedirect !== undefined;
  // Learning v2: advice from approved lessons. An older worker is sent the stage without it (never refused), so it runs as it would without memory.
  // Standing instructions (lanes I1, I2): the company's rules and "How we work" in the system prompt. An older worker would run the step without them and say nothing, so it is refused (the field is never dropped).
  const carriesStandingInstructions = invocation.kind === "task" && invocation.payload.standingInstructions !== undefined;
  const carriesLearnedContext = invocation.kind === "task" && (invocation.payload.learnedContext !== undefined || invocation.payload.learnedRefs !== undefined);
  // Test environment and test services: a preparation that carries `testServices`, or a task that carries `testEnvironment`, reaches the feature gates below even when it carries nothing else (the gates are never skipped for it).
  const carriesTestServices = (invocation.kind === "task" && invocation.payload.testEnvironment !== undefined) || (invocation.kind === "prepare" && invocation.payload.testServices !== undefined);
  if (requestedThinkingLevel === undefined && !carriesSavedEnv && !carriesSavedEnvBuild && !carriesChatGpt && !carriesReadiness && !carriesReviewChecks && !carriesWorkflowMode && !carriesWorkflowBase && !carriesStructuredPlans && !carriesCodeAnchors && !carriesPlanQuality && !carriesApplicationPlans && !carriesApplicationAdmission && !carriesAgentSteps && !carriesCaptureExtras && !carriesReportChecks && !carriesCandidateTree && !carriesPublicationMode && !carriesPublishBase && !carriesAttribution && !carriesPullRequestUpdate && !carriesBranchSync && !carriesWorkflowDependencies && !carriesProjectSetupSmoke && !carriesAgentStep && !carriesModelRoute && !carriesReviewers && !carriesFix && !carriesContextSources && !carriesOwnerRedirect && !carriesFeedbackAutonomy && !carriesCheckout && !carriesMeta && !carriesRegistries && !carriesPins && !carriesCredentialKinds && !carriesModelPolicy && !carriesSpec && !carriesLearnedContext && !carriesTestServices && !carriesStandingInstructions) return invocation;
  let features: readonly string[] = [];
  if (workerFeatures !== undefined) {
    try {
      features = await workerFeatures(pingUrl);
    } catch (error) {
      throw agentXError("RUNTIME_UNAVAILABLE", `could not ask the EC2 worker which invocation fields it parses: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512));
    }
  }
  if (carriesWorkflowMode && !features.includes("task.workflowMode")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX workflow mode requires a compatible worker that advertises the read-only tool boundary");
  }
  if (invocation.kind === "task" && invocation.payload.workflowMode === "REVIEW" && !features.includes("task.workflowReview")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "independent workflow review requires a compatible worker");
  }
  if (invocation.kind === "task" && invocation.payload.workflowMode === "CHECKS" && !features.includes("task.workflowChecks")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "verification retry requires a compatible worker that runs checks without code-editing tools");
  }
  // Rovara Code v2's Understand and plan-critic runs: a worker that does not list the feature would fail the mode at its own parse, so the mode is never sent to it.
  if (invocation.kind === "task" && invocation.payload.workflowMode === "UNDERSTAND" && !features.includes("task.workflowUnderstand")) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  if (invocation.kind === "task" && invocation.payload.workflowMode === "PLAN_CRITIQUE" && !features.includes("task.workflowPlanCritique")) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Rovara proposes a project's setup (Task 10; version 2 with citations, meta repo lane B): an older worker would fail the mode at its own parse, or answer a draft this broker
  // no longer reads, so the mode is never sent to it.
  if (invocation.kind === "task" && invocation.payload.workflowMode === "SETUP_DRAFT" && !(features.includes("task.setupDraft") && features.includes("task.setupProposal.v2"))) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // SH14: a setup run that runs commands is never sent to a worker that does not list it (an older worker fails the mode at its own parse). The field is never dropped.
  if (invocation.kind === "task" && invocation.payload.workflowMode === "SETUP_AGENT" && !features.includes(SETUP_AGENT_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // NH-1: a nightly run is never sent to a worker that does not list it (an older worker would run the verification mode with no checks and say nothing of the night). The field is never dropped.
  if (invocation.kind === "task" && invocation.payload.nightlyRun !== undefined && !features.includes(NIGHTLY_RUN_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Live interaction F3: a deep diagnosis is never sent to a worker that does not list it: an older worker would run the look as a setup draft and answer a proposal this broker does not read.
  if (invocation.kind === "task" && invocation.payload.diagnosis !== undefined && !features.includes(DIAGNOSIS_WORKER_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  if (carriesStandingInstructions && !features.includes(STANDING_INSTRUCTIONS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Test environment: a verification run that carries the environment's plan is never sent to a worker that does not list it (it would run the whole suite under another budget and say nothing of it), and the field is never dropped.
  if (invocation.kind === "task" && invocation.payload.testEnvironment !== undefined && !features.includes(TEST_ENV_PLAN_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Test services (slice 1): a run whose plan starts dependencies is never sent to a worker that does not list the feature (it would run the checks with no database and say nothing), and the field is never dropped.
  if (((invocation.kind === "task" && (invocation.payload.testEnvironment?.dependencies?.length ?? 0) > 0) || (invocation.kind === "prepare" && invocation.payload.testServices !== undefined)) && !features.includes(TEST_SERVICES_PLAN_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Test services (slice 2): a plan that starts Rovara local AWS (an `emulated` dependency) also needs the worker to list the AWS feature: an older worker's strict parse would refuse the entry.
  if ((invocation.kind === "task" ? invocation.payload.testEnvironment?.dependencies : invocation.kind === "prepare" ? invocation.payload.testServices?.dependencies : undefined)?.some((dependency) => dependency.backing === "emulated") === true && !features.includes(TEST_SERVICES_AWS_PLAN_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Test services (slice 3): a plan with a fake (the fake server from the worker's own image, and a fixture set fetched through the `fixture-set` callback) also needs the worker to list the fake feature: an older worker's strict parse would refuse the entry.
  if ((invocation.kind === "task" ? invocation.payload.testEnvironment?.dependencies : invocation.kind === "prepare" ? invocation.payload.testServices?.dependencies : undefined)?.some((dependency) => dependency.backing === "fake") === true && !features.includes(TEST_SERVICES_FAKE_PLAN_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // TS-UX-1 item 9: a plan with a seed FILE needs a worker that loads one: an older one would fail the seed.
  if ((invocation.kind === "task" ? invocation.payload.testEnvironment?.dependencies : invocation.kind === "prepare" ? invocation.payload.testServices?.dependencies : undefined)?.some((dependency) => dependency.seeds.some((seed) => "fixturePath" in seed)) === true && !features.includes(TEST_SERVICES_FILE_SEED_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // SEED-RISK-1: a plan with a LOCKED seed command needs a worker that checks the lock before it runs the seed: an older one would refuse the plan's shape, or run a changed script unchecked.
  if ((invocation.kind === "task" ? invocation.payload.testEnvironment?.dependencies : invocation.kind === "prepare" ? invocation.payload.testServices?.dependencies : undefined)?.some((dependency) => dependency.seeds.some((seed) => "command" in seed && seed.lock !== undefined)) === true && !features.includes(TEST_SERVICES_SEED_LOCK_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Meta repo lane D: the spec write mode and the spec publication are never dropped for an older worker, which would not know the mode or would publish without the files.
  if (invocation.kind === "task" && (invocation.payload.workflowMode === "SPEC_WRITE" || invocation.payload.specWrite !== undefined) && !features.includes("task.specWrite.v1")) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // DR5: a design review is never sent to a worker that does not list it (it would run one plan check with the planner's workspace); the binding is never dropped.
  if (invocation.kind === "task" && invocation.payload.designReview !== undefined && !features.includes(DESIGN_REVIEW_WORKER_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  if (invocation.kind === "task" && invocation.payload.workflowReviewSpec !== undefined && !features.includes("task.workflowReviewSpec.v1")) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  if (carriesFeedbackReview && !features.includes("task.workflowFeedbackReview")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "PR feedback critic requires a compatible worker");
  }
  if (carriesFeedbackApproval && !features.includes("task.workflowFeedbackApproval")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "feedback approval requires a compatible worker");
  }
  // Rovara's own decision on review comments (Plan 6 Task 16): its binding carries the autonomy, which an older worker would fail to parse; it is never dropped, so the round is not run on that worker.
  if (carriesFeedbackAutonomy && !features.includes("task.workflowFeedbackAutonomy")) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  if (carriesWorkflowDependencies && !features.includes("task.workflowDependencies")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "ordered work requires a compatible worker that advertises task.workflowDependencies");
  }
  // An agent step changes what the operation is allowed to do and a model route changes where its model comes from,
  // so neither is ever dropped; the agent kind (a step with no coding workflow) also needs task.agentRun.
  if (agentStep !== undefined && !(features.includes(AGENT_STEP_FEATURE) && (agentStep.kind !== "agent" || features.includes(AGENT_RUN_FEATURE)))) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  if (carriesCheckout && !features.includes(AGENT_RUN_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  if (carriesMeta && !features.includes("prepare.metaRepo")) {
    throw agentXError("RUNTIME_UNAVAILABLE", META_FEATURE_MISSING);
  }
  // P1: a setup run's pins are never dropped for an older worker, which would prepare whatever head it resolves: the run is refused.
  if (carriesPins && !features.includes(PREPARE_PINS_FEATURE)) throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  // Saved project images: a rebuild is never dropped for an older worker (a preparation alone would build nothing and the job would sit until its lease ran out): the job is refused.
  if (carriesSavedEnvBuild && !features.includes(PREPARE_SAVED_ENV_BUILD_FEATURE)) throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  // N9 (INTG2): a project's registries are never dropped for an older worker, which would run setup without them and fail on a 401 (or reach a public mirror): the run is refused.
  if (carriesRegistries && !features.includes(PREPARE_REGISTRIES_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", REGISTRY_FEATURE_MISSING);
  }
  // P8: the broker never dispatches a repository whose host hands out a credential kind the worker has not said it takes.
  if (carriesCredentialKinds) {
    const taken = credentialKindsOfWorkerFeatures(features);
    if (!credentialKindsNeeded.every((kind) => (taken as readonly string[]).includes(kind))) throw agentXError("RUNTIME_UNAVAILABLE", CREDENTIAL_KIND_FEATURE_MISSING);
  }
  if(carriesModelPolicy&&!features.includes("task.modelPolicy"))throw agentXError("RUNTIME_UNAVAILABLE",AGENT_WORKER_OUTDATED);
  if (carriesModelRoute && !features.includes(MODEL_ROUTE_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // A stage with MCP context sources (lane E) must not be run by a worker that would run it without them and say nothing, so the field is never dropped.
  if (carriesContextSources && !features.includes("task.contextSources.v1")) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // Stop & redirect: the owner's instruction is bound by the re-approval stop only on a worker that lists the feature. An older worker would run the step without that stop, so the field is never dropped and the step is not run there.
  if (carriesOwnerRedirect && !features.includes(OWNER_REDIRECT_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // A fix to a pull request that is already open (Plan 6 Task 15) must not be run by a worker that would take it for a first build, so the field is never dropped.
  if (carriesFix && !features.includes("task.workflowFix")) {
    throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  }
  // A review step that asks for fewer than both reviews must not be run by a worker that would run them all, so the field is never dropped.
  if (carriesReviewers && !features.includes("task.workflowReviewers")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "a review step that runs only some of the reviews needs a worker that runs just the reviews it is asked for");
  }
  // A worker built before application CHECKS, or one without the executor image on its host (it then does not list the feature), cannot run an application admission, and the admission's content decides what the round proves, so it is never
  // sent one (and never a trimmed one): the attempt fails with this reason instead (Ruling BQ, mixed fleet).
  if (carriesApplicationAdmission && !features.includes("task.workflowE2EApplicationChecks")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "browser and API verification needs a worker that runs application admissions (it must list task.workflowE2EApplicationChecks); this worker predates it or has no executor image on its host, so no application round was sent to it");
  }
  // Proof and evidence B1/B2: a capture policy with a strip or API samples is read only by a worker that lists the feature. An older worker parses the policy strictly and refuses the whole round after
  // compute was spent, so the round is never handed to it (and the fields are never trimmed away, since the signed admission fixes what the round proves).
  if (carriesCaptureExtras && !features.includes(E2E_CAPTURE_EXTRAS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "This worker can't take screenshot strips or API samples yet; retry once it restarts on the new image");
  }
  // A round with AI navigation steps needs the model channel only a worker that lists the feature has, and the steps are never trimmed away: the attempt fails with this reason instead.
  if (carriesAgentSteps && !features.includes(E2E_AGENT_STEPS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "This worker can't run AI navigation steps yet; retry once it restarts");
  }
  // Task 4.10: a route whose model the installation chose, or whose request shape is minimal, is derived only by a worker that lists the model-choice feature. An older worker would refuse it
  // after compute was spent, so it is refused here, with a fixed sentence. A route that cannot be read is refused too: it is never assumed to be the default.
  if (carriesAgentSteps && modelChoice !== undefined && !features.includes(E2E_AGENT_MODEL_CHOICE_FEATURE)) {
    let needs: boolean | undefined;
    try { needs = await modelChoice(); } catch { needs = undefined; }
    if (needs !== false) throw agentXError("RUNTIME_UNAVAILABLE", `${E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved}: this worker is too old for the chosen AI navigation model`);
  }
  // MIDSTEPCOOKIE: the worker's credential scan must be told the browser's session values before every model call. A worker (or its executor image) without that would call the model
  // with a scan that is a step old, or refuse every call after compute was spent, so a round with AI navigation steps is not sent to it.
  if (carriesAgentSteps && !features.includes(E2E_MODEL_SESSION_SYNC_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "This worker can't protect session values during AI navigation steps yet; retry once it restarts on the new image");
  }
  // M1.3 Task 3.4: a version 2 admission keys its runtime rows by profile and kind, which a worker built before it cannot read. It is refused here, before compute is spent, with a sentence the
  // owner can act on (the worker lists the feature again once it restarts on the new image).
  if (carriesApplicationAdmission && admissionSchemaVersion === E2E_APPLICATION_ADMISSION_SCHEMA_V2 && !features.includes("task.workflowE2EApplicationChecks.v2")) {
    throw agentXError("RUNTIME_UNAVAILABLE", COMBINED_CHECKS_WORKER_REFUSAL);
  }
  // M1.3 Task 3.7b: a baseline round is an application round of a kind of its own. A worker that runs application admissions but predates baseline rounds would run it as a
  // candidate's, and its refusal of the signed purpose would come only after compute was spent, so it is refused here with the reason.
  if (carriesApplicationAdmission && invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.purpose === "baseline" && !features.includes("task.workflowE2EBaselineChecks")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the baseline round on the unchanged code needs a worker that runs baseline rounds (it must list task.workflowE2EBaselineChecks); this worker predates it or has no executor image on its host, so no baseline round was sent to it");
  }
  // T7b: a grounding round (the proposed plan's must-not-change checks on the unchanged code) is a kind of its own too. A worker without its feature would not know the purpose, so it is
  // refused here before compute is spent; the plan then reads "not checked against the current app".
  if (carriesApplicationAdmission && invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.purpose === "grounding" && !features.includes(GROUNDING_CHECKS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the plan grounding round needs a worker that runs grounding rounds (it must list task.workflowE2EGroundingChecks.v1); this worker predates it, so no grounding round was sent to it");
  }
  // M1.4 Task 4.6b: an audit replay is an application round of a kind of its own, run with no model by a worker that lists its feature. An older worker could not parse the purpose, and one
  // that runs application rounds only would run it as a candidate's; it is never handed one, and nothing is spent on a worker that cannot run it.
  if (carriesApplicationAdmission && invocation.kind === "task" && invocation.payload.workflowE2EAdmission?.purpose === "replay" && !features.includes(E2E_REPLAY_CHECKS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the audit replay needs a worker that runs replay rounds (it must list task.workflowE2EReplayChecks.v1); this worker predates it or has no executor image on its host, so no replay was sent to it");
  }
  // Evaluation fix RUN-1 (Ruling DV): a route-pinned round whose groups with no agent step rely on the normal time limits goes only to a worker that compiles them that way; an older one would
  // refuse the admission after compute was spent, so it is refused here, before anything runs.
  if (carriesApplicationAdmission && needsModelFreeLimits && !features.includes(E2E_MODEL_FREE_LIMITS_FEATURE)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "this round's browser and API checks need a worker that runs them under the normal time limits (it must list task.workflowE2EModelFreeLimits.v1); this worker predates it, so no round was sent to it; update the worker, then retry the checks");
  }
  if (carriesProjectSetupSmoke && !features.includes("project.setupSmoke")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "project setup smoke requires a worker that implements project.setupSmoke");
  }
  // The pinned base decides what reviewers judge and whether a finding blocks, so it is never dropped.
  if (carriesWorkflowBase && !features.includes("task.workflowBase")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "workflow reviews need a worker that receives the task's pinned base commit");
  }
  // The checked tree binds the publication to what passed checks and reviews, so it is never dropped either.
  if (carriesCandidateTree && !features.includes("publish.candidateTree")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing the checked code needs a worker that publishes exactly the checked tree");
  }
  if (carriesPublicationMode && !features.includes("publish.mode")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing a workflow candidate needs a worker that authenticates the broker-selected publication mode");
  }
  if (carriesPublicationMode && !features.includes("publish.contextDigest")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing a workflow candidate needs a worker that authenticates its complete publication context");
  }
  if (carriesPublicationContextDigest !== carriesPublicationMode) {
    throw agentXError("CONFIG_INVALID", "workflow publication context digest is missing or unexpected");
  }
  if (invocation.kind === "publish" && carriesPublicationMode) {
    const context = workflowPublicationContext(invocation);
    if (context === undefined || workflowPublicationContextDigest(context) !== invocation.payload.publicationContextDigest) {
      throw agentXError("CONFIG_INVALID", "stored workflow publication context does not match its invocation");
    }
  }
  // The pinned base is the published commit's parent, which the broker checks on GitHub, so it is never dropped either.
  if (carriesPublishBase && !features.includes("publish.workflowBase")) {
    throw agentXError("RUNTIME_UNAVAILABLE", "publishing the checked code needs a worker that builds it on the task's pinned base commit");
  }
  // I3: rolling deploys put a new broker in front of an old worker, so an old worker must not fail the publication. It is sent no attribution and publishes as before, with no trailer on
  // the commit; the broker wrote the requester and approver lines into the description itself (it owns that text) and recorded the audit link and the people on the operation.
  const attributionUnsupported = carriesAttribution && !features.includes("publish.attribution");
  // Proof and evidence (wire-proof fix round 1): the request to gather the checks' test reports is informational (it changes nothing the run does or proves), so a worker that does not list it is sent no
  // field and runs the checks as before; no evidence is captured for that run, and the broker finds no raw file and keeps no pack. A run built while the proof switch was on and retried or re-delivered
  // after a worker-image rollback is therefore never failed on it.
  const evidenceUnsupported = invocation.kind === "task" && invocation.payload.evidenceCapture === true && !features.includes(EVIDENCE_CAPTURE_FEATURE);
  if (evidenceUnsupported) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.evidence_capture_omitted", reason: workerFeatures === undefined ? "no-probe" : "worker-lacks-feature", operationId: invocation.operationId, workspaceId: invocation.workspaceId, evidence: "not_captured" }));
  }
  // Test environment (wire-testenv fix round 1): the request to run the environment detectors only ADDS a draft to the setup draft's result, so a worker that does not list it is sent no field and drafts the
  // setup as before; no environment draft is made for that run (the setup route then says there is no draft), and this line records that detection did not run. Replaces: refusing the setup draft.
  const detectUnsupported = invocation.kind === "task" && invocation.payload.testEnvDetect === true && !features.includes(TEST_ENV_DETECT_FEATURE);
  if (detectUnsupported) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.test_env_detect_omitted", reason: workerFeatures === undefined ? "no-probe" : "worker-lacks-feature", operationId: invocation.operationId, workspaceId: invocation.workspaceId, detection: "not_run" }));
  }
  // SR-1 (switch `cr`): the second reviewer only ADDS an opinion to a review, so a worker that does not list it is sent the review without the field and runs it as today; its result then has no second-review key,
  // which the broker reads as "did not run: older worker" (flagged in `on`, silent in shadow). The review itself is never refused for it.
  const secondReviewerUnsupported = invocation.kind === "task" && invocation.payload.workflowSecondReviewer !== undefined && !features.includes(SECOND_REVIEWER_FEATURE);
  if (secondReviewerUnsupported) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.second_reviewer_omitted", reason: workerFeatures === undefined ? "no-probe" : "worker-lacks-feature", operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  // Evidence (S-2): the approved report path in the test environment's plan only helps the evidence read changed-line coverage, so a worker that lists the plan but not this field is sent the plan without it (its
  // strict parse would refuse the field); nothing else in the plan changes, and the omission is recorded.
  const coveragePathUnsupported = invocation.kind === "task" && invocation.payload.testEnvironment?.checks.some((check) => check.coveragePath !== undefined) === true && !features.includes(TEST_ENV_COVERAGE_PATH_FEATURE);
  if (coveragePathUnsupported) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.test_env_coverage_path_omitted", reason: workerFeatures === undefined ? "no-probe" : "worker-lacks-feature", operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  // SH30 (switch `sp`): company recipes only ADD a starting point to the detected draft, so a worker that does not list them (or does not detect at all, which the recipes need) is sent the run without them and drafts as
  // before; the operation's record of the offers is cleared by the recorder in `deliver`, and this line records that recipes did not run. Replaces: refusing the setup draft.
  const recipesUnsupported = invocation.kind === "task" && invocation.payload.testEnvRecipes !== undefined && (detectUnsupported || !features.includes(SETUP_RECIPES_FEATURE));
  if (recipesUnsupported) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.setup_recipes_omitted", reason: workerFeatures === undefined ? "no-probe" : "worker-lacks-feature", operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  // Saved environments (SH25): the saved image only SPEEDS UP a preparation, so a worker that does not list the feature is sent no field and sets up fresh (its strict parse would refuse the field); the omission
  // is recorded. Replaces: refusing the run.
  const savedEnvUnsupported = carriesSavedEnv && !features.includes(PREPARE_SAVED_ENV_FEATURE);
  if (savedEnvUnsupported) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.saved_env_omitted", reason: workerFeatures === undefined ? "no-probe" : "worker-lacks-feature", operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  const withAttribution = withoutSavedEnv(withoutCoveragePath(withoutSecondReviewer(withoutTestEnvRecipes(withoutTestEnvDetect(withoutEvidenceCapture(attributionUnsupported ? withoutAttribution(invocation) : invocation, evidenceUnsupported), detectUnsupported), recipesUnsupported), secondReviewerUnsupported), coveragePathUnsupported), savedEnvUnsupported);
  if (attributionUnsupported) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.attribution_omitted", reason: workerFeatures === undefined ? "no-probe" : "worker-lacks-feature", operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  // A reviewed fix is pushed only as exactly its reviewed tree; an older worker would push the workspace as it is, so it gets nothing.
  if (carriesPullRequestUpdate && !features.includes("task.workflowPullRequestUpdate")) {
    throw agentXError("RUNTIME_UNAVAILABLE", WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED);
  }
  // The base commit a merge names changes what the push is, so the field is never dropped.
  if (carriesBranchSync && !features.includes("maintain.workflowSync")) {
    throw agentXError("RUNTIME_UNAVAILABLE", WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED);
  }
  const reason = workerFeatures === undefined ? "no-probe" : "worker-lacks-feature";
  const leveled = withoutUnparsedFields(withAttribution, features);
  if (leveled !== withAttribution) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.thinking_level_omitted",
      reason,
      requestedThinkingLevel,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  // #341: an older worker cannot fetch a ChatGPT token, so its task runs on the default model it also carries.
  const unsupportedChatGpt = carriesChatGpt && !features.includes("model.chatgpt");
  if(unsupportedChatGpt&&invocation.kind==="task"&&invocation.payload.modelPolicy!==undefined)throw agentXError("RUNTIME_UNAVAILABLE","The worker cannot execute this governed personal model. Update the worker and retry.");
  if (unsupportedChatGpt) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.chatgpt_omitted", reason, operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  const checked = withoutReadiness(unsupportedChatGpt ? withoutChatGpt(leveled) : leveled, features);
  if (checked !== leveled) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.readiness_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const reported = withoutReportChecks(checked, features);
  if (reported !== checked) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.report_checks_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const phased = withoutStructuredPlans(reported, features);
  if (phased !== reported) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.structured_plans_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withChecks = withoutReviewChecks(phased, features);
  if (withChecks !== phased) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_checks_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withPlan = withoutReviewPlan(withChecks, features);
  if (withPlan !== withChecks) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_plan_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withFeedback = withoutReviewFeedback(withPlan, features);
  if (withFeedback !== withPlan) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_feedback_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withNote = withoutReviewNote(withFeedback, features);
  if (withNote !== withFeedback) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_note_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withRisk = withoutReviewRisk(withNote, features);
  if (withRisk !== withNote) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.review_risk_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withPush = withoutPushFix(withRisk, features);
  if (withPush !== withRisk) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.push_fix_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const anchored = withoutCodeAnchors(withPush, features);
  if (anchored !== withPush) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.code_anchors_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const planned = withoutApplicationPlans(anchored, features);
  if (planned !== anchored) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.application_plan_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const qualified = withoutPlanQuality(planned, features);
  if (qualified !== planned) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.plan_quality_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  // M1.3 Task 3.7b: the request to export the unchanged code is only for a worker that can; an older one runs the coding without it (a baseline never stops the coding), and the
  // baseline then says it could not be checked.
  const serial = withoutParallelParts(qualified, features);
  if (serial !== qualified) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.parallel_parts_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const baselineTrimmed = withoutBaselineSource(serial, features);
  // T7b: a planning run's request to export the unchanged code (to ground the plan) goes only to a worker that can, and only while the run still negotiates the application plan the
  // request depends on (a worker that does not parse that plan has it removed above, and the schema refuses the request without it).
  const sent = withoutGroundingSource(baselineTrimmed, features);
  if (sent !== baselineTrimmed) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.grounding_source_omitted", operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  if (baselineTrimmed !== serial) {
    console.log(JSON.stringify({
      component: "dispatcher",
      event: "dispatch.baseline_source_omitted",
      reason,
      operationId: invocation.operationId,
      workspaceId: invocation.workspaceId,
    }));
  }
  const withLessons = await withLearnedContext(sent, features, learnedFromRefs, evalFilesFromRefs);
  if (withLessons.omitted) {
    console.log(JSON.stringify({ component: "dispatcher", event: "dispatch.learned_context_omitted", reason: withLessons.reason, operationId: invocation.operationId, workspaceId: invocation.workspaceId }));
  }
  return withLessons.invocation;
}

/**
 * The stage a worker is sent, with its lessons built NOW from the lesson store (WL-6). The stored copy holds `learnedRefs` (ids and versions); the worker never sees them. A worker that lists
 * "task.learnedContext.v1" gets the `learnedContext` the refs resolve to, from the lessons as they are at this moment (erased, retired, expired or edited ones left out); anything else gets the stage
 * without lessons, which is safe. A lookup that fails sends no lessons: the stage still runs, as without memory. A stage queued before this change may still carry a stored `learnedContext` (lesson text in the queue):
 * it is dropped, never delivered unchecked.
 */
export async function withLearnedContext(invocation: WorkerInvocation, features: readonly string[], resolve?: Ec2DeliveryDependencies["learnedFromRefs"], resolveFiles?: Ec2DeliveryDependencies["evalFilesFromRefs"]): Promise<{ invocation: WorkerInvocation; omitted: boolean; reason: string }> {
  if (invocation.kind !== "task") return { invocation, omitted: false, reason: "" };
  const { learnedRefs: refs, ...payload } = invocation.payload;
  if (refs === undefined) {
    // Lesson text stored in the queue is never delivered unchecked: a stage queued by an older build with a stored `learnedContext` is sent without it (it runs as without memory, which is always allowed).
    if (payload.learnedContext === undefined) return { invocation, omitted: false, reason: "" };
    const { learnedContext: _legacy, ...bare } = payload;
    void _legacy;
    return { invocation: { ...invocation, payload: bare }, omitted: true, reason: "stored_text_dropped" };
  }
  // The refs never go to a worker, and nothing the refs replace is kept: the lessons are the resolved ones or none.
  const { learnedContext: _stored, ...rest } = payload;
  void _stored;
  // Lane 7, the file arm: a replay copy's lessons are a file in its checkout, not a prompt block. The step is sent only to a worker that places it (an older one would run the arm with no file and say nothing), and only with the
  // file built NOW from the copy's frozen snapshot; a file that cannot be built is no lessons (the arm records that it loaded nothing).
  if (refs.file !== undefined) {
    if (!features.includes(EVAL_FILES_FEATURE)) throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
    let files: EvalFilesPayload | undefined;
    try { files = resolveFiles === undefined ? undefined : await resolveFiles(refs); } catch { files = undefined; }
    if (files === undefined) return { invocation: { ...invocation, payload: rest }, omitted: true, reason: "no_lessons_at_delivery" };
    return { invocation: { ...invocation, payload: { ...rest, evalFiles: files } }, omitted: false, reason: "" };
  }
  if (!features.includes(LEARNED_CONTEXT_FEATURE)) return { invocation: { ...invocation, payload: rest }, omitted: true, reason: "worker_lacks_feature" };
  let context: LearnedContext | undefined;
  try { context = resolve === undefined ? undefined : await resolve(refs); } catch { context = undefined; }
  if (context === undefined || (context.lessons.length === 0 && (context.priorLoaded ?? []).length === 0)) return { invocation: { ...invocation, payload: rest }, omitted: true, reason: "no_lessons_at_delivery" };
  return { invocation: { ...invocation, payload: { ...rest, learnedContext: context } }, omitted: false, reason: "" };
}

/** A stage without the lessons chosen for it, for a worker that does not list "task.learnedContext.v1": it would reject the field. Nothing is lost but the advice. */
export function withoutLearnedContext(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.learnedContext === undefined || features.includes(LEARNED_CONTEXT_FEATURE)) return invocation;
  const { learnedContext: _lessons, ...payload } = invocation.payload;
  void _lessons;
  return { ...invocation, payload };
}

/**
 * An approved plan's parts for a worker that does not list "task.workflowParallelParts": it would reject the `parallel` setting, and it builds the parts one after another, which
 * the broker's checkpoint rules accept and which costs no more (only time). The `parallel` setting is the one field of a plan run that is withheld rather than refused (owner
 * ruling), and only when the older worker can take over the retained progress; otherwise the run is refused with the worker-outdated text. The plan and its approval are sent whole.
 */
function withoutParallelParts(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowDependencies?.parallel === undefined || features.includes("task.workflowParallelParts")) return invocation;
  // Progress that parallel parts left is not one an older worker can resume from; it is refused, not sent.
  if (!serialWorkerCanResume(invocation.payload.workflowDependencies)) throw agentXError("RUNTIME_UNAVAILABLE", AGENT_WORKER_OUTDATED);
  const { parallel: _parallel, ...workflowDependencies } = invocation.payload.workflowDependencies;
  void _parallel;
  return { ...invocation, payload: { ...invocation.payload, workflowDependencies } };
}

/** A coding run without the request to export the unchanged code, for a worker that does not list "task.workflowE2EBaselineSource": it would reject the field. The export reads the repository alone, so this feature is not withheld with the executor image. */
function withoutBaselineSource(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowE2EBaselineSource === undefined || features.includes("task.workflowE2EBaselineSource")) return invocation;
  const { workflowE2EBaselineSource: _request, ...payload } = invocation.payload;
  void _request;
  return { ...invocation, payload };
}

/** A planning run without the request to export the unchanged code for grounding, for a worker that does not list the grounding feature or whose run no longer negotiates the application plan. */
function withoutGroundingSource(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowE2EGroundingSource === undefined) return invocation;
  if (features.includes(GROUNDING_CHECKS_FEATURE) && invocation.payload.workflowE2EPlanVersion === 2) return invocation;
  const { workflowE2EGroundingSource: _request, ...payload } = invocation.payload;
  void _request;
  return { ...invocation, payload };
}

/** A planning prompt that does not ask for anchor lines, for a worker that does not parse them: it would reject a plan that carried one. */
function withoutCodeAnchors(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || !asksForCodeAnchors(invocation.payload.prompt) || features.includes("task.codeAnchors")) return invocation;
  return { ...invocation, payload: { ...invocation.payload, prompt: withoutCodeAnchorText(invocation.payload.prompt) } };
}

/** A planning prompt without the plan quality guidance, for a worker that does not list the plan-quality feature: it would reject a plan that carried the members the guidance names. */
function withoutPlanQuality(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || !asksForPlanQuality(invocation.payload.prompt) || features.includes(PLAN_DRY_RUN_FEATURE)) return invocation;
  return { ...invocation, payload: { ...invocation.payload, prompt: withoutPlanQualityText(invocation.payload.prompt) } };
}

/**
 * A worker that does not list "task.workflowE2EApplicationPlan" parses only the portable schemaVersion 1 intent, so it is never handed a version 2
 * one: a planning run is sent the portable-only prompt without the plan version, and a review's approved plan without its (version 2) E2E intent.
 * The edit is deterministic, so a retry sends what the first attempt did.
 */
function withoutApplicationPlans(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || features.includes("task.workflowE2EApplicationPlan")) return invocation;
  const payload = { ...invocation.payload };
  let changed = false;
  if (payload.workflowE2EPlanVersion !== undefined) {
    delete payload.workflowE2EPlanVersion;
    changed = true;
  }
  const prompt = withoutApplicationPlanText(payload.prompt);
  if (prompt !== payload.prompt) {
    payload.prompt = prompt;
    changed = true;
  }
  if (payload.workflowReviewPlan?.e2eIntent?.schemaVersion === 2) {
    const { e2eIntent: _applicationIntent, ...plan } = payload.workflowReviewPlan;
    void _applicationIntent;
    payload.workflowReviewPlan = plan;
    changed = true;
  }
  return changed ? { ...invocation, payload } : invocation;
}

/** A planning run without the kind and format of plan it writes, for a worker that does not parse them; it plans without checking the answer's format. */
function withoutStructuredPlans(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || (invocation.payload.workflowPhase === undefined && invocation.payload.planFormat === undefined) || features.includes("task.structuredPlans")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowPhase;
  delete payload.planFormat;
  return { ...invocation, payload };
}

/**
 * A review without the note of which checks ran, for a worker that does not parse it. The note only informs the
 * reviewers' prompt; such a worker reviews the same change as before, without being told which checks ran.
 */
function withoutReviewChecks(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewChecks === undefined || features.includes("task.workflowReviewChecks")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewChecks;
  return { ...invocation, payload };
}

/**
 * A review without the approved plan, for a worker that does not parse it. The plan only informs the reviewers'
 * prompt; such a worker reviews the same change as before, without seeing the plan.
 */
function withoutReviewPlan(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewPlan === undefined || features.includes("task.workflowReviewPlan")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewPlan;
  return { ...invocation, payload };
}

/**
 * A review without the owner's approved PR feedback, for a worker that does not parse it. It only informs the reviewers'
 * prompt; such a worker reviews the same change as before, judging it against the plan alone.
 */
function withoutReviewFeedback(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewFeedback === undefined || features.includes("task.workflowReviewFeedback")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewFeedback;
  return { ...invocation, payload };
}

/** A review without the owner's retry note for a worker that does not parse it; its review remains unchanged. */
function withoutReviewNote(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewNote === undefined || features.includes("task.workflowReviewNote")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewNote;
  return { ...invocation, payload };
}

/** A push of a fix without the name of the fix it is, for a worker that does not parse it: the push is the same, and its commit keeps the usual message. */
function withoutPushFix(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "maintain" || invocation.payload.workflowFix === undefined || features.includes("task.workflowFix")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowFix;
  return { ...invocation, payload };
}

/**
 * A review without the request for a risk level, for a worker that does not parse it. The level is one more input of the risk shown on the pull request; such a worker reviews the same change
 * as before, and the risk comes from the paths, the size and the checks alone.
 */
function withoutReviewRisk(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.workflowReviewRisk === undefined || features.includes("task.workflowReviewRisk")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowReviewRisk;
  return { ...invocation, payload };
}

/**
 * A publication without reportChecks, for a worker that does not parse it (spec 051, D-7). Such a worker refuses a
 * failing readiness check, as before, and reports no checks, so the broker opens the pull request as it did.
 */
function withoutReportChecks(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "publish" || invocation.payload.reportChecks === undefined || features.includes("publish.reportChecks")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.reportChecks;
  return { ...invocation, payload };
}

/** A task without its ChatGPT plan, for a worker that cannot use one (#341). */
function withoutChatGpt(invocation: WorkerInvocation): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.chatgpt === undefined) return invocation;
  const payload = { ...invocation.payload };
  delete payload.chatgpt;
  return { ...invocation, payload };
}

/** A task without its readiness, for a worker that does not parse it (spec 051). */
function withoutReadiness(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind !== "task" || invocation.payload.readiness === undefined || features.includes("task.readiness")) return invocation;
  const payload = { ...invocation.payload };
  delete payload.readiness;
  return { ...invocation, payload };
}

/** The first thinking level the invocation carries: a task's model, or a project definition's models. */
function carriedThinkingLevel(invocation: WorkerInvocation): string | undefined {
  if (invocation.kind === "task") return invocation.payload.model?.thinkingLevel;
  if (!carriesProject(invocation)) return undefined;
  const models = invocation.payload.project.models;
  if (models === undefined) return undefined;
  return [models.default, ...models.approved].find((model) => model.thinkingLevel !== undefined)?.thinkingLevel;
}

function withoutUnparsedFields(invocation: WorkerInvocation, features: readonly string[]): WorkerInvocation {
  if (invocation.kind === "task") {
    if (invocation.payload.model === undefined) return invocation;
    const model = modelSelectionFor(invocation.payload.model, features);
    return model === invocation.payload.model ? invocation : { ...invocation, payload: { ...invocation.payload, model } };
  }
  if (!carriesProject(invocation) || features.includes("model.thinkingLevel")) return invocation;
  const models = invocation.payload.project.models;
  if (models === undefined) return invocation;
  const project = { ...invocation.payload.project, models: { default: withoutLevel(models.default), approved: models.approved.map(withoutLevel) } };
  // Identical branches so each keeps its own payload type within the discriminated union.
  if (invocation.kind === "prepare") return { ...invocation, payload: { ...invocation.payload, project } };
  if (invocation.kind === "publish") return { ...invocation, payload: { ...invocation.payload, project } };
  return { ...invocation, payload: { ...invocation.payload, project } };
}

/** A publication without the attribution field (and the very object back for anything else). */
/** The invocation with the plan's checks stripped of `coveragePath` when `drop` (and the very object back otherwise). */
function withoutCoveragePath(invocation: WorkerInvocation, drop: boolean): WorkerInvocation {
  if (!drop || invocation.kind !== "task" || invocation.payload.testEnvironment === undefined) return invocation;
  const plan = invocation.payload.testEnvironment;
  return { ...invocation, payload: { ...invocation.payload, testEnvironment: { ...plan, checks: plan.checks.map(({ id, kind, selectArgs }) => ({ id, kind, ...(selectArgs === undefined ? {} : { selectArgs }) })) } } };
}

/** The invocation without the evidence request when `drop` (and the very object back otherwise). */
function withoutEvidenceCapture(invocation: WorkerInvocation, drop: boolean): WorkerInvocation {
  if (!drop || invocation.kind !== "task") return invocation;
  const payload = { ...invocation.payload };
  delete payload.evidenceCapture;
  return { ...invocation, payload };
}

/** The invocation without the company recipes offered to the setup draft when `drop` (and the very object back otherwise). */
function withoutTestEnvRecipes(invocation: WorkerInvocation, drop: boolean): WorkerInvocation {
  if (!drop || invocation.kind !== "task") return invocation;
  const payload = { ...invocation.payload };
  delete payload.testEnvRecipes;
  return { ...invocation, payload };
}

/** The invocation without the request to detect the test environment when `drop` (and the very object back otherwise). */
function withoutTestEnvDetect(invocation: WorkerInvocation, drop: boolean): WorkerInvocation {
  if (!drop || invocation.kind !== "task") return invocation;
  const payload = { ...invocation.payload };
  delete payload.testEnvDetect;
  return { ...invocation, payload };
}

function withoutSavedEnv(invocation: WorkerInvocation, drop: boolean): WorkerInvocation {
  if (!drop || invocation.kind !== "prepare") return invocation;
  const payload = { ...invocation.payload };
  delete payload.savedEnv;
  return { ...invocation, payload };
}

function withoutSecondReviewer(invocation: WorkerInvocation, drop: boolean): WorkerInvocation {
  if (!drop || invocation.kind !== "task") return invocation;
  const payload = { ...invocation.payload };
  delete payload.workflowSecondReviewer;
  return { ...invocation, payload };
}

function withoutAttribution(invocation: WorkerInvocation): WorkerInvocation {
  if (invocation.kind !== "publish" || invocation.payload.attribution === undefined) return invocation;
  const payload = { ...invocation.payload };
  delete payload.attribution;
  return { ...invocation, payload };
}

/** The same invocation with every project model's stored check result dropped (and the very object back when it carries none). */
function withoutLastCheck(invocation: WorkerInvocation): WorkerInvocation {
  if (!carriesProject(invocation)) return invocation;
  const models = invocation.payload.project.models;
  if (models === undefined || ![models.default, ...models.approved].some((model) => model.lastCheck !== undefined)) return invocation;
  const strip = <Model extends { lastCheck?: unknown }>(model: Model): Omit<Model, "lastCheck"> => { const rest: Model = { ...model }; delete rest.lastCheck; return rest; };
  const project = { ...invocation.payload.project, models: { default: strip(models.default), approved: models.approved.map(strip) } };
  if (invocation.kind === "prepare") return { ...invocation, payload: { ...invocation.payload, project } };
  if (invocation.kind === "publish") return { ...invocation, payload: { ...invocation.payload, project } };
  return { ...invocation, payload: { ...invocation.payload, project } };
}

/** Prepare, publish and maintain carry the whole stored project definition; cancel, resume and close carry none. */
function carriesProject(invocation: WorkerInvocation): invocation is Extract<WorkerInvocation, { kind: "prepare" | "publish" | "maintain" }> {
  return invocation.kind === "prepare" || invocation.kind === "publish" || invocation.kind === "maintain";
}

function withoutLevel<Model extends { thinkingLevel?: unknown }>(model: Model): Omit<Model, "thinkingLevel"> {
  const rest: Model = { ...model };
  delete rest.thinkingLevel;
  return rest;
}
