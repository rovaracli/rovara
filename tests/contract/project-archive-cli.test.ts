// Plan 2, Task 20: `agentx project archive <name>` (asks first) and `agentx project restore <name>` against a fake control plane: the request each
// sends and the lines it prints.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { createCliProgram, executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const detail = (status: "active" | "archived") => ({
  name: "web", status, latestRevision: 2, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "unchecked" },
  settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] },
  createdAt: "2026-10-02T00:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya Chen" },
});

async function cli(answer: (method: string, path: string) => Response, options: { confirm?: (question: string) => Promise<boolean> } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-project-archive-cli-"));
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
    calls.push({ method, path, authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    return answer(method, path);
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
  return { run, out, err, calls };
}

describe("agentx project archive", () => {
  it("asks first, then posts a request id to the archive route with the developer session and says what changed", async () => {
    const questions: string[] = [];
    const h = await cli(() => Response.json({ project: detail("archived"), warnings: [], requestId: "r" }), { confirm: async (question) => { questions.push(question); return true; } });
    expect(await h.run(["project", "archive", "web"])).toBe(0);
    expect(questions).toEqual(["Archive web? Nobody can start new tasks in it until it is restored. Tasks already running keep going, but lose access to this project's approved extra domains."]);
    expect(h.calls).toEqual([{ method: "POST", path: "/v1/app/projects/web/archive", authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.out.join("")).toBe("Archived web. To bring it back, run: agentx project restore web\n");
  });

  it("does nothing when the person says no", async () => {
    const h = await cli(() => Response.json({}), { confirm: async () => false });
    expect(await h.run(["project", "archive", "web"])).not.toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain("nothing changed");
  });

  it("--yes skips the question, and --json prints the project", async () => {
    const confirm = vi.fn(async () => false);
    const h = await cli(() => Response.json({ project: detail("archived"), warnings: [], requestId: "r" }), { confirm });
    expect(await h.run(["--json", "project", "archive", "web", "--yes"])).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { project: { name: "web", status: "archived" } } });
  });

  it("shows the server's words when it refuses, and encodes the name in the path", async () => {
    const words = "only a project maintainer can archive or restore a project";
    const h = await cli(() => Response.json({ error: { code: "FORBIDDEN", message: `FORBIDDEN: ${words}` } }, { status: 403 }));
    expect(await h.run(["project", "archive", "we b", "--yes"])).not.toBe(0);
    expect(h.calls[0]!.path).toBe("/v1/app/projects/we%20b/archive");
    expect(h.err.join("")).toContain(words);
  });
});

describe("warnings and help", () => {
  const WARNING = "The firewall will apply this within 5 minutes.";

  it("prints each warning the server sent after the archive and restore lines, and --json carries them", async () => {
    const archived = await cli(() => Response.json({ project: detail("archived"), warnings: [WARNING], requestId: "r" }));
    expect(await archived.run(["project", "archive", "web", "--yes"])).toBe(0);
    expect(archived.out.join("")).toBe(`Archived web. To bring it back, run: agentx project restore web\nNote: ${WARNING}\n`);
    const restored = await cli(() => Response.json({ project: detail("active"), warnings: [WARNING], requestId: "r" }));
    expect(await restored.run(["project", "restore", "web"])).toBe(0);
    expect(restored.out.join("")).toBe(`Restored web. People can start tasks in it again, and its approved domains are allowed again.\nNote: ${WARNING}\n`);
    const json = await cli(() => Response.json({ project: detail("archived"), warnings: [WARNING], requestId: "r" }));
    expect(await json.run(["--json", "project", "archive", "web", "--yes"])).toBe(0);
    expect(JSON.parse(json.out.join(""))).toMatchObject({ data: { warnings: [WARNING] } });
  });

  it("does not say the commands are for Rovara Cloud only", () => {
    const project = createCliProgram().commands.find((command) => command.name() === "project")!;
    for (const name of ["archive", "restore"]) {
      expect(project.commands.find((command) => command.name() === name)!.description(), name).not.toContain("Rovara Cloud");
    }
  });
});

describe("agentx project restore", () => {
  it("posts a request id to the restore route without asking, and says what changed", async () => {
    const h = await cli(() => Response.json({ project: detail("active"), warnings: [], requestId: "r" }));
    expect(await h.run(["project", "restore", "web"])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: "/v1/app/projects/web/restore", authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.out.join("")).toBe("Restored web. People can start tasks in it again, and its approved domains are allowed again.\n");
  });
});
