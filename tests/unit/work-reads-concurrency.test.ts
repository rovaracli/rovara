import { expect, it } from "vitest";
import { WORK_READS } from "../../packages/cloud-server/src/work-reads.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";

it("N6 Work keeps at most six fallback Code reads in flight, preserving all 100 rows and their order", async () => {
 const rows = Array.from({ length: 100 }, (_, i) => ({ taskId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, title: `Task ${String(i)}`, project: "web", status: "RUNNING", createdAt: "a", updatedAt: "b" }));
 let active = 0, peak = 0, pages = 0;
 const seen: string[] = [];
 const client = { json: async (_session: unknown, path: string) => {
  if (path.startsWith("/v1/dev/tasks?")) { pages++;return { tasks: rows.slice((pages - 1) * 50, pages * 50), ...(pages === 1 ? { nextCursor: "page2" } : {}) }; }
  active++;peak = Math.max(peak, active);seen.push(path);
  await new Promise(resolve => setTimeout(resolve, seen.length % 3));active--;
  return { task: {} };
 } };
 const route = WORK_READS.find(r => r.method === "GET" && r.path.test("/sessions"))!;
 const result = await route.answer({ client, session: { access: { developerId: "d".repeat(64) } }, work: { startedBy: async () => [] } } as unknown as RouteContext);
 expect(peak).toBe(6);expect(active).toBe(0);expect(pages).toBe(2);expect(seen).toHaveLength(100);
 expect((result.body as { tasks: unknown[] }).tasks).toStrictEqual(rows.map(row => ({ ...row, pullRequests: [], detail: "unread" })));
});

it("N6 bounded workers preserve served runs, optional failures and rows that need no read", async () => {
 const run = { state: "RUNNING", currentStep: { id: "build", name: "Build" }, steps: [], pendingApprovals: [] };
 const rows = Array.from({ length: 4 }, (_, i) => ({ taskId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, title: `Task ${String(i)}`, project: "web", status: i === 0 ? "CLOSED" : "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, createdAt: "a", updatedAt: "b", ...(i === 1 ? { run } : {}) }));
 const seen: string[] = [];
 const client = { json: async (_session: unknown, path: string) => {
  if (path.startsWith("/v1/dev/tasks?")) return { tasks: rows };
  seen.push(path);
  if (path.includes(rows[3]!.taskId)) throw new Error("optional read refused");
  return { task: { taskId: rows[2]!.taskId, status: "RUNNING", run } };
 } };
 const route = WORK_READS.find(r => r.method === "GET" && r.path.test("/sessions"))!;
 const result = await route.answer({ client, session: { access: { developerId: "d".repeat(64) } }, work: { startedBy: async () => [] } } as unknown as RouteContext);
 // TASK-STATUS-TRUTH (work-reads.ts:129): a summary workflow with no definitionId cannot prove the built-in order, so workTask marks it programmed:true.
 expect(seen).toEqual(rows.slice(2).map(row => `/v1/dev/tasks/${row.taskId}?events=0`));
 expect((result.body as { tasks: unknown[] }).tasks).toStrictEqual(rows.map((row, i) => ({ ...row, workflow: { ...row.workflow, programmed: true }, pullRequests: [], ...(i === 2 ? { run } : {}) })));
});
