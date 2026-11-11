// AI navigation on Cloud, the broker side (design proof-test-env, section 4.8; Option B). Before a round with AI-navigation steps starts, its WORST CASE is reserved on the org's spend ledger as a proxy key: the work
// is admitted against every budget it counts against (task stop, project, org, member), a key is minted capped at the smallest room anywhere, and the round starts only if that cap covers the worst case. When the round
// ends the key is blocked and finalized, so what it did not spend goes back. There is never an uncharged model call on Cloud: a refused admission, a key that cannot be minted, a cap below the worst case, or a
// proxy that cannot be asked all END the round before it starts.
//
// This module is the sequence. Admission and minting are PORTS (the real `admitWork` and `mintOperationKey`, bound to the broker's dependencies where the hot file wires them), so the sequence and the money rules are
// tested without a ledger. The existing day-budget reservation (`model-budget-endpoint.ts`) stays as a second cap; this adds the dollar cap.
import { E2E_PROXY_GRANT_MAX_TTL_SECONDS, E2E_PROXY_GRANT_SCHEMA_VERSION, E2eProxyGrantSchema, e2eRoundWorstCaseUsd, type AgentXError, type E2EModelRouteBudgets, type E2eModelPrice, type E2eProxyGrant, type OrgId } from "@rovara-code/contracts";
import type { MintOperationDependencies, MintOperationKeyInput, MintedOperationKey } from "../spend/admission.js";

/** The spend refusals a round can meet. The words are the ledger's own (which scope is full); the card asks the people who can raise it. */
const BUDGET_CODES: ReadonlySet<string> = new Set(["ORG_BUDGET_EXCEEDED", "BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "AGENT_BUDGET_REQUIRED", "CHAIN_BUDGET_EXCEEDED", "CHAIN_BUDGET_REQUIRED", "TEST_ALLOWANCE_USED", "TRIAL_LOCKED", "MACHINE_TIME_EXCEEDED"]);
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(["MODEL_PROXY_UNAVAILABLE", "RUNTIME_UNAVAILABLE"]);

export interface MintedRoundKey {
  key: string;
  keyId: string;
  expiresAt: number;
  /** The cap the key was actually given. It must be the worst case asked for (never the whole room): a larger cap is refused. */
  maxBudgetUsd: number;
  /**
   * True only when the key's cap was RESERVED on the spend ledger before it was handed out (scopes and tags were given, so `mintOperationKey` wrote the reservation). A binding that cannot say so returns false and
   * the round is refused: an unreserved key is an uncharged call.
   */
  reserved: boolean;
}

export interface RoundSpendPorts {
  /** `admitWork` for the round's payer and path; throws the scope's own error when a budget is full. */
  admit(): Promise<{ maxBudgetUsd: number }>;
  /** `mintOperationKey` for the e2e route; the minted key's cap is the smallest room anywhere. A lost race (`raced`) is `undefined`. */
  mint(input: { routeAlias: string; ttlSeconds: number; capUsd: number }): Promise<MintedRoundKey | undefined>;
  /** Blocks the key at the proxy and finalizes its reservation (what it did not spend goes back). Resolves true when both happened. */
  close(orgId: OrgId, keyId: string): Promise<boolean>;
  /** The proxy's address for e2e model calls on this install; undefined when the install has no proxy route. */
  proxyBaseUrl: string | undefined;
  now(): number;
}

export interface StartRoundSpendInput {
  orgId: OrgId;
  operationId: string;
  routeAlias: string;
  groups: number;
  budgets?: E2EModelRouteBudgets;
  price: E2eModelPrice;
  /** The round's own deadline: the key expires shortly after it, so a lost close still ends. */
  roundSeconds: number;
}

export type RoundSpendRefusal =
  | { reason: "budget"; code: string; message: string; neededUsd: number; askCard: "approve_spend" }
  | { reason: "insufficient_room"; neededUsd: number; availableUsd: number; askCard: "approve_spend" }
  | { reason: "unavailable"; retryable: true }
  | { reason: "not_reserved" }
  | { reason: "cap_not_applied"; neededUsd: number }
  | { reason: "no_proxy_route" }
  | { reason: "raced"; retryable: true };

export type StartedRoundSpend = { ok: true; grant: E2eProxyGrant; worstCaseUsd: number } | ({ ok: false } & RoundSpendRefusal);

const codeOf = (error: unknown): string | undefined => (typeof (error as Partial<AgentXError> | undefined)?.code === "string" ? (error as AgentXError).code : undefined);
/** The ledger's words are fixed text (scope names and figures); anything else a fault carries is dropped. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message.slice(0, 500) : "the budget has no room for this round");

/**
 * Reserves a round's worst case. The key's cap must be at least the worst case: a smaller room refuses the round (and gives the key back) instead of starting a round that could run dry mid-way and leave a
 * half-finished verdict. A key that was minted and then cannot be turned into a grant is closed before the refusal is returned.
 */
export async function startE2eRoundSpend(ports: RoundSpendPorts, input: StartRoundSpendInput): Promise<StartedRoundSpend> {
  if (ports.proxyBaseUrl === undefined) return { ok: false, reason: "no_proxy_route" };
  const neededUsd = e2eRoundWorstCaseUsd({ groups: input.groups, price: input.price, ...(input.budgets === undefined ? {} : { budgets: input.budgets }) });
  let admitted: { maxBudgetUsd: number };
  try {
    admitted = await ports.admit();
  } catch (error) {
    return refusalOf(error, neededUsd);
  }
  if (!(admitted.maxBudgetUsd >= neededUsd)) return { ok: false, reason: "insufficient_room", neededUsd, availableUsd: Number.isFinite(admitted.maxBudgetUsd) ? Math.max(0, admitted.maxBudgetUsd) : 0, askCard: "approve_spend" };

  if (!Number.isFinite(input.roundSeconds) || input.roundSeconds <= 0) throw new RangeError("a round has a positive length in seconds");
  const ttlSeconds = Math.min(E2E_PROXY_GRANT_MAX_TTL_SECONDS, Math.max(60, Math.ceil(input.roundSeconds) + 300));
  let minted: MintedRoundKey | undefined;
  try {
    minted = await ports.mint({ routeAlias: input.routeAlias, ttlSeconds, capUsd: neededUsd });
  } catch (error) {
    return refusalOf(error, neededUsd);
  }
  if (minted === undefined) return { ok: false, reason: "raced", retryable: true };
  if (minted.reserved !== true) {
    await ports.close(input.orgId, minted.keyId).catch(() => false);
    return { ok: false, reason: "not_reserved" };
  }
  if (!(minted.maxBudgetUsd >= neededUsd)) {
    await ports.close(input.orgId, minted.keyId).catch(() => false);
    return { ok: false, reason: "insufficient_room", neededUsd, availableUsd: Math.max(0, minted.maxBudgetUsd), askCard: "approve_spend" };
  }
  // The key is capped at the round's worst case and no higher: a larger cap means the binding left the room as the cap (starving other work, and a leaked key could spend all of it).
  if (!(minted.maxBudgetUsd <= neededUsd + 1e-9)) {
    await ports.close(input.orgId, minted.keyId).catch(() => false);
    return { ok: false, reason: "cap_not_applied", neededUsd };
  }
  const grant = E2eProxyGrantSchema.safeParse({
    schemaVersion: E2E_PROXY_GRANT_SCHEMA_VERSION, proxyBaseUrl: ports.proxyBaseUrl, key: minted.key, keyId: minted.keyId, operationId: input.operationId, routeAlias: input.routeAlias,
    capUsd: minted.maxBudgetUsd, expiresAt: Math.floor(minted.expiresAt),
  });
  if (!grant.success || grant.data.expiresAt <= ports.now()) {
    await ports.close(input.orgId, minted.keyId).catch(() => false);
    return { ok: false, reason: "unavailable", retryable: true };
  }
  return { ok: true, grant: grant.data, worstCaseUsd: neededUsd };
}

function refusalOf(error: unknown, neededUsd: number): StartedRoundSpend {
  const code = codeOf(error);
  if (code !== undefined && BUDGET_CODES.has(code)) return { ok: false, reason: "budget", code, message: messageOf(error), neededUsd, askCard: "approve_spend" };
  // A proxy that cannot be asked, or a fault that may pass: the round does not start and may be tried again. Never a charge-free call.
  if (code !== undefined && UNAVAILABLE_CODES.has(code)) return { ok: false, reason: "unavailable", retryable: true };
  if (code === undefined || error instanceof TypeError) return { ok: false, reason: "unavailable", retryable: true };
  throw error;
}

/**
 * Ends a round's key: blocked at the proxy and finalized, so the unspent cap is reusable at once. Safe to call twice and from every exit of the round (done, failed, cancelled). False when it could not finish;
 * the key then ends at its expiry and the ledger's sweep settles what it spent, as late spend.
 */
export async function closeE2eRoundSpend(ports: Pick<RoundSpendPorts, "close">, orgId: OrgId, keyId: string): Promise<boolean> {
  try {
    return await ports.close(orgId, keyId);
  } catch {
    return false;
  }
}

// ---- binding the mint port to the real `mintOperationKey`


/**
 * The mint port over `mintOperationKey`. What it fixes, so a wiring task cannot get it wrong:
 *   - the key is recorded through the caller's task-stop `guardRecord` (M47); without one the port cannot be built (fail closed until the guard is wired from the task, as handleModelAccess does);
 *   - the key's cap IS the round's worst case (`stepBudgetUsd` and the run limits are all set to it), never the whole room;
 *   - the ledger reservation is written: scopes (task stop, project, org, member) and tags are required, the install must have the ledger, and `reserved` is true only then;
 *   - the earlier-keys decision (`keepEarlierKeys`) is the caller's and explicit, because blocking the task's earlier keys is visible to a round that runs beside another;
 *   - the key is for the e2e route alias only.
 */
export function mintRoundKeyPort(input: {
  mintOperationKey: (deps: MintOperationDependencies, input: MintOperationKeyInput) => Promise<MintedOperationKey>;
  deps: MintOperationDependencies;
  base: Pick<MintOperationKeyInput, "orgId" | "developerId" | "refId" | "agentName" | "taskKeyIds" | "operationKeyIds" | "pause" | "recordOn" | "guardRecord" | "taskStopExempt"> & { scopes: NonNullable<MintOperationKeyInput["scopes"]>; tags: NonNullable<MintOperationKeyInput["tags"]>; keepEarlierKeys: boolean };
}): RoundSpendPorts["mint"] {
  if (input.base.scopes.length === 0 || input.deps.ledger === undefined) throw new RangeError("a round key needs budget scopes and the spend ledger");
  // Fail closed until the M47 task-stop guard is wired here: handleModelAccess records every task key through `guardRecord` (the operation's admitted source, the task's spending stop and, for own-source
  // funding, the funding checks). A round key minted without it would reserve money outside a task's stop, so the port cannot be built without the caller's guard.
  if (input.base.guardRecord === undefined) throw new RangeError("a round key must be recorded through the task-stop guard (guardRecord)");
  // `mintOperationKey` runs `guardRecord` only when there is a record to write the key on (`recordOn`): with none, the key is recorded nowhere and the guard never runs.
  if (input.base.recordOn === undefined || input.base.recordOn.length === 0) throw new RangeError("a round key must be recorded on the task's records (recordOn), where the task-stop guard runs");
  return async ({ routeAlias, ttlSeconds, capUsd }) => {
    const minted = await input.mintOperationKey(input.deps, {
      ...input.base, ttlSeconds, route: { alias: routeAlias }, runLimitUsd: capUsd, stopAtUsd: capUsd, stepBudgetUsd: capUsd, keepEarlierKeys: input.base.keepEarlierKeys,
    });
    if (minted.outcome !== "minted") return undefined;
    return { key: minted.key, keyId: minted.keyId, expiresAt: minted.expiresAt, maxBudgetUsd: minted.maxBudgetUsd, reserved: true };
  };
}
