// Browser testing (DEC 417/420/421): one served view for the tests, shaped as Code's `GET /v1/app/projects/{p}/browser-testing` answers it (a test parses it with the strict contract schema).
export const BT_AT = "2026-11-23T05:02:00.000Z";
export const BT_DIGEST = "a".repeat(64);
export const kind = (profileId: string, over: Record<string, unknown> = {}) => ({ profileId, roleRef: profileId, signInPath: "/login", ...over });
export const application = (over: Record<string, unknown> = {}) => ({
  applicationId: "web", recipeSource: "repo", build: ["npm ci", "npm run build"], start: "npm run start", healthPath: "/health", healthStatus: 200,
  userKinds: [kind("admin"), kind("viewer")], signInDeclared: true, snippet: null, ...over,
});
export const found = (over: Record<string, unknown> = {}, app: Record<string, unknown> = {}) => ({ applications: [application(app)], problem: null, ...over });
export const proof = (over: Record<string, unknown> = {}) => ({ screenshotMode: "failed", video: false, ...over });
export const summary = (foundOver: Record<string, unknown> = {}, app: Record<string, unknown> = {}) => ({ found: found(foundOver, app), proof: proof(), runTimeoutMs: 600_000 });
export const draft = (over: Record<string, unknown> = {}, foundValue: unknown = found()) => ({ revision: 3, foundAt: BT_AT, found: foundValue, proof: proof(), runTimeoutMs: 600_000, locked: false, stale: false, ...over });
export const accounts = (rows: Array<[string, Record<string, unknown> | null]> = [["admin", null], ["viewer", null]]) => rows.map(([id, lastSignIn]) => ({ ...kind(id), lastSignIn }));
export const approval = () => ({ requestId: `setup-${BT_DIGEST.slice(0, 40)}-5`, revision: 5, artifactDigest: BT_DIGEST });
export const candidate = (over: Record<string, unknown> = {}) => ({ status: "ready", checkedAt: BT_AT, revision: 5, summary: summary(), approval: approval(), canApprove: true, ...over });
/** The page's read; `state` picks the common shapes and `over` changes any member. */
export function btView(state: "not-set-up" | "draft" | "checking" | "check-failed" | "waiting" | "on" | "paused" = "draft", over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { project: "payments", canManage: true, viewerRole: "owner", state, paused: state === "paused", sandboxAvailable: true, faults: [], setupWaiting: false, draft: null, candidate: null, approved: null, newerChange: null, accounts: [] };
  const approved = { revision: 6, approvedAt: "2026-11-23T05:10:00.000Z", approvedBy: "p-owner", decidedByYou: true, summary: summary() };
  const shapes: Record<string, Record<string, unknown>> = {
    "not-set-up": {},
    draft: { draft: draft(), accounts: accounts() },
    checking: { draft: draft({ locked: true }), candidate: candidate({ status: "checking", approval: null, canApprove: false }), accounts: accounts() },
    "check-failed": { draft: draft({ locked: true }), candidate: candidate({ status: "failed", failedStep: "npm ci", approval: null, canApprove: false }), accounts: accounts() },
    waiting: { draft: draft({ locked: true }), candidate: candidate(), accounts: accounts() },
    on: { approved, accounts: accounts() },
    paused: { approved, accounts: accounts() },
  };
  return { ...base, ...shapes[state], ...over };
}
