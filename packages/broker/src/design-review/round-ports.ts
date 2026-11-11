// Design review stage, DR7 slice B: what the round's dispatch needs of the rest of the broker, as one small port. The broker builds it from its own dependencies (`design-review/wiring.ts`); a test builds it from fakes. Everything the
// round reads from outside the task record comes through here, so the orchestration (round-start.ts) reads no store and calls no host by itself.
import type { ContextSource, DesignReviewBinding, InvocationModelRoute, ModelSelection, OrgId } from "@rovara-code/contracts";
import type { StateTable } from "../aws/cancellation.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { PriceLookup } from "./estimate.js";
import type { PacketReaders } from "./packet.js";
import type { PacketOriginItem } from "./mcp-allowlist.js";
import type { DesignReviewProxyCheck } from "./proxy-check.js";

/** What a task's packets are read with: the broker's own readers (repository files at the pinned commits, the meta repository at its knowledgeCommit, MCP items through the allowlist), the repositories' names, and the request thread to keep out. */
export interface RoundSourceReaders {
  readers: PacketReaders;
  /** The names section 8 may use for a repository (the project's). */
  repositoryNames: readonly string[];
  /** The task's own request thread, passed to the packet builder and to the MCP reader (security M6/N8). */
  origin: readonly PacketOriginItem[];
}

export interface DesignReviewRoundPorts {
  /** The State table, for the packet store and the budget allocation. */
  table: StateTable;
  now(): number;
  /** Whether a model proxy exists to mint reviewer keys from (`designReviewProxyCheck`). */
  proxy(): DesignReviewProxyCheck;
  /** The catalog price of a model (a model with none is "cost unavailable", never guessed). */
  price: PriceLookup;
  /** The company lock's cap ceiling for an org, when it has one. */
  capCeilingUsd(orgId: OrgId): Promise<number | undefined>;
  /** What is left of the task's run limit for model spend (`taskRunRoomUsd`). */
  taskRoomUsd(task: DeveloperTaskRecord): Promise<number>;
  /** The readers for this task's packets; `operationId` is the round's operation, under which the MCP route records what it fetched. */
  sourceReaders(task: DeveloperTaskRecord, operationId: string): Promise<RoundSourceReaders>;
  /** The model the planner last ran on, for the planner-revision part of the estimate. Absent or undefined: the reviewers' model is priced instead (high, never low). */
  plannerModel?(task: DeveloperTaskRecord): Promise<ModelSelection | undefined>;
  /** The context sources of the project, for naming the origin thread to withhold. Not used by the dispatch itself. */
  contextSources?(task: DeveloperTaskRecord): Promise<readonly ContextSource[]>;
}

/** What the operation's own resolution (the plan check's model and the route chosen for it) tells the round, handed to `prepare` inside the operation's creation. */
export interface DesignReviewResolved {
  /** The id the operation will have. The budgets and the packets are stored under it before the operation exists. */
  operationId: string;
  /** The model the plan_check stage resolved for this step; every reviewer and the merge step use it. */
  model: ModelSelection | undefined;
  /** The route the worker cannot reach by the model's own name (absent for the metered catalog, which is reached by name). */
  modelRoute: InvocationModelRoute | undefined;
  /** The source that serves the model. A person's ChatGPT plan has no alias and serves no reviewer. */
  sourceId: string | undefined;
}

/** `acceptTask`'s `designReview` option: the round's preparation, run inside `taskOperationParts` once the plan-check model is resolved and before the operation record exists. It answers the binding the operation is stored with (in the SAME write that creates it), or throws `DesignReviewRoundStop`. */
export interface DesignReviewDispatch {
  prepare(resolved: DesignReviewResolved): Promise<DesignReviewBinding>;
}
