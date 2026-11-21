// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { CORE_ACTION_WORDS } from "../../packages/cloud-server/src/core-task-actions.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { actionLock, actionSubject, createActionRecords, fenceFor, handleActionFailure } from "../../packages/ui/src/safe-action.js";
import { parseAccepted, parsePending, type AcceptedAnswer, type PendingPress } from "../../packages/ui/src/screens/session/merge-pending.js";
import CORE_TASK_ROUTES from "../fixtures/code-core-task-routes.json" with { type: "json" };

const sid = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = CORE_TASK_ROUTES.page.taskId, person = "a".repeat(64), company = "org_aaaaaaaaaaaaaaaaaaaa";
const subject = actionSubject({ orgId: company, developerId: person, subjectId: sid });
const route = (action: string) => `/v1/web/sessions/${sid}/${action}`;
const limit = "workspace operation read limit exceeded (10 reads, each up to 1 MB, plus a completion probe)";
const cases: Array<[string, string, number, string, string]> = [
 // Code dev-routes.ts:649-650 projects AFTER answer-request.ts:120-134 commits.
 ["session answers projection", route("answers"), 400, "CONFIG_INVALID", limit],
 ["task answers projection", `/v1/web/tasks/${taskId}/answers`, 400, "CONFIG_INVALID", limit],
 // dev-routes.ts:602-606 and :631-633 reload access/project AFTER the workflow commit.
 ["send-back projection", route("send-back"), 400, "CONFIG_INVALID", limit],
 ["send-back access reload", route("send-back"), 404, "TASK_NOT_FOUND", "no such task"],
 ["findings projection", route("accept-findings"), 400, "CONFIG_INVALID", limit],
 ["findings access reload", route("accept-findings"), 404, "TASK_NOT_FOUND", "no such task"],
 ["page findings projection", route("accept-findings"), 400, "CONFIG_INVALID", limit],
 ["page findings access reload", route("accept-findings"), 404, "TASK_NOT_FOUND", "no such task"],
 // Legacy review queues work then reauthorizes (developer-tasks.ts:3177-3185).
 ["retry access reload", route("retry"), 404, "TASK_NOT_FOUND", "no task here that you can see"],
 ["retry task view", route("retry"), 400, "CONFIG_INVALID", limit],
 // Core session-routes.ts:166-167, :193-195 calls access.of/view AFTER control.retry.
 ["core retry projection", route("retry"), 400, "CONFIG_INVALID", limit],
 ["core retry missing task", route("retry"), 404, "NOT_FOUND", "There is no such session."],
 ["core retry unreadable owner", route("retry"), 403, "TASK_ACCESS_DENIED", "Rovara can't tell who owns this task right now, so it did nothing."],
];

function records() {
 return createActionRecords({ lockPrefix: "postcommit.claim:", pendingPrefix: "postcommit.pending:", acceptedPrefix: "postcommit.accepted:", changedEvent: "postcommit-changed", parsePending, parseAccepted, pendingSubject: (p: PendingPress) => p.sessionId, acceptedSubject: (a: AcceptedAnswer) => a.subject, canonicalAccepted: (a: AcceptedAnswer) => ({ ...a }) });
}
afterEach(() => { localStorage.clear();vi.restoreAllMocks(); });

it.each(cases)("%s: Code commits once then its FIRST response is %s %s %s; the press stays HELD across reload", async (scenario, path, status, code, message) => {
 const pending: PendingPress = { v: 1, sessionId: subject, requestId: "22222222-2222-4222-8222-222222222222", startedAt: new Date().toISOString(), heads: [{ repositoryId: "acme/repo", number: 1, headSha: "a".repeat(40) }], risk: "high", sent: ["shown"] };
 const saved = records(), fence = fenceFor(new QueryClient(), subject, scenario), read = vi.fn(async () => undefined), words = vi.fn();
 expect(saved.writePending(pending)).toBe(true);
 const before = localStorage.getItem("postcommit.pending:" + subject);
 const session: CodeSession = { accessToken: "synthetic", csrf: "csrf", signedInAt: new Date().toISOString(), access: { developerId: person, displayName: "Ada", administrator: false, companyId: company, companyRole: "owner", projects: [], notices: [] } };
 const store = new LocalSessionStore(undefined, { environment: {} }), work = new LocalWorkSessionStore();
 await store.create("cookie", session);
 await work.put({ sessionId: sid, taskId, companyId: company, project: "alpha", startedBy: { developerId: person, name: "Ada" }, owner: { developerId: person, name: "Ada" }, revision: 1, createdAt: pending.startedAt });
 let applied = 0;
 const writes: string[] = [];
 const json = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s });
 const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input).pathname;
  if (target === "/v1/dev/access") return json(200, session.access);
  if ((init?.method ?? "GET") === "GET") return json(200, { task: { ...CORE_TASK_ROUTES.page.blockedTask, status: "RUNNING", sessionId: sid } });
  writes.push(target);
  // These are the real pre-apply fallbacks, before the one simulated committed call.
  if (scenario.startsWith("core retry") && target.endsWith("/workflow/review")) return json(404, CORE_TASK_ROUTES.page.notOnCore.body);
  if (scenario.startsWith("page findings") && target.endsWith("/workflow/review-findings")) return json(CORE_TASK_ROUTES.page.tokenRoute.status, CORE_TASK_ROUTES.page.tokenRoute.body);
  // Models the source-traced Code commit -> projection failure; not a full Code runtime execution.
  applied += 1;
  return json(status, { error: { code, message } });
 } });
 const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: company, name: "Acme", plan: "test" }, log: () => undefined });
 const answer = await handler({ method: "POST", path, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie", "x-rovara-csrf": "csrf" }, body: JSON.stringify({ requestId: pending.requestId, round: 1, answers: [{ questionId: "q1", optionId: "a" }], reason: "Accept this finding", note: "Fix this finding" }) });
 expect(answer).toBeDefined();
 const body = JSON.parse(answer!.body) as { error: { code: string; message: string } };
 const mapped = scenario === "page findings access reload" ? [403, "FORBIDDEN", CORE_ACTION_WORDS.acceptNotYours] : scenario === "core retry missing task" ? [403, "FORBIDDEN", CORE_ACTION_WORDS.retryRefused] : [status, code, message];
 expect([answer!.status, body.error.code, body.error.message]).toEqual(mapped);
 expect(applied).toBe(1);
 expect(writes).toHaveLength(scenario.startsWith("core retry") || scenario.startsWith("page findings") ? 2 : 1);
 expect(handleActionFailure({ route: path, failure: new ApiError(answer!.status, body.error.code, body.error.message), entry: pending, subject, fence, records: saved, message: words, read, readIdentity: read })).toBe("unknown");
 expect(localStorage.getItem("postcommit.pending:" + subject)).toBe(before);
 expect(saved.readPendingNow(subject)).toEqual({ kind: "pending", entry: pending, stale: false });
 expect(actionLock({ unresolved: true, drift: false, ready: true })).toBe("unresolved");
 const reloaded = records();
 expect(reloaded.readPendingNow(subject)).toEqual({ kind: "pending", entry: pending, stale: false });
 expect(reloaded.claimPending({ ...pending, requestId: "33333333-3333-4333-8333-333333333333" }, () => undefined, "storage").stop).toBe(true);
 expect(read).not.toHaveBeenCalled();expect(words).not.toHaveBeenCalled();
 expect(applied).toBe(1);
});
