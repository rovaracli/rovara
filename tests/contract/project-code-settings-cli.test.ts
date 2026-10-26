// Rovara Code (Plan 6 Task 19, with the Task 25 slice the controller moved here): `agentx project code-settings <project> [--self-approval on|off] [--merge-method squash|merge]
// [--reviewers a,b]` against a fake control plane. It reads the settings and their revision, changes what is asked under that revision, and for self-approval turned on prints the
// link where an organization owner or admin confirms it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFIRM = `${URL_}/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa?ticket=t`;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const settings = (extra: Record<string, unknown> = {}) => ({ allowSelfApproval: false, mergeMethod: "squash", codeReviewers: [], revision: 3, ...extra });

async function cli(answer: (method: string, path: string, body: unknown) => Response) {
  const home = await mkdtemp(join(tmpdir(), "rovara-code-settings-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ method: string; path: string; authorization: string | null; body: unknown }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path, authorization: new Headers(init?.headers).get("authorization"), body });
    return answer(method, path, body);
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { run, out, err, calls };
}

describe("agentx project code-settings", () => {
  it("reads the settings and says them in words when no change is asked", async () => {
    const h = await cli(() => Response.json({ settings: settings({ allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["alice", "acme/core"] }) }));
    expect(await h.run(["project", "code-settings", "web"])).toBe(0);
    expect(h.calls.map((call) => [call.method, call.path])).toEqual([["GET", "/v1/app/projects/web/code-settings"]]);
    expect(h.out.join("")).toBe([
      "Code settings for web (revision 3):", "  Self-approval: on", "  Merge method: merge", "  Reviewers: alice, acme/core", "",
    ].join("\n"));
  });

  it("says no reviewers and self-approval off", async () => {
    const h = await cli(() => Response.json({ settings: settings() }));
    expect(await h.run(["project", "code-settings", "web"])).toBe(0);
    expect(h.out.join("")).toContain("  Self-approval: off");
    expect(h.out.join("")).toContain("  Reviewers: none");
  });

  it("changes the merge method and the reviewers under the revision it read, with a fresh request id", async () => {
    const h = await cli((method) => (method === "GET" ? Response.json({ settings: settings() })
      : Response.json({ settings: settings({ mergeMethod: "merge", codeReviewers: ["alice", "acme/core"], revision: 4 }) })));
    expect(await h.run(["project", "code-settings", "web", "--merge-method", "merge", "--reviewers", "alice, acme/core"])).toBe(0);
    expect(h.calls.map((call) => [call.method, call.path])).toEqual([["GET", "/v1/app/projects/web/code-settings"], ["PUT", "/v1/app/projects/web/code-settings"]]);
    expect(h.calls[1]).toMatchObject({ authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string, expectedRevision: 3, mergeMethod: "merge", codeReviewers: ["alice", "acme/core"] } });
    expect(Object.keys(h.calls[1]!.body as object).sort()).toEqual(["codeReviewers", "expectedRevision", "mergeMethod", "requestId"]);
    expect(h.out.join("")).toContain("Changed the code settings of web.");
  });

  it("turns self-approval off at once", async () => {
    const h = await cli((method) => (method === "GET" ? Response.json({ settings: settings({ allowSelfApproval: true }) }) : Response.json({ settings: settings({ revision: 4 }) })));
    expect(await h.run(["project", "code-settings", "web", "--self-approval", "off"])).toBe(0);
    expect(h.calls[1]!.body).toMatchObject({ allowSelfApproval: false, expectedRevision: 3 });
    expect(h.out.join("")).toContain("  Self-approval: off");
  });

  it("turning self-approval on prints the link where an organization owner or admin confirms it, and says nothing has changed", async () => {
    const h = await cli((method) => (method === "GET" ? Response.json({ settings: settings() })
      : Response.json({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM, changes: ["Let a person approve a pull request that Rovara made for them, in project web"] }, { status: 202 })));
    expect(await h.run(["project", "code-settings", "web", "--self-approval", "on"])).toBe(0);
    expect(h.calls[1]!.body).toMatchObject({ allowSelfApproval: true, expectedRevision: 3 });
    const text = h.out.join("");
    expect(text).toContain("An organization owner or admin has to confirm turning self-approval on. Nothing has changed for it yet.");
    expect(text).toContain("  - Let a person approve a pull request that Rovara made for them, in project web");
    expect(text).toContain(`Confirm this in your browser: ${CONFIRM}`);
  });

  it("says what applied at once when the same request also turns self-approval on", async () => {
    const h = await cli((method) => (method === "GET" ? Response.json({ settings: settings() })
      : Response.json({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM, changes: ["Let a person approve a pull request that Rovara made for them, in project web"] }, { status: 202 })));
    expect(await h.run(["project", "code-settings", "web", "--self-approval", "on", "--merge-method", "merge"])).toBe(0);
    expect(h.out.join("")).toContain("Changed now: merge method merge.");
  });

  it("prints only a link on the control plane's own address", async () => {
    const h = await cli((method) => (method === "GET" ? Response.json({ settings: settings() })
      : Response.json({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://evil.example.com/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: [] }, { status: 202 })));
    expect(await h.run(["project", "code-settings", "web", "--self-approval", "on"])).not.toBe(0);
    expect(h.out.join("")).not.toContain("evil.example.com");
  });

  it("refuses a value it cannot send, before it asks the server anything", async () => {
    for (const argv of [["--self-approval", "maybe"], ["--merge-method", "rebase"], ["--reviewers", "not a name"], ["--reviewers", Array.from({ length: 11 }, (_, index) => `r${String(index)}`).join(",")]]) {
      const h = await cli(() => Response.json({ settings: settings() }));
      expect(await h.run(["project", "code-settings", "web", ...argv])).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it("clears the reviewers with --reviewers none", async () => {
    const h = await cli((method) => (method === "GET" ? Response.json({ settings: settings({ codeReviewers: ["alice"] }) }) : Response.json({ settings: settings({ revision: 4 }) })));
    expect(await h.run(["project", "code-settings", "web", "--reviewers", "none"])).toBe(0);
    expect(h.calls[1]!.body).toMatchObject({ codeReviewers: [] });
  });

  it("shows the server's refusal as it words it: a stale revision, a contributor", async () => {
    const stale = await cli((method) => (method === "GET" ? Response.json({ settings: settings() })
      : Response.json({ error: { code: "CONFIG_INVALID", message: "Someone changed these settings. Reload and try again." } }, { status: 400 })));
    expect(await stale.run(["project", "code-settings", "web", "--merge-method", "merge"])).toBe(2);
    expect(stale.err.join("")).toContain("Someone changed these settings. Reload and try again.");
    const forbidden = await cli(() => Response.json({ error: { code: "FORBIDDEN", message: "only a project maintainer can change its code settings" } }, { status: 403 }));
    expect(await forbidden.run(["project", "code-settings", "web", "--merge-method", "merge"])).toBe(4);
    expect(forbidden.err.join("")).toContain("only a project maintainer can change its code settings");
  });

  it("prints the settings as JSON with --json", async () => {
    const h = await cli(() => Response.json({ settings: settings() }));
    expect(await h.run(["--json", "project", "code-settings", "web"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { settings: { mergeMethod: "squash", revision: 3 } } });
  });
});
