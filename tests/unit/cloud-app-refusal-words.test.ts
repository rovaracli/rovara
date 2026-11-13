// Convergence S0-143d (owner decision 143d): a refusal on the core is told in Cloud's current words. A table over every refusal code the core and lane A5 can
// answer with: each one maps to Cloud's sentence, and none falls through to the core's or A5's own text.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { chainBudgetExceededMessage, projectArchivedMessage } from "@rovara-code/contracts";
import { spendCounterKey } from "../../packages/cloud-contracts/src/org-scoped-keys.js";
import { createCloudAdmission, monthOfMs, type AdmissionLevel, type RefusalCircumstance } from "../../packages/broker/src/cloud-adapters/money/index.js";
import {
  CORE_ADMISSION_ACTIONS, CORE_ADMISSION_REFUSAL_CODES, CORE_START_REFUSAL_CODES, INSTALL_FAULT_WORDS, cloudRefusalWords, cloudWordsForCoreRefusal,
} from "../../packages/broker/src/cloud/app/index.js";
import { budgetExceeded, orgBudgetExceeded } from "../../packages/broker/src/org/budget.js";
import { machineTimeExceeded, trialLocked } from "../../packages/broker/src/org/trial.js";
import { workflowStartFailureNotice } from "../../packages/broker/src/aws/slack-workflow-choice.js";

const bare = (error: { code: string; message: string }): string => error.message.replace(`${error.code}: `, "");
const orgSentence = bare(orgBudgetExceeded());
const budgetSentence = (spent: number, limit: number): string => bare(budgetExceeded(spent, limit));
const trialSentence = bare(trialLocked());
const machineSentence = bare(machineTimeExceeded());

/** A5's own sentence for a scope that is short: the one Cloud's words replace. */
const a5Words = (code: string): string => `X has too little left for this ($0.00 of $0.00 left). Try again when running work finishes, or ask an admin to raise it. (${code})`;
const circumstance = (code: string, over: Partial<RefusalCircumstance> = {}): RefusalCircumstance => ({ code, message: a5Words(code), ...over });

describe("S0-143d: the table covers every refusal code the core and A5 can answer with", () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("every key of the core's REFUSAL_CODES and every code A5 or its gate refuses with is in the table", () => {
    const core = read("vendor/rovara-code/packages/broker/src/core/task-flow/admission.ts");
    const coreKeys = [...(/REFUSAL_CODES[^{]*\{([^}]*)\}/s.exec(core)?.[1] ?? "").matchAll(/^\s*([a-z_]+):/gm)].map((match) => match[1]);
    expect(coreKeys.length).toBeGreaterThanOrEqual(7);
    const a5 = read("packages/broker/src/cloud-adapters/money/admission.ts");
    const a5Codes = [...a5.matchAll(/code: "([a-z_]+)"/g)].map((match) => match[1]);
    const scopeCodes = [...(/SCOPE_CODES[^{]*\{([^}]*)\}/s.exec(a5)?.[1] ?? "").matchAll(/:\s*"([a-z_]+)"/g)].map((match) => match[1]);
    expect(scopeCodes.length).toBe(6);
    for (const code of [...coreKeys, ...a5Codes, ...scopeCodes]) expect(CORE_ADMISSION_REFUSAL_CODES as readonly (string | undefined)[], code).toContain(code);
  });

  it("every code has words that are Cloud's, not the core's or A5's own", () => {
    for (const code of CORE_ADMISSION_REFUSAL_CODES) {
      const words = cloudRefusalWords(circumstance(code));
      expect(words, code).not.toBe(a5Words(code));
      expect(words, code).not.toContain("too little left for this");
      expect(words, code).not.toContain(code);
      expect(words.length, code).toBeGreaterThan(20);
    }
  });
});

describe("S0-143d: money refusals are Cloud's sentences (org/budget.ts:346 and :348 and spend/admission.ts refusalFor)", () => {
  it("the company's budget is used up: org/budget.ts:348, with or without the figures", () => {
    expect(cloudRefusalWords(circumstance("org_budget_exceeded", { kind: "org", limitUsd: 0, spentUsd: 0, committedUsd: 0 }))).toBe(orgSentence);
    expect(cloudRefusalWords(circumstance("org_budget_exceeded"))).toBe(orgSentence);
    expect(cloudRefusalWords(circumstance("org_budget_exceeded", { kind: "org", limitUsd: 5, spentUsd: 5, committedUsd: 5 }))).toBe("Your company's monthly AI budget is used up. Ask an admin to raise it.");
  });

  it("the company's budget is committed to running work, not spent", () => {
    expect(cloudRefusalWords(circumstance("org_budget_exceeded", { kind: "org", limitUsd: 5, spentUsd: 1, committedUsd: 5 })))
      .toBe("Your company's monthly AI budget is committed to work that is running. Try again when it finishes, or ask an admin to raise it.");
  });

  it("the person's own budget: org/budget.ts:346, and the held wording", () => {
    expect(cloudRefusalWords(circumstance("budget_exceeded", { kind: "member", limitUsd: 10, spentUsd: 10, committedUsd: 10 }))).toBe(budgetSentence(10, 10));
    expect(cloudRefusalWords(circumstance("budget_exceeded", { kind: "member", limitUsd: 10, spentUsd: 2, committedUsd: 9.5 })))
      .toBe("Your monthly AI budget is used or held for work that is running ($9.50 of $10.00). Try again when it finishes, or ask an admin to raise it.");
    expect(cloudRefusalWords(circumstance("budget_exhausted", { kind: "member", limitUsd: 3, spentUsd: 3, committedUsd: 3 }))).toBe(budgetSentence(3, 3));
  });

  it("the project, the agent, the chain and the testing allowance name themselves, with the figures", () => {
    expect(cloudRefusalWords(circumstance("project_budget_exceeded", { kind: "project", projectName: "payments", limitUsd: 20, spentUsd: 0, committedUsd: 20 })))
      .toBe("The payments project's monthly AI budget is used up ($20.00 of $20.00). Ask for more from the project's page.");
    expect(cloudRefusalWords(circumstance("agent_budget_exceeded", { kind: "agent", limitUsd: 4, spentUsd: 0, committedUsd: 4 }))).toBe("This agent's monthly AI budget is used up ($4.00 of $4.00). Ask its owner for more.");
    expect(cloudRefusalWords(circumstance("chain_budget_exceeded", { kind: "chain", limitUsd: 4, spentUsd: 0, committedUsd: 4 }))).toBe(chainBudgetExceededMessage("This chain", 4, 4));
    expect(cloudRefusalWords(circumstance("test_allowance_used", { kind: "testing", limitUsd: 2, spentUsd: 0, committedUsd: 2 })))
      .toBe("Your testing allowance for this month is used up ($2.00 of $2.00). Run the agent as a normal task instead.");
  });

  it("the trial lock and the month's machine time: org/trial.ts", () => {
    expect(cloudRefusalWords(circumstance("trial_locked"))).toBe(trialSentence);
    expect(cloudRefusalWords(circumstance("machine_time_exceeded"))).toBe(machineSentence);
  });

  it("a start that lost a race is told as Cloud tells a busy start", () => {
    expect(cloudRefusalWords(circumstance("budget_busy"))).toBe("AgentX could not start the task just now; try again with the same request_id");
  });

  it("a fault of the install is told as Cloud tells any unexpected start failure", () => {
    for (const code of ["admission_invalid_request", "admission_action_unknown", "currency_unsupported", "admission_key_reused", "a_code_nobody_listed"]) expect(cloudRefusalWords(circumstance(code)), code).toBe(INSTALL_FAULT_WORDS);
    expect(workflowStartFailureNotice("SOMETHING_ELSE", "ref")).toContain(INSTALL_FAULT_WORDS.replace(" ask an AgentX admin.", ""));
  });
});

describe("S0-143d: through A5's own decision, with the words the root registers", () => {
  const A = "org_aaaaaaaaaaaaaaaaaaaa";
  const NOW = Date.parse("2026-11-11T12:00:00.000Z");
  const month = monthOfMs(NOW);

  async function refuse(options: { limit: number; spent: number; committed: number; kind: AdmissionLevel["kind"]; action?: string }): Promise<string> {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...spendCounterKey(A, month, "S"), entityType: "SPEND_COUNTER", spentUsd: options.spent, committedUsd: options.committed } });
    const admission = createCloudAdmission({ store, now: () => NOW, levels: async () => [{ scope: "S", kind: options.kind, limitUsd: options.limit }], actions: CORE_ADMISSION_ACTIONS, words: cloudRefusalWords });
    const decision = await admission.admit({ companyId: A, idempotencyKey: "k", action: options.action ?? "task.start", projectName: "payments" });
    if (decision.allowed) throw new Error("expected a refusal");
    return decision.message;
  }

  it("a $0 company limit refuses a start in the words Cloud's admitWork uses", async () => {
    expect(await refuse({ limit: 0, spent: 0, committed: 0, kind: "org" })).toBe(orgSentence);
  });

  it("each scope's refusal carries its code and Cloud's sentence", async () => {
    expect(await refuse({ limit: 10, spent: 10, committed: 10, kind: "member" })).toBe(budgetSentence(10, 10));
    expect(await refuse({ limit: 6, spent: 0, committed: 6, kind: "project" })).toBe("The payments project's monthly AI budget is used up ($6.00 of $6.00). Ask for more from the project's page.");
    expect(await refuse({ limit: 6, spent: 1, committed: 6, kind: "org", action: "model.call" })).toBe("Your company's monthly AI budget is committed to work that is running. Try again when it finishes, or ask an admin to raise it.");
  });

  it("an action nobody listed is a fault of the install, in Cloud's words", async () => {
    const store = new MemoryDocumentStore();
    const admission = createCloudAdmission({ store, now: () => NOW, levels: async () => [], actions: CORE_ADMISSION_ACTIONS, words: cloudRefusalWords });
    const decision = await admission.admit({ companyId: A, idempotencyKey: "k", action: "something.new" });
    expect(decision).toEqual({ allowed: false, code: "admission_action_unknown", message: INSTALL_FAULT_WORDS });
  });

  it("without the host's words A5 keeps its own sentence (the adapter alone is unchanged)", async () => {
    const store = new MemoryDocumentStore();
    const admission = createCloudAdmission({ store, now: () => NOW, levels: async () => [], actions: CORE_ADMISSION_ACTIONS });
    const decision = await admission.admit({ companyId: A, idempotencyKey: "k", action: "something.new" });
    expect(decision).toMatchObject({ allowed: false, message: "Rovara does not admit this kind of work on this install." });
  });
});

describe("S0-143d: the core's own start refusals", () => {
  it("covers every code the table names", () => {
    expect([...CORE_START_REFUSAL_CODES].sort()).toEqual(["PROJECT_ARCHIVED", "PROJECT_NOT_FOUND", "WORKSPACE_BUSY", "WORKSPACE_LIMIT"]);
  });

  it("a person's and the company's workspace limit, in aws/developer-tasks/start.ts's words", () => {
    expect(cloudWordsForCoreRefusal({ code: "WORKSPACE_LIMIT", message: "you have reached the limit of 3 open workspaces per person; close a task to start another" }))
      .toBe("you have reached the limit of 3 open workspaces per person, counting Slack threads and AI-tool tasks; close a task with agentx_close_task.");
    expect(cloudWordsForCoreRefusal({ code: "WORKSPACE_LIMIT", message: "this install has reached its limit of 20 open workspaces; close a task, or ask an admin" }))
      .toBe("this AgentX has reached its limit of 20 open workspaces; close a task with agentx_close_task, or ask an admin.");
  });

  it("a busy start, a missing and an archived project", () => {
    expect(cloudWordsForCoreRefusal({ code: "WORKSPACE_BUSY", message: "Rovara could not start the task just now; try again with the same request_id" })).toBe("AgentX could not start the task just now; try again with the same request_id");
    expect(cloudWordsForCoreRefusal({ code: "PROJECT_NOT_FOUND", message: "project `payments` doesn't exist" })).toBe("project `payments` doesn't exist in this AgentX");
    expect(cloudWordsForCoreRefusal({ code: "PROJECT_ARCHIVED", message: "project `payments` is archived; unarchive it to start new work" })).toBe(projectArchivedMessage("payments"));
  });

  it("a money refusal keeps the sentence the admission already gave it", () => {
    expect(cloudWordsForCoreRefusal({ code: "ORG_BUDGET_EXCEEDED", message: orgSentence })).toBe(orgSentence);
  });
});
