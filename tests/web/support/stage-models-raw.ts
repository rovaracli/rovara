// A version-1 stage-models read in lane C's shape (G3 contract, no imports so the e2e mock can use it) for the How we work tests: five candidates, one answer per stage.
type Json = Record<string, unknown>;
export const OPUS = "anthropic/claude-opus-5-5", SONNET = "anthropic/claude-sonnet-4-6", GPT = "openai/gpt-5-codex", GEMINI = "google/gemini-3-pro", GROK = "xai/grok-5";
/** `provider/modelId` as lane C's `{ provider, modelId }`. */
export const mid = (key: string) => ({ provider: key.slice(0, key.indexOf("/")), modelId: key.slice(key.indexOf("/") + 1) });
export const keyOf = (model: unknown): string => { const { provider, modelId } = model as { provider: string; modelId: string };return provider + "/" + modelId; };
export const candidates = (): Json[] => [
 { model: mid(OPUS), label: "Opus 5.5", provider: "anthropic", company: "anthropic", status: "verified", checkedAt: "2026-10-29T10:00:00.000Z" },
 { model: mid(SONNET), label: "Sonnet 4.6", provider: "anthropic", company: "anthropic", status: "verified", checkedAt: "2026-10-29T10:00:00.000Z" },
 { model: mid(GPT), label: "GPT-5 Codex", provider: "openai", company: "openai", status: "unverified" },
 { model: mid(GEMINI), label: "Gemini 3 Pro", provider: "google", company: "google", status: "verified", checkedAt: "2026-10-29T10:00:00.000Z", blockedReason: "MODEL_NOT_ALLOWED_IN_PROJECT" },
 { model: mid(GROK), label: "Grok 5", provider: "xai", company: "other", status: "stale", checkedAt: "2026-10-01T10:00:00.000Z" },
];
/** The `effective` object of a row. */
export const effective = (model: string, overrides: Json = {}): Json => ({ model: mid(model), sourceId: "rovara", thinkingLevel: null, decidedBy: "rovara", locked: false, reason: "BUILTIN_DEFAULT", ...overrides });
/** One row. By default it holds `effective`; a row given `refusal` or `notApplicable` holds that instead. */
export function stageEntry(stage: string, overrides: Json = {}): Json {
 const answer = "refusal" in overrides || "notApplicable" in overrides || "effective" in overrides ? {} : { effective: effective(OPUS) };
 return { stage, projectChoice: null, companyDefault: null, locked: false, ...answer, candidates: candidates(), candidatesState: "complete", editable: true, ...overrides };
}
/** The seven stages as the resolver would answer them; Understand and Pull request run no model. */
export function stageModelsRaw(stages: Record<string, Json> = {}, extra: Json = {}) {
 const ids = ["plan", "plan_check", "build", "code_review", "security_review", "understand", "pull_request"];
 return ({ version: 1, checkedAt: "2026-10-29T10:00:00.000Z", companyRevision: 1, projectRevision: 1, process: { agentId: "agt_cccccccccccccccccccc", version: 2, draftRevision: 3, digest: "a".repeat(64) }, rankingVersion: "g3-v1",
  stages: ids.map(id => stageEntry(id, id === "understand" || id === "pull_request" ? { editable: false, notApplicable: true } : {})).map(entry => stages[entry.stage as string] ?? entry), ...extra });
}
