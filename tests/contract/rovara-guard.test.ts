// The guard module that every inference request passes through (Plan 3 Task 25; docs/learnings/model-sources-spike.md, questions 8 and 9).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROVARA_GUARD_PY } from "../../packages/model-proxy/src/rovara-guard.js";

// A missing python3 must show as skipped, never as green: the refusal checks below run the real Python hook.
const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;
const itPython = it.skipIf(!hasPython);

describe("rovara_guard.py", () => {
  it("is the module the spike verified, byte for byte (update both together when LiteLLM or Pi is bumped)", () => {
    expect(ROVARA_GUARD_PY).toBe(readFileSync(new URL("../../docs/learnings/model-sources-spike/rovara_guard.py", import.meta.url), "utf8"));
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
});
