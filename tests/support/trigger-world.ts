import { fixtureActor } from "./money-authority.js";
// Plan 4 Task 18: a world for the tests of triggers. It is Task 8's gate world (two orgs on one FakeDynamoDb, the agent and chain stores, project roles, the real decide
// page) with the trigger store, a hook reader, a scheduler that records what it was asked and the trigger code's own hooks wired onto the world's dependencies, as the
// broker wires them. Nothing here is Plan 4's code: the tests call the routes and the lifecycle functions and read what they left.
import { randomUUID } from "node:crypto";
import { AgentXError } from "@rovara-code/contracts";
import { addToRoster } from "../../packages/broker/src/agents/roster.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { routeAgentRequest, type AgentRouteDependencies } from "../../packages/broker/src/agents/routes.js";
import { routeChainRequest, type ChainRouteDependencies } from "../../packages/broker/src/chains/routes.js";
import { chainTriggerHooksFor, triggerHooksFor } from "../../packages/broker/src/triggers/lifecycle.js";
import type { ScheduledTrigger, TriggerHook, TriggerHookReader, TriggerScheduler } from "../../packages/broker/src/triggers/ports.js";
import { TriggerStore, type TriggerRecord } from "../../packages/broker/src/triggers/store.js";
import type { RecipeOverlay } from "@rovara-code/contracts";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import { connectionKey, connectionsKey } from "@rovara-code/contracts";
import { orgMemberKey } from "../../packages/cloud-contracts/src/org-node.js";
import { INVESTIGATE_THEN_FIX } from "./chain-examples.js";
import { ARJUN, CARL, DANA, MAX, ORG_A, ORG_B, PRIYA, STRANGER, VIV, callerOf, disposeGateWorlds, setupGateWorld, type GateWorld } from "./chain-gate-world.js";
import type { WorldOptions } from "./chain-run-world.js";

export { ARJUN, CARL, DANA, MAX, ORG_A, ORG_B, PRIYA, STRANGER, VIV, callerOf, disposeGateWorlds };
export const CELL = "https://cell.example.com";

/** The request id of a call, as the app sends it. */
export const rid = (): string => randomUUID();

/** What a route said: its status and body, whether it answered or refused (a refusal's body is its code and message). */
export interface Called { status: number; body: Record<string, unknown> }

export class FakeHooks implements TriggerHookReader {
  readonly hooks = new Map<string, TriggerHook>();
  add(hook: TriggerHook): TriggerHook {
    this.hooks.set(`${hook.orgId}|${hook.hookId}`, hook);
    return hook;
  }
  get = async (orgId: OrgId, hookId: string): Promise<TriggerHook | undefined> => this.hooks.get(`${orgId}|${hookId}`);
}

export class FakeScheduler implements TriggerScheduler {
  /** Every call, in order. */
  readonly calls: Array<{ call: "put" | "disable" | "remove"; triggerId: string }> = [];
  /** What each trigger's schedule stands at now. */
  readonly states = new Map<string, "ENABLED" | "DISABLED">();
  failNext: Error | undefined;
  private async maybeFail(): Promise<void> {
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure !== undefined) throw failure;
  }
  async put(trigger: ScheduledTrigger): Promise<void> { await this.maybeFail(); this.calls.push({ call: "put", triggerId: trigger.triggerId }); this.states.set(trigger.triggerId, "ENABLED"); }
  async disable(trigger: Pick<ScheduledTrigger, "triggerId">): Promise<void> { await this.maybeFail(); this.calls.push({ call: "disable", triggerId: trigger.triggerId }); this.states.set(trigger.triggerId, "DISABLED"); }
  async remove(trigger: Pick<ScheduledTrigger, "triggerId">): Promise<void> { await this.maybeFail(); this.calls.push({ call: "remove", triggerId: trigger.triggerId }); this.states.delete(trigger.triggerId); }
  async describe(triggerId: string): Promise<{ state: "ENABLED" | "DISABLED" } | undefined> { const state = this.states.get(triggerId); return state === undefined ? undefined : { state }; }
}

/** The org's first owner, who takes over what a member who leaves owned. Route calls are made as Dana (an admin): the callers of the worlds read their org role from a fixed table. */
export const OWNER = "7".repeat(64);
export const HOOK_A = `hk_${"a".repeat(26)}`;
export const HOOK_A2 = `hk_${"c".repeat(26)}`;
export const HOOK_B = `hk_${"b".repeat(26)}`;

export interface TriggerWorld extends GateWorld {
  triggers: TriggerStore;
  hookReader: FakeHooks;
  scheduler: FakeScheduler;
  routeDeps: ChainRouteDependencies & AgentRouteDependencies;
  /** A route of the chains, called as `who`. */
  chainCall(who: string, method: string, path: string, body?: Record<string, unknown>, orgId?: OrgId): Promise<Called>;
  /** A route of the agents, called as `who`. */
  agentCall(who: string, method: string, path: string, body?: Record<string, unknown>, orgId?: OrgId): Promise<Called>;
  /** A chain with a run limit and a monthly budget, owned by Priya, published: what an event or a schedule may start. */
  budgetedChain(definition?: ChainDefinitionInput, extra?: { owner?: { kind: "member"; developerId: string } | { kind: "project"; project: string }; accountable?: { developerId: string } }): ReturnType<GateWorld["publish"]>;
  /** A custom agent on web whose recipe allows `triggers`, with a monthly budget when `budgetUsd` is given. */
  triggerAgent(name: string, triggers: NonNullable<RecipeOverlay["triggers"]>, options?: { budgetUsd?: number; owner?: string }): Promise<{ agentId: string }>;
  /** Gives a built-in agent the monthly budget an autonomous run needs. */
  builtinBudget(agentId: string, usd?: number): Promise<void>;
  /** A hook of org A on web for `source`. */
  hook(source: string, hookId?: string, over?: Partial<TriggerHook>): TriggerHook;
  /** A Linear or Jira connection of org A whose check recorded `actorId`; `identity` says whose key it is (a service account unless a test says otherwise). */
  connection(type: "linear" | "jira", actorId?: string, identity?: "service" | "personal" | "unmarked"): void;
  /** A trigger stored directly: how the tests of rechecks, movers and the matching start from a trigger that is already on. */
  seed(over?: Partial<TriggerRecord> & { target: TriggerRecord["target"] }): Promise<TriggerRecord>;
  notices(developerId: string): Promise<string[]>;
  /** Events a target's own log holds. */
  targetEvents(target: TriggerRecord["target"]): Array<Record<string, unknown>>;
}

const asCalled = (result: unknown): Called => (result instanceof StatusReply ? { status: result.statusCode, body: result.body as Record<string, unknown> } : { status: 200, body: (result ?? {}) as Record<string, unknown> });
const refusal = (error: unknown): Called => {
  if (error instanceof AgentXError) return { status: error.statusCode, body: { code: error.code, message: error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message } };
  throw error;
};

export function setupTriggerWorld(options: WorldOptions = {}): TriggerWorld {
  // srv/automations (E-52): a trigger starts a chain only where the spend engine's admission holds it to the chain's budget, as the broker wires it; a test of
  // the refusal without one passes `admission: false`.
  const w = setupGateWorld({ admission: true, ...options });
  const triggers = new TriggerStore({ documentClient: w.db, tableName: "T", now: () => w.clock.now });
  const hookReader = new FakeHooks();
  const scheduler = new FakeScheduler();
  // The gate world's dependencies are the ones the decide page, the approval routes and the runner hold: the trigger code is wired onto them, as the broker wires it.
  w.db.set({ ...orgMemberKey(ORG_A, OWNER), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: OWNER, role: "owner", joinedAt: "2026-09-01T00:00:00.000Z" });
  w.db.set({ pk: `DEVELOPER#${OWNER}`, sk: "META", developerId: OWNER, provider: "oidc", displayName: "Olivia", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  w.projectMembers.setOrgRole(ORG_A, OWNER, "owner");
  const routeDeps = w.deps as unknown as ChainRouteDependencies & AgentRouteDependencies;
  Object.assign(routeDeps, { triggers, hooks: hookReader, triggerSchedules: scheduler });
  routeDeps.triggerHooks = triggerHooksFor(routeDeps);
  routeDeps.chainTriggers = chainTriggerHooksFor(routeDeps);

  const request = (method: string, path: string, body?: Record<string, unknown>) => ({ method, path, requestId: "r", headers: {}, ...(body === undefined ? {} : { body: JSON.stringify({ requestId: rid(), ...body }) }) });
  const call = (route: typeof routeChainRequest | typeof routeAgentRequest) => async (who: string, method: string, path: string, body?: Record<string, unknown>, orgId: OrgId = ORG_A): Promise<Called> => {
    try {
      return asCalled(await route(routeDeps, callerOf(who, orgId), request(method, path, body), new URL(`${CELL}${path}`)));
    } catch (error) {
      return refusal(error);
    }
  };

  const budgetedChain: TriggerWorld["budgetedChain"] = (definition = INVESTIGATE_THEN_FIX, extra = {}) => w.publish(definition, { budgetUsd: 50, ...extra });
  const triggerAgent: TriggerWorld["triggerAgent"] = async (name, triggerSpecs, options = {}) => {
    const owner = options.owner ?? DANA;
    const overlay: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }], triggers: triggerSpecs };
    const created = await w.agents.create({ orgId: ORG_A, name, owner: { kind: "member", developerId: owner }, overlay, createdBy: owner });
    await w.agents.publish({ orgId: ORG_A, agentId: created.agentId, expectedDraftRevision: created.draftRevision, digest: "d".repeat(64), by: owner });
    await addToRoster(w.deps, { orgId: ORG_A, project: "web", agentId: created.agentId, by: DANA });
    if (options.budgetUsd !== undefined) await w.agents.setBudget(ORG_A, created.agentId, { monthlyUsd: options.budgetUsd }, fixtureActor(w.agents, ORG_A, owner).developerId, undefined, { ...({}), actor: fixtureActor(w.agents, ORG_A, owner) });
    return { agentId: created.agentId };
  };
  const builtinBudget: TriggerWorld["builtinBudget"] = async (agentId, usd = 20) => {
    await w.agents.ensureBuiltinSettings(ORG_A, agentId, DANA);
    await w.agents.setBudget(ORG_A, agentId, { monthlyUsd: usd }, fixtureActor(w.agents, ORG_A, DANA).developerId, undefined, { ...({}), actor: fixtureActor(w.agents, ORG_A, DANA) });
  };
  const hook: TriggerWorld["hook"] = (source, hookId = HOOK_A, over = {}) => hookReader.add({ orgId: ORG_A, hookId, project: "web", source, disabled: false, ...over });
  const connection: TriggerWorld["connection"] = (type, actorId = "vendor-user-1", identity = "service") => {
    const connectionId = `con_${(type === "linear" ? "l" : "j").repeat(20)}`;
    w.db.set({ ...connectionsKey(ORG_A, connectionId), entityType: "CONNECTION_DIRECTORY", connectionId });
    w.db.set({ ...connectionKey(ORG_A, connectionId), entityType: "ORG_CONNECTION", orgId: ORG_A, connectionId, type, actorId, ...(identity === "unmarked" ? {} : { identity }) });
  };
  let counter = 0;
  const seed: TriggerWorld["seed"] = async (over) => {
    const { target = { kind: "agent" as const, agentId: "code-reviewer" }, ...rest } = over ?? {};
    counter += 1;
    return triggers.create({
      record: {
        orgId: ORG_A, triggerId: `ctr_${String(counter).padStart(20, "0")}`, target, project: "web",
        spec: { kind: "event", source: "github", type: "pull_request.opened" }, enabled: true, maxRunsPerHour: 30, createdBy: PRIYA, ...rest,
      },
    });
  };
  const notices = async (developerId: string) => (await triggers.listNotices(ORG_A, developerId)).map((notice) => notice.text);
  const targetEvents = (target: TriggerRecord["target"]) => w.db.find((item) => String(item["pk"]).includes(target.kind === "chain" ? `#CHAIN#${target.chainId}` : `#AGENT#${target.agentId}`) && String(item["sk"]).startsWith("EVENT#")) as Array<Record<string, unknown>>;

  return {
    ...w, deps: w.deps, triggers, hookReader, scheduler, routeDeps,
    chainCall: call(routeChainRequest), agentCall: call(routeAgentRequest), budgetedChain, triggerAgent, builtinBudget, hook, connection, seed, notices, targetEvents,
  };
}
