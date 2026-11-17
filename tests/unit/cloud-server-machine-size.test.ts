import { describe, expect, it } from "vitest";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";

const NOW = Date.UTC(2026, 10, 17, 18);
const path = "/projects/payments/machine-size";
const payload = (at: number) => `e30.${Buffer.from(JSON.stringify({ step_up_at: at, step_up_amr: "passkey" })).toString("base64url")}.sig`;
function context(method: "GET" | "POST", token = "no-step-up", codeStatus?: number, code = "NOT_FOUND", message = "route not found") {
  const calls: Array<{ path: string; options: unknown }> = [];
  const value: RouteContext = {
    client: { json: async (_session: unknown, requestPath: string, options: unknown) => { calls.push({ path: requestPath, options }); if (codeStatus !== undefined) throw new CodeError(codeStatus, { error: { code, message } }); return { measuredPeakMemoryMiB: 6144, testTimeMs: 120_000, suggestedSize: "arm64-4-16", currentSize: null, storedOnlyLine: "Stored only: Rovara does not launch this size yet.", choices: [] }; }, access: async () => ({ projects: [] }) } as never,
    session: { accessToken: token, access: { developerId: "person", displayName: "Person", administrator: false, projects: [{ name: "payments", access: "administrator" }], notices: [] } } as never,
    params: ["payments"], query: new URLSearchParams(), body: { rowId: "arm64-4-16" }, org: { orgId: "acme", name: "Acme", plan: "test" }, now: () => new Date(NOW),
    work: {} as never, origin: "https://cloud.example.test", presence: {} as never,
  };
  const route = ROUTES.find((row) => row.method === method && row.path.test(path));
  if (route === undefined) throw new Error("machine-size route missing");
  return { answer: () => route.answer(value), calls };
}

describe("Cloud machine-size route", () => {
  it("reads measurements and the stored choice from Code for a project member", async () => {
    const w = context("GET");
    const result = await w.answer();
    expect(result).toMatchObject({ status: 200, body: { measuredPeakMemoryMiB: 6144, suggestedSize: "arm64-4-16" } });
    expect(w.calls[0]?.path).toBe("/v1/dev/projects/payments/machine-size");
  });
  it("asks for a fresh step-up before forwarding the choice", async () => {
    const w = context("POST");
    expect(await w.answer()).toMatchObject({ status: 403, body: { error: { message: "Confirm it's you again, then try once more." } } });
    expect(w.calls).toHaveLength(0);
  });
  it("forwards a choice only with a fresh Code factor", async () => {
    const w = context("POST", payload(Math.floor(NOW / 1000) - 30));
    expect(await w.answer()).toMatchObject({ status: 200, body: { suggestedSize: "arm64-4-16" } });
    expect(w.calls[0]).toMatchObject({ path: "/v1/dev/projects/payments/machine-size", options: { method: "POST", body: { rowId: "arm64-4-16" } } });
  });
  it("maps a missing Code route to fixed not-set-up words", async () => {
    const w = context("GET", "no-step-up", 404);
    expect(await w.answer()).toMatchObject({ status: 501, body: { status: "not_set_up", message: "Machine size suggestions are not set up on Rovara Code yet." } });
  });
  it.each(["GET", "POST"] as const)("maps a removed project to project-not-found on %s", async (method) => {
    const w = context(method, payload(NOW / 1000 - 30), 404, "NOT_FOUND", "project not found");
    expect(await w.answer()).toMatchObject({ status: 404, body: { error: { code: "PROJECT_NOT_FOUND", message: "That project doesn't exist, or you can't use it." } } });
  });
  it.each(["GET", "POST"] as const)("maps Code unavailable to not-set-up on %s", async (method) => {
    const w = context(method, payload(NOW / 1000 - 30), 501, "NOT_AVAILABLE_HERE", "off");
    expect(await w.answer()).toMatchObject({ status: 501, body: { status: "not_set_up" } });
  });
  it.each(["FORBIDDEN", "REAUTH_REQUIRED"])("preserves Code's distinct %s refusal", async (code) => {
    const w = context("POST", payload(NOW / 1000 - 30), 403, code, "fixed refusal");
    await expect(w.answer()).rejects.toMatchObject({ status: 403, body: { error: { code, message: "fixed refusal" } } });
  });
  it("does not hide an unrelated Code 404", async () => {
    await expect(context("GET", "no-step-up", 404, "NOT_FOUND", "other fixed words").answer()).rejects.toMatchObject({ status: 404 });
  });

});
