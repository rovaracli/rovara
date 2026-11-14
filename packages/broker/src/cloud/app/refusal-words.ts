// Convergence S0-143d (owner decision 143d, 2026-11-12): after the combined switch a person reads the words Cloud uses today, not the core's or lane A5's.
//
// Where the words come from, so nothing here is a second copy that can drift:
//   - Money refusals: Cloud's own `refusalFor` (spend/admission.ts), the function `admitWork` refuses a start with (org/budget.ts:346 and :348 are its building
//     blocks), run over what A5's CloudAdmission knows (scope, spent, held, limit). A5's decision carries the code the core branches on; only the sentence changes.
//   - The trial lock and the month's machine time: org/trial.ts `trialLocked` and `machineTimeExceeded`, exactly as `admitWork` refuses with them.
//   - The start's own refusals (a person's workspace limit, the project): the sentences of aws/developer-tasks/start.ts (`limitError`, :84 and :85, :286) and the
//     contracts' `projectArchivedMessage`, so a start on the core fails in the words a start on Cloud's path does.
//   - A fault of the install (A5 saw a request it cannot read, an action nobody listed, a currency it does not count, a key reused): no person can fix it, and
//     Cloud's start says the same thing for every unexpected failure (aws/slack-workflow-choice.ts `workflowStartFailureNotice`'s last line, without the reference).
// `CORE_ADMISSION_REFUSAL_CODES` and `CORE_START_REFUSAL_CODES` are every code the core's task flow and A5 answer with; the table test fails when one has no words.
import { projectArchivedMessage, type AgentXErrorCode } from "@rovara-code/contracts";
import type { BudgetScope } from "@agentx/cloud-contracts";
import type { RefusalCircumstance } from "../../cloud-adapters/money/admission.js";
import { budgetExceeded, orgBudgetExceeded } from "../../org/budget.js";
import { machineTimeExceeded, trialLocked } from "../../org/trial.js";
import { refusalFor, type Level } from "../../spend/admission.js";

/** Every refusal code a money decision on the core can carry: the core's `REFUSAL_CODES` keys (vendor core/task-flow/admission.ts) and the codes lane A5 and its gate answer. */
export const CORE_ADMISSION_REFUSAL_CODES = [
  "budget_exhausted", "budget_exceeded", "org_budget_exceeded", "project_budget_exceeded", "agent_budget_exceeded", "chain_budget_exceeded", "test_allowance_used",
  "machine_time_exceeded", "trial_locked",
  "admission_invalid_request", "admission_action_unknown", "currency_unsupported", "admission_key_reused", "budget_busy",
] as const;
export type CoreAdmissionRefusalCode = (typeof CORE_ADMISSION_REFUSAL_CODES)[number];

/** The refusals of the core's start that Cloud has its own words for (the person's slots, the project). */
export const CORE_START_REFUSAL_CODES = ["WORKSPACE_LIMIT", "WORKSPACE_BUSY", "PROJECT_NOT_FOUND", "PROJECT_ARCHIVED"] as const satisfies readonly AgentXErrorCode[];
export type CoreStartRefusalCode = (typeof CORE_START_REFUSAL_CODES)[number];

/** What is told when an unattended (automation) run is asked of the core: it is not admitted there. Automations are Cloud's own engine's (chains), and the core's unattended door is not wired in Cloud (decision 45.10). */
export const AUTOMATION_NOT_ON_CORE_WORDS = "Automations are not available on this engine yet; they run on Rovara's own automation engine, which this task does not use.";

/** What Cloud tells a person when something that is the install's fault stops a start (the last line of `workflowStartFailureNotice`, with no reference). */
export const INSTALL_FAULT_WORDS = "I couldn't start this task. Try again in a minute; if it keeps failing, ask an AgentX admin.";

/** What Cloud tells a person whose start lost a race for the same slot or room (aws/developer-tasks/start.ts WORKSPACE_BUSY). */
export const BUSY_WORDS = "AgentX could not start the task just now; try again with the same request_id";

const SCOPE_OF_CODE: Readonly<Record<string, BudgetScope["kind"]>> = {
  org_budget_exceeded: "org", budget_exceeded: "member", budget_exhausted: "member", project_budget_exceeded: "project",
  agent_budget_exceeded: "agent", chain_budget_exceeded: "chain", test_allowance_used: "testing",
};

const EPSILON = 0.000001;

/** An `AgentXError`'s sentence without the `CODE: ` it begins with (the core's dispatch strips it the same way, vendor core/task-flow/dispatch.ts). */
const sentence = (error: { code: string; message: string }): string => (error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);

const scopeOf = (kind: BudgetScope["kind"], project: string): BudgetScope => {
  switch (kind) {
    case "org": return { kind };
    case "member": return { kind, developerId: "member" };
    case "project": return { kind, project };
    case "agent": return { kind, agentId: "agent" };
    case "chain": return { kind, chainId: "chain" };
    case "testing": return { kind, developerId: "member" };
  }
};

/** The sentence Cloud tells for an admission refusal. Total over `CORE_ADMISSION_REFUSAL_CODES`; any other code is a fault of the install and says so in Cloud's words, never raw text. */
export function cloudRefusalWords(refusal: RefusalCircumstance): string {
  const code = refusal.code.toLowerCase();
  if (code === "admission_action_unknown" && refusal.action === "automation.run") return AUTOMATION_NOT_ON_CORE_WORDS;
  if (code === "budget_busy") return BUSY_WORDS;
  if (code === "trial_locked") return sentence(trialLocked());
  if (code === "machine_time_exceeded") return sentence(machineTimeExceeded());
  const kind = SCOPE_OF_CODE[code];
  if (kind === undefined) return INSTALL_FAULT_WORDS;
  const limitUsd = refusal.limitUsd ?? 0;
  const spentUsd = refusal.spentUsd ?? 0;
  const committedUsd = refusal.committedUsd ?? spentUsd;
  // Money held by running work is not money spent (spend/admission.ts readLevels): the org's and the member's words say so when the ledger holds more than is spent.
  const held = committedUsd > spentUsd + EPSILON ? { heldUsd: committedUsd } : undefined;
  if (refusal.kind === undefined) {
    // No figures came with the refusal (a gate, or a host that knew the code only): the plain sentences of the org and the member.
    if (kind === "org") return sentence(orgBudgetExceeded());
    if (kind === "member") return sentence(budgetExceeded(spentUsd, limitUsd));
  }
  const level: Level = {
    scope: scopeOf(kind, refusal.projectName ?? "selected"), limitUsd,
    usedUsd: kind === "org" || kind === "member" ? spentUsd : committedUsd, leftUsd: Math.max(0, limitUsd - committedUsd),
    ...(kind === "member" ? { proxy: { spentUsd, limitUsd } } : {}), ...(held === undefined || (kind !== "org" && kind !== "member") ? {} : { held }),
  };
  return sentence(refusalFor(level, { agentName: "This agent", chainName: "This chain" }));
}

/**
 * Cloud's words for a refusal the core's start raised (an `AgentXError`'s code and message). A code Cloud has words for gets them (the numbers and names are
 * read from the core's own sentence, which states them); any other code, a money refusal among them (its words were set where the admission was asked), keeps
 * the sentence it came with.
 */
export function cloudWordsForCoreRefusal(error: { code: string; message: string }): string {
  const named = /`([^`]+)`/.exec(error.message)?.[1];
  switch (error.code) {
    case "WORKSPACE_LIMIT": {
      const limit = /limit of (\d+)/.exec(error.message)?.[1] ?? "";
      return /per person/.test(error.message)
        ? `you have reached the limit of ${limit} open workspaces per person, counting Slack threads and AI-tool tasks; close a task with agentx_close_task.`
        : `this AgentX has reached its limit of ${limit} open workspaces; close a task with agentx_close_task, or ask an admin.`;
    }
    case "WORKSPACE_BUSY": return BUSY_WORDS;
    case "PROJECT_NOT_FOUND": return `project \`${named ?? "this project"}\` doesn't exist in this AgentX`;
    case "PROJECT_ARCHIVED": return projectArchivedMessage(named ?? "this project");
    default: return error.message;
  }
}
