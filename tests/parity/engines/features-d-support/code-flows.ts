// The chain and custom agent flows on Rovara Code's core runner (vendored core/chains, core/agents, core/automation) over the document store port, with the
// same pieces Code's own tests use (Code tests/support/automation-world.ts, rebuilt here on the vendored modules): an admission that can refuse, a
// recording starter for the unattended door, the automation switch, and a recording store so the rows facet sees what the runner wrote.
import { INDEX_EXPIRY_ATTRIBUTE, type Admission, type AuditSink, type DocumentStore, type OrgId, type TransactItem } from "@rovara-code/contracts";
import { MemoryDocumentStore, localOwnerPrincipal } from "@rovara-code/broker/ports";
import { AgentStore, resolveAgent } from "../../../../vendor/rovara-code/packages/broker/src/core/agents/store.js";
import { validateRecipeForCompany } from "../../../../vendor/rovara-code/packages/broker/src/core/agents/guardrails.js";
import type { ProjectRules } from "../../../../vendor/rovara-code/packages/broker/src/core/agents/rules.js";
import type { RosterDependencies } from "../../../../vendor/rovara-code/packages/broker/src/core/agents/roster.js";
import type { AutomatedRunRequest, UnattendedStartDeps, UnattendedTasks } from "../../../../vendor/rovara-code/packages/broker/src/core/automation/run-seam.js";
import { ChainStore } from "../../../../vendor/rovara-code/packages/broker/src/core/chains/store.js";
import { onStepEnded, readChainRun, readStepAttempts, startChainRun, type ChainRunnerDeps } from "../../../../vendor/rovara-code/packages/broker/src/core/chains/runner.js";
import { validateChainForPublish } from "../../../../vendor/rovara-code/packages/broker/src/core/chains/validate.js";
import { keyFamily } from "../../harness/normalize.js";
import { CUSTOM_OVERLAY, START_INPUT, TWO_BUILTIN_STEPS, oneStepOn, runWord, type FlowName, type FlowObservation } from "./flows.js";

const COMPANY = "org_00000000000000000000" as OrgId;
const OWNER = localOwnerPrincipal();
/** The person who starts a run: a developer id is 64 hex characters on both products (Code's local owner's own id is not one). */
const STARTER = "d".repeat(64);
const PROJECT = "web";

/** The store with every written key recorded (the rows facet). */
function recording(inner: DocumentStore, rows: string[]): DocumentStore {
  const keyOf = (item: TransactItem) => (item.kind === "put" ? item.item : item.key);
  return Object.assign(Object.create(null) as DocumentStore, {
    indexes: inner.indexes, ...(inner.ttlAttribute === undefined ? {} : { ttlAttribute: inner.ttlAttribute }),
    get: (key: Parameters<DocumentStore["get"]>[0]) => inner.get(key),
    getMany: (keys: Parameters<DocumentStore["getMany"]>[0]) => inner.getMany(keys),
    query: (request: Parameters<DocumentStore["query"]>[0]) => inner.query(request),
    queryIndex: (request: Parameters<DocumentStore["queryIndex"]>[0]) => inner.queryIndex(request),
    async put(request: Parameters<DocumentStore["put"]>[0]) { const result = await inner.put(request); if (result.applied) rows.push(keyFamily(request.item.pk, request.item.sk)); return result; },
    async update(request: Parameters<DocumentStore["update"]>[0]) { const result = await inner.update(request); if (result.applied) rows.push(keyFamily(request.key.pk, request.key.sk)); return result; },
    async delete(request: Parameters<DocumentStore["delete"]>[0]) { const result = await inner.delete(request); if (result.applied) rows.push(keyFamily(request.key.pk, request.key.sk)); return result; },
    async transact(items: Parameters<DocumentStore["transact"]>[0]) {
      const result = await inner.transact(items);
      if (result.applied) for (const item of items) if (item.kind !== "check") rows.push(keyFamily(keyOf(item).pk, keyOf(item).sk));
      return result;
    },
  });
}

export async function runCodeFlow(flow: FlowName): Promise<FlowObservation> {
  const seen: FlowObservation = { transitions: [], spend: [], rows: [] };
  const clock = { now: Date.parse("2026-11-12T10:00:00.000Z") };
  const store = recording(new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, nowSeconds: () => Math.floor(clock.now / 1000) }), seen.rows);
  const table = { store, now: () => clock.now };
  const auditSink: AuditSink = { stage: () => [], async record() { /* audit is the facets lane's */ } };
  let refuse: { code: string; message: string } | undefined;
  const admission: Admission = {
    enforcesCost: true,
    async admit() { return refuse === undefined ? { allowed: true, reservationId: "res-1" } : { allowed: false, ...refuse }; },
    async stage() { return { decision: { allowed: true }, items: [] }; },
    async settle() { /* nothing held */ },
    async release() { /* nothing held */ },
  };
  const starts: AutomatedRunRequest[] = [];
  const made = new Map<string, string>();
  const ended = new Map<string, "succeeded" | "cancelled" | "failed">();
  const starter = {
    async start(request: AutomatedRunRequest) {
      const known = made.get(request.requestId);
      if (known !== undefined) return { taskId: known, duplicate: true };
      starts.push(request);
      const taskId = `task-${String(starts.length)}`;
      made.set(request.requestId, taskId);
      return { taskId, duplicate: false };
    },
    async read(requestId: string) { const taskId = made.get(requestId); return taskId === undefined ? undefined : { taskId }; },
  };
  const switchOn = { value: flow !== "chains-switch-off" };
  const tasks: UnattendedTasks = {
    async read(taskId) { return made.has(taskId) || [...made.values()].includes(taskId) ? { ...(ended.has(taskId) ? { end: ended.get(taskId)! } : {}), waiting: false } : undefined; },
    async cancel(taskId) { ended.set(taskId, "cancelled"); },
  };
  let counter = 0;
  const idBody = () => { counter += 1; return counter.toString(36).padStart(20, "0"); };
  const agents = new AgentStore({ ...table, audit: auditSink, companyId: COMPANY, newId: () => `agt_${idBody()}` as never });
  const chains = new ChainStore({ ...table, audit: auditSink, companyId: COMPANY, newId: () => `chn_${idBody()}` as never });
  // Cloud serves a connector write behind a person's approval, so the composition root must tell the core so (`allowConnectorWrites`, S0-Q2's settings
  // mapping): without it Code refuses every agent with a writing tool, the built-in Code reviewer among them. `chains-code-defaults` leaves Code's default.
  const rules: ProjectRules = { async definition(project) { return project === PROJECT ? {} : undefined; }, ...(flow === "chains-code-defaults" ? {} : { allowConnectorWrites: true }) };
  const roster: RosterDependencies = { store: agents, rules };
  const unattended: UnattendedStartDeps = { automation: { enabled: () => switchOn.value }, companyId: COMPANY, admission, audit: auditSink, starter, enforces: { dollars: true }, store, tasks, now: () => clock.now };
  const deps: ChainRunnerDeps = {
    ...table, companyId: COMPANY, chains, roster, unattended, cancelTask: (taskId) => tasks.cancel(taskId), log: () => undefined,
    taskOpen: async (taskId) => !ended.has(taskId), taskWaiting: async () => false,
  };

  const publishChain = async (definition: unknown): Promise<string> => {
    const chain = await chains.create({ orgId: COMPANY, name: "Chain 1", by: OWNER.personId, definition });
    const draft = (await chains.getDraft(COMPANY, chain.chainId))!;
    const checked = await validateChainForPublish(roster, COMPANY, draft.definition);
    if (checked.problems.length > 0) throw new Error(`the scenario's chain has problems: ${JSON.stringify(checked.problems)}`);
    await chains.publish({ orgId: COMPANY, chainId: chain.chainId, expectedDraftRevision: draft.revision, by: OWNER.personId, pinned: checked.pinned, problems: checked.problems, guardrailsRevision: checked.guardrailsRevision });
    return chain.chainId;
  };
  const publishAgent = async (): Promise<string> => {
    const record = await agents.create({ orgId: COMPANY, name: "Reporter", by: OWNER.personId, overlay: CUSTOM_OVERLAY });
    const recipe = await resolveAgent(agents, COMPANY, record.agentId, "draft");
    const problems = await validateRecipeForCompany(agents.table, COMPANY, recipe);
    await agents.publish({ orgId: COMPANY, agentId: record.agentId, expectedDraftRevision: 1, by: OWNER.personId, recipe, problems });
    return record.agentId;
  };
  const look = async (runId: string): Promise<void> => {
    seen.transitions.push(runWord(await readChainRun(table, COMPANY, runId), await readStepAttempts(table, COMPANY, runId)));
  };
  const start = (chainId: string, runId?: string) => startChainRun(deps, {
    orgId: COMPANY, chainId: chainId, project: PROJECT, origin: "app", startedBy: { kind: "member", developerId: STARTER }, owner: { developerId: OWNER.personId }, input: START_INPUT,
    ...(runId === undefined ? {} : { runId: runId }),
  });
  const end = async (taskId: string) => { ended.set(taskId, "succeeded"); await onStepEnded(deps, COMPANY, { taskId, status: "succeeded", report: "Done." }); };

  switch (flow) {
    case "chains":
    case "chains-code-defaults": {
      const run = await start(await publishChain(TWO_BUILTIN_STEPS)).catch((error: unknown) => { seen.spend.push(`refused:${String((error as { code?: string }).code)}`); return undefined; });
      if (run === undefined) break;
      await look(run.runId);
      await end("task-1");
      await look(run.runId);
      await end("task-2");
      await look(run.runId);
      break;
    }
    case "custom-agents": {
      const run = await start(await publishChain(oneStepOn(await publishAgent())));
      await look(run.runId);
      await end("task-1");
      await look(run.runId);
      break;
    }
    case "chains-admission-refused": {
      const chainId = await publishChain(TWO_BUILTIN_STEPS);
      // Code admits a step's money at the unattended door, before the starter.
      refuse = { code: "budget_exhausted", message: "the company's budget for this month is spent" };
      const run = await start(chainId).catch((error: unknown) => { seen.spend.push(`refused:${String((error as { code?: string }).code)}`); return undefined; });
      if (run !== undefined) await look(run.runId);
      break;
    }
    case "chains-start-twice": {
      const chainId = await publishChain(TWO_BUILTIN_STEPS);
      // Code names a person's run by its run id (Cloud by the request id): the same id twice at the same moment.
      const runId = "crn_parity00000000000001";
      const [first, second] = await Promise.all([start(chainId, runId), start(chainId, runId)]);
      seen.spend.push(first.runId === second.runId ? "same_run" : "two_runs");
      await look(first.runId);
      break;
    }
    case "chains-switch-off": {
      // Code's switch sits at the unattended door (core/automation/switch.ts, read by the run seam on every start).
      seen.spend.push(`switch:${switchOn.value ? "on" : "off"}`);
      const chainId = await publishChain(TWO_BUILTIN_STEPS);
      const run = await start(chainId).catch((error: unknown) => { seen.spend.push(`refused:${String((error as { code?: string }).code)}`); return undefined; });
      if (run !== undefined) await look(run.runId);
      break;
    }
  }
  for (const request of starts) seen.spend.push(`start:${request.agent.agentId.startsWith("agt_") ? "<custom>" : request.agent.agentId}`);
  return seen;
}
