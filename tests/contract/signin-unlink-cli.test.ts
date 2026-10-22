// Plan 2, Task 8 and 8b: `agentx signin unlink <cloud|github>` and `agentx signin link <cloud|github>` against a fake control plane: the
// request they send, the fresh sign-in they run when the server asks for one (and retry once after), and the lines they print.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const REFRESH_2 = `agxr_${"b".repeat(43)}`;
const configuration = {
  env: "staging", apiVersion: "1.0", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
  revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: false, oidc: null, cloud: { displayName: "Rovara" }, github: { displayName: "GitHub" } },
};
const REAUTH_WORDS = "to change your sign-in methods, sign in again first with a method you are keeping, then try again";
const reauthRefusal = () => Response.json({ error: { code: "REAUTH_REQUIRED", message: REAUTH_WORDS } }, { status: 403 });

async function cli(answer: (method: string, path: string, authorization: string | null) => Response | undefined) {
  const home = await mkdtemp(join(tmpdir(), "rovara-unlink-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ method: string; path: string; body: unknown; authorization: string | null }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body, authorization: new Headers(init?.headers).get("authorization") });
    const authorization = new Headers(init?.headers).get("authorization");
    if (path === "/v1/auth/.well-known/agentx-configuration") return Response.json(configuration);
    if (path === "/v1/auth/token") return Response.json({ access_token: "access2", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH_2 });
    return answer(method, path, authorization) ?? new Response("unexpected", { status: 500 });
  });
  const opened: string[] = [];
  // The browser: a sign-in link ends at the CLI's loopback with a code; any other link (a page of the server's) is only recorded.
  const openBrowser = vi.fn(async (link: string) => {
    opened.push(link);
    const authorize = new URL(link);
    const redirect = authorize.searchParams.get("redirect_uri");
    if (redirect === null) return;
    const callback = new URL(redirect);
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "agxc_code");
    await fetch(callback);
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home }, login: { openBrowser },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { run, out, err, calls, opened, tokenStore };
}

const LEFT = [{ provider: "cloud", email: "priya@acme.dev", linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-02T00:00:00.000Z" }];

describe("agentx signin unlink", () => {
  it("sends a signed-in DELETE for the method and says what is left", async () => {
    const h = await cli((method, path) => (method === "DELETE" && path === "/v1/app/me/identities/github" ? Response.json({ identities: LEFT, requestId: "r" }) : undefined));
    expect(await h.run(["signin", "unlink", "github"])).toBe(0);
    expect(h.calls).toEqual([{ method: "DELETE", path: "/v1/app/me/identities/github", body: undefined, authorization: "Bearer access" }]);
    expect(h.out.join("")).toBe("Removed GitHub from your account. Sessions signed in that way have ended.\nYou can still sign in with Rovara sign-in.\n");
  });

  it("refuses a method that is not cloud or github before it calls anything", async () => {
    const h = await cli(() => undefined);
    expect(await h.run(["signin", "unlink", "slack"])).not.toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain("use cloud or github");
  });

  it("shows the server's words when it refuses the only or the first sign-in", async () => {
    const words = "this is your only way to sign in, so it can't be removed";
    const h = await cli(() => Response.json({ error: { code: "CONFIG_INVALID", message: words } }, { status: 400 }));
    expect(await h.run(["signin", "unlink", "cloud"])).not.toBe(0);
    expect(h.err.join("")).toContain(words);
  });

  it("says so when the method is not linked", async () => {
    const h = await cli(() => Response.json({ error: { code: "NOT_FOUND", message: "that sign-in method is not linked to your account" } }, { status: 404 }));
    expect(await h.run(["signin", "unlink", "github"])).not.toBe(0);
    expect(h.err.join("")).toContain("that sign-in method is not linked to your account");
  });
});

describe("a fresh sign-in when the server asks for one (Plan 2, Task 8b)", () => {
  it("unlink: on REAUTH_REQUIRED it says why, signs in again without the method being removed, and retries once with the new sign-in", async () => {
    const h = await cli((method, path, authorization) => {
      if (method !== "DELETE" || path !== "/v1/app/me/identities/github") return undefined;
      return authorization === "Bearer access2" ? Response.json({ identities: LEFT, requestId: "r" }) : reauthRefusal();
    });
    expect(await h.run(["signin", "unlink", "github"])).toBe(0);
    expect(h.calls.map((call) => `${call.method} ${call.path} ${call.authorization ?? ""}`.trim())).toEqual([
      "DELETE /v1/app/me/identities/github Bearer access",
      "GET /v1/auth/.well-known/agentx-configuration",
      "POST /v1/auth/token",
      "DELETE /v1/app/me/identities/github Bearer access2",
    ]);
    // The sign-in link leaves out the method being removed.
    expect(h.opened).toHaveLength(1);
    expect(new URL(h.opened[0]!).searchParams.get("exclude_method")).toBe("github");
    // And asks the provider to prompt again, not to reuse a browser session.
    expect(new URL(h.opened[0]!).searchParams.get("fresh")).toBe("1");
    expect(h.err.join("")).toContain(REAUTH_WORDS);
    expect(h.err.join("")).toContain("Signing in again");
    expect(h.out.join("")).toBe("Removed GitHub from your account. Sessions signed in that way have ended.\nYou can still sign in with Rovara sign-in.\n");
    expect(await h.tokenStore.get(developerTokenKey(ISSUER))).toMatchObject({ accessToken: "access2", refreshToken: REFRESH_2 });
  });

  it("unlink: retries only once; a second REAUTH_REQUIRED is shown as it is, with no third attempt", async () => {
    const h = await cli((method, path) => (method === "DELETE" && path === "/v1/app/me/identities/cloud" ? reauthRefusal() : undefined));
    expect(await h.run(["signin", "unlink", "cloud"])).not.toBe(0);
    expect(h.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
    expect(h.opened).toHaveLength(1);
    expect(h.err.join("")).toContain(REAUTH_WORDS);
  });

  it("unlink: asks for no sign-in when the server does not ask, and does not sign in again for any other refusal", async () => {
    const h = await cli(() => Response.json({ error: { code: "CONFIG_INVALID", message: "this is your only way to sign in, so it can't be removed" } }, { status: 400 }));
    expect(await h.run(["signin", "unlink", "cloud"])).not.toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it("link: asks the server for the sign-in link, opens it, and says what to do next", async () => {
    const link = `${ISSUER}/authorize?request=${"a".repeat(43)}&method=cloud`;
    const h = await cli((method, path) => (method === "POST" && path === "/v1/app/me/identities/cloud" ? Response.json({ authorizeUrl: link, requestId: "r" }) : undefined));
    expect(await h.run(["signin", "link", "cloud"])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: "/v1/app/me/identities/cloud", body: undefined, authorization: "Bearer access" }]);
    expect(h.opened).toEqual([link]);
    expect(h.out.join("")).toBe(
      `Opening your browser to add Rovara sign-in (email code) back to your account. If it does not open, open this link:\n${link}\n`
      + "When the page says it was added, run agentx whoami to see it. Only a sign-in method you removed from this account can be added back.\n",
    );
  });

  it("link: with --no-browser it only prints the link", async () => {
    const link = `${ISSUER}/authorize?request=${"a".repeat(43)}&method=github`;
    const h = await cli(() => Response.json({ authorizeUrl: link, requestId: "r" }));
    expect(await h.run(["signin", "link", "github", "--no-browser"])).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.out.join("")).toContain(link);
  });

  it("link: on REAUTH_REQUIRED it signs in again and retries once", async () => {
    const link = `${ISSUER}/authorize?request=${"a".repeat(43)}&method=cloud`;
    const h = await cli((method, path, authorization) => {
      if (method !== "POST" || path !== "/v1/app/me/identities/cloud") return undefined;
      return authorization === "Bearer access2" ? Response.json({ authorizeUrl: link, requestId: "r" }) : reauthRefusal();
    });
    expect(await h.run(["signin", "link", "cloud"])).toBe(0);
    expect(h.calls.filter((call) => call.method === "POST" && call.path.startsWith("/v1/app/"))).toHaveLength(2);
    // The first link opened is the fresh sign-in (it names no method to leave out: nothing is being removed); the last is the link.
    expect(h.opened).toHaveLength(2);
    expect(new URL(h.opened[0]!).searchParams.get("redirect_uri")).not.toBeNull();
    expect(new URL(h.opened[0]!).searchParams.get("exclude_method")).toBeNull();
    expect(h.opened[1]).toBe(link);
  });

  it("link: refuses a method that is not cloud or github before it calls anything", async () => {
    const h = await cli(() => undefined);
    expect(await h.run(["signin", "link", "slack"])).not.toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain("use cloud or github");
  });
});
