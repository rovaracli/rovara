// The company's learning AI key (PRODUCT-LEARNING-CONNECT-ROUTE): Cloud's `/v1/app/org/learning-ai` routes. Company admins only. The key is
// write-only: the page sends it once and never reads it back (Cloud answers only "connected" and when). Readers are total over untrusted data:
// a field that is not the shape is absent, and a body that is not an object is unreadable.
export const LEARNING_AI_PATH = "/v1/app/org/learning-ai";
export const LEARNING_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type LearningProvider = typeof LEARNING_PROVIDERS[number];
export const LEARNING_PROVIDER_LABELS: Readonly<Record<LearningProvider, string>> = Object.freeze({ anthropic: "Anthropic", openai: "OpenAI", gemini: "Google AI Studio (Gemini)" });
export interface LearningAccount { connected: boolean; connectedAt?: number; updatedAt?: number; refusedAt?: number }
export interface LearningAiRead {
  revision: number;
  accounts: Record<LearningProvider, LearningAccount>;
  removed: Array<{ provider: LearningProvider; recoverUntil: number }>;
  learningCap?: { monthlyUsdMicros: number; companyMonthlyUsdMicros?: number };
  lessonsOn?: boolean;
  pausedNow: string[];
  pauseReasons: Array<{ reason: string; message: string }>;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const named = (v: unknown): v is LearningProvider => LEARNING_PROVIDERS.some(p => p === v);
const REASON = /^[a-z_]{1,32}$/u;
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));
function account(v: unknown): LearningAccount {
  const a = isRecord(v) ? v : {};
  return { connected: a["connected"] === true, ...opt("connectedAt", whole(a["connectedAt"]) ? a["connectedAt"] : undefined), ...opt("updatedAt", whole(a["updatedAt"]) ? a["updatedAt"] : undefined), ...opt("refusedAt", whole(a["refusedAt"]) ? a["refusedAt"] : undefined) };
}
export function readLearningAi(body: unknown): LearningAiRead {
  if (!isRecord(body) || !whole(body["revision"]) || !isRecord(body["accounts"])) throw new Error("not learning AI settings");
  const accounts = body["accounts"], cap = isRecord(body["learningCap"]) ? body["learningCap"] : undefined;
  return {
    revision: body["revision"],
    accounts: { anthropic: account(accounts["anthropic"]), openai: account(accounts["openai"]), gemini: account(accounts["gemini"]) },
    removed: (Array.isArray(body["removed"]) ? body["removed"] : []).filter(isRecord).filter(r => named(r["provider"]) && whole(r["recoverUntil"])).map(r => ({ provider: r["provider"] as LearningProvider, recoverUntil: r["recoverUntil"] as number })),
    ...opt("learningCap", cap !== undefined && whole(cap["monthlyUsdMicros"]) ? { monthlyUsdMicros: cap["monthlyUsdMicros"], ...opt("companyMonthlyUsdMicros", whole(cap["companyMonthlyUsdMicros"]) ? cap["companyMonthlyUsdMicros"] : undefined) } : undefined),
    ...opt("lessonsOn", typeof body["lessonsOn"] === "boolean" ? body["lessonsOn"] : undefined),
    pausedNow: (Array.isArray(body["pausedNow"]) ? body["pausedNow"] : []).filter((r): r is string => typeof r === "string" && REASON.test(r)),
    pauseReasons: (Array.isArray(body["pauseReasons"]) ? body["pauseReasons"] : []).filter(isRecord).filter(r => typeof r["reason"] === "string" && REASON.test(r["reason"]) && typeof r["message"] === "string" && r["message"].length <= 300).map(r => ({ reason: r["reason"] as string, message: r["message"] as string })),
  };
}
