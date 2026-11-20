import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { createConnectFlow, sha256 } from "../../packages/cloud-server/src/connect-flow.js";
import { githubStateKey, sessionBinding } from "../../packages/cloud-server/src/github-connect.js";
import { linkPendingKey } from "../../packages/cloud-server/src/sign-in-links.js";

const access: CodeSession["access"] = { developerId: "a".repeat(64), displayName: "Ada", administrator: false, companyId: "org_aaaaaaaaaaaaaaaaaaaa", companyRole: "owner", projects: [], notices: [] };
const session = (): CodeSession => ({ accessToken: "old", refreshToken: "refresh-old", csrf: "csrf", signedInAt: "2026-11-20T00:00:00.000Z", access });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("callback writes preserve unknown rather than a failure redirect (review F1)", () => {
  it.each(["github", "github-link", "slack", "linear", "sign-in"] as const)("%s commit then 401 stays unknown with one write", async provider => {
    const store = new LocalSessionStore(undefined, { environment: {} });
    await store.create("cookie", session());
    const now = () => new Date("2026-11-20T12:00:00.000Z");
    const state = "s".repeat(43);
    let path: string, cookie = "rovara_cloud_session=cookie";
    const query = new URLSearchParams({ state, code: "synthetic-code" });
    if (provider === "slack" || provider === "linear") {
      const flow = createConnectFlow({ provider, store, now, secureCookies: true });
      const binderCookie = await flow.bind(session(), "cookie", state, "/app/onboard");
      cookie += `; ${binderCookie.split(";")[0]!}`;
      path = `/api/connect/${provider}/callback`;
    } else if (provider === "sign-in") {
      const linkId = `lnk_${"l".repeat(43)}`;
      await store.putPending(linkPendingKey("cookie"), { verifier: "synthetic-verifier", returnTo: "/app/account", at: now().getTime(), link: { method: "github", developerId: access.developerId, stateHash: sha256(state), linkId } });
      query.delete("code");
      query.set("link_id", linkId);
      query.set("link_code", `lnc_${"c".repeat(43)}`);
      path = "/callback";
    } else {
      const binder = "b".repeat(43);
      await store.putPending(githubStateKey(binder), { verifier: "", returnTo: "/app/onboard", at: now().getTime(), github: { kind: "state", ...(provider === "github-link" ? { flow: "link" as const } : {}), session: sessionBinding("cookie"), developerId: access.developerId, stateHash: sha256(state) } });
      cookie += `; rovara_cloud_github=${binder}`;
      path = "/api/connect/github/callback";
    }
    const writes: string[] = [];
    const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "test", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: async (input) => {
      const codePath = new URL(input instanceof Request ? input.url : input).pathname;
      if (codePath === "/v1/auth/token") return json(200, { access_token: "new", refresh_token: "refresh-new" });
      writes.push(codePath);
      return json(401, {});
    } });
    const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, now, org: { orgId: "acme", name: "Acme", plan: "test" }, log: () => undefined });
    const answer = await handler({ method: "GET", path, query, headers: { cookie } });
    expect(answer?.status).toBe(503);
    expect(JSON.parse(answer!.body)).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: "The request's outcome is unknown. Check its status before trying again." } });
    expect(answer?.headers["location"]).toBeUndefined();
    expect(answer?.headers["cache-control"]).toBe("no-store");
    expect(answer?.headers["referrer-policy"]).toBe("no-referrer");
    if (provider !== "sign-in") expect(answer?.headers["set-cookie"]).toContain("Max-Age=0");
    expect(writes).toHaveLength(1);
    expect((await store.get("cookie"))?.accessToken).toBe("new");
  });
});
