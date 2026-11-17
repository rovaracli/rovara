// DEC 254t (a): the owner's real-key check, on fakes only. scripts/real-key-check.ts (the owner-run entry: real keys, real transports)
// is never imported here or by any package; its pure parts (scripts/real-key-check-lib.ts) run the one check through the gateway's own
// agent path with a fake transport, and every failure path answers with fixed words that never carry the key.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it } from "vitest";
import type { AwsCredentials } from "../../packages/model-gateway/src/aws.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import {
  anthropicModel, bedrockSettings, CHECK_KINDS, CHECK_MAX_TOKENS, CHECK_TOKEN_CEILING, checkRequest, DEFAULT_BEDROCK_MODEL_US, formatResult, keyProblem, parseCliCredentials,
  parseKind, promptHidden, readAgentStream, runCheck, WORDS, type CheckTarget,
} from "../../scripts/real-key-check-lib.js";

const ROOT = join(import.meta.dirname, "..", "..");
// Built at run time, never a literal key shape in the source.
const KEY = ["sk", "ant", "api03", "realkeycheck", "x".repeat(24)].join("-");
const frame = (type: string, value: Record<string, unknown> = {}) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
function anthropicAnswer(options: { tool?: boolean; stop?: boolean; extra?: Buffer } = {}): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield frame("message_start", { message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m", usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    if (options.tool !== false) {
      yield frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "ping", input: {} } });
      yield frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
    } else {
      yield frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      yield frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "pong" } });
    }
    if (options.extra !== undefined) yield options.extra;
    yield frame("content_block_stop", { index: 0 });
    yield frame("message_delta", { delta: { stop_reason: options.tool === false ? "end_turn" : "tool_use" }, usage: { output_tokens: 9 } });
    if (options.stop !== false) yield frame("message_stop");
  })();
}
function anthropic(transport: ProviderTransport): CheckTarget { return { kind: "anthropic", key: KEY, model: "claude-haiku-4-5", transport }; }
const ok = (sent: ProviderRequest[], options?: Parameters<typeof anthropicAnswer>[0]): ProviderTransport => async (request) => { sent.push(request); return { status: 200, body: anthropicAnswer(options) }; };
const all = (lines: string[]) => lines.join("\n");

describe("the entry script is owner-run only", () => {
  it("no test, package, script or infra file imports scripts/real-key-check.ts (only its -lib)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".") || name === "cdk.out") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(?:ts|tsx|js|mjs|cjs)$/u.test(name)) continue;
        const rel = relative(ROOT, path);
        if (rel === join("scripts", "real-key-check.ts")) continue;
        // An import, a dynamic import, a require or a re-export of the entry (any path ending in real-key-check, with or without .ts/.js).
        if (/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`][^"'`]*real-key-check(?:\.ts|\.js)?["'`]/u.test(readFileSync(path, "utf8"))) offenders.push(rel);
      }
    };
    for (const top of ["tests", "packages", "scripts", "infra"]) walk(join(ROOT, top));
    expect(offenders).toEqual([]);
  });

  it("refuses without the consent switch, for a kind not built yet, and for anything but one kind (never echoing it), before any key is read", () => {
    const run = (args: string[], env: Record<string, string>) => {
      try { execFileSync(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "scripts/real-key-check.ts"), ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000 }); return { status: 0, out: "" }; }
      catch (error) { const e = error as { status: number; stdout: string; stderr: string }; return { status: e.status, out: `${e.stdout}${e.stderr}` }; }
    };
    expect(run(["anthropic"], {})).toEqual({ status: 2, out: `${WORDS.consent}\n` });
    expect(run(["openai"], { ROVARA_REAL_KEY_CHECK: "1" })).toEqual({ status: 2, out: `${WORDS.notBuilt}\n` });
    const pasted = run(["anthropic", KEY], { ROVARA_REAL_KEY_CHECK: "1" });
    expect(pasted).toEqual({ status: 2, out: `${WORDS.usage}\n` });
    expect(pasted.out).not.toContain(KEY);
    // Not a terminal and no variable: refused, never read from a pipe.
    expect(run(["anthropic"], { ROVARA_REAL_KEY_CHECK: "1" })).toEqual({ status: 2, out: `${WORDS.noKey}\n` });
  }, 120_000);
});

describe("the one check, through the gateway's own agent route (fake transport)", () => {
  it("PASS: HTTP ok, a complete stream, an Anthropic tool call, usage, and an unknown price settled above $0 as a flagged estimate", async () => {
    const sent: ProviderRequest[] = [];
    const result = await runCheck(anthropic(ok(sent)));
    expect(result.lines.map((line) => [line.name, line.ok])).toEqual([
      ["HTTP ok", true], ["answer streamed to completion", true], ["a tool call came back in the agent's (Anthropic) shape", true], ["usage read", true],
      ["settled above $0", true], ["unknown price settled as a flagged estimate, never $0", true],
    ]);
    expect(result.pass).toBe(true);
    // One call, on the company key path: the key only in the transport's own field, the body as the guard forwarded it.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe(KEY);
    const body = JSON.parse(Buffer.from(sent[0]!.body).toString("utf8")) as { max_tokens: number; tools: unknown[]; tool_choice: unknown; stream: boolean };
    expect(body).toMatchObject({ max_tokens: CHECK_MAX_TOKENS, stream: true, tool_choice: { type: "tool", name: "ping" } });
    expect(body.tools).toHaveLength(1);
    expect(all(formatResult("anthropic", result))).toMatch(/PASS real-key check: anthropic$/u);
    expect(all(formatResult("anthropic", result))).not.toContain(KEY);
  });

  it("a request above the hard ceiling is refused by the gateway's own guard before anything is sent", () => {
    expect(CHECK_MAX_TOKENS).toBeLessThanOrEqual(CHECK_TOKEN_CEILING);
    expect(checkRequest("claude-haiku-4-5").max_tokens).toBe(CHECK_MAX_TOKENS);
  });

  const failures: Array<[string, () => ProviderTransport, string]> = [
    ["no tool call", () => ok([], { tool: false }), "a tool call came back in the agent's (Anthropic) shape"],
    ["a stream that never ends", () => ok([], { stop: false }), "answer streamed to completion"],
    ["the provider refuses the key", () => async () => ({ status: 401, body: (async function* () { yield Buffer.from(JSON.stringify({ error: { message: `bad key ${KEY}` } })); })() }), "HTTP ok"],
    ["the provider is down", () => async () => ({ status: 529, body: (async function* () { yield Buffer.from(`overloaded ${KEY}`); })() }), "HTTP ok"],
    ["an answer that carries the key", () => async () => ({ status: 200, body: anthropicAnswer({ extra: frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: KEY } }) }) }), "answer streamed to completion"],
    ["a transport that throws with the key in its error", () => async () => { throw new Error(`connect failed for ${KEY}`); }, "HTTP ok"],
    ["garbage", () => async () => ({ status: 200, body: (async function* () { yield Buffer.from(`not sse ${KEY}\n\n`); })() }), "answer streamed to completion"],
  ];
  it.each(failures)("FAIL on %s, and nothing printed carries the key", async (_name, transport, failing) => {
    const result = await runCheck(anthropic(transport()));
    expect(result.pass).toBe(false);
    expect(result.lines.find((line) => line.name === failing)?.ok).toBe(false);
    const printed = all(formatResult("anthropic", result));
    expect(printed).toMatch(/FAIL real-key check: anthropic$/u);
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(KEY.slice(-16));
    expect(JSON.stringify(result)).not.toContain(KEY.slice(8, 32));
  });

  it("the gateway's refusal code is shown (fixed words), provider text never", async () => {
    const result = await runCheck(anthropic(async () => ({ status: 401, body: (async function* () { yield Buffer.from("provider says <script>"); })() })));
    expect(result.lines[0]).toEqual({ name: "HTTP ok", ok: false, detail: "gateway answered 403 no_ai_key" });
    expect(all(formatResult("anthropic", result))).not.toContain("provider says");
  });

  it("Bedrock: the company's own Bedrock path (invoke, the owner's credentials as the session, the connection's Region)", async () => {
    const credentials: AwsCredentials = { accessKeyId: "AKIDCHECKEXAMPLE000", secretAccessKey: ["check", "secret", "x".repeat(20)].join("-") };
    const seen: Array<{ region: string; credentials: AwsCredentials; path?: string; body: string }> = [];
    const target: CheckTarget = {
      kind: "bedrock", region: "us-west-2", agentModel: "claude-haiku-4-5", bedrockModel: DEFAULT_BEDROCK_MODEL_US, credentials,
      transport: (region, source) => async (request) => { seen.push({ region, credentials: await source(), ...(request.path === undefined ? {} : { path: request.path }), body: Buffer.from(request.body).toString("utf8") }); return { status: 200, body: anthropicAnswer() }; },
    };
    const result = await runCheck(target);
    expect(result.pass).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.region).toBe("us-west-2");
    expect(seen[0]!.credentials).toEqual(credentials);
    expect(seen[0]!.path).toContain(encodeURIComponent(DEFAULT_BEDROCK_MODEL_US));
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ anthropic_version: "bedrock-2023-05-31", max_tokens: CHECK_MAX_TOKENS });
    expect(all(formatResult("bedrock", result))).not.toContain(credentials.secretAccessKey);
  });

  it("Bedrock: AWS refusing the call is a FAIL in fixed words, never the credentials", async () => {
    const credentials: AwsCredentials = { accessKeyId: "AKIDCHECKEXAMPLE000", secretAccessKey: ["check", "secret", "y".repeat(20)].join("-") };
    const result = await runCheck({ kind: "bedrock", region: "us-west-2", agentModel: "claude-haiku-4-5", bedrockModel: DEFAULT_BEDROCK_MODEL_US, credentials, transport: () => async () => ({ status: 403, body: (async function* () { yield Buffer.from(`denied ${credentials.secretAccessKey}`); })() }) });
    expect(result.pass).toBe(false);
    expect(all(formatResult("bedrock", result))).not.toContain(credentials.secretAccessKey);
  });
});

describe("the pure parts", () => {
  it("one kind on the command line, nothing else", () => {
    for (const kind of CHECK_KINDS) expect(parseKind([kind])).toBe(kind);
    for (const argv of [[], ["anthropic", KEY], [KEY], ["Anthropic"], ["--key", KEY], ["anthropic", "--model", "x"]]) expect(parseKind(argv)).toBeUndefined();
  });

  it("a key is 6 to 8192 characters with no line break", () => {
    expect(keyProblem(KEY)).toBeUndefined();
    for (const bad of ["", "short", `${KEY}\n`, `a\rb${KEY}`, "x".repeat(8193), `${KEY}\0`]) expect(keyProblem(bad)).toBe(WORDS.badKey);
  });

  it("models and Bedrock settings: checked, never the staging profile", () => {
    expect(anthropicModel({})).toBe("claude-haiku-4-5");
    expect(anthropicModel({ ROVARA_CHECK_ANTHROPIC_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(anthropicModel({ ROVARA_CHECK_ANTHROPIC_MODEL: "gpt-4o" })).toBeUndefined();
    expect(bedrockSettings({ ROVARA_CHECK_BEDROCK_REGION: "us-west-2" })).toEqual({ region: "us-west-2", bedrockModel: DEFAULT_BEDROCK_MODEL_US, agentModel: "claude-haiku-4-5" });
    expect(bedrockSettings({ ROVARA_CHECK_BEDROCK_REGION: "us-west-2", AWS_PROFILE: "agentx-test" })).toBe(WORDS.stagingProfile);
    expect(bedrockSettings({})).toBe(WORDS.badRegion);
    expect(bedrockSettings({ ROVARA_CHECK_BEDROCK_REGION: "eu-west-1" })).toBe(WORDS.badModel);
    expect(bedrockSettings({ ROVARA_CHECK_BEDROCK_REGION: "eu-west-1", ROVARA_CHECK_BEDROCK_MODEL: DEFAULT_BEDROCK_MODEL_US })).toBe(WORDS.badModel);
    expect(bedrockSettings({ ROVARA_CHECK_BEDROCK_REGION: "us-west-2", ROVARA_CHECK_BEDROCK_MODEL: "global.anthropic.claude-haiku-4-5-20251001-v1:0" })).toBe(WORDS.badModel);
    expect(bedrockSettings({ ROVARA_CHECK_BEDROCK_REGION: "us-west-2", ROVARA_CHECK_BEDROCK_MODEL: "qwen.qwen3-coder-30b-a3b-v1:0" })).toBe(WORDS.badModel);
  });

  it("reads the AWS CLI's export-credentials answer, and nothing else", () => {
    const secret = ["s", "x".repeat(30)].join("");
    expect(parseCliCredentials(JSON.stringify({ Version: 1, AccessKeyId: "ASIACHECKEXAMPLE00", SecretAccessKey: secret, SessionToken: "tok" }))).toEqual({ accessKeyId: "ASIACHECKEXAMPLE00", secretAccessKey: secret, sessionToken: "tok" });
    for (const bad of ["", "not json", "{}", JSON.stringify({ AccessKeyId: "lower", SecretAccessKey: secret }), JSON.stringify({ AccessKeyId: "ASIACHECKEXAMPLE00", SecretAccessKey: "short" }), JSON.stringify({ AccessKeyId: "ASIACHECKEXAMPLE00", SecretAccessKey: secret, SessionToken: 1 })]) expect(parseCliCredentials(bad)).toBeUndefined();
  });

  it("reads an agent stream's facts only; malformed is not complete", () => {
    expect(readAgentStream(Buffer.from("data: {broken\n\n"))).toEqual({ complete: false, toolCall: false });
  });
});

class FakeTerminal extends EventEmitter {
  isTTY = true; raw: boolean[] = []; resumed = 0; paused = 0;
  setRawMode(mode: boolean) { this.raw.push(mode); return this; }
  resume() { this.resumed += 1; return this; }
  pause() { this.paused += 1; return this; }
}

describe("the hidden prompt", () => {
  it("reads the key in raw mode and never writes a typed character back", async () => {
    const terminal = new FakeTerminal(); const written: string[] = [];
    const answer = promptHidden(terminal, (text) => written.push(text), "Your anthropic key");
    terminal.emit("data", Buffer.from(KEY.slice(0, 10)));
    terminal.emit("data", `${KEY.slice(10)}x\u007f`);
    terminal.emit("data", "\r");
    expect(await answer).toBe(KEY);
    expect(terminal.raw).toEqual([true, false]);
    expect(terminal.listenerCount("data")).toBe(0);
    expect(written.join("")).not.toContain(KEY.slice(0, 6));
    expect(written.join("")).toBe("Your anthropic key (input hidden, Enter to finish): \n");
  });

  it("Ctrl-C cancels; not a terminal is never read", async () => {
    const terminal = new FakeTerminal();
    const answer = promptHidden(terminal, () => undefined, "k");
    terminal.emit("data", "abc\u0003");
    expect(await answer).toBeUndefined();
    expect(terminal.raw).toEqual([true, false]);
    const pipe = new FakeTerminal(); pipe.isTTY = false;
    expect(await promptHidden(pipe, () => undefined, "k")).toBeUndefined();
    expect(pipe.raw).toEqual([]);
  });
});
