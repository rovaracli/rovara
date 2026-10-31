import { describe, expect, it, vi } from "vitest";
import { editionPolicy, ENTERPRISE_ONLY_MESSAGE, NOT_IN_THIS_EDITION_MESSAGE } from "@agentx/contracts";
import { INSTALL_OPERATOR_ROUTES, requireStaffRouteAllowed } from "../../packages/broker/src/aws/broker/staff-routes.js";
import { githubConnectionOf } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { enabledMethods } from "../../packages/broker/src/developer/server.js";
import { trialAvailable } from "../../packages/broker/src/org/trial-availability.js";
import { orgMetaKey } from "@agentx/contracts";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { identityHarness, authorizeQuery, httpEvent } from "../support/developer-fakes.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

// Enterprise foundations E3: requireFeature gates. Staff routes, the trial, and the sign-in methods of the hosted product are off in Enterprise.

const enterprise = editionPolicy("enterprise");
const publicPolicy = editionPolicy("public");

function thrown(run: () => void): { code?: string; message: string } | undefined {
  try { run(); } catch (error) { return error as { code?: string; message: string }; }
  return undefined;
}

describe("staff routes (a closed list of what an install's own operator may call)", () => {
  const STAFF = [
    "/v1/admin/turns", "/v1/admin/audit/org_aaaaaaaaaaaaaaaaaaaa/records", "/v1/admin/audit/org_aaaaaaaaaaaaaaaaaaaa/exports/x", "/v1/admin/audit/org_aaaaaaaaaaaaaaaaaaaa/erase-subject",
    "/v1/admin/evals/batches", "/v1/admin/evals/batches/11111111-1111-4111-8111-111111111111/stop", "/v1/admin/evals/channels/T1/C1",
    "/v1/admin/a-route-added-later", "/v1/admin", "/v1/admin/", "/v1/admin/turns/", "/v1/admin/projects/extra", "/v1/admin/me/../turns", "/v1/workspaces", "/v1/admin/changes/not-a-uuid",
  ];
  const OPERATOR = [
    "/v1/admin/me", "/v1/admin/health", "/v1/admin/projects", "/v1/admin/projects/setup-proposals", "/v1/admin/projects/setup-approvals",
    "/v1/admin/projects/setup-executions/11111111-1111-4111-8111-111111111111/retry", "/v1/admin/credentials", "/v1/admin/runtime-installation/status",
    "/v1/admin/e2e/model-checks", "/v1/admin/e2e/model-checks/11111111-1111-4111-8111-111111111111", "/v1/admin/chatgpt", "/v1/admin/org/budget", "/v1/admin/egress/pending",
    "/v1/admin/slack/bindings", "/v1/admin/slack/bindings/T1/C1", "/v1/admin/slack/teams/T1", "/v1/admin/workspaces", "/v1/admin/workspaces/prepare",
    "/v1/admin/workspaces/11111111-1111-4111-8111-111111111111/stop", "/v1/admin/changes", "/v1/admin/changes/config", "/v1/admin/changes/11111111-1111-4111-8111-111111111111/outcome",
    "/v1/admin/tasks/abc/share-mode", "/v1/admin/github/webhook-deliveries/11111111-1111-4111-8111-111111111111/retry",
  ];

  it("Enterprise refuses every staff route with the edition's fixed sentence", () => {
    for (const path of STAFF) {
      const failure = thrown(() => requireStaffRouteAllowed(enterprise, path));
      expect(failure?.code, path).toBe("FORBIDDEN");
      expect(failure?.message, path).toContain(NOT_IN_THIS_EDITION_MESSAGE);
      expect(failure?.message, path).not.toContain(path);
    }
    expect(ENTERPRISE_ONLY_MESSAGE).not.toBe(NOT_IN_THIS_EDITION_MESSAGE);
  });

  it("Enterprise serves the routes an install's own operator calls", () => {
    for (const path of OPERATOR) expect(thrown(() => requireStaffRouteAllowed(enterprise, path)), path).toBeUndefined();
  });

  it("Public and an install deployed before editions serve everything, as before", () => {
    for (const path of [...STAFF, ...OPERATOR]) {
      expect(thrown(() => requireStaffRouteAllowed(publicPolicy, path)), path).toBeUndefined();
      expect(thrown(() => requireStaffRouteAllowed(undefined, path)), path).toBeUndefined();
    }
  });

  it("every allowed pattern is anchored, so no staff path can hide inside one", () => {
    for (const route of INSTALL_OPERATOR_ROUTES) {
      expect(route.source.startsWith("^"), route.source).toBe(true);
      expect(route.source.endsWith("$"), route.source).toBe(true);
    }
  });

  it("through the broker: Enterprise answers 403 on /v1/admin/turns before anything is read, and still serves /v1/admin/projects", async () => {
    const page = vi.fn(async () => ({ turns: [], cursor: undefined }));
    const enterpriseBroker = await createAdminBroker({ turnRecords: { page } as never, extra: { editionPolicy: enterprise } });
    const refused = await adminCall(enterpriseBroker.handler, { method: "GET", path: "/v1/admin/turns" });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain(NOT_IN_THIS_EDITION_MESSAGE);
    expect(page).not.toHaveBeenCalled();
    expect((await adminCall(enterpriseBroker.handler, { method: "GET", path: "/v1/admin/projects" })).status).toBe(200);
    // The staff path into any company's audit log, and a route nobody has classified.
    expect((await adminCall(enterpriseBroker.handler, { method: "GET", path: "/v1/admin/audit/org_aaaaaaaaaaaaaaaaaaaa/records" })).status).toBe(403);
    expect((await adminCall(enterpriseBroker.handler, { method: "GET", path: "/v1/admin/a-route-added-later" })).status).toBe(403);

    for (const extra of [{}, { editionPolicy: publicPolicy }]) {
      const open = await createAdminBroker({ turnRecords: { page } as never, extra });
      expect((await adminCall(open.handler, { method: "GET", path: "/v1/admin/turns" })).status).toBe(200);
    }
    expect(page).toHaveBeenCalledTimes(2);
  });
});

describe("the trial", () => {
  it("is available only where the edition has trial and billing (or the install has no edition)", () => {
    expect(trialAvailable(undefined)).toBe(true);
    expect(trialAvailable(publicPolicy)).toBe(true);
    expect(trialAvailable(enterprise)).toBe(false);
  });

  async function trialWorld(extra: Record<string, unknown>) {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, ...extra } });
    h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Maya's organization", plan: "trial", createdBy: MAYA.developerId, createdAt: "2026-10-23T12:00:00Z" });
    // A company (oidc) session: the only kind an Enterprise install serves.
    h.db.set({ ...h.db.get(`SESSION#${MAYA.sessionId}`, "META")!, amr: "oidc" });
    return h;
  }

  it("/v1/app/me and /v1/app/nav carry no trial state in Enterprise, and still do on Public and without an edition", async () => {
    for (const [extra, shown] of [[{}, true], [{ editionPolicy: publicPolicy }, true], [{ editionPolicy: enterprise }, false]] as const) {
      const h = await trialWorld(extra);
      const me = await h.dev({ ...MAYA, provider: "oidc" }, "GET", "/v1/app/me");
      const nav = await h.dev({ ...MAYA, provider: "oidc" }, "GET", "/v1/app/nav");
      expect(me.status).toBe(200);
      expect(nav.status).toBe(200);
      expect((me.body.org as Record<string, unknown>).trial !== undefined, JSON.stringify(extra)).toBe(shown);
      expect((nav.body.org as Record<string, unknown>).trial !== undefined, JSON.stringify(extra)).toBe(shown);
    }
  });

  it("connecting GitHub does not claim a GitHub account for a trial in Enterprise", async () => {
    const send = vi.fn(async () => ({ Item: { plan: "trial", createdBy: "someone" } }));
    const base = {
      documentClient: { send }, tableName: "state", developer: { issuer: "https://x.example.test", signInTableName: "signin" },
      githubPullRequests: { appSlug: async () => "app", oauthClient: async () => ({}), installation: async () => ({}) },
    };
    for (const [policy, calls] of [[enterprise, 0], [publicPolicy, 1], [undefined, 1]] as const) {
      send.mockClear();
      const connection = githubConnectionOf({ ...base, ...(policy === undefined ? {} : { editionPolicy: policy }) } as never);
      await connection!.unlockTrial({ orgId: TEST_ORG, githubUserId: "123" });
      expect(send.mock.calls.length > 0, String(policy?.edition)).toBe(calls === 1);
    }
  });
});

describe("sign-in methods", () => {
  it("Enterprise offers the company's own sign-in only, however many methods are configured", () => {
    const h = identityHarness({ oidc: {}, cloud: {}, github: { users: [] }, editionPolicy: enterprise });
    expect(enabledMethods(h.deps)).toEqual(["oidc"]);
    const open = identityHarness({ oidc: {}, cloud: {}, github: { users: [] }, editionPolicy: publicPolicy });
    expect(enabledMethods(open.deps)).toEqual(["slack", "oidc", "cloud", "github"]);
    const legacy = identityHarness({ oidc: {} });
    expect(enabledMethods(legacy.deps)).toEqual(["slack", "oidc"]);
  });

  it("a Slack sign-in cannot be started in Enterprise, and the company sign-in still can", async () => {
    const h = identityHarness({ oidc: {}, oidcUsers: [{ sub: "u1", name: "Una", email: "una@example.test", email_verified: true }], slackUsers: [{ userId: "U0SLACK01", name: "Sam", email: "sam@example.test", emailVerified: true }], editionPolicy: enterprise });
    const picker = await h.http(httpEvent("GET", authorizeQuery()));
    // One method: the server goes straight to it, and it is the company's.
    expect(picker.statusCode).toBe(302);
    expect(picker.headers.location).toContain("idp.example.test");
    const slackUrl = (await h.http(httpEvent("GET", authorizeQuery()))).headers.location!;
    expect(slackUrl).not.toContain("slack.com");
    const requestId = new URL(slackUrl).searchParams.get("state");
    expect(requestId).not.toBeNull();
    // A request that asks for Slack by name is refused: the method is not available.
    const direct = await h.http(httpEvent("GET", `/v1/auth/authorize?request=${requestId!}&method=slack`));
    expect(direct.statusCode).toBe(400);
    expect(direct.body).toContain("Sign-in method not available");
  });

  it("a Slack sign-in already under way is refused at the callback once the install is Enterprise (the provider itself is behind the same gate)", async () => {
    const h = identityHarness({ slackUsers: [{ userId: "U0SLACK01", name: "Sam", email: "sam@example.test", emailVerified: true }] });
    const started = await h.http(httpEvent("GET", authorizeQuery()));
    expect(started.statusCode).toBe(302);
    const providerUrl = started.headers.location!;
    expect(providerUrl).toContain("slack.com");
    h.deps.editionPolicy = enterprise;
    const callback = h.slack.approve(providerUrl, "U0SLACK01");
    const back = await h.http(httpEvent("GET", callback));
    const redirectedTo = new URL(back.headers.location ?? "https://none.invalid/");
    expect(redirectedTo.searchParams.get("code")).toBeNull();
    expect(redirectedTo.searchParams.get("error")).not.toBeNull();
  });
});
