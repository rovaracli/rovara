// Lessons for local coding tools (decision 46b, lane B2): `agentx lessons`. It reads the git remote of the directory it runs in (read only; credentials in a clone address are never sent), asks Rovara on every run (no cache),
// finds the project from the repository when none is named, leaves out the lessons already in the checkout's .rovara/lessons.md, and never fails an agent: any failure is one fixed line and exit code 0.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_LESSONS_AMBIGUOUS_LINE, LOCAL_LESSONS_NOT_FOUND_LINE, LOCAL_LESSONS_NO_PROJECT_LINE, LOCAL_LESSONS_UNAVAILABLE_LINE, type LocalLessonsRead } from "@agentx/contracts";
import { executeCli } from "../../packages/cli/src/main.js";
import { readCheckout, withoutCredentials, type GitRunner } from "../../packages/cli/src/developer/checkout.js";

const BASE = "https://rovara.example.test";
// A token-shaped value built at run time (the public repository's push protection refuses a literal one).
const TOKEN = ["tok", "en", "-", "abc123"].join("");
vi.mock("../../packages/cli/src/developer/session.js", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  developerAccessToken: async () => ({ env: "staging", entry: { url: BASE }, accessToken: TOKEN }),
}));

const block = (id = "les_cents0001"): LocalLessonsRead => ({
  status: "ok", message: "", project: "payments", repo: "github.com/acme/api", complete: true, lessons: [{ id, advice: "Amounts are integer cents." }],
  markdown: `<!-- Rovara lessons for project "payments". -->\n## Team lessons (from Rovara; follow them unless the task says otherwise)\n- [${id}] Amounts are integer cents.\n`,
});
interface Sent { method: string; path: string; body: Record<string, unknown> | undefined; authorization: string | undefined }
function server(handlers: { lessons?: (project: string, body: Record<string, unknown>) => { status: number; body?: unknown }; projects?: string[]; offline?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetchImplementation = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).slice(BASE.length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    sent.push({ method: init?.method ?? "GET", path, body, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (handlers.offline === true) throw new TypeError("fetch failed");
    if (path === "/v1/dev/projects") return new Response(JSON.stringify({ developer: { developerId: "d", name: "Maya", provider: "slack" }, projects: (handlers.projects ?? []).map((name) => ({ name, latestRevision: 1, access: "granted", channels: [] })), notices: [] }), { status: 200 });
    const match = /^\/v1\/dev\/projects\/([^/]+)\/lessons$/u.exec(path);
    if (match === null) return new Response("{}", { status: 404 });
    const answer = (handlers.lessons ?? (() => ({ status: 200, body: block() })))(decodeURIComponent(match[1]!), body!);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as typeof fetch;
  return { sent, fetchImplementation };
}
async function run(args: string[], world: ReturnType<typeof server>, checkout: { remote?: string; hasLessonsFile?: boolean } | "none" = { remote: "https://github.com/acme/api.git" }) {
  let out = "";
  let err = "";
  const code = await executeCli(["--env", "staging", ...args], {
    fetchImplementation: world.fetchImplementation, stdout: { write: (text: string) => { out += text; return true; } }, stderr: { write: (text: string) => { err += text; return true; } },
    cwd: "/checkout", checkout: async () => (checkout === "none" ? { hasLessonsFile: false } : { hasLessonsFile: checkout.hasLessonsFile ?? false, ...(checkout.remote === undefined ? {} : { remote: checkout.remote }) }),
  });
  return { code, out, err };
}

describe("agentx lessons", () => {
  it("asks the named project with the checkout's remote, the task, the files and the stage; prints the broker's block and exits 0", async () => {
    const w = server();
    const { code, out } = await run(["--project", "payments", "lessons", "--task", "add refund endpoint", "--files", "src/refunds/handler.ts", "src/money/cents.ts", "--stage", "plan"], w);
    expect(code).toBe(0);
    expect(w.sent).toEqual([{ method: "POST", path: "/v1/dev/projects/payments/lessons", authorization: `Bearer ${TOKEN}`, body: { repo: "https://github.com/acme/api.git", task: "add refund endpoint", files: ["src/refunds/handler.ts", "src/money/cents.ts"], stage: "plan" } }]);
    expect(out).toContain("- [les_cents0001] Amounts are integer cents.");
  });

  it("asks on every run: nothing is cached", async () => {
    const w = server();
    await run(["--project", "payments", "lessons"], w);
    await run(["--project", "payments", "lessons"], w);
    expect(w.sent.filter((s) => s.method === "POST")).toHaveLength(2);
  });

  it("sends the remote without a user name or password, and an explicit --repo wins over the checkout", async () => {
    const w = server();
    await run(["--project", "payments", "lessons"], w, { remote: withoutCredentials(`https://user:${TOKEN}@github.com/acme/api.git`) });
    await run(["--project", "payments", "lessons", "--repo", `https://oauth2:${TOKEN}@github.com/acme/web.git`], w);
    expect(JSON.stringify(w.sent)).not.toContain(TOKEN.slice(0, 3) + "en-abc123@");
    expect(w.sent.map((s) => s.body?.repo)).toEqual(["https://github.com/acme/api.git", "https://github.com/acme/web.git"]);
    expect(withoutCredentials("git@github.com:acme/api.git")).toBe("git@github.com:acme/api.git");
  });

  it("leaves out the lessons already in the checkout's .rovara/lessons.md", async () => {
    const w = server();
    await run(["--project", "payments", "lessons"], w, { remote: "git@github.com:acme/api.git", hasLessonsFile: true });
    expect(w.sent[0]!.body).toMatchObject({ skipRepoFile: true });
    const without = server();
    await run(["--project", "payments", "lessons"], without);
    expect(without.sent[0]!.body).not.toHaveProperty("skipRepoFile");
  });

  it("finds the project from the repository when none is named: the one the broker does not answer 'not found' for", async () => {
    const w = server({ projects: ["billing", "payments", "ops"], lessons: (project) => (project === "payments" ? { status: 200, body: block() } : { status: 404, body: { error: { code: "PROJECT_NOT_FOUND", message: "project not found" } } }) });
    const { code, out } = await run(["lessons"], w);
    expect(code).toBe(0);
    expect(out).toContain("les_cents0001");
    expect(w.sent.filter((s) => s.method === "POST").map((s) => s.path)).toEqual(["billing", "payments", "ops"].map((name) => `/v1/dev/projects/${name}/lessons`));
  });

  it("says plainly, and exits 0, when nothing holds the repository, two projects do, or there is no repository or project to go by", async () => {
    const missing = server({ projects: ["a", "b"], lessons: () => ({ status: 404, body: { error: { code: "PROJECT_NOT_FOUND", message: "project not found" } } }) });
    expect(await run(["lessons"], missing)).toMatchObject({ code: 0, out: `${LOCAL_LESSONS_NOT_FOUND_LINE}\n` });
    expect(await run(["--project", "a", "lessons"], missing)).toMatchObject({ code: 0, out: `${LOCAL_LESSONS_NOT_FOUND_LINE}\n` });
    expect(await run(["lessons"], server({ projects: ["a", "b"] }))).toMatchObject({ code: 0, out: `${LOCAL_LESSONS_AMBIGUOUS_LINE}\n` });
    expect(await run(["lessons"], server(), "none")).toMatchObject({ code: 0, out: `${LOCAL_LESSONS_NO_PROJECT_LINE}\n` });
  });

  it("never fails an agent: offline, an outage, a rate limit and an unreadable answer are the one 'not available' line with exit code 0", async () => {
    for (const [name, world] of [
      ["offline", server({ offline: true })], ["5xx", server({ lessons: () => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } }) })],
      ["429", server({ lessons: () => ({ status: 429, body: { error: { code: "TOO_MANY_REQUESTS", message: "x" } } }) })], ["garbage", server({ lessons: () => ({ status: 200, body: { nope: true } }) })],
      ["unknown status", server({ lessons: () => ({ status: 200, body: { ...block(), status: "later" } }) })],
    ] as const) {
      const { code, out } = await run(["--project", "payments", "lessons"], world);
      expect(code, name).toBe(0);
      expect(out, name).toBe(`${LOCAL_LESSONS_UNAVAILABLE_LINE}\n`);
    }
  });

  it("a sign-in that has ended adds the way back, still exit 0", async () => {
    const { code, out } = await run(["--project", "payments", "lessons"], server({ lessons: () => ({ status: 401, body: { error: { code: "AUTH_REQUIRED", message: "x" } } }) }));
    expect(code).toBe(0);
    expect(out).toContain(LOCAL_LESSONS_UNAVAILABLE_LINE);
    expect(out).toContain("Sign in again: npx @preplabsai/rovara-code login https://rovara.example.test");
  });

  it("prints an 'off' answer's reason, cleans what the server sent for a terminal, and has a JSON form", async () => {
    const off: LocalLessonsRead = { ...block(), status: "off", reason: "regulated", lessons: [], markdown: "<!-- x -->\nThis project is on the Regulated preset.\u001b[31m red\u0007\n" };
    const text = await run(["--project", "payments", "lessons"], server({ lessons: () => ({ status: 200, body: off }) }));
    expect(text.out).toContain("Regulated preset.");
    expect(text.out.includes("\u001b") || text.out.includes("\u0007")).toBe(false);
    const json = await run(["--json", "--project", "payments", "lessons"], server());
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, data: { status: "ok", project: "payments", lessons: [{ id: "les_cents0001", advice: "Amounts are integer cents." }] } });
  });

  it("an unknown stage is a mistake in the command line, and nothing is sent", async () => {
    const w = server();
    const { code } = await run(["--project", "payments", "lessons", "--stage", "deploy"], w);
    expect(code).not.toBe(0);
    expect(w.sent).toEqual([]);
  });
});

describe("the git checkout is read, never written", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  const git = (top: string | undefined, remote: string | undefined): GitRunner => async (args) => (args[0] === "rev-parse" ? top : args[0] === "remote" ? remote : undefined);

  it("finds the origin remote without credentials, and the lessons file only as a regular file", async () => {
    const top = await mkdtemp(join(tmpdir(), "lessons-checkout-"));
    dirs.push(top);
    expect(await readCheckout(top, git(top, `https://u:p@github.com/acme/api.git`))).toEqual({ remote: "https://github.com/acme/api.git", hasLessonsFile: false });
    await mkdir(join(top, ".rovara"));
    await writeFile(join(top, ".rovara", "lessons.md"), "# lessons\n");
    expect(await readCheckout(top, git(top, "git@github.com:acme/api.git"))).toEqual({ remote: "git@github.com:acme/api.git", hasLessonsFile: true });
    await rm(join(top, ".rovara", "lessons.md"));
    await symlink("/etc/hosts", join(top, ".rovara", "lessons.md"));
    expect((await readCheckout(top, git(top, "git@github.com:acme/api.git"))).hasLessonsFile).toBe(false);
  });

  it("outside a checkout, or with no origin, there is no remote and no file", async () => {
    expect(await readCheckout("/anywhere", git(undefined, undefined))).toEqual({ hasLessonsFile: false });
    const top = await mkdtemp(join(tmpdir(), "lessons-checkout-"));
    dirs.push(top);
    expect(await readCheckout(top, git(top, undefined))).toEqual({ hasLessonsFile: false });
  });
});
