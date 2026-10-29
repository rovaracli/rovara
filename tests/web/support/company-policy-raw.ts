// A version-1 company model-selection policy and its preview/save answers (lane C's company contract, relay 3: `candidates`, the 200 and the 202 are all lane C's shapes and parse with its strict schemas), shared by the web tests and the e2e mock (no imports).
type Json = Record<string, unknown>;
export const COMPANY_BUILD = "anthropic/claude-sonnet-4-6", COMPANY_REVIEW = "anthropic/claude-opus-5-5";
export const mid = (key: string) => ({ provider: key.slice(0, key.indexOf("/")), modelId: key.slice(key.indexOf("/") + 1) });
const candidate = (key: string, label: string, status = "verified", extra: Record<string, unknown> = {}) => ({ model: mid(key), label, provider: key.slice(0, key.indexOf("/")), company: "anthropic", status, ...(status === "verified" ? { checkedAt: "2026-10-29T10:00:00.000Z" } : {}), ...extra });
/** The per-stage lists a company picker offers (lane C's optional `candidates`). */
export const companyCandidates = () => Object.fromEntries(["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"].map(stage => [stage, [candidate(COMPANY_REVIEW, "Opus 5.5"), candidate(COMPANY_BUILD, "Sonnet 4.6"), candidate("openai/gpt-5-codex", "GPT-5 Codex", "unverified")]]));
/** Build is set (model, effort) and unlocked; Review is set and locked; Plan check has only an effort. */
export const companyPolicyRaw = (overrides: Json = {}, revision = 4) => ({
 version: 1, revision, rankingVersion: "g3-v1",
 stepOverrides: {
  build: { model: mid(COMPANY_BUILD), thinkingLevel: "medium", locked: false },
  code_review: { model: mid(COMPANY_REVIEW), thinkingLevel: null, differentFrom: { stage: "build", level: "vendor" }, locked: true },
  security_review: { model: mid(COMPANY_REVIEW), thinkingLevel: null, differentFrom: { stage: "build", level: "vendor" }, locked: true },
  plan_check: { thinkingLevel: "low", locked: false },
  ...overrides,
 },
});
export const PROJECT_NAMES = ["payments", "checkout", "ledger", "mobile", "search", "billing", "reports"];
const impacts = ["changed", "blocked", "unchanged", "unavailable", "changed", "unchanged", "blocked"];
const reasons: string[][] = [["STAGE_LOCKED"], ["MODEL_FORBIDDEN", "SOME_FUTURE_CODE"], [], ["MODEL_NOT_VERIFIED"], [], [], ["LOCK_UNSATISFIABLE"]];
/** Pages of five projects; the cursor is the offset. The last reason is a code this build does not know. */
export function previewPage(cursor?: string) {
 const start = cursor === undefined ? 0 : Number(cursor), slice = PROJECT_NAMES.slice(start, start + 5);
 return { version: 1, checkedAt: "2026-10-29T10:00:00.000Z", policyRevision: 4, mayBeIncomplete: true, projects: slice.map((project, index) => ({ project, impact: impacts[start + index], reasonCodes: reasons[start + index] })), ...(start + 5 < PROJECT_NAMES.length ? { nextCursor: String(start + 5) } : {}) };
}
export const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
export const applied = (revision: number, requestId = REQUEST_ID) => ({ status: "APPLIED", revision, requestId });
/** `soleOwner`: a time (the path is open from then) or a ready-made field. */
export const needsConfirmation = (origin: string, requestId = REQUEST_ID, soleOwner?: string | Record<string, unknown>) => ({
 status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmationId: "cnf_aaaaaaaaaaaaaaaaaaaa", confirmUrl: origin + "/v1/app/approve/" + "A".repeat(43), changes: ["A stage lock is removed"], requestId, ...(soleOwner === undefined ? {} : { soleOwner: typeof soleOwner === "string" ? { available: true, availableAt: soleOwner } : soleOwner }),
});
