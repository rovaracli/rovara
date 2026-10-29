// A version-1 company model-selection policy and its preview/save answers (lane C's C53 company contract), shared by the web tests and the e2e mock (no imports).
type Json = Record<string, unknown>;
export const COMPANY_BUILD = "anthropic/claude-sonnet-4-6", COMPANY_REVIEW = "anthropic/claude-opus-5-5";
/** Build is set (model, effort) and unlocked; Review is set and locked; Plan check has only an effort. */
export const companyPolicyRaw = (overrides: Json = {}, revision = 4) => ({
 version: 1, revision, rankingVersion: "g3-v1",
 stepOverrides: {
  build: { model: COMPANY_BUILD, effort: "medium", locked: false },
  code_review: { model: COMPANY_REVIEW, effort: null, differentFrom: { stage: "build", level: "vendor" }, locked: true },
  security_review: { model: COMPANY_REVIEW, effort: null, differentFrom: { stage: "build", level: "vendor" }, locked: true },
  plan_check: { effort: "low", locked: false },
  ...overrides,
 },
});
export const PROJECT_NAMES = ["payments", "checkout", "ledger", "mobile", "search", "billing", "reports"];
const impacts = ["changed", "blocked", "unchanged", "unavailable", "changed", "unchanged", "blocked"];
const reasons: string[][] = [["STAGE_LOCKED"], ["MODEL_FORBIDDEN", "SOME_FUTURE_CODE"], [], ["MODEL_NOT_VERIFIED"], [], [], ["LOCK_UNSATISFIABLE"]];
/** Pages of five projects; the cursor is the offset. */
export function previewPage(cursor?: string, coverage: "page" | "unavailable" = "page") {
 const start = cursor === undefined ? 0 : Number(cursor), slice = PROJECT_NAMES.slice(start, start + 5);
 return { version: 1, checkedAt: "2026-10-29T10:00:00.000Z", policyRevision: 4, coverage, projects: coverage === "unavailable" ? [] : slice.map((project, index) => ({ project, impact: impacts[start + index], reasonCodes: reasons[start + index] })), ...(start + 5 < PROJECT_NAMES.length ? { nextCursor: String(start + 5) } : {}) };
}
export const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
export const applied = (revision: number, requestId = REQUEST_ID) => ({ version: 1, status: "APPLIED", revision, requestId });
export const needsConfirmation = (origin: string, requestId = REQUEST_ID, soleOwner?: string) => ({
 version: 1, status: "NEEDS_CONFIRMATION", confirmationId: "cnf_aaaaaaaaaaaaaaaaaaaa", confirmUrl: origin + "/v1/app/approve/" + "A".repeat(43), reasonCodes: ["LOCK_REMOVED"], requestId, ...(soleOwner === undefined ? {} : { soleOwner: { availableAt: soleOwner } }),
});
