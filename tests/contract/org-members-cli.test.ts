// Plan 2, Task 4: `agentx org members | role | remove | leave` against a fake control plane: the requests each command sends and the
// lines it prints.
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
const MAYA = "a".repeat(64);
const BEA = "b".repeat(64);
const MEMBERS = [
  { developerId: MAYA, name: "Maya Chen", email: "maya@example.com", role: "owner", joinedAt: "2026-10-01T00:00:00.000Z", identities: ["cloud", "github"] },
  { developerId: BEA, name: "Bea Ortiz", email: "bea@example.com", role: "member", joinedAt: "2026-10-02T00:00:00.000Z", identities: ["cloud"] },
];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function cli(answer: (method: string, path: string, body: unknown) => Response | undefined, options: { confirm?: (question: string) => Promise<boolean>; members?: unknown[] } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-org-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path === "/v1/app/org/members") return Response.json({ members: options.members ?? MEMBERS, requestId: "r" });
    return answer(method, path, body) ?? new Response("unexpected", { status: 500 });
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
  return { run, out, err, calls };
}

describe("agentx org", () => {
  it("members lists each person with role, ID and sign-in methods", async () => {
    const h = await cli(() => undefined);
    expect(await h.run(["org", "members"])).toBe(0);
    expect(h.out.join("")).toBe([
      `Members of your organization on staging (${URL_}):`,
      `  Maya Chen <maya@example.com>  owner  ${MAYA}  signs in with Rovara sign-in, GitHub`,
      `  Bea Ortiz <bea@example.com>  member  ${BEA}  signs in with Rovara sign-in`,
      "",
    ].join("\n"));
  });

  it("members lists names and roles alone for a plain member, whose list has no emails, join dates or sign-in methods", async () => {
    const h = await cli(() => undefined, { members: [{ developerId: MAYA, name: "Maya Chen", role: "owner" }, { developerId: BEA, name: "Member 3fa9", role: "member" }] });
    expect(await h.run(["org", "members"])).toBe(0);
    expect(h.out.join("")).toBe([
      `Members of your organization on staging (${URL_}):`,
      `  Maya Chen  owner  ${MAYA}`,
      `  Member 3fa9  member  ${BEA}`,
      "",
    ].join("\n"));
  });

  it("role finds the person by email, sends a PUT with a request ID, and says the new role", async () => {
    const h = await cli((method, path) => (method === "PUT" && path === `/v1/app/org/members/${BEA}/role` ? Response.json({ developerId: BEA, role: "admin", requestId: "r" }) : undefined));
    expect(await h.run(["org", "role", "BEA@example.com", "admin"])).toBe(0);
    const put = h.calls.find((call) => call.method === "PUT")!;
    expect(put.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, role: "admin" });
    expect(h.out.join("")).toBe("Bea Ortiz is now an admin.\n");
  });

  it("role refuses an unknown role before it calls anything but the member list", async () => {
    const h = await cli(() => undefined);
    expect(await h.run(["org", "role", "bea@example.com", "boss"])).not.toBe(0);
    expect(h.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("role shows the server's LAST_OWNER words", async () => {
    const words = "An organization needs at least one owner. Make someone else an owner first.";
    const h = await cli(() => Response.json({ error: { code: "LAST_OWNER", message: `LAST_OWNER: ${words}` } }, { status: 409 }));
    expect(await h.run(["org", "role", MAYA, "member"])).not.toBe(0);
    expect(h.err.join("")).toContain(words);
  });

  it("remove sends a DELETE for the person the email names and prints what the server says happens to their tasks", async () => {
    const message = "Bea Ortiz's running tasks will stop after their current step. None of them will open a pull request.";
    const h = await cli((method, path) => (method === "DELETE" && path === `/v1/app/org/members/${BEA}` ? Response.json({ removed: { developerId: BEA, name: "Bea Ortiz" }, message, requestId: "r" }) : undefined));
    expect(await h.run(["org", "remove", "bea@example.com"])).toBe(0);
    expect(h.out.join("")).toBe(`Removed Bea Ortiz from your organization. ${message}\n`);
  });

  it("remove says so when nobody matches, and sends no DELETE", async () => {
    const h = await cli(() => undefined);
    expect(await h.run(["org", "remove", "nobody@example.com"])).not.toBe(0);
    expect(h.err.join("")).toContain("no member of your organization has the email or ID nobody@example.com");
    expect(h.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  const me = (role: string) => Response.json({ developer: { id: MAYA, name: "Maya Chen", orgRole: role }, org: { orgId: `org_${"a".repeat(20)}`, name: "Acme", plan: "team" }, identities: [], requestId: "r" });

  it("leave asks first, and tells the only member that the organization closes and its GitHub connection is released", async () => {
    const questions: string[] = [];
    const h = await cli((method, path) => {
      if (method === "GET" && path === "/v1/app/me") return me("owner");
      if (method === "POST" && path === "/v1/app/org/leave") return Response.json({ left: true, orgClosed: true, message: "You left and the organization is closed.", requestId: "r" });
      return undefined;
    }, { members: [MEMBERS[0]], confirm: async (question) => { questions.push(question); return true; } });
    expect(await h.run(["org", "leave"])).toBe(0);
    expect(questions).toEqual(["You are the only member of Acme, so leaving closes the organization and releases its GitHub connection. Leave and close Acme?"]);
    expect(h.calls.find((call) => call.method === "POST")!.body).toEqual({});
    expect(h.out.join("")).toBe("You left and the organization is closed.\n");
  });

  it("leave does nothing when the person says no", async () => {
    const h = await cli((method, path) => (method === "GET" && path === "/v1/app/me" ? me("member") : undefined), { confirm: async () => false });
    expect(await h.run(["org", "leave"])).not.toBe(0);
    expect(h.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("leave --yes skips the question", async () => {
    const h = await cli((method, path) => {
      if (method === "GET" && path === "/v1/app/me") return me("member");
      if (method === "POST" && path === "/v1/app/org/leave") return Response.json({ left: true, orgClosed: false, message: "m", requestId: "r" });
      return undefined;
    });
    expect(await h.run(["org", "leave", "--yes"])).toBe(0);
    expect(h.out.join("")).toBe("You left the organization.\n");
  });
});

describe("agentx org comment-triggers list (Plan 3, Task 14b)", () => {
  const OPT_OUT = {
    project: "payments", repository: "example/demo", digest: "d".repeat(64), files: [".github/workflows/triage.yml", "scripts/triage.sh"],
    reviewedBy: MAYA, reviewedAt: "2026-10-22T09:00:00.000Z", reason: "Only our own triage bot reacts",
  };
  const guardrails = (commentTriggerOptOuts: unknown[]) => Response.json({ guardrails: {}, revision: 1, commentTriggerOptOuts, requestId: "r" });

  it("reads the opt-outs from the guardrails and prints each with its reviewer, reason and files", async () => {
    const h = await cli((method, path) => (method === "GET" && path === "/v1/app/org/agent-guardrails" ? guardrails([OPT_OUT]) : undefined));
    expect(await h.run(["org", "comment-triggers", "list"])).toBe(0);
    expect(h.out.join("")).toBe([
      `Repositories opted out of the comment-triggered workflow rule on staging (${URL_}):`,
      `  payments  example/demo  digest dddddddddddd  reviewed by ${MAYA} at 2026-10-22T09:00:00.000Z`,
      "    reason: Only our own triage bot reacts",
      "    .github/workflows/triage.yml",
      "    scripts/triage.sh",
      "",
    ].join("\n"));
    expect(h.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("says so when there are none, and prints JSON on request", async () => {
    const none = await cli((method, path) => (method === "GET" && path === "/v1/app/org/agent-guardrails" ? guardrails([]) : undefined));
    expect(await none.run(["org", "comment-triggers", "list"])).toBe(0);
    expect(none.out.join("")).toBe(`No repository is opted out of the comment-triggered workflow rule in your organization on staging (${URL_}).\n`);
    const json = await cli((method, path) => (method === "GET" && path === "/v1/app/org/agent-guardrails" ? guardrails([OPT_OUT]) : undefined));
    expect(await json.run(["--json", "org", "comment-triggers", "list"])).toBe(0);
    expect(JSON.parse(json.out.join(""))).toMatchObject({ ok: true, data: { commentTriggerOptOuts: [OPT_OUT] } });
  });

  it("neutralises what the server sent and shows a long file list in part", async () => {
    const files = Array.from({ length: 25 }, (_, index) => `scripts/s${String(index)}.sh`);
    const h = await cli((method, path) => (method === "GET" && path === "/v1/app/org/agent-guardrails"
      ? guardrails([{ ...OPT_OUT, reason: "line\u001b[31m red\nnext", files: ["a\u202Eb.yml", ...files.slice(1)] }]) : undefined));
    expect(await h.run(["org", "comment-triggers", "list"])).toBe(0);
    const text = h.out.join("");
    expect(text.includes("\u001b") || text.includes("\u202E")).toBe(false);
    expect(text).toContain("and 5 more files");
    expect(text.split("\n").filter((line) => line.startsWith("    scripts/")).length).toBe(19);
  });

  it("shows the server's words when the call is refused", async () => {
    const h = await cli(() => Response.json({ error: { code: "FORBIDDEN", message: "FORBIDDEN: nope\u202Eflipped" } }, { status: 403 }));
    expect(await h.run(["org", "comment-triggers", "list"])).not.toBe(0);
    expect(h.err.join("")).toContain("nope[U+202E]flipped");
    expect(h.err.join("")).not.toContain("\u202E");
  });
});

it("lists the restricted directory without requiring private details", async () => { const h = await cli(() => undefined, { members: [{ developerId: MAYA, name: "Maya Chen", role: "member" }] });expect(await h.run(["org", "members"])).toBe(0);expect(h.out.join("")).toContain("Maya Chen  member");expect(h.out.join("")).not.toContain("signs in with"); });
it("resolves an exact email through the server when the directory is restricted", async () => { const h = await cli((method, path) => path.endsWith("/lookup") ? Response.json({ match: { developerId: BEA, name: "Bea Ortiz" }, requestId: "wire-fixture" }) : method === "PUT" ? Response.json({ developerId: BEA, role: "admin" }) : undefined, { members: [{ developerId: BEA, name: "Bea Ortiz", role: "member" }] });expect(await h.run(["org", "role", "bea@example.com", "admin"])).toBe(0);expect(h.calls.find(call => call.path.endsWith("/lookup"))).toMatchObject({ method: "POST", body: { email: "bea@example.com" } }); });
