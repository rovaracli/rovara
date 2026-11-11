import { ActingAttributionSchema, AgentStepPayloadSchema, AGENTX_PROTOCOL_VERSION, AgentXNameSchema, DesignReviewBindingSchema, DiagnosisInvocationSchema, E2EWorkflowAdmissionRefSchema, EvalFilesPayloadSchema, LearnedContextSchema, LearnedRefsSchema, LiveSteerPayloadSchema, ModelRouteSchema, ModelSelectionSchema, NightlyRunPayloadSchema, OwnerRedirectInvocationSchema, PeekPayloadSchema, PrepareMetaSchema, PreparePinsSchema, PrepareRegistriesSchema, PrepareSavedEnvBuildSchema, PrepareSavedEnvSchema, ProjectCommandSchema, RunCheckoutSchema, SecondReviewerSchema, SETUP_RECIPE_OFFERS_MAX, SetupAgentWireSchema, SetupRecipeOfferSchema, SpecReviewInputSchema, SpecWriteBindingSchema, StandingInstructionsPayloadSchema, StoredProjectDefinitionSchema, TASK_DEPENDENCY_PLAN_MAX, TaskDependencyPlanSchema, TaskModelPolicyBindingSchema, TestEnvTaskPlanSchema, WorkflowDependencyInvocationSchema, WorkflowFeedbackApprovalBindingSchema, WorkflowReviewBaseSchema, WorkflowReviewChecksSchema, WorkflowReviewFeedbackSchema, WorkflowReviewNoteSchema, WorkflowReviewPlanSchema } from "@rovara-code/contracts";
import { z } from "zod";
import { WorkflowFixPayloadSchema } from "./rovara-code.js";



const InvocationBaseSchema = z.object({
  protocolVersion: z.literal(AGENTX_PROTOCOL_VERSION),
  operationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  fence: z.number().int().positive(),
  projectRevision: z.number().int().positive(),
  callbackCapability: z.string().min(32).max(8_192),
});

export const WorkerInvocationSchema = z.discriminatedUnion("kind", [
  InvocationBaseSchema.extend({
    kind: z.literal("project-setup-smoke"),
    payload: z.object({
      domain: z.literal("project-setup-source-interface/v1"),
      setupExecutionId: z.string().uuid(),
      subjectId: z.string().uuid(),
      approvalRevision: z.number().int().positive(),
      /** Opaque supervisor-issued correlation for transport auth; never a project workspace identity. */
      transportCorrelationId: z.string().uuid(),
      executionRef: z.object({
        key: z.string().regex(/^project-setup-executions\/sha256\/[a-f0-9]{64}\.json$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z.number().int().positive().max(24 * 1024 * 1024),
      }).strict(),
    }).strict(),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("prepare"),
    payload: z.object({
      project: StoredProjectDefinitionSchema,
      repositoryGrant: z.string().min(1),
      /** An agent-step run that looks at pull requests: after cloning, the worker fetches each head, checks the commit out detached and verifies it (Plan 3, Task 22). Sent only to a worker that lists `task.agentRun`. */
      checkout: z.array(RunCheckoutSchema).max(10).optional(),
      /** An agent-step run's preparation clones and checks out only: no devcontainer, no setup command, no readiness command (Plan 3 final fix wave). Sent only to a worker that lists `task.agentRun`. */
      readOnly: z.literal(true).optional(),
      /** Meta repo lane A3: the project's meta repository, read-only and sparse, beside the code. Sent only to a worker that lists `prepare.metaRepo`. */
      meta: PrepareMetaSchema.optional(),
      /** N9 (INTG2): the project's private package registries (where they are, never a credential): the worker asks the broker for each one's short-lived token by name, writes the package manager's config outside the repository for the setup and readiness commands, and removes it. Sent only to a worker that lists `prepare.registries.v1`. */
      registries: PrepareRegistriesSchema.optional(),
      /** Saved environments (SH25, switch `sv`): the project's saved image to start from (digest, a one-repository pull login, the revision the task is pinned to). Informational: a worker that does not list `prepare.savedEnv.v1` is sent no field and sets up fresh. */
      savedEnv: PrepareSavedEnvSchema.optional(),
      /** P1: the default-branch head the broker read for each repository of a setup run; the worker refuses the preparation if its own resolution differs. Sent only to a worker that lists `prepare.pins.v1`. */
      pins: PreparePinsSchema.optional(),
      /** Saved project images (switch `sv`): a rebuild of the project's image. The preparation is read only and pinned (`pins` are the job's commits); after it the worker proves the approved environment in a fresh sandbox and builds and pushes the image (saved-env/rebuild.ts). The lease token is added by the dispatcher at delivery. Sent only to a worker that lists `prepare.savedEnvBuild.v1`; never dropped. */
      savedEnvBuild: PrepareSavedEnvBuildSchema.optional(),
      /**
       * Test services (slice 1, Prove): a test environment's CANDIDATE check starts these dependencies (pinned by digest; no secret), runs the proposal's readiness commands against them with the sealed check runners and
       * reports a usage record under `testServicesUsage` in its result. Sent only with the switch `tx` on and only to a worker whose /ping lists `task.testServices.v1`; never dropped (delivery refuses an older worker).
       */
      testServices: z.object({ dependencies: z.array(TaskDependencyPlanSchema).min(1).max(TASK_DEPENDENCY_PLAN_MAX) }).strict().optional(),
    }).strict(),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("task"),
    payload: z
      .object({
        conversationId: z.string().uuid(),
        prompt: z.string().min(1).max(65_536),
        /** The control plane's record that this conversation already owns a saved session. */
        conversationStarted: z.boolean().optional(),
        /** The broker-selected tool boundary for the current native workflow stage (spec 056). */
        workflowMode: z.enum(["PLAN", "IMPLEMENT", "REVIEW", "CHECKS", "FEEDBACK_REVIEW", "UNDERSTAND", "PLAN_CRITIQUE", "SETUP_DRAFT", "SETUP_AGENT", "SPEC_WRITE"]).optional(),
        /** The setup run that runs commands (SH14, switch `su`): its limits, fixed by the broker when the run started. Only with `workflowMode: "SETUP_AGENT"`, and only to a worker whose /ping lists "task.setupAgent.v1". */
        setupAgent: SetupAgentWireSchema.optional(),
        /** The nightly run (NH-1, switch `nh`): what the broker fixed when the fire started it. Only with `workflowMode: "CHECKS"`, and only to a worker whose /ping lists "task.nightlyRun.v1". */
        nightlyRun: NightlyRunPayloadSchema.optional(),
        /**
         * Meta repo lane B: a setup proposal run is told which of the project's repositories is its meta repository (the team's rules, specs and runbooks live there), so it
         * knows where to look for them. Sent only with `workflowMode: "SETUP_DRAFT"`, and only to a worker whose /ping lists "task.setupProposal.v2".
         */
        setupMetaRepo: AgentXNameSchema.optional(),
        /**
         * The document a planning run writes in the Full path (a Quick plan has none). The worker uses it to read the
         * planner's answer as that kind of plan. Sent only to a worker whose /ping lists "task.structuredPlans"; an older
         * worker is sent the run without it.
         */
        workflowPhase: z.enum(["REQUIREMENTS", "DESIGN", "IMPLEMENTATION_PLAN"]).optional(),
        /**
         * The broker asked this planning run for a structured plan (spec 061). Only then does the worker check the answer
         * and ask once more when it cannot be read. Sent only to a worker whose /ping lists "task.structuredPlans".
         */
        planFormat: z.literal("structured").optional(),
        /**
         * Opt-in to the schema-v2 application E2E plan: the planner may propose it and the worker's plan parser accepts it. Sent only to a
         * worker whose /ping lists "task.workflowE2EApplicationPlan"; an older one is sent the portable-only prompt, without this field.
         * Absent means the portable schemaVersion 1 intent only.
         */
        workflowE2EPlanVersion: z.literal(2).optional(),
        workflowFeedbackReview: z.object({ taskId: z.string().uuid(), workflowRevision: z.number().int().positive(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
        workflowFeedbackApproval: WorkflowFeedbackApprovalBindingSchema.optional(),
        /** Server-assigned immutable native E2E round; the worker must reload it through its signed callback capability. */
        workflowE2EAdmission: E2EWorkflowAdmissionRefSchema.optional(),
        /**
         * M1.3 Task 3.7b: a coding run is asked to export the unchanged code (its recorded base commit) beside the candidate, for the baseline round of the approved application plan.
         * Sent only to a worker whose /ping lists "task.workflowE2EBaselineSource" (which, unlike the baseline CHECKS feature, needs no executor image: the export reads the repository alone); an older one is sent the run without it, and the baseline then says it could not be checked.
         */
        workflowE2EBaselineSource: z.literal(true).optional(),
        /**
         * T7a: a coding plan run is asked to export the unchanged code (the signed workflow base) after planning, so the plan's must-not-change checks can be tried on the current app before the owner is asked.
         * Sent only to a worker whose /ping lists "task.workflowE2EGroundingChecks.v1" and only to a structured planning run that negotiated the application plan; absent means the run is as before.
         */
        workflowE2EGroundingSource: z.literal(true).optional(),
        /** One approved same-repository dependency graph, sent only to workers advertising task.workflowDependencies. */
        workflowDependencies: WorkflowDependencyInvocationSchema.optional(),
        /**
         * The task's pinned base commit per repository (the workflow's reviewBase). The worker records it in the
         * candidate and reviewers see the diff from it. Sent only to a worker whose /ping lists "task.workflowBase".
         */
        workflowBase: WorkflowReviewBaseSchema.optional(),
        /**
         * The checks that ran on the candidate under review, or that it is review only, for the reviewers' prompt.
         * Review operations only. Sent only to a worker whose /ping lists "task.workflowReviewChecks"; an older worker
         * is sent the review without it and reviews as before, without that section.
         */
        workflowReviewChecks: WorkflowReviewChecksSchema.optional(),
        /**
         * The coding plan the owner approved, for the reviewers' prompt. Review operations only. Sent only to a worker
         * whose /ping lists "task.workflowReviewPlan"; an older worker is sent the review without it.
         */
        workflowReviewPlan: WorkflowReviewPlanSchema.optional(),
        /**
         * The fixes the owner approved from pull request feedback since the plan, for the reviewers' prompt. Review
         * operations only. Sent only to a worker whose /ping lists "task.workflowReviewFeedback"; an older worker is sent
         * the review without it.
         */
        workflowReviewFeedback: WorkflowReviewFeedbackSchema.optional(),
        /**
         * Meta repo lane D (D3): the spec's requirements, read by the broker at the commit recorded when the spec was published, for the code review to walk. Review operations only. Sent only to a worker whose /ping
         * lists "task.workflowReviewSpec.v1"; never dropped, because an older worker would review without the spec.
         */
        workflowReviewSpec: SpecReviewInputSchema.optional(),
        /** The exact owner retry note, shown as untrusted context. Older workers omit it and review as before. */
        workflowReviewNote: WorkflowReviewNoteSchema.optional(),
        /**
         * Which reviews a review operation runs when its step asks for fewer than both (a custom coding sequence's
         * security-only review). Absent: both, as always. Sent only to a worker whose /ping lists "task.workflowReviewers";
         * never dropped, because an older worker would run reviews the step did not ask for.
         */
        workflowReviewers: z.array(z.enum(["CRITIC", "SECURITY"])).min(1).max(2).refine((roles) => new Set(roles).size === roles.length, "reviewers must be unique").optional(),
        /**
         * Rovara Code version 2: the code review states a risk level (low, medium or high) beside its findings. Review operations only. It only adds one word to the report; a worker whose /ping does not list
         * "task.workflowReviewRisk" is sent the review without it, and the risk level then comes from the paths, the size and the checks alone.
         */
        workflowReviewRisk: z.literal(true).optional(),
        /** SR-1: the second reviewer (another AI company's model) that runs after the reviews above, inside this operation. Review operations only; a worker without "task.workflowSecondReviewer.v1" is sent the review without it. */
        workflowSecondReviewer: SecondReviewerSchema.optional(),
        /**
         * DR5: this PLAN_CRITIQUE operation reviews a design with several fresh reviewers (see DesignReviewBindingSchema). Plan-check mode only; sent only to a worker that lists "task.designReview.v1"; never dropped,
         * because an older worker would run the plan check on the design with one session that has the planner's workspace and history.
         */
        designReview: DesignReviewBindingSchema.optional(),
        /**
         * Rovara Code (Plan 6 Task 15): this coding run fixes a pull request that is already open (failing CI, a conflict, comments), so it changes that code and leaves it alone when
         * nothing it can do helps. Implementation mode only. Sent only to a worker whose /ping lists "task.workflowFix"; never dropped, because an older worker would take the run for a first build.
         */
        workflowFix: WorkflowFixPayloadSchema.optional(),
        /**
         * Meta repo lane D: the spec write run. It reads the owner-approved plan (in the prompt, as data) and returns a structured spec draft; it changes nothing. SPEC_WRITE mode only. Sent only to a worker whose /ping
         * lists "task.specWrite.v1"; never dropped, because an older worker would not know the mode.
         */
        specWrite: SpecWriteBindingSchema.optional(),
        /**
         * Lane E: the project has MCP context sources for this stage (Understand, Plan, Plan check or Review; never Build), so the worker asks the broker for the stage's source tools with its
         * `context-tools` capability. Sent only to a worker that lists "task.contextSources.v1"; never dropped, because an older worker would run the stage without the team's sources and say nothing.
         */
        contextSources: z.literal(true).optional(),
        model: ModelSelectionSchema.optional(),
        /**
         * Sign in with ChatGPT (#341): the task runs on its owner's ChatGPT plan, with this model, and the worker asks
         * the control plane for the owner's access token through its callback capability. `model` stays the install's
         * default, which the worker uses when the plan cannot be. Sent only to a worker whose /ping lists "model.chatgpt".
         */
        chatgpt: z.object({ model: ModelSelectionSchema }).strict().optional(),
        modelSelectionDiagnostic: z.string().min(1).max(512).optional(),
        /**
         * Spec 051 (P-1): the project's current readiness commands, which the worker reruns when the agent finishes.
         * Optional: a payload from a broker built before it has none, and the worker falls back to the agent's own
         * test commands. Sent only to a worker whose /ping lists "task.readiness". The limit is the project's own.
         */
        readiness: z.array(ProjectCommandSchema).max(64).optional(),
        /** What the agent's recipe adds to this operation, or the agent step it is. Sent only to a worker that lists "task.agentStep"; never dropped. */
        agentStep: AgentStepPayloadSchema.optional(),
        /**
         * Standing instructions (lanes I1 and I2): the company's rules and the project's "How we work" for this step, as one text the worker puts in the SYSTEM prompt, after Rovara's own prompt and preamble and before the
         * repository's files and the skills. Sent only to a worker that lists "task.standingInstructions.v1"; never dropped (an older worker is refused the step at delivery).
         */
        standingInstructions: StandingInstructionsPayloadSchema.optional(),
        /** The model proxy alias to use in place of the install's default route. Sent only to a worker that lists "model.route"; never dropped. */
        modelRoute: ModelRouteSchema.optional(),
        /** Governed tasks require broker authorization before any worker-side replacement; never dropped. */
        modelPolicy:TaskModelPolicyBindingSchema.optional(),
        /**
         * Learning v2: the lessons chosen for this stage, advice the worker re-checks against the task's base commit and renders in a labelled block. Sent only to a worker that lists
         * "task.learnedContext.v1"; an older worker is sent none, which is safe (the task runs as without memory). Never carries a tool, a check, an approval or a limit.
         */
        learnedContext: LearnedContextSchema.optional(),
        /**
         * The stored and queued form of `learnedContext` (WL-6): lesson ids and versions only. The dispatcher turns it into `learnedContext` from the lesson store at delivery and never sends it on
         * to a worker, so no lesson text sits in an outbox row, a queue message or a dead-letter copy.
         */
        learnedRefs: LearnedRefsSchema.optional(),
        /**
         * Lessons replay, the file arm (DECISIONS 50.5, 68): the lessons file and its pointer the worker places in a replay copy's checkout before the agent starts, kept out of any diff. Built by the dispatcher at
         * delivery for a replay copy only; never stored or queued. Sent only to a worker that lists "task.evalFiles.v1"; never dropped (an older worker is refused the step).
         */
        evalFiles: EvalFilesPayloadSchema.optional(),
        /**
         * Live interaction, Stop & redirect (keep the plan): the owner's instruction that stopped the previous run of this coding step. The worker records it as taken from the owner (so the re-approval stop applies) and
         * puts it in the prompt, framed and untrusted. Implementation mode only. Sent only to a worker whose /ping lists "task.ownerRedirect.v1"; never dropped, because an older worker would run the step
         * without the re-approval stop the owner's instruction is bound by.
         */
        ownerRedirect: OwnerRedirectInvocationSchema.optional(),
        /**
         * Live interaction F3 (Fix with agent, deep tier): this read-only look is a diagnosis, not a setup draft. The worker adds the diagnosis instructions and answers with the diagnosis JSON. Setup-draft mode
         * only (read, grep, find and ls: no shell, no write tool, no network, no MCP). Sent only to a worker whose /ping lists "task.diagnosis.v1"; never dropped, because an older worker would run it as a setup draft.
         */
        diagnosis: DiagnosisInvocationSchema.optional(),
        /**
         * Proof and evidence (wire-proof): this verification run also writes `evidence-raw.json` (the test report of each check that names one, read in the workspace; never a change to any command). Verification mode
         * only. Sent only while the proof switch is on, and only to a worker whose /ping lists "task.evidenceCapture.v1"; the dispatcher drops the field for an older worker (no evidence is captured and the omission is logged), because its strict parse would refuse it.
         */
        evidenceCapture: z.literal(true).optional(),
        /**
         * Test environment (wire-testenv): this setup draft also runs the environment detectors over the default branch's files and reports the environment it would propose (a draft, never approved or run). Setup-draft
         * mode only. Sent only while the test environment switch is on, and only to a worker whose /ping lists "task.testEnvDetect.v1"; the dispatcher drops the field for an older worker (the setup draft then has no environment draft and the omission is logged), because its strict parse would refuse it.
         */
        testEnvDetect: z.literal(true).optional(),
        /** SH30 (switch `sp`): the company recipes offered to the detectors' proposal. Only with `testEnvDetect`; only to a worker whose /ping lists "task.setupRecipes.v1". */
        testEnvRecipes: z.array(SetupRecipeOfferSchema).max(SETUP_RECIPE_OFFERS_MAX).optional(),
        /**
         * Test environment (wire-testenv): the approved environment as this verification run needs it (which commands are its checks, how to select tests, the round budget). Verification mode only; a coding run is sent it too, but only a plan with dependencies (test services: the working sandbox gets them while the agent codes). Sent only while the
         * switch is on and the task pinned an environment a task may use, and only to a worker whose /ping lists "task.testEnvironment.v1"; never dropped, because an older worker's strict parse would refuse it.
         */
        testEnvironment: TestEnvTaskPlanSchema.optional(),
      })
      .strict().superRefine((payload, context) => {
        if ((payload.setupAgent !== undefined) !== (payload.workflowMode === "SETUP_AGENT")) {
          context.addIssue({ code: "custom", path: ["setupAgent"], message: "a setup run carries its limits, and only a setup run does" });
        }
        if (payload.setupAgent !== undefined && (payload.agentStep !== undefined || payload.ownerRedirect !== undefined || payload.specWrite !== undefined || payload.contextSources !== undefined || payload.diagnosis !== undefined || payload.testEnvDetect !== undefined)) {
          context.addIssue({ code: "custom", path: ["setupAgent"], message: "a setup run carries no agent step, redirect, spec write, context sources, diagnosis or detection" });
        }
        if (payload.nightlyRun !== undefined && payload.workflowMode !== "CHECKS") {
          context.addIssue({ code: "custom", path: ["nightlyRun"], message: "a nightly run is a verification-mode operation" });
        }
        if (payload.diagnosis !== undefined && payload.workflowMode !== "SETUP_DRAFT") {
          context.addIssue({ code: "custom", path: ["diagnosis"], message: "a diagnosis is a read-only look and requires the setup draft mode" });
        }
        if (payload.diagnosis !== undefined && (payload.agentStep !== undefined || payload.ownerRedirect !== undefined || payload.specWrite !== undefined || payload.contextSources !== undefined)) {
          context.addIssue({ code: "custom", path: ["diagnosis"], message: "a diagnosis carries no agent step, redirect, spec write or context sources" });
        }
        if (payload.evidenceCapture !== undefined && payload.workflowMode !== "CHECKS") {
          context.addIssue({ code: "custom", path: ["evidenceCapture"], message: "evidence capture requires the verification (checks) mode" });
        }
        if (payload.testEnvRecipes !== undefined && payload.testEnvDetect !== true) {
          context.addIssue({ code: "custom", path: ["testEnvRecipes"], message: "company recipes are offered to a test environment detection only" });
        }
        if (payload.testEnvDetect !== undefined && (payload.workflowMode !== "SETUP_DRAFT" || payload.diagnosis !== undefined)) {
          context.addIssue({ code: "custom", path: ["testEnvDetect"], message: "test environment detection requires the setup draft mode and is not a diagnosis" });
        }
        // Test services (slice 1): a coding run carries the plan too, but only one with dependencies (the working sandbox gets them while the agent codes); every other mode is as it was.
        if (payload.testEnvironment !== undefined && payload.workflowMode !== "CHECKS" && !(payload.workflowMode === "IMPLEMENT" && (payload.testEnvironment.dependencies?.length ?? 0) > 0)) {
          context.addIssue({ code: "custom", path: ["testEnvironment"], message: "a test environment plan requires the verification (checks) mode, or a coding run with dependencies" });
        }
        if (payload.ownerRedirect !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["ownerRedirect"], message: "an owner redirect requires implementation mode" });
        }
        if (payload.ownerRedirect !== undefined && payload.agentStep !== undefined) {
          context.addIssue({ code: "custom", path: ["ownerRedirect"], message: "an owner redirect is for a coding step, not an agent step (the agent step would ignore it)" });
        }
        if(payload.modelPolicy!==undefined&&payload.model===undefined)context.addIssue({code:"custom",path:["model"],message:"a governed task requires an explicit server-resolved model"});
        if ((payload.workflowMode === "FEEDBACK_REVIEW") !== (payload.workflowFeedbackReview !== undefined)) {
          context.addIssue({ code: "custom", path: ["workflowFeedbackReview"], message: "feedback review mode requires its exact task workflow binding" });
        }
        if (payload.workflowPhase !== undefined && payload.workflowMode !== "PLAN") {
          context.addIssue({ code: "custom", path: ["workflowPhase"], message: "the document a run writes requires planning mode" });
        }
        if (payload.planFormat !== undefined && payload.workflowMode !== "PLAN") {
          context.addIssue({ code: "custom", path: ["planFormat"], message: "the plan format requires planning mode" });
        }
        if (payload.workflowE2EPlanVersion !== undefined && (payload.workflowMode !== "PLAN" || payload.planFormat !== "structured")) {
          context.addIssue({ code: "custom", path: ["workflowE2EPlanVersion"], message: "the application E2E plan version requires a structured planning run" });
        }
        if (payload.workflowE2EGroundingSource !== undefined && (payload.workflowMode !== "PLAN" || payload.planFormat !== "structured" || payload.workflowE2EPlanVersion !== 2)) {
          context.addIssue({ code: "custom", path: ["workflowE2EGroundingSource"], message: "the grounding source export requires a structured planning run with the application plan version" });
        }
        if (payload.workflowReviewChecks !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewChecks"], message: "the checks reviewers are told about require review mode" });
        }
        if (payload.workflowReviewPlan !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewPlan"], message: "the approved plan reviewers are shown requires review mode" });
        }
        if (payload.workflowReviewFeedback !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewFeedback"], message: "the approved feedback reviewers are shown requires review mode" });
        }
        if (payload.workflowReviewNote !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewNote"], message: "the retry note reviewers are shown requires review mode" });
        }
        if (payload.workflowReviewSpec !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewSpec"], message: "the spec the review walks requires review mode" });
        }
        if (payload.workflowReviewers !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewers"], message: "the reviews to run require review mode" });
        }
        if (payload.workflowSecondReviewer !== undefined && (payload.workflowMode !== "REVIEW" || (payload.workflowReviewers !== undefined && !payload.workflowReviewers.includes("CRITIC")))) {
          context.addIssue({ code: "custom", path: ["workflowSecondReviewer"], message: "the second reviewer requires review mode with the code review" });
        }
        if (payload.designReview !== undefined && payload.workflowMode !== "PLAN_CRITIQUE") {
          context.addIssue({ code: "custom", path: ["designReview"], message: "the design review requires plan-check mode" });
        }
        if (payload.workflowReviewRisk !== undefined && payload.workflowMode !== "REVIEW") {
          context.addIssue({ code: "custom", path: ["workflowReviewRisk"], message: "the review's risk level requires review mode" });
        }
        if (payload.workflowFix !== undefined && (payload.workflowMode !== "IMPLEMENT" || payload.workflowDependencies !== undefined)) {
          context.addIssue({ code: "custom", path: ["workflowFix"], message: "a fix to an open pull request requires implementation mode and no work breakdown" });
        }
        if ((payload.workflowMode === "SPEC_WRITE") !== (payload.specWrite !== undefined)) {
          context.addIssue({ code: "custom", path: ["specWrite"], message: "the spec write mode and its binding go together" });
        }
        if (payload.workflowFeedbackApproval !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["workflowFeedbackApproval"], message: "feedback approval binding requires implementation mode" });
        }
        // Rovara's own decision on review comments (Plan 6 Task 16) is a feedback fix. (A feedback fix may also run with no approval: the owner's Retry of one that stopped continues it from the current code.)
        if (payload.workflowFeedbackApproval?.autonomy !== undefined && payload.workflowFix?.source !== "feedback") {
          context.addIssue({ code: "custom", path: ["workflowFeedbackApproval"], message: "an automatic feedback approval belongs to a feedback fix" });
        }
        if (payload.workflowDependencies !== undefined && payload.workflowMode !== "IMPLEMENT") {
          context.addIssue({ code: "custom", path: ["workflowDependencies"], message: "a work breakdown requires implementation mode" });
        }
        if (payload.workflowE2EAdmission !== undefined && payload.workflowMode !== "CHECKS") {
          context.addIssue({ code: "custom", path: ["workflowE2EAdmission"], message: "a trusted E2E admission requires its separate CHECKS operation" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("publish"),
    payload: z
      .object({
        project: StoredProjectDefinitionSchema,
        repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        title: z.string().min(1).max(256),
        body: z
          .string()
          .refine((value) => !value.includes("\0"), "body contains a NUL character")
          .refine(
            (value) => new TextEncoder().encode(value).byteLength <= 32_768,
            "body exceeds 32768 UTF-8 bytes",
          )
          .optional(),
        headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
        repositoryGrant: z.string().min(1),
        mode: z.enum(["create", "replace", "revert"]).default("create"),
        targetPullRequestNumber: z.number().int().positive().optional(),
        revertCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
        /**
         * Spec 051 (D-7, P-2): the broker opens a draft pull request with a checks section when a check fails, so the
         * worker publishes despite a failing readiness check and reports its checks with the pull request callback.
         * Without it (a broker built before it), a failing check still refuses the publication, as before. Sent only
         * to a worker whose /ping lists "publish.reportChecks".
         */
        reportChecks: z.literal(true).optional(),
        /**
         * The tree the task's checks and reviews passed on. The worker publishes exactly this tree on the task's base and
         * refuses before pushing when the workspace no longer matches it. Sent only to a worker whose /ping lists
         * "publish.candidateTree"; never dropped for an older one.
         */
        candidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /** Server-selected behavior for publishing a workflow candidate; never supplied by a caller. */
        publicationMode: z.enum(["COMMITTED_HEAD", "CHECKED_TREE"]).optional(),
        /** Digest of the immutable workflow publication context, copied into the signed worker claims. */
        publicationContextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        /** The exact committed HEAD whose tree was checked and reviewed. */
        candidateCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /**
         * The base commit the broker pinned for the task in this repository: the published commit's only parent, in
         * place of the commit the workspace's (agent-writable) preparation manifest records. Only with candidateTreeSha.
         * Sent only to a worker whose /ping lists "publish.workflowBase"; never dropped for an older one.
         */
        workflowBaseCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /**
         * Enterprise foundations I3: who asked for the work and who approved its plan, written as `Requested-by` / `Approved-by` trailers on the commit the worker makes. Built by the broker from its
         * own records (a person who was erased is "a former member", never named). Sent only to a worker whose /ping lists "publish.attribution"; never dropped for an older one, because a
         * publication that was meant to say whose it was must not go out saying nothing.
         */
        attribution: ActingAttributionSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.mode === "create" && (value.targetPullRequestNumber !== undefined || value.revertCommit !== undefined)) {
          context.addIssue({ code: "custom", message: "create mode must not target another pull request" });
        }
        if ((value.mode === "replace" || value.mode === "revert") && value.targetPullRequestNumber === undefined) {
          context.addIssue({ code: "custom", message: `${value.mode} mode requires targetPullRequestNumber` });
        }
        if (value.mode === "revert" && value.revertCommit === undefined) {
          context.addIssue({ code: "custom", message: "revert mode requires revertCommit" });
        }
        if (value.mode !== "revert" && value.revertCommit !== undefined) {
          context.addIssue({ code: "custom", message: "revertCommit is allowed only in revert mode" });
        }
        if (value.mode !== "create" && value.candidateTreeSha !== undefined) {
          context.addIssue({ code: "custom", message: "candidateTreeSha is allowed only in create mode" });
        }
        if (value.workflowBaseCommit !== undefined && value.candidateTreeSha === undefined) {
          context.addIssue({ code: "custom", message: "workflowBaseCommit is allowed only with candidateTreeSha" });
        }
        if (value.candidateCommitSha !== undefined && value.candidateTreeSha === undefined) {
          context.addIssue({ code: "custom", message: "candidateCommitSha is allowed only with candidateTreeSha" });
        }
        if ((value.candidateTreeSha === undefined) !== (value.publicationMode === undefined)) {
          context.addIssue({ code: "custom", path: ["publicationMode"], message: "candidateTreeSha and publicationMode go together" });
        }
        if (value.publicationMode === "COMMITTED_HEAD" && value.candidateCommitSha === undefined) {
          context.addIssue({ code: "custom", path: ["candidateCommitSha"], message: "committed-head publication requires the exact checked commit" });
        }
        if (value.publicationMode === "CHECKED_TREE" && value.candidateCommitSha !== undefined) {
          context.addIssue({ code: "custom", path: ["candidateCommitSha"], message: "checked-tree publication cannot select a commit" });
        }
        if ((value.publicationMode === undefined) !== (value.publicationContextDigest === undefined)) {
          context.addIssue({ code: "custom", path: ["publicationContextDigest"], message: "workflow publication mode and context digest must be present together" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("maintain"),
    payload: z
      .object({
        action: z.enum(["append", "sync"]),
        project: StoredProjectDefinitionSchema,
        repository: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        pullRequestNumber: z.number().int().positive(),
        headBranch: z.string().regex(/^agentx\/[0-9a-f-]{36}$/i),
        baseBranch: z.string().min(1).max(255),
        expectedHeadCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
        repositoryGrant: z.string().min(1),
        /**
         * A workflow task's fix to its pull request: the tree the fix's checks and reviews passed on. The worker pushes
         * exactly this tree, runs no readiness checks again, and refuses before pushing when the workspace no longer
         * matches it. Sent only to a worker whose /ping lists "task.workflowPullRequestUpdate".
         */
        workflowCandidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /** The base commit the broker pinned for the task in this repository; it must be in the workspace's history. Always and only with workflowCandidateTreeSha. */
        workflowBaseCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
        /**
         * Which fix the reviewed tree is (failing CI, a conflict, comments), so its commit says so. Only with workflowCandidateTreeSha. It changes nothing about the push: a worker whose /ping does not list
         * "task.workflowFix" is sent the push without it, and its commit keeps the usual message.
         */
        workflowFix: WorkflowFixPayloadSchema.optional(),
        /**
         * A workflow task's merge of the base branch into its pull request's branch (Plan 6 Task 17, `sync` only): the worker merges exactly `baseCommit` (no rebase, no force-push), runs the readiness
         * checks and pushes to the head it was told (`expectedHeadCommit`); a conflict is returned as the conflicting files, nothing pushed, the merge's files left in the workspace. Sent only to a
         * worker whose /ping lists "maintain.workflowSync"; never dropped, because an older worker would merge whatever the base is now.
         */
        workflowSync: z.object({ baseCommit: z.string().regex(/^[a-f0-9]{40}$/), expectedHeadCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict().optional(),
        /**
         * A conflict round's reviewed fix is pushed as a merge commit (`append` with the reviewed tree only): the first parent is the head the pull request has, the second is this commit of the base.
         * Sent only to a worker whose /ping lists "maintain.workflowSync".
         */
        workflowMergeBase: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.workflowSync !== undefined && (value.action !== "sync" || value.workflowCandidateTreeSha !== undefined || value.workflowSync.expectedHeadCommit !== value.expectedHeadCommit)) {
          context.addIssue({ code: "custom", path: ["workflowSync"], message: "a merge of the base branch is a sync of the recorded head, with no reviewed tree" });
        }
        if (value.workflowMergeBase !== undefined && value.workflowCandidateTreeSha === undefined) {
          context.addIssue({ code: "custom", path: ["workflowMergeBase"], message: "the base a fix was merged with goes with the reviewed tree" });
        }
        if (value.workflowFix !== undefined && value.workflowCandidateTreeSha === undefined) {
          context.addIssue({ code: "custom", path: ["workflowFix"], message: "the fix a push is for goes with the reviewed tree" });
        }
        if (value.workflowCandidateTreeSha !== undefined && value.action !== "append") {
          context.addIssue({ code: "custom", message: "workflowCandidateTreeSha is allowed only with append" });
        }
        // A reviewed fix is pushed only with the task's base, so its base ancestry is always checked.
        if ((value.workflowBaseCommit === undefined) !== (value.workflowCandidateTreeSha === undefined)) {
          context.addIssue({ code: "custom", message: "workflowBaseCommit and workflowCandidateTreeSha go together" });
        }
      }),
  }).strict(),
  InvocationBaseSchema.extend({
    kind: z.literal("cancel"),
    payload: z.object({ targetOperationId: z.string().uuid() }).strict(),
  }).strict(),
  // Live steer: a person's message for the pi session of the running step `payload.targetOperationId` (live-steer.ts).
  InvocationBaseSchema.extend({ kind: z.literal("steer"), payload: LiveSteerPayloadSchema }).strict(),
  // Live interaction A2: a read-only look at the workspace's working tree for an Ask (live-peek.ts). Answered on the same request; no operation record, no callback.
  InvocationBaseSchema.extend({ kind: z.literal("peek"), payload: PeekPayloadSchema }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("resume"), payload: z.object({}).strict() }).strict(),
  InvocationBaseSchema.extend({ kind: z.literal("close"), payload: z.object({}).strict() }).strict(),
]);

export type WorkerInvocation = z.infer<typeof WorkerInvocationSchema>;
