// Learning v2 production wiring (lessons-in-production lane 1): the model the learning pipeline calls (`PipelineModel`: the reflector, the curator's judge), on the COMPANY's own AI provider.
//
// The company pays (owner decision 2026-11-03, the same rule as Fix with agent): the route is chosen among the sources billed to the company (`chooseLearningRoute`: its own sources, or Rovara's metered
// built-in AI that is billed to the company), never a person's ChatGPT plan, never a model the company forbids (read now, with the reader schema). The model is the company's CHEAPEST suitable one (lane 1b:
// not its main assistant model), or the "lessons model" an admin set. With no usable provider the call THROWS a `LearningRefusal` with a fixed code (the reflector records it as the project's "lessons paused"
// reason). There is NO Rovara-paid route anywhere in this file: no support key, no fallback model, no default.
//
// The hold is SIZED to the call (lane 1b): the chosen model's list price x the prompt's worst-case token count (non-Latin text counts a token per byte, ASCII three characters per token) + `maxOutputTokens` x the
// output price. A model with no list price holds the caller's budget (or the default). Only the company's budgets, the Public $20 month or the protocol's ceiling can refuse it.
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
import { OrgIdSchema, ROVARA_CODE_AGENT_ID, forbiddenModelMatcher, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { readGuardrails } from "../../agents/guardrails.js";
import { LearningRefusal } from "../../lessons/pause.js";
import type { Edition } from "../../lessons/policy.js";
import type { PipelineModel } from "../../lessons/ports.js";
import { chooseLearningRoute, learningWorstCaseUsd } from "../../model-sources/diagnosis-provider.js";
import type { RoutingDependencies } from "../../model-sources/routing.js";
import { admitWork, mintOperationKey } from "../../spend/admission.js";
import { ScopeFullError, blockOperationKeys } from "../../spend/ledger.js";
import { ROVARA_SOURCE_ID, budgetScopesFor } from "../../spend/payer.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { cleanUsd } from "../../spend/top-ups.js";
import { LEARNING_AGENT_ID, LEARNING_COUNTER, learningMonthlyCapUsd } from "./learning-spend.js";
import { routingOf } from "./scope-helpers.js";
import { ledgerOf } from "./sweeps-and-readiness.js";

/** What a call on a model with NO list price holds when the caller names no budget (the key's cap); a reflection is a few thousand tokens in and out. A model with a list price is sized from its price instead. */
export const LEARNING_CALL_BUDGET_USD = 0.25;
/** No call may hold more than this, whatever a caller asks or a model costs (the protocol's own ceiling for a learning key). */
export const LEARNING_MAX_CALL_BUDGET_USD = 5;
/** What the pipeline's callers are told: fixed words, never the provider's or the proxy's. */
export const LEARNING_NO_PROVIDER = "learning has no usable AI provider for this project";
export const LEARNING_NO_BUDGET = "learning has no budget left";
export const LEARNING_MONTH_FULL = "learning's monthly limit is used up";
export const LEARNING_TOO_DEAR = "the model's price could take a call past what learning holds for it";
export const LEARNING_ALL_FORBIDDEN = "every model learning could use is forbidden";
export const LEARNING_NO_SUITABLE_MODEL = "no available model can take this learning call";
/** A learning key lives for at most five minutes (the call itself is bounded to 100 s). */
export const LEARNING_KEY_TTL_SECONDS = 300;
/** ASCII text (prose, code, JSON) runs shorter than three characters per token only in odd cases, so three characters a token is the bound for it. Anything else counts one token per UTF-8 byte, the most any tokenizer can make of it (R7: CJK is about a token a character). */
const ASCII_CHARS_PER_TOKEN = 3;
/** The role markers and framing a provider adds around a prompt. */
const FRAMING_TOKENS = 256;
const LEARNING_AGENT_NAME = "Learning";

/** The most tokens a text can be: ASCII at three characters a token, every other byte a token of its own. */
export function worstCaseTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const byte of Buffer.from(text, "utf8")) { if (byte < 0x80) ascii += 1; else other += 1; }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + other;
}

export interface CustomerLearningModelOptions {
  /** Replaces the broker's routing (tests). */
  routing?: (dependencies: AwsBrokerDependencies) => RoutingDependencies | undefined;
  /** Replaces the call's budget when the caller names none. */
  budgetUsd?: number;
  /** The install's edition: Public holds every key's cap on the company's $20 learning month; Enterprise has no learning cap of its own. Default Public (the safe side). */
  edition?: Edition;
  /** Replaces the Public monthly cap (tests). */
  monthlyCapUsd?: number;
  /** The company's "lessons model" (optional setting; `lessons/model-setting.ts`). Absent, or returning undefined: the cheapest suitable model. A read that throws is read as unset. */
  lessonsModel?: (orgId: OrgId) => Promise<ModelIdentifier | undefined>;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

const BUDGET_CODE = /BUDGET|TRIAL|MACHINE_TIME|LIMIT/u;
/** A refusal of the company's own budgets (the org's, the project's, the trial) is a learning pause with its own code; anything else (the proxy down, a bug) is the caller's plain failure. */
const asBudgetRefusal = (error: unknown): LearningRefusal | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "MODEL_PROXY_UNAVAILABLE" && BUDGET_CODE.test(code) ? new LearningRefusal("no_budget", LEARNING_NO_BUDGET, { cause: error }) : undefined;
};

type CompleteRequest = Parameters<PipelineModel["complete"]>[0];

export function customerLearningModel(dependencies: AwsBrokerDependencies, options: CustomerLearningModelOptions = {}): PipelineModel {
  const log = options.log ?? ((event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields })));
  const admissionOf = (modelAccess: NonNullable<AwsBrokerDependencies["modelAccess"]>) =>
    ({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true });

  /** The model, the route and the hold of one call, or a `LearningRefusal` (nothing is made, nothing is held). */
  async function plan(request: CompleteRequest) {
    const org = OrgIdSchema.safeParse(request.workspaceId);
    if (!org.success || request.project === undefined || request.project === "") throw new Error("learning needs a company and a project");
    const orgId: OrgId = org.data, project = request.project;
    // The company's forbidden models, read now: an unreadable document refuses (fail closed) rather than choosing among models without the list.
    const forbidden = forbiddenModelMatcher((await readGuardrails({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, orgId)).forbiddenModels);
    const routing = (options.routing ?? ((deps) => routingOf(deps, true)))(dependencies);
    if (routing === undefined) throw new LearningRefusal("no_provider", LEARNING_NO_PROVIDER);
    const preferred = options.lessonsModel === undefined ? undefined : await options.lessonsModel(orgId).catch(() => undefined);
    const shape = { inputTokens: worstCaseTokens(request.system) + worstCaseTokens(request.user) + FRAMING_TOKENS, maxOutputTokens: request.maxOutputTokens };
    const chosen = await chooseLearningRoute(routing, orgId, project, forbidden, shape, preferred);
    if ("none" in chosen) {
      throw new LearningRefusal(chosen.none, chosen.none === "all_models_forbidden" ? LEARNING_ALL_FORBIDDEN : chosen.none === "no_suitable_model" ? LEARNING_NO_SUITABLE_MODEL : LEARNING_NO_PROVIDER);
    }
    if (chosen.route.api === undefined) throw new LearningRefusal("no_provider", LEARNING_NO_PROVIDER);
    // The hold is the call's own worst case on the model's list price. A caller's budget is a ceiling on it. A model with no list price holds the caller's budget (or the default): its key's cap is the only bound.
    const worst = learningWorstCaseUsd(chosen.model, shape);
    if (worst !== undefined && request.budgetUsd !== undefined && worst > request.budgetUsd) throw new LearningRefusal("cost_too_high", LEARNING_TOO_DEAR);
    const hold = worst === undefined ? Math.min(request.budgetUsd ?? options.budgetUsd ?? LEARNING_CALL_BUDGET_USD, LEARNING_MAX_CALL_BUDGET_USD) : Math.max(Math.ceil(worst * 1e6) / 1e6, 0.001);
    if (hold > LEARNING_MAX_CALL_BUDGET_USD) throw new LearningRefusal("cost_too_high", LEARNING_TOO_DEAR);
    if (!(hold >= 0.001)) throw new LearningRefusal("no_budget", LEARNING_NO_BUDGET);
    return { orgId, project, chosen: { model: chosen.model, alias: chosen.route.alias, sourceId: chosen.route.sourceId, api: chosen.route.api }, hold: cleanUsd(hold) };
  }

  /** The company's existing budgets, like any chat turn of the project: nothing left refuses, before any key exists. */
  async function admit(modelAccess: NonNullable<AwsBrokerDependencies["modelAccess"]>, planned: Awaited<ReturnType<typeof plan>>): Promise<void> {
    try {
      const admitted = await admitWork(admissionOf(modelAccess), { orgId: planned.orgId, payer: { kind: "project", project: planned.project }, project: planned.project, agentId: ROVARA_CODE_AGENT_ID, agentName: LEARNING_AGENT_NAME, path: "CHAT" });
      if (admitted.maxBudgetUsd < planned.hold) throw new LearningRefusal("no_budget", LEARNING_NO_BUDGET);
    } catch (error) {
      throw asBudgetRefusal(error) ?? error;
    }
  }

  return {
    async quote(request) {
      const modelAccess = dependencies.modelAccess;
      if (modelAccess === undefined || modelAccess.access.learningCompletion === undefined) return { ok: false, code: "no_provider" };
      try {
        const planned = await plan(request);
        await admit(modelAccess, planned);
        return { ok: true, usd: planned.hold };
      } catch (error) {
        if (error instanceof LearningRefusal) return { ok: false, code: error.code };
        throw error;
      }
    },
    async complete(request) {
      const modelAccess = dependencies.modelAccess;
      const completion = modelAccess?.access.learningCompletion?.bind(modelAccess.access);
      if (modelAccess === undefined || completion === undefined) throw new Error("learning has no model path in this install");
      // The ledger is the money's home: an install without one cannot hold a cap, so it makes no call (fail closed).
      const ledger = ledgerOf(dependencies);
      if (ledger === undefined) throw new Error("learning has no spend ledger in this install");
      const planned = await plan(request);
      const { orgId, project, chosen, hold } = planned;
      await admit(modelAccess, planned);

      const payer = { kind: "project", project } as const;
      const operationId = `learning-${randomUUID()}`;
      const monthlyCap = learningMonthlyCapUsd(options.edition ?? "public", options.monthlyCapUsd);
      let minted: Awaited<ReturnType<typeof mintOperationKey>>;
      try {
        minted = await mintOperationKey({ ...admissionOf(modelAccess), ledger }, {
          orgId, refId: operationId, ttlSeconds: LEARNING_KEY_TTL_SECONDS, agentName: LEARNING_AGENT_NAME,
          // The same scopes a chat turn of the project counts against (the org and the project), and the learning month beside them.
          scopes: budgetScopesFor(payer, { project }, { agentId: ROVARA_CODE_AGENT_ID }),
          holds: [{ counter: LEARNING_COUNTER, ...(monthlyCap === undefined ? {} : { limitUsd: monthlyCap }) }],
          tags: { agentId: LEARNING_AGENT_ID, project, payerKind: "project", payerId: project, source: ROVARA_SOURCE_ID, origin: "learning", operationId },
          route: { alias: chosen.alias, sourceId: chosen.sourceId },
          // The hold is sized to the call: the key is never capped above it (nor, when the budgets are short, above what they have left).
          runLimitUsd: hold, stopAtUsd: hold, budgetCeilingUsd: hold, taskKeyIds: [],
        });
      } catch (error) {
        if (error instanceof ScopeFullError && error.scope === LEARNING_COUNTER) throw new LearningRefusal("monthly_limit", LEARNING_MONTH_FULL, { cause: error });
        throw asBudgetRefusal(error) ?? error;
      }
      if (minted.outcome !== "minted") throw new Error("learning could not record its model key");
      try {
        // R3: a concurrent mint can leave the key capped below the hold (the worst-case check was made against the hold). The proxy checks a key's budget only before a request, so a call that could cost more than
        // the key holds must not be made: refuse it (the finally below blocks the key and the sweep releases its hold).
        if (minted.maxBudgetUsd + 1e-9 < hold) throw new LearningRefusal("no_budget", LEARNING_NO_BUDGET);
        const answer = await completion({
          key: minted.key, purpose: request.purpose, system: request.system, user: request.user, maxOutputTokens: request.maxOutputTokens,
          model: chosen.alias, api: chosen.api,
        });
        return { text: answer.text, costUsd: minted.maxBudgetUsd, model: answer.model };
      } finally {
        // Whatever the call did (an answer, an error, a timeout), the key is blocked now and its finalize clock starts; the sweep settles the proxy's own figure when it has flushed it. A block that fails
        // leaves the key to expire (five minutes) and to be finalized by the sweep's expiry backstop; its cap stays held until then.
        await blockOperationKeys(ledger, { orgId, operationId, keyIds: [minted.keyId] }).catch(() => log("learning.key_not_blocked", { orgId }));
      }
    },
  };
}
