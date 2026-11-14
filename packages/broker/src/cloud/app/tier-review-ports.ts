// S3-9: the lighter flow's reviewer ports (tier-review.ts `TierReviewPorts`) over the broker's own money and model machinery, the same pieces the broker's other customer-paid model call (learning,
// aws/broker/learning-model.ts) uses, applied to the TASK's payer instead of the project:
//   task   the payer the core task's start captured (TASK_PAYER, money.ts `cloudLevelSources`), held to this company;
//   route  a source billed to the company (`customerProviderRouting`: its own sources and Rovara's metered one, never a person's ChatGPT plan) that serves the model Code's checking rule chose, or, when it
//          chose none, the company's assistant model, then its dearest listed model (the strongest available); a model the company forbids is never used (its guardrails, read now: unreadable refuses);
//   room   `admitWork` for the payer, as a chat turn of the project (the trial, the machine time, every budget scope's room, so a used-up month refuses);
//   call   `mintOperationKey` (the key is capped at the call's hold and reserved on the payer's scopes, the company's and project's month among them, in one transaction: a full scope refuses), the one call
//          through the in-VPC function (`reviewCompletion`), then `blockOperationKeys` whatever happened, so the sweep settles the proxy's own figure and releases the rest. Nothing is ever charged at $0.
// There is no Rovara-paid route anywhere here: no support key, no fallback model, no default.
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ROVARA_CODE_AGENT_ID, canonicalModelName, forbiddenModelMatcher, type ModelIdentifier, type OrgId, type Payer } from "@rovara-code/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { readGuardrails } from "../../agents/guardrails.js";
import { customerProviderRouting } from "../../model-sources/diagnosis-provider.js";
import { effectiveSources, servableModels, servingRoutes, type RoutingDependencies } from "../../model-sources/routing.js";
import { admitWork, mintOperationKey } from "../../spend/admission.js";
import { blockOperationKeys, type LedgerDependencies } from "../../spend/ledger.js";
import { budgetScopesFor, keyMember, payerIdOf } from "../../spend/payer.js";
import type { ModelAccess } from "../../model-proxy/access.js";
import { taskPayerKey } from "./money.js";
import { TIER_REVIEW_OUTPUT_TOKENS, type TierReviewPorts, type TierReviewRoute } from "./tier-review.js";

/** A reviewer key lives for at most five minutes (Code's reviewer waits two). */
export const TIER_REVIEW_KEY_TTL_SECONDS = 300;
/** The origin the reviewer's spend is tagged with (the ledger's origin counter). */
export const TIER_REVIEW_ORIGIN = "tier_review";
const AGENT_NAME = "Rovara Code";

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
}

const listPrice = (model: ModelIdentifier): number => {
  const price = listPricesPerMillion(model);
  return price === undefined ? -1 : price.input + price.output;
};

/** The ports over the broker's machinery for one company. Every port that cannot answer throws or answers undefined (a refusal). */
export function cloudTierReviewPorts(deps: TierReviewPortDependencies): TierReviewPorts {
  const { companyId } = deps;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const admission = { ...table, access: deps.access, cloud: deps.cloud, ...(deps.now === undefined ? {} : { now: deps.now }) };
  const own = customerProviderRouting(deps.routing);

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
      // Code's checking rule chose no model (the install has no per-step rule): the company's assistant model, then the dearest listed model it can call (the strongest available).
      const effective = await effectiveSources(own, companyId, project);
      if (effective === undefined || effective.order.length === 0) return undefined;
      const served = (await servableModels(own, companyId, project)).filter((candidate) => !forbidden(candidate));
      const ranked = [...served].sort((left, right) => listPrice(right) - listPrice(left) || canonicalModelName(left).localeCompare(canonicalModelName(right)));
      const seen = new Set<string>();
      for (const candidate of [effective.stored.assistantModel, ...ranked]) {
        if (candidate === undefined || forbidden(candidate)) continue;
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

    async call({ taskId, project, payer, route, holdUsd, prompt, purpose, signal }) {
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
        const answer = await reviewCompletion({ key: minted.key, purpose, user: prompt, maxOutputTokens: TIER_REVIEW_OUTPUT_TOKENS, model: route.alias, api: route.api, signal });
        return answer.text;
      } finally {
        // Whatever the call did, the key is blocked now and its finalize clock starts; the sweep settles what the proxy counted and releases the rest. A block that fails leaves the key to expire.
        await blockOperationKeys(deps.ledger, { orgId: companyId, operationId, keyIds: [minted.keyId] }).catch(() => undefined);
      }
    },
  };
}
