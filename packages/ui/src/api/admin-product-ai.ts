// The project's product AI settings (B7): Cloud's `/v1/app/projects/:name/product-ai` routes. The key is write-only: the page sends it once
// and never reads it back (Cloud answers only "connected" and when). Readers are total over untrusted data: a field that is not the shape is
// absent, and a body that is not an object is unreadable.
export const productAiPath = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/product-ai`;
export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
export interface ProductAiRead {
  project: string; revision: number;
  key: { connected: boolean; connectedAt?: number; updatedAt?: number; refusedAt?: number };
  removedUntil?: number;
  evalBudget: { calls: number; costMicros: number };
  evalApproval?: { selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string; approvedAt: number; approvedByYou: boolean };
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));
export function readProductAi(body: unknown): ProductAiRead {
  if (!isRecord(body) || typeof body["project"] !== "string" || !whole(body["revision"]) || !isRecord(body["key"])) throw new Error("not product AI settings");
  const key = body["key"], budget = isRecord(body["evalBudget"]) ? body["evalBudget"] : {}, a = isRecord(body["evalApproval"]) ? body["evalApproval"] : undefined;
  const approval = a !== undefined && typeof a["selection"] === "string" && typeof a["inputsDigest"] === "string" && whole(a["maxCalls"]) && whole(a["maxCostMicros"]) && whole(a["approvedAt"])
    ? { selection: a["selection"], inputsDigest: a["inputsDigest"], maxCalls: a["maxCalls"], maxCostMicros: a["maxCostMicros"], ...opt("model", typeof a["model"] === "string" ? a["model"] : undefined), approvedAt: a["approvedAt"], approvedByYou: a["approvedByYou"] === true }
    : undefined;
  return {
    project: body["project"], revision: body["revision"],
    key: { connected: key["connected"] === true, ...opt("connectedAt", whole(key["connectedAt"]) ? key["connectedAt"] : undefined), ...opt("updatedAt", whole(key["updatedAt"]) ? key["updatedAt"] : undefined), ...opt("refusedAt", whole(key["refusedAt"]) ? key["refusedAt"] : undefined) },
    ...opt("removedUntil", whole(body["removedUntil"]) ? body["removedUntil"] : undefined),
    evalBudget: { calls: whole(budget["calls"]) ? budget["calls"] : 400, costMicros: whole(budget["costMicros"]) ? budget["costMicros"] : 4_000_000 },
    ...opt("evalApproval", approval),
  };
}
/** Dollars as typed ("4", "4.50") to micro-dollars; undefined when it does not read. */
export function usdToMicros(text: string): number | undefined {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,6}))?\s*$/u.exec(text);
  return m === null ? undefined : Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}
