import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PreviewV2Schema, PreviewRequestV2Schema, TaskStopStartPreviewSchema } from "../../packages/contracts/src/task-stop-start-preview.js";
import { describe, expect, it, vi } from "vitest";
import { SAVED_ENV_ROUTES } from "../../packages/cloud-server/src/saved-env-routes.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { quoteFixture } from "../support/start-preview-fixture.js";
import { restrictPreviewV2, parsePreviewV2 } from "../../packages/contracts/src/start-estimates.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa";
const preview = SAVED_ENV_ROUTES.find(r => r.path.test("/projects/web/start-preview"))!;
function context(body: unknown, raw: unknown = quoteFixture(), projects = [{ name: "web" }], role = "member") {
 const json = vi.fn(async () => raw);
 return { jsonMock: json, params: ["web"], body, now: () => new Date("2026-11-18T12:00:00.000Z"), client: { access: async () => ({ companyId: orgId, companyRole: role, developerId: "a".repeat(64), displayName: "Ada", projects }), json }, session: {} } as unknown as RouteContext & { jsonMock: typeof json };
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
  const c = context(body, quoteFixture(), [{ name: "web" }], "admin");
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

it("strips company numbers throughout member JSON and leaves admin and owner quotes unchanged", async () => {
 const raw = quoteFixture();
 const sentinels = [9100011, 8100013, 7100017, 6100019];
 for (const q of raw.options) Object.assign(q, {
  initialHoldMicros: { state: "available", value: 6100019 },
  planningAllowanceMicros: { state: "available", value: 10000000 },
  limits: [{ scope: "engine_day", maximumMicros: { state: "available", value: 9100011 }, availableMicros: { state: "available", value: 8100013 }, heldMicros: { state: "available", value: 7100017 }, resetAt: { state: "unavailable", reason: "not_measured" } }],
  firstBindingLimit: { state: "available", value: { scope: "engine_day", appliesAt: "start", requiredMicros: { state: "available", value: 6100019 }, availableMicros: 8100013, blocked: false, reason: "tightest_known" } },
 });
 const numbers = (v: unknown): number[] => typeof v === "number" ? [v] : v !== null && typeof v === "object" ? Object.values(v).flatMap(numbers) : [];
 const member = await preview.answer(context({ quoteVersion: 2 }, raw));
 expect(member.status).toBe(200);
 for (const q of (member.body as { options: Array<{ firstBindingLimit: unknown }> }).options) {
  expect(q.firstBindingLimit).toEqual({ state: "available", value: { scope: "RESTRICTED", bindingScope: "engine_day", blocked: false } });
  expect(numbers(q.firstBindingLimit)).toEqual([]);
 }
 expect(numbers(JSON.parse(JSON.stringify(member.body))).filter(n => sentinels.includes(n))).toEqual([]);
 expect(PreviewV2Schema.safeParse(member.body).success).toBe(true);
 expect(numbers(member.body)).toEqual([2, 1_000_000, 3_000_000, 4_000_000, 10_000_000]);
 for (const extra of [{ spentMicros: 123 }, { planningAllowanceMicros: { state: "available", value: 123 } }, { companyRemainingMicros: 123 }, { taskMaximumMicros: { state: "available", value: -1 } }]) {
  const bad = structuredClone(member.body) as { options: object[] };
  for (const q of bad.options) Object.assign(q, extra);
  expect(PreviewV2Schema.safeParse(bad).success).toBe(false);
 }
 for (const role of ["owner", "admin"]) expect(await preview.answer(context({ quoteVersion: 2 }, raw, [{ name: "web" }], role))).toEqual({ status: 200, body: raw });
});


it.each([true, false, null])("accepts and preserves an already restricted Code quote (%s), strictly", async blocked => {
 const raw = restrictPreviewV2(parsePreviewV2(quoteFixture())!);
 for (const q of raw.options) Object.assign(q, { firstBindingLimit: { state: "available", value: { scope: "RESTRICTED", blocked, bindingScope: "engine_day" } } });
 expect(PreviewV2Schema.safeParse(raw).success).toBe(true);
 expect(await preview.answer(context({ quoteVersion: 2 }, raw))).toEqual({ status: 200, body: raw });
 for (const extra of [{ availableMicros: 42 }, { requiredMicros: 42 }, { blocked: "false" }, { bindingScope: "other" }, { bindingScope: 42 }]) {
  const bad = structuredClone(raw);
  for (const q of bad.options) Object.assign(q, { firstBindingLimit: { state: "available", value: { scope: "RESTRICTED", blocked, ...extra } } });
  expect(PreviewV2Schema.safeParse(bad).success).toBe(false);
  expect((await preview.answer(context({ quoteVersion: 2 }, bad))).status).toBe(502);
 }
});


it("pins the mirrored PreviewV2 contract and member boundary", () => {
 const bytes = readFileSync("packages/contracts/src/start-estimates.ts");
 expect(createHash("sha256").update(bytes).digest("hex")).toBe("b426600eeed7ab865ba75dcf658fc93f2a7a857296dc185d3ec72f29388b320c");
 expect(readFileSync("packages/cloud-server/src/start-estimates.ts")).toEqual(bytes);
});


it("keeps the own-task maximum through Cloud restriction without remaining or held amounts", async () => {
 const raw = quoteFixture();
 for (const q of raw.options) Object.assign(q, { limits: [{ scope: "project_task", maximumMicros: { state: "available", value: 12_000_000 }, availableMicros: { state: "available", value: 8_100_013 }, heldMicros: { state: "available", value: 7_100_017 }, resetAt: { state: "unavailable", reason: "not_measured" } }] });
 const answer = await preview.answer(context({ quoteVersion: 2 }, raw));
 expect(answer.status).toBe(200);
 const q = answer.body as { options: object[] };
 for (const option of q.options) expect(option).toMatchObject({ taskMaximumMicros: { state: "available", value: 12_000_000 } });
 expect(JSON.stringify(answer.body)).not.toMatch(/8100013|7100017|planningAllowanceMicros|stages|basis/);
});
