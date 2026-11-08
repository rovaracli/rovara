// Learning v2 production wiring (lessons-in-production lane 1): the model the learning pipeline calls (`PipelineModel`: the reflector, the curator's judge), on the COMPANY's own AI provider.
//
// The company pays (owner decision 2026-11-03, the same rule as Fix with agent): the route is chosen among the sources billed to the company (`chooseDiagnosisRoute`: its own sources, or Rovara's metered
// built-in AI that is billed to the company), never a person's ChatGPT plan, never a model the company forbids (read now, with the reader schema). With no usable provider the call THROWS, the reflector
// answers `model_error` and nothing is made. There is NO Rovara-paid route anywhere in this file: no support key, no fallback model, no default.
//
// The money follows the product's ordinary key lifecycle (spend/ledger.ts), so it is booked where every other chat turn and task is, and is never read before the proxy has flushed it:
//   1. `admitWork` (the trial, the machine time, the room of the org's and the project's budgets) and the worst-case price check;
//   2. `mintOperationKey` mints a key for the one alias and RESERVES its cap (= the estimate, never more) on the org's and the project's counters AND on the company's learning month (`LEARNING`, Public: $20),
//      all in one transaction. Out of room anywhere refuses the call before it starts. The key has the source, the model and the origin tags, so the source, model and origin counters see its spend too;
//   3. the in-VPC ModelAccessFunction makes the one call with that key (it neither mints nor reads spend nor deletes);
//   4. the key is BLOCKED (not deleted) at once and its finalize clock starts (`blockOperationKeys`); the sweep settles its spend after `FINALIZE_DELAY_MS`, when the proxy has flushed it, and then releases what
//      it did not spend. A call that failed, timed out or whose broker died holds its whole cap until then (a key nobody blocked is finalized by the sweep ten minutes after it expired): nothing is ever charged at $0
//      for money that may have been spent, and nothing leaks a month's cap.
// `costUsd` of the answer is therefore an upper bound, the cap the key held.
import { randomUUID } from "node:crypto";
import { OrgIdSchema, ROVARA_CODE_AGENT_ID, forbiddenModelMatcher, type OrgId } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { readGuardrails } from "../../agents/guardrails.js";
import type { Edition } from "../../lessons/policy.js";
import type { PipelineModel } from "../../lessons/ports.js";
import { chooseDiagnosisRoute } from "../../model-sources/diagnosis-provider.js";
import type { RoutingDependencies } from "../../model-sources/routing.js";
import { admitWork, mintOperationKey } from "../../spend/admission.js";
import { ScopeFullError, blockOperationKeys } from "../../spend/ledger.js";
import { ROVARA_SOURCE_ID, budgetScopesFor } from "../../spend/payer.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { LEARNING_AGENT_ID, LEARNING_COUNTER, learningMonthlyCapUsd } from "./learning-spend.js";
import { routingOf } from "./scope-helpers.js";
import { ledgerOf } from "./sweeps-and-readiness.js";

/** The most one learning call may cost when the caller names no budget (the key's cap); a reflection is a few thousand tokens in and out. */
export const LEARNING_CALL_BUDGET_USD = 0.25;
/** No call may hold more than this, whatever a caller asks. */
export const LEARNING_MAX_CALL_BUDGET_USD = 0.5;
/** What the pipeline's callers are told: fixed words, never the provider's or the proxy's. */
export const LEARNING_NO_PROVIDER = "learning has no usable AI provider for this project";
export const LEARNING_NO_BUDGET = "learning has no budget left";
export const LEARNING_MONTH_FULL = "learning's monthly limit is used up";
export const LEARNING_TOO_DEAR = "the model's price could take a call past what learning holds for it";
/** A learning key lives for at most five minutes (the call itself is bounded to 100 s). */
export const LEARNING_KEY_TTL_SECONDS = 300;
/** A token is taken as this many characters when the worst-case price of a call is worked out (code and JSON run shorter than prose, so the guess leans to more tokens). */
const CHARS_PER_TOKEN = 3;
const LEARNING_AGENT_NAME = "Learning";

export interface CustomerLearningModelOptions {
  /** Replaces the broker's routing (tests). */
  routing?: (dependencies: AwsBrokerDependencies) => RoutingDependencies | undefined;
  /** Replaces the call's budget when the caller names none. */
  budgetUsd?: number;
  /** The install's edition: Public holds every key's cap on the company's $20 learning month; Enterprise has no learning cap of its own. Default Public (the safe side). */
  edition?: Edition;
  /** Replaces the Public monthly cap (tests). */
  monthlyCapUsd?: number;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** What the call could cost at most on a model whose list price is known: every character of the prompt as input and every allowed output token. Undefined for a model with no list price (a company's own source). */
function worstCaseUsd(model: Parameters<typeof listPricesPerMillion>[0], request: { system: string; user: string; maxOutputTokens: number }): number | undefined {
  const price = listPricesPerMillion(model);
  if (price === undefined) return undefined;
  const inputTokens = Math.ceil((request.system.length + request.user.length) / CHARS_PER_TOKEN);
  return (inputTokens * price.input + request.maxOutputTokens * price.output) / 1_000_000;
}

export function customerLearningModel(dependencies: AwsBrokerDependencies, options: CustomerLearningModelOptions = {}): PipelineModel {
  const log = options.log ?? ((event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields })));
  return {
    async complete(request) {
      const modelAccess = dependencies.modelAccess;
      const completion = modelAccess?.access.learningCompletion?.bind(modelAccess.access);
      if (modelAccess === undefined || completion === undefined) throw new Error("learning has no model path in this install");
      const org = OrgIdSchema.safeParse(request.workspaceId);
      if (!org.success || request.project === undefined || request.project === "") throw new Error("learning needs a company and a project");
      const orgId: OrgId = org.data, project = request.project;
      // The ledger is the money's home: an install without one cannot hold a cap, so it makes no call (fail closed).
      const ledger = ledgerOf(dependencies);
      if (ledger === undefined) throw new Error("learning has no spend ledger in this install");
      const estimate = Math.min(request.budgetUsd ?? options.budgetUsd ?? LEARNING_CALL_BUDGET_USD, LEARNING_MAX_CALL_BUDGET_USD);
      if (!(estimate >= 0.001)) throw new Error(LEARNING_NO_BUDGET);
      // The company's forbidden models, read now: an unreadable document refuses (fail closed) rather than choosing among models without the list.
      const forbidden = forbiddenModelMatcher((await readGuardrails({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, orgId)).forbiddenModels);
      const routing = (options.routing ?? ((deps) => routingOf(deps, true)))(dependencies);
      const chosen = routing === undefined ? undefined : await chooseDiagnosisRoute(routing, orgId, project, forbidden, []);
      if (chosen === undefined || chosen.route.api === undefined) throw new Error(LEARNING_NO_PROVIDER);
      // One call must not be able to cost more than the key holds for it, on a model whose price is known (the key's cap is checked before a request, not during it).
      const worst = worstCaseUsd(chosen.model, request);
      if (worst !== undefined && worst > estimate) throw new Error(LEARNING_TOO_DEAR);
      // The company's existing budgets, like any chat turn of the project: nothing left refuses, before any key exists.
      const payer = { kind: "project", project } as const;
      const admission = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true };
      const admitted = await admitWork(admission, { orgId, payer, project, agentId: ROVARA_CODE_AGENT_ID, agentName: LEARNING_AGENT_NAME, path: "CHAT" });
      if (admitted.maxBudgetUsd < estimate) throw new Error(LEARNING_NO_BUDGET);

      const operationId = `learning-${randomUUID()}`;
      const monthlyCap = learningMonthlyCapUsd(options.edition ?? "public", options.monthlyCapUsd);
      let minted: Awaited<ReturnType<typeof mintOperationKey>>;
      try {
        minted = await mintOperationKey({ ...admission, ledger }, {
          orgId, refId: operationId, ttlSeconds: LEARNING_KEY_TTL_SECONDS, agentName: LEARNING_AGENT_NAME,
          // The same scopes a chat turn of the project counts against (the org and the project), and the learning month beside them.
          scopes: budgetScopesFor(payer, { project }, { agentId: ROVARA_CODE_AGENT_ID }),
          holds: [{ counter: LEARNING_COUNTER, ...(monthlyCap === undefined ? {} : { limitUsd: monthlyCap }) }],
          tags: { agentId: LEARNING_AGENT_ID, project, payerKind: "project", payerId: project, source: ROVARA_SOURCE_ID, origin: "learning", operationId },
          route: { alias: chosen.route.alias, sourceId: chosen.route.sourceId },
          // The hold is the estimate: the key is never capped above it (nor, when the budgets are short, above what they have left).
          runLimitUsd: estimate, stopAtUsd: estimate, budgetCeilingUsd: estimate, taskKeyIds: [],
        });
      } catch (error) {
        if (error instanceof ScopeFullError && error.scope === LEARNING_COUNTER) throw new Error(LEARNING_MONTH_FULL);
        throw error;
      }
      if (minted.outcome !== "minted") throw new Error("learning could not record its model key");
      try {
        const answer = await completion({
          key: minted.key, purpose: request.purpose, system: request.system, user: request.user, maxOutputTokens: request.maxOutputTokens,
          model: chosen.route.alias, api: chosen.route.api,
        });
        return { text: answer.text, costUsd: minted.maxBudgetUsd, model: answer.model };
      } finally {
        // Whatever the call did (an answer, an error, a timeout), the key is blocked now and its finalize clock starts; the sweep settles the proxy's own figure when it has flushed it. A block that fails
        // leaves the key to expire (five minutes) and to be finalized by the sweep's expiry backstop; its cap stays held until then.
        await blockOperationKeys({ ...ledger }, { orgId, operationId, keyIds: [minted.keyId] }).catch(() => log("learning.key_not_blocked", { orgId }));
      }
    },
  };
}
