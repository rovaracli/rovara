// Release 0.4.17: `rovara --env staging --project <p> slack bind|unbind --channel <C...>` against a fake control plane: the developer session is used (never the
// admin sign-in), the request each sends, the lines each prints (with the invite-the-bot next step), and the control plane's own words when it refuses.
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
const TEAM = "T0BSHLLUGBD";
const CHANNEL = "C0CCBS6BBU3";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function cli(answer: (method: string, path: string) => Response) {
  const home = await mkdtemp(join(tmpdir(), "rovara-slack-bind-cli-"));
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
  });
  return { run, out, err, calls };
}

const bound = (changed = true) => Response.json({ binding: { teamId: TEAM, channelId: CHANNEL, projectName: "demo-tasklog", updatedAt: "2026-10-27T10:00:00.000Z" }, changed, requestId: "r" });
const unbound = (removed = true) => Response.json({ teamId: TEAM, channelId: CHANNEL, removed, requestId: "r" });
const refusal = (status: number, code: string, message: string) => Response.json({ error: { code, message: `${code}: ${message}` } }, { status });

describe("rovara slack bind", () => {
  it("puts the channel with the developer session and a fresh request id, then tells the owner to invite the bot", async () => {
    const h = await cli(() => bound());
    expect(await h.run(["--env", "staging", "--project", "demo-tasklog", "slack", "bind", "--channel", CHANNEL])).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: "/v1/app/projects/demo-tasklog/slack-channel", authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string, channelId: CHANNEL } }]);
    const text = h.out.join("");
    expect(text).toContain(`Bound Slack channel ${CHANNEL} to demo-tasklog on staging.`);
    expect(text).toContain("invite the Rovara bot to that channel in Slack (type /invite and pick the Rovara app)");
    // The bot's name is not known to a developer sign-in, so the line names no bot.
    expect(text).not.toMatch(/@\w+/);
  });

  it("sends --team when given, and says so when the channel was already bound to the project", async () => {
    const h = await cli(() => bound(false));
    expect(await h.run(["--env", "staging", "--project", "demo-tasklog", "slack", "bind", "--channel", CHANNEL, "--team", TEAM])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, channelId: CHANNEL, teamId: TEAM });
    expect(h.out.join("")).toContain(`Slack channel ${CHANNEL} was already bound to demo-tasklog; nothing changed.`);
  });

  it("--json prints the binding", async () => {
    const h = await cli(() => bound());
    expect(await h.run(["--json", "--project", "demo-tasklog", "slack", "bind", "--channel", CHANNEL])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { project: "demo-tasklog", teamId: TEAM, channelId: CHANNEL, changed: true } });
  });

  it("needs --project and --channel; nothing is sent", async () => {
    const h = await cli(() => bound());
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await h.run(["slack", "bind", "--channel", CHANNEL])).not.toBe(0);
      expect(await h.run(["--project", "demo-tasklog", "slack", "bind"])).not.toBe(0);
    } finally {
      stderr.mockRestore();
    }
    expect(h.calls).toEqual([]);
  });

  it("shows the control plane's words for a refusal: not an owner or admin, a team that is not the org's, a channel bound elsewhere", async () => {
    const cases: Array<[number, string, string]> = [
      [403, "FORBIDDEN", "only an organization owner or admin can bind a Slack channel to a project"],
      [403, "SLACK_TEAM_NOT_BOUND", "that Slack workspace is not connected to your organization"],
      [400, "CONFIG_INVALID", "that channel is bound to the project payments; unbind it there first"],
    ];
    for (const [status, code, message] of cases) {
      const h = await cli(() => refusal(status, code, message));
      expect(await h.run(["--project", "demo-tasklog", "slack", "bind", "--channel", CHANNEL])).not.toBe(0);
      expect(h.err.join("")).toContain(message);
    }
  });
});

describe("rovara slack unbind", () => {
  it("deletes the channel with a request id in the body and says so", async () => {
    const h = await cli(() => unbound());
    expect(await h.run(["--project", "demo-tasklog", "slack", "unbind", "--channel", CHANNEL])).toBe(0);
    expect(h.calls).toEqual([{ method: "DELETE", path: "/v1/app/projects/demo-tasklog/slack-channel", authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string, channelId: CHANNEL } }]);
    expect(h.out.join("")).toBe(`Unbound Slack channel ${CHANNEL} from demo-tasklog on staging. Threads already started keep their workspaces.\n`);
  });

  it("says nothing changed for a channel that was not bound", async () => {
    const h = await cli(() => unbound(false));
    expect(await h.run(["--project", "demo-tasklog", "slack", "unbind", "--channel", CHANNEL])).toBe(0);
    expect(h.out.join("")).toBe(`Slack channel ${CHANNEL} was not bound to demo-tasklog; nothing changed.\n`);
  });
});

describe("the slack command", () => {
  it("is a top-level command with bind and unbind, beside admin slack bind", () => {
    const program = createCliProgram();
    expect(program.commands.find((command) => command.name() === "slack")?.commands.map((command) => command.name())).toEqual(["bind", "unbind"]);
    expect(program.commands.find((command) => command.name() === "admin")?.commands.find((command) => command.name() === "slack")?.commands.map((command) => command.name())).toEqual(["bind", "connect-team", "disconnect-team", "unbind"]);
  });
});
