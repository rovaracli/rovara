import { AppMeResponseReaderSchema, ScriptTokenMetadataListSchema, ProjectSetupChecklistSchema, SetupAgentViewSchema, SetupJournalReplySchema, AgentDirectoryResponseReaderSchema, GithubConnectionsResponseReaderSchema, SlackWorkspaceResponseReaderSchema } from "@agentx/contracts/web";
import { readMyGithub } from "../../../../packages/ui/src/api/github-link.js";
import { readMySignIns } from "../../../../packages/ui/src/api/sign-ins.js";
import { readLessonsSlackSwitch } from "../../../../packages/ui/src/api/lessons-slack.js";
import type { ApiRequest, ApiResponse } from "../../../../packages/ui/src/host.js";

export const identity = AppMeResponseReaderSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "member", nameChosen: true }, org: { orgId: "org_fixture", name: "Acme", plan: "team" }, identities: [] });
export const github = readMyGithub({ linked: true, login: "priya-dev", linkedAt: "2026-11-17T12:00:00Z" });
export const signIns = readMySignIns({ signIns: [{ method: "slack", primary: true }] });
export const learning = readLessonsSlackSwitch({ optOut: true });
export const keys = ScriptTokenMetadataListSchema.parse({ canCreate: true, tokens: ["active", "expired", "revoked"].map((status, i) => ({ tokenId: `stk_${String(i).repeat(20)}`, name: i === 0 ? "Nightly CI" : `Build ${status}`, hint: "rvst_…aaaaaaaa", projects: ["web"], permissions: ["read", "wiki"], createdAt: "2026-11-17T12:00:00Z", expiresAt: "2026-12-17T12:00:00Z", status, mine: true })) });
export const checklist = ProjectSetupChecklistSchema.parse({
 project: "web", viewer: { companyRole: "member", projectAdmin: false, canSkip: false },
 progress: { done: 2, total: 8, percent: 25, nextRequired: "setupRun" },
 repos: { state: "done", count: 1, items: [{ name: "web", defaultBranch: "main" }] },
 setupRun: { state: "running", status: "running", approval: "none", commandsRun: 2 },
 evalConfirm: { state: "needs_you", report: "none", blockedBy: "setupRun" },
 aiAndSpend: { state: "done", source: "company", companyModelSaved: true, modelBudgetUsd: null },
 slackChannel: { state: "skipped", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" },
 firstTask: { state: "needs_you", hasTask: false, canStart: false },
});
export const run = SetupAgentViewSchema.parse({ status: "running", basedOnRevision: 3, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 } });
export const journal = SetupJournalReplySchema.parse({ status: "running", entries: [{ n: 1, source: "agent", command: "npm run check", exitCode: null, durationMs: 1200, timedOut: false, flagged: false, blockedHosts: ["registry.npmjs.org"], tail: "Waiting for registry", startedAt: "2026-11-17T12:00:00Z" }], hostAsks: [{ host: "registry.npmjs.org", status: "open" }] });
const workflow = { agentId: "rovara-code", name: "Rovara Code", description: "Build and check changes", builtin: true, access: "use", status: "active", latestVersion: 1 };
export const offered = AgentDirectoryResponseReaderSchema.parse({ agents: [workflow, { ...workflow, agentId: "review", name: "Review", builtin: false }] });
export const connections = GithubConnectionsResponseReaderSchema.parse({ installations: [{ installationId: 11, accountLogin: "acme", status: "active", connectedAt: "2026-11-17T12:00:00Z", connectedBy: { kind: "operator" } }] });
export const slack = SlackWorkspaceResponseReaderSchema.parse({ workspace: null });
export const refusal = (status: number): ApiResponse => ({ status, body: { error: { code: "READ_UNAVAILABLE", message: "PRIVATE ERROR DETAIL" } } });
export function respond(request: ApiRequest): ApiResponse {
 if (request.method !== "GET") throw new Error("G5 attempted a write");
 const body: unknown = ({ "/v1/app/me": identity, "/v1/app/me/github": github, "/v1/app/me/sign-ins": signIns, "/v1/app/me/lessons-slack": learning, "/v1/app/script-tokens": keys,
 "/v1/app/projects/web/setup-status": checklist, "/v1/app/projects/web/setup-agent": run,
 "/v1/app/projects/web/setup-agent/journal": journal, 
 "/v1/app/agents?scope=all": offered, "/v1/app/github/connections": connections, "/v1/app/slack": slack } as Record<string, unknown>)[request.path];
 return body === undefined ? refusal(404) : { status: 200, body };
}
