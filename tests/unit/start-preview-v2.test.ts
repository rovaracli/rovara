import { PreviewV2Schema, PreviewRequestV2Schema, TaskStopStartPreviewSchema } from "../../packages/contracts/src/task-stop-start-preview.js";
import { describe, expect, it, vi } from "vitest";
import { SAVED_ENV_ROUTES } from "../../packages/cloud-server/src/saved-env-routes.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { quoteFixture } from "../support/start-preview-fixture.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa";
const preview = SAVED_ENV_ROUTES.find(r => r.path.test("/projects/web/start-preview"))!;
function context(body: unknown, raw: unknown = quoteFixture(), projects = [{ name: "web" }]) {
 const json = vi.fn(async () => raw);
 return { jsonMock: json, params: ["web"], body, now: () => new Date("2026-11-18T12:00:00.000Z"), client: { access: async () => ({ companyId: orgId, companyRole: "member", developerId: "a".repeat(64), displayName: "Ada", projects }), json }, session: {} } as unknown as RouteContext & { jsonMock: typeof json };
}
describe("negotiated start preview", () => {
 it.each([{}, { path: "QUICK" }, { requestId: "11111111-1111-4111-8111-111111111111", path: "FULL" }])("keeps old request bytes unchanged for %j", async body => {
  const c = context(body);
  const r = await preview.answer(c);
  expect(JSON.stringify(r)).toBe('{"status":200,"body":{"orgId":"org_aaaaaaaaaaaaaaaaaaaa","project":"web","kind":"unknown"}}');
  expect(c.jsonMock).not.toHaveBeenCalled();
 });
 it("forwards only the opt-in body as the person and refuses wrong-company or malformed quotes", async () => {
  const body = { quoteVersion: 2, inputText: "Fix it", options: { eval: true } };
  const c = context(body);
  const r = await preview.answer(c);
  expect(r).toEqual({ status: 200, body: quoteFixture() });
  expect(c.jsonMock).toHaveBeenCalledWith(c.session, "/v1/dev/projects/web/start-estimates", { method: "POST", body });
  for (const raw of [{ ...quoteFixture(), orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, { ...quoteFixture(), options: [] }, { ...quoteFixture(), currency: "EUR" }]) expect((await preview.answer(context(body, raw))).status).toBe(502);
 });
 it("does not negotiate for a project the person cannot use and rejects browser policy facts", async () => {
  const c = context({ quoteVersion: 2 }, quoteFixture(), []);
  expect((await preview.answer(c)).status).toBe(404);expect(c.jsonMock).not.toHaveBeenCalled();
  for (const body of [{ quoteVersion: 3 }, { quoteVersion: 2, source: "own" }, { quoteVersion: 2, options: { eval: "yes" } }, { quoteVersion: 2, inputText: "x".repeat(4001) }]) expect((await preview.answer(context(body))).status).toBe(400);
 });
});

it("keeps strict legacy and negotiated schemas separate and rejects invalid money", () => {
 const q = quoteFixture();
 expect(PreviewV2Schema.safeParse(q).success).toBe(true);
 expect(TaskStopStartPreviewSchema.safeParse(q).success).toBe(false);
 expect(PreviewRequestV2Schema.safeParse({ quoteVersion: 2, options: { secondReview: true } }).success).toBe(true);
 expect(PreviewRequestV2Schema.safeParse({ quoteVersion: 2, inputText: "x".repeat(4001) }).success).toBe(false);
 expect(PreviewV2Schema.safeParse({ ...q, options: q.options.map(o => ({ ...o, initialHoldMicros: { state: "available", value: 0.1 } })) }).success).toBe(false);
});
