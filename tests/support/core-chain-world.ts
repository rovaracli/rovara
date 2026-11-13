// A small world for Rovara Code's chain runner and unattended door (vendored core/chains, core/automation) over the document store port, with the pieces a test needs to
// watch an automation stop: a switch it flips, a recording starter, tasks whose end and workflow stage it sets. Built the way the parity suite's chain flows are
// (tests/parity/engines/features-d-support/code-flows.ts), kept here so a unit test can use it without the parity harness.
import { INDEX_EXPIRY_ATTRIBUTE, type Admission, type AuditSink, type OrgId } from "@rovara-code/contracts";
import { MemoryDocumentStore, localOwnerPrincipal } from "@rovara-code/broker/ports";
import { AgentStore } from "../../vendor/rovara-code/packages/broker/src/core/agents/store.js";
import type { ProjectRules } from "../../vendor/rovara-code/packages/broker/src/core/agents/rules.js";
import type { RosterDependencies } from "../../vendor/rovara-code/packages/broker/src/core/agents/roster.js";
import type { AutomatedRunRequest, UnattendedStartDeps, UnattendedTasks } from "../../vendor/rovara-code/packages/broker/src/core/automation/run-seam.js";
import { ChainStore } from "../../vendor/rovara-code/packages/broker/src/core/chains/store.js";
import { onStepEnded, startChainRun, type ChainRunnerDeps } from "../../vendor/rovara-code/packages/broker/src/core/chains/runner.js";
import { validateChainForPublish } from "../../vendor/rovara-code/packages/broker/src/core/chains/validate.js";

export const WORLD_COMPANY = "org_00000000000000000000" as OrgId;
export const WORLD_PROJECT = "web";
const STARTER = "d".repeat(64);

export const TWO_STEPS = {
  start: "look", limits: { maxRunUsd: 30 },
  steps: [
    { kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "go", to: "review" } },
    { kind: "agent", id: "review", name: "Review it", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } },
  ],
};

export function createCoreChainWorld() {
  const clock = { now: Date.parse("2026-11-12T10:00:00.000Z") };
  const store = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, nowSeconds: () => Math.floor(clock.now / 1000) });
  const table = { store, now: () => clock.now };
  const owner = localOwnerPrincipal();
  const auditSink: AuditSink = { stage: () => [], async record() { /* not under test */ } };
  const admission: Admission = {
    enforcesCost: true,
    async admit() { return { allowed: true, reservationId: "res-1" }; },
    async stage() { return { decision: { allowed: true }, items: [] }; },
    async settle() { settled.push("settle"); },
    async release() { /* nothing held */ },
  };
  const settled: string[] = [];
  const starts: AutomatedRunRequest[] = [];
  const made = new Map<string, string>();
  const ended = new Map<string, "succeeded" | "cancelled" | "failed">();
  const cancelled: string[] = [];
  /** The workflow each task is at (what the safe point reads); default: coding is running. */
  const workflows = new Map<string, { stage: string; state: string }>();
  const waiting = new Set<string>();
  const starter = {
    async start(request: AutomatedRunRequest) {
      const known = made.get(request.requestId);
      if (known !== undefined) return { taskId: known, duplicate: true };
      starts.push(request);
      const taskId = `task-${String(starts.length)}`;
      made.set(request.requestId, taskId);
      workflows.set(taskId, { stage: "IMPLEMENT", state: "RUNNING" });
      return { taskId, duplicate: false };
    },
    async read(requestId: string) { const taskId = made.get(requestId); return taskId === undefined ? undefined : { taskId }; },
  };
  const switchState = { on: true };
  const tasks: UnattendedTasks = {
    async read(taskId) { return [...made.values()].includes(taskId) ? { ...(ended.has(taskId) ? { end: ended.get(taskId)! } : {}), waiting: waiting.has(taskId) } : undefined; },
    async cancel(taskId) { cancelled.push(taskId); ended.set(taskId, "cancelled"); },
  };
  let counter = 0;
  const idBody = () => { counter += 1; return counter.toString(36).padStart(20, "0"); };
  const agents = new AgentStore({ ...table, audit: auditSink, companyId: WORLD_COMPANY, newId: () => `agt_${idBody()}` as never });
  const chains = new ChainStore({ ...table, audit: auditSink, companyId: WORLD_COMPANY, newId: () => `chn_${idBody()}` as never });
  const rules: ProjectRules = { async definition(project) { return project === WORLD_PROJECT ? {} : undefined; }, allowConnectorWrites: true };
  const roster: RosterDependencies = { store: agents, rules };
  const unattended: UnattendedStartDeps = { automation: { enabled: () => switchState.on }, companyId: WORLD_COMPANY, admission, audit: auditSink, starter, enforces: { dollars: true }, store, tasks, now: () => clock.now };
  const deps: ChainRunnerDeps = {
    ...table, companyId: WORLD_COMPANY, chains, roster, unattended, cancelTask: (taskId) => tasks.cancel(taskId), log: () => undefined,
    taskOpen: async (taskId) => !ended.has(taskId), taskWaiting: async (taskId) => waiting.has(taskId),
  };
  const publishChain = async (definition: unknown = TWO_STEPS): Promise<string> => {
    const chain = await chains.create({ orgId: WORLD_COMPANY, name: "Chain 1", by: owner.personId, definition });
    const draft = (await chains.getDraft(WORLD_COMPANY, chain.chainId))!;
    const checked = await validateChainForPublish(roster, WORLD_COMPANY, draft.definition);
    if (checked.problems.length > 0) throw new Error(`the chain has problems: ${JSON.stringify(checked.problems)}`);
    await chains.publish({ orgId: WORLD_COMPANY, chainId: chain.chainId, expectedDraftRevision: draft.revision, by: owner.personId, pinned: checked.pinned, problems: checked.problems, guardrailsRevision: checked.guardrailsRevision });
    return chain.chainId;
  };
  const start = (chainId: string) => startChainRun(deps, {
    orgId: WORLD_COMPANY, chainId, project: WORLD_PROJECT, origin: "app", startedBy: { kind: "member", developerId: STARTER }, owner: { developerId: owner.personId }, input: "Please look into the refund errors.",
  });
  const endStep = async (taskId: string) => { ended.set(taskId, "succeeded"); await onStepEnded(deps, WORLD_COMPANY, { taskId, status: "succeeded", report: "Done." }); };
  return { clock, store, table, deps, unattended, switchState, starts, made, ended, cancelled, workflows, waiting, settled, publishChain, start, endStep, tasks };
}
