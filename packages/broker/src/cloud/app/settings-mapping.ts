// Convergence S0-Q2: Cloud's settings, mapped onto the options of Rovara Code's core.
//
// Code's core takes its behaviour from a few flow options (`understandFirst`, `planCheck`, `planSelfCheck`, `autofix`, `liveSteer`, `limits`), from the
// project rules of its custom agents (`allowConnectorWrites`) and from a lessons switch. Cloud keeps the same choices in its own settings. The root reads
// Cloud's settings with Cloud's own readers and passes the core what Cloud would have done, per company. Nothing here reads a store or a clock: it is a
// pure mapping over a plain description of the settings (`CloudCompanySettings`), so a table test can state each row and the parity suite can run the
// core with exactly the settings the Cloud journey has.
//
// What Cloud's Quick path reads today, for the choices a Quick task makes (the core has no separate Quick settings, so these decide Quick and Full alike):
//   - Understand first and the plan check: `hasPlanCheck` (the company's pinned Rovara Code recipe has a `plan_critic` step) and `rovaraCodeV2Live`
//     (switch `rv`): packages/broker/src/aws/developer-tasks/start.ts:370 and :372. With either missing the task starts on the plan step with no program.
//   - The plan's self-check: `dependencies.planSelfCheck !== false` (aws/broker/plan-answers.ts:168), set from PLAN_SELF_CHECK_ENABLED (aws/broker.ts:639).
//   - Automatic fixing: `autofixConfigFromEnvironment` (aws/workflow-autofix-runner.ts:57, AUTOFIX_ENABLED, AUTOFIX_CAP_USD), read at aws/broker.ts:640.
//   - Lessons: `learnedLessonsEnabled` (lessons/switch.ts:11, LEARNED_LESSONS_ENABLED, exactly "1").
//   - Live steer: LIVE_STEER_ENABLED, exactly "1" (the `ls` switch).
//   - Workspace limits: `readWorkspaceLimits` (developer/limits.ts:19): the company's WORKSPACE_LIMITS setting, else SLACK_MEMBER/ORGANIZATION_WORKSPACE_LIMIT.
import { AUTO_FIX_DEFAULT_CAP_USD, type ResolvedRecipe } from "@rovara-code/contracts";
import type { RegistryTaskFlowOptions } from "@rovara-code/broker/core/task-flow";
import { learnedLessonsEnabled } from "../../lessons/switch.js";
import { rovaraCodeV2LiveFromEnvironment } from "../../rovara-code/v2-switch.js";

/** What one company's settings say, in the words Cloud reads them in. Build it with `cloudSettingsFromEnvironment`, or by hand in a test. */
export interface CloudCompanySettings {
  /** `rv` (rovaraCodeV2Live): Understand and the plan check run on this install. */
  rovaraCodeV2Live: boolean;
  /**
   * The step kinds of the company's pinned Rovara Code recipe (`store.pinnedBuiltinVersion` then `builtinRecipe`), or undefined where Cloud's agents are not wired
   * (the journey install): no plan check step is known, so a task starts on the plan step.
   */
  recipeStepKinds: readonly string[] | undefined;
  /** `wd` (AGENTX_WORKFLOW_DEPENDENCIES_ENABLED): exactly "true". Cloud lets a version 1 task start its approved ordered plan only with this on (rovara-code/parallel-parts.ts `workflowDependenciesAllowed`). */
  workflowDependencies: boolean;
  /** `pc` (PLAN_SELF_CHECK_ENABLED): on unless exactly "false". */
  planSelfCheck: boolean;
  /** `fx` (AUTOFIX_ENABLED) and AUTOFIX_CAP_USD. `capUsd` NaN: Cloud's policy asks instead of acting; the core reads it the same way. */
  autofix: { enabled: boolean; capUsd: number; roundEstimateUsd: number };
  /** `ll` (LEARNED_LESSONS_ENABLED): exactly "1". */
  lessons: boolean;
  /** `ls` (LIVE_STEER_ENABLED): exactly "1". */
  liveSteer: boolean;
  /** The company's open-workspace limits (its WORKSPACE_LIMITS setting, else the stack parameters). Undefined: the core's own defaults stand. */
  workspaceLimits?: { member: number; organization: number } | undefined;
  /**
   * The lighter flow (decisions 178 and 179): a small change skips the planning steps and gets one quick check. ON by default, for everyone; `LIGHTER_FLOW_ENABLED` is the switch back, and only the word
   * "false" (any case, trimmed) turns it off (the same rule as `fx`). The core has no option of this name yet: the flow-P lanes (P1, P2) name it, and until a vendor re-pin carries it `mapCloudSettings` answers it
   * in `lighterFlow` and does not pass it to the flow.
   */
  lighterFlow: boolean;
  /** Cloud serves a connector write behind a person's approval (its approvers adapter is registered), so the core's rule may say yes. */
  connectorWritesBehindApproval: boolean;
}

/** One Cloud setting the core has no option for, and why. */
export interface UnmappedSetting {
  /** The Cloud switch or setting. */
  setting: string;
  /** `service`: the core has a seam for it, built by its own service lane; `none`: the core has no counterpart (Cloud's own product, or a later lane). */
  kind: "service" | "none";
  why: string;
}

export interface CoreSettings {
  /** The flow options, to be spread into `createCoreRuntime`'s `flowOptions`. */
  flowOptions: Required<Pick<RegistryTaskFlowOptions, "understandFirst" | "planCheck" | "planSelfCheck" | "autofix" | "liveSteer" | "workflowDependenciesEnabled">> & Pick<RegistryTaskFlowOptions, "limits">;
  /** Whether the lighter flow is on for this company (178: default ON). Not a flow option until the flow-P lanes are in the pin. */
  lighterFlow: boolean;
  /** The project rules for the core's chains and custom agents. */
  projectRules: { allowConnectorWrites: boolean };
  /** Whether lessons are on (the core's `lessonsEnabled`). */
  lessonsEnabled: () => boolean;
}

/** Cloud's number for the cost of one more automatic round (aws/workflow-autofix-runner.ts AUTOFIX_ROUND_ESTIMATE_USD), the same figure the core defaults to. */
const AUTOFIX_ROUND_ESTIMATE_USD = 3;

/** The recipe's step kinds, from a resolved recipe (the company's pinned Rovara Code recipe). */
export const recipeStepKinds = (recipe: Pick<ResolvedRecipe, "steps">): readonly string[] => recipe.steps.map((step) => step.kind);

/**
 * Cloud's settings from the broker's environment (the packed settings put back under their variable names). The same switches Cloud reads: `rv`, `pc`, `fx`
 * with its cap, `ll`, `ls`. `recipeStepKinds`, `workspaceLimits` and `connectorWritesBehindApproval` are per company and come from Cloud's records, so the
 * caller gives them.
 */
export function cloudSettingsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  company: Pick<CloudCompanySettings, "recipeStepKinds" | "connectorWritesBehindApproval"> & { workspaceLimits?: CloudCompanySettings["workspaceLimits"] },
): CloudCompanySettings {
  const cap = env["AUTOFIX_CAP_USD"] === undefined ? AUTO_FIX_DEFAULT_CAP_USD : Number(env["AUTOFIX_CAP_USD"]);
  return {
    rovaraCodeV2Live: rovaraCodeV2LiveFromEnvironment(env),
    workflowDependencies: env["AGENTX_WORKFLOW_DEPENDENCIES_ENABLED"] === "true",
    recipeStepKinds: company.recipeStepKinds,
    // aws/broker.ts:639: only the exact word "false" turns the plan self-check off.
    planSelfCheck: env["PLAN_SELF_CHECK_ENABLED"] !== "false",
    // aws/workflow-autofix-runner.ts:57-61: on unless AUTOFIX_ENABLED=false (any case); a cap that is not a number is no cap, and the policy then asks.
    autofix: { enabled: env["AUTOFIX_ENABLED"]?.trim().toLowerCase() !== "false", capUsd: Number.isFinite(cap) && cap >= 0 ? cap : Number.NaN, roundEstimateUsd: AUTOFIX_ROUND_ESTIMATE_USD },
    lessons: learnedLessonsEnabled(env),
    liveSteer: env["LIVE_STEER_ENABLED"] === "1",
    // Case-insensitive and trimmed, as `fx` (AUTOFIX_ENABLED) is read: an operator's " False " is off.
    lighterFlow: env["LIGHTER_FLOW_ENABLED"]?.trim().toLowerCase() !== "false",
    ...(company.workspaceLimits === undefined ? {} : { workspaceLimits: company.workspaceLimits }),
    connectorWritesBehindApproval: company.connectorWritesBehindApproval,
  };
}

/** Cloud's settings mapped onto the core's options. Everything the core would otherwise default (on) is stated, so a Cloud setting that is off is off on the core. */
export function mapCloudSettings(settings: CloudCompanySettings): CoreSettings {
  // start.ts:370 and :372: the task understands first only with a plan check step in the recipe AND the switch on.
  const hasPlanCheck = settings.recipeStepKinds?.includes("plan_critic") === true;
  const understandFirst = hasPlanCheck && settings.rovaraCodeV2Live;
  return {
    flowOptions: {
      understandFirst,
      planCheck: hasPlanCheck,
      planSelfCheck: settings.planSelfCheck,
      // The core's default is ON (core/build-step/autofix.ts reads `enabled !== false`); Cloud's is its own switch, so it is always stated.
      autofix: { enabled: settings.autofix.enabled, capUsd: settings.autofix.capUsd, roundEstimateUsd: settings.autofix.roundEstimateUsd },
      liveSteer: settings.liveSteer,
      // Switch blocker G3 (0517-REPIN-PARTS-NEED-V2): with Understand off a task is version 1.0.0, and the core starts an ordered work plan (parts) on a 1.0.0 task only where the install says so.
      // Cloud's own rule is `workflowDependenciesAllowed`: the `wd` switch, or a Rovara Code v2 task (`rv` live). The core gets the same: on only where either is on, never always.
      workflowDependenciesEnabled: settings.workflowDependencies || settings.rovaraCodeV2Live,
      ...(settings.workspaceLimits === undefined ? {} : { limits: { member: settings.workspaceLimits.member, organization: settings.workspaceLimits.organization } }),
    },
    lighterFlow: settings.lighterFlow,
    projectRules: { allowConnectorWrites: settings.connectorWritesBehindApproval },
    lessonsEnabled: () => settings.lessons,
  };
}

/**
 * The Cloud settings that have no flow option on the core, each with why. A switch listed `service` has a core seam that a service lane builds over Cloud's
 * own data (the root passes it in `services` or a later `flowOptions` entry); `none` has no counterpart in the core at all. Kept as data so the lane report and
 * the suite name the same list.
 */
export const UNMAPPED_SETTINGS: readonly UnmappedSetting[] = [
  { setting: "dr (design review)", kind: "service", why: "the core's `designReview` seam is built by createDesignReviewSteps over Cloud's per-project How we work; that wiring is the design-review lane's" },
  { setting: "si (standing instructions)", kind: "service", why: "the core's `standingInstructions` seam needs Cloud's company rules and project How we work read through the playbook port" },
  { setting: "cr (second review)", kind: "service", why: "the core's `secondReview` seam needs Cloud's second-review settings and model source" },
  { setting: "ev, sv, tx, ta, pj (test environment, saved environments, test services)", kind: "service", why: "the core's `testEnvironment` seam reads Cloud's approved test setup; the test-environment lane wires it" },
  { setting: "pe (proof evidence)", kind: "service", why: "the core's `keepEvidence` seam; Cloud's evidence pack lane wires it" },
  { setting: "vx, nh, su, sp (four test results, nightly health, setup agent, setup recipes)", kind: "service", why: "each is a core service (core/setup-agent, core/health) the setup lane builds; none is a flow option" },
  { setting: "ak, rd, fd (Ask, redirect, Fix with agent)", kind: "service", why: "core services with their own kill switches in the local app; Cloud's live-interaction lane maps them" },
  { setting: "dk (decision cards)", kind: "service", why: "the core's decision gate is always on; the card routes are Cloud's pages over the gate" },
  { setting: "pr (project registries)", kind: "none", why: "private package registries reach Cloud's worker setup only; the core worker has no registry grant yet (enterprise pilot, ask the customer first)" },
  { setting: "tm, ss, sn, os, sm (Slack team and sign-in switches)", kind: "none", why: "who is a member is Cloud's people adapter (A6), not a flow option" },
  { setting: "per-project approved models and per-project model choice", kind: "none", why: "the core's model service has one company policy and no project argument (`choose({stage})`); the install model seam is per company" },
  { setting: "the person's own ChatGPT plan as a model source", kind: "none", why: "the core has no personal-plan source; the company's model sources (keys, endpoints, AWS role) are Cloud's routing, mapped by the model seams" },
  { setting: "per-company autonomy limit and recipe autonomy", kind: "service", why: "the core's `autonomy` seam reads a task's frozen recipe and the company limit; Cloud's autonomy reader is wired with merge tracking (decision 70c)" },
];
