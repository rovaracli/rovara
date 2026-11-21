import { expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, SignInEnded, createCloudHandler, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
const sid = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = "11111111-1111-4111-8111-111111111111", person = "a".repeat(64), companyId = "org_aaaaaaaaaaaaaaaaaaaa", digest = "b".repeat(64);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
async function world(options: { unreadable?: boolean; saveFailure?: "ended" | "plain" }) {
 const store = new LocalSessionStore(undefined, { environment: {} }), work = new LocalWorkSessionStore();
 const session: CodeSession = { accessToken: "synthetic", csrf: "csrf", signedInAt: new Date().toISOString(), access: { developerId: person, displayName: "Ada", administrator: false, companyId, companyRole: "owner", projects: [], notices: [] } };
 await store.create("cookie", session);
 if (options.saveFailure !== undefined) {
  const get = store.get.bind(store);
  store.get = async id => { const result = await get(id); if (result !== undefined) result.changed = true; return result; };
  store.save = async () => { throw options.saveFailure === "ended" ? new SignInEnded() : new Error("save failed"); };
 }
 await work.put({ sessionId: sid, taskId, companyId, project: "alpha", startedBy: { developerId: person, name: "Ada" }, owner: { developerId: person, name: "Ada" }, revision: 1, createdAt: new Date().toISOString() });
 let applied = 0;
 const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "synthetic", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  if (init?.method === "POST") { applied += 1; return options.unreadable === true ? new Response("not JSON", { status: 200 }) : json(200, { task: { taskId } }); }
  if (path === "/v1/app/decisions") return json(200, { cards: [] });
  return json(200, { task: { taskId, project: "alpha", title: "A task", status: "RUNNING", workflow: { ...createWorkflowSnapshot({ taskId, ownerId: person, now: "2026-11-20T00:00:00.000Z", path: "QUICK" }), revision: 4, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [{ id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "planner", objectKey: "plan.md", createdAt: "2026-11-20T00:00:00.000Z" }] } } });
 } });
 const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: "acme", name: "Acme", plan: "test" }, log: () => undefined });
 return { applied: () => applied, send: () => handler({ method: "POST", path: `/v1/app/approve/plan-${sid}`, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie", origin: "https://cloud.example.test", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "csrf", revision: "4", digest, decision: "APPROVE" }).toString() }) };
}
it("approval's unreadable Code success stays unknown instead of claiming a decided plan", async () => {
 const w = await world({ unreadable: true }), answer = await w.send();
 expect(answer?.status).toBe(503); expect(answer?.body).toContain("outcome is unknown"); expect(w.applied()).toBe(1);
});
it.each(["ended", "plain"] as const)("approval's %s final-save error stays unknown after Code applied", async saveFailure => {
 const w = await world({ saveFailure }), answer = await w.send();
 expect(answer?.status).toBe(503); expect(answer?.body).toContain("outcome is unknown"); expect(w.applied()).toBe(1);
});
