// The company's learning AI key (PRODUCT-LEARNING-CONNECT-ROUTE): Cloud's `/v1/app/org/learning-ai` routes. Company admins only. The key is
// write-only: the page sends it once and never reads it back (Cloud answers only "connected" and when). Readers are total over untrusted data:
// a field that is not the shape is absent, and a body that is not an object is unreadable.
export const LEARNING_AI_PATH = "/v1/app/org/learning-ai";
export const LEARNING_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter"] as const;
export type LearningProvider = typeof LEARNING_PROVIDERS[number];
/** DEC 254t: OpenRouter is for the agents only, and listed only when Cloud lists it (its kind is switched on). */
const ALWAYS_LISTED: readonly LearningProvider[] = ["anthropic", "openai", "gemini"];
export const LEARNING_PROVIDER_LABELS: Readonly<Record<LearningProvider, string>> = Object.freeze({ anthropic: "Anthropic", openai: "OpenAI", gemini: "Google AI Studio (Gemini)", openrouter: "OpenRouter (agents only)" });
export interface LearningAccount { connected: boolean; connectedAt?: number; updatedAt?: number; refusedAt?: number }
export interface LearningAiRead {
  revision: number;
  accounts: Record<LearningProvider, LearningAccount>;
  /** The providers Cloud lists (OpenRouter only where it is switched on). */
  listed: readonly LearningProvider[];
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
    accounts: { anthropic: account(accounts["anthropic"]), openai: account(accounts["openai"]), gemini: account(accounts["gemini"]), openrouter: account(accounts["openrouter"]) },
    listed: LEARNING_PROVIDERS.filter(p => ALWAYS_LISTED.includes(p) || isRecord(accounts[p])),
    removed: (Array.isArray(body["removed"]) ? body["removed"] : []).filter(isRecord).filter(r => named(r["provider"]) && whole(r["recoverUntil"])).map(r => ({ provider: r["provider"] as LearningProvider, recoverUntil: r["recoverUntil"] as number })),
    ...opt("learningCap", cap !== undefined && whole(cap["monthlyUsdMicros"]) ? { monthlyUsdMicros: cap["monthlyUsdMicros"], ...opt("companyMonthlyUsdMicros", whole(cap["companyMonthlyUsdMicros"]) ? cap["companyMonthlyUsdMicros"] : undefined) } : undefined),
    ...opt("lessonsOn", typeof body["lessonsOn"] === "boolean" ? body["lessonsOn"] : undefined),
    pausedNow: (Array.isArray(body["pausedNow"]) ? body["pausedNow"] : []).filter((r): r is string => typeof r === "string" && REASON.test(r)),
    pauseReasons: (Array.isArray(body["pauseReasons"]) ? body["pauseReasons"] : []).filter(isRecord).filter(r => typeof r["reason"] === "string" && REASON.test(r["reason"]) && typeof r["message"] === "string" && r["message"].length <= 300).map(r => ({ reason: r["reason"] as string, message: r["message"] as string })),
  };
}

const SHORT_NAMES: Readonly<Record<LearningProvider, string>> = Object.freeze({ anthropic: "Anthropic", openai: "OpenAI", gemini: "Google AI Studio", openrouter: "OpenRouter" });
/** The provider a key's own prefix names: OpenRouter "sk-or-", Anthropic "sk-ant-", Google "AIza", else any other "sk-" is OpenAI's. Undefined when the shape says nothing. */
function shapeOf(key: string): LearningProvider | undefined {
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("AIza")) return "gemini";
  return key.startsWith("sk-") ? "openai" : undefined;
}
/**
 * A hint only (the server's own check, cloud-server learning-ai-routes.ts, is the authority and says the same words): when a key's prefix
 * plainly belongs to a different provider than the slot it was pasted into, say where to paste it. Undefined for any key that could be the slot's.
 */
export function wrongProviderKeyHint(provider: LearningProvider, key: string, listed: readonly LearningProvider[] = LEARNING_PROVIDERS): string | undefined {
  const shape = shapeOf(key.trim());
  if (shape === undefined || shape === provider) return undefined;
  const looks = `This looks like ${shape === "gemini" ? "a" : "an"} ${SHORT_NAMES[shape]} key.`;
  // Where that provider's slot is switched off there is nowhere to paste it, so say no more.
  return listed.includes(shape) ? `${looks} Paste it under ${SHORT_NAMES[shape]}.` : looks;
}

/** The words for a key with spaces or line breaks inside it (a pasted console command, not a key). The server's refusal says the same. */
export const KEY_WHITESPACE_WORDS = "A key can't contain spaces or line breaks. Copy just the key.";
/** A hint only. The page already trims leading and trailing whitespace before sending, so only whitespace INSIDE the trimmed value is refused. */
export function keyWhitespaceHint(key: string): string | undefined {
  return /\s/u.test(key.trim()) ? KEY_WHITESPACE_WORDS : undefined;
}
