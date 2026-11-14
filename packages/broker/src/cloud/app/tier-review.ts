// S3-9 (DEFERRED S3-LIGHTER-FLOW-REVIEWER): the host pieces Rovara Code's lighter flow needs on a core task (decisions 178, 179, 182, 202): the reviewer call (`tierReviewCall`) and its meter
// (`tierReviewMeter`). Code's core refuses to switch the lighter flow on without the call, and without a reviewer that can run a small change can never be cleared for merge.
//
// Who pays (owner decision 2026-11-03, the same rule as Fix with agent and learning): the CUSTOMER, on a source billed to the company (its own AI sources, or Rovara's metered built-in AI), never a person's plan
// and never Rovara. The money is the task's: the call is charged to the payer the task's start captured (TASK_PAYER, money.ts), on the same budget scopes every other spend of that task counts against
// (`budgetScopesFor`: the company's month, the project's month and, for a member payer, theirs). This file holds the rules; the reads and the key lifecycle are ports (`TierReviewPorts`), given by the root
// over the broker's own machinery (tier-review-ports.ts: `admitWork`, `mintOperationKey`, the in-VPC function's one call, `blockOperationKeys`), so the rules are tested with fakes.
//
// The rules, each fail closed (a refusal is "couldn't check", never a pass: Code's floor reads a reviewer that throws as risky, and a grown review that did not run as not done):
//   - The METER runs before every call (Code's `callWithDeadline` asks it first, the retry included). It refuses, so no call is made, when the task has no captured payer, when no company-billed source
//     serves a model for the review, or when the payer's budgets cannot take the call (a used-up month refuses here: decision 180's "one overrun" is the proxy guard's single month slot, and a month that
//     is already over its cap leaves no room at all). A refusal leaves the ticket empty, so the call that would follow cannot be made.
//   - Code's call port names no task. So the meter hands the call a TICKET (the task, its payer and route) and the call takes it at once. A runtime serves one meter/call pair at a time: a meter that starts
//     while another is metering, or while another task's ticket is waiting, refuses. Two tasks can therefore never swap tickets (one task's review is never charged to another's payer); at worst one
//     of them is refused and Code asks again on a later pass.
//   - The CALL takes the ticket, checks it is for the same purpose and model, and refuses a prompt too long to send, an aborted signal, or a hold over the per-call ceiling or over the room the meter saw.
//     Only then does the port mint a key capped at the hold (which reserves it on the payer's scopes, and itself refuses a full scope) and make the one call.
import { canonicalModelName, type ModelIdentifier, type ModelSelection, type Payer } from "@rovara-code/contracts";
import type { RegistryTaskFlowOptions } from "@rovara-code/broker/core/task-flow";
import type { LearningCompletionApi } from "../../model-proxy/access.js";
import { REVIEW_LIMITS } from "../../model-proxy/protocol.js";
import { learningWorstCaseUsd } from "../../model-sources/diagnosis-provider.js";

export type CloudTierReviewCall = NonNullable<RegistryTaskFlowOptions["tierReviewCall"]>;
export type CloudTierReviewMeter = NonNullable<RegistryTaskFlowOptions["tierReviewMeter"]>;
export type TierReviewPurpose = Parameters<CloudTierReviewCall>[0]["purpose"];

/** The most a reviewer may answer, in tokens (fourteen yes/no answers with reasons, or a list of findings). */
export const TIER_REVIEW_OUTPUT_TOKENS = REVIEW_LIMITS.outputTokens;
/** The role markers and framing a provider adds around a prompt. */
const FRAMING_TOKENS = 256;
/** The hold is the worst case plus this much: the proxy's price for a route need not equal the catalog's list price. */
export const TIER_REVIEW_HOLD_MARGIN = 1.25;
/** What a call on a model with NO list price holds: its key's cap, an estimate (the proxy guard settles an estimated call under decision 180's one-overrun rule). */
export const TIER_REVIEW_UNPRICED_HOLD_USD = 0.5;
/** No reviewer call may hold more than this, whatever the model costs: a dearer call is not made (the change is "couldn't check"). */
export const TIER_REVIEW_MAX_CALL_USD = 5;
/** How long a ticket waits for its call. The call follows the meter at once (the same chain of promises), so a ticket older than this was left by a call that never came. */
export const TIER_REVIEW_TICKET_MS = 10_000;
/** What the meter assumes the prompt adds to the patch before it is built: the fixed questions, the boundary lines and the data's escaping (the call checks the real prompt against the room again). */
const PROMPT_OVERHEAD_CHARS = 8_000;

export interface TierReviewTask {
  project: string;
  /** The payer the task's start captured. */
  payer: Payer;
}

export interface TierReviewRoute {
  /** The model the route serves (the one Code's checking rule chose, or the company's strongest available when it chose none). */
  model: ModelIdentifier;
  /** The proxy alias the key may call, and the source that serves it (a source billed to the company). */
  alias: string;
  sourceId: string;
  api: LearningCompletionApi;
}

/** What the rules read and do, given by the root over the broker's machinery (tier-review-ports.ts). Every one may throw: a throw is a refusal. */
export interface TierReviewPorts {
  /** The task's project and the payer its start captured. Undefined: none recorded, so nobody is charged by default and nothing is called. */
  task(taskId: string): Promise<TierReviewTask | undefined>;
  /** The route for the review's model among the company-billed sources the project walks. `model` undefined: Code's rule chose none, so the company's strongest available. Undefined: no provider. */
  route(input: { project: string; model: ModelSelection | undefined }): Promise<TierReviewRoute | undefined>;
  /** The room the payer's budgets have for the call now (the trial, the machine time, the company's, project's and member's month: `admitWork`). Throws a budget refusal when there is none. */
  room(input: { project: string; payer: Payer }): Promise<number>;
  /** The one call: a key for the payer capped at `holdUsd` and reserved on the payer's scopes, the call, then the key blocked. Answers the model's text; throws for anything that refuses or fails. */
  call(input: { taskId: string; project: string; payer: Payer; route: TierReviewRoute; holdUsd: number; prompt: string; purpose: TierReviewPurpose; signal: AbortSignal }): Promise<string>;
}

export interface CloudTierReviewOptions {
  ports: TierReviewPorts;
  /** Epoch milliseconds. */
  now: () => number;
  log: (event: string, fields: Record<string, unknown>) => void;
}

interface Ticket {
  taskId: string;
  purpose: TierReviewPurpose;
  model: string;
  task: TierReviewTask;
  route: TierReviewRoute;
  roomUsd: number;
  at: number;
}

const modelKey = (model: ModelSelection | undefined): string => (model === undefined ? "" : canonicalModelName({ provider: model.provider, modelId: model.modelId }));

/** The most a call on `model` with `promptChars` characters of prompt can cost, with the margin; a model with no list price holds the fixed estimate. Never under a tenth of a cent. */
export function tierReviewHoldUsd(model: ModelIdentifier, promptBytes: number): number {
  const worst = learningWorstCaseUsd(model, { inputTokens: promptBytes + FRAMING_TOKENS, maxOutputTokens: TIER_REVIEW_OUTPUT_TOKENS });
  if (worst === undefined) return TIER_REVIEW_UNPRICED_HOLD_USD;
  return Math.max(Math.ceil(worst * TIER_REVIEW_HOLD_MARGIN * 1e6) / 1e6, 0.001);
}

/** The core's `tierReviewCall` and `tierReviewMeter` for one company's runtime. */
export function createCloudTierReview(options: CloudTierReviewOptions): { tierReviewCall: CloudTierReviewCall; tierReviewMeter: CloudTierReviewMeter } {
  const { ports, now, log } = options;
  let pending: Ticket | undefined;
  let metering = 0;
  const live = (ticket: Ticket | undefined): ticket is Ticket => ticket !== undefined && now() - ticket.at < TIER_REVIEW_TICKET_MS;

  const refuse = (taskId: string, purpose: string, why: string): false => {
    log("tier_review.refused", { taskId, purpose, why });
    return false;
  };

  const tierReviewMeter: CloudTierReviewMeter = async ({ taskId, purpose, model, promptChars }) => {
    // One meter/call pair at a time: another meter in progress, or another task's ticket still waiting for its call, refuses this one (never a ticket that could be taken by the other task's call).
    if (metering > 0 || (live(pending) && pending.taskId !== taskId)) return refuse(taskId, purpose, "busy");
    metering += 1;
    try {
      // A ticket of this task that was never called (its call was cut off) is replaced; one of another task that is no longer live is dropped.
      pending = undefined;
      const task = await ports.task(taskId);
      if (task === undefined) return refuse(taskId, purpose, "no_payer");
      const route = await ports.route({ project: task.project, model });
      if (route === undefined) return refuse(taskId, purpose, "no_provider");
      let roomUsd: number;
      try {
        roomUsd = await ports.room({ project: task.project, payer: task.payer });
      } catch (error) {
        return refuse(taskId, purpose, `no_budget:${(error as { code?: unknown } | null)?.code === undefined ? "unknown" : String((error as { code: unknown }).code)}`);
      }
      // What the call could hold, from the patch's size: a call the room cannot take is not started.
      const estimate = tierReviewHoldUsd(route.model, promptChars + PROMPT_OVERHEAD_CHARS);
      if (!(roomUsd > 0) || estimate > roomUsd + 1e-9) return refuse(taskId, purpose, "no_room");
      if (estimate > TIER_REVIEW_MAX_CALL_USD) return refuse(taskId, purpose, "too_dear");
      pending = { taskId, purpose, model: modelKey(model), task, route, roomUsd, at: now() };
      return true;
    } catch (error) {
      log("tier_review.meter_failed", { taskId, purpose, error: error instanceof Error ? error.name : "unknown" });
      return false;
    } finally {
      metering -= 1;
    }
  };

  const tierReviewCall: CloudTierReviewCall = async ({ model, prompt, purpose, signal }) => {
    // The ticket is taken before anything else (no await before this line), so a later meter can never see it as waiting.
    const ticket = pending;
    pending = undefined;
    if (!live(ticket) || metering > 0) throw new Error("the reviewer call was not metered");
    if (ticket.purpose !== purpose || ticket.model !== modelKey(model)) throw new Error("the reviewer call does not match its meter");
    if (signal.aborted) throw new Error("the reviewer's time ran out before the call");
    if (prompt.length > REVIEW_LIMITS.userChars) throw new Error("the change is too large to send to the reviewer");
    const holdUsd = tierReviewHoldUsd(ticket.route.model, Buffer.byteLength(prompt, "utf8"));
    if (holdUsd > TIER_REVIEW_MAX_CALL_USD) throw new Error("the reviewer call would cost more than one call may");
    if (holdUsd > ticket.roomUsd + 1e-9) throw new Error("the payer's budget cannot take the reviewer call");
    log("tier_review.call", { taskId: ticket.taskId, purpose, sourceId: ticket.route.sourceId, holdUsd });
    return await ports.call({ taskId: ticket.taskId, project: ticket.task.project, payer: ticket.task.payer, route: ticket.route, holdUsd, prompt, purpose, signal });
  };

  return { tierReviewCall, tierReviewMeter };
}
