// Test environment (wire-testenv): the shapes that cross the wire between the broker and the worker, and the answers of the setup routes.
//
//   TestEnvDraftSchema    what a SETUP_DRAFT run reports when the broker asked it to detect (`testEnvDetect`): the detectors' environment with the source of each value. A DRAFT is never approved or run: the broker
//                         reads it again, refuses anything but the safest tier, and only a maintainer's propose / prove / approve makes it a revision.
//   TestEnvTaskPlanSchema what a CHECKS run is sent when the project has an approved environment: which readiness commands are the environment's checks, how to select tests, the round budget and the nightly's inputs.
//   the route answers     what `GET/POST /v1/app/projects/{name}/test-environment*` say.
//
// The feature strings are what a worker advertises on /ping: an older worker is refused the run at dispatch (a strict parse would refuse the field), never mis-run.
import { z } from "zod";
import { CoverageMapSchema } from "./test-env-nightly.js";
import { CheckKindSchema } from "./evidence.js";
import { TEST_ENV_ROUND_BUDGET_MIN, TEST_ENV_SELECTION_METHODS, TEST_ENV_SELECT_PLACEHOLDER, TestEnvValueSourceSchema, TestEnvironmentBodySchema, type TestEnvironmentBody } from "./test-environment.js";

export const TEST_ENV_DETECT_FEATURE = "task.testEnvDetect.v1";
export const TEST_ENV_PLAN_FEATURE = "task.testEnvironment.v1";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

/** The most inline coverage map a CHECKS run is sent: a larger one is not sent (the run then selects nothing and runs the whole check). */
export const TEST_ENV_PLAN_MAP_MAX_BYTES = 256 * 1_024;
export const TEST_ENV_PLAN_FAILURES_MAX = 500;

/** A service the code calls that the detectors found, listed so a person can decide; it is not part of the environment (a mocked service needs a recorded fixture set first). */
export const TestEnvPendingServiceSchema = z.object({ kind: z.enum(["sagemaker_runtime", "http"]), target: line(253) }).strict();
export type TestEnvPendingService = z.infer<typeof TestEnvPendingServiceSchema>;

export const TestEnvDraftSchema = z
  .object({
    environment: TestEnvironmentBodySchema,
    valueSources: z.array(z.object({ field: line(200), source: TestEnvValueSourceSchema }).strict()).max(400),
    pendingServices: z.array(TestEnvPendingServiceSchema).max(32),
    /** Fixed statements for the maintainer (what was found that the proposal cannot use, and what is not known). */
    notes: z.array(line(400)).max(60),
    questions: z.array(line(400)).max(60),
  })
  .strict();
export type TestEnvDraft = z.infer<typeof TestEnvDraftSchema>;

/** The most a draft may weigh once serialized (worker and broker both hold to it): well under DynamoDB's 400 KB item limit, which would cancel the setup draft's own result write. */
export const TEST_ENV_DRAFT_MAX_BYTES = 200 * 1_024;

/** The key under which a draft rides in a SETUP_DRAFT run's result. */
export const TEST_ENV_DRAFT_RESULT_KEY = "testEnvironmentDraft";

export const TestEnvTaskPlanSchema = z
  .object({
    revision: z.number().int().min(1),
    /** The approved environment's digest (`testEnvDigest`): the worker echoes it into the evidence, the broker compares it. */
    digest: Sha256,
    roundBudgetMin: z.number().int().min(TEST_ENV_ROUND_BUDGET_MIN.min).max(TEST_ENV_ROUND_BUDGET_MIN.max),
    selection: z
      .object({
        method: z.enum(TEST_ENV_SELECTION_METHODS),
        declared: z.array(z.object({ glob: z.string().min(1).max(256), tests: z.array(z.string().min(1).max(256)).min(1).max(50) }).strict()).max(100).optional(),
        alwaysRun: z.array(Id).max(32),
        fullSuiteOn: z.array(z.string().min(1).max(256)).max(100),
      })
      .strict(),
    /** Readiness command `i` of the run is the environment's check `checks[i]`, for `i < checks.length`: the run's first commands are the environment's checks, in order. */
    checks: z.array(z.object({ id: Id, kind: CheckKindSchema, selectArgs: z.array(z.string().min(1).max(256)).max(8).optional() }).strict()
      .superRefine((check, context) => {
        if (check.selectArgs !== undefined && check.selectArgs.filter((arg) => arg === TEST_ENV_SELECT_PLACEHOLDER).length !== 1) context.addIssue({ code: "custom", path: ["selectArgs"], message: "selectArgs holds {tests} exactly once" });
      })).min(1).max(32),
    /** The tests that failed in the last nightly: they always run. */
    lastNightlyFailures: z.array(z.string().min(1).max(500)).max(TEST_ENV_PLAN_FAILURES_MAX).optional(),
    /** The nightly's coverage map, only when it fits (`TEST_ENV_PLAN_MAP_MAX_BYTES`); without it a coverage-map selection runs the whole check, with its reason. */
    coverageMap: CoverageMapSchema.optional(),
  })
  .strict()
  .refine((plan) => plan.coverageMap === undefined || JSON.stringify(plan.coverageMap).length <= TEST_ENV_PLAN_MAP_MAX_BYTES, { message: "an inline coverage map is at most 256 KiB", path: ["coverageMap"] });
export type TestEnvTaskPlan = z.infer<typeof TestEnvTaskPlanSchema>;

// ---- the setup routes

export const TEST_ENV_REFUSALS = [
  "no_draft", "stale_draft", "no_proposal", "not_provable", "outdated", "checking", "failed", "no_setup_check", "commands_differ", "nothing_to_prove", "services_need_prove", "setup_check_old",
] as const;
export type TestEnvRefusal = (typeof TEST_ENV_REFUSALS)[number];

/** A check as the approval card shows it, with the arguments that narrow its tests (shown, because they decide which tests run once a map exists). */
const CheckRow = z.object({ id: Id, label: line(80), kind: CheckKindSchema, selectArgs: z.array(z.string().min(1).max(256)).max(8).optional() }).strict();
export const TestEnvSummarySchema = z
  .object({
    tier: z.enum(["sandbox", "preview", "shared"]),
    repositories: z.array(z.object({ repositoryId: line(200), setupCommands: z.number().int().min(0), checks: z.array(CheckRow).max(32) }).strict()).max(16),
    selectionMethod: z.enum(TEST_ENV_SELECTION_METHODS),
    roundBudgetMin: z.number().int(),
    nightly: z.object({ enabled: z.boolean(), cronUtc: line(64), branch: line(255) }).strict(),
    services: z.number().int().min(0),
  })
  .strict();
export type TestEnvSummary = z.infer<typeof TestEnvSummarySchema>;

export function testEnvSummaryOf(body: TestEnvironmentBody): TestEnvSummary {
  return {
    tier: body.tier,
    repositories: body.repos.map((repo) => ({ repositoryId: repo.repositoryId, setupCommands: repo.setupCommands.length, checks: repo.checks.map((check) => ({ id: check.id, label: check.label, kind: check.kind, ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }) })) })),
    selectionMethod: body.selection.method,
    roundBudgetMin: body.roundBudgetMin,
    nightly: { enabled: body.nightly.enabled, cronUtc: body.nightly.cronUtc, branch: body.nightly.branch },
    services: body.services.length,
  };
}

export const TestEnvironmentStateSchema = z
  .object({
    approved: z.object({ revision: z.number().int().min(1), approvedAt: z.string().datetime(), digest: Sha256, summary: TestEnvSummarySchema }).strict().optional(),
    /** What the latest setup run found, ready to propose. `stale`: the setup run is older than the project's settings or is not ready. */
    draft: z.object({ status: z.enum(["none", "ready", "stale"]), notes: z.array(line(400)).max(60), questions: z.array(line(400)).max(60), pendingServices: z.array(TestEnvPendingServiceSchema).max(32) }).strict(),
    proposal: z
      .object({
        digest: Sha256,
        risk: z.enum(["low", "medium", "high"]),
        lessSafe: z.array(z.string().max(60)).max(20),
        summary: TestEnvSummarySchema,
        proved: z.boolean(),
        proveSteps: z.array(z.object({ step: z.string().max(40), status: z.enum(["passed", "failed", "skipped"]) }).strict()).max(10),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TestEnvironmentState = z.infer<typeof TestEnvironmentStateSchema>;

export const TestEnvProposeBodySchema = z.object({}).strict();
export const TestEnvProveBodySchema = z.object({ digest: Sha256 }).strict();
export const TestEnvApproveBodySchema = z.object({ digest: Sha256, expectedRevision: z.number().int().min(0), requestId: z.string().min(8).max(100).optional() }).strict();
