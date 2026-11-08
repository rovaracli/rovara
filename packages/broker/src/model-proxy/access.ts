// What the broker's callers see of the model proxy (ruling R28). ModelProxyClient talks to LiteLLM
// directly and runs only inside the VPC-attached ModelAccessFunction; ModelAccessInvoker satisfies the
// same interface from the broker Lambdas, which are not in the VPC and never hold the master key.
import type { ModelSource, OrgId } from "@agentx/contracts";

export interface SpendFigures {
  spentUsd: number;
  limitUsd: number;
}

export interface MemberSpend {
  member: SpendFigures;
  org: SpendFigures;
}

/** Who pays and what ran, kept with the key (the proxy's spend logs do not carry key metadata, so the ledger reads these from the key record). */
export interface MintTags {
  taskId?: string | undefined;
  operationId?: string | undefined;
  stepId?: string | undefined;
  agentId: string;
  /** Plan 4: the chain and the run a chain's step belongs to. */
  chainId?: string | undefined;
  chainRunId?: string | undefined;
  project?: string | undefined;
  payerKind: "member" | "project" | "agent" | "chain";
  payerId: string;
  source: string;
  origin: string;
}

/** The answer to checking a company source: a Bedrock trust policy that is too loose, or a source that did not answer, comes back as `ok: false` with text safe to show. */
export type SourceCheck = { ok: true; health: "healthy" | "unknown" } | { ok: false; message: string };

/** What the periodic audit of the proxy's scoped keys found: how many it evaluated, and how many it blocked for drifting from their org's own models. */
export interface KeyAudit {
  checked: number;
  blocked: number;
  /** The audit stopped at its page limit or its time budget with keys unread; the next run starts from the newest again. */
  truncated: boolean;
}

export interface UpsertSourceInput {
  orgId: OrgId;
  source: ModelSource;
  /** The vendor key, sent only when it is new or changed. It is stored in the proxy's own credential store and never returned, logged or echoed. */
  apiKey?: string | undefined;
}

export interface MintKeyInput {
  orgId: OrgId;
  /** Absent for work no known member started (a Slack requester not linked to a member): the key then answers to the org alone. */
  developerId?: string | undefined;
  purpose: "task" | "turn";
  refId: string;
  maxBudgetUsd: number;
  ttlSeconds: number;
  /** The aliases the key may call: the org's own source aliases and Rovara AI catalog ids, never a wildcard or another org's alias. Absent keeps the older, unscoped key. */
  models?: readonly string[] | undefined;
  tags?: MintTags | undefined;
}

/** The transports a learning completion can be made over: the route's own (`ModelRoute.api`). */
export type LearningCompletionApi = "anthropic-messages" | "openai-responses" | "openai-completions";

/**
 * Lessons in production: ONE tool-less model call for the learning pipeline, made on the COMPANY's own route. The function mints a short-lived key for the org alone (no member), scoped to the
 * one model alias and capped at `maxBudgetUsd`, makes the call, reads what the key spent, and gives the key back. The key never leaves the function.
 */
export interface LearningCompletionInput {
  orgId: OrgId;
  project: string;
  purpose: "reflect" | "judge" | "distill" | "outcome";
  system: string;
  user: string;
  maxOutputTokens: number;
  /** The route's alias (the company's own source alias, or a Rovara AI catalog id the company's order reaches) and its transport. */
  model: string;
  api: LearningCompletionApi;
  /** The most the call may cost, in US dollars: the key's cap. */
  maxBudgetUsd: number;
}

export interface LearningCompletion {
  text: string;
  /** What the proxy says the key spent. */
  costUsd: number;
  /** The alias that answered. */
  model: string;
}

export interface MintedKey {
  key: string;
  /** Epoch milliseconds, counted from when the request was made, so never later than the proxy's own expiry. */
  expiresAt: number;
}

export interface ModelAccess {
  upsertOrg(orgId: OrgId, monthlyBudgetUsd: number): Promise<void>;
  upsertMember(orgId: OrgId, developerId: string, monthlyBudgetUsd: number): Promise<void>;
  /** LiteLLM's own figures (ruling R22); remaining budget is clamped at 0 by the caller (R23). */
  spend(orgId: OrgId, developerId: string): Promise<MemberSpend>;
  /** The org's own figures, for work no known member started (a Slack requester not linked to a member). */
  orgSpend(orgId: OrgId): Promise<SpendFigures>;
  /**
   * What the given keys have spent in all, by key id (the SHA-256 of the key, which is LiteLLM's own token id, so the key itself
   * never leaves the caller). A key the proxy does not know is MODEL_PROXY_UNAVAILABLE: its spend is unknown, so it is never counted as 0.
   */
  keySpend(keyIds: readonly string[]): Promise<number>;
  /**
   * Registers a company source: its key (when given) in the proxy's credential store, one proxy model per source model under
   * `sourceAlias`, removal of the source's aliases that are no longer listed, and the org team's `models`.
   */
  upsertSource(input: UpsertSourceInput): Promise<void>;
  /** Removes the source's models and key from the proxy, and its aliases from the org's team. Removing a source the proxy does not know is a no-op. */
  removeSource(orgId: OrgId, sourceId: string): Promise<void>;
  /**
   * Every company source the proxy holds a model or a credential for, by org and source id. The sweeper compares it with the records, so a registration
   * whose record write never landed (or whose removal never finished) is found. Credentials without models count: a registration that stopped half-way.
   * `hosts` are the hostnames the source's models and credential point at (`api_base`), so the sweeper can tell a key that sits beside a host it was not saved
   * for. Hostnames only: never a key, and never a path or query.
   */
  listSources(): Promise<Array<{ orgId: OrgId; sourceId: string; hosts?: string[] | undefined }>>;
  /**
   * N8: judges a company model endpoint's address where the proxy runs, inside the VPC, with the same resolver the proxy connects with: https, no user info, a DNS name, and every
   * address public or inside the install's model-endpoint ranges (never a never-called address or Rovara's own network). Throws CONFIG_INVALID (text safe to show) when it may not be
   * used, and RUNTIME_UNAVAILABLE when the name cannot be looked up. A function that has no checker refuses every address: nothing is judged elsewhere. The proxy connects by name
   * and cannot be pinned to the addresses judged here, so the check is repeated at every save and every check, and a failed check takes the qualification away.
   */
  checkEndpoint?(url: string): Promise<void>;
  /** Tests a source: for Bedrock the trust-policy probe first, then a health call per alias. A source the proxy does not know is NOT_FOUND. */
  checkSource(orgId: OrgId, sourceId: string): Promise<SourceCheck>;
  /**
   * A key with `models` is minted only for a team whose own models are scoped, and is read back and checked against the request before it is returned
   * (a key that drifted is revoked and refused with MODEL_PROXY_UNAVAILABLE).
   */
  mintKey(input: MintKeyInput): Promise<MintedKey>;
  /**
   * Reads the proxy's keys and blocks every scoped key that no longer holds to its invariants: models that are only its own org's aliases and Rovara AI
   * catalog ids, no wildcard, no alias map, a team. A backstop for the checks at the mint; the older unscoped keys are not part of it.
   */
  auditKeys(options?: { budgetMs?: number }): Promise<KeyAudit>;
  revokeKey(key: string): Promise<void>;
  /**
   * Blocks a key by its id (the SHA-256 of the key): the proxy refuses it from then on, and its spend stays readable (`keySpend`), which a
   * deleted key's does too. A key the proxy no longer knows is already blocked. Task 30's two-phase finalize starts here.
   */
  blockKey(keyId: string): Promise<void>;
  /** See `LearningCompletionInput`. Absent where the function does not make learning calls. Errors carry fixed words only: never the provider's text, never a key. */
  learningCompletion?(input: LearningCompletionInput): Promise<LearningCompletion>;
}
