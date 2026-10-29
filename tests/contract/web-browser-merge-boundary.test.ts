// Owner decision 2026-10-27: Merge merges at once only for a caller the web boundary vouched for (a live browser session cookie, the same-origin header and the CSRF token). A token never carries that mark.
import { describe, expect, it, vi } from "vitest";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import type * as developerRoutes from "../../packages/broker/src/aws/developer-routes.js";

const SID = "11111111-1111-4111-8111-111111111111";
const CELL = "https://cell.example";
const caller = { developerId: "a".repeat(64), sessionId: SID, amr: "cloud" as const, name: "Priya", orgId: "org_aaaaaaaaaaaaaaaaaaaa", orgRole: "member" as const };

vi.mock("../../packages/broker/src/aws/developer-routes.js", async (original) => ({
  ...(await original<typeof developerRoutes>()),
  authenticateDeveloperSessionId: async () => ({ ...caller }),
}));

const { authenticateWebRequest } = await import("../../packages/broker/src/aws/web-auth.js");
const deps = { developer: { issuer: `${CELL}/v1/auth`, methods: { cloud: true } } } as never;
const request = (headers: Record<string, string>, method = "POST") => ({ method, path: "/v1/web/sessions/x/merge", headers: { "sec-fetch-site": "same-origin", ...headers }, requestId: "r" }) as never;
const cookie = `__Host-agentx_review_session=${SID}`;

describe("the web boundary's mark on a caller", () => {
  it("marks a caller that came with a cookie, the app's origin and the matching CSRF token", async () => {
    const who = await authenticateWebRequest(deps, request({ cookie, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }));
    expect(who.browserSession).toBe(true);
    expect(who.developerId).toBe(caller.developerId);
  });

  it("marks a read as well (the mark says how the caller signed in, not what they asked)", async () => {
    expect((await authenticateWebRequest(deps, request({ cookie }, "GET"))).browserSession).toBe(true);
  });

  it("refuses a write without the CSRF token, from another origin, or with a wrong token: nothing is marked", async () => {
    await expect(authenticateWebRequest(deps, request({ cookie, origin: CELL }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(authenticateWebRequest(deps, request({ cookie, origin: "https://evil.example", [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(authenticateWebRequest(deps, request({ cookie, origin: CELL, [APP_CSRF_HEADER]: "wrong" }))).rejects.toMatchObject({ code: "CSRF_STALE" });
    await expect(authenticateWebRequest(deps, request({ cookie, origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID), "sec-fetch-site": "cross-site" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a bearer token on the web boundary: a token is never a browser session", async () => {
    await expect(authenticateWebRequest(deps, request({ cookie, authorization: "Bearer x", origin: CELL, [APP_CSRF_HEADER]: appCsrfTokenFor(SID) }))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
