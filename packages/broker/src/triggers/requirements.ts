// What a trigger needs of the rest of the system, in one place (Plan 4 Task 18): `triggerProblems` answers what a trigger needs and does not have. The routes ask it before they
// store or turn on a trigger; the rechecks ask it after a change that might have taken something away; dispatch (Task 20) and the schedule handler (Task 26) ask it again
// before every start, so a change that no recheck saw is still caught. It reads live and trusts nothing stored on the trigger but what the trigger itself says.
import {
  AgentXError,
  BUILTIN_TRIGGER_SUGGESTIONS,
  agentXError,
  chainBudgetRequiredMessage,
  isBuiltinAgentId,
  projectAllows,
  scopeKey,
  type AgentId,
  type AgentXErrorCode,
  type OrgId,
  type ResolvedRecipe,
  type TriggerTarget,
} from "@agentx/contracts";
import { orgRoleOf, requireAgentAccess, type AgentCaller } from "../agents/access.js";
import { resolveRecipe } from "../agents/changes.js";
import { resolveAgentForAutonomousRun, type RosterDependencies } from "../agents/roster.js";
import type { AgentRecord } from "../agents/store.js";
import { autonomousTriggerProblems, formatChainProblem, type ChainProblem } from "../chains/validate.js";
import { connectionActorIds } from "../connections/store.js";
import { monthOf } from "../org/trial.js";
import { effectiveLimits } from "../spend/settings.js";
import type { TriggerRecord } from "./store.js";

/** One thing a trigger needs and does not have. `code` is the error a route refuses with when the problem is the one it is told (absent: `CONFIG_INVALID`, in the form `<path>: <message>`). */
export interface TriggerProblem extends ChainProblem {
  code?: AgentXErrorCode;
}

/** The error a route refuses with for a problem: coded problems say their own words, the rest are `CONFIG_INVALID` with the path in front. */
export function triggerProblemError(problem: TriggerProblem): AgentXError {
  return agentXError(problem.code ?? "CONFIG_INVALID", triggerProblemText(problem));
}

/** A problem as one line, for the trigger's `disabledReason` and the notices. */
export const triggerProblemText = (problem: TriggerProblem): string => (problem.code === undefined && problem.path !== "" ? formatChainProblem(problem) : problem.message);

type Deps = RosterDependencies;

const KIND_WORDS = { event: "events", schedule: "schedules" } as const;
const LOOP_GUARD_TYPES = { linear: "Linear", jira: "Jira" } as const;

const sentence = (text: string) => text.replace(/\.+$/u, "");

/** The target's display name, and the facts its checks need: undefined when it is not there. */
async function nameOfTarget(deps: Deps, orgId: OrgId, target: TriggerTarget): Promise<string | undefined> {
  if (target.kind === "chain") return (await deps.chains?.get(orgId, target.chainId))?.name;
  return isBuiltinAgentId(target.agentId) ? deps.store.builtinName(target.agentId) : (await deps.store.get(orgId, target.agentId))?.name;
}

/** The words a notice or a route uses for what a trigger is on: `Code reviewer` or `Triage chain`; `a deleted chain` when it is gone. */
export async function targetName(deps: Deps, orgId: OrgId, target: TriggerTarget): Promise<string> {
  return (await nameOfTarget(deps, orgId, target)) ?? (target.kind === "chain" ? "a chain that was deleted" : "an agent that was deleted");
}

/** What the trigger does, in words: `GitHub pull request opened` or `every 60 minutes`. */
export function triggerWords(trigger: Pick<TriggerRecord, "spec">): string {
  const { spec } = trigger;
  if (spec.kind === "event") return `${spec.source} ${spec.type.replaceAll(".", " ").replaceAll("_", " ")}`;
  const { schedule } = spec;
  if (schedule.kind === "interval") return `every ${String(schedule.minutes)} minutes`;
  if (schedule.kind === "daily") return `daily at ${schedule.at}${schedule.days === undefined ? "" : ` on ${schedule.days.join(", ")}`}`;
  return `weekly on ${schedule.day} at ${schedule.at}`;
}

/** The person who owns a trigger's runs, as the member they are now. Undefined when they are no longer in the org. */
export async function ownerOf(deps: Deps, orgId: OrgId, developerId: string): Promise<AgentCaller | undefined> {
  const orgRole = await orgRoleOf(deps, orgId, developerId);
  return orgRole === undefined ? undefined : { orgId, developerId, orgRole };
}

const unavailable = (chain: string, step: string, agent: string, version: number, reason: string): TriggerProblem => ({
  path: "target", code: "CHAIN_UNAVAILABLE",
  message: `${chain}'s step "${step}" uses ${agent} version ${String(version)}, which can't run now: ${sentence(reason)}. Ask ${chain}'s owner to publish a new version.`,
});

const reasonOf = (error: AgentXError): string => (error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);

/** What the chain's current version needs of the world for an autonomous start: its run limit, budget and gates, and each step's agent still usable on the project by the owner. */
async function chainProblems(deps: Deps, trigger: TriggerRecord, owner: AgentCaller | undefined): Promise<TriggerProblem[]> {
  const { orgId } = trigger;
  if (trigger.target.kind !== "chain" || deps.chains === undefined) return [];
  const chain = await deps.chains.get(orgId, trigger.target.chainId);
  if (chain === undefined) return [{ path: "target", code: "NOT_FOUND", message: "no chain has that ID" }];
  if (chain.status !== "active") return [{ path: "target", code: "CHAIN_UNAVAILABLE", message: `${chain.name} is archived, so it can't start new runs.` }];
  const version = chain.currentVersion === undefined ? undefined : await deps.chains.getVersion(orgId, chain.chainId, chain.currentVersion);
  if (version === undefined) return [{ path: "target", code: "CHAIN_UNAVAILABLE", message: `${chain.name} has no published version yet, so it can't start new runs.` }];
  const problems: TriggerProblem[] = autonomousTriggerProblems({ ...(chain.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: chain.monthlyBudgetUsd }), pinned: version.definition }).map((problem) => (
    problem.path === "limits.maxRunUsd" ? { path: problem.path, code: "CHAIN_BUDGET_REQUIRED" as const, message: chainBudgetRequiredMessage(chain.name) } : problem
  ));
  // Each agent step, as the run would find it: the agent is there and not archived, the owner may use it, and it resolves at its pinned version on the project.
  const seen = new Set<string>();
  for (const step of version.definition.steps) {
    if (step.kind !== "agent") continue;
    const { agentId, version: pinned } = step.agent;
    const key = `${agentId}@${String(pinned)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = await nameOfTarget(deps, orgId, { kind: "agent", agentId }) ?? agentId;
    const record = isBuiltinAgentId(agentId) ? undefined : await deps.store.get(orgId, agentId);
    if (record?.status === "archived") {
      problems.push(unavailable(chain.name, step.name, name, pinned, `${name} is archived, so it can't start new work`));
      continue;
    }
    if (owner !== undefined) {
      try {
        await requireAgentAccess(deps, owner, agentId, "use");
      } catch (error) {
        if (!(error instanceof AgentXError)) throw error;
        problems.push(unavailable(chain.name, step.name, name, pinned, "its owner can no longer use it"));
        continue;
      }
    }
    try {
      await resolveAgentForAutonomousRun(deps, { orgId, project: trigger.project, agentId, version: pinned });
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      problems.push(unavailable(chain.name, step.name, name, pinned, reasonOf(error)));
    }
  }
  return problems;
}

/** Whether a recipe's (or a built-in's suggested) trigger specs list a spec of the same kind, and for an event the same source and type. */
function allows(specs: ReadonlyArray<{ kind: string; source?: string; type?: string }>, wanted: TriggerRecord["spec"]): boolean {
  return specs.some((spec) => spec.kind === wanted.kind && (wanted.kind !== "event" || (spec.source === wanted.source && spec.type === wanted.type)));
}

/** What an agent needs to be started by a trigger: it allows this way, has a budget, and resolves for an autonomous run on the project. */
async function agentProblems(deps: Deps, trigger: TriggerRecord): Promise<TriggerProblem[]> {
  const { orgId } = trigger;
  if (trigger.target.kind !== "agent") return [];
  const agentId: AgentId = trigger.target.agentId;
  let record: AgentRecord | undefined;
  let recipe: ResolvedRecipe | undefined;
  if (!isBuiltinAgentId(agentId)) {
    record = await deps.store.get(orgId, agentId);
    if (record === undefined) return [{ path: "target", code: "NOT_FOUND", message: "no agent has that ID" }];
    if (record.status === "archived") return [{ path: "target", code: "AGENT_UNAVAILABLE", message: `${record.name} is archived, so it can't start new work.` }];
    if (record.currentVersion === undefined) return [{ path: "target", code: "AGENT_UNAVAILABLE", message: `${record.name} has no published version yet, so it can't start new work.` }];
    // The recipe of the version that runs: what its owner allows is read first, so an agent that can't be started this way is told so before anything else is.
    try {
      recipe = await resolveRecipe(deps, orgId, agentId, record.currentVersion);
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return [{ path: "target", code: "AGENT_UNAVAILABLE", message: `${record.name}'s version ${String(record.currentVersion)} can't run now: ${sentence(reasonOf(error))}.` }];
    }
  }
  const name = record?.name ?? deps.store.builtinName(agentId);
  const specs = recipe === undefined ? BUILTIN_TRIGGER_SUGGESTIONS[agentId as keyof typeof BUILTIN_TRIGGER_SUGGESTIONS] : recipe.triggers;
  if (!allows(specs, trigger.spec)) return [{ path: "spec", message: `${name} can't be started by ${KIND_WORDS[trigger.spec.kind]}; ask its owner to allow it` }];
  // The agent pays with no person watching: its own monthly budget must exist (the guardrails' ceiling applies to it).
  const scope = { kind: "agent" as const, agentId };
  const limit = (await effectiveLimits(deps, { orgId, month: monthOf(deps.now()), scopes: [scope] })).get(scopeKey(scope));
  if (limit === undefined) return [{ path: "target", code: "AGENT_BUDGET_REQUIRED", message: `${name} has no monthly budget, so it can't run work that no person started. Ask its owner to set one.` }];
  try {
    await resolveAgentForAutonomousRun(deps, { orgId, project: trigger.project, agentId });
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    return [{ path: "target", code: error.code === "NOT_FOUND" ? "AGENT_UNAVAILABLE" : error.code, message: reasonOf(error) }];
  }
  return [];
}

/** What an event trigger needs of the hook that receives its events, and of the org's connections, so Rovara can tell its own tickets from others. */
async function eventProblems(deps: Deps, trigger: TriggerRecord): Promise<TriggerProblem[]> {
  const { spec, orgId } = trigger;
  if (spec.kind !== "event") return [];
  const problems: TriggerProblem[] = [];
  if (spec.source === "github") {
    if (trigger.hookId !== undefined) problems.push({ path: "hookId", message: "GitHub's events come through the GitHub app and have no hook" });
  } else if (trigger.hookId === undefined) {
    problems.push({ path: "hookId", message: `name the ${spec.source} hook that receives these events` });
  } else if (deps.hooks === undefined) {
    problems.push({ path: "hookId", code: "RUNTIME_UNAVAILABLE", message: "event hooks are not set up in this deployment" });
  } else {
    const hook = await deps.hooks.get(orgId, trigger.hookId);
    if (hook === undefined || hook.orgId !== orgId || hook.project !== trigger.project || hook.source !== spec.source) problems.push({ path: "hookId", code: "NOT_FOUND", message: "no hook has that ID" });
    else if (hook.disabled) problems.push({ path: "hookId", message: "that hook is turned off" });
  }
  const vendor = (LOOP_GUARD_TYPES as Record<string, string | undefined>)[spec.source];
  if (vendor !== undefined && (await connectionActorIds(deps, orgId, spec.source as "linear" | "jira")).size === 0) {
    problems.push({ path: "spec", message: `connect ${vendor} and run its check first, so Rovara can tell its own tickets from others` });
  }
  return problems;
}

/**
 * Everything a trigger needs and does not have, the first problem first: the target (it exists, is active, has a current version), what the target needs (a chain: a run
 * limit, a monthly budget, no gate only the starter can decide, every step agent usable on the project; an agent: that it allows this way, a budget, a run that resolves), the
 * hook, the loop guard of Linear and Jira, and the owner (a member of the org who holds `start_tasks` on the project and may use every step agent). Empty when it can start work.
 */
export async function triggerProblems(deps: Deps, trigger: TriggerRecord): Promise<TriggerProblem[]> {
  const { orgId } = trigger;
  const owner = await ownerOf(deps, orgId, trigger.createdBy);
  const problems: TriggerProblem[] = [];
  if (trigger.target.kind === "chain") problems.push(...await chainProblems(deps, trigger, owner));
  else problems.push(...await agentProblems(deps, trigger));
  problems.push(...await eventProblems(deps, trigger));
  if (owner === undefined) {
    problems.push({ path: "createdBy", message: "its owner is no longer a member of your company, so nobody can run it" });
  } else {
    const role = await deps.projectMembers.roleOf(orgId, trigger.project, { developerId: owner.developerId, orgRole: owner.orgRole });
    if (role === undefined || !projectAllows(role, "start_tasks")) problems.push({ path: "createdBy", message: `its owner can no longer start tasks on ${trigger.project}, so nobody can run it` });
  }
  return problems;
}

/**
 * Whether `developerId` could own `trigger`: a current member of the org who holds `start_tasks` on its project and, for a chain, may use every agent step of its current
 * version. This is the owner rule of `triggerProblems`, asked of someone else, for who a trigger moves to when its owner leaves.
 */
export async function ownerQualifies(deps: Deps, trigger: TriggerRecord, developerId: string): Promise<boolean> {
  const owner = await ownerOf(deps, trigger.orgId, developerId);
  if (owner === undefined) return false;
  const role = await deps.projectMembers.roleOf(trigger.orgId, trigger.project, { developerId: owner.developerId, orgRole: owner.orgRole });
  if (role === undefined || !projectAllows(role, "start_tasks")) return false;
  if (trigger.target.kind !== "chain" || deps.chains === undefined) return true;
  const chain = await deps.chains.get(trigger.orgId, trigger.target.chainId);
  const version = chain?.currentVersion === undefined ? undefined : await deps.chains?.getVersion(trigger.orgId, chain.chainId, chain.currentVersion);
  for (const step of version?.definition.steps ?? []) {
    if (step.kind !== "agent") continue;
    try {
      await requireAgentAccess(deps, owner, step.agent.agentId, "use");
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return false;
    }
  }
  return true;
}
