/**
 * What the deployed gateway reads from its environment and writes to its log, shared with infra/lib/model-gateway.ts (which
 * repeats these literals; tests/contract/model-gateway-infra.test.ts holds the two to one truth). Constants only: process.ts
 * (the entry, main.ts) reads them; dynamo-meter.ts, dynamo-prices.ts and secrets.ts are the DynamoDB and Secrets Manager adapters.
 *
 * Settings come from plain environment variables. A provider key never does: the environment names the secret's ARN, and the
 * process reads the value from Secrets Manager at run time with its own role (migration plan v3.2, 7.4 item 4).
 */
export const GATEWAY_ENV = {
  /** "serve" (the HTTP service) or "price-fetch" (the daily price job, one run then exit). */
  mode: "GATEWAY_MODE",
  /** The port the HTTP service listens on, behind the load balancer. */
  port: "GATEWAY_PORT",
  /** The one Code install the gateway trusts (TC-1 `iss`), its pinned JWKS address and the task-token key IDs it accepts. */
  installIssuer: "GATEWAY_INSTALL_ISSUER",
  installJwksUrl: "GATEWAY_INSTALL_JWKS_URL",
  /** Comma-separated, at most two (one live, one being rotated in). */
  installTaskKids: "GATEWAY_INSTALL_TASK_KIDS",
  meterTable: "GATEWAY_METER_TABLE",
  ledgerTable: "GATEWAY_LEDGER_TABLE",
  markersTable: "GATEWAY_MARKERS_TABLE",
  pricesTable: "GATEWAY_PRICES_TABLE",
  /** The ARN of the secret holding the Anthropic key. Never the key itself. */
  anthropicKeySecret: "GATEWAY_ANTHROPIC_KEY_SECRET",
  /** The Cloud company backend's Companies table, read for each company's budgets (GATEWAY_COMPANY_SETTINGS). */
  companyTable: "GATEWAY_COMPANY_TABLE",
} as const;

export const GATEWAY_MODES = ["serve", "price-fetch"] as const;
export const GATEWAY_PORT = 8080;

/**
 * Table shapes. Every key of the company tables starts with COMPANY_KEY_PREFIX followed by the install and company
 * (`CO#` + JSON.stringify([iss, cid]) ...), so the role's dynamodb:LeadingKeys condition can refuse any other key.
 * Only the markers table expires rows (the per-company in-flight marker, ADDENDUM-3 item 3, and the ended-task list); the
 * meter (spend, holds) and the ledger (per-call records, the estimated-call ledger) are kept with no expiry (DEC 222).
 */
export const GATEWAY_COMPANY_KEY_PREFIX = "CO#";
export const GATEWAY_TABLE_KEYS = { partitionKey: "pk", sortKey: "sk" } as const;
export const GATEWAY_MARKERS_TTL_ATTRIBUTE = "expiresAt";

/**
 * Log lines are one JSON object per line on stdout with an `event` field; the alarms count them with metric filters, so the
 * process needs no metrics permission. The first four are server.ts's own events; price_fetch_failed is the price job's.
 */
export const GATEWAY_LOG_EVENTS = {
  refused: "refused",
  overrunBusy: "overrun_busy",
  settleFailed: "settle_failed",
  providerError: "provider_error",
  priceFetchFailed: "price_fetch_failed",
  /** A price fetch that saved (counted daily; no count for three days raises the staleness alarm). */
  priceFetched: "price_fetched",
} as const;

/**
 * The ledger's two sparse indexes over estimated calls still waiting for a real price (R3c's pending-correction index). Only a
 * pending call carries `pendingAll` (one constant value), so the indexes hold nothing else and a corrected or expired call
 * leaves both. by-key orders by price key, then age (one price key's calls, and the distinct keys); by-age orders by age
 * across keys (the expiry sweep). The serving role may Query these two indexes by name, nothing else on them.
 */
export const GATEWAY_LEDGER_INDEXES = {
  pendingByKey: { name: "pending-by-key", partitionKey: "pendingAll", sortKey: "pendingKeyAt" },
  pendingByAge: { name: "pending-by-age", partitionKey: "pendingAll", sortKey: "pendingAt" },
} as const;
export const GATEWAY_PENDING_PARTITION = "PENDING";

/**
 * The meter's sparse index over holds still open (one constant partition, ordered by when the hold was taken). The sweep
 * (dynamo-meter.ts sweepOpenHolds) reads it to close holds whose settle failed; a settled hold leaves it.
 */
export const GATEWAY_METER_INDEXES = {
  openHolds: { name: "open-holds", partitionKey: "openAll", sortKey: "openAt" },
} as const;
export const GATEWAY_OPEN_PARTITION = "OPEN";

/**
 * Budgets come from the Cloud company backend's Companies table (packages/cloud-server company-dynamo.ts, #52): the item COMPANY#<org_…> / SETTINGS holds `companyId` and `settings.budgets`, four caps in
 * micro-dollars where null means no cap of that kind. The gateway only reads it (GetItem); the backend's admin API writes it.
 * These literals repeat that store's; tests/contract/model-gateway-company-budgets.test.ts writes through the backend's store
 * and reads back through the gateway's reader, so the two cannot drift.
 */
export const GATEWAY_COMPANY_SETTINGS = { partitionPrefix: "COMPANY#", sortKey: "SETTINGS" } as const;
export const GATEWAY_COMPANY_BUDGET_FIELDS = ["companyMonthlyUsdMicros", "memberMonthlyUsdMicros", "projectMonthlyUsdMicros", "taskUsdMicros"] as const;
/** The backend's own ceiling for one budget: $1,000,000 in micro-dollars. */
export const GATEWAY_COMPANY_BUDGET_MAX = 1_000_000_000_000;
/**
 * The company's lessons switch (DEC 226): the feature gate of this name in the same settings item (`settings.featureGates`), on
 * only when exactly true. The learning route reads it on every call; off, missing or anything else makes no learning call.
 */
export const GATEWAY_COMPANY_LESSONS_GATE = "lessons";
