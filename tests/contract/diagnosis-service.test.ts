// Live interaction F2: the broker's service routes for the chat service (`/v1/service/diagnoses/*`) and who pays. The routes answer the orchestrator role only, name the diagnosis (never a Slack thread),
// take nothing from the request about who asks or what they pay, and are NOT_FOUND while the switch is off. WHO PAYS is decided from the edition: Public light is paid by Rovara (a small fixed key for
// Rovara's own AI, counted against none of the customer's budgets); Enterprise runs on the customer's own account and limits; nothing in a request can ask for Rovara's payment.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSIS_LIGHT_BUDGET_USD, DiagnosisModelAccessRequestSchema, SLACK_ROUTE_DIAGNOSIS, diagnosisRouteAttributes, isDiagnosisRoute } from "../../packages/contracts/src/index.js";

const mint = vi.hoisted(() => vi.fn((...args: unknown[]) => { void args; return Promise.resolve({ baseUrl: "https://proxy.example.invalid", apiKey: "fake-key-not-a-secret", expiresAt: 1 }); }));
vi.mock("../../packages/broker/src/aws/broker/model-access.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), mintChatTurnKey: mint }));

import { handleDiagnosisServiceRoute, installDiagnosisService, rovaraPaysForLight } from "../../packages/broker/src/aws/broker/diagnosis-service.js";
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
  it("Public: Rovara pays. The key is asked for as Rovara's support, with no member to bill, and the request cannot say otherwise", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const t = service(w, "public");
    const reply = await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: "Ev1234567890" }), "/v1/diagnoses/model-access");
    expect(reply?.statusCode).toBe(200);
    expect(mint).toHaveBeenCalledTimes(1);
    const args = mint.mock.calls[0]!;
    expect(args[1]).toBe(ORG_A);
    expect(args[2]).toBe("web");
    expect(args[3]).toBeUndefined();
    expect(args[5]).toEqual({ rovaraPays: true });
    // A request cannot ask for a payer, a budget or a person: the body is strict.
    for (const extra of [{ rovaraPays: true }, { payer: "rovara" }, { developerId: ARJUN }, { maxBudgetUsd: 1000 }]) {
      expect(DiagnosisModelAccessRequestSchema.safeParse({ orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: "Ev1", ...extra }).success).toBe(false);
      await expect(handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: "Ev1234567890", ...extra }), "/v1/diagnoses/model-access")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("Enterprise: the customer's own account and limits. The key is asked for in the requester's name, with no Rovara payment", async () => {
    const w = diagnosisWorld({ edition: "enterprise" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() });
    const t = service(w, "enterprise");
    await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, t.request("/diagnoses/model-access", { orgId: ORG_A, diagnosisId: status.diagnosisId, turnId: "Ev1234567890" }), "/v1/diagnoses/model-access");
    const args = mint.mock.calls[0]!;
    expect(args[3]).toMatchObject({ kind: "developer", developerId: ARJUN });
    expect(args[5]).toEqual({});
  });

  it("the choice is the edition's alone", () => {
    expect(rovaraPaysForLight("public")).toBe(true);
    expect(rovaraPaysForLight("enterprise")).toBe(false);
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
    expect(await handleDiagnosisServiceRoute(t.dependencies, t.dependencies.diagnosisService, { ...t.request("/diagnoses/turn", ref), method: "GET" } as never, "/v1/diagnoses/turn")).toBeUndefined();
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
