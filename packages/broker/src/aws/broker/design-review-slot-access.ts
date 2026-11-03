// Part of the broker, DR7 slice A: what `GET /v1/internal/model-access?slot=` does differently for a design-review operation (model-access.ts calls into this; an operation WITHOUT a stored binding never does).
//
// A design-review operation has no model key of its own. Every request must name a slot of the binding the broker stored, and gets the key minted for that (operation, slot) alone (security S6 to S9, N4):
//   - the slot is looked up in the stored binding (reviewers, and the merge step when it is a model); a request with no slot, or an unknown one, is refused, and nothing falls back to the operation's key;
//   - the key may call only that slot's resolved model: the model must still be offered (the usable-models resolution), not forbidden by the company, and served by a source with an alias for it, which must be the
//     alias the binding names. A person's ChatGPT plan has no alias and gets no key. A Rovara-catalog model with no list price gets none either (the proxy could not hold its spend to a budget);
//   - it spends from the same payer as the task's other keys (the customer: the key is minted by the ordinary task path in model-access.ts, so its tags, scopes and budgets are the task's) and from the task
//     and project budgets, and its own budget is a share of what is left under the review's cap (`designReviewKeyBudgets`); nothing left means no key;
//   - it is minted once and handed out again while it lives (idempotent, S7), with a life longer than a reviewer's run plus the worker's refresh margin.
import { DesignReviewBindingSchema, agentXError, designReviewActive, canonicalModelName, forbiddenModelMatcher, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { readGuardrails } from "../../agents/guardrails.js";
import { finalizeKey } from "../../spend/ledger.js";
import { servableModels, servingRoutes } from "../../model-sources/routing.js";
import { designReviewKeyBudgets } from "../../design-review/estimate.js";
import { DESIGN_REVIEW_KEY_TTL_SECONDS, bindingSlotOf, putSlotKey, readSlotKey, type BindingSlot } from "../../design-review/slot-keys.js";
import { getItem, type OperationRecord } from "../cancellation.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import type { MintOperationKeyInput } from "../../spend/admission.js";
import { keyIdOf } from "../../org/budget.js";
import { requireWorkspace } from "./records.js";
import { routingOf } from "./scope-helpers.js";
import { ledgerOf } from "./sweeps-and-readiness.js";
import type { AwsBrokerDependencies } from "./definitions.js";

const SLOT_REFUSED = "a design review asks for a model key by one of its own slots";
const NO_MODEL = "The model chosen for this reviewer cannot be used on this account right now.";
const NO_ROOM = "The design review has no budget left for this step.";

/**
 * The slot a model-access request names, when the operation is a design-review one. Undefined for any operation without a stored binding (the request is answered exactly as before, whatever it carries).
 * A design-review operation with no slot, a malformed or unknown one, or a binding that does not parse is refused: the key of the operation itself is never handed out.
 */
export function designReviewSlotOf(operation: OperationRecord, path: string): BindingSlot | undefined {
  if (operation.designReview === undefined) return undefined;
  const binding = DesignReviewBindingSchema.safeParse(operation.designReview);
  if (!binding.success || operation.kind !== "task" || operation.workflowMode !== "PLAN_CRITIQUE") throw agentXError("FORBIDDEN", SLOT_REFUSED);
  const slot = bindingSlotOf(binding.data, new URL(path, "https://agentx.invalid").searchParams.get("slot"));
  if (slot === undefined) throw agentXError("FORBIDDEN", SLOT_REFUSED);
  return slot;
}

/** What the mint of one slot's key is given, and how a kept key is handed out again. */
export interface SlotAsk {
  slot: BindingSlot;
  /** The route the key is scoped to: the proxy alias of the slot's model, and the source that serves it. */
  route: { alias: string; sourceId: string };
  /** A key already minted for this slot that can still be used, as the answer to give; undefined when a new one must be minted. */
  reuse(): Promise<{ apiKey: string; expiresAt: number } | undefined>;
  /** The changes to the ordinary mint input for this slot (its own budget, life and recording). Throws when the review has no budget left for the step. */
  mintInput(scope: Pick<MintOperationKeyInput, "recordOn">): Pick<MintOperationKeyInput, "ttlSeconds" | "keepEarlierKeys" | "recordOn" | "budgetCeilingUsd">;
  /** Keeps the key just minted, and answers with the key to hand out: this one, or the one another request kept first (this one is then given back). */
  keep(minted: { key: string; keyId: string; expiresAt: number; maxBudgetUsd: number }): Promise<{ apiKey: string; expiresAt: number }>;
}

/** The task of a workspace and its design review, read fresh. Fails closed: no task, another org's task, or no review in progress is a refusal. */
async function reviewOf(dependencies: AwsBrokerDependencies, operation: OperationRecord) {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  const task = pointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  const review = task?.workflow?.designReview;
  if (task === undefined || task.orgId !== operation.orgId || review === undefined || !designReviewActive(review)) throw agentXError("FORBIDDEN", SLOT_REFUSED);
  return review;
}

/** The route that serves a slot's model, or MODEL_NOT_ALLOWED. */
async function routeOf(dependencies: AwsBrokerDependencies, operation: OperationRecord, orgId: OrgId, slot: BindingSlot): Promise<{ alias: string; sourceId: string }> {
  const routing = routingOf(dependencies, true);
  if (routing === undefined) throw agentXError("MODEL_NOT_ALLOWED", NO_MODEL);
  const model: ModelIdentifier = { provider: slot.model.provider, modelId: slot.model.modelId };
  const project = (await requireWorkspace(dependencies, operation.workspaceId)).projectName;
  if (forbiddenModelMatcher((await readGuardrails(dependencies, orgId)).forbiddenModels)(model)) throw agentXError("MODEL_NOT_ALLOWED", NO_MODEL);
  const wanted = canonicalModelName(model);
  if (!(await servableModels(routing, orgId, project)).some((offered) => canonicalModelName(offered) === wanted)) throw agentXError("MODEL_NOT_ALLOWED", NO_MODEL);
  // No payer is named: a person's ChatGPT plan has no alias and cannot carry a key, so it never serves a reviewer.
  const served = (await servingRoutes(routing, { orgId, project, model })).find((route) => route.alias !== undefined
    && (slot.modelRoute !== undefined ? route.alias === slot.modelRoute.alias : route.sourceId === "rovara" && route.alias === model.modelId));
  if (served?.alias === undefined) throw agentXError("MODEL_NOT_ALLOWED", NO_MODEL);
  // Rovara's catalog model with no list price: the proxy would not know what a call costs, so no budget could hold it.
  if (served.sourceId === "rovara" && listPricesPerMillion(model) === undefined) throw agentXError("MODEL_NOT_ALLOWED", NO_MODEL);
  return { alias: served.alias, sourceId: served.sourceId };
}

/** Everything model-access.ts needs to answer a design-review slot request. Reads are fresh (the review, the sources, the guardrails); nothing is cached between requests. */
export async function resolveSlotAsk(dependencies: AwsBrokerDependencies, operation: OperationRecord, slot: BindingSlot): Promise<SlotAsk> {
  const orgId = operation.orgId;
  if (orgId === undefined || dependencies.modelAccess === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy is not set up in this deployment");
  const binding = DesignReviewBindingSchema.parse(operation.designReview);
  const review = await reviewOf(dependencies, operation);
  const route = await routeOf(dependencies, operation, orgId, slot);
  const modelAccess = dependencies.modelAccess;
  const scope = { orgId, operationId: operation.id, slot: slot.keySlot };
  let previousKeyId: string | undefined;
  return {
    slot, route,
    reuse: async () => {
      const found = await readSlotKey(dependencies, dependencies.callbackSigningKey, scope, Date.now());
      previousKeyId = found.previousKeyId;
      return found.kept === undefined ? undefined : { apiKey: found.kept.key, expiresAt: found.kept.expiresAt };
    },
    mintInput: (input) => {
      const budgets = designReviewKeyBudgets({ capUsd: review.capUsd ?? 0, spentUsd: review.spentUsd, reviewers: binding.reviewers.length, hasMergeModel: binding.merge !== undefined });
      const budgetCeilingUsd = slot.purpose === "merge" ? budgets.mergeUsd : budgets.reviewerUsd;
      if (!(budgetCeilingUsd > 0)) throw agentXError("BUDGET_EXCEEDED", NO_ROOM);
      // The other slots' keys are live at the same time and must not be given back: this key competes with their holds, and records without a count (concurrent slots all append).
      return { ttlSeconds: DESIGN_REVIEW_KEY_TTL_SECONDS, keepEarlierKeys: true, budgetCeilingUsd, ...(input.recordOn === undefined ? {} : { recordOn: input.recordOn.map(({ key }) => ({ key })) }) };
    },
    keep: async (minted) => {
      const stored = await putSlotKey(dependencies, dependencies.callbackSigningKey, {
        ...scope, purpose: slot.purpose, key: minted.key, keyId: minted.keyId, expiresAt: minted.expiresAt, budgetUsd: minted.maxBudgetUsd, alias: route.alias, nowMs: Date.now(), previousKeyId,
      });
      if (stored) return { apiKey: minted.key, expiresAt: minted.expiresAt };
      // Another request kept a key for this slot first: give this one back, and answer with the stored one.
      await modelAccess.access.blockKey(keyIdOf(minted.key)).catch(() => modelAccess.access.revokeKey(minted.key).catch(() => undefined));
      const ledger = ledgerOf(dependencies);
      if (ledger !== undefined) await finalizeKey(ledger, orgId, keyIdOf(minted.key)).catch(() => undefined);
      const found = await readSlotKey(dependencies, dependencies.callbackSigningKey, scope, Date.now());
      if (found.kept === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not issue a key");
      return { apiKey: found.kept.key, expiresAt: found.kept.expiresAt };
    },
  };
}
