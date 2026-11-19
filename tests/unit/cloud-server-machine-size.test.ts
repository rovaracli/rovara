import { describe, expect, it } from "vitest";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";

const NOW = Date.UTC(2026, 10, 17, 18);
const path = "/projects/payments/machine-size";
const payload = (at: number) => `e30.${Buffer.from(JSON.stringify({ step_up_at: at, step_up_amr: "passkey" })).toString("base64url")}.sig`;
function context(method: "GET" | "POST", token = "no-step-up", codeStatus?: number, code = "NOT_FOUND", message = "route not found", projects: Array<{ name: string; access: string }> = [{ name: "payments", access: "administrator" }], liveProjects = projects) {
  const calls: Array<{ path: string; options: unknown }> = [];
  const value: RouteContext = {
    client: { json: async (_session: unknown, requestPath: string, options: unknown) => { calls.push({ path: requestPath, options }); if (codeStatus !== undefined) throw new CodeError(codeStatus, { error: { code, message } }); return { measuredPeakMemoryMiB: 6144, testTimeMs: 120_000, suggestedSize: "arm64-4-16", currentSize: null, storedOnlyLine: "Stored only: Rovara does not launch this size yet.", choices: [] }; }, access: async () => ({ developerId: "person", displayName: "Person", administrator: false, projects: liveProjects, notices: [] }) } as never,
    session: { accessToken: token, access: { developerId: "person", displayName: "Person", administrator: false, projects, notices: [] } } as never,
    params: ["payments"], query: new URLSearchParams(), body: { rowId: "arm64-4-16" }, org: { orgId: "acme", name: "Acme", plan: "test" }, now: () => new Date(NOW),
    work: {} as never, origin: "https://cloud.example.test", presence: {} as never,
  };
  const route = ROUTES.find((row) => row.method === method && row.path.test(path));
  if (route === undefined) throw new Error("machine-size route missing");
  return { answer: () => route.answer(value), calls };
}

describe("Cloud machine-size route", () => {
  it.each(["GET", "POST"] as const)("allows access granted since sign-in on %s", async (method) => {
    const w = context(method, "no-step-up", undefined, "NOT_FOUND", "route not found", [], [{ name: "payments", access: "administrator" }]);
    expect(await w.answer()).toMatchObject({ status: 200, body: { suggestedSize: "arm64-4-16" } });
    expect(w.calls).toHaveLength(1);
  });
  it.each(["GET", "POST"] as const)("refuses access revoked since sign-in on %s without asking for measurements", async (method) => {
    const w = context(method, "no-step-up", undefined, "NOT_FOUND", "route not found", [{ name: "payments", access: "administrator" }], []);
    expect(await w.answer()).toMatchObject({ status: 404 });
    expect(w.calls).toHaveLength(0);
  });
  it("reads measurements and the stored choice from Code for a project member", async () => {
    const w = context("GET");
    const result = await w.answer();
    expect(result).toMatchObject({ status: 200, body: { measuredPeakMemoryMiB: 6144, suggestedSize: "arm64-4-16" } });
    expect(w.calls[0]?.path).toBe("/v1/dev/projects/payments/machine-size");
  });
  it("forwards a choice with no step-up in the token (owner DEC 254zzz73); Code decides the role", async () => {
    for (const token of ["no-step-up", payload(Math.floor(NOW / 1000) - 3600)]) {
      const w = context("POST", token);
      expect(await w.answer()).toMatchObject({ status: 200, body: { suggestedSize: "arm64-4-16" } });
      expect(w.calls[0]).toMatchObject({ path: "/v1/dev/projects/payments/machine-size", options: { method: "POST", body: { rowId: "arm64-4-16" } } });
    }
  });
  it("a person without the project (another company's, or none) is not found and Code is not asked", async () => {
    const w = context("POST", "no-step-up", undefined, "NOT_FOUND", "route not found", []);
    expect(await w.answer()).toMatchObject({ status: 404 });
    expect(w.calls).toHaveLength(0);
  });
  it("Code's refusal of the wrong role (403) reaches the app with no step-up in play", async () => {
    const w = context("POST", "no-step-up", 403, "FORBIDDEN", "fixed refusal");
    await expect(w.answer()).rejects.toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "fixed refusal" } } });
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
