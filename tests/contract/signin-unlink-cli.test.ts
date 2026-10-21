// Plan 2, Task 8: `agentx signin unlink <cloud|github>` against a fake control plane: the request it sends and the lines it prints.
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

async function cli(answer: (method: string, path: string) => Response | undefined) {
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
    return answer(method, path) ?? new Response("unexpected", { status: 500 });
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { run, out, err, calls };
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
