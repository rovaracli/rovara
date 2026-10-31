import { describe, expect, it } from "vitest";
import { checkArguments, contextWriteGate, looksLikeCode } from "../../../packages/broker/src/context-sources/guards.js";
import { frameResult, inertSchema, presentedToolName, resolvePresentedTool } from "../../../packages/broker/src/context-sources/present.js";
import { source } from "./fixtures.js";

describe("contextWriteGate", () => {
  it("runs only what is annotated read-only, or confirmed", () => {
    expect(contextWriteGate({ tool: { name: "get_ticket", annotations: { readOnlyHint: true } }, attestedReadOnly: false }).decision).toBe("run");
    expect(contextWriteGate({ tool: { name: "get_ticket" }, attestedReadOnly: false }).decision).toBe("refuse");
    expect(contextWriteGate({ tool: { name: "get_ticket" }, attestedReadOnly: true }).decision).toBe("run");
    expect(contextWriteGate({ tool: { name: "get_ticket", annotations: { destructiveHint: true } }, attestedReadOnly: true }).decision).toBe("refuse");
    expect(contextWriteGate({ tool: { name: "create_ticket", annotations: { readOnlyHint: true } }, attestedReadOnly: false }).decision).toBe("refuse");
    expect(contextWriteGate({ tool: { name: "create_ticket", annotations: { readOnlyHint: false } }, attestedReadOnly: true }).decision).toBe("refuse");
  });
});

describe("checkArguments", () => {
  const base = { inputSchema: {}, hosts: ["sim.example.com"], sendCodeSnippets: false };
  it("passes a short plain query", () => expect(checkArguments({ ...base, args: { query: "login fails on retry" } })).toEqual({ ok: true }));
  it("refuses deep nesting and very many strings", () => {
    expect(checkArguments({ ...base, args: { a: { b: { c: { d: { e: { f: { g: "x" } } } } } } } })).toEqual({ ok: false, reason: "too_deep" });
    expect(checkArguments({ ...base, args: { list: Array.from({ length: 150 }, () => "a") } })).toMatchObject({ ok: false });
  });
  it("counts the address host case-insensitively, and refuses a look-alike host", () => {
    expect(checkArguments({ ...base, args: { q: "https://SIM.example.com/x" } })).toEqual({ ok: true });
    expect(checkArguments({ ...base, args: { q: "https://sim.example.com.evil.net/x" } })).toEqual({ ok: false, reason: "address_off_host" });
  });
  it("tells code from words", () => {
    expect(looksLikeCode("a ticket about login failing after the retry")).toBe(false);
    expect(looksLikeCode("error: invalid {id} in config")).toBe(false);
    expect(looksLikeCode("if (a) {\n  b();\n}")).toBe(true);
    expect(looksLikeCode("line1\nline2\nline3\nline4")).toBe(true);
    expect(looksLikeCode("```js\nx\n```")).toBe(true);
    expect(looksLikeCode("const f = (a) => { return a; };")).toBe(true);
  });
});

describe("presented names", () => {
  it("stay within 64 characters and stay different for two long tool names", () => {
    const a = presentedToolName("sim", `search_${"a".repeat(60)}`);
    const b = presentedToolName("sim", `search_${"a".repeat(59)}b`);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^src_sim_/u);
  });
  it("resolve back to the ticked tool, and only for the right source", () => {
    const sources = [source()];
    expect(resolvePresentedTool(sources, "src_sim_get_ticket")?.tool.upstreamName).toBe("get_ticket");
    expect(resolvePresentedTool(sources, "src_wiki_get_ticket")).toBeUndefined();
    expect(resolvePresentedTool(sources, "get_ticket")).toBeUndefined();
  });
});

describe("schemas and frames", () => {
  it("drops a schema that is too deep or too large instead of trusting it", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 10; index += 1) deep = { type: "object", properties: { next: deep } };
    expect(inertSchema(deep)).toBeUndefined();
    expect(inertSchema({ type: "object", properties: { big: { type: "string", enum: Array.from({ length: 2_000 }, (_, i) => `value-${i}`) } } })).toBeUndefined();
  });
  it("cuts on a character boundary", () => {
    const framed = frameResult({ source: source(), itemRef: "x", fetchedAt: "t", text: "é".repeat(100), maxBytes: 11, standing: "outsider" });
    expect(framed.truncated).toBe(true);
    expect(framed.text).not.toContain("�");
  });
  it("keeps a label with quotes or tags from breaking the tag", () => {
    const framed = frameResult({ source: source({ label: 'SIM" onload="x' }), itemRef: "a>b", fetchedAt: "t", text: "t", maxBytes: 100, standing: "outsider" });
    expect(framed.text.split("\n")[0]).toBe('<source-result source="SIM onload=x" item="ab" fetched="t" untrusted="true" standing="outsider">');
  });
});
