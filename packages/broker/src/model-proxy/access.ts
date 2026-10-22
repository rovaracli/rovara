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
  project?: string | undefined;
  payerKind: "member" | "project" | "agent";
  payerId: string;
  source: string;
  origin: string;
}

/** The answer to checking a company source: a Bedrock trust policy that is too loose, or a source that did not answer, comes back as `ok: false` with text safe to show. */
export type SourceCheck = { ok: true; health: "healthy" | "unknown" } | { ok: false; message: string };

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
   */
  listSources(): Promise<Array<{ orgId: OrgId; sourceId: string }>>;
  /** Tests a source: for Bedrock the trust-policy probe first, then a health call per alias. A source the proxy does not know is NOT_FOUND. */
  checkSource(orgId: OrgId, sourceId: string): Promise<SourceCheck>;
  mintKey(input: MintKeyInput): Promise<MintedKey>;
  revokeKey(key: string): Promise<void>;
  /**
   * Blocks a key by its id (the SHA-256 of the key): the proxy refuses it from then on, and its spend stays readable (`keySpend`), which a
   * deleted key's does too. A key the proxy no longer knows is already blocked. Task 30's two-phase finalize starts here.
   */
  blockKey(keyId: string): Promise<void>;
}
