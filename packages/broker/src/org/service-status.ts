import { takeRateAt } from "../developer/page-comments.js";
import { requireLiveCompanyAdmin, type CompanyAuthorityDependencies, type CompanyViewer } from "./company-authority.js";
import { z } from "zod";
import { connectorHealthErrorRef, e2eRuntimeExpiryNotice, OrgIdSchema, agentXError, orgScoped, type ErrorRef } from "@agentx/contracts";
type RuntimeKind = "web" | "api";
export interface ServiceObservation {
 kind: RuntimeKind; state: "ready" | "parked" | "unavailable" | "unknown";
 observation: "qualified" | "warning" | "expired" | "unknown";
 reason: "qualified" | "expiring" | "expired" | "not_ready" | "not_observed" | "invalid_evidence" | "not_configured" | "unavailable";
 expiresAt?: string;
 /** Live interaction F1: what "Fix with agent" is about, for a row that is not healthy (fixed codes and ids only). */
 errorRef?: ErrorRef;
}
/**
 * Which rows are an error to fix: an expired or not-ready qualification, evidence that cannot be read and a store that is down. A row that is simply not set up (`not_configured`), not yet observed
 * (`not_observed`) or expiring soon is a state, not an error: no reference.
 */
export function withServiceErrorRefs(rows: readonly ServiceObservation[], at: string): ServiceObservation[] {
 return rows.map(row => {
  const faulty = row.reason === "expired" || row.reason === "not_ready" || row.reason === "invalid_evidence" || row.reason === "unavailable";
  const errorRef = faulty ? connectorHealthErrorRef({ connectorId: `runtime-${row.kind}`, reason: row.reason, at }) : undefined;
  return errorRef === undefined ? row : { ...row, errorRef };
 });
}
const stored = z.object({ kind: z.enum(["web", "api"]), state: z.enum(["READY", "PARKED", "UNAVAILABLE"]), qualifiedAt: z.string().datetime(), expiresAt: z.string().datetime() });
/** Only coarse stored qualification facts leave this projection. Never emit helper text. */
export function projectRuntimeStatus(input: { rows: readonly unknown[]; malformedKinds: readonly string[] }, now: number): ServiceObservation[] {
 return (["web", "api"] as const).map(kind => {
  const unknown = (reason: "not_observed" | "invalid_evidence"): ServiceObservation => ({ kind, state: "unknown", observation: "unknown", reason });
  const rows = input.rows.filter(row => row !== null && typeof row === "object" && (row as { kind?: unknown }).kind === kind);
  if (!Number.isFinite(now) || input.malformedKinds.includes(kind) || rows.length > 1) return unknown("invalid_evidence");
  if (!rows.length) return unknown("not_observed");
  const parsed = stored.safeParse(rows[0]);if (!parsed.success) return unknown("invalid_evidence");const row = parsed.data;
  const qualified = Date.parse(row.qualifiedAt), expiry = Date.parse(row.expiresAt);
  if (qualified > now || expiry <= qualified) return unknown("invalid_evidence");
  const state = row.state === "READY" ? "ready" : row.state === "PARKED" ? "parked" : "unavailable";
  const severity = e2eRuntimeExpiryNotice({ subject: "runtime", expiresAt: row.expiresAt, now })?.severity;
  if (expiry <= now) return { kind, state, observation: "expired", reason: "expired", expiresAt: row.expiresAt };
  if (state !== "ready") return { kind, state, observation: "warning", reason: "not_ready", expiresAt: row.expiresAt };
  return { kind, state, observation: severity === undefined ? "qualified" : "warning", reason: severity === undefined ? "qualified" : "expiring", expiresAt: row.expiresAt };
 });
}

export interface StoredRuntimeEvidence { rows: readonly unknown[]; malformedKinds: readonly string[] }
export interface ServiceStatusDependencies extends CompanyAuthorityDependencies { now(): number; runtimeStatus?: () => Promise<StoredRuntimeEvidence> }
const evidenceSchema = z.object({ rows: z.array(z.unknown()).max(2), malformedKinds: z.array(z.enum(["web", "api"])).max(2) }).strict();
/** Browser reads only: rate rows are the sole state mutation, never runtime renewal. */
export async function readOrgServiceStatus(deps: ServiceStatusDependencies, caller: CompanyViewer, request: { expectedOrgId: unknown }) {
 if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session for service status.");
 if (!OrgIdSchema.safeParse(request.expectedOrgId).success || request.expectedOrgId !== caller.orgId) throw agentXError("CHANGE_STALE", "Refresh your company before reading service status.");
 await requireLiveCompanyAdmin(deps, caller);
 for (const bucket of [{ name: "SERVICE_STATUS_PERSON_RATE", actor: caller.developerId, limit: 30 }, { name: "SERVICE_STATUS_ORG_RATE", actor: "ALL", limit: 120 }]) {
  let accepted: boolean;try { accepted = await takeRateAt(deps, { pk: orgScoped(caller.orgId, bucket.name), sk: bucket.actor }, bucket.limit, 60000); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "Service status could not be read."); }
  if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many service status reads. Try again later.");
 }
 let timer: ReturnType<typeof setTimeout> | undefined, evidence: StoredRuntimeEvidence | undefined;
 let reason: "not_configured" | "unavailable" | "invalid_evidence" = "not_configured";
 if (deps.runtimeStatus !== undefined) {
  try {
   const raw = await Promise.race([deps.runtimeStatus(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Stored read deadline")), 5000); })]);
   const parsed = evidenceSchema.safeParse(raw);if (!parsed.success || Buffer.byteLength(JSON.stringify(raw), "utf8") > 16384) reason = "invalid_evidence";else evidence = parsed.data;
  } catch { reason = "unavailable"; } finally { clearTimeout(timer); }
 }
 await requireLiveCompanyAdmin(deps, caller);const now = deps.now();
 const checkedAt = new Date(now).toISOString();
 const checks: ServiceObservation[] = withServiceErrorRefs(evidence === undefined ? (["web", "api"] as const).map(kind => ({ kind, state: "unknown", observation: "unknown", reason })) : projectRuntimeStatus(evidence, now), checkedAt);
 return { orgId: caller.orgId, source: "stored_runtime_qualification" as const, checkedAt, configured: deps.runtimeStatus !== undefined, checks };
}
