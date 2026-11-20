import { describe, expect, it } from "vitest";
import { CodeClient, CodeError, LocalCompanyStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CodeSession, type RouteAnswer } from "../../packages/cloud-server/src/index.js";
import { agentModelsRefusal } from "../../packages/cloud-server/src/agent-models-routes.js";
import { engineModelRefusal, projectSettingsRefusal } from "../../packages/cloud-server/src/ai-spend-routes.js";
import { answersRefusal } from "../../packages/cloud-server/src/answers-routes.js";
import { evalCheckRefusal } from "../../packages/cloud-server/src/eval-check-routes.js";
import { knowledgeSwitchRefusal } from "../../packages/cloud-server/src/knowledge-switch-routes.js";
import { learningModelRefusal } from "../../packages/cloud-server/src/learning-model-routes.js";
import { roleRefusal, removalRefusal } from "../../packages/cloud-server/src/member-routes.js";
import { createRefusal } from "../../packages/cloud-server/src/project-create-routes.js";
import { lifecycleRefusal } from "../../packages/cloud-server/src/project-lifecycle-routes.js";
import { setupRefusal, approvalRefusal } from "../../packages/cloud-server/src/setup-checklist-routes.js";
import { setupRepairRefusal } from "../../packages/cloud-server/src/setup-repair-routes.js";
import { systemRunsRefusal } from "../../packages/cloud-server/src/system-runs-routes.js";
import { wikiCorrectionRefusal } from "../../packages/cloud-server/src/wiki-corrections-routes.js";
import { wikiSetupRefusal } from "../../packages/cloud-server/src/wiki-setup-routes.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const ID = "11111111-1111-4111-8111-111111111111";
const access: CodeSession["access"] = { developerId: "a".repeat(64), displayName: "Ada", administrator: false, companyId: COMPANY, companyRole: "owner", projects: [{ name: "payments", access: "maintain" }], notices: [] };
const fresh = (): CodeSession => ({ accessToken: "old", refreshToken: "refresh-old", csrf: "csrf", signedInAt: "2026-11-20T00:00:00.000Z", access: { ...access } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const clientFor = (fetchImpl: typeof fetch) => new CodeClient({ baseUrl: "https://code.example.test", clientId: "test", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });
const UNKNOWN = { error: { code: "RUNTIME_UNAVAILABLE", message: "The request's outcome is unknown. Check its status before trying again." } };

async function world(options: { withdrawal?: "ok" | "unknown"; refusal?: number; company?: boolean } = {}) {
  const sends: Array<{ path: string; method: string }> = [];
  let livePreapproval = false;
  const client = clientFor(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === "/v1/dev/access") return json(200, options.company === false ? { ...access, companyId: undefined, companyRole: undefined } : access);
    if (path === "/v1/auth/token") return json(200, { access_token: "new", refresh_token: "refresh-new" });
    sends.push({ path, method: init?.method ?? "GET" });
    if (init?.method === "DELETE" && options.withdrawal === "ok") { livePreapproval = false; return json(200, { ok: true }); }
    livePreapproval = true;
    return json(options.refusal ?? 401, { error: { code: "NOT_FOUND" } });
  });
  const store = new LocalSessionStore(undefined, { environment: {} });
  await store.create("cookie", fresh());
  const company = new LocalCompanyStore();
  const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), company: { store: company, log: () => undefined }, origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: "acme", name: "Acme", plan: "test" }, log: () => undefined });
  const call = (path: string, body?: unknown, method = "POST") => handler({ method, path, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie", "x-rovara-csrf": "csrf" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { client, store, company, call, sends, live: () => livePreapproval };
}

// These functions used to replace the transport's unknown with a fixed failure/retry sentence.
const adapters: Array<[string, (error: CodeError) => RouteAnswer]> = [
  ["agent models", agentModelsRefusal], ["engine models", engineModelRefusal], ["project settings", projectSettingsRefusal],
  ["answers", error => answersRefusal("answer", error)], ["answer suggestions", error => answersRefusal("suggest", error)], ["answer correction", error => answersRefusal("notRight", error)],
  ["eval check", evalCheckRefusal], ["company knowledge", error => knowledgeSwitchRefusal(error, "company")], ["project knowledge", error => knowledgeSwitchRefusal(error, "project")],
  ["learning model", learningModelRefusal], ["member role", roleRefusal], ["member removal", removalRefusal], ["project create", createRefusal], ["project lifecycle", lifecycleRefusal],
  ["setup run", error => setupRefusal("run", error)], ["setup skip", error => setupRefusal("skip", error)],
  ["setup confirm", error => approvalRefusal("confirm", error)], ["setup discard", error => approvalRefusal("discard", error)], ["setup decide", error => approvalRefusal("decide", error)],
  ["setup repair", setupRepairRefusal], ["system runs", systemRunsRefusal], ["wiki correction", wikiCorrectionRefusal],
  ["wiki upkeep", error => wikiSetupRefusal("upkeep", error)], ["wiki map", error => wikiSetupRefusal("map", error)],
];

describe("unknown writes survive audited adapters (review F1)", () => {
  it.each(adapters)("%s keeps the existing unknown shape", async (_name, adapt) => {
    const w = await world();
    const error: unknown = await w.client.json(fresh(), "/write", { method: "POST" }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CodeError);
    const answer = adapt(error as CodeError);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual(UNKNOWN);
    expect(w.sends).toHaveLength(1);
  });

  it.each([
    ["/org/report/features", { name: "Synthetic" }, "POST"],
    ["/projects", { requestId: ID, repositories: ["acme/payments"] }, "POST"],
    ["/projects", { requestId: ID, repositories: ["acme/payments"], separate: true }, "POST"],
    ["/github/connect", {}, "POST"], ["/github/connections/123", {}, "DELETE"],
    ["/slack/install", {}, "POST"], ["/slack/disconnect", {}, "POST"],
    ["/linear/connect", {}, "POST"], ["/linear", {}, "DELETE"],
    ["/me/github/link", {}, "POST"], ["/me/github", {}, "DELETE"],
    ["/me/sign-ins/github", {}, "DELETE"],
    ["/me/lessons-slack", { optOut: true }, "PUT"],
    ["/projects/payments/intake/updates", { requestId: ID, settings: { comments: true, changeStatus: false, statuses: {} } }, "PUT"],
    ["/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa/revoke", {}, "POST"],
    
  ] as const)("%s %j %s tells the browser to check status after one dispatch", async (path, body, method) => {
    const w = await world();
    const answer = await w.call(`/v1/web${path}`, body, method);
    expect(answer?.status).toBe(503);
    expect(JSON.parse(answer!.body)).toEqual(UNKNOWN);
    expect(w.sends).toHaveLength(1);
    expect((await w.store.get("cookie"))?.accessToken).toBe("new");
  });

  it("company creation preserves unknown instead of asserting it could not be created", async () => {
    const w = await world({ company: false });
    const answer = await w.call("/v1/web/companies", { name: "Acme", inviteCode: "synthetic-code" });
    expect(answer?.status).toBe(503);
    expect(JSON.parse(answer!.body)).toEqual(UNKNOWN);
    expect(w.sends).toHaveLength(1);
  });
});

describe("invite preapproval cleanup (review F2)", () => {
  it.each(["/org/invites", "/org/invites/reviewed"])("%s retains an unknown preapproval for reconciliation", async path => {
    const w = await world({ withdrawal: "unknown" });
    const answer = await w.call(`/v1/web${path}`, { requestId: ID, role: "member", email: "synthetic@example.test" });
    expect(answer?.status).toBe(503);
    expect(JSON.parse(answer!.body)).toEqual(UNKNOWN);
    expect(w.sends.filter(send => send.method === "POST")).toHaveLength(1);
    expect(w.live()).toBe(true);
    const kept = (await w.company.invites(COMPANY)).invites;
    expect(kept).toHaveLength(1);
    expect(["unconfirmed", "revoking"]).toContain(kept[0]!.state);
    const duplicate = await w.call(`/v1/web${path}`, { requestId: ID, role: "member", email: "synthetic@example.test" });
    expect(duplicate?.status).toBe(409);
    expect(w.sends.filter(send => send.method === "POST")).toHaveLength(1);
  });

  it("only confirmed compensation can remove a possibly live preapproval", async () => {
    const w = await world({ withdrawal: "ok" });
    const answer = await w.call("/v1/web/org/invites", { requestId: ID, role: "member", email: "synthetic@example.test" });
    expect(answer?.status).toBe(503);
    const kept = (await w.company.invites(COMPANY)).invites;
    expect(kept.length > 0 || !w.live()).toBe(true);
    if (kept.length === 0) expect(w.sends.filter(send => send.method === "DELETE")).toHaveLength(1);
  });

  it("a definitive preapproval refusal still removes the unused record", async () => {
    const w = await world({ refusal: 404 });
    const answer = await w.call("/v1/web/org/invites", { requestId: ID, role: "member", email: "synthetic@example.test" });
    expect(answer?.status).toBe(409);
    expect((await w.company.invites(COMPANY)).invites).toHaveLength(0);
    expect(w.sends.filter(send => send.method === "DELETE")).toHaveLength(0);
  });
});
