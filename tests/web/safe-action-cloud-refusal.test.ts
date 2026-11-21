// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { isFinalActionRefusal } from "../../packages/ui/src/safe-action.js";
import CORE_TASK_ROUTES from "../fixtures/code-core-task-routes.json" with { type: "json" };

const sid = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = CORE_TASK_ROUTES.page.taskId, person = "a".repeat(64), company = "org_aaaaaaaaaaaaaaaaaaaa";
const requestId = "22222222-2222-4222-8222-222222222222";
const route = (action: string) => `/v1/web/sessions/${sid}/${action}`;
type Source = "code" | "validation" | "missing" | "owner" | "nothing" | "security";
type Case = { path: string; status: number; code: string; source: Source; message: string; body?: unknown };
const cases: Case[] = [];
function add(path: string, status: number, code: string, source: Source = "code", message = `Code refused: ${code}`, body?: unknown) {
 cases.push({ path, status, code, source, message, ...(body === undefined ? {} : { body }) });
}
// Independent inventory of every allowlisted tuple, expanded over each route.
// Cloud-only errors come from Cloud itself; Code errors pass through its real
// handler/client/adapters using a synthetic Code transport (no network).
for (const action of ["stop", "close", "take-over", "retry", "send-back", "accept-findings", "answers"]) {
 const path = route(action);
 add(path, 400, "CONFIG_INVALID", "validation", "requestId must be a UUID.", { requestId: "invalid" });
 add(path, 404, "SESSION_NOT_FOUND", "missing", "That session doesn't exist, or you can't see it.");
}
for (const action of ["retry", "send-back", "accept-findings"]) {
 const path = route(action);
 const message = action === "retry" ? "Only Ada can retry this session." : `Only Ada or a co-owner can ${action === "send-back" ? "send this back to coding" : "accept these findings"}.`;
 add(path, 403, "FORBIDDEN", "owner", message);
 add(path, 409, "CONFLICT", "nothing", action === "retry" ? "There's nothing to retry on this session right now." : `There are no review findings to ${action === "send-back" ? "send back" : "accept"} right now.`);
}
add(route("retry"), 409, "IDEMPOTENCY_CONFLICT");
add(route("retry"), 403, "SESSION_LEVEL_REQUIRED");
add(route("retry"), 409, "CONFIG_INVALID");
for (const action of ["send-back", "accept-findings"]) {
 const path = route(action);
 add(path, 404, "NOT_FOUND", "code", "this task does not have a workflow record");
 add(path, 409, "PROJECT_ARCHIVED");
 for (const code of ["BUDGET_EXCEEDED", "ORG_BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "MACHINE_TIME_EXCEEDED"]) add(path, 402, code);
 add(path, 403, "TRIAL_LOCKED");
}
add(route("send-back"), 400, "CONFIG_INVALID", "validation", "The note is at most 1,000 characters.", { requestId, note: "n".repeat(1001) });
add(route("accept-findings"), 400, "CONFIG_INVALID", "validation", "Give a reason of up to 500 characters for accepting the findings.", { requestId, reason: "" });
add(route("accept-findings"), 409, "SECURITY_ACCEPT_NOT_HERE", "security", "Rovara accepts a security finding only on its own task page, and that isn't available for this task in Rovara Cloud yet. Nothing was accepted. Send the work back to coding to fix it.");
for (const path of [route("answers"), `/v1/web/tasks/${taskId}/answers`]) {
 for (const [status, code] of [[403, "FORBIDDEN"], [409, "IDEMPOTENCY_CONFLICT"], [409, "INTENT_NOT_WAITING"]] as const) add(path, status, code);
 // Exercise each exact Cloud validation sentence, not an upstream imitation.
 const valid = { requestId, round: 1, answers: [{ questionId: "q1", optionId: "a" }] };
 for (const [message, body] of [
  ["The answers must be a JSON object.", []],
  ["requestId must be a UUID.", { ...valid, requestId: "invalid" }],
  ["round must be a whole number from 1 to 1,000,000.", { ...valid, round: 0 }],
  ["revision must be a whole number from 0 to 1,000,000.", { ...valid, revision: -1 }],
  ["answers must list 1 to 3 answers.", { ...valid, answers: [] }],
  ["Each answer needs a questionId (q1 to q3) and an optionId (a to d), some text, or both.", { ...valid, answers: [{ questionId: "invalid", optionId: "a" }] }],
  ["An answer's text is 1 to 2,000 characters.", { ...valid, answers: [{ questionId: "q1", text: "" }] }],
 ] as const) add(path, 400, "CONFIG_INVALID", "validation", message, body);
}
for (const kind of ["approve_requirements", "approve_plan", "approve_design"]) {
 for (const action of ["approve", "request-changes", "reject"]) {
  for (const [status, code] of [[400, "CONFIG_INVALID"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [409, "CHANGE_STALE"], [409, "MERGE_NOT_READY"]] as const) add(`/v1/web/decisions/${kind}/task-a/${action}`, status, code);
 }
}
for (const [status, code] of [[409, "IDEMPOTENCY_CONFLICT"], [403, "FORBIDDEN"], [404, "TASK_NOT_FOUND"], [400, "CONFIG_INVALID"]] as const) add(route("merge"), status, code);
add(route("merge"), 404, "SESSION_NOT_FOUND", "missing", "That session doesn't exist, or you can't see it.");

afterEach(() => { localStorage.clear(); });
it.each(cases)("$path $status $code ($source): real Cloud answer remains final", async row => {
 const session: CodeSession = { accessToken: "synthetic", csrf: "csrf", signedInAt: new Date().toISOString(), access: { developerId: person, displayName: "Ada", administrator: false, companyId: company, companyRole: "owner", projects: [], notices: [] } };
 const store = new LocalSessionStore(undefined, { environment: {} }), work = new LocalWorkSessionStore();
 await store.create("cookie", session);
 if (row.source !== "missing") await work.put({ sessionId: sid, taskId, companyId: company, project: "alpha", startedBy: { developerId: person, name: "Ada" }, owner: { developerId: row.source === "owner" ? "b".repeat(64) : person, name: "Ada" }, revision: 1, createdAt: session.signedInAt });
 const writes: string[] = [];
 const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
 const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  if (path === "/v1/dev/access") return json(200, session.access);
  if ((init?.method ?? "GET") === "GET") {
   if (path.endsWith("/people")) return json(200, { view: { people: [] } });
   return json(200, { task: { ...CORE_TASK_ROUTES.page.blockedTask, status: "RUNNING", sessionId: sid, ...(row.source === "nothing" ? { workflow: undefined } : {}) } });
  }
  writes.push(path);
  if (row.source === "security") return path.endsWith("/workflow/review-findings") ? json(CORE_TASK_ROUTES.page.tokenRoute.status, CORE_TASK_ROUTES.page.tokenRoute.body) : json(403, { error: { code: "FORBIDDEN", message: "Web app required" } });
  expect(row.source).toBe("code");
  return json(row.status, { error: { code: row.code, message: row.message } });
 } });
 const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: company, name: "Acme", plan: "test" }, log: () => undefined });
 const body = row.body ?? { requestId, ...(row.path.endsWith("/merge") ? {} : { round: 1, answers: [{ questionId: "q1", optionId: "a" }], note: "Fix findings", reason: "Accept findings" }) };
 const answer = await handler({ method: "POST", path: row.path, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie", "x-rovara-csrf": "csrf" }, body: JSON.stringify(body) });
 const result = JSON.parse(answer!.body) as { error: { code: string; message: string } };
 expect([answer?.status, result.error.code, result.error.message]).toEqual([row.status, row.code, row.message]);
 expect(writes).toHaveLength(row.source === "code" ? 1 : row.source === "security" ? 2 : 0);
 const failure = new ApiError(answer!.status, result.error.code, result.error.message);
 expect(isFinalActionRefusal(failure, { route: row.path, pullCount: 1 })).toBe(true);
 expect(isFinalActionRefusal(failure, { route: row.path.replace("/v1/web/", "/v1/app/"), pullCount: 1 })).toBe(true);
 if (row.path.endsWith("/merge") && row.code === "CONFIG_INVALID") expect(isFinalActionRefusal(failure, { route: row.path, pullCount: 2 })).toBe(false);
});
