import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { INTAKE_UPDATES_ROUTES } from "../../packages/cloud-server/src/intake-updates-routes.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";

const view = { settings: { comments: true, changeStatus: false, statuses: {}, level: "full" }, canEdit: true, access: [] };
const read = INTAKE_UPDATES_ROUTES.find(route => route.method === "GET")!;
const write = INTAKE_UPDATES_ROUTES.find(route => route.method === "PUT")!;
function context(project: string, companyId: string, json: ReturnType<typeof vi.fn>): RouteContext {
 const session = { access: { companyId } };
 return { client: { json } as never, session: session as never, params: [project], query: new URLSearchParams(), body: {}, org: { orgId: companyId, name: "Company", plan: "test" }, now: () => new Date(), work: {} as never, origin: "https://app.example", presence: {} as never };
}

describe("intake ticket update route pass-through", () => {
 it("keeps reads and writes in the signed-in person's company and selected project", async () => {
  for (const [companyId, project] of [["org_a", "api"], ["org_b", "web"]] as const) {
   const json = vi.fn(async () => view), ctx = context(project, companyId, json);
   expect(await read.answer(ctx)).toEqual({ status: 200, body: view });
   expect(json).toHaveBeenCalledWith(ctx.session, `/v1/app/projects/${project}/intake/updates`);
   const body = { requestId: randomUUID(), settings: { comments: true, changeStatus: false, statuses: {}, level: "decisions" } };
   ctx.body = body;
   expect(await write.answer(ctx)).toEqual({ status: 200, body: view });
   expect(json).toHaveBeenLastCalledWith(ctx.session, `/v1/app/projects/${project}/intake/updates`, { method: "PUT", body });
  }
 });

 it("refuses malformed writes before forwarding", async () => {
  const json = vi.fn(), ctx = context("web", "org_a", json);ctx.body = { requestId: "not-a-uuid", settings: {} };
  expect(await write.answer(ctx)).toMatchObject({ status: 400 });
  expect(json).not.toHaveBeenCalled();
 });

 it.each([
  [new CodeError(403, { error: { message: "secret Code refusal" } }), 403, "Only project admins can change ticket update settings."],
  [new CodeError(409, { error: { message: "secret conflict" } }), 409, "Ticket update settings changed. Look again, then try once more."],
  [new CodeError(503, { error: { message: "secret outage" } }), 503, "Ticket update settings couldn't be read just now. Try again."],
  [new CodeError(405, { error: { message: "secret method" } }), 501, "Ticket update settings aren't available on this Rovara yet."],
  [new CodeError(404, { error: { code: "NOT_FOUND", message: "route not found" } }), 501, "Ticket update settings aren't available on this Rovara yet."],
  [new CodeError(404, { error: { code: "NOT_FOUND", message: "project not found" } }), 404, "project not found"],
 ])("maps Code refusals to fixed words", async (error, status, message) => {
  const ctx = context("web", "org_a", vi.fn(async () => { throw error; }));
  expect(await read.answer(ctx)).toEqual({ status, body: { error: { code: expect.any(String) as unknown, message } } });
 });

 it("answers an unreadable Code response with 503", async () => {
  const ctx = context("web", "org_a", vi.fn(async () => ({ nope: "Code text" })));
  expect(await read.answer(ctx)).toMatchObject({ status: 503, body: { error: { message: "Ticket update settings couldn't be read just now. Try again." } } });
 });
});
