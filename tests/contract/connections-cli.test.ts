// Plan 3 Task 12b: `agentx connections list | add | remove | check` against a fake control plane: the requests each sends, the lines each
// prints, and that a secret is read from stdin (masked on a terminal), sent once, and never printed, logged or put in a file.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { createCliProgram, executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const LINEAR_KEY = "lin_api_CLISECRETKEY0123456789";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const saved = (extra: Record<string, unknown> = {}) => ({
  connectionId: CON, type: "linear", label: "Team Linear", access: "read", hasCredential: true,
  createdBy: "1".repeat(64), createdAt: "2026-10-22T09:00:00.000Z", updatedBy: "1".repeat(64), updatedAt: "2026-10-22T09:00:00.000Z", ...extra,
});

async function cli(answer: (method: string, path: string) => Response, stdin?: string, options: { confirm?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-connections-cli-"));
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
  const run = (argv: string[], input: string | undefined = stdin) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home },
    ...(input === undefined ? {} : { stdin: Readable.from([input]) }),
    ...(options.confirm === undefined ? {} : { confirm: async () => options.confirm! }),
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { run, out, err, calls, home };
}

const created = (connection: Record<string, unknown>) => (method: string, path: string): Response =>
  method === "POST" && path === "/v1/app/connections" ? Response.json({ connection, requestId: "r" }, { status: 201 }) : Response.json({ error: { code: "NOT_FOUND", message: `NOT_FOUND: ${method} ${path}` } }, { status: 404 });

describe("agentx connections list", () => {
  it("prints each connection with its type, access, whether a credential is saved and the last check", async () => {
    const h = await cli(() => Response.json({ connections: [
      saved({ lastCheck: { ok: true, at: "2026-10-22T09:30:00.000Z" } }),
      saved({ connectionId: "con_bbbbbbbbbbbbbbbbbbbb", type: "jira", label: "Jira", access: "read_write", siteUrl: "https://acme.atlassian.net", hasCredential: false }),
      saved({ connectionId: "con_cccccccccccccccccccc", type: "mcp", label: "Sentry", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry", lastCheck: { ok: false, at: "2026-10-22T09:40:00.000Z" } }),
    ] }));
    expect(await h.run(["connections", "list"])).toBe(0);
    expect(h.calls).toEqual([{ method: "GET", path: "/v1/app/connections", authorization: "Bearer access", body: undefined }]);
    expect(h.out.join("")).toBe([
      `Connections of your organization on staging (${URL_}):`,
      `  ${CON}  linear  Team Linear  read  credential saved  last check ok (2026-10-22T09:30:00.000Z)`,
      "  con_bbbbbbbbbbbbbbbbbbbb  jira  Jira  read_write  no credential  https://acme.atlassian.net",
      "  con_cccccccccccccccccccc  mcp  Sentry  read  credential saved  https://mcp.acme.dev/mcp  last check failed (2026-10-22T09:40:00.000Z)",
      "",
    ].join("\n"));
  });

  it("says so when there are none, and prints JSON with --json", async () => {
    let h = await cli(() => Response.json({ connections: [] }));
    expect(await h.run(["connections", "list"])).toBe(0);
    expect(h.out.join("")).toContain("No connections yet");
    h = await cli(() => Response.json({ connections: [saved()] }));
    expect(await h.run(["--json", "connections", "list"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { connections: [{ connectionId: CON, hasCredential: true }] } });
  });

  it("neutralises control characters and escape sequences a label or a server message carries", async () => {
    const h = await cli(() => Response.json({ connections: [saved({ label: "Evil\u001b[2J\u0007 label" })] }));
    expect(await h.run(["connections", "list"])).toBe(0);
    // eslint-disable-next-line no-control-regex -- the point is that no control character reaches the terminal
    expect(h.out.join("")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    const refused = await cli(() => Response.json({ error: { code: "FORBIDDEN", message: "FORBIDDEN: nope\u001b]0;pwned\u0007" } }, { status: 403 }));
    expect(await refused.run(["connections", "list"])).not.toBe(0);
    expect(refused.err.join("")).not.toContain("\u001b");
  });
});

describe("agentx connections add", () => {
  it("reads a Linear key from stdin, sends it once with a fresh request id, and prints neither the key nor the secret's name", async () => {
    const h = await cli(created(saved()), `${LINEAR_KEY}\n`);
    expect(await h.run(["connections", "add", "linear", "--label", "Team Linear"])).toBe(0);
    expect(h.calls).toEqual([{
      method: "POST", path: "/v1/app/connections", authorization: "Bearer access",
      body: { requestId: expect.stringMatching(UUID) as string, connection: { type: "linear", label: "Team Linear", access: "read" }, secret: { apiKey: LINEAR_KEY } },
    }]);
    expect(h.out.join("")).toBe(`Added the linear connection Team Linear (${CON}). Run agentx connections check ${CON} to test it.\n`);
    expect(h.out.join("") + h.err.join("")).not.toContain(LINEAR_KEY);
    // The prompt says it is hidden; the key is not echoed back.
    expect(h.err.join("")).toContain("hidden");
  });

  it("sends a Jira site with the account email and the token, and an MCP endpoint with its vendor and auth header", async () => {
    let h = await cli(created(saved({ type: "jira", siteUrl: "https://acme.atlassian.net" })), "jira-token\n");
    expect(await h.run(["connections", "add", "jira", "--label", "Jira", "--access", "read_write", "--site-url", "https://acme.atlassian.net", "--email", "svc@acme.com"])).toBe(0);
    expect(h.calls[0]!.body).toMatchObject({ connection: { type: "jira", label: "Jira", access: "read_write", siteUrl: "https://acme.atlassian.net" }, secret: { email: "svc@acme.com", apiToken: "jira-token" } });
    h = await cli(created(saved({ type: "mcp", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" })), "mcp-token\n");
    expect(await h.run(["connections", "add", "mcp", "--label", "Sentry", "--endpoint", "https://mcp.acme.dev/mcp", "--vendor", "Sentry", "--auth-header", "X-Api-Key", "--auth-prefix", ""])).toBe(0);
    expect(h.calls[0]!.body).toMatchObject({
      connection: { type: "mcp", label: "Sentry", access: "read", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry", auth: { header: "X-Api-Key", prefix: "" } },
      secret: { token: "mcp-token" },
    });
  });

  it("sends nothing, and asks for no secret, when a required option is missing or does not belong to the type", async () => {
    const h = await cli(created(saved()), `${LINEAR_KEY}\n`);
    const refusals: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text: string | Uint8Array) => { refusals.push(String(text)); return true; });
    try {
      expect(await h.run(["connections", "add", "linear"])).not.toBe(0); // no --label
      expect(await h.run(["connections", "add", "jira", "--label", "Jira", "--email", "svc@acme.com"])).not.toBe(0); // no --site-url
      expect(await h.run(["connections", "add", "jira", "--label", "Jira", "--site-url", "https://acme.atlassian.net"])).not.toBe(0); // no --email
      expect(await h.run(["connections", "add", "mcp", "--label", "Sentry", "--endpoint", "https://mcp.acme.dev/mcp"])).not.toBe(0); // no --vendor
      expect(await h.run(["connections", "add", "linear", "--label", "L", "--endpoint", "https://mcp.acme.dev/mcp"])).not.toBe(0); // an MCP option on Linear
      expect(await h.run(["connections", "add", "asana", "--label", "A"])).not.toBe(0); // not a type
      expect(await h.run(["connections", "add", "linear", "--label", "L", "--access", "write"])).not.toBe(0);
    } finally {
      stderr.mockRestore();
    }
    expect(h.calls).toEqual([]);
    expect(h.err.join("") + refusals.join("")).not.toContain(LINEAR_KEY);
  });

  it("refuses an empty secret, or one with a space inside, without sending it", async () => {
    for (const input of ["\n", "", "two words\n"]) {
      const h = await cli(created(saved()), input);
      expect(await h.run(["connections", "add", "linear", "--label", "L"], input), JSON.stringify(input)).not.toBe(0);
      expect(h.calls, JSON.stringify(input)).toEqual([]);
      expect(h.err.join(""), JSON.stringify(input)).not.toContain("two words");
    }
  });

  it("shows the server's reason when it refuses, and never the secret", async () => {
    const h = await cli(() => Response.json({ error: { code: "CONFIG_INVALID", message: "CONFIG_INVALID: connection.siteUrl: must be https://<site>.atlassian.net" } }, { status: 400 }), "jira-token\n");
    expect(await h.run(["connections", "add", "jira", "--label", "J", "--site-url", "https://acme.example", "--email", "svc@acme.com"])).not.toBe(0);
    expect(h.err.join("")).toContain("must be https://<site>.atlassian.net");
    expect(h.err.join("") + h.out.join("")).not.toContain("jira-token");
  });

  it("writes the secret nowhere on disk", async () => {
    const h = await cli(created(saved()), `${LINEAR_KEY}\n`);
    await h.run(["connections", "add", "linear", "--label", "L"]);
    const { readdir, readFile } = await import("node:fs/promises");
    const names = await readdir(h.home, { recursive: true });
    for (const name of names) {
      const text = await readFile(join(h.home, name), "utf8").catch(() => "");
      expect(text, name).not.toContain(LINEAR_KEY);
    }
  });
});

describe("agentx connections remove", () => {
  it("removes with a request id in the body once the person says yes", async () => {
    const h = await cli((method, path) => (method === "DELETE" && path === `/v1/app/connections/${CON}` ? Response.json({ removed: { connectionId: CON } }) : Response.json({}, { status: 404 })), undefined, { confirm: true });
    expect(await h.run(["connections", "remove", CON])).toBe(0);
    expect(h.calls).toEqual([{ method: "DELETE", path: `/v1/app/connections/${CON}`, authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.out.join("")).toBe(`Removed the connection ${CON}. Its secret is scheduled for deletion and can be recovered for 7 days.\n`);
  });

  it("sends nothing when the answer is no, or when there is no terminal to ask and no --yes", async () => {
    let h = await cli(() => Response.json({}), undefined, { confirm: false });
    expect(await h.run(["connections", "remove", CON])).not.toBe(0);
    expect(h.calls).toEqual([]);
    h = await cli(() => Response.json({ removed: { connectionId: CON } }), "");
    expect(await h.run(["connections", "remove", CON])).not.toBe(0);
    expect(h.calls).toEqual([]);
    expect(await h.run(["connections", "remove", CON, "--yes"])).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it("shows the server's words when the connection is not found", async () => {
    const h = await cli(() => Response.json({ error: { code: "NOT_FOUND", message: "NOT_FOUND: no connection has that ID" } }, { status: 404 }));
    expect(await h.run(["connections", "remove", CON, "--yes"])).not.toBe(0);
    expect(h.err.join("")).toContain("no connection has that ID");
  });
});

describe("agentx connections check", () => {
  it("posts the check with a request id and prints what it found", async () => {
    let h = await cli(() => Response.json({ ok: true }));
    expect(await h.run(["connections", "check", CON])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/connections/${CON}/check`, authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.out.join("")).toBe(`The connection ${CON} works.\n`);
    h = await cli(() => Response.json({ ok: true, message: "2 tools" }));
    expect(await h.run(["connections", "check", CON])).toBe(0);
    expect(h.out.join("")).toBe(`The connection ${CON} works (2 tools).\n`);
  });

  it("prints a failed check as a failure with the reason, and exits non-zero", async () => {
    const h = await cli(() => Response.json({ ok: false, message: "Linear refused the saved secret (HTTP 401)\u001b[31m" }));
    expect(await h.run(["connections", "check", CON])).not.toBe(0);
    expect(h.err.join("")).toContain("Linear refused the saved secret (HTTP 401)");
    expect(h.err.join("")).not.toContain("\u001b");
  });
});

describe("the connections commands", () => {
  it("list add, remove, check and list under `connections`", () => {
    const names = createCliProgram().commands.find((command) => command.name() === "connections")!.commands.map((command) => command.name());
    expect(names).toEqual(["list", "add", "remove", "check"]);
  });
});
