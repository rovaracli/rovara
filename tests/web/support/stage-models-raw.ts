// A version-1 stage-models read (no imports, so the e2e mock can use it) (lane C's C53 contract) for the How we work tests: five candidates, one result per semantic stage.
type Json = Record<string, unknown>;
export const OPUS = "anthropic/claude-opus-5-5", SONNET = "anthropic/claude-sonnet-4-6", GPT = "openai/gpt-5-codex", GEMINI = "google/gemini-3-pro", GROK = "xai/grok-5";
export const candidates = (): Json[] => [
 { model: OPUS, label: "Opus 5.5", provider: "anthropic", company: "anthropic", status: "verified", checkedAt: "2026-10-29T10:00:00.000Z" },
 { model: SONNET, label: "Sonnet 4.6", provider: "anthropic", company: "anthropic", status: "verified", checkedAt: "2026-10-29T10:00:00.000Z" },
 { model: GPT, label: "GPT-5 Codex", provider: "openai", company: "openai", status: "unverified" },
 { model: GEMINI, label: "Gemini 3 Pro", provider: "google", company: "google", status: "verified", checkedAt: "2026-10-29T10:00:00.000Z", blockedReason: "MODEL_NOT_ALLOWED_IN_PROJECT" },
 { model: GROK, label: "Grok 5", provider: "xai", company: "xai", status: "stale", checkedAt: "2026-10-01T10:00:00.000Z" },
];
export const effective = (model: string, overrides: Json = {}): Json => ({ kind: "effective", model, sourceId: "rovara", effort: null, decidedBy: "rovara", locked: false, reason: "BUILTIN_DEFAULT", checkedAt: "2026-10-29T10:00:00.000Z", expiresAt: "2026-10-30T10:00:00.000Z", ...overrides });
export function stageEntry(stage: string, overrides: Json = {}): Json {
 return { stage, projectChoice: null, companyDefault: { choice: null, locked: false }, result: effective(OPUS), candidates: candidates(), candidatesState: "complete", editable: true, ...overrides };
}
/** The six stages of the fixture view that run (or may run) a model, as the resolver would answer them. */
export function stageModelsRaw(stages: Record<string, Json> = {}, extra: Json = {}) {
 const ids = ["plan", "plan_check", "build", "code_review", "security_review", "understand", "pull_request"];
 return ({ version: 1, checkedAt: "2026-10-29T10:00:00.000Z", companyRevision: 1, projectRevision: 1, process: { agentId: "agt_cccccccccccccccccccc", version: 2, draftRevision: 3, digest: "a".repeat(64) }, referenceMode: "prospective", rankingVersion: "g3-v1",
  stages: ids.map(id => stageEntry(id, id === "understand" ? { editable: false, result: { kind: "not_applicable", reason: "NO_MODEL_INVOCATION" } } : id === "pull_request" ? { editable: false, result: { kind: "not_applicable", reason: "NO_MODEL_INVOCATION" } } : {})).map(entry => ({ ...entry, ...(stages[entry.stage as string] ?? {}) })), ...extra });
}
