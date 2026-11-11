// Live interaction F2: the broker's service routes for the chat service (`/v1/service/diagnoses/*`) and who pays. The routes answer the orchestrator role only, name the diagnosis (never a Slack thread),
// take nothing from the request about who asks or what they pay, and are NOT_FOUND while the switch is off. The COMPANY pays for every diagnosis, in either edition (2026-11-03, replacing the
// Rovara-paid design): the key is asked for in the requester's name on the company's own AI provider; nothing in a request can ask for another payer.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSIS_LIGHT_BUDGET_USD, DiagnosisModelAccessRequestSchema, canonicalModelName, SLACK_ROUTE_DIAGNOSIS, diagnosisRouteAttributes, isDiagnosisRoute } from "@rovara-code/contracts";

const mint = vi.hoisted(() => vi.fn((...args: unknown[]) => { void args; return Promise.resolve({ baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 }); }));
vi.mock("../../packages/broker/src/aws/broker/model-access.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), mintChatTurnKey: mint }));

import * as diagnosisService from "../../packages/broker/src/aws/broker/diagnosis-service.js";
import { handleDiagnosisServiceRoute, installDiagnosisService } from "../../packages/broker/src/aws/broker/diagnosis-service.js";
import { startLightDiagnosis } from "../../packages/broker/src/diagnosis/light.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";
import { ARJUN, ORG_A, PRIYA, diagnosisWorld, type DiagnosisWorld } from "../support/diagnosis-world.js";

const ORCHESTRATOR = "arn:aws:iam::123456789012:role/orchestrator";
const PRINCIPAL = "arn:aws:sts::123456789012:assumed-role/orchestrator/session-1";

function service(w: DiagnosisWorld, edition: "enterprise" | "public") {
  const dependencies = { slack: { orchestratorRoleArn: ORCHESTRATOR }, documentClient: w.w.db, tableName: "state", audit: w.audit.audit, editionPolicy: { edition } } as unknown as AwsBrokerDependencies;
  installDiagnosisService(dependencies, w.access, { LIVE_FIX_ENABLED: "1" });
  const request = (path: string, body: unknown, principal: string | null = PRINCIPAL) => ({
    method: "POST", path: `/v1/service${path}`, headers: {}, body: JSON.stringify(body), requestId: randomUUID(),
    ...(principal === null ? {} : { iamPrincipalArn: principal }),
  }) as never;
  return { dependencies, request };
}

beforeEach(() => { mint.mockClear(); });

describe("who pays for a light diagnosis", () => {
  for (const edition of ["public", "enterprise"] as const) {
    it(`${edition}: the company pays. The key is asked for in the requester's name, as a diagnosis, and the request cannot say otherwise`, async () => {
      const w = diagnosisWorld({ edition });
      const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
      const t = service(w, edition);
      const reply = await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: "Ev1234567890" }), "/v1/diagnoses/model-access");
      expect(reply?.statusCode).toBe(200);
      expect(mint).toHaveBeenCalledTimes(1);
      const args = mint.mock.calls[0]!;
      expect(args[1]).toBe(ORG_A);
      expect(args[2]).toBe("web");
      expect(args[3]).toMatchObject({ kind: "developer", developerId: PRIYA });
      // The options carry the diagnosis claim and nothing that asks for Rovara's payment.
      expect(args[6]).toEqual({ diagnosis: { claimKey: expect.any(Function) as unknown } });
      // A request cannot ask for a payer, a budget or a person: the body is strict.
      for (const extra of [{ rovaraPays: true }, { payer: "rovara" }, { developerId: ARJUN }, { maxBudgetUsd: 1000 }]) {
        expect(DiagnosisModelAccessRequestSchema.safeParse({ orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: "Ev1", ...extra }).success).toBe(false);
        await expect(handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: "Ev1234567890", ...extra }), "/v1/diagnoses/model-access")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      }
      expect(mint).toHaveBeenCalledTimes(1);
    });
  }

  it("DG-3: a diagnosis takes ONE key: a second model-access call for it (a retry, a redelivery) is refused by the claim the route hands the mint, and another diagnosis is not affected", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const first = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const t = service(w, "public");
    // The mint is played as the real one plays it: it asks the claim first and mints nothing when it is refused.
    mint.mockImplementation(async (...args: unknown[]) => {
      const options = args[6] as { diagnosis?: { claimKey(): Promise<boolean> } };
      if (options.diagnosis !== undefined && !(await options.diagnosis.claimKey())) throw new Error("already claimed");
      return { baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 };
    });
    try {
      const ask = (id: string) => handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: id, turnId: `Ev${randomUUID().replaceAll("-", "").slice(0, 12)}` }), "/v1/diagnoses/model-access");
      await expect(ask(first.diagnosisId)).resolves.toMatchObject({ statusCode: 200 });
      await expect(ask(first.diagnosisId)).rejects.toThrow("already claimed");
      await expect(ask(first.diagnosisId)).rejects.toThrow("already claimed");
      w.retried();
      const second = await startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() });
      await expect(ask(second.diagnosisId)).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      mint.mockReset();
      mint.mockImplementation((...args: unknown[]) => { void args; return Promise.resolve({ baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 }); });
    }
  });

  it("QA6-14: after the provider refused the first model, one retry key is given that leaves that model out for this diagnosis only (nothing is written to the install-wide usable-models record); a second retry or a retry with no first key is refused", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const t = service(w, "public");
    const markUnusable = vi.fn(async (model: unknown) => { void model; });
    (t.dependencies as unknown as { usableModels: unknown }).usableModels = { unusable: async () => new Set<string>(), markUnusable };
    const haiku = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5" };
    mint.mockImplementation(async (...args: unknown[]) => {
      const options = args[6] as { diagnosis?: { claimKey(chosen?: unknown): Promise<boolean>; avoid?: string } };
      if (options.diagnosis !== undefined && !(await options.diagnosis.claimKey({ model: options.diagnosis.avoid === undefined ? haiku : { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5" }, sourceId: "rovara" }))) throw new Error("already claimed");
      return { baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 };
    });
    try {
      const ask = (extra: object = {}) => handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: `Ev${randomUUID().replaceAll("-", "").slice(0, 12)}`, ...extra }), "/v1/diagnoses/model-access");
      // A retry before any key was taken is refused and mints nothing.
      await expect(ask({ retryAfterRefusal: true })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(mint).not.toHaveBeenCalled();
      await expect(ask()).resolves.toMatchObject({ statusCode: 200 });
      mint.mockClear();
      await expect(ask({ retryAfterRefusal: true })).resolves.toMatchObject({ statusCode: 200 });
      expect(mint).toHaveBeenCalledTimes(1);
      const options = mint.mock.calls[0]![6] as { diagnosis: { avoid?: string } };
      expect(options.diagnosis.avoid).toBe(canonicalModelName(haiku));
      // F2: the refusal is this diagnosis's alone: the install-wide record is never touched from here.
      expect(markUnusable).not.toHaveBeenCalled();
      // The retry is once: another is refused, and no plain key is given again either.
      mint.mockClear();
      await expect(ask({ retryAfterRefusal: true })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      await expect(ask()).rejects.toThrow("already claimed");
      expect(mint).toHaveBeenCalledTimes(1);
      expect(markUnusable).not.toHaveBeenCalled();
    } finally {
      mint.mockReset();
      mint.mockImplementation((...args: unknown[]) => { void args; return Promise.resolve({ baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 }); });
    }
  });

  it("nothing in the module decides that Rovara pays: no edition test, no Rovara-pays option", () => {
    expect(Object.keys(diagnosisService)).not.toContain("rovaraPaysForLight");
    expect(DIAGNOSIS_LIGHT_BUDGET_USD).toBeLessThanOrEqual(0.5);
  });

  it("mints nothing for a requester whose use ended, a diagnosis the broker did not queue, or one already answered", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() });
    const t = service(w, "public");
    const ask = (id: string) => handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: id, turnId: "Ev1234567890" }), "/v1/diagnoses/model-access");
    await expect(ask("dgn_zzzzzzzzzzzzzzzzzzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const [key, item] of [...w.w.db.items.entries()]) if ((item as { sk?: string }).sk?.startsWith("SHARE#")) w.w.db.items.delete(key);
    await expect(ask(status.diagnosisId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mint).not.toHaveBeenCalled();
  });
});

describe("the service routes", () => {
  it("answer the orchestrator role only", async () => {
    const w = diagnosisWorld();
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const t = service(w, "enterprise");
    const ref = { orgId: ORG_A, diagnosisId: status.diagnosisId };
    for (const principal of [null, "arn:aws:sts::123456789012:assumed-role/someone-else/s", "arn:aws:sts::999999999999:assumed-role/orchestrator/s"]) {
      for (const [path, body] of [["/diagnoses/turn", ref], ["/diagnoses/answered", { ...ref, outcome: "FAILED" }], ["/diagnoses/model-access", { ...ref, turnId: "Ev1" }]] as const) {
        await expect(handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request(path, body, principal), `/v1${path}`)).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
    expect(mint).not.toHaveBeenCalled();
  });

  it("hand the turn the context and take the answer, and ignore any path that is not theirs", async () => {
    const w = diagnosisWorld();
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const t = service(w, "enterprise");
    const ref = { orgId: ORG_A, diagnosisId: status.diagnosisId };
    const turn = await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/turn", ref), "/v1/diagnoses/turn");
    expect(turn?.statusCode).toBe(200);
    expect(JSON.parse(turn!.body)).toMatchObject({ taskContext: expect.stringContaining("Answer with ONE JSON object") as string });
    const done = await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/answered", { ...ref, outcome: "ANSWERED", text: JSON.stringify({ summary: "The step failed.", proposals: [] }) }), "/v1/diagnoses/answered");
    expect(JSON.parse(done!.body)).toMatchObject({ outcome: "ANSWERED" });
    expect(await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/asks/turn", ref), "/v1/asks/turn")).toBeUndefined();
    expect(await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, { ...(t.request("/diagnoses/turn", ref) as object), method: "GET" } as never, "/v1/diagnoses/turn")).toBeUndefined();
  });

  it("are NOT_FOUND while the switch is off: nothing is installed, and the route says it does not exist", async () => {
    const w = diagnosisWorld({ enabled: false });
    const dependencies = { slack: { orchestratorRoleArn: ORCHESTRATOR }, documentClient: w.w.db, tableName: "state", audit: w.audit.audit } as unknown as AwsBrokerDependencies;
    for (const env of [{}, { LIVE_FIX_ENABLED: "0" }, { LIVE_FIX_ENABLED: "true" }, { LIVE_FIX_ENABLED: " 1" }]) {
      installDiagnosisService(dependencies, w.access, env);
      expect(dependencies.diagnosisService, JSON.stringify(env)).toBeUndefined();
    }
    const request = { method: "POST", path: "/v1/service/diagnoses/turn", headers: {}, body: "{}", requestId: randomUUID(), iamPrincipalArn: PRINCIPAL } as never;
    await expect(handleDiagnosisServiceRoute(dependencies, undefined, request, "/v1/diagnoses/turn")).rejects.toMatchObject({ code: "NOT_FOUND" });
    installDiagnosisService(dependencies, undefined, { LIVE_FIX_ENABLED: "1" });
    expect(dependencies.diagnosisService).toBeUndefined();
  });
});

describe("the queue route", () => {
  it("is its own value, an older chat service discards it, and nothing else is read as a diagnosis", () => {
    expect(SLACK_ROUTE_DIAGNOSIS).toBe("diagnosis");
    expect(isDiagnosisRoute(diagnosisRouteAttributes())).toBe(true);
    expect(isDiagnosisRoute({ agentxRoute: { StringValue: "ask" } })).toBe(false);
    expect(isDiagnosisRoute({ agentxRoute: { StringValue: "thread" } })).toBe(false);
    expect(isDiagnosisRoute(undefined)).toBe(false);
  });
});
