// The project's product AI settings (B7): Cloud's `/v1/app/projects/:name/product-ai` routes. The key is write-only: the page sends it once
// and never reads it back (Cloud answers only "connected" and when). Readers are total over untrusted data: a field that is not the shape is
// absent, and a body that is not an object is unreadable.
export const productAiPath = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/product-ai`;
export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
export interface ProductAiRead {
  project: string; revision: number;
  key: { connected: boolean; connectedAt?: number; updatedAt?: number; refusedAt?: number };
  removedUntil?: number;
  /** The project's Vertex AI federation setup: never a secret (there is none: Google trusts Rovara's AWS role for this company). */
  vertex: { connected: boolean; connectedAt?: number; updatedAt?: number; refusedAt?: number; projectId?: string; location?: string; serviceAccount?: string };
  vertexRemovedUntil?: number;
  /** What Rovara knows for the Vertex guide (L4-T4): its AWS account and federation role name, and this company's id. Absent: this install does not know them yet. */
  vertexSetup?: { awsAccountId: string; roleName: string; companyId: string };
  evalBudget: { calls: number; costMicros: number };
  /** state: "current" counts at the stage hold now; "stale" (over 15 minutes) and "withdrawn" (the approver's membership changed) must be approved again. */
  evalApproval?: { selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string; approvedAt: number; approvedByYou: boolean; state: "current" | "stale" | "withdrawn" };
}
/** How long an approval counts at the stage hold (the gateway's EVAL_APPROVAL_FRESH_MS). */
export const EVAL_APPROVAL_COUNTS_MINUTES = 15;
/** The Vertex AI form's fields, as Cloud checks them. */
export const VERTEX_FORM = Object.freeze({
  projectId: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u,
  location: /^(?:global|[a-z]{2,15}-[a-z]{2,15}[0-9]{1,2})$/u,
  audience: /^\/\/iam\.googleapis\.com\/projects\/[0-9]{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/u,
  serviceAccount: /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com|[0-9]{1,20}-compute@developer\.gserviceaccount\.com)$/u,
});
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));
const VERTEX_SETUP = Object.freeze({ awsAccountId: /^[0-9]{12}$/u, roleName: /^[\w+=,.@-]{1,64}$/u, companyId: /^org_[a-z0-9]{20}$/u });
/** All three values or none: a half-known setup would print a command that trusts the wrong thing. */
function readVertexSetup(value: unknown): ProductAiRead["vertexSetup"] {
  if (!isRecord(value)) return undefined;
  const { awsAccountId, roleName, companyId } = value;
  return typeof awsAccountId === "string" && VERTEX_SETUP.awsAccountId.test(awsAccountId) && typeof roleName === "string" && VERTEX_SETUP.roleName.test(roleName) && typeof companyId === "string" && VERTEX_SETUP.companyId.test(companyId)
    ? { awsAccountId, roleName, companyId } : undefined;
}
export function readProductAi(body: unknown): ProductAiRead {
  if (!isRecord(body) || typeof body["project"] !== "string" || !whole(body["revision"]) || !isRecord(body["key"])) throw new Error("not product AI settings");
  const key = body["key"], budget = isRecord(body["evalBudget"]) ? body["evalBudget"] : {}, a = isRecord(body["evalApproval"]) ? body["evalApproval"] : undefined;
  const approval = a !== undefined && typeof a["selection"] === "string" && typeof a["inputsDigest"] === "string" && whole(a["maxCalls"]) && whole(a["maxCostMicros"]) && whole(a["approvedAt"])
    ? { selection: a["selection"], inputsDigest: a["inputsDigest"], maxCalls: a["maxCalls"], maxCostMicros: a["maxCostMicros"], ...opt("model", typeof a["model"] === "string" ? a["model"] : undefined), approvedAt: a["approvedAt"], approvedByYou: a["approvedByYou"] === true,
      // Only "current" is taken as counting; anything else (or nothing) reads as needing approval again.
      state: a["state"] === "current" ? "current" as const : a["state"] === "withdrawn" ? "withdrawn" as const : "stale" as const }
    : undefined;
  const v = isRecord(body["vertex"]) ? body["vertex"] : {};
  const text = (value: unknown, pattern: RegExp) => (typeof value === "string" && pattern.test(value) ? value : undefined);
  return {
    project: body["project"], revision: body["revision"],
    key: { connected: key["connected"] === true, ...opt("connectedAt", whole(key["connectedAt"]) ? key["connectedAt"] : undefined), ...opt("updatedAt", whole(key["updatedAt"]) ? key["updatedAt"] : undefined), ...opt("refusedAt", whole(key["refusedAt"]) ? key["refusedAt"] : undefined) },
    ...opt("removedUntil", whole(body["removedUntil"]) ? body["removedUntil"] : undefined),
    vertex: {
      connected: v["connected"] === true, ...opt("connectedAt", whole(v["connectedAt"]) ? v["connectedAt"] : undefined), ...opt("updatedAt", whole(v["updatedAt"]) ? v["updatedAt"] : undefined), ...opt("refusedAt", whole(v["refusedAt"]) ? v["refusedAt"] : undefined),
      ...opt("projectId", text(v["projectId"], VERTEX_FORM.projectId)), ...opt("location", text(v["location"], VERTEX_FORM.location)), ...opt("serviceAccount", text(v["serviceAccount"], VERTEX_FORM.serviceAccount)),
    },
    ...opt("vertexRemovedUntil", whole(body["vertexRemovedUntil"]) ? body["vertexRemovedUntil"] : undefined),
    ...opt("vertexSetup", readVertexSetup(body["vertexSetup"])),
    evalBudget: { calls: whole(budget["calls"]) ? budget["calls"] : 400, costMicros: whole(budget["costMicros"]) ? budget["costMicros"] : 4_000_000 },
    ...opt("evalApproval", approval),
  };
}
/** Dollars as typed ("4", "4.50") to micro-dollars; undefined when it does not read. */
export function usdToMicros(text: string): number | undefined {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,6}))?\s*$/u.exec(text);
  return m === null ? undefined : Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}
