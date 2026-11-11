// The guard module that every inference request passes through (Plan 3 Task 25; docs/learnings/model-sources-spike.md, questions 8 and 9).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROVARA_GUARD_PY } from "../../packages/model-proxy/src/rovara-guard.js";
import { litellmConfig } from "../../packages/model-proxy/src/litellm-config.js";
import { ROVARA_GUARD_PACKED } from "../../packages/model-proxy/src/rovara-guard-packed.js";
import { ROVARA_GUARD_ENV, litellmStartCommand } from "../../packages/model-proxy/src/start-command.js";
import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";

// A missing python3 must show as skipped, never as green: the refusal checks below run the real Python hook.
const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;
const itPython = it.skipIf(!hasPython);

describe("rovara_guard.py", () => {
  it("is the module the spike verified, byte for byte (update both together when LiteLLM or Pi is bumped)", () => {
    expect(ROVARA_GUARD_PY).toBe(readFileSync(new URL("../../docs/learnings/model-sources-spike/rovara_guard.py", import.meta.url), "utf8"));
  });

  describe("as the proxy's container unpacks it from the task definition", () => {
    // The Python of the container's start command, with the file it writes moved into a temporary folder.
    const unpack = (packed: string) => {
      const dir = mkdtempSync(join(tmpdir(), "rovara-guard-unpack-"));
      const python = /python -c '([^']+)'/u.exec(litellmStartCommand(4000))![1]!.replace("/tmp/rovara_guard.py", join(dir, "rovara_guard.py"));
      const result = spawnSync("python3", ["-I", "-c", python], { env: { [ROVARA_GUARD_ENV]: packed }, encoding: "utf8" });
      return { result, file: join(dir, "rovara_guard.py") };
    };

    itPython("writes the guard, byte for byte the spike's file, when it hashes to the pinned value", () => {
      const { result, file } = unpack(ROVARA_GUARD_PACKED);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(readFileSync(new URL("../../docs/learnings/model-sources-spike/rovara_guard.py", import.meta.url), "utf8"));
    });

    itPython("stops, writing nothing, for a guard with one byte changed, an empty value, or a value that is not packed text", () => {
      const changed = deflateSync(Buffer.from(`${ROVARA_GUARD_PY}#`), { level: 9 }).toString("base64");
      for (const packed of [changed, "", "not base64 or zlib"]) {
        const { result, file } = unpack(packed);
        expect({ packed: packed.slice(0, 12), status: result.status, written: existsSync(file) }).toEqual({ packed: packed.slice(0, 12), status: 1, written: false });
      }
      expect(unpack(changed).result.stderr).toContain("does not match its pinned SHA-256");
    });
  });

  it("forces every httpx send to stop at a redirect, refuses to start if one would be followed, and allow-lists the three inference routes", () => {
    expect(ROVARA_GUARD_PY).toContain('kwargs["follow_redirects"] = False');
    expect(ROVARA_GUARD_PY).toContain("os._exit(70)");
    for (const route of ["anthropic_messages", "aresponses", "acompletion"]) expect(ROVARA_GUARD_PY).toContain(`"${route}"`);
    for (const refused of ["fallbacks", "router_settings_override", "x-litellm-"]) expect(ROVARA_GUARD_PY).toContain(refused);
    expect(ROVARA_GUARD_PY).toContain("proxy_handler_instance = RovaraGuard()");
  });

  it("carries no key", () => {
    expect(ROVARA_GUARD_PY).not.toMatch(/sk-[A-Za-z0-9]|AKIA[0-9A-Z]{8}/);
  });

  itPython("is valid Python", () => {
    const directory = mkdtempSync(join(tmpdir(), "rovara-guard-"));
    const file = join(directory, "rovara_guard.py");
    writeFileSync(file, ROVARA_GUARD_PY);
    execFileSync("python3", ["-I", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", file], { stdio: "pipe" });
  });

  // The request allow-list (section 1) is run for real with the two imports it needs stubbed, so the tool-type rules are tested as Python.
  const HARNESS = String.raw`
import asyncio, json, sys
class HTTPException(Exception):
    def __init__(self, status_code, detail): self.status_code, self.detail = status_code, detail
class CustomLogger: pass
text = open(sys.argv[1]).read()
ns = {"HTTPException": HTTPException, "CustomLogger": CustomLogger, "__name__": "guard_section"}
exec(compile(text[text.index("# ---------------------------------------------------------------- 1. request allow-list"):], "guard", "exec"), ns)
out = []
for case in json.load(sys.stdin):
    try:
        asyncio.run(ns["proxy_handler_instance"].async_pre_call_hook({}, None, case["data"], case["call_type"]))
        out.append({"status": 200})
    except HTTPException as e:
        out.append({"status": e.status_code, "detail": e.detail})
json.dump(out, sys.stdout)
`;

  type Verdict = { status: number; detail?: string };
  function runGuard(cases: Array<{ call_type: string; data: Record<string, unknown> }>): Verdict[] {
    const directory = mkdtempSync(join(tmpdir(), "rovara-guard-run-"));
    const guard = join(directory, "rovara_guard.py");
    const harness = join(directory, "harness.py");
    writeFileSync(guard, ROVARA_GUARD_PY);
    writeFileSync(harness, HARNESS);
    return JSON.parse(execFileSync("python3", ["-I", harness, guard], { input: JSON.stringify(cases), stdio: ["pipe", "pipe", "pipe"] }).toString()) as Verdict[];
  }

  const fn = { type: "function", function: { name: "read_file", parameters: { type: "object" } } };
  const respFn = { type: "function", name: "read_file", parameters: { type: "object" } };
  const clientTool = { name: "read_file", description: "d", input_schema: { type: "object", properties: {}, required: [] } };
  const base = { anthropic_messages: { model: "m", messages: [], max_tokens: 8 }, aresponses: { model: "m", input: "hi" }, acompletion: { model: "m", messages: [] } };

  itPython("serves plain function tools on every route and refuses provider-side tool types with a 400 that names the type", () => {
    const refused: Array<[keyof typeof base, unknown, string]> = [
      ["aresponses", { type: "mcp", server_label: "x", server_url: "https://attacker.example/x" }, "mcp"],
      ["aresponses", { type: "web_search" }, "web_search"],
      ["aresponses", { type: "web_search_preview" }, "web_search_preview"],
      ["aresponses", { type: "code_interpreter", container: { type: "auto" } }, "code_interpreter"],
      ["aresponses", { type: "file_search", vector_store_ids: ["v"] }, "file_search"],
      ["aresponses", { type: "image_generation" }, "image_generation"],
      ["aresponses", { type: "computer_use_preview" }, "computer_use_preview"],
      ["aresponses", { type: "custom", name: "n" }, "custom"],
      ["aresponses", { name: "no_type" }, "NoneType"],
      ["anthropic_messages", { type: ["web_search"], name: "x" }, "list"],
      ["acompletion", { type: "web_search" }, "web_search"],
      ["acompletion", { type: "mcp" }, "mcp"],
      ["acompletion", { type: "custom", custom: { name: "n" } }, "custom"],
      ["anthropic_messages", { type: "web_search_20250305", name: "web_search" }, "web_search_20250305"],
      ["anthropic_messages", { type: "web_fetch_20250910", name: "web_fetch" }, "web_fetch_20250910"],
      ["anthropic_messages", { type: "code_execution_20250522", name: "code_execution" }, "code_execution_20250522"],
      ["anthropic_messages", { type: "computer_20250124", name: "computer" }, "computer_20250124"],
      ["anthropic_messages", { type: "bash_20250124", name: "bash" }, "bash_20250124"],
      ["anthropic_messages", { type: "mcp_toolset", mcp_server_name: "s" }, "mcp_toolset"],
      ["anthropic_messages", { type: "function", name: "x" }, "function"],
    ];
    const cases = [
      { call_type: "anthropic_messages", data: { ...base.anthropic_messages, tools: [clientTool, { ...clientTool, type: "custom" }], tool_choice: { type: "tool", name: "read_file" } } },
      { call_type: "aresponses", data: { ...base.aresponses, tools: [respFn], tool_choice: "auto" } },
      { call_type: "acompletion", data: { ...base.acompletion, tools: [fn], tool_choice: { type: "function", function: { name: "read_file" } } } },
      { call_type: "acompletion", data: { ...base.acompletion } },
      { call_type: "aresponses", data: { ...base.aresponses, tools: [] } },
      ...refused.map(([route, tool]) => ({ call_type: route, data: { ...base[route], tools: [route === "aresponses" ? respFn : route === "acompletion" ? fn : clientTool, tool] } })),
    ];
    const verdicts = runGuard(cases);
    expect(verdicts.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => ({ status: 200 })));
    refused.forEach(([, , shown], index) => {
      const verdict = verdicts[5 + index]!;
      expect(verdict.status, JSON.stringify(refused[index])).toBe(400);
      expect(verdict.detail).toContain("request not allowed: tool type");
      expect(verdict.detail).toContain(`'${shown}'`);
      expect(verdict.detail).toContain("tools[1]");
    });
  });

  itPython("refuses a tools field that is not a list of objects, and a tool_choice that names a provider-side tool", () => {
    const verdicts = runGuard([
      { call_type: "aresponses", data: { ...base.aresponses, tools: { type: "web_search" } } },
      { call_type: "aresponses", data: { ...base.aresponses, tools: ["web_search"] } },
      { call_type: "aresponses", data: { ...base.aresponses, tools: [respFn], tool_choice: { type: "web_search_preview" } } },
      { call_type: "anthropic_messages", data: { ...base.anthropic_messages, tools: [clientTool], tool_choice: { type: "web_search_20250305" } } },
      { call_type: "acompletion", data: { ...base.acompletion, tools: [fn], tool_choice: { type: "auto" } } },
      { call_type: "anthropic_messages", data: { ...base.anthropic_messages, tools: [clientTool], tool_choice: { type: ["auto"] } } },
      { call_type: "aresponses", data: { ...base.aresponses, tools: [respFn], tool_choice: { type: { a: 1 } } } },
      { call_type: "aresponses", data: { ...base.aresponses, tools: [respFn], tool_choice: ["auto"] } },
      // the shapes pi-ai and the e2e provider path send
      ...[{ type: "any" }, { type: "tool", name: "read_file" }, { type: "function", name: "read_file" }, "required", "none"].map((tool_choice) => ({ call_type: "aresponses", data: { ...base.aresponses, tools: [respFn], tool_choice } })),
    ]);
    expect(verdicts.map((v) => v.status)).toEqual([400, 400, 400, 400, 200, 400, 400, 400, 200, 200, 200, 200, 200]);
    expect(verdicts[5]!.detail).toContain("tool_choice type 'unknown'");
    expect(verdicts[2]!.detail).toContain("tool_choice type 'web_search_preview'");
    expect(verdicts[3]!.detail).toContain("tool_choice type 'web_search_20250305'");
  });

  itPython("holds tool definitions nested in Responses input items and Anthropic messages to the same rule", () => {
    const sys = (definition: unknown) => ({ role: "system", content: [{ type: "text", text: "t" }, { type: "tool_addition", tool: { type: "tool_definition", definition } }] });
    const refused: Array<{ call_type: string; data: Record<string, unknown>; shown: string }> = [
      // the three payloads from the review
      { call_type: "aresponses", shown: "mcp", data: { ...base.aresponses, input: [{ type: "additional_tools", role: "developer", tools: [{ type: "mcp", server_url: "https://attacker.example/x", require_approval: "never" }] }, { role: "user", content: "hi" }] } },
      { call_type: "aresponses", shown: "web_search", data: { ...base.aresponses, input: [{ type: "tool_search_call", call_id: "c", execution: "client", arguments: {} }, { type: "tool_search_output", call_id: "c", execution: "client", tools: [{ type: "web_search" }] }] } },
      { call_type: "anthropic_messages", shown: "web_search_20250305", data: { ...base.anthropic_messages, messages: [sys({ type: "web_search_20250305", name: "web_search" })] } },
      // variations: a tools list deeper in the structure, a hosted tool next to a plain one, a non-dict definition, other routes
      { call_type: "aresponses", shown: "code_interpreter", data: { ...base.aresponses, input: [{ role: "user", content: [{ type: "input_text", text: "x", extra: { tools: [respFn, { type: "code_interpreter" }] } }] }] } },
      { call_type: "anthropic_messages", shown: "web_fetch_20250910", data: { ...base.anthropic_messages, messages: [{ role: "user", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { type: "web_fetch_20250910", name: "w" } } }] }] } },
      { call_type: "anthropic_messages", shown: "is not a function tool", data: { ...base.anthropic_messages, messages: [{ role: "user", content: [{ type: "tool_addition", tool: { type: "tool_definition" } }] }] } },
      { call_type: "acompletion", shown: "web_search", data: { ...base.acompletion, messages: [{ role: "user", content: "x", tools: [{ type: "web_search" }] }] } },
    ];
    const allowed = [
      // pi-ai's own nested shapes: converted function tools in additional_tools and tool_search_output (defer_loading), plain and cached Anthropic definitions
      { call_type: "aresponses", data: { ...base.aresponses, input: [{ type: "additional_tools", role: "developer", tools: [respFn, { ...respFn, strict: false, defer_loading: true }] }] } },
      { call_type: "aresponses", data: { ...base.aresponses, input: [{ type: "tool_search_call", call_id: "c", execution: "client", status: "completed", arguments: { query: "read_file", limit: 1 } }, { type: "tool_search_output", call_id: "c", execution: "client", status: "completed", tools: [{ ...respFn, defer_loading: true }] }] } },
      { call_type: "anthropic_messages", data: { ...base.anthropic_messages, messages: [sys(clientTool), sys({ ...clientTool, type: "custom", cache_control: { type: "ephemeral" } }), { role: "system", content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "read_file" } }] }] } },
      // a model's own tool arguments may hold a key named tools: not a definition
      { call_type: "anthropic_messages", data: { ...base.anthropic_messages, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: { tools: [{ type: "web_search" }] } }] }] } },
      { call_type: "aresponses", data: { ...base.aresponses, input: [{ type: "function_call", call_id: "c", name: "x", arguments: "{\"tools\":[{\"type\":\"mcp\"}]}" }, { type: "function_call_output", call_id: "c", output: "ok" }] } },
    ];
    const verdicts = runGuard([...refused, ...allowed]);
    refused.forEach(({ shown }, index) => {
      const verdict = verdicts[index]!;
      expect(verdict.status, `refused case ${String(index)}`).toBe(400);
      expect(verdict.detail).toContain(shown.startsWith("is not") ? shown : `tool type '${shown}'`);
    });
    expect(verdicts.slice(refused.length), "allowed nested shapes").toEqual(allowed.map(() => ({ status: 200 })));
    expect(verdicts[0]!.detail).toContain("input[0].tools[0]");
    expect(verdicts[2]!.detail).toContain("messages[0].content[1].tool.definition");
  });

  itPython("serves only reasoning.encrypted_content in a Responses include", () => {
    const run = (include: unknown) => ({ call_type: "aresponses", data: { ...base.aresponses, tools: [respFn], include } });
    const verdicts = runGuard([
      run(["reasoning.encrypted_content"]), run([]),
      run(["web_search_call.action.sources"]), run(["file_search_call.results"]), run(["code_interpreter_call.outputs"]), run(["reasoning.encrypted_content", "message.output_text.logprobs"]), run("reasoning.encrypted_content"), run([["x"]]),
    ]);
    expect(verdicts.map((v) => v.status)).toEqual([200, 200, 400, 400, 400, 400, 400, 400]);
    expect(verdicts[2]!.detail).toContain("field include");
  });

  itPython("also walks the Anthropic system field, needs a tool_definition inside every tool_addition, and caps the path in the 400", () => {
    const addition = (tool: unknown) => ({ type: "tool_addition", tool });
    const def = (definition: unknown) => ({ type: "tool_definition", definition });
    const deep = (n: number) => {
      let value: unknown = [{ type: "tool_definition", definition: { type: "web_search_20250305", name: "w" } }];
      for (let i = 0; i < n; i++) value = [value];
      return value;
    };
    const run = (messages: unknown, system?: unknown) => ({ call_type: "anthropic_messages", data: { ...base.anthropic_messages, messages, ...(system === undefined ? {} : { system }) } });
    const verdicts = runGuard([
      run([], [{ type: "text", text: "t" }, addition(def({ type: "web_search_20250305", name: "w" }))]),        // N1: typed definition in system
      run([], [{ type: "text", text: "t", tools: [{ type: "web_search_20250305", name: "w" }] }]),               // N1: tools list in system
      run([], "plain system text"),                                                                              // allowed
      run([], [{ type: "text", text: "t", cache_control: { type: "ephemeral" } }, addition(def(clientTool))]),   // allowed
      run([{ role: "system", content: [addition({ type: "web_search_20250305", name: "w" })] }]),                // N2: typed tool placed directly
      run([{ role: "system", content: [addition({ type: "something_else", definition: clientTool })] }]),       // N2: other wrapper
      run([{ role: "system", content: [addition(undefined)] }]),                                                 // N2: no tool
      run([{ role: "system", content: [addition("x")] }]),                                                       // N2: tool not an object
      run([deep(300)]),                                                                                          // N3: long path
    ]);
    expect(verdicts.map((v) => v.status)).toEqual([400, 400, 200, 200, 400, 400, 400, 400, 400]);
    expect(verdicts[0]!.detail).toContain("tool type 'web_search_20250305' at system[1].tool.definition");
    expect(verdicts[1]!.detail).toContain("tool type 'web_search_20250305' at system[0].tools[0]");
    for (const index of [4, 5, 6, 7]) expect(verdicts[index]!.detail).toContain("tool_addition without a tool_definition at messages[0].content[0]");
    expect(verdicts[8]!.detail!.length).toBeLessThan(600);
    expect(verdicts[8]!.detail).toContain("...");
  });

  // Section 4 (task budget holds) run as Python. LiteLLM's modules are replaced by small fakes (its router and cost map, ProxyException), and the
  // Postgres ledger by an in-memory one with the same statements' meaning: an atomic take, a settle that charges once, orphans past HOLD_SECONDS
  // charged on the key's next take. The SQL itself is run against the real LiteLLM and Postgres in tests/integration/model-proxy-budget-docker.test.ts.
  const BUDGET_HARNESS = String.raw`
import asyncio, json, random, sys, types
class HTTPException(Exception):
    def __init__(self, status_code, detail): self.status_code, self.detail = status_code, detail
class CustomLogger:
    def __init__(self, *a, **k): pass
class ProxyException(Exception):
    def __init__(self, message, type, param, code=None, headers=None):
        self.message, self.type, self.code, self.headers = message, type, str(code), headers or {}
PRICED = {"m-anth": {"litellm_params": {"model": "bedrock/us.anthropic.claude-x"}, "model_info": {}},
          "m-own": {"litellm_params": {"model": "openai/own", "input_cost_per_token": 0.000003, "output_cost_per_token": 0.000015}, "model_info": {}},
          "m-free": {"litellm_params": {"model": "bedrock/us.anthropic.claude-free"}, "model_info": {}},
          "m-percall": {"litellm_params": {"model": "openai/own", "input_cost_per_token": 0.000003, "output_cost_per_token": 0.000015, "input_cost_per_request": 0.01}, "model_info": {}}}
COST_MAP = {"us.anthropic.claude-x": {"input_cost_per_token": 0.000003, "output_cost_per_token": 0.000015, "cache_creation_input_token_cost": 0.00000375,
            "input_cost_per_token_above_200k_tokens": 0.000006, "output_cost_per_token_above_200k_tokens": 0.0000225, "output_cost_per_token_batches": 0.0000075,
            "max_output_tokens": 64000, "max_input_tokens": 1000000},
            "us.anthropic.claude-free": {"input_cost_per_token": 0, "output_cost_per_token": 0, "max_output_tokens": 64000}}
litellm = types.ModuleType("litellm"); litellm.model_cost = COST_MAP
def get_model_info(model): return COST_MAP[model.split("/", 1)[-1]]
litellm.get_model_info = get_model_info
proxy = types.ModuleType("litellm.proxy"); server = types.ModuleType("litellm.proxy.proxy_server"); ptypes = types.ModuleType("litellm.proxy._types")
class Router:
    def get_model_list(self, model_name=None): return [dict(PRICED[model_name], model_name=model_name)] if model_name in PRICED else None
server.llm_router = Router(); server.prisma_client = None; ptypes.ProxyException = ProxyException
sys.modules.update({"litellm": litellm, "litellm.proxy": proxy, "litellm.proxy.proxy_server": server, "litellm.proxy._types": ptypes})
text = open(sys.argv[1]).read()
ns = {"HTTPException": HTTPException, "CustomLogger": CustomLogger, "__name__": "guard_section"}
exec(compile(text[text.index("# ---------------------------------------------------------------- 1. request allow-list"):], "guard", "exec"), ns)

class Ledger:
    """The Postgres ledger's meaning, in memory. clock is moved by the scenarios to age holds."""
    def __init__(self): self.keys, self.holds, self.clock, self.lock = {}, {}, 0.0, asyncio.Lock()
    async def take(self, key, call_id, worst, spent, cap):
        await asyncio.sleep(random.random() / 1000)         # replicas reach the database in any order
        async with self.lock:
            row = self.keys.setdefault(key, {"charged": 0, "held": 0})
            for cid, h in list(self.holds.items()):
                if h["key"] == key and h["expires"] < self.clock:
                    del self.holds[cid]; row["held"] -= h["r"]; row["charged"] += h["r"]
            if max(row["charged"], spent) + row["held"] + worst <= cap:
                row["held"] += worst; self.holds[call_id] = {"key": key, "r": worst, "expires": self.clock + ns["HOLD_SECONDS"]}
                return "ok", None
            return ("exceeded" if max(row["charged"], spent) + worst > cap else "held"), row["charged"]
    async def settle(self, call_id, cost):
        async with self.lock:
            h = self.holds.pop(call_id, None)
            if h is None: return
            row = self.keys[h["key"]]; row["held"] -= h["r"]; row["charged"] += h["r"] if cost is None else cost
ns["SETTLE_GRACE_SECONDS"] = 0.05

class Key:
    def __init__(self, cap, spend=0.0, token="k1"): self.max_budget, self.spend, self.token = cap, spend, token

def guard(): return ns["RovaraGuard"]()
call_n = [0]
def req(model="m-own", stream=False, max_tokens=1000, route="acompletion"):
    call_n[0] += 1
    body = {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": max_tokens, "stream": stream} if route != "aresponses" \
        else {"model": model, "input": "hi", "max_output_tokens": max_tokens, "stream": stream}
    if max_tokens is None: body.pop("max_tokens", None); body.pop("max_output_tokens", None)
    return dict(body, litellm_call_id=f"call-{call_n[0]}")
async def pre(g, key, data, route="acompletion"):
    try:
        await g.async_pre_call_hook(key, None, data, route); return {"status": 200}
    except ProxyException as e:
        return {"status": int(e.code), "type": e.type, "message": e.message, "headers": e.headers}
async def chunks(n, fail=False):
    for i in range(n):
        await asyncio.sleep(0); yield i
    if fail: raise RuntimeError("provider cut the stream")
def state(ledger, key="k1"): return dict(ledger.keys.get(key, {"charged": 0, "held": 0}), holds=len([h for h in ledger.holds.values() if h["key"] == key]))
def worst(data): return ns["_worst_case_micros"](data, ns["_prices_for"](data["model"]))

async def parallel():
    ledger = ns["_LEDGER"] = Ledger(); g1, g2 = guard(), guard()   # two replicas, one shared ledger
    calls = [req() for _ in range(8)]; one = worst(calls[0])
    key = Key(cap=(one * 1.5) / 1e6)                                  # room for one call's worst case, not two
    answers = await asyncio.gather(*(pre(g1 if i % 2 else g2, key, c) for i, c in enumerate(calls)))
    held = dict(state(ledger))
    for c, a in zip(calls, answers):
        if a["status"] == 200: await (g1 if g1._calls.get(c["litellm_call_id"]) else g2).async_log_success_event({"litellm_call_id": c["litellm_call_id"], "response_cost": 0.003}, None, None, None)
    return {"codes": sorted(a["status"] for a in answers), "types": sorted({a.get("type") for a in answers if a["status"] != 200}),
            "retry_after": sorted({a.get("headers", {}).get("retry-after") for a in answers if a["status"] == 429}), "held": held, "after": state(ledger), "one": one, "cap": int(key.max_budget * 1e6)}

async def refusals():
    ledger = ns["_LEDGER"] = Ledger(); g = guard()
    data = req(); one = worst(data)
    spent = await pre(g, Key(cap=0.05, spend=0.05 - one / 2e6), data)                      # LiteLLM's own spend leaves less than this call
    ledger.keys["k2"] = {"charged": 50000 - one // 2, "held": 0}
    charged = await pre(g, Key(cap=0.05, token="k2"), req())                               # the guard's charged figure leaves less (LiteLLM's lags)
    too_big = await pre(g, Key(cap=one / 2e6, token="k3"), req())                           # one call alone cannot fit
    anth = await pre(g, Key(cap=0.0001, token="k4"), req(model="m-anth", route="anthropic_messages"), "anthropic_messages")
    unpriced = await pre(g, Key(cap=1.0, token="k5"), req(model="m-free"))
    unknown = await pre(g, Key(cap=1.0, token="k5"), req(model="m-nowhere"))
    no_budget = await pre(g, Key(cap=None, token="k6"), req(model="m-nowhere"))
    no_key_object = await pre(g, {}, req())
    # room for about 10,000 output tokens, 64,000 asked: the largest affordable limit is offered, and the call sent again with it is held
    big = req(max_tokens=64000); room = worst(dict(big, max_tokens=10_000))
    hint = await pre(g, Key(cap=room / 1e6, token="k7"), big)
    again = await pre(g, Key(cap=room / 1e6, token="k7"), dict(req(max_tokens=int(hint["headers"]["x-rovara-max-tokens"]))))
    hint_anth = await pre(g, Key(cap=room / 1e6, token="k8"), req(model="m-own", route="anthropic_messages", max_tokens=64000), "anthropic_messages")
    return {"spent": spent, "charged": charged, "too_big": too_big, "anth": anth, "unpriced": unpriced, "unknown": unknown, "no_budget": no_budget,
            "no_key_object": no_key_object, "ledger_keys": sorted(ledger.keys), "hint": hint, "again": again, "hint_anth": hint_anth}

async def settling():
    out = {}
    ledger = ns["_LEDGER"] = Ledger(); g = guard()
    d = req(); await pre(g, Key(cap=1.0), d); w = worst(d)
    await g.async_post_call_success_hook(d, None, "response")
    await g.async_log_success_event({"litellm_call_id": d["litellm_call_id"], "response_cost": 0.0042}, None, None, None)
    await g.async_log_success_event({"litellm_call_id": d["litellm_call_id"], "response_cost": 0.5}, None, None, None)     # a repeat changes nothing
    out["plain"] = dict(state(ledger), reserved=w)
    # a stream that completes, its cost arriving after the stream ended, and one whose cost arrives first
    ledger = ns["_LEDGER"] = Ledger(); g = guard()
    a, b = req(stream=True), req(stream=True)
    for d in (a, b): await pre(g, Key(cap=1.0), d)
    async for _ in g.async_post_call_streaming_iterator_hook(None, chunks(3), a): pass
    await g.async_log_success_event({"litellm_call_id": a["litellm_call_id"], "response_cost": 0.001}, None, None, None)
    it = g.async_post_call_streaming_iterator_hook(None, chunks(3), b)
    await it.__anext__()
    await g.async_log_success_event({"litellm_call_id": b["litellm_call_id"], "response_cost": 0.002}, None, None, None)
    async for _ in it: pass
    await asyncio.sleep(0.01)
    out["streams"] = state(ledger)
    # a stream the worker cuts (LiteLLM then logs a partial cost), one the provider breaks, and one that ends with no cost ever arriving
    ledger = ns["_LEDGER"] = Ledger(); g = guard()
    cut, broken, silent = req(stream=True), req(stream=True), req(stream=True)
    for d in (cut, broken, silent): await pre(g, Key(cap=1.0), d)
    it = g.async_post_call_streaming_iterator_hook(None, chunks(10), cut)
    await it.__anext__(); await it.aclose()
    await g.async_log_success_event({"litellm_call_id": cut["litellm_call_id"], "response_cost": 0.00001}, None, None, None)
    try:
        async for _ in g.async_post_call_streaming_iterator_hook(None, chunks(2, fail=True), broken): pass
    except RuntimeError: pass
    await g.async_log_failure_event({"litellm_call_id": broken["litellm_call_id"], "exception": RuntimeError("x")}, None, None, None)
    async for _ in g.async_post_call_streaming_iterator_hook(None, chunks(2), silent): pass
    await asyncio.sleep(0.01)
    before_grace = state(ledger)
    await asyncio.sleep(0.1)
    out["cut"] = {"before_grace": before_grace, "after_grace": state(ledger), "each": worst(cut)}
    # errors: an error answer is not billed, a timeout is charged in full; a failed ATTEMPT settles nothing (LiteLLM may retry it under the same call id)
    ledger = ns["_LEDGER"] = Ledger(); g = guard()
    e400, timeout = req(), req()
    for d in (e400, timeout): await pre(g, Key(cap=1.0), d)
    class BadRequest(Exception): status_code = 400
    class Upstream(Exception): status_code = 500
    class Timeout(Exception): status_code = 408
    await g.async_log_failure_event({"litellm_call_id": e400["litellm_call_id"], "exception": BadRequest()}, None, None, None)
    attempt_only = state(ledger)
    await g.async_post_call_failure_hook(e400, BadRequest(), None)
    await g.async_post_call_failure_hook(timeout, Timeout(), None)
    out["errors"] = dict(state(ledger), each=worst(timeout), attempt_only=attempt_only)
    # a failed attempt and then a retry that answers: its cost, plus the whole hold when the failed attempt timed out (it may have been billed)
    ledger = ns["_LEDGER"] = Ledger(); g = guard()
    plain, slow = req(), req()
    for d in (plain, slow): await pre(g, Key(cap=1.0), d)
    await g.async_log_failure_event({"litellm_call_id": plain["litellm_call_id"], "exception": Upstream()}, None, None, None)
    await g.async_log_success_event({"litellm_call_id": plain["litellm_call_id"], "response_cost": 0.003}, None, None, None)
    await g.async_log_failure_event({"litellm_call_id": slow["litellm_call_id"], "exception": Timeout()}, None, None, None)
    await g.async_log_success_event({"litellm_call_id": slow["litellm_call_id"], "response_cost": 0.003}, None, None, None)
    out["retried"] = dict(state(ledger), each=worst(slow))
    # N1: a failed attempt whose call never reaches the failure hook is settled after the grace (released), not held until it expires; a 499 is charged
    ledger = ns["_LEDGER"] = Ledger(); g = guard()
    lone, gone = req(), req()
    for d in (lone, gone): await pre(g, Key(cap=1.0), d)
    await g.async_log_failure_event({"litellm_call_id": lone["litellm_call_id"], "exception": Upstream()}, None, None, None)
    class ClientGone(Exception): status_code = 499
    await g.async_post_call_failure_hook(gone, ClientGone(), None)
    before = state(ledger)
    await asyncio.sleep(0.1)
    out["lone_failure"] = {"before": before, "after": state(ledger), "each": worst(gone)}
    # an orphan (its replica died) is charged its whole hold once it is older than HOLD_SECONDS, at the key's next take
    ledger = ns["_LEDGER"] = Ledger(); g1, g2 = guard(), guard()
    lost = req(); await pre(g1, Key(cap=1.0), lost)
    ledger.clock += ns["HOLD_SECONDS"] - 1; await pre(g2, Key(cap=1.0), req()); young = state(ledger)
    ledger.clock += 2; await pre(g2, Key(cap=1.0), req()); old = state(ledger)
    out["orphan"] = {"young": young, "old": old, "each": worst(lost)}
    return out

class FakeDb:
    """Records the statements the Postgres ledger sends; answers a take as held. fail_next makes the next statement raise once."""
    def __init__(self): self.sent, self.fail_next = [], False
    async def _go(self, sql):
        await asyncio.sleep(0.001)
        if self.fail_next: self.fail_next = False; raise RuntimeError("relation does not exist")
        self.sent.append(sql.split(" (")[0][:60])
    async def execute_raw(self, sql, *args): await self._go(sql); return 1
    async def query_raw(self, sql, *args): await self._go(sql); return [{"call_id": args[4]}] if "INSERT INTO rovara_budget.holds" in sql else []

async def postgres():
    db = FakeDb(); server.prisma_client = types.SimpleNamespace(db=db); ledger = ns["_PostgresLedger"]()
    await asyncio.gather(*(ledger.take("k", f"c{i}", 1, 0, 100) for i in range(5)))
    first = list(db.sent)
    db.fail_next = True
    try: await ledger.take("k", "c9", 1, 0, 100); failed = False
    except RuntimeError: failed = True
    after_error = ledger._ready
    db.sent.clear(); await ledger.take("k", "c10", 1, 0, 100)
    return {"schema_runs": sum(1 for s in first if s.startswith("CREATE SCHEMA")), "first": first[:6], "failed": failed, "ready_after_error": after_error,
            "again": db.sent[:2], "statements": [ns[n] for n in ("_SQL_TAKE", "_SQL_SETTLE", "_SQL_SWEEP")]}

async def worst_cases():
    p = ns["_prices_for"]("m-anth"); own = ns["_prices_for"]("m-own")
    def w(**k):
        data = dict({"model": "m-anth", "messages": [], "litellm_call_id": "c", "metadata": {"user_api_key_hash": "h"}}, **k)
        return [ns["_worst_case_micros"](data, p), ns["_request_bytes"](data)]     # injected fields are not part of the request's size
    url_image = [{"role": "user", "content": [{"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}]}]
    inline = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}]
    argument = [{"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "fetch", "input": {"url": "https://example.com"}}]}]
    per_call = ns["_prices_for"]("m-percall")
    citation = [{"role": "assistant", "content": [{"type": "text", "text": "see", "citations": [{"type": "web_search_result_location", "url": "https://example.com/x"}]}]}]
    file_uri = [{"role": "user", "content": [{"type": "file", "file": {"file_uri": "gs://bucket/a.pdf"}}]}]
    s3 = [{"role": "user", "content": [{"image": {"format": "png", "source": {"s3Location": {"uri": "s3://bucket/a.png"}}}}]}]
    return {"prices": p, "own": own, "named": w(max_tokens=1000), "none": w(), "over_model": w(max_tokens=10_000_000), "responses": w(max_output_tokens=1000),
            "completion": w(max_completion_tokens=1000), "big": w(max_tokens=1000, messages=[{"role": "user", "content": "x" * 100_000}]),
            "both": w(max_tokens=100, max_completion_tokens=1000), "remote": w(max_tokens=1000, messages=url_image),
            "file_id": w(max_tokens=1000, messages=[{"role": "user", "content": [{"type": "input_file", "file_id": "f1"}]}]),
            "inline": w(max_tokens=1000, messages=inline), "argument": w(max_tokens=1000, messages=argument),
            "citation": w(max_tokens=1000, messages=citation), "file_uri": w(max_tokens=1000, messages=file_uri), "s3": w(max_tokens=1000, messages=s3),
            "per_call": [ns["_worst_case_micros"]({"model": "m-percall", "max_tokens": 1000}, per_call), ns["_request_bytes"]({"model": "m-percall", "max_tokens": 1000})],
            "plain_size": len(json.dumps({"model": "m-anth", "messages": [], "max_tokens": 1000}, ensure_ascii=False))}

which = json.load(sys.stdin)
json.dump({name: asyncio.run(globals()[name]()) for name in which}, sys.stdout)
`;

  type LedgerRow = { charged: number; held: number; holds: number };
  type Answer = { status: number; type?: string; message?: string; headers?: Record<string, string> };
  type Priced = [number, number];
  interface BudgetResults {
    worst_cases: { prices: Array<number | null>; own: Array<number | null>; plain_size: number }
      & Record<"named" | "none" | "over_model" | "responses" | "completion" | "big" | "both" | "remote" | "file_id" | "inline" | "argument" | "per_call" | "citation" | "file_uri" | "s3", Priced>;
    parallel: { codes: number[]; types: string[]; retry_after: string[]; held: LedgerRow; after: LedgerRow; one: number; cap: number };
    refusals: Record<"spent" | "charged" | "too_big" | "anth" | "unpriced" | "unknown" | "no_budget" | "no_key_object" | "hint" | "again" | "hint_anth", Answer> & { ledger_keys: string[] };
    postgres: { schema_runs: number; first: string[]; failed: boolean; ready_after_error: boolean; again: string[]; statements: string[] };
    settling: { plain: LedgerRow; streams: LedgerRow; cut: { before_grace: LedgerRow; after_grace: LedgerRow; each: number }; errors: LedgerRow & { each: number; attempt_only: LedgerRow };
      retried: LedgerRow & { each: number }; lone_failure: { before: LedgerRow; after: LedgerRow; each: number };
      orphan: { young: LedgerRow; old: LedgerRow; each: number } };
  }
  function runBudget<K extends keyof BudgetResults>(scenario: K): BudgetResults[K] {
    const directory = mkdtempSync(join(tmpdir(), "rovara-guard-budget-"));
    const guard = join(directory, "rovara_guard.py");
    const harness = join(directory, "harness.py");
    writeFileSync(guard, ROVARA_GUARD_PY);
    writeFileSync(harness, BUDGET_HARNESS);
    const out = JSON.parse(execFileSync("python3", ["-I", harness, guard], { input: JSON.stringify([scenario]), stdio: ["pipe", "pipe", "pipe"] }).toString()) as Pick<BudgetResults, K>;
    return out[scenario];
  }

  itPython("prices a call's worst case at the dearest rate it could be billed at, its output limit or the model's, and one input token per request byte", () => {
    const w = runBudget("worst_cases");
    // the dearest input rate (the 200k tier, above the cache-write rate) and output rate (the 200k tier, never the cheaper batch rate)
    expect(w.prices).toEqual([0.000006, 0.0000225, 64000, 1000000, 0]);
    expect(w.own).toEqual([0.000003, 0.000015, null, null, 0]);
    const at = (output: number, input: number) => Math.ceil((output * 0.0000225 + input * 0.000006) * 1e6 - 1e-6);
    expect(w.named[1]).toBe(w.plain_size);
    for (const name of ["named", "responses", "completion", "big"] as const) expect(w[name][0], name).toBe(at(1000, w[name][1]));
    expect(w.none[0]).toBe(at(64000, w.none[1]));                  // no limit named: the model's own
    // a limit as asked, even above the cost map's (the map disagrees with itself across ids); at most 1,000,000
    expect(w.over_model[0]).toBe(at(1_000_000, w.over_model[1]));
    expect(w.both[0]).toBe(at(1000, w.both[1]));                   // max_tokens 100 beside max_completion_tokens 1000: the larger
    expect(w.big[1]).toBeGreaterThan(100_000);
    // media named by reference (a URL, a file id) is fetched after the hook: the model's whole input limit is held; inline data and tool arguments are bytes
    expect(w.remote[0]).toBe(at(1000, 1_000_000));
    expect(w.file_id[0]).toBe(at(1000, 1_000_000));
    expect(w.inline[0]).toBe(at(1000, w.inline[1]));
    expect(w.argument[0]).toBe(at(1000, w.argument[1]));
    // only references inside a media block count: a citation's URL is text; a Gemini file_uri and a Bedrock S3 location are media (N4)
    expect(w.citation[0]).toBe(at(1000, w.citation[1]));
    expect(w.file_uri[0]).toBe(at(1000, 1_000_000));
    expect(w.s3[0]).toBe(at(1000, 1_000_000));
    // a fixed price per call is added
    expect(w.per_call[0]).toBe(Math.ceil((1000 * 0.000015 + w.per_call[1] * 0.000003 + 0.01) * 1e6 - 1e-6));
  });

  itPython("8 parallel calls over two replicas on a budget that fits one worst case: one is held, seven get 429 budget_held, nothing overshoots", () => {
    const parallel = runBudget("parallel");
    expect(parallel.codes).toEqual([200, 429, 429, 429, 429, 429, 429, 429]);
    expect(parallel.types).toEqual(["budget_held"]);
    expect(parallel.retry_after).toEqual(["2"]);
    expect(parallel.held).toEqual({ charged: 0, held: parallel.one, holds: 1 });
    expect(parallel.held.held).toBeLessThanOrEqual(parallel.cap);
    expect(parallel.after).toEqual({ charged: 3000, held: 0, holds: 0 });
  });

  itPython("answers 422 budget_exceeded when the spend leaves no room for the call, in the shape the worker reads, and 403 for a model with no price", () => {
    const r = runBudget("refusals");
    for (const name of ["spent", "charged", "too_big"] as const) {
      expect(r[name].status, name).toBe(422);
      expect(r[name].type, name).toBe("budget_exceeded");
      expect(r[name].message, name).toMatch(/^Budget has been exceeded! Key=/u);
    }
    // /v1/messages rewrites an error by its status unless the message is already an Anthropic error body: so it is one, keeping the type
    expect(r.anth.status).toBe(422);
    const anthropic = JSON.parse(r.anth.message ?? "") as { type: string; error: { type: string; message: string } };
    expect(anthropic.type).toBe("error");
    expect(anthropic.error.type).toBe("budget_exceeded");
    expect(anthropic.error.message).toMatch(/^Budget has been exceeded! Key=task /u);
    expect(r.unpriced).toMatchObject({ status: 403, type: "model_not_priced" });
    expect(r.unknown).toMatchObject({ status: 403, type: "model_not_priced" });
    // a key with no budget (or no key object) is not held at all
    expect(r.no_budget).toEqual({ status: 200 });
    expect(r.no_key_object).toEqual({ status: 200 });
    expect(r.ledger_keys).not.toContain("k6");
    // a room too small for the output limit asked, but enough for a smaller one: 422 budget_max_tokens with the largest affordable limit, not a spent budget
    expect(r.hint).toMatchObject({ status: 422, type: "budget_max_tokens", headers: { "x-rovara-max-tokens": "10000" } });
    expect(r.again).toEqual({ status: 200 });
    expect(r.hint_anth).toMatchObject({ status: 422, type: "budget_max_tokens" });
    expect((JSON.parse(r.hint_anth.message ?? "") as { error: { type: string } }).error.type).toBe("budget_max_tokens");
  });

  itPython("settles to the real cost, charges a cut or broken stream its whole hold, releases an error answer, and charges an orphan after HOLD_SECONDS", () => {
    const s = runBudget("settling");
    expect(s.plain).toMatchObject({ charged: 4200, held: 0, holds: 0 });
    expect(s.streams).toEqual({ charged: 3000, held: 0, holds: 0 });
    // the cut and the broken stream are charged in full at once; the silent one is charged in full after the grace
    expect(s.cut.before_grace).toEqual({ charged: 2 * s.cut.each, held: s.cut.each, holds: 1 });
    expect(s.cut.after_grace).toEqual({ charged: 3 * s.cut.each, held: 0, holds: 0 });
    expect(s.errors.attempt_only).toEqual({ charged: 0, held: 2 * s.errors.each, holds: 2 });
    expect(s.errors).toMatchObject({ charged: s.errors.each, held: 0, holds: 0 });
    expect(s.retried).toMatchObject({ charged: 3000 + 3000 + s.retried.each, held: 0, holds: 0 });
    expect(s.lone_failure.before).toEqual({ charged: s.lone_failure.each, held: s.lone_failure.each, holds: 1 });
    expect(s.lone_failure.after).toEqual({ charged: s.lone_failure.each, held: 0, holds: 0 });
    expect(s.orphan.young).toEqual({ charged: 0, held: 2 * s.orphan.each, holds: 2 });
    expect(s.orphan.old).toEqual({ charged: s.orphan.each, held: 2 * s.orphan.each, holds: 2 });
  });

  itPython("sets the Postgres ledger up once per replica even under concurrent calls, in its own schema, and again after a database error", () => {
    const pg = runBudget("postgres");
    expect(pg.schema_runs).toBe(1);
    expect(pg.first.slice(0, 4)).toEqual(["CREATE SCHEMA IF NOT EXISTS rovara_budget", "CREATE TABLE IF NOT EXISTS rovara_budget.keys", "CREATE TABLE IF NOT EXISTS rovara_budget.holds", "CREATE INDEX IF NOT EXISTS holds_key ON rovara_budget.holds"]);
    expect(pg.failed).toBe(true);
    expect(pg.ready_after_error).toBe(false);
    expect(pg.again[0]).toBe("CREATE SCHEMA IF NOT EXISTS rovara_budget");
    for (const statement of pg.statements) {
      expect(statement).toContain("rovara_budget.");
      expect(statement).not.toMatch(/\brovara_budget_(keys|holds)\b/u);
    }
  });

  it("keeps the budget hold's limits: an orphan outlives the proxy's request timeout, and LiteLLM's own per-replica reservation is off", () => {
    expect(ROVARA_GUARD_PY).toContain("HOLD_SECONDS = 1000");
    expect(ROVARA_GUARD_PY).toContain("HELD_RETRY_AFTER_SECONDS = 2");
    expect(litellmConfig({ region: "us-west-2", models: [{ id: "m" }] })).toContain("  disable_budget_reservation: true\n");
  });
});
