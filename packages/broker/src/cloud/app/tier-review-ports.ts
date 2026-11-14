// S3-9: the lighter flow's reviewer ports (tier-review.ts `TierReviewPorts`) over the broker's own money and model machinery, the same pieces the broker's other customer-paid model call (learning,
// aws/broker/learning-model.ts) uses, applied to the TASK's payer instead of the project:
//   task   the payer the core task's start captured (TASK_PAYER, money.ts `cloudLevelSources`), held to this company;
//   route  a source billed to the company (`customerProviderRouting`: its own sources and Rovara's metered one, never a person's ChatGPT plan) that serves the model Code's checking rule chose, or, when it
//          chose none, the company's assistant model, then the CHEAPEST listed model with a list price whose largest call fits the per-call ceiling (review M4: the dearest could hold every change as
//          "couldn't check"); a model with no list price is never picked (M3), and a model the company forbids is never used (its guardrails, read now: unreadable refuses);
//   room   `admitWork` for the payer, as a chat turn of the project (the trial, the machine time, every budget scope's room, so a used-up month refuses);
//   call   `mintOperationKey` (the key is capped at the call's hold and reserved on the payer's scopes, the company's and project's month among them, in one transaction: a full scope refuses), the one call
//          through the in-VPC function (`reviewCompletion`), then `blockOperationKeys` whatever happened, so the sweep settles the proxy's own figure and releases the rest. Nothing is ever charged at $0.
//   calls  the durable row of each task's reviewer calls, one per purpose (`ORG#<company>#TIER_REVIEW_CALL#<task>`, `PURPOSE#<purpose>`): claimed before the key is minted, `sent` before the prompt is
//          forwarded, and its outcome after (review H1b). The claim's condition is `tierReviewCallBlocked`'s rule, so two passes cannot both claim.
// There is no Rovara-paid route anywhere here: no support key, no fallback model, no default.
import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, ROVARA_CODE_AGENT_ID, canonicalModelName, forbiddenModelMatcher, orgScoped, type ModelIdentifier, type OrgId, type Payer } from "@rovara-code/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { readGuardrails } from "../../agents/guardrails.js";
import { customerProviderRouting } from "../../model-sources/diagnosis-provider.js";
import { effectiveSources, servableModels, servingRoutes, type RoutingDependencies } from "../../model-sources/routing.js";
import { admitWork, mintOperationKey } from "../../spend/admission.js";
import { blockOperationKeys, type LedgerDependencies } from "../../spend/ledger.js";
import { budgetScopesFor, keyMember, payerIdOf } from "../../spend/payer.js";
import type { ModelAccess } from "../../model-proxy/access.js";
import { taskPayerKey } from "./money.js";
import { REVIEW_LIMITS } from "../../model-proxy/protocol.js";
import { TIER_REVIEW_IN_FLIGHT_MS, TIER_REVIEW_MAX_CALL_USD, TIER_REVIEW_MAX_FAILURES, TIER_REVIEW_OUTPUT_TOKENS, tierReviewBackoffMs, tierReviewHoldUsd, type TierReviewCallLedger, type TierReviewCallRow, type TierReviewPorts, type TierReviewPurpose, type TierReviewRoute } from "./tier-review.js";

/** A reviewer key lives for at most five minutes (Code's reviewer waits two). */
export const TIER_REVIEW_KEY_TTL_SECONDS = 300;
/** The origin the reviewer's spend is tagged with (the ledger's origin counter). */
export const TIER_REVIEW_ORIGIN = "tier_review";
const AGENT_NAME = "Rovara Code";
/**
 * Review M2: whether this install's lighter-flow reviewer may run: TIER_REVIEW_ENABLED (packed setting `tq`) is exactly "1". The infra sets it on the broker and on the CoreTierChecks function exactly where
 * it gives the model access function its long timeout (LEARNING_COMPLETION_ENABLED=1, with the Team record): `reviewCompletion` is refused without that timeout. (LEARNING_COMPLETION_ENABLED itself is set
 * only on the model access function, so it is not read here.) Off: the root gives no reviewer, so the lighter flow stays OFF (every core task runs its whole plan) instead of holding every small change.
 */
export function tierReviewLongCallsOn(env: NodeJS.ProcessEnv): boolean {
  return env[BROKER_SETTINGS.tierReview.variable] === "1";
}

/** A call's row is kept a day (the table's expiry attribute), far past the windows it decides. */
const CALL_ROW_TTL_SECONDS = 24 * 3600;

/** The durable row of one task's reviewer calls for one purpose, in the company's partition space. */
export const tierReviewCallKey = (companyId: OrgId, taskId: string, purpose: TierReviewPurpose): { pk: string; sk: string } => ({ pk: orgScoped(companyId, `TIER_REVIEW_CALL#${taskId}`), sk: `PURPOSE#${purpose}` });

export interface TierReviewPortDependencies {
  companyId: OrgId;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The broker's model access (the in-VPC function's invoker). Its `reviewCompletion` makes the call. */
  access: ModelAccess;
  /** The broker's routing over the company's sources (`routingOf(dependencies, true)`). */
  routing: RoutingDependencies;
  /** The spend ledger (`ledgerOf`): the key's cap is held there. */
  ledger: LedgerDependencies;
  /** A cloud install (the trial and machine-time limits apply). */
  cloud: boolean;
  now?: () => number;
  /** Where a failure that leaves money held is told (a key that could not be blocked). Ids and names only, never a key. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** A model's list price per million tokens (input plus output), or undefined when it has none. */
const listPrice = (model: ModelIdentifier): number | undefined => {
  const price = listPricesPerMillion(model);
  return price === undefined ? undefined : price.input + price.output;
};

/** The durable call rows over the State table (`TierReviewCallLedger`). */
export function tierReviewCallLedger(deps: { companyId: OrgId; documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }): TierReviewCallLedger {
  const { companyId, documentClient, tableName } = deps;
  const conditionFailed = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";
  return {
    async last({ taskId, purpose }) {
      const item = ((await documentClient.send(new GetCommand({ TableName: tableName, Key: tierReviewCallKey(companyId, taskId, purpose), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
      if (item === undefined) return undefined;
      // A row that is not this company's or not in shape is read as a call in flight (it blocks): never as free.
      const status = item["status"];
      const startedAt = item["startedAt"];
      const failures = item["failures"];
      if (item["orgId"] !== companyId || typeof item["callId"] !== "string" || typeof startedAt !== "number" || !["started", "sent", "answered", "failed_unsent", "failed_sent"].includes(String(status))
        || (failures !== undefined && !(typeof failures === "number" && Number.isInteger(failures) && failures >= 0))) {
        return { callId: "unknown", status: "started", startedAt: Number.MAX_SAFE_INTEGER };
      }
      return { callId: item["callId"], status: status as TierReviewCallRow["status"], startedAt, ...(typeof item["endedAt"] === "number" ? { endedAt: item["endedAt"] } : {}), ...(typeof failures === "number" ? { failures } : {}) };
    },
    async claim({ taskId, purpose, callId, at }) {
      // `tierReviewCallBlocked`'s rule as the write's condition, built from the same constants: no row; an answered outcome; otherwise (a count under the cap) a call that failed unsent, one that failed after it was sent
      // and has waited its backoff for that count, or a claim older than the window. The row's failure count is KEPT by the claim (an update, never a replace); only an answered outcome resets it.
      const failedSent: string[] = [];
      const values: Record<string, unknown> = { ":answered": "answered", ":unsent": "failed_unsent", ":failedSent": "failed_sent", ":started": "started", ":sent": "sent", ":max": TIER_REVIEW_MAX_FAILURES, ":zero": 0, ":inFlightBefore": at - TIER_REVIEW_IN_FLIGHT_MS + 1 };
      for (let count = 1; count < TIER_REVIEW_MAX_FAILURES; count += 1) {
        values[`:count${count}`] = count;
        values[`:before${count}`] = at - tierReviewBackoffMs(count) + 1;
        // A failed row with no counter (or 0) counts as one failure, as `tierReviewFailuresOf` reads it.
        const counted = count === 1 ? `(attribute_not_exists(#failures) OR #failures = :zero OR #failures = :count1)` : `#failures = :count${count}`;
        failedSent.push(`(#status = :failedSent AND ${counted} AND #endedAt < :before${count})`);
      }
      try {
        await documentClient.send(new UpdateCommand({
          TableName: tableName, Key: tierReviewCallKey(companyId, taskId, purpose),
          UpdateExpression: "SET #entityType = :entityType, #orgId = :orgId, #taskId = :taskId, #purpose = :purpose, #callId = :callId, #status = :started, #startedAt = :at, #expiry = :expiry, #failures = if_not_exists(#failures, :zero) REMOVE #endedAt, #sentAt",
          ConditionExpression: `attribute_not_exists(pk) OR #status = :answered OR ((attribute_not_exists(#failures) OR #failures < :max) AND (#status = :unsent OR ${failedSent.join(" OR ")} OR ((#status = :started OR #status = :sent) AND #startedAt < :inFlightBefore)))`,
          ExpressionAttributeNames: { "#status": "status", "#failures": "failures", "#endedAt": "endedAt", "#startedAt": "startedAt", "#sentAt": "sentAt", "#entityType": "entityType", "#orgId": "orgId", "#taskId": "taskId", "#purpose": "purpose", "#callId": "callId", "#expiry": INDEX_EXPIRY_ATTRIBUTE },
          ExpressionAttributeValues: { ...values, ":entityType": "TIER_REVIEW_CALL", ":orgId": companyId, ":taskId": taskId, ":purpose": purpose, ":callId": callId, ":at": at, ":expiry": Math.floor(at / 1000) + CALL_ROW_TTL_SECONDS },
        }));
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },
    async mark({ taskId, purpose, callId, status, at }) {
      await documentClient.send(new UpdateCommand({
        TableName: tableName, Key: tierReviewCallKey(companyId, taskId, purpose),
        // An answered outcome resets the row's failure count; a failure after the prompt was sent adds one (atomically, on this call's row only).
        UpdateExpression: status === "sent" ? "SET #status = :status, sentAt = :at"
          : status === "answered" ? "SET #status = :status, endedAt = :at, #failures = :zero"
          : status === "failed_sent" ? "SET #status = :status, endedAt = :at ADD #failures :one" : "SET #status = :status, endedAt = :at",
        // Only this call's row, and never back from an outcome: a late write of an older call cannot free or overwrite a newer one.
        ConditionExpression: "callId = :callId AND (#status = :started OR #status = :sent)",
        ExpressionAttributeNames: { "#status": "status", ...(status === "answered" || status === "failed_sent" ? { "#failures": "failures" } : {}) },
        ExpressionAttributeValues: { ":status": status, ":at": at, ":callId": callId, ":started": "started", ":sent": "sent", ...(status === "answered" ? { ":zero": 0 } : {}), ...(status === "failed_sent" ? { ":one": 1 } : {}) },
      }));
    },
  };
}

/** The ports over the broker's machinery for one company. Every port that cannot answer throws or answers undefined (a refusal). */
export function cloudTierReviewPorts(deps: TierReviewPortDependencies): TierReviewPorts {
  const { companyId } = deps;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const admission = { ...table, access: deps.access, cloud: deps.cloud, ...(deps.now === undefined ? {} : { now: deps.now }) };
  const own = customerProviderRouting(deps.routing);
  const log = deps.log ?? ((): void => undefined);

  async function routeFor(project: string, model: ModelIdentifier): Promise<TierReviewRoute | undefined> {
    if (own === undefined) return undefined;
    const route = (await servingRoutes(own, { orgId: companyId, project, model })).find((served) => served.alias !== undefined && served.api !== undefined);
    return route === undefined ? undefined : { model, alias: route.alias!, sourceId: route.sourceId, api: route.api! };
  }

  return {
    async task(taskId) {
      const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskPayerKey(taskId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
      const payer = item?.["payer"] as Payer | undefined;
      const project = item?.["project"];
      // Another company's row, or a row without a payer or a project, is no payer: nobody is charged by default.
      if (item === undefined || item["orgId"] !== companyId || typeof project !== "string" || project === "" || payer === undefined || payer === null || typeof payer !== "object" || typeof payer.kind !== "string") return undefined;
      return { project, payer };
    },

    async route({ project, model }) {
      if (own === undefined) return undefined;
      // The company's forbidden models, read now: an unreadable document throws (a refusal), never a choice made without the list.
      const forbidden = forbiddenModelMatcher((await readGuardrails(table, companyId)).forbiddenModels);
      if (model !== undefined) {
        const chosen = { provider: model.provider, modelId: model.modelId };
        return forbidden(chosen) ? undefined : await routeFor(project, chosen);
      }
      // Code's checking rule chose no model (the install has no per-step rule): the company's assistant model, then the CHEAPEST listed model with a list price whose largest call (the reviewer's whole
      // prompt limit) fits the per-call ceiling (M4: the dearest model could make every review "too dear" and hold every change). A model with no list price is never picked (M3: it cannot be held).
      const effective = await effectiveSources(own, companyId, project);
      if (effective === undefined || effective.order.length === 0) return undefined;
      const served = (await servableModels(own, companyId, project)).filter((candidate) => !forbidden(candidate));
      const fits = (candidate: ModelIdentifier): boolean => { const largest = tierReviewHoldUsd(candidate, REVIEW_LIMITS.userChars); return largest !== undefined && largest <= TIER_REVIEW_MAX_CALL_USD; };
      const ranked = served.filter(fits).sort((left, right) => listPrice(left)! - listPrice(right)! || canonicalModelName(left).localeCompare(canonicalModelName(right)));
      const seen = new Set<string>();
      for (const candidate of [effective.stored.assistantModel, ...ranked]) {
        if (candidate === undefined || forbidden(candidate) || listPrice(candidate) === undefined) continue;
        const name = canonicalModelName(candidate);
        if (seen.has(name)) continue;
        seen.add(name);
        const route = await routeFor(project, candidate);
        if (route !== undefined) return route;
      }
      return undefined;
    },

    async room({ project, payer }) {
      const admitted = await admitWork(admission, { orgId: companyId, payer, project, agentId: ROVARA_CODE_AGENT_ID, agentName: AGENT_NAME, path: "CHAT" });
      return admitted.maxBudgetUsd;
    },

    calls: tierReviewCallLedger({ companyId, documentClient: deps.documentClient, tableName: deps.tableName }),

    async call({ taskId, project, payer, route, holdUsd, prompt, purpose, signal, sent }) {
      const reviewCompletion = deps.access.reviewCompletion?.bind(deps.access);
      if (reviewCompletion === undefined) throw new Error("this install's model access makes no reviewer calls");
      const operationId = `tier-review-${randomUUID()}`;
      const minted = await mintOperationKey({ ...admission, ledger: deps.ledger }, {
        orgId: companyId, ...(keyMember(payer) === undefined ? {} : { developerId: keyMember(payer) }), refId: operationId, ttlSeconds: TIER_REVIEW_KEY_TTL_SECONDS, agentName: AGENT_NAME,
        // The scopes every spend of this task counts against (the company's month, the project's, and the member's for a member payer), so the call is charged where the task's own spend is.
        scopes: budgetScopesFor(payer, { project }, { agentId: ROVARA_CODE_AGENT_ID }),
        tags: { taskId, agentId: ROVARA_CODE_AGENT_ID, project, payerKind: payer.kind, payerId: payerIdOf(payer), source: route.sourceId, origin: TIER_REVIEW_ORIGIN, operationId },
        route: { alias: route.alias, sourceId: route.sourceId },
        // The key is never capped above the call's hold (nor, when the budgets are short, above what they have left).
        runLimitUsd: holdUsd, stopAtUsd: holdUsd, budgetCeilingUsd: holdUsd, taskKeyIds: [],
      });
      if (minted.outcome !== "minted") throw new Error("the reviewer's key could not be recorded");
      try {
        // A concurrent mint can leave the key capped below the hold; the proxy checks a key's budget only before a request, so a call that could cost more than the key holds is not made.
        if (minted.maxBudgetUsd + 1e-9 < holdUsd) throw new Error("the payer's budget cannot take the reviewer call");
        if (signal.aborted) throw new Error("the reviewer's time ran out before the call");
        // Recorded as sent before the prompt leaves (a fast-fail retry of a call that may have been billed is then refused); a record that cannot be written stops the call here, unsent.
        await sent();
        const answer = await reviewCompletion({ key: minted.key, purpose, user: prompt, maxOutputTokens: TIER_REVIEW_OUTPUT_TOKENS, model: route.alias, api: route.api, signal });
        return answer.text;
      } finally {
        // Whatever the call did, the key is blocked now and its finalize clock starts; the sweep settles what the proxy counted and releases the rest. A block that fails leaves the key to expire.
        await blockOperationKeys(deps.ledger, { orgId: companyId, operationId, keyIds: [minted.keyId] }).catch((error: unknown) => {
          log("tier_review.key_not_blocked", { taskId, operationId, keyId: minted.keyId, error: error instanceof Error ? error.name : "unknown" });
        });
      }
    },
  };
}
