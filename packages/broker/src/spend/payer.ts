// Plan 3 Task 29: every expense has a payer and a place, counted once. The payer is whose budget the work is charged to and is named from where the work
// came from (`resolvePayer`); the place is the project it works on. `budgetScopesFor` turns the two into the budgets the work is counted against, which
// Task 31 checks and Task 30 records. Plan 4 widens both with its chain payer and the `chain` scope.
import { ROVARA_CODE_AGENT_ID, agentXError, type AgentId, type BudgetScope, type Payer, type Place, type WorkOrigin } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { MintTags } from "../model-proxy/access.js";

/** A person the origin names, as the request names one. */
export interface NamedPerson { developerId: string }

/** What `resolvePayer` decides from: the origin and the facts that origin carries. A fact an origin does not use is ignored. */
export interface ResolvePayerInput {
  origin: WorkOrigin;
  project: string;
  /** Whether the project's AI settings say the project pays for its tasks. */
  projectPays: boolean;
  /** The agent that runs; the payer of work an event or a schedule starts. */
  agentId: AgentId;
  /** Plan 4's chain payer, required for the `chain` origin: the chain's own rules decided it, or the member for a person-started chain. */
  chainPayer?: Payer;
  /** The person who started the run, for the origins a person starts from. */
  startedBy?: NamedPerson;
  /** The Linear user who assigned the issue: a person with a Rovara member (`developerId`), a person Rovara has no member for, or a bot. */
  assignedBy?: { developerId?: string; bot: boolean };
  /** The member who approved work a bot assigned. */
  approvedBy?: NamedPerson;
  /** The member who accepted an offered run. */
  acceptedBy?: NamedPerson;
}

/** The facts only some origins carry, which the caller of a start hands over beside the request. */
export type PayerFacts = Pick<ResolvePayerInput, "assignedBy" | "approvedBy" | "acceptedBy">;

const member = (person: NamedPerson): Payer => ({ kind: "member", developerId: person.developerId });
const needs = (what: string) => agentXError("CONFIG_INVALID", `payer: this run needs ${what} to say who pays`);

/**
 * Whose budget a run is charged to, in this order: a test run is the project's (its testing allowance is counted as well, see `budgetScopesFor`); an
 * event or a schedule is the agent's; a chain is whoever the chain named; a project that pays pays; a Linear issue is its person assigner's, else
 * the member who approved a bot's assignment, else the project; an offer is whoever accepted it; any other run is whoever started it. A run whose
 * origin needs a fact it was not given is refused, never charged to someone else by default.
 */
export function resolvePayer(input: ResolvePayerInput): Payer {
  switch (input.origin) {
    case "test_run": return { kind: "project", project: input.project };
    case "event":
    case "schedule": return { kind: "agent", agentId: input.agentId };
    case "chain":
      if (input.chainPayer === undefined) throw needs("the chain's payer");
      return input.chainPayer;
    default: break;
  }
  if (input.projectPays) return { kind: "project", project: input.project };
  if (input.origin === "linear") {
    const assigner = input.assignedBy;
    if (assigner !== undefined && !assigner.bot && assigner.developerId !== undefined) return { kind: "member", developerId: assigner.developerId };
    // A bot, or a person Rovara has no member for: whoever approved it, else no one in particular, so the project.
    return input.approvedBy === undefined ? { kind: "project", project: input.project } : member(input.approvedBy);
  }
  if (input.origin === "offer") {
    if (input.acceptedBy === undefined) throw needs("the person who accepted the offer");
    return member(input.acceptedBy);
  }
  if (input.startedBy === undefined) throw needs("the person who started it");
  return member(input.startedBy);
}

/**
 * The budgets a run is counted against. The org and the project always (each is checked only when it has a limit). A member payer adds the member; a
 * test run adds its starter's testing allowance and not the member; an agent payer adds that agent. Work a person started never adds the agent,
 * whatever budget the agent has: only an agent that pays is limited by its own. `options.agentId` is the agent that runs, which the usage counter
 * (`agentUsageCounter`, no limit, not a scope) counts for every expense.
 */
export function budgetScopesFor(payer: Payer, place: Place, options: { agentId: AgentId; testRunBy?: string | undefined }): BudgetScope[] {
  const scopes: BudgetScope[] = [{ kind: "org" }, { kind: "project", project: place.project }];
  if (options.testRunBy !== undefined) scopes.push({ kind: "testing", developerId: options.testRunBy });
  else if (payer.kind === "member") scopes.push({ kind: "member", developerId: payer.developerId });
  if (payer.kind === "agent") scopes.push({ kind: "agent", agentId: payer.agentId });
  return scopes;
}

/** The name of the counter that adds up what an agent has spent however it was paid for. It has no limit and is not a `BudgetScope`. */
export const agentUsageCounter = (agentId: AgentId): string => `AGENT_USAGE#${agentId}`;

/** What a task is paid for with: its payer, its place, the agent that runs and the budgets they are counted against. */
export interface TaskPayment {
  payer: Payer;
  place: Place;
  agentId: AgentId;
  origin: WorkOrigin | undefined;
  scopes: BudgetScope[];
}

/**
 * The payment of a task, from the record the start wrote. A task from before payers were recorded was paid for by its owner, in the project it
 * names, and ran Rovara Code. A test run (a draft agent's run) is counted on the testing allowance of the person who started it (`startedBy`;
 * a task from before that was recorded was started by its owner).
 */
export function paymentOfTask(task: Pick<DeveloperTaskRecord, "payer" | "place" | "project" | "developerId" | "origin" | "agent" | "startedBy">): TaskPayment {
  const payer: Payer = task.payer ?? { kind: "member", developerId: task.developerId };
  const place: Place = task.place ?? { project: task.project };
  const agentId = task.agent?.agentId ?? ROVARA_CODE_AGENT_ID;
  return { payer, place, agentId, origin: task.origin, scopes: budgetScopesFor(payer, place, { agentId, testRunBy: task.origin === "test_run" ? (task.startedBy?.developerId ?? task.developerId) : undefined }) };
}

/** What identifies the payer in a key's tags and the ledger: the member, the project or the agent. */
export const payerIdOf = (payer: Payer): string => (payer.kind === "member" ? payer.developerId : payer.kind === "project" ? payer.project : payer.agentId);

/** The model source a key is minted for until the route chooses one (Task 31's `mintOperationKey` passes the route's source). */
export const ROVARA_SOURCE_ID = "rovara";

/**
 * The tags a model proxy key carries, which say whose budget the work is charged to and what ran (the proxy's spend logs do not carry key
 * metadata, so the ledger reads these from the key record). A key is minted in a member's name (`user_id`) only for a member payer: `keyMember`.
 */
export function mintTagsFor(input: {
  payer: Payer; place: Place; agentId: AgentId; origin: string; taskId?: string | undefined; operationId?: string | undefined; stepId?: string | undefined;
}): MintTags {
  return {
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    agentId: input.agentId, project: input.place.project, payerKind: input.payer.kind, payerId: payerIdOf(input.payer), source: ROVARA_SOURCE_ID, origin: input.origin,
  };
}

/** The member a key is minted in the name of: the payer when it is a member, else no one (the key then answers to the org alone). */
export const keyMember = (payer: Payer): string | undefined => (payer.kind === "member" ? payer.developerId : undefined);
