// srv/automations: the switch that hides automations. Every `/v1/app/chains*`, `/v1/app/chain-runs*` and `/v1/app/projects/{p}/automations` path answers the
// 404 of an unknown path unless the broker's WEB_FEATURES names `chains`; the Auditor is refused before any of it. Through the real route dispatcher.
// (This file turns automations on and off itself: it does not import tests/support/automations-on.ts.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentXError } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey, type OrgRole } from "@agentx/cloud-contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { AUTOMATIONS_WEB_FEATURE, automationsEnabled } from "../../packages/broker/src/chains/automations-gate.js";
import { AUDITOR_REFUSED } from "../../packages/broker/src/org/auditor.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

afterEach(() => { vi.unstubAllEnvs(); });

const org = "org_aaaaaaaaaaaaaaaaaaaa", actor = "a".repeat(64);
const PATHS: ReadonlyArray<[string, string, unknown?]> = [
  ["GET", "/v1/app/chains"], ["POST", "/v1/app/chains", { requestId: "22222222-2222-4222-8222-222222222222", name: "x" }], ["GET", "/v1/app/chains/chn_00000000000000000001"],
  ["GET", "/v1/app/chain-runs?project=web"], ["GET", "/v1/app/chains/chn_00000000000000000001/triggers"], ["GET", "/v1/app/projects/web/automations"],
];

/** A dispatcher with no agents or chains wired: past the switch a chain path says "chains are not set up", before it the answer is the unknown path's 404. */
function bench(role: OrgRole) {
  const db = new FakeDynamoDb();
  db.set({ ...orgMemberKey(org, actor), orgId: org, developerId: actor, role, joinedAt: "2026-10-01T00:00:00Z" });
  db.set({ ...developerOrgKey(actor), orgId: org, developerId: actor, role });
  db.set({ ...orgMetaKey(org), orgId: org, name: "Acme", plan: "team" });
  const deps: DeveloperRouteDependencies = {
    tableName: "state", now: () => Date.parse("2026-11-11T12:00:00Z"), documentClient: db,
    developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: true, cloud: false }, signInTableName: "signin", verifyAccessToken: async () => { throw new Error("no token"); }, channelMembers: async () => ({ ok: true, memberOf: [] }) },
    orgs: new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-11-11T12:00:00Z") }),
    tasks: {} as never,
  };
  const caller: DeveloperCaller = { orgId: org, developerId: actor, orgRole: role, name: "Priya", amr: "oidc", sessionId: "fixture" };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path: path.split("?")[0]!, headers: {}, body: body === undefined ? "" : JSON.stringify(body), requestId: "test" };
    try { return { result: await routeDeveloperRequest(deps, request, new URL(path, "https://cell.example"), { caller: { ...caller, browserSession: true }, csrf: "csrf" }) }; }
    catch (error) { if (!(error instanceof AgentXError)) throw error; return { code: error.code, message: error.message }; }
  };
  return { db, call };
}

describe("the automations switch", () => {
  it("is on only when WEB_FEATURES names chains exactly", () => {
    expect(AUTOMATIONS_WEB_FEATURE).toBe("chains");
    expect(automationsEnabled({})).toBe(false);
    expect(automationsEnabled({ WEB_FEATURES: "" })).toBe(false);
    expect(automationsEnabled({ WEB_FEATURES: "admin" })).toBe(false);
    expect(automationsEnabled({ WEB_FEATURES: "admin,chainsx" })).toBe(false);
    expect(automationsEnabled({ WEB_FEATURES: "Chains" })).toBe(false);
    expect(automationsEnabled({ WEB_FEATURES: "chains" })).toBe(true);
    expect(automationsEnabled({ WEB_FEATURES: "admin, chains ,usage" })).toBe(true);
  });

  for (const features of [undefined, "", "admin", "admin,usage,notices"]) {
    it(`answers every automations path with the unknown path's 404 while WEB_FEATURES is ${JSON.stringify(features)}, and writes nothing`, async () => {
      vi.stubEnv("WEB_FEATURES", features);
      const b = bench("admin");
      const before = b.db.commandNames().length;
      for (const [method, path, body] of PATHS) expect(await b.call(method, path, body), `${method} ${path}`).toEqual({ code: "NOT_FOUND", message: "NOT_FOUND: route not found" });
      expect(b.db.commandNames().slice(before).filter((name) => !name.startsWith("Get") && !name.startsWith("Query"))).toEqual([]);
    });
  }

  it("lets the same paths through to the chain routes once WEB_FEATURES names chains (the positive control: here no chains are set up, so they say so)", async () => {
    vi.stubEnv("WEB_FEATURES", "admin,chains");
    const b = bench("admin");
    for (const [method, path, body] of PATHS) expect(await b.call(method, path, body), `${method} ${path}`).toEqual({ code: "NOT_FOUND", message: "NOT_FOUND: chains are not set up in this deployment" });
  });

  it("refuses the Auditor on every automations path, on or off, before the switch", async () => {
    for (const features of ["", "chains"]) {
      vi.stubEnv("WEB_FEATURES", features);
      const b = bench("auditor");
      for (const [method, path, body] of PATHS) {
        const answer = await b.call(method, path, body);
        expect(answer, `${features} ${method} ${path}`).toMatchObject({ code: "FORBIDDEN" });
        expect((answer as { message: string }).message).toContain(AUDITOR_REFUSED);
      }
    }
  });
});
