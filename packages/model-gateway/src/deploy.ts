/**
 * What the deployed gateway reads from its environment and writes to its log, shared with infra/lib/model-gateway.ts (which
 * repeats these literals; tests/contract/model-gateway-infra.test.ts holds the two to one truth). Constants only: the process
 * entry that reads them, and the DynamoDB and Secrets Manager adapters, are a later lane.
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
} as const;
