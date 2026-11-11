// Settings of the audit ledger (Task 5 of the Audit Ledger plan), read from CDK context and checked at
// synth. Pure functions, no CDK imports, so a test can feed them any value.
import { AUDIT_GOVERNANCE_RETENTION_DAYS, AUDIT_RETENTION_DAYS_DEFAULT, AUDIT_RETENTION_DAYS_MIN_COMPLIANCE } from "@agentx/cloud-contracts";
import type { AgentXNaming } from "./naming.js";

export type AuditLockMode = "COMPLIANCE" | "GOVERNANCE";

export interface AuditLockSettings {
  readonly mode: AuditLockMode;
  readonly retentionDays: number;
  /** The weakest setting this environment accepts. The anchor applies the same floor at runtime (Task 9). */
  readonly floor: { readonly mode: AuditLockMode; readonly days: number };
}

/** Only these environments may run the ledger in governance mode for a short time; every other name is a real install. */
function isTrialEnvironment(env: string): boolean {
  return /^(?:staging|test|dev|dev-.+)$/.test(env);
}

function parseMode(value: unknown): AuditLockMode | undefined {
  if (value === undefined) return undefined;
  if (value === "COMPLIANCE" || value === "GOVERNANCE") return value;
  throw new Error(`audit ledger: agentxAuditLockMode must be COMPLIANCE or GOVERNANCE, not ${JSON.stringify(value)}`);
}

function parseDays(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const days = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(days)) throw new Error(`audit ledger: agentxAuditRetentionDays must be a whole number of days, not ${JSON.stringify(value)}`);
  return days;
}

/**
 * The Object Lock mode and retention of the ledger bucket. The context (`agentxAuditLockMode`,
 * `agentxAuditRetentionDays`) wins; otherwise `staging`, `test`, `dev` and `dev-<suffix>` get governance for one day and every
 * other environment compliance for 1,096 days. A setting below the environment's floor throws at synth.
 */
export function auditLockSettings(naming: AgentXNaming, context: { lockMode?: unknown; retentionDays?: unknown }): AuditLockSettings {
  const env = naming.env;
  if (env === undefined) throw new Error("audit ledger: the ledger exists for named environments only");
  const trial = isTrialEnvironment(env);
  const floor = trial
    ? ({ mode: "GOVERNANCE", days: AUDIT_GOVERNANCE_RETENTION_DAYS } as const)
    : ({ mode: "COMPLIANCE", days: AUDIT_RETENTION_DAYS_MIN_COMPLIANCE } as const);
  const mode = parseMode(context.lockMode) ?? (trial ? "GOVERNANCE" : "COMPLIANCE");
  const retentionDays = parseDays(context.retentionDays) ?? (trial ? AUDIT_GOVERNANCE_RETENTION_DAYS : AUDIT_RETENTION_DAYS_DEFAULT);
  if (floor.mode === "COMPLIANCE" && (mode !== "COMPLIANCE" || retentionDays < floor.days)) {
    throw new Error(`audit ledger: ${env} needs compliance mode with at least ${floor.days} days`);
  }
  if (retentionDays < floor.days) throw new Error(`audit ledger: ${env} needs at least ${floor.days} day of retention`);
  return { mode, retentionDays, floor };
}

export type AuditTsaSettings =
  | { readonly kind: "public" }
  | { readonly kind: "custom"; readonly urls: [string] | [string, string]; readonly rootsParameter: string }
  | { readonly kind: "off" };

const CUSTOM_TSA_MESSAGE = "audit ledger: a custom timestamp authority needs its URL and root certificates";

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Which timestamp authority the anchor asks: the two public ones (default), a customer's own (`custom`: one or two
 * http(s) URLs and the name of an SSM parameter holding the PEM roots), or none (`off`, the last resort).
 */
export function auditTsaSettings(context: { tsa?: unknown; tsaUrls?: unknown; tsaRootsParameter?: unknown }): AuditTsaSettings {
  const kind = context.tsa ?? "public";
  if (kind === "public") return { kind: "public" };
  if (kind === "off") return { kind: "off" };
  if (kind !== "custom") throw new Error(`audit ledger: agentxAuditTsa must be public, custom or off, not ${JSON.stringify(kind)}`);
  const raw = context.tsaUrls;
  const urls = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : []).map((entry) => String(entry).trim()).filter((entry) => entry !== "");
  const rootsParameter = typeof context.tsaRootsParameter === "string" ? context.tsaRootsParameter.trim() : "";
  if (urls.length < 1 || urls.length > 2 || !urls.every(isHttpUrl) || rootsParameter === "") throw new Error(CUSTOM_TSA_MESSAGE);
  return { kind: "custom", urls: urls.length === 1 ? [urls[0]!] : [urls[0]!, urls[1]!], rootsParameter };
}

/**
 * An Enterprise install must not leave the audit anchor on the two public timestamp authorities: the customer names its own (`custom`) or switches it off
 * (`off`, the last resort). Unset or `public` is refused at synth.
 */
export function requireEnterpriseAuditTsa(tsa: unknown): void {
  if (tsa === undefined || tsa === "" || tsa === "public") {
    throw new Error("audit ledger: an Enterprise install must not use the public timestamp authorities; set agentxAuditTsa to custom (with agentxAuditTsaUrls and agentxAuditTsaRootsParameter) or off");
  }
}

export interface AuditReplicaSettings {
  readonly bucketArn: string;
}

/**
 * The second copy of the ledger in a separate account. The rule is added only with the bucket ARN
 * (`agentxAuditReplicaBucketArn`) and the confirmation that the bucket has Object Lock in compliance mode
 * (`agentxAuditReplicaLockConfirmed=true`); the ARN alone throws, because a replica without a lock protects nothing.
 */
export function auditReplicaSettings(context: { replicaBucketArn?: unknown; replicaLockConfirmed?: unknown }): AuditReplicaSettings | undefined {
  const arn = context.replicaBucketArn;
  if (arn === undefined || arn === "") return undefined;
  if (typeof arn !== "string" || !/^arn:aws[a-z-]*:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(arn)) {
    throw new Error(`audit ledger: agentxAuditReplicaBucketArn must be the ARN of a bucket, not ${JSON.stringify(arn)}`);
  }
  if (context.replicaLockConfirmed !== true && context.replicaLockConfirmed !== "true") {
    throw new Error("audit ledger: a replica bucket needs agentxAuditReplicaLockConfirmed=true, set only once the bucket has Object Lock in compliance mode");
  }
  return { bucketArn: arn };
}
