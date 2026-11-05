// 0.5.7: every browser page a person can reach from an old link on the API's own address moves to the custom domain (GET only), because each page's cookies are host-only
// and its Origin check, sign-in and links are the domain's. Through the whole broker, so a new page added without joining the list fails here.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_PAGE_PREFIXES, GITHUB_INSTALL_CALLBACK, isBrowserPagePath, machineOrigin } from "../../packages/broker/src/developer/legacy-host-redirect.js";
import { HookIngressMemory } from "../../packages/broker/src/triggers/ingress.js";
import { createDeveloperTaskBroker, DEV_ISSUER, MAYA, seedMembership } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { FakeHookSecrets, LINEAR_TENANT, SECRET_1, hmacProvider } from "../support/hook-fixtures.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const OWN_HOST = new URL(DEV_ISSUER).host;
const DOMAIN = "staging.rovara.dev";
const CUSTOM_ISSUER = `https://${DOMAIN}/v1/auth`;

async function broker() {
  return createDeveloperTaskBroker({ brokerExtra: { cloud: true }, developerExtra: { issuer: CUSTOM_ISSUER, previousIssuer: DEV_ISSUER } });
}
const call = async (h: Awaited<ReturnType<typeof broker>>, method: string, pathAndQuery: string, host: string | undefined, routeKey: string) => {
  const [path, query = ""] = pathAndQuery.split("?");
  return h.handler({
    version: "2.0", routeKey, rawPath: path!, rawQueryString: query, headers: host === undefined ? {} : { host },
    requestContext: { requestId: "r-1", http: { method } },
  }) as Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;
};

const taskId = randomUUID();
const approvalId = `apr_${"a".repeat(26)}`;
const PAGES: Array<[string, string, string]> = [
  ["the task review page", `/review/${taskId}/task?x=1`, "ANY /review/{proxy+}"],
  ["the task page's API (task-web-api)", `/review/${taskId}/task/api/status`, "ANY /review/{proxy+}"],
  ["the approval confirmation page (decide-session, MCP confirm)", `/v1/app/approve/${approvalId}?ticket=${"t".repeat(32)}`, "ANY /v1/app/{proxy+}"],
  ["the audit view", "/v1/app/audit/view?page=2", "ANY /v1/app/{proxy+}"],
  ["the GitHub App install callback (GitHub connect)", "/v1/github/install/callback?code=c&installation_id=501&setup_action=install&state=s", "GET /v1/github/install/callback"],
];

describe("browser pages opened on the API's own address", () => {
  it.each(PAGES)("%s moves to the domain, with its path and query, as a temporary redirect", async (_name, path, routeKey) => {
    const h = await broker();
    const moved = await call(h, "GET", path, OWN_HOST, routeKey);
    expect(moved.statusCode).toBe(307);
    expect(moved.headers).toMatchObject({ location: `https://${DOMAIN}${path}`, "cache-control": "no-store" });
    expect(moved.body).toBe("");
  });

  it.each(PAGES)("%s is not moved on the domain's own host, with no host, or for a POST", async (_name, path, routeKey) => {
    const h = await broker();
    for (const [method, host] of [["GET", DOMAIN], ["GET", undefined], ["POST", OWN_HOST]] as const) {
      expect((await call(h, method, path, host, routeKey)).statusCode, `${method} ${host}`).not.toBe(307);
    }
  });

  it("matches exactly the pages the list names, and no machine route", () => {
    expect([...BROWSER_PAGE_PREFIXES, GITHUB_INSTALL_CALLBACK].sort()).toEqual(["/review/", "/v1/app/approve/", "/v1/app/audit/view", "/v1/github/install/callback"].sort());
    for (const machine of ["/v1/slack/events", "/v1/github/webhooks", "/v1/hooks/github/abc", "/v1/app/me", "/v1/dev/projects", "/v1/service/x", "/v1/auth/authorize", "/app", "/s/x"]) expect(isBrowserPagePath(machine), machine).toBe(false);
  });

  it("does not move anything without a custom domain (no previous issuer)", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { cloud: true } });
    const page = await call(h, "GET", `/review/${taskId}/task`, OWN_HOST, "ANY /review/{proxy+}");
    expect(page.statusCode).not.toBe(307);
  });
});

describe("event-hook URLs", () => {
  it("a hook made through the broker with a custom domain set gets the API's own address, as without one", async () => {
    await loadSlackBroker();
    for (const developerExtra of [{ issuer: CUSTOM_ISSUER, previousIssuer: DEV_ISSUER }, {}]) {
      const members = new FakeProjectMembers();
      members.addProject(TEST_ORG, "web");
      const h = await createDeveloperTaskBroker({
        register: false, developerExtra,
        brokerExtra: { cloud: true, agents: { projectMembers: members, eventHooks: { secrets: new FakeHookSecrets(), memory: new HookIngressMemory(), providers: { linear: hmacProvider("linear") } } } },
      });
      await h.orgOf(MAYA);
      seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
      const made = await h.dev(MAYA, "POST", "/v1/app/projects/web/event-hooks", { requestId: randomUUID(), source: "linear", tenant: LINEAR_TENANT, secret: `${SECRET_1}-new` });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const hook = made.body["hook"] as { hookId: string; url: string };
      expect(hook.url).toBe(`${new URL(DEV_ISSUER).origin}/v1/hooks/linear/${hook.hookId}`);
    }
  });

  it("are built on the API's own address, not the domain: vendors register them once, and they must survive the domain being removed", () => {
    expect(machineOrigin({ issuer: CUSTOM_ISSUER, previousIssuer: DEV_ISSUER })).toBe(new URL(DEV_ISSUER).origin);
    expect(machineOrigin({ issuer: DEV_ISSUER })).toBe(new URL(DEV_ISSUER).origin);
  });
});
