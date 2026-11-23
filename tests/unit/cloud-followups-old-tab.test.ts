import { expect, it, vi } from "vitest";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { LocalWorkSessionStore } from "../../packages/cloud-server/src/work-sessions.js";

const id = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222", owner = "a".repeat(64), digest = "d".repeat(64);
const task = { taskId, title: "Review", project: "web", status: "SUCCEEDED", createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", workflow: { stage: "REVIEW", state: "BLOCKED", revision: 16, candidate: { digest }, verification: { candidateDigest: digest, reviewOnly: true, results: [] }, reviews: [{ role: "CRITIC", status: "FINDINGS", candidateDigest: digest, findings: [{ origin: "INTRODUCED", advisory: false, text: "Shown finding" }] }] } };
async function setup(action: string, pins: object) {
 const work = new LocalWorkSessionStore();
 await work.put({ sessionId: id, taskId, project: "web", owner: { developerId: owner, name: "Ada" }, startedBy: { developerId: owner, name: "Ada" }, createdAt: task.createdAt, revision: 1 });
 const json = vi.fn<(session: unknown, path: string, init?: { method?: string }) => Promise<{ task: typeof task }>>(async () => ({ task }));
 const context = { client: { json }, session: { access: { developerId: owner, displayName: "Ada" } }, params: [id], body: { requestId, note: "Fix it", reason: "Reviewed it", ...pins }, work, presence: { viewing: async () => [] }, now: () => new Date(task.createdAt), origin: "https://cloud.example.test" } as unknown as RouteContext;
 const route = ROUTES.find(r => r.method === "POST" && r.path.test(`/sessions/${id}/${action}`))!;
 let result;
 try { result = await route.answer(context); } catch (e) { if (!(e instanceof CodeError)) throw e;result = { status: e.status, body: e.body }; }
 return { result, posts: json.mock.calls.filter(([, , init]) => init?.method === "POST") };
}
for (const action of ["send-back", "accept-findings"]) {
 for (const pins of [{}, { expectedRevision: 16 }, { candidateDigest: digest }, { expectedRevision: "16", candidateDigest: digest }, { expectedRevision: -1, candidateDigest: digest }, { expectedRevision: 1.5, candidateDigest: digest }, { expectedRevision: 16, candidateDigest: 12 }, { expectedRevision: 16, candidateDigest: "bad" }]) it(`N4 ${action}: missing or invalid pins ${JSON.stringify(pins)} refuse before Code and tell an old bundle to reload`, async () => {
  const s = await setup(action, pins);
  expect(s.result).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "This page is out of date. Reload to continue." } } });expect(s.posts).toHaveLength(0);
 });
 it(`N4 ${action}: documented pinned requests still work without resending or replacing inputs`, async () => {
  const s = await setup(action, { expectedRevision: 16, candidateDigest: digest });
  expect(s.result.status).toBe(200);expect(s.posts).toHaveLength(1);
  expect(s.posts[0]?.[2]).toMatchObject({ method: "POST", body: { requestId, expectedRevision: 16 } });
  if (action === "accept-findings") expect(s.posts[0]?.[2]).toMatchObject({ body: { candidateDigest: digest } });
 });
}
