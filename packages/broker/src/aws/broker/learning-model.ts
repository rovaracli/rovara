// Learning v2 production wiring (lessons-in-production lane 1): the model the learning pipeline calls (`PipelineModel`: the reflector, the curator's judge), on the COMPANY's own AI provider.
//
// The company pays (owner decision 2026-11-03, the same rule as Fix with agent): the route is chosen among the sources billed to the company (`chooseLearningRoute`: its own sources, or Rovara's metered
// built-in AI that is billed to the company), never a person's ChatGPT plan, never a model the company forbids (read now, with the reader schema). The model is the company's CHEAPEST suitable one (lane 1b:
// not its main assistant model), or the "lessons model" an admin set. With no usable provider the call THROWS a `LearningRefusal` with a fixed code (the reflector records it as the project's "lessons paused"
// reason). There is NO Rovara-paid route anywhere in this file: no support key, no fallback model, no default.
//
// The hold is SIZED to the call (lane 1b): the chosen model's list price x the prompt's worst-case token count (one token per UTF-8 byte, a true ceiling for any byte-level tokenizer) + `maxOutputTokens` x the
// output price, plus a margin (`LEARNING_HOLD_MARGIN`) for a proxy price that is not exactly the list price. A model with no list price holds the fixed default (never the caller's budget). Only the company's budgets, the Public $20 month or the protocol's ceiling can refuse it.
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
import { AgentXError, LESSONS_BROKER_MODEL_WAIT_SECONDS, OrgIdSchema, ROVARA_CODE_AGENT_ID, forbiddenModelMatcher, type ModelIdentifier, type OrgId } from "@agentx/contracts";
import { readGuardrails } from "../../agents/guardrails.js";
import { currentLearningAttempt, learningCallMayStart, noteLearningFault } from "../../lessons/learning-deadline.js";
import { gatedByLessonsSwitch } from "../../lessons/model-gate.js";
import { LearningRefusal } from "../../lessons/pause.js";
import type { Edition } from "../../lessons/policy.js";
import type { PipelineModel } from "../../lessons/ports.js";
import { LearningNotForwarded } from "../../model-proxy/access.js";
import { chooseLearningRoute, learningReasoningEffort, learningWorstCaseUsd } from "../../model-sources/diagnosis-provider.js";
import type { RoutingDependencies } from "../../model-sources/routing.js";
import { admitWork, mintOperationKey } from "../../spend/admission.js";
import { ScopeFullError, blockOperationKeys } from "../../spend/ledger.js";
import { ROVARA_SOURCE_ID, budgetScopesFor } from "../../spend/payer.js";
import type { LessonsHostDependencies } from "./definitions.js";
import { cleanUsd } from "../../spend/top-ups.js";
import { LEARNING_AGENT_ID, LEARNING_COUNTER, learningMonthlyCapUsd } from "./learning-spend.js";
import { routingOf } from "./scope-helpers.js";
import { ledgerOf } from "./sweeps-and-readiness.js";

/** What a call on a model with NO list price holds (the key's cap; the caller's budget never lowers it); a reflection is a few thousand tokens in and out. A model with a list price is sized from its price instead. */
export const LEARNING_CALL_BUDGET_USD = 0.25;
/** No call may hold more than this, whatever a caller asks or a model costs (the protocol's own ceiling for a learning key). */
export const LEARNING_MAX_CALL_BUDGET_USD = 5;
/** What the pipeline's callers are told: fixed words, never the provider's or the proxy's. */
export const LEARNING_NO_PROVIDER = "learning has no usable AI provider for this project";
export const LEARNING_NO_BUDGET = "learning has no budget left";
export const LEARNING_MONTH_FULL = "learning's monthly limit is used up";
export const LEARNING_DEADLINE = "the reflection ran out of time before this call could finish";
/** The longest the broker waits for the in-VPC function's one call (lane 1): what a call must be able to finish inside before the worker's deadline. */
export const LEARNING_BROKER_WAIT_MS = LESSONS_BROKER_MODEL_WAIT_SECONDS * 1000;
export const LEARNING_TOO_DEAR = "no available model costs little enough for what learning holds for one call";
export const LEARNING_ALL_FORBIDDEN = "every model learning could use is forbidden";
export const LEARNING_NO_SUITABLE_MODEL = "no available model can take this learning call";
/** A learning key lives for at most five minutes (the call itself is bounded to 100 s). */
export const LEARNING_KEY_TTL_SECONDS = 300;
/** The role markers and framing a provider adds around a prompt. */
const FRAMING_TOKENS = 256;
/** The hold is the worst case plus this much: the proxy's price for a route need not equal the catalog's list price, and the proxy checks a key's budget only before a request. */
export const LEARNING_HOLD_MARGIN = 1.25;
const LEARNING_AGENT_NAME = "Learning";

/** The most tokens a text can be: one per UTF-8 byte. Hex, base64, digit runs, dense JSON and CJK all stay at or under it; no byte-level tokenizer makes more tokens than bytes. */
export function worstCaseTokens(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface CustomerLearningModelOptions {
  /** Replaces the broker's routing (tests). */
  routing?: (dependencies: LessonsHostDependencies) => RoutingDependencies | undefined;
  /** Replaces the call's budget when the caller names none. */
  budgetUsd?: number;
  /** The install's edition: Public holds every key's cap on the company's $20 learning month; Enterprise has no learning cap of its own. Default Public (the safe side). */
  edition?: Edition;
  /** Replaces the Public monthly cap (tests). */
  monthlyCapUsd?: number;
  /** The company's "lessons model" (optional setting; `lessons/model-setting.ts`). Absent, or returning undefined: the cheapest suitable model. A read that throws is read as unset. */
  lessonsModel?: (orgId: OrgId) => Promise<ModelIdentifier | undefined>;
  log?: (event: string, fields: Record<string, string | number>) => void;
  /** Owner decision 47 (tests): whether the install's lessons switch is on. Default: the switch itself, failing closed. Off: every call is refused before anything is planned, held or sent. */
  lessonsSwitchOn?: () => boolean;
}

/** The codes `admitWork` and the mint refuse the company's own budgets with (the org's, the member's, the project's, the agent's, the chain's, the test allowance, the trial, the machine time). Exact codes only: a rate limit or any other code is a plain failure. */
const BUDGET_CODES: ReadonlySet<string> = new Set([
  "BUDGET_EXCEEDED", "ORG_BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "AGENT_BUDGET_REQUIRED", "CHAIN_BUDGET_EXCEEDED", "CHAIN_BUDGET_REQUIRED",
  "TEST_ALLOWANCE_USED", "TRIAL_LOCKED", "MACHINE_TIME_EXCEEDED",
]);
/** A refusal of the company's own budgets is a learning pause with its own code; anything else (the proxy down, a bug) is the caller's plain failure. */
const asBudgetRefusal = (error: unknown): LearningRefusal | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && BUDGET_CODES.has(code) ? new LearningRefusal("no_budget", LEARNING_NO_BUDGET, { cause: error }) : undefined;
};

type CompleteRequest = Parameters<PipelineModel["complete"]>[0];

/**
 * How a failure of the model path is read inside the worker (lane 2, H1; re-check R1, R3). ONE refusal class (`LearningRefusal`, final: the answer will not change, so it is never retried). The rule for everything else is
 * decided by whether the model call STARTED, never by dollars:
 *   - before the call starts (a read or a mint failed, the deadline left no room, the lease could not be marked) nothing was sent to the provider, so a plain fault or a 5xx is retryable and a 4xx is final;
 *   - once the call has started every failure is final (a timeout, our own abort, a non-200 answer, an answer with no text: the provider may have been reached and may still be working), except a
 *     `LearningNotForwarded` refusal, which the in-VPC client raises only before it sent anything, and which is retryable once the lease mark is taken back.
 * `keysOutcome` of the ledger stays as a second check (`reflect-claims.ts`).
 */
export function learningFaultOf(error: unknown, callStarted: boolean): "retryable" | "final" {
  if (error instanceof LearningRefusal) return "final";
  if (callStarted) return "final";
  if (error instanceof AgentXError) return error.statusCode >= 500 ? "retryable" : "final";
  return "retryable";
}

export function customerLearningModel(dependencies: LessonsHostDependencies, options: CustomerLearningModelOptions = {}): PipelineModel {
  return gatedByLessonsSwitch(rawCustomerLearningModel(dependencies, options), options.lessonsSwitchOn);
}

function rawCustomerLearningModel(dependencies: LessonsHostDependencies, options: CustomerLearningModelOptions): PipelineModel {
  const log = options.log ?? ((event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields })));
  const admissionOf = (modelAccess: NonNullable<LessonsHostDependencies["modelAccess"]>) =>
    ({
      documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true,
      // R2: inside the LessonsWorker (a running attempt) the budget-sync markers are written best-effort: its role has no grant on the budget settings partition and must not get one.
      ...(currentLearningAttempt() === undefined ? {} : { bestEffortMarkers: { log: (event: string, fields: Record<string, string>) => log(`learning.${event}`, fields) } }),
    });

  /** The model, the route and the hold of one call, or a `LearningRefusal` (nothing is made, nothing is held). */
  async function plan(request: CompleteRequest) {
    const org = OrgIdSchema.safeParse(request.workspaceId);
    if (!org.success || request.project === undefined || request.project === "") throw new LearningRefusal("no_provider", LEARNING_NO_PROVIDER);
    const orgId: OrgId = org.data, project = request.project;
    // The company's forbidden models, read now: an unreadable document refuses (fail closed) rather than choosing among models without the list.
    const forbidden = forbiddenModelMatcher((await readGuardrails({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, orgId)).forbiddenModels);
    const routing = (options.routing ?? ((deps) => routingOf(deps, true)))(dependencies);
    if (routing === undefined) throw new LearningRefusal("no_provider", LEARNING_NO_PROVIDER);
    const preferred = options.lessonsModel === undefined ? undefined : await options.lessonsModel(orgId).catch(() => undefined);
    const shape = { inputTokens: worstCaseTokens(request.system) + worstCaseTokens(request.user) + FRAMING_TOKENS, maxOutputTokens: request.maxOutputTokens };
    // What a call on a model holds: its worst case on the list price plus the margin. A model with no list price holds the FIXED figure (the default call budget), never the caller's budget: the caller's budget is the quote
    // made for another model, and sizing this one from it would let the quote and the call price different models (M1). The caller's budget is a ceiling on the hold, checked below for every model.
    const holdOf = (model: ModelIdentifier): number => {
      const worst = learningWorstCaseUsd(model, shape);
      return worst === undefined ? Math.min(options.budgetUsd ?? LEARNING_CALL_BUDGET_USD, LEARNING_MAX_CALL_BUDGET_USD) : Math.max(Math.ceil(worst * LEARNING_HOLD_MARGIN * 1e6) / 1e6, 0.001);
    };
    // LP-10 R4: the caller's per-call cap (Public's per-task cap) is passed to the choice, so a dear "lessons model" is skipped for the cheapest one that fits. Only when none fits is the call `cost_too_high`.
    const chosen = await chooseLearningRoute(routing, orgId, project, forbidden, shape, preferred, request.maxHoldUsd === undefined ? undefined : { usd: request.maxHoldUsd, holdOf });
    if ("none" in chosen) {
      throw new LearningRefusal(chosen.none, chosen.none === "all_models_forbidden" ? LEARNING_ALL_FORBIDDEN : chosen.none === "no_suitable_model" ? LEARNING_NO_SUITABLE_MODEL : chosen.none === "cost_too_high" ? LEARNING_TOO_DEAR : LEARNING_NO_PROVIDER);
    }
    if (chosen.route.api === undefined) throw new LearningRefusal("no_provider", LEARNING_NO_PROVIDER);
    // L2: the admin's "lessons model" costs more than one call may hold (Public's cap), so the cheapest that fits is used instead. Said in the log (the company only, no model name), never silently.
    if (chosen.preferredOverCap === true) log("learning.lessons_model_over_cap", { orgId, purpose: request.purpose });
    // The hold is the call's own worst case on the model's list price. A caller's budget is a ceiling on it. A model with no list price holds the fixed default: its key's cap is the only bound.
    const hold = holdOf(chosen.model);
    // The call's ceiling is what the quote approved: a model that would hold more than that (a different model from the one the quote priced) is refused, priced or not.
    if (request.budgetUsd !== undefined && hold > request.budgetUsd + 1e-9) throw new LearningRefusal("cost_too_high", LEARNING_TOO_DEAR);
    if (hold > LEARNING_MAX_CALL_BUDGET_USD) throw new LearningRefusal("cost_too_high", LEARNING_TOO_DEAR);
    if (!(hold >= 0.001)) throw new LearningRefusal("no_budget", LEARNING_NO_BUDGET);
    // A model that reasons by default is asked for the least reasoning its catalog entry allows (its thinkingLevelMap: the off value such as "none", else "minimal", else "low"), so the hidden reasoning cannot eat a
    // short answer budget. A model with no map is sent nothing (a guessed level may be refused). The Messages transport has no such field.
    const effortOf: ReturnType<typeof learningReasoningEffort> = chosen.route.api === "anthropic-messages" ? { fit: true } : learningReasoningEffort(chosen.model);
    if (!effortOf.fit) throw new LearningRefusal("no_suitable_model", LEARNING_NO_SUITABLE_MODEL);
    const effort = effortOf.fit ? effortOf.effort : undefined;
    return { orgId, project, chosen: { model: chosen.model, alias: chosen.route.alias, sourceId: chosen.route.sourceId, api: chosen.route.api, ...(effort === undefined ? {} : { reasoningEffort: effort }) }, hold: cleanUsd(hold) };
  }

  /** The company's existing budgets, like any chat turn of the project: nothing left refuses, before any key exists. */
  async function admit(modelAccess: NonNullable<LessonsHostDependencies["modelAccess"]>, planned: Awaited<ReturnType<typeof plan>>): Promise<void> {
    try {
      const admitted = await admitWork(admissionOf(modelAccess), { orgId: planned.orgId, payer: { kind: "project", project: planned.project }, project: planned.project, agentId: ROVARA_CODE_AGENT_ID, agentName: LEARNING_AGENT_NAME, path: "CHAT" });
      if (admitted.maxBudgetUsd < planned.hold) throw new LearningRefusal("no_budget", LEARNING_NO_BUDGET);
    } catch (error) {
      throw asBudgetRefusal(error) ?? error;
    }
  }

  async function completeOnce(request: CompleteRequest, state: { callStarted: boolean }): ReturnType<PipelineModel["complete"]> {
    const modelAccess = dependencies.modelAccess;
    const completion = modelAccess?.access.learningCompletion?.bind(modelAccess.access);
    // These are about this install, not this reflection: a refusal (final) with the code that says learning has nothing to run on here.
    if (modelAccess === undefined || completion === undefined) throw new LearningRefusal("no_provider", LEARNING_NO_PROVIDER);
    // Lane 2: inside the worker, a call that could still be running at the reflection's deadline is not started (nothing is reserved or charged).
    if (!learningCallMayStart(Date.now(), LEARNING_BROKER_WAIT_MS)) throw new Error(LEARNING_DEADLINE);
    // The ledger is the money's home: an install without one cannot hold a cap, so it makes no call (fail closed).
    const ledger = ledgerOf(dependencies);
    if (ledger === undefined) throw new LearningRefusal("no_provider", LEARNING_NO_PROVIDER);
    const planned = await plan(request);
    const { orgId, project, chosen, hold } = planned;
    await admit(modelAccess, planned);

    const payer = { kind: "project", project } as const;
    // H1: inside the worker the key is tagged with the attempt (its operation id carries the attempt's id) and noted on the reflection's lease, so a later worker can read from the ledger what this attempt spent.
    const attempt = currentLearningAttempt();
    const operationId = `learning-${attempt?.attemptId === undefined ? "" : `${attempt.attemptId}-`}${randomUUID()}`;
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
        ...(attempt?.leaseKey === undefined ? {} : { recordOn: [{ key: attempt.leaseKey }] }),
      });
    } catch (error) {
      if (error instanceof ScopeFullError) {
        // The learning month is the company's own limit; any other scope that fills between the admission and the mint (the org's or the project's budget) is a budget pause, not a provider failure.
        throw error.scope === LEARNING_COUNTER ? new LearningRefusal("monthly_limit", LEARNING_MONTH_FULL, { cause: error }) : new LearningRefusal("no_budget", LEARNING_NO_BUDGET, { cause: error });
      }
      throw asBudgetRefusal(error) ?? error;
    }
    if (minted.outcome !== "minted") throw new Error("learning could not record its model key");
    try {
      // R3 (lane 1b): a concurrent mint can leave the key capped below the hold (the worst-case check was made against the hold). The proxy checks a key's budget only before a request, so a call that could cost more than
      // the key holds must not be made: refuse it (the finally below blocks the key and the sweep releases its hold).
      if (minted.maxBudgetUsd + 1e-9 < hold) throw new LearningRefusal("no_budget", LEARNING_NO_BUDGET);
      // Re-check R4: the steps above (guardrails, routing, admission, the mint) can take seconds, so the time is looked at again right before the call. No room: nothing was sent, the key is blocked and spent nothing.
      if (!learningCallMayStart(Date.now(), LEARNING_BROKER_WAIT_MS)) throw new Error(LEARNING_DEADLINE);
      // Re-check R1: from here the call MAY reach the provider. The lease says so first (a conditional write on this attempt); a lease that cannot be marked means the call is not made. Once marked, `take` never
      // runs this reflection again, whatever the key's figure turns out to be, unless the in-VPC client says it sent nothing.
      await attempt?.callStarting?.();
      state.callStarted = true;
      let answer: Awaited<ReturnType<typeof completion>>;
      try {
        answer = await completion({
          key: minted.key, purpose: request.purpose, system: request.system, user: request.user, maxOutputTokens: request.maxOutputTokens,
          model: chosen.alias, api: chosen.api, ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }),
          ...(attempt?.signal === undefined ? {} : { signal: attempt.signal }),
        });
      } catch (error) {
        // The in-VPC client refused before it sent anything: the call is taken back (the lease's mark is removed) and the reflection may be tried again. A mark that cannot be removed leaves the call counted as made.
        if (error instanceof LearningNotForwarded && attempt?.callNotSent !== undefined) {
          try { await attempt.callNotSent(); state.callStarted = false; } catch { log("learning.call_mark_kept", { orgId }); }
        }
        throw error;
      }
      return { text: answer.text, costUsd: minted.maxBudgetUsd, model: answer.model };
    } finally {
      // Whatever the call did (an answer, an error, a timeout), the key is blocked now and its finalize clock starts; the sweep settles the proxy's own figure when it has flushed it. A block that fails
      // leaves the key to expire (five minutes) and to be finalized by the sweep's expiry backstop; its cap stays held until then.
      await blockOperationKeys(ledger, { orgId, operationId, keyIds: [minted.keyId] }).catch(() => log("learning.key_not_blocked", { orgId }));
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
        // R3: a quote makes no call and holds nothing, so a table or proxy fault here is typed like any fault before the call: retryable (a 4xx is final). Without this a quote fault read as final.
        noteLearningFault(learningFaultOf(error, false));
        throw error;
      }
    },
    async complete(request) {
      const state = { callStarted: false };
      try {
        return await completeOnce(request, state);
      } catch (error) {
        // Inside the worker the attempt learns whether this failure is worth another try (the reflector turns every model failure into one fixed reason).
        noteLearningFault(learningFaultOf(error, state.callStarted));
        throw error;
      }
    },
  };
}
