// The chain and custom agent flows on Cloud's own runner (packages/broker/src/chains/runner.ts), over the chain runner test world (tests/support/
// chain-run-world.ts): its DynamoDB fake, the agent and chain stores, project roles, and a recording stand-in for Plan 3's `startAgentRun`.
import { randomUUID } from "node:crypto";
import { agentXError, type ChainDefinitionInput } from "@rovara-code/contracts";
import { onStepTaskEnded, readChainRun, readStepAttempts, startChainRun } from "../../../../packages/broker/src/chains/runner.js";
import { automationsEnabled } from "../../../../packages/broker/src/chains/automations-gate.js";
import { DANA, ORG_A, PRIYA, callerOf, setupWorld, type ChainWorld } from "../../../support/chain-run-world.js";
import { keyFamily } from "../../harness/normalize.js";
import { CUSTOM_OVERLAY, START_INPUT, TWO_BUILTIN_STEPS, oneStepOn, runWord, type FlowName, type FlowObservation } from "./flows.js";

export async function runCloudFlow(flow: FlowName): Promise<FlowObservation> {
  const world: ChainWorld = setupWorld();
  const seen: FlowObservation = { transitions: [], spend: [], rows: [] };
  world.db.onWrite((change) => {
    const item = change.after ?? change.before;
    if (item !== undefined) seen.rows.push(keyFamily(String(item.pk), String(item.sk)));
  });
  // What the run seam was asked: every start of an agent run, and each refusal.
  const starts = world.starts.length;
  const look = async (runId: string): Promise<void> => {
    seen.transitions.push(runWord(await readChainRun(world.deps, ORG_A, runId), await readStepAttempts(world.deps, ORG_A, runId)));
  };
  const start = (chainId: string, requestId: string = randomUUID(), who: string = PRIYA) => startChainRun(world.deps, callerOf(who), { orgId: ORG_A, chainId: chainId as never, project: "web", origin: "app", startedBy: { kind: "member", developerId: who }, input: START_INPUT, requestId } as never);
  // The step's task ended with the same report the Code side gives ("Done.").
  const end = async (taskId: string) => { await onStepTaskEnded(world.deps, world.endEvent(taskId, { finalReport: "Done." })); };
  const record = () => { for (const request of world.starts.slice(starts)) seen.spend.push(`start:${request.agent.agentId.startsWith("agt_") ? "<custom>" : request.agent.agentId}`); };

  switch (flow) {
    case "chains":
    case "chains-code-defaults": {
      const chain = await world.publish(TWO_BUILTIN_STEPS as ChainDefinitionInput);
      const run = await start(chain.chainId).catch((error: unknown) => { seen.spend.push(`refused:${String((error as { code?: string }).code)}`); return undefined; });
      if (run === undefined) break;
      await look(run.runId);
      await end("task-1");
      await look(run.runId);
      await end("task-2");
      await look(run.runId);
      break;
    }
    case "custom-agents": {
      // Cloud's agents are owned and shared: the agent's owner (Dana, an admin) publishes the chain on it and starts it. The recipe is chain-run-world's
      // scratch overlay, the same step as the Code side's (flows.ts CUSTOM_OVERLAY: one report-only agent step with no workspace).
      void CUSTOM_OVERLAY;
      const agent = await world.customAgent("Reporter", DANA);
      const chain = await world.publish(oneStepOn(agent.agentId) as ChainDefinitionInput, { owner: { kind: "member", developerId: DANA }, by: DANA });
      const run = await start(chain.chainId, randomUUID(), DANA);
      await look(run.runId);
      await end("task-1");
      await look(run.runId);
      break;
    }
    case "chains-admission-refused": {
      const chain = await world.publish(TWO_BUILTIN_STEPS as ChainDefinitionInput);
      // Cloud admits a step's money inside Plan 3's start (startAgentRun), so a refusal comes back from the run seam.
      world.hooks.refuse.push(agentXError("BUDGET_EXCEEDED", "the company's budget for this month is spent"));
      const run = await start(chain.chainId).catch((error: unknown) => { seen.spend.push(`refused:${String((error as { code?: string }).code)}`); return undefined; });
      if (run !== undefined) await look(run.runId);
      break;
    }
    case "chains-start-twice": {
      const chain = await world.publish(TWO_BUILTIN_STEPS as ChainDefinitionInput);
      const requestId = randomUUID();
      // Two starts of the same request at the same moment (a double click, a retried request): one run, one first step.
      const [first, second] = await Promise.all([start(chain.chainId, requestId), start(chain.chainId, requestId)]);
      seen.spend.push(first.runId === second.runId ? "same_run" : "two_runs");
      await look(first.runId);
      break;
    }
    case "chains-switch-off": {
      // Cloud's switch sits at the routes (WEB_FEATURES `chains`, chains/automations-gate.ts): with it off the routes answer 404, but the runner itself
      // does not read it. Off here, the runner is called directly.
      seen.spend.push(`switch:${automationsEnabled({}) ? "on" : "off"}`);
      const chain = await world.publish(TWO_BUILTIN_STEPS as ChainDefinitionInput);
      const run = await start(chain.chainId).catch((error: unknown) => { seen.spend.push(`refused:${String((error as { code?: string }).code)}`); return undefined; });
      if (run !== undefined) await look(run.runId);
      break;
    }
  }
  record();
  return seen;
}
