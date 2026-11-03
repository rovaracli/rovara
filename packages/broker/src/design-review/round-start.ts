// Design review stage, DR7 slice B (DR7-BRIEF.md "Slice B", security S10 to S17, money W5/W6): what starts ONE round of the design review. The plan check's start (`startTaskWorkflowPlanCritiqueFromSystem`) hands a task in the design form
// here; this module does, in this order, and dispatches nothing if any step fails:
//
//   1. the proxy check (no model proxy, no per-reviewer keys, no review);
//   2. the packets, built by the BROKER with its own readers (repository files at the pinned commits, the meta repository at knowledgeCommit, MCP items through the allowlist with the task's origin passed in);
//   3. the estimate, with the real packet size and the rounds still to run, and the cost gate with what the review has already spent: either the spend card (`holdDesignReviewForCost`) or on;
//   4. the round's money: the review's room (less what the planner's revision is expected to cost) and the task's remaining run limit, split into one ceiling per slot in ONE conditional write (`allocateSlotBudgets`);
//   5. the stored packets (`putSlotPackets`): the route serves these bytes and never rebuilds them;
//   6. the PLAN_CRITIQUE operation, created with the `designReview` binding in the SAME write (the merge prompt from the registry, `mergeBindingFor`), the packet capability and no other model channel, and the workflow moved to RUNNING by
//      `startDesignReview`.
//
// One operation is one round (m4). A failure at any step leaves the review `not_run` with a fixed reason (or at the cap), never an exception that a dispatch retry would run again with other bytes: a person's one-tap Retry
// (`retryDesignReviewNotRun`, bounded) is the way to try again. What the model or a host wrote is never kept; only fixed codes are logged.
import { randomUUID } from "node:crypto";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError, DESIGN_REVIEW_ROUNDS_MAX, DesignReviewBindingSchema, WorkflowTransitionError, agentXError, closeDesignReview, holdDesignReviewForCost, startDesignReview, workflowIsDesignReviewing, workflowRequestId,
  type DesignReviewBinding, type DesignReviewTier, type ModelIdentifier, type ModelSelection, type ReviewerRole, type WorkflowArtifact, type WorkflowSnapshot, type DESIGN_REVIEW_NOT_RUN_REASONS,
} from "@agentx/contracts";
import { aiToolTurn, developerTaskIdentity, partyOfTask, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { loadWorkflowDocument } from "../developer/plan-artifacts.js";
import { accessFence, systemTaskAccess } from "../aws/developer-tasks/access.js";
import { isConditional } from "../aws/broker-shared.js";
import { creatorGuard, iso, partyOfTaskActor, putNew, taskBaseOption, turnTable } from "../aws/developer-tasks/common.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks/types.js";
import { estimateDesignReviewUsd, gateDesignReviewCost, nextLowerTier, reviewersForRound, TIER_HAS_MERGE_MODEL, designReviewKeyBudgets, type DesignReviewCapGate, type DesignReviewEstimate } from "./estimate.js";
import { mergeBindingFor } from "./merge-binding.js";
import { buildReviewerPacket, estimateInputTokens, PacketBuildError, PACKET_BYTES_MAX, type BuiltPacket, type PacketReaders } from "./packet.js";
import { putSlotPackets } from "./packet-store.js";
import { designSourcesOf, pinsOf } from "./round-inputs.js";
import type { DesignReviewDispatch, DesignReviewResolved, DesignReviewRoundPorts } from "./round-ports.js";
import { allocateSlotBudgets } from "./slot-keys.js";

type NotRunReason = (typeof DESIGN_REVIEW_NOT_RUN_REASONS)[number];

/** Why a round did not start, as the workflow moves for it. Fixed codes: nothing from a host, a model or an error's own text is kept. */
export type RoundStop =
  | { kind: "hold"; estimateUsd: number | undefined }
  | { kind: "not_run"; reason: NotRunReason }
  | { kind: "at_cap" };

/** Thrown from the round's preparation (inside the operation's creation) when the round must not run; the start turns it into the workflow's move. */
export class DesignReviewRoundStop extends Error {
  constructor(readonly stop: RoundStop) { super("the design review round was not started"); this.name = "DesignReviewRoundStop"; }
}

const notRun = (reason: NotRunReason): DesignReviewRoundStop => new DesignReviewRoundStop({ kind: "not_run", reason });

/**
 * Every reviewer of a round reads the same source the same way: ONE read per source per round, so they are all given the same bytes (and an MCP item has one fetch time). The read is made with the packet's whole room, whatever the
 * caller's; a file too big for one reviewer's room is left out of that packet by the builder (`byte_cap`), never cut differently for each.
 */
function sharedReaders(readers: PacketReaders): PacketReaders {
  const once = <A, T>(call: (input: A) => Promise<T>, key: (input: A) => unknown = (input) => input): ((input: A) => Promise<T>) => {
    const answers = new Map<string, Promise<T>>();
    return (input) => {
      const id = JSON.stringify(key(input));
      let answer = answers.get(id);
      if (answer === undefined) { answer = call(input); answers.set(id, answer); }
      return answer;
    };
  };
  const whole = <T extends { maxBytes: number }>(input: T): T => ({ ...input, maxBytes: PACKET_BYTES_MAX });
  const room = <T extends { maxBytes: number }>(input: T): unknown => { const rest: Record<string, unknown> = { ...input }; delete rest.maxBytes; return rest; };
  return {
    readRepoFile: once((input) => readers.readRepoFile(whole(input)), room), readMetaFile: once((input) => readers.readMetaFile(whole(input)), room), fetchMcpItem: once((input) => readers.fetchMcpItem(input)),
  };
}

/** The slot a round names for a role: one per reviewer and one for the merge step, distinct, of the pattern the packet and key routes accept. */
export const slotOf = (round: number, role: ReviewerRole | "merge"): string => `r${round}-${role}`;

export interface RoundInputs {
  task: DeveloperTaskRecord;
  workflow: WorkflowSnapshot;
  ports: DesignReviewRoundPorts;
  design: { ref: string; revision: string; text: string; sha256: string };
  requirements: { ref: string; revision: string; text: string };
  /** A person approved an unpriced run at the cost hold (dispatch row). The round then starts from WAITING with `costApproved`; the cap still holds. */
  costApprovedBy?: string;
}

/** What a round's preparation leaves for the start: the figure `startDesignReview` is told. */
interface Prepared { estimateUsd: number | undefined; binding: DesignReviewBinding }

/**
 * The whole preparation of one round (steps 1 to 5 above), given the model the operation resolved. Throws `DesignReviewRoundStop` for every way the round must not run; any other failure is turned into one (`worker_failed`),
 * so nothing here is retried by the dispatch with other bytes.
 */
export async function prepareDesignReviewRound(input: RoundInputs, resolved: DesignReviewResolved): Promise<Prepared> {
  const { task, workflow, ports } = input;
  const review = workflow.designReview;
  if (review === undefined || task.orgId === undefined) throw notRun("worker_failed");
  try {
    // 1. No model proxy: no reviewer can have a key of its own, so there is nothing to verify (S9). Checked before anything is estimated, built or stored.
    const proxy = ports.proxy();
    if (!proxy.ok) throw notRun(proxy.notRunReason);
    // Every reviewer and the merge step run on the model the plan_check stage resolved, through a route that has an alias: a person's ChatGPT plan has none and serves no reviewer. The Rovara catalog is the customer's provider like any other.
    const model = resolved.model;
    if (model === undefined || resolved.sourceId === undefined || resolved.sourceId === "personal-chatgpt") throw notRun("no_model_source");
    if (review.capUsd === undefined) throw new DesignReviewRoundStop({ kind: "at_cap" });
    const capUsd = review.capUsd;
    const round = (review.rounds.length + 1) as 1 | 2;
    if (round > DESIGN_REVIEW_ROUNDS_MAX) throw notRun("worker_failed");
    const roles = reviewersForRound(review.tier, round);

    // 2. What the round would cost, worked out in two steps. FIRST from the sizes alone (B-m7): the design and the requirements are the least any packet holds, so a hold on their size is certain and nothing else is read for it
    //    (no source is fetched, and no MCP fetch is logged under an operation that never exists). THEN, if that passes, from the packets the broker builds with its own readers.
    const reviewerModel: ModelIdentifier = { provider: model.provider, modelId: model.modelId };
    const plannerSelection = await ports.plannerModel?.(task);
    const plannerModel: ModelIdentifier = plannerSelection === undefined ? reviewerModel : { provider: plannerSelection.provider, modelId: plannerSelection.modelId };
    const roundsLeft = (DESIGN_REVIEW_ROUNDS_MAX - review.rounds.length) as 1 | 2;
    const estimateFor = (tier: DesignReviewTier, packetTokens: number): DesignReviewEstimate => estimateDesignReviewUsd({ tier, models: { reviewer: reviewerModel, merge: reviewerModel, planner: plannerModel }, price: ports.price, packetTokens, rounds: roundsLeft });
    const capCeilingUsd = await ports.capCeilingUsd(task.orgId);
    const lower = nextLowerTier(review.tier);
    const gateFor = (packetTokens: number) => gateDesignReviewCost({
      tier: review.tier, capUsd, spentUsd: review.spentUsd, capCeilingUsd, estimate: estimateFor(review.tier, packetTokens),
      ...(lower === undefined ? {} : { lowerTier: { tier: lower, estimate: estimateFor(lower, packetTokens) } }),
      // The skip rules are applied per person when the spend card is built for them; the gate here only decides go or ask.
      canSkip: false,
    });
    const floorTokens = estimateInputTokens(Buffer.byteLength(input.design.text, "utf8") + Buffer.byteLength(input.requirements.text, "utf8"));
    const floorGate = gateFor(floorTokens);
    // An unpriced run a person approved goes on past "cost unavailable"; an estimate over the cap is never lifted by an approval (the cap is raised, or a lower tier chosen, on the card).
    const approved = (gate: DesignReviewCapGate): boolean => gate.kind === "ask" && gate.why === "cost_unavailable" && input.costApprovedBy !== undefined;
    if (floorGate.kind === "ask" && !approved(floorGate)) throw new DesignReviewRoundStop({ kind: "hold", estimateUsd: floorGate.estimateUsd });

    const { readers, repositoryNames, origin } = await ports.sourceReaders(task, resolved.operationId);
    const shared = sharedReaders(readers);
    const baseCommits = pinsOf(taskBaseOption(task, workflow).workflowBase);
    const sources = designSourcesOf(input.design.text, repositoryNames);
    let built: BuiltPacket[];
    try {
      built = await Promise.all(roles.map((role) => buildReviewerPacket({
        role, tier: review.tier, design: { ref: input.design.ref, revision: input.design.revision, text: input.design.text }, requirements: { ref: input.requirements.ref, revision: input.requirements.revision, text: input.requirements.text },
        ...(task.requestText === undefined ? {} : { requestText: task.requestText }), baseCommits, ...(task.knowledgeCommit === undefined ? {} : { knowledgeCommit: task.knowledgeCommit }),
        sources, ...(origin.length === 0 ? {} : { origin: [...origin] }),
      }, shared)));
    } catch (error) {
      if (error instanceof PacketBuildError) throw notRun("inputs_unverified");
      throw error;
    }

    // 3. The estimate with the real packet size, and the cost gate over what is left under the cap AND under the task's own run limit (B-m2): the review cap and the task's limit are two different limits, and a round that the
    //    task's remaining room cannot pay for would only spend money to hit `budget_exhausted` half way. The task's limit is its own stop, said as such.
    const packetTokens = Math.max(...built.map((packet) => packet.estimatedInputTokens));
    const gate = gateFor(packetTokens);
    if (gate.kind === "ask" && !approved(gate)) throw new DesignReviewRoundStop({ kind: "hold", estimateUsd: gate.estimateUsd });
    const estimate = estimateFor(review.tier, packetTokens);
    const taskRoomUsd = await ports.taskRoomUsd(task);
    const perRoundUsd = estimate.kind === "priced" ? (estimate.breakdown.reviewersUsd + estimate.breakdown.mergeUsd) / estimate.rounds : 0;
    if (taskRoomUsd <= 0 || taskRoomUsd < perRoundUsd) throw notRun("task_limit");

    // 4. The round's money: the review's room (the planner's revision is held back, it is not on a reviewer key) and the task's remaining run limit, one ceiling per slot, in one conditional write.
    const reservedUsd = estimate.kind === "priced" ? estimate.breakdown.plannerUsd : 0;
    const hasMerge = TIER_HAS_MERGE_MODEL[review.tier];
    const reviewRoomUsd = designReviewKeyBudgets({ capUsd: review.capUsd, spentUsd: review.spentUsd, reviewers: roles.length, hasMergeModel: hasMerge, reservedUsd }).roomUsd;
    const selection: ModelSelection = model;
    const binding = DesignReviewBindingSchema.parse({
      version: 1, round,
      reviewers: built.map((packet) => ({ role: packet.role, keySlot: slotOf(round, packet.role), packetDigest: packet.packetDigest, model: selection, ...(resolved.modelRoute === undefined ? {} : { modelRoute: resolved.modelRoute }) })),
      ...(Object.keys(baseCommits).length === 0 ? {} : { baseCommits }),
      ...(hasMerge ? { merge: mergeBindingFor({ keySlot: slotOf(round, "merge"), model: selection, ...(resolved.modelRoute === undefined ? {} : { modelRoute: resolved.modelRoute }) }) } : {}),
    });
    try {
      await allocateSlotBudgets(ports.table, { orgId: task.orgId, operationId: resolved.operationId, binding, reviewRoomUsd, taskRoomUsd, nowMs: ports.now() });
    } catch (error) {
      if (error instanceof AgentXError && error.code === "BUDGET_EXCEEDED") throw new DesignReviewRoundStop({ kind: "at_cap" });
      throw error;
    }

    // 5. The packets are stored before the operation exists, under its id. If this fails nothing is dispatched, and the same operation is never given other bytes (a conflict refuses).
    await putSlotPackets(ports.table, { orgId: task.orgId, operationId: resolved.operationId, round, packets: built.map((packet) => ({ keySlot: slotOf(round, packet.role), packet })), nowMs: ports.now() });
    return { estimateUsd: gate.kind === "go" ? gate.estimateUsd : undefined, binding };
  } catch (error) {
    if (error instanceof DesignReviewRoundStop) throw error;
    console.log(JSON.stringify({ component: "broker", event: "design_review.round_not_prepared", taskId: task.taskId, error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" }));
    throw notRun("worker_failed");
  }
}

/** The text the design review's operation carries as its prompt. The worker runs the reviewers from the binding and the packets; the prompt names nothing a model could be steered by. */
export const designReviewOperationPrompt = (round: number): string => `Design review, round ${round}. The reviewers are given their packets by the broker.`;

const artifactOf = (workflow: WorkflowSnapshot, type: WorkflowArtifact["type"]): WorkflowArtifact | undefined => workflow.artifacts.filter((entry) => entry.type === type).at(-1);

/** Applies the move a stop calls for, if the task is still where the start found it. */
async function applyStop(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot, stop: RoundStop, now: string): Promise<"STARTED" | "STALE"> {
  const expectedRevision = workflow.revision;
  // A round started from the cost hold (an approved unpriced run) that is held again stays where it is: the card the person decided on is still the card.
  if (stop.kind === "hold" && workflow.state === "WAITING") return "STARTED";
  const next = stop.kind === "hold" ? holdDesignReviewForCost(workflow, { expectedRevision, ...(stop.estimateUsd === undefined ? {} : { estimateUsd: stop.estimateUsd }), now })
    : stop.kind === "at_cap" ? closeDesignReview(workflow, { expectedRevision, outcome: "stopped_at_cap", now })
      : closeDesignReview(workflow, { expectedRevision, outcome: "not_run", notRunReason: stop.reason, now });
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :critique AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.revision, ":critique": "PLAN_CRITIQUE", ":ready": workflow.state },
    }));
  } catch (error) {
    // A task that moved meanwhile is the newer writer's.
    if (isConditional(error)) return "STALE";
    throw error;
  }
  console.log(JSON.stringify({ component: "broker", event: "design_review.round_stopped", taskId: task.taskId, kind: stop.kind, ...(stop.kind === "not_run" ? { reason: stop.reason } : {}) }));
  return "STARTED";
}

/**
 * Starts the design review's next round for a task standing at PLAN_CRITIQUE/READY with a review that is "estimating" (the dispatch row of the plan check: after the design was submitted, after a retry on the next model, and after
 * the planner revised the design for round 2). Answers like the plan check's start: STALE when the task is not exactly there, DUPLICATE for a repeated dispatch, STARTED otherwise (also when the round was held for cost or closed).
 */
export async function startDesignReviewRound(
  deps: DeveloperTaskRouteDependencies,
  input: { task: DeveloperTaskRecord; workflow: WorkflowSnapshot; stepId: string; conversationId: (taskId: string, revision: number) => string; actor?: DeveloperCaller; /** Who approved an unpriced run at the cost hold (from the dispatch row): the only way a round starts from WAITING. */ costApprovedBy?: string },
): Promise<"STARTED" | "DUPLICATE" | "STALE"> {
  const { task, workflow } = input;
  const ports = deps.designReview;
  const review = workflow.designReview;
  const approvedHold = input.costApprovedBy !== undefined && review?.status === "waiting_cost" && workflow.state === "WAITING";
  if (!workflowIsDesignReviewing(workflow) || review === undefined || (review.status !== "estimating" && !approvedHold) || review.rounds.length >= DESIGN_REVIEW_ROUNDS_MAX) return "STALE";
  // A deployment whose broker did not give this path the round's ports (the owner's immediate start after a retry) leaves the dispatch row to the sweep, which has them.
  if (ports === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the design review cannot be started from here");
  await creatorGuard(deps, task);
  const dispatchAccess = await systemTaskAccess(deps, task);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED" || workspace.status === "PREPARATION_FAILED") return "STALE";
  const designArtifact = artifactOf(workflow, "design");
  const requirementsArtifact = artifactOf(workflow, "requirements");
  if (designArtifact === undefined || requirementsArtifact === undefined) throw agentXError("WORKSPACE_NOT_READY", "the design to review or the approved requirements are missing");
  const read = (objectKey: string, maxBytes: number) => deps.actions.readArtifact(objectKey, maxBytes);
  const [design, requirements] = [await loadWorkflowDocument(read, designArtifact, {}), await loadWorkflowDocument(read, requirementsArtifact, {})];
  if (design === undefined || requirements === undefined) throw agentXError("WORKSPACE_NOT_READY", "the design or the requirements failed their digest check");
  const receivedAt = iso(deps);
  const round = review.rounds.length + 1;
  const requestId = workflowRequestId("agentx-plan-critique", task.taskId, workflow.revision);
  const conversationId = input.conversationId(task.taskId, workflow.revision);
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
    Item: { pk: `WORKSPACE#${task.workspaceId}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId: task.workspaceId, createdAt: receivedAt, updatedAt: receivedAt },
  })).catch((error: unknown) => { if (!isConditional(error)) throw error; });

  const roundInputs: RoundInputs = {
    task, workflow, ports, ...(input.costApprovedBy === undefined ? {} : { costApprovedBy: input.costApprovedBy }),
    design: { ref: `design-v${designArtifact.version}`, revision: designArtifact.sha256.slice(0, 12), text: design.markdown, sha256: designArtifact.sha256 },
    requirements: { ref: `requirements-v${requirementsArtifact.version}`, revision: requirementsArtifact.sha256.slice(0, 12), text: requirements.markdown },
  };
  let prepared: Prepared | undefined;
  const dispatch: DesignReviewDispatch = { prepare: async (resolved) => { prepared = await prepareDesignReviewRound(roundInputs, resolved); return prepared.binding; } };
  try {
    const accepted = await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId, conversationId, prompt: designReviewOperationPrompt(round) }, (operation) => {
      if (prepared === undefined) throw agentXError("CONFIG_INVALID", "the design review round was not prepared");
      // The workflow moves READY -> RUNNING by the review's own move, which refuses a start the cap does not allow, whoever calls.
      const next = startDesignReview(workflow, { expectedRevision: workflow.revision, ...(prepared.estimateUsd === undefined ? {} : { estimateUsd: prepared.estimateUsd }), ...(input.costApprovedBy === undefined ? {} : { costApproved: { by: { actorId: input.costApprovedBy } } }), now: receivedAt });
      return [
        { Update: {
          TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
          ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :critique AND workflow.#state = :ready AND attribute_not_exists(closedAt)",
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":critique": "PLAN_CRITIQUE", ":ready": workflow.state },
        } },
        putNew(turnTable(deps), aiToolTurn({
          party: input.actor === undefined ? partyOfTask(task) : partyOfTaskActor(task, input.actor), turnId: randomUUID(), action: "continue", phase: "accepted", outcome: "accepted", receivedAt, finishedAt: iso(deps),
          request: "Review the design with fresh reviewers", response: `The design review started as operation ${operation.id}.`, operationId: operation.id,
        })),
        ...(dispatchAccess === undefined ? [] : [accessFence(deps, dispatchAccess)]),
      ];
    }, { sharedTask: task.shared === true, workflowMode: "PLAN_CRITIQUE", programStepId: input.stepId, ...taskBaseOption(task, workflow), designReview: dispatch });
    return accepted.duplicate ? "DUPLICATE" : "STARTED";
  } catch (error) {
    if (error instanceof DesignReviewRoundStop) return applyStop(deps, task, workflow, error.stop, receivedAt);
    // A stale workflow in the start move (the task moved while the round was prepared) is not this dispatch's to retry.
    if (error instanceof WorkflowTransitionError) return "STALE";
    throw error;
  }
}
