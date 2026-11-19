import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { KnownFailingMarksAnswerReaderSchema, KnownFailingUndoAnswerReaderSchema } from "../../packages/contracts/src/app-known-failing.js";
import { KNOWN_FAILING_ROUTES } from "../../packages/cloud-server/src/known-failing-routes.js";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/code-known-failing.json", import.meta.url), "utf8")) as { read: unknown; undo: Record<string, unknown>; undone: unknown };
const context = (reply: unknown, body?: unknown) => {
  const session = { accessToken: "website-session" };
  const json = vi.fn(async () => reply);
  return { ctx: { client: { json }, session, params: ["payments"], query: new URLSearchParams("company=foreign"), body } as unknown as RouteContext, json, session };
};
describe("known-failing Cloud forwards, generated Code release answers", () => {
  it("registers GET and Undo POST and keeps the retired company policy unavailable", () => {
    for (const method of ["GET", "POST"]) expect(ROUTES.some((route) => route.method === method && route.path.test("/projects/payments/known-failing"))).toBe(true);
    expect(ROUTES.some((route) => route.path.test("/org/known-failing-policy"))).toBe(false);
  });
  it("reads the Code snapshot as the website person and strips unknown fields", async () => {
    const c = context({ ...(fixture.read as object), secretField: "drop" });
    const result = await KNOWN_FAILING_ROUTES[0]!.answer(c.ctx);
    expect(result).toEqual({ status: 200, body: fixture.read });
    expect(KnownFailingMarksAnswerReaderSchema.parse(result.body)).toEqual(fixture.read);
    expect(c.json).toHaveBeenCalledWith(c.session, "/v1/app/projects/payments/known-failing", undefined);
  });
  it("forwards only an exact Undo and validates the Code answer", async () => {
    const c = context(fixture.undone, fixture.undo);
    const result = await KNOWN_FAILING_ROUTES[1]!.answer(c.ctx);
    expect(result.status).toBe(200);
    expect(KnownFailingUndoAnswerReaderSchema.parse(result.body)).toEqual(fixture.undone);
    expect(c.json).toHaveBeenCalledWith(c.session, "/v1/app/projects/payments/known-failing", { method: "POST", body: fixture.undo });
  });
  it.each([{ action: "mark", names: ["invented"] }, { ...fixture.undo, companyId: "foreign" }, { ...fixture.undo, role: "owner" }])("refuses invented writes before Code", async (body) => {
    const c = context(fixture.undone, body);
    expect((await KNOWN_FAILING_ROUTES[1]!.answer(c.ctx)).status).toBe(400);
    expect(c.json).not.toHaveBeenCalled();
  });
  it("refuses an unreadable mark set whole", async () => {
    const c = context({ max: 500, marks: [{ name: "partial" }] });
    expect((await KNOWN_FAILING_ROUTES[0]!.answer(c.ctx)).status).toBe(502);
  });
});
