// Plan 2, Task 22: `agentx project check <name>` against a fake control plane. It posts a fresh request id to the setup-check route, then reads the project
// every 10 seconds until the check is no longer running, and says how it ended: ready, failed (with the failing step, and a non-zero exit) or outdated.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSetupCheckBodySchema } from "@rovara-code/contracts";
import { ProjectSetupCheckResponseSchema } from "@agentx/cloud-contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

type Setup = { status: "unchecked" | "checking" | "ready" | "failed" | "outdated"; checkedRevision?: number; checkedAt?: string; failedStep?: string };
const detail = (setup: Setup, revision = 2) => ({
  name: "web", status: "active", latestRevision: revision, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer", setup,
  settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] },
  createdAt: "2026-10-02T00:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya Chen" },
});
const CHECKING: Setup = { status: "checking", checkedRevision: 2, checkedAt: "2026-10-21T00:00:00.000Z" };

async function cli(answer: (method: string, path: string, call: number) => Response) {
  const home = await mkdtemp(join(tmpdir(), "rovara-project-check-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const slept: number[] = [];
  const calls: Array<{ method: string; path: string; authorization: string | null; body: unknown }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    return answer(method, path, calls.length);
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home }, sleep: async (ms) => { slept.push(ms); },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { run, out, err, calls, slept };
}

/** The server: the POST answers `first`; each later GET answers the next of `later` (the last one repeats). */
const server = (first: Setup, ...later: Setup[]) => (method: string, path: string, call: number) => {
  if (method === "POST") return Response.json({ project: detail(first) }, { status: 202 });
  return Response.json(detail(later[Math.min(call - 2, later.length - 1)]!));
};

describe("the contract", () => {
  it("accepts a request id and nothing else, and answers the project", () => {
    expect(ProjectSetupCheckBodySchema.safeParse({ requestId: "7f6c1f4e-0b57-4c4b-9a0b-0e7f0e1f2a3b" }).success).toBe(true);
    expect(ProjectSetupCheckBodySchema.safeParse({}).success).toBe(false);
    expect(ProjectSetupCheckBodySchema.safeParse({ requestId: "7f6c1f4e-0b57-4c4b-9a0b-0e7f0e1f2a3b", project: "x" }).success).toBe(false);
    expect(ProjectSetupCheckResponseSchema.parse({ project: detail(CHECKING) }).project.setup.status).toBe("checking");
  });
});

describe("agentx project check", () => {
  it("posts a request id to the setup-check route, waits 10 seconds between reads while it is checking, and says it passed", async () => {
    const h = await cli(server(CHECKING, CHECKING, CHECKING, { status: "ready", checkedRevision: 2, checkedAt: "2026-10-21T00:00:00.000Z" }));
    expect(await h.run(["project", "check", "web"])).toBe(0);
    expect(h.calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/v1/app/projects/web/setup-check"], ["GET", "/v1/app/projects/web"], ["GET", "/v1/app/projects/web"], ["GET", "/v1/app/projects/web"],
    ]);
    expect(h.calls[0]).toMatchObject({ authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string } });
    expect(h.slept).toEqual([10_000, 10_000, 10_000]);
    expect(h.out.join("")).toContain("Setup check passed for web (revision 2)");
    expect(h.err).toEqual([]);
  });

  it("does not wait when the check is already over (a replayed request)", async () => {
    const h = await cli(server({ status: "ready", checkedRevision: 2, checkedAt: "x" }));
    expect(await h.run(["project", "check", "web"])).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.slept).toEqual([]);
  });

  it("fails with a non-zero exit and names the failing step", async () => {
    const h = await cli(server(CHECKING, CHECKING, { status: "failed", checkedRevision: 2, checkedAt: "x", failedStep: "test: npm test - readiness check 0 (npm test in repo/web) exited 1" }));
    expect(await h.run(["project", "check", "web"])).toBe(2);
    expect(h.err.join("")).toContain("Setup check failed for web (revision 2): test: npm test - readiness check 0 (npm test in repo/web) exited 1");
    expect(h.out.join("")).toBe("");
  });

  it("says the settings changed under it when the check ends outdated", async () => {
    const h = await cli((method) => method === "POST" ? Response.json({ project: detail(CHECKING) }, { status: 202 })
      : Response.json(detail({ status: "outdated", checkedRevision: 2, checkedAt: "x" }, 3)));
    expect(await h.run(["project", "check", "web"])).toBe(0);
    expect(h.out.join("")).toBe("The settings of web changed while it was being checked (it ran at revision 2, the project is now at revision 3). Run agentx project check web again.\n");
  });

  it("prints nothing a server can use to move the terminal: control characters and tokens are removed from the failing step", async () => {
    const h = await cli(server({ status: "failed", checkedRevision: 2, checkedAt: "x", failedStep: "setup: npm ci - \u001b[2Jcleared agxr_secretsecretsecret ‮evil" }));
    expect(await h.run(["project", "check", "web"])).toBe(2);
    const text = h.err.join("");
    expect([...text.replace(/\n$/, "")].filter((character) => /[\p{Cc}\p{Cf}]/u.test(character))).toEqual([]);
    expect(text).not.toContain("agxr_secretsecretsecret");
    expect(text).toContain("[hidden]");
  });

  it("gives up with a message, not a hang, when the check is still running after an hour", async () => {
    const h = await cli(server(CHECKING, CHECKING));
    expect(await h.run(["project", "check", "web"])).toBe(6);
    expect(h.slept.reduce((sum, ms) => sum + ms, 0)).toBe(3_600_000);
    expect(h.err.join("")).toContain("still running");
  });

  it("prints the project and status as JSON with --json", async () => {
    const h = await cli(server(CHECKING, { status: "ready", checkedRevision: 2, checkedAt: "x" }));
    expect(await h.run(["--json", "project", "check", "web"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { project: { name: "web", setup: { status: "ready" } } } });
  });

  it("shows the server's refusal as it words it (a viewer, a locked trial, a running check)", async () => {
    const h = await cli(() => Response.json({ error: { code: "FORBIDDEN", message: "only a project maintainer can run a setup check" } }, { status: 403 }));
    expect(await h.run(["project", "check", "web"])).toBe(4);
    expect(h.err.join("")).toContain("only a project maintainer can run a setup check");
  });
});
