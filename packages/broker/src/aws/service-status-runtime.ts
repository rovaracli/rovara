import { WEB_API_RUNTIME_PROFILE_ID } from "@agentx/contracts";
import { e2eRegisteredRuntimeKey, readE2ERuntimeStatus } from "./e2e-runtime-readiness.js";
import type { StoredRuntimeEvidence } from "../org/service-status.js";
/** Reuse doctor's two-key reader while retaining evidence that it silently drops. */
export async function readServiceStatusEvidence(input: { runtimeCatalogId: string; read(key: { pk: string; sk: string }): Promise<unknown> }): Promise<StoredRuntimeEvidence> {
 const malformedKinds: string[] = [];
 const keys = new Map((["web", "api"] as const).map(kind => [e2eRegisteredRuntimeKey(input.runtimeCatalogId, WEB_API_RUNTIME_PROFILE_ID, kind).sk, kind]));
 const status = await readE2ERuntimeStatus({ runtimeCatalogId: input.runtimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID, read: async key => {
  const kind = keys.get(key.sk);if (kind === undefined) throw new Error("Unexpected runtime key");
  const row = await input.read(key);if (row === null || row === undefined) return row;
  const value = typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : undefined;
  if (!value || Buffer.byteLength(JSON.stringify(value), "utf8") > 32768 || ["state", "qualifiedAt", "expiresAt"].some(field => typeof value[field] !== "string" || value[field].length > 40)) { malformedKinds.push(kind);return {}; }
  return value;
 } });
 return { rows: status.rows, malformedKinds };
}
