// Part of the broker, DR7 slice A: what `GET /v1/internal/model-access?slot=` does differently for a design-review operation (model-access.ts calls into this; an operation WITHOUT a stored binding never does).
//
// A design-review operation has no model key of its own. Every request must name a slot of the binding the broker stored, and gets the key minted for that (operation, slot) alone (security S6 to S9, N4):
//   - the slot is looked up in the stored binding (reviewers, and the merge step when it is a model); a request with no slot, or an unknown one, is refused, and nothing falls back to the operation's key;
//   - the key may call only that slot's resolved model: the model must still be offered (the usable-models resolution), not forbidden by the company, and served by a source with an alias for it, which must be the
//     alias the binding names. A person's ChatGPT plan has no alias and gets no key. A metered-catalog model with no list price gets none either (the proxy could not hold its spend to a budget);
//   - it spends from the same payer as the task's other keys (the customer: the key is minted by the ordinary task path in model-access.ts, so its tags, scopes and budgets are the task's; the metered catalog is the
//     customer's provider like any other, billed to the company or project, never to Rovara) and from the task and project budgets. Its own budget is the CEILING allocated to the slot at dispatch
//     (`allocateSlotBudgets`, one conditional write whose sum is held under the review's room and the task's remaining run limit); a slot with no allocation gets no key;
//   - it is ONE-SHOT: a slot's key is minted once, with a life past the whole stage, and a second request for the slot is refused (the slot fails closed). No key secret is stored anywhere.
import { AgentXError, DesignReviewBindingSchema, agentXError, designReviewActive, canonicalModelName, forbiddenModelMatcher, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { readGuardrails } from "../../agents/guardrails.js";
import { finalizeKey } from "../../spend/ledger.js";
import { servableModels, servingRoutes } from "../../model-sources/routing.js";
import { ProcessModelRefusal } from "../../model-selection/process-refusal.js";
import { SLOT_PATTERN } from "../../design-review/packet-store.js";
import { DESIGN_REVIEW_KEY_TTL_SECONDS, bindingSlotOf, putSlotKey, readSlotCeiling, recordSlotReask, slotKeyRowExists, type BindingSlot } from "../../design-review/slot-keys.js";
import { getItem, type OperationRecord } from "../cancellation.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import type { MintOperationKeyInput } from "../../spend/admission.js";
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

/**
 * DR-KEY-1: one line for a design-review operation's key request that was refused, whatever refused it (the slot lookup, the slot's checks, or the ordinary checks of model-access.ts): the operation, the
 * slot asked for (`none` when no slot was named, `invalid` when the name is not a slot's shape: a client's text is never repeated) and the refusal's fixed code. No person's id and no key material.
 */
export function logSlotKeyRefused(operationId: string, path: string, error: unknown): void {
  let asked: string | null;
  try { asked = new URL(path, "https://agentx.invalid").searchParams.get("slot"); } catch { asked = ""; }
  const slot = asked === null ? "none" : SLOT_PATTERN.test(asked) ? asked : "invalid";
  const code = error instanceof AgentXError || error instanceof ProcessModelRefusal ? error.code : "UNEXPECTED";
  console.log(JSON.stringify({ component: "broker", event: "design_review.slot_key_refused", operationId, slot, code, ...(code === "UNEXPECTED" ? { errorName: error instanceof Error ? error.name : "unknown" } : {}) }));
}

/** Whether an error is this module's fixed refusal (model-access.ts lets it through unchanged instead of answering that the proxy failed). */
const refusals = new WeakSet<object>();
export const isSlotRefusal = (error: unknown): boolean => error instanceof AgentXError && refusals.has(error);
const refusal = () => { const error = agentXError("FORBIDDEN", SLOT_REFUSED); refusals.add(error); return error; };

/** What the mint of one slot's key is given, and how the key just minted is kept. */
export interface SlotAsk {
  slot: BindingSlot;
  /** The route the key is scoped to: the proxy alias of the slot's model, and the source that serves it. */
  route: { alias: string; sourceId: string };
  /** One-shot: throws the fixed refusal when the slot already has a key. The re-ask is recorded and the slot's key is blocked, so the slot fails closed. */
  claim(): Promise<void>;
  /** The changes to the ordinary mint input for this slot (its ceiling, life and recording). Throws when the slot has no allocated ceiling. */
  mintInput(scope: Pick<MintOperationKeyInput, "recordOn">): Promise<Pick<MintOperationKeyInput, "ttlSeconds" | "keepEarlierKeys" | "recordOn" | "budgetCeilingUsd">>;
  /** Records the key just minted (its id and facts, never the key) and answers with it. When another request recorded a key for the slot first, this one is blocked and released at once, never returned, and the fixed refusal is thrown. */
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
  // A metered-catalog model with no list price: the proxy would not know what a call costs, so no budget could hold it.
  if (served.sourceId === "rovara" && listPricesPerMillion(model) === undefined) throw agentXError("MODEL_NOT_ALLOWED", NO_MODEL);
  return { alias: served.alias, sourceId: served.sourceId };
}

/** Everything model-access.ts needs to answer a design-review slot request. Reads are fresh (the review, the sources, the guardrails); nothing is cached between requests. */
export async function resolveSlotAsk(dependencies: AwsBrokerDependencies, operation: OperationRecord, slot: BindingSlot): Promise<SlotAsk> {
  const orgId = operation.orgId;
  if (orgId === undefined || dependencies.modelAccess === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy is not set up in this deployment");
  const binding = DesignReviewBindingSchema.parse(operation.designReview);
  await reviewOf(dependencies, operation);
  const route = await routeOf(dependencies, operation, orgId, slot);
  const modelAccess = dependencies.modelAccess;
  const scope = { orgId, operationId: operation.id, slot: slot.keySlot };
  /** Blocks a key at the proxy now (revoking it when the proxy cannot block by id) and releases its hold. Never throws: what cannot be closed here expires with the key. */
  const close = async (key: { key?: string; keyId: string }): Promise<void> => {
    await modelAccess.access.blockKey(key.keyId).catch(() => (key.key === undefined ? undefined : modelAccess.access.revokeKey(key.key).catch(() => undefined)));
    const ledger = ledgerOf(dependencies);
    if (ledger !== undefined) await finalizeKey(ledger, orgId, key.keyId).catch(() => undefined);
  };
  /** A slot asked for a key again: recorded on its row, its key blocked, and the fixed refusal. */
  const reask = async (): Promise<never> => {
    const keyId = await recordSlotReask(dependencies, scope, Date.now());
    console.log(JSON.stringify({ component: "broker", event: "design_review.slot_key_asked_again", operationId: operation.id, slot: slot.keySlot }));
    if (keyId !== undefined) await close({ keyId });
    throw refusal();
  };
  return {
    slot, route,
    claim: async () => { if (await slotKeyRowExists(dependencies, scope)) await reask(); },
    mintInput: async (input) => {
      const ceiling = await readSlotCeiling(dependencies, scope);
      if (ceiling === undefined || !(ceiling > 0)) throw agentXError("BUDGET_EXCEEDED", NO_ROOM);
      // The other slots' keys are live at the same time and must not be given back: this key competes with their holds, and records without a count (concurrent slots all append).
      return { ttlSeconds: DESIGN_REVIEW_KEY_TTL_SECONDS, keepEarlierKeys: true, budgetCeilingUsd: ceiling, ...(input.recordOn === undefined ? {} : { recordOn: input.recordOn.map(({ key }) => ({ key })) }) };
    },
    keep: async (minted) => {
      let stored: boolean;
      try {
        stored = await putSlotKey(dependencies, { ...scope, purpose: slot.purpose, round: binding.round, keyId: minted.keyId, expiresAt: minted.expiresAt, budgetUsd: minted.maxBudgetUsd, alias: route.alias, nowMs: Date.now() });
      } catch (error) {
        // The key could not be recorded: it was reserved and recorded on the task, and nobody will use it. Block it and release its hold (it is never handed out).
        await close({ key: minted.key, keyId: minted.keyId });
        throw error;
      }
      if (stored) return { apiKey: minted.key, expiresAt: minted.expiresAt };
      // Another request recorded a key for this slot first: this one is blocked and released at once and never returned, and the slot has been asked twice (it fails closed).
      await close({ key: minted.key, keyId: minted.keyId });
      return reask();
    },
  };
}
