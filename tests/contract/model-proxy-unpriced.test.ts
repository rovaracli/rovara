// DECISIONS 172 (0.5.18): no model is refused for lack of a price. The guard (rovara_guard.py, section 4) holds a model with no known price at a cautious estimate (the dearest known rate of
// its family, long-context tier included, times 1.5), enforces the task's cap on that hold, and settles the call at the dearest known rate, flagged estimated, never at $0. Prices come
// fresh: AWS's price list and LiteLLM's upstream cost map, validated, with the image's bundled map as the fallback. The guard runs here as Python with LiteLLM's modules replaced by small
// fakes (a cost map that registers prices, a router that lists deployments, an in-memory ledger); the real LiteLLM is in tests/integration/model-proxy-prices-docker.test.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROVARA_GUARD_PY } from "../../packages/model-proxy/src/rovara-guard.js";

const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;
const itPython = it.skipIf(!hasPython);

const HARNESS = String.raw`
import asyncio, json, sys, types
class HTTPException(Exception):
    def __init__(self, status_code, detail): self.status_code, self.detail = status_code, detail
class CustomLogger:
    def __init__(self, *a, **k): pass
class ProxyException(Exception):
    def __init__(self, message, type, param, code=None, headers=None):
        self.message, self.type, self.code, self.headers = message, type, str(code), headers or {}
scenario = json.load(sys.stdin)
litellm = types.ModuleType("litellm"); litellm.model_cost = json.loads(json.dumps(scenario["model_cost"]))
def get_model_info(model):
    entry = litellm.model_cost.get(model) or litellm.model_cost.get(model.split("/", 1)[-1])
    if entry is None: raise Exception("This model isn't mapped yet. model=" + model)
    return entry
def register_model(entries):
    for key, value in entries.items(): litellm.model_cost[key] = {**litellm.model_cost.get(key, {}), **value}
litellm.get_model_info, litellm.register_model = get_model_info, register_model
DEPLOYMENTS = scenario["deployments"]
proxy = types.ModuleType("litellm.proxy"); server = types.ModuleType("litellm.proxy.proxy_server"); ptypes = types.ModuleType("litellm.proxy._types")
class Router:
    def get_model_list(self, model_name=None): return [d for d in DEPLOYMENTS if model_name is None or d["model_name"] == model_name] or None
server.llm_router = Router(); server.prisma_client = None; ptypes.ProxyException = ProxyException
sys.modules.update({"litellm": litellm, "litellm.proxy": proxy, "litellm.proxy.proxy_server": server, "litellm.proxy._types": ptypes})
text = open(sys.argv[1]).read()
ns = {"HTTPException": HTTPException, "CustomLogger": CustomLogger, "__name__": "guard_section"}
exec(compile(text[text.index("# ---------------------------------------------------------------- 1. request allow-list"):], "guard", "exec"), ns)
ns["PRICE_REFRESH_ENABLED"] = False
ns["MIN_MAP_MODELS"] = scenario.get("min_models", 2)
ns["SETTLE_GRACE_SECONDS"] = 0.01

class Ledger:
    """The Postgres ledger's meaning, in memory: a take against the cap (an ESTIMATED hold that does not fit goes ahead once, while the key has not overrun and nothing else is held,
    holding only the room that is left: DECISIONS 165), and a settle that records the charge and whether it is an estimate."""
    def __init__(self): self.rows, self.holds, self.settled, self.worsts = {}, {}, [], {}
    async def take(self, key, call_id, worst, spent, cap, estimated=False):
        row = self.rows.setdefault(key, {"charged": 0, "held": 0})
        known = max(row["charged"], spent)
        self.worsts[call_id] = worst
        if known + row["held"] + worst <= cap: reserve = worst
        elif estimated and known < cap and row["held"] == 0: reserve = min(worst, max(cap - known, 0))
        else: return ("exceeded" if known + worst > cap else "held"), row["charged"]
        row["held"] += reserve; self.holds[call_id] = (key, reserve); return "ok", None
    async def settle(self, call_id, cost, estimated=False):
        key, reserved = self.holds.pop(call_id)
        charge = reserved if cost is None else cost
        row = self.rows[key]; row["held"] -= reserved; row["charged"] += charge
        self.settled.append({"micros": charge, "estimated": bool(estimated), "whole_hold": cost is None})
ledger = ns["_LEDGER"] = Ledger()
guard = ns["RovaraGuard"]()

class Key:
    def __init__(self, cap, token="k1"): self.max_budget, self.spend, self.token = cap, 0.0, token

async def fetch_for(sources):
    def fetch(url, host):
        if host not in sources: raise OSError("unreachable " + host)
        return json.loads(json.dumps(sources[host]))
    return fetch

async def run(step, n):
    if step["op"] == "refresh":
        result = await ns["_refresh_prices"](await fetch_for(step["sources"]))
        return {"refresh": result, "entries": {k: litellm.model_cost.get(k) for k in step.get("inspect", [])}}
    data = {"model": step["model"], "messages": [{"role": "user", "content": "hi"}], "stream": False, "litellm_call_id": "call-%d" % n}
    if step.get("max_tokens") is not None: data["max_tokens"] = step["max_tokens"]
    before = len(ledger.settled)
    try:
        await guard.async_pre_call_hook(Key(step.get("cap", 100.0)), None, data, "acompletion")
    except ProxyException as e:
        return {"status": int(e.code), "type": e.type}
    out = {"status": 200, "held": ledger.worsts["call-%d" % n], "reserved": ledger.holds["call-%d" % n][1], "prices": list(ns["_hold_prices"](step["model"]))[1:]}
    if "usage" in step or "cost" in step or step.get("cut"):
        if step.get("cut"): await guard.async_post_call_failure_hook(data, Exception("cut"), None); await guard._finish("call-%d" % n, None, True)
        else: await guard.async_log_success_event({"litellm_call_id": "call-%d" % n, "response_cost": step.get("cost")}, {"usage": step["usage"]} if "usage" in step else None, None, None)
        out["settled"] = ledger.settled[before] if len(ledger.settled) > before else None
    return out

async def main():
    return [await run(step, n) for n, step in enumerate(scenario["steps"])]
json.dump(asyncio.run(main()), sys.stdout)
`;

type Step = Record<string, unknown>;
type Result = { status?: number; type?: string; held?: number; reserved?: number; prices?: boolean[]; settled?: { micros: number; estimated: boolean; whole_hold: boolean } | null; refresh?: Record<string, string>; entries?: Record<string, Record<string, number> | null> };

function run(scenario: { deployments: unknown[]; model_cost: Record<string, unknown>; steps: Step[]; min_models?: number }): Result[] {
  const directory = mkdtempSync(join(tmpdir(), "rovara-guard-unpriced-"));
  const guard = join(directory, "rovara_guard.py");
  const harness = join(directory, "harness.py");
  writeFileSync(guard, ROVARA_GUARD_PY);
  writeFileSync(harness, HARNESS);
  return JSON.parse(execFileSync("python3", ["-I", harness, guard], { input: JSON.stringify(scenario), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ROVARA_PRICE_REFRESH: "0" } }).toString()) as Result[];
}

const deployment = (name: string, model: string, extra: Record<string, unknown> = {}) => ({ model_name: name, litellm_params: { model, aws_region_name: "us-west-2" }, model_info: extra });
// What LiteLLM's bundled map knows: three Claude models (the dearest, Opus, with a long-context tier at twice its rate) and one model of another provider. $ per token.
const KNOWN = {
  "us.anthropic.claude-sonnet-4-6": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 3.3e-6, output_cost_per_token: 1.65e-5, max_output_tokens: 64000 },
  "us.anthropic.claude-opus-4-8": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 5.5e-6, output_cost_per_token: 2.75e-5, input_cost_per_token_above_200k_tokens: 1.1e-5, output_cost_per_token_above_200k_tokens: 4.125e-5, cache_creation_input_token_cost: 6.875e-6, max_output_tokens: 128000 },
  "us.anthropic.claude-haiku-4-5": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 1.1e-6, output_cost_per_token: 5.5e-6 },
  "gpt-4o": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
  "gemini-2-flash": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 1e-7, output_cost_per_token: 4e-7 },
  "gemini-2-pro": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
  "gpt-5-pro": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1.5e-5, output_cost_per_token: 1.2e-4 },
};
const NEW_CLAUDE = deployment("us.anthropic.claude-haiku-9", "bedrock/us.anthropic.claude-haiku-9");
const NEW_OPENAI = deployment("gpt-new", "openai/gpt-new");

describe("a model with no price is held and settled cautiously, never refused", () => {
  itPython("holds a Claude model nobody priced at 1.5 times the dearest Claude rate, long-context tier included, and goes through", () => {
    const [call] = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [{ op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000 }] });
    expect(call).toMatchObject({ status: 200, prices: [true] });
    // 1,000 output tokens at 1.5 x $41.25 per million (Opus's long-context output rate, the dearest Claude rate) is 61,875 micro-dollars; the request's own 150 or so bytes add under 2,500 at 1.5 x Opus's $6.875 per million (the dearest input-side rate).
    expect(call!.held).toBeGreaterThanOrEqual(61_875);
    expect(call!.held).toBeLessThan(64_500);
  });

  itPython("holds a model of another provider at that provider's dearest rate, and any other at the dearest of all", () => {
    const [openai, bare] = run({ deployments: [NEW_OPENAI, deployment("mystery", "mystery")], model_cost: KNOWN, steps: [{ op: "call", model: "gpt-new", max_tokens: 1000 }, { op: "call", model: "mystery", max_tokens: 1000 }] });
    // OpenAI's dearest known output rate is gpt-5-pro's $120 per million: 1,000 tokens at 1.5 times that is 180,000 micro-dollars.
    expect(openai!.held).toBeGreaterThanOrEqual(180_000);
    expect(openai!.held).toBeLessThan(183_000);
    expect(bare!.held).toBeGreaterThanOrEqual(180_000);
  });

  itPython("settles at the usage the provider reported times the dearest known rate, flagged estimated, when LiteLLM prices the call at $0", () => {
    const [call] = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [{ op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000, cost: 0, usage: { prompt_tokens: 2000, completion_tokens: 500 } }] });
    // 2,000 x $11 per million + 500 x $41.25 per million = $0.0426250 (no safety factor at settlement).
    expect(call!.settled).toEqual({ micros: 42_625, estimated: true, whole_hold: false });
  });

  itPython("never settles a call that used tokens at $0: LiteLLM's missing cost is replaced, and no usage at all charges the whole hold", () => {
    const calls = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [
      { op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000, cost: null, usage: { input_tokens: 100, output_tokens: 10 } },
      { op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000, cost: 0 },
    ] });
    expect(calls[0]!.settled).toMatchObject({ estimated: true, whole_hold: false });
    expect(calls[0]!.settled!.micros).toBeGreaterThan(0);
    expect(calls[1]!.settled).toEqual({ micros: calls[1]!.held, estimated: true, whole_hold: true });
  });

  itPython("puts the estimate in LiteLLM's cost map at the dearest known rate with cached tokens at that rate too (left out, LiteLLM counts them as free)", () => {
    const [, entries] = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [{ op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 100 }, { op: "refresh", sources: {}, inspect: ["bedrock/us.anthropic.claude-haiku-9"] }] });
    const entry = entries!.entries!["bedrock/us.anthropic.claude-haiku-9"]!;
    expect(entry).toMatchObject({ input_cost_per_token: 1.1e-5, output_cost_per_token: 4.125e-5, cache_read_input_token_cost: 1.1e-5, cache_creation_input_token_cost: 1.1e-5 });
  });

  itPython("settles a call LiteLLM did price at LiteLLM's cost, not flagged estimated", () => {
    const [call] = run({ deployments: [deployment("us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6")], model_cost: KNOWN, steps: [{ op: "call", model: "us.anthropic.claude-sonnet-4-6", max_tokens: 1000, cost: 0.0042, usage: { prompt_tokens: 100, completion_tokens: 100 } }] });
    expect(call).toMatchObject({ status: 200, prices: [false], settled: { micros: 4200, estimated: false } });
  });

  itPython("lets a cheap model of an unknown provider work on a small cap: the first call goes ahead, holding the room that is left; calls go on while the task has not overrun; the first call settled over the cap blocks every later one (DECISIONS 165)", () => {
    const small = (step: Step): Step => ({ op: "call", model: "mystery", cap: 0.01, ...step });
    const calls = run({ deployments: [deployment("mystery", "mystery")], model_cost: KNOWN, steps: [
      small({ cost: 0, usage: { prompt_tokens: 100, completion_tokens: 50 } }),
      small({ cost: 0, usage: { prompt_tokens: 100, completion_tokens: 50 } }),
      small({ cost: 0, usage: { prompt_tokens: 100, completion_tokens: 50 } }),
      small({}),
    ] });
    // The cautious hold (64,000 output tokens at 1.5 x $120 per million: $11.5) is far over the $0.01 cap, yet the task has spent nothing: the call goes ahead and holds the $0.01 that is left.
    expect(calls[0]).toMatchObject({ status: 200, prices: [true], reserved: 10_000 });
    expect(calls[0]!.held).toBeGreaterThan(10_000_000);
    // It settles at its actual usage times the dearest known rate (100 x $15 + 50 x $120 per million = $0.0075), flagged estimated: under the cap, so the next call also goes ahead, on what is left.
    expect(calls[0]!.settled).toEqual({ micros: 7500, estimated: true, whole_hold: false });
    expect(calls[1]).toMatchObject({ status: 200, reserved: 2500 });
    // That second call settles at $0.0075 too: $0.015 spent of $0.01. From then on every call is blocked, in the shape the worker reads as a spent budget.
    expect(calls[1]!.settled).toEqual({ micros: 7500, estimated: true, whole_hold: false });
    expect(calls[2]).toEqual({ status: 422, type: "budget_exceeded" });
    expect(calls[3]).toEqual({ status: 422, type: "budget_exceeded" });
  });

  itPython("answers 429 budget_held, not a spent budget, to an estimated call that arrives while an earlier one is still in flight", () => {
    const calls = run({ deployments: [deployment("mystery", "mystery")], model_cost: KNOWN, steps: [
      { op: "call", model: "mystery", cap: 0.01 },
      { op: "call", model: "mystery", cap: 0.01 },
    ] });
    expect(calls[0]).toMatchObject({ status: 200 });
    expect(calls[1]).toEqual({ status: 429, type: "budget_held" });
  });

  itPython("still enforces the cap on a call whose price IS known: no overrun, a hold that does not fit is refused", () => {
    const calls = run({ deployments: [deployment("us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6")], model_cost: KNOWN, steps: [
      { op: "call", model: "us.anthropic.claude-sonnet-4-6", max_tokens: 1000, cap: 0.01 },
      { op: "call", model: "us.anthropic.claude-sonnet-4-6", max_tokens: 100, cap: 0.01 },
    ] });
    expect(calls[0]).toMatchObject({ status: 422 });                   // 1,000 tokens at $16.50 per million is $0.0165 over the $0.01 cap
    expect(calls[1]).toMatchObject({ status: 200, prices: [false] });  // 100 tokens fit
  });

  itPython("uses the SAME provider's dearest known rate when the provider is known (prefix or name), and every model's only for an unknown provider", () => {
    const calls = run({ deployments: [deployment("g", "gemini/gemini-new"), deployment("gemini-newer", "gemini-newer"), deployment("o", "openai/o-new"), deployment("mystery", "mystery")], model_cost: KNOWN, steps: [
      { op: "call", model: "g", max_tokens: 1000 }, { op: "call", model: "gemini-newer", max_tokens: 1000 }, { op: "call", model: "o", max_tokens: 1000 }, { op: "call", model: "mystery", max_tokens: 1000 },
    ] });
    // Gemini's dearest is gemini-2-pro at $10 per million out: 1,000 tokens at 1.5 times that is 15,000 micro-dollars (the request's bytes add under 1,000); not gpt-5-pro's $120.
    for (const gemini of [calls[0]!, calls[1]!]) { expect(gemini.held).toBeGreaterThanOrEqual(15_000); expect(gemini.held).toBeLessThan(16_000); }
    expect(calls[2]!.held).toBeGreaterThanOrEqual(180_000);                                          // OpenAI's dearest is gpt-5-pro
    expect(calls[3]!.held).toBeGreaterThanOrEqual(180_000);                                          // unknown provider: the dearest of every model
  });

  itPython("bounds the hold by the request's own max_tokens when it names one, and by the model's maximum (else 64,000) when it does not", () => {
    const [few, none] = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [{ op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 100 }, { op: "call", model: "us.anthropic.claude-haiku-9" }] });
    expect(few!.held).toBeLessThan(10_000);                         // 100 tokens at $61.875 per million output, plus the request's bytes
    expect(none!.held).toBeGreaterThan(3_900_000);                  // 64,000 tokens at $61.875 per million
  });

  itPython("holds a model with a price of zero (a free one, or a gap in the map) the same way, not as free", () => {
    const [call] = run({ deployments: [deployment("us.anthropic.claude-haiku-9", "bedrock/us.anthropic.claude-haiku-9", { input_cost_per_token: 0, output_cost_per_token: 0 })], model_cost: KNOWN, steps: [{ op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000 }] });
    expect(call).toMatchObject({ status: 200, prices: [true] });
  });
});

import { AWS_HAIKU_FABLE_OFFER, awsPriceOffer } from "../support/aws-price-offer.js";

const AWS_OFFER = AWS_HAIKU_FABLE_OFFER;
const offer = awsPriceOffer;
const HAIKU = deployment("us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-haiku-5-5");
const FABLE = deployment("us.anthropic.claude-fable-5-2", "bedrock/us.anthropic.claude-fable-5-2");
const GLOBAL_HAIKU = deployment("global.anthropic.claude-haiku-5-5", "bedrock/global.anthropic.claude-haiku-5-5");
const AWS = "pricing.us-east-1.amazonaws.com";

describe("fresh prices: AWS's price list", () => {
  itPython("prices Haiku 5.5 and Fable 5.2 from the price list, with the long-context and cache tiers, and the global profile's own rates; the call is then a known price, not an estimate", () => {
    const [before, refreshed, haiku, fable, global] = run({ deployments: [HAIKU, FABLE, GLOBAL_HAIKU], model_cost: KNOWN, steps: [
      { op: "call", model: "us.anthropic.claude-haiku-5-5", max_tokens: 1000 },
      { op: "refresh", sources: { [AWS]: AWS_OFFER }, inspect: ["bedrock/us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-fable-5-2", "bedrock/global.anthropic.claude-haiku-5-5"] },
      { op: "call", model: "us.anthropic.claude-haiku-5-5", max_tokens: 1000 },
      { op: "call", model: "us.anthropic.claude-fable-5-2", max_tokens: 1000 },
      { op: "call", model: "global.anthropic.claude-haiku-5-5", max_tokens: 1000 },
    ] });
    expect(before).toMatchObject({ status: 200, prices: [true] });          // unpriced until the refresh: held cautiously, not refused
    expect(refreshed!.refresh).toMatchObject({ aws: "ok" });
    const near = (value: number | undefined, expected: number) => expect(value).toBeCloseTo(expected, 12);
    const h = refreshed!.entries!["bedrock/us.anthropic.claude-haiku-5-5"]!;
    near(h.input_cost_per_token, 1.1e-7); near(h.output_cost_per_token, 5.5e-7); near(h.cache_read_input_token_cost, 1.1e-8); near(h.cache_creation_input_token_cost, 1.375e-7);
    near(h.input_cost_per_token_above_100k_tokens, 5.5e-7); near(h.output_cost_per_token_above_100k_tokens, 2.75e-6);
    const f = refreshed!.entries!["bedrock/us.anthropic.claude-fable-5-2"]!;
    near(f.input_cost_per_token, 8.8e-6); near(f.output_cost_per_token, 4.4e-5); near(f.cache_creation_input_token_cost_above_1hr, 1.76e-5);
    expect(Object.keys(f).filter((key) => key.includes("_above_") && key.includes("tokens"))).toEqual([]);
    const g = refreshed!.entries!["bedrock/global.anthropic.claude-haiku-5-5"]!;
    near(g.input_cost_per_token, 1e-7); near(g.output_cost_per_token, 5e-7);
    expect([haiku, fable, global].map((call) => call!.prices)).toEqual([[false], [false], [false]]);
    // The hold is at the dearest rate any tier names: 1,000 output tokens at Haiku's long-context $2.75 per million is 2,750 micro-dollars; Fable's $44 per million is 44,000.
    expect(haiku!.held).toBeGreaterThanOrEqual(2750); expect(haiku!.held).toBeLessThan(3000);
    expect(fable!.held).toBeGreaterThanOrEqual(44_000); expect(fable!.held).toBeLessThan(46_500);
    expect(global!.held).toBeGreaterThanOrEqual(2500); expect(global!.held).toBeLessThan(3500);   // the global profile's long-context output rate, $2.50 per million
  });

  itPython("corrects a stale bundled rate and leaves a tiered model's own thresholds alone; a company's own prices are never replaced", () => {
    const stale = { ...KNOWN, "us.anthropic.claude-haiku-5-5": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, input_cost_per_token_above_200k_tokens: 2e-6 } };
    const company = deployment("us.anthropic.claude-fable-5-2", "bedrock/us.anthropic.claude-fable-5-2", { input_cost_per_token: 9e-6, output_cost_per_token: 5e-5 });
    const [refreshed] = run({ deployments: [HAIKU, company], model_cost: stale, steps: [{ op: "refresh", sources: { [AWS]: AWS_OFFER }, inspect: ["bedrock/us.anthropic.claude-haiku-5-5", "us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-fable-5-2"] }] });
    const h = refreshed!.entries!["bedrock/us.anthropic.claude-haiku-5-5"]!;
    expect(h.input_cost_per_token).toBeCloseTo(1.1e-7, 12);
    expect(h.input_cost_per_token_above_200k_tokens).toBe(2e-6);
    expect(Object.keys(h)).not.toContain("input_cost_per_token_above_100k_tokens");
    expect(refreshed!.entries!["bedrock/us.anthropic.claude-fable-5-2"]).toBeNull();
  });

  itPython("keeps Rovara's verified override until AWS's list answers, then replaces it; an unreachable or unreadable list changes nothing", () => {
    const override = deployment("us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-haiku-5-5", { input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7, rovara_price_override: true, id: "dep-haiku" });
    const model_cost = { ...KNOWN, "dep-haiku": { input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7 } };
    const cheaper = offer([["Claude Haiku 5.5", "input_tokens_standard", 0.05], ["Claude Haiku 5.5", "output_tokens_standard", 0.25]]);
    const [unreachable, broken, replaced, call] = run({ deployments: [override], model_cost, steps: [
      { op: "refresh", sources: {}, inspect: ["dep-haiku"] },
      { op: "refresh", sources: { [AWS]: { products: "nope" } }, inspect: ["dep-haiku"] },
      { op: "refresh", sources: { [AWS]: cheaper }, inspect: ["dep-haiku"] },
      { op: "call", model: "us.anthropic.claude-haiku-5-5", max_tokens: 1000 },
    ] });
    expect(unreachable!.refresh).toMatchObject({ aws: "OSError", litellm: "OSError" });
    expect(unreachable!.entries!["dep-haiku"]!.input_cost_per_token).toBe(1.1e-7);
    expect(broken!.refresh!.aws).toBe("ValueError");
    expect(broken!.entries!["dep-haiku"]!.input_cost_per_token).toBe(1.1e-7);
    expect(replaced!.entries!["dep-haiku"]!.input_cost_per_token).toBeCloseTo(5e-8, 12);
    expect(call).toMatchObject({ status: 200, prices: [false] });
  });

  itPython("ignores batch and flex rows, prices that are zero or absurd, and a model with no output price", () => {
    const [refreshed] = run({ deployments: [HAIKU, FABLE], model_cost: KNOWN, steps: [{ op: "refresh", sources: { [AWS]: offer([
      ["Claude Haiku 5.5", "input_tokens_standard", 0], ["Claude Haiku 5.5", "output_tokens_standard", 0.55], ["Claude Haiku 5.5", "input_tokens_batch_standard", 0.05],
      ["Claude Fable 5.2", "input_tokens_standard", 8.8],
    ]) }, inspect: ["bedrock/us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-fable-5-2"] }] });
    expect(refreshed!.refresh).toMatchObject({ aws: "no prices" });
    expect(Object.keys(refreshed!.entries!["bedrock/us.anthropic.claude-haiku-5-5"] ?? {})).not.toContain("input_cost_per_token");
  });
});

describe("fresh prices: LiteLLM's upstream cost map", () => {
  const upstream = (changed: Record<string, unknown> = {}) => ({ ...KNOWN, "gpt-4o": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 }, ...changed });
  const GITHUB = "raw.githubusercontent.com";
  const scenario = (map: unknown) => run({ deployments: [NEW_CLAUDE, deployment("us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6")], model_cost: KNOWN, steps: [
    { op: "refresh", sources: { [GITHUB]: map }, inspect: ["us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-haiku-9"] },
  ] })[0]!;

  itPython("registers a validated map: a price that moved, a model the image's map lacks, and the router's copy for a deployment", () => {
    const fresh = scenario(upstream({ "us.anthropic.claude-sonnet-4-6": { ...KNOWN["us.anthropic.claude-sonnet-4-6"], input_cost_per_token: 2.2e-6 }, "us.anthropic.claude-haiku-9": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 7e-7, output_cost_per_token: 3e-6 } }));
    expect(fresh.refresh!.litellm).toBe("ok");
    expect(fresh.entries!["us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token).toBe(2.2e-6);
    expect(fresh.entries!["bedrock/us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token).toBe(2.2e-6);
    expect(fresh.entries!["us.anthropic.claude-haiku-9"]!.input_cost_per_token).toBe(7e-7);
  });

  itPython("falls back to the bundled map, changing nothing, for a map that is not an object, is too small, carries negative or absurd prices, or moves what the image prices implausibly", () => {
    const bad: Array<[string, unknown]> = [
      ["not an object", ["a"]],
      ["too few models", { "gpt-4o": KNOWN["gpt-4o"] }],
      ["prices out of range", { ...KNOWN, a: { input_cost_per_token: -1, output_cost_per_token: 1 }, b: { input_cost_per_token: 5, output_cost_per_token: 5 }, c: { input_cost_per_token: "x" } }],
      ["prices changed implausibly", Object.fromEntries(Object.entries(KNOWN).map(([key, value]) => [key, { ...value, input_cost_per_token: value.input_cost_per_token * 0.002, output_cost_per_token: value.output_cost_per_token * 0.002 }]))],
      ["prices changed implausibly", Object.fromEntries(Object.entries(KNOWN).map(([key, value]) => [key, { ...value, input_cost_per_token: 0, output_cost_per_token: 0 }]))],
    ];
    for (const [reason, map] of bad) {
      const refreshed = scenario(map);
      expect(refreshed.refresh!.litellm, reason).toBe(reason);
      expect(refreshed.entries!["us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token, reason).toBe(3.3e-6);
      expect(refreshed.entries!["bedrock/us.anthropic.claude-sonnet-4-6"], reason).toBeNull();
    }
  });

  itPython("falls back when the source cannot be reached or answers something that is not JSON", () => {
    const refreshed = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [{ op: "refresh", sources: {}, inspect: ["us.anthropic.claude-sonnet-4-6"] }] })[0]!;
    expect(refreshed.refresh!.litellm).toBe("OSError");
    expect(refreshed.entries!["us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token).toBe(3.3e-6);
  });
});

describe("the guard's own file", () => {
  it("no longer refuses a model for lack of a price, and says so", () => {
    expect(ROVARA_GUARD_PY).not.toContain("model_not_priced");
    expect(ROVARA_GUARD_PY).toContain("CAUTION_FACTOR = 1.5");
  });
});
