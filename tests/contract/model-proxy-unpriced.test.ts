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
    def __init__(self): self.rows, self.holds, self.settled, self.worsts, self.months, self.gates = {}, {}, [], {}, {}, {}
    async def take(self, key, call_id, worst, spent, cap, estimated=False, month_gate=None):
        row = self.rows.setdefault(key, {"charged": 0, "held": 0})
        known = max(row["charged"], spent)
        self.worsts[call_id] = worst
        self.gates[call_id] = bool(month_gate)
        mrow, in_month = None, True
        if month_gate:
            org, month, month_limit, month_spent = month_gate
            mrow = self.months.setdefault((org, month), {"held": 0, "charged": 0, "over": False})
            used = max(mrow["charged"], month_spent) + mrow["held"]
            in_month = not estimated or used + worst <= month_limit
            if estimated and used >= month_limit: return "month", row["charged"]
        if known + row["held"] + worst <= cap: reserve = worst
        elif estimated and known < cap and row["held"] == 0: reserve = min(worst, max(cap - known, 0))
        else: return ("exceeded" if known + worst > cap else "held"), row["charged"]
        if mrow is not None:
            if not in_month and mrow["over"]: return "slot", max(month_limit - used, 0)
            mrow["held"] += worst
            if not in_month: mrow["over"] = True
        row["held"] += reserve; self.holds[call_id] = (key, reserve, worst, (month_gate[0], month_gate[1]) if month_gate else None); return "ok", None
    async def settle(self, call_id, cost, estimated=False):
        key, reserved, worst, month_key = self.holds.pop(call_id)
        charge = reserved if cost is None else cost
        row = self.rows[key]; row["held"] -= reserved; row["charged"] += charge
        if month_key: self.months[month_key]["held"] -= worst; self.months[month_key]["charged"] += charge
        self.settled.append({"micros": charge, "estimated": bool(estimated), "whole_hold": cost is None})
ledger = ns["_LEDGER"] = Ledger()
guard = ns["RovaraGuard"]()

class Key:
    def __init__(self, cap, token="k1", team=None):
        self.max_budget, self.spend, self.token = cap, 0.0, token
        if team: self.team_id, self.team_max_budget, self.team_spend = team["id"], team["cap"], team["spend"]

async def fetch_for(sources):
    def fetch(url, host):
        if host not in sources: raise OSError("unreachable " + host)
        return json.loads(json.dumps(sources[host]))
    return fetch

async def run(step, n):
    if step["op"] == "redirect":
        try: ns["_NoRedirect"]().redirect_request(None, None, 302, "Found", {}, "https://elsewhere.example/x"); return {"refused": False}
        except Exception as e: return {"refused": True, "error": type(e).__name__}
    if step["op"] == "fetch":
        import time as _t
        class Reply:
            def __init__(self): self.left = step.get("body", "{}").encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def geturl(self): return step.get("final_url", step["url"])
            def read(self, n=-1):
                if step.get("delay"): _t.sleep(step["delay"])
                chunk, self.left = self.left[:n], self.left[n:]
                return chunk
        class Opener:
            def open(self, request, timeout=None): return Reply()
        for name, value in step.get("limits", {}).items(): ns[name] = value
        try: return {"fetched": ns["_fetch_json"](step["url"], step["host"], opener=Opener())}
        except Exception as e: return {"error": type(e).__name__, "detail": str(e)}
    if step["op"] == "refresh":
        result = await ns["_refresh_prices"](await fetch_for(step["sources"]))
        return {"refresh": result, "entries": {k: litellm.model_cost.get(k) for k in step.get("inspect", [])}}
    data = {"model": step["model"], "messages": [{"role": "user", "content": "hi"}], "stream": False, "litellm_call_id": "call-%d" % n}
    if step.get("max_tokens") is not None: data["max_tokens"] = step["max_tokens"]
    before = len(ledger.settled)
    try:
        await guard.async_pre_call_hook(Key(step.get("cap", 100.0), step.get("token", "k1"), step.get("team")), None, data, "acompletion")
    except ProxyException as e:
        return {"status": int(e.code), "type": e.type, **({"message": e.message, "headers": e.headers} if step.get("want_message") else {})}
    out = {"status": 200, "held": ledger.worsts["call-%d" % n], "reserved": ledger.holds["call-%d" % n][1], "prices": list(ns["_hold_prices"](step["model"]))[1:], "gate": ledger.gates["call-%d" % n]}
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
type Result = { gate?: boolean; headers?: Record<string, string>; message?: string; refused?: boolean; error?: string; detail?: string; fetched?: unknown; status?: number; type?: string; held?: number; reserved?: number; prices?: boolean[]; settled?: { micros: number; estimated: boolean; whole_hold: boolean } | null; refresh?: Record<string, string>; entries?: Record<string, Record<string, number> | null> };

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

  itPython("charges cached tokens once, at the input rate, whichever way the usage counts them: inside prompt_tokens (LiteLLM's own usage on the OpenAI, Anthropic and Bedrock routes) or beside input_tokens (Anthropic's)", () => {
    const usages = [
      { prompt_tokens: 1600, completion_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 },     // LiteLLM's usage on the Anthropic and Bedrock routes
      { prompt_tokens: 1600, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 1000 } },                      // OpenAI's
      { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 },           // Anthropic's own
    ];
    const calls = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: usages.map((usage) => ({ op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000, cost: null, usage })) });
    for (const call of calls) {
      // 1,600 input tokens x $11 per million + 10 x $41.25 per million = $0.0180125: the cached ones are charged, and only once.
      expect(call.settled).toMatchObject({ estimated: true, whole_hold: false });
      expect(call.settled!.micros).toBeGreaterThanOrEqual(18_012);
      expect(call.settled!.micros).toBeLessThanOrEqual(18_014);
    }
  });

  itPython("charges the whole hold, flagged estimated, when the provider reports usage of all zeros and LiteLLM has no cost, not $0", () => {
    const calls = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [
      { op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000, cost: null, usage: { prompt_tokens: 0, completion_tokens: 0 } },
      { op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000, cost: 0, usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0 } },
    ] });
    for (const call of calls) expect(call.settled).toEqual({ micros: call.held, estimated: true, whole_hold: true });
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

  itPython("registers a validated map: a price that was raised, a model the image's map lacks, and the router's copy for a deployment", () => {
    const fresh = scenario(upstream({ "us.anthropic.claude-sonnet-4-6": { ...KNOWN["us.anthropic.claude-sonnet-4-6"], input_cost_per_token: 4.4e-6 }, "us.anthropic.claude-haiku-9": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 7e-7, output_cost_per_token: 3e-6 } }));
    expect(fresh.refresh!.litellm).toBe("ok");
    expect(fresh.entries!["us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token).toBe(4.4e-6);
    expect(fresh.entries!["bedrock/us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token).toBe(4.4e-6);
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

  const filler = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`filler-${String(i)}`, { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }]));
  const withFiller = { ...KNOWN, ...filler };

  itPython("only fills a missing price or raises one: an upstream map that lowers a served model's price, or any other model's, changes nothing; a price it raises on one rate keeps the other", () => {
    const sonnet = KNOWN["us.anthropic.claude-sonnet-4-6"];
    const [fresh] = run({ deployments: [deployment("us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6"), deployment("gpt-5-pro", "gpt-5-pro")], model_cost: withFiller, steps: [
      { op: "refresh", sources: { [GITHUB]: { ...withFiller,
        "us.anthropic.claude-sonnet-4-6": { ...sonnet, input_cost_per_token: 3.9e-6, output_cost_per_token: 1e-5 },     // input raised, output lowered
        "gpt-5-pro": { ...KNOWN["gpt-5-pro"], input_cost_per_token: 1.5e-6, output_cost_per_token: 1.2e-5 },            // lowered ten-fold
        "us.anthropic.claude-opus-4-8": { ...KNOWN["us.anthropic.claude-opus-4-8"], input_cost_per_token: 5.5e-7, output_cost_per_token: 2.75e-6 },
      } }, inspect: ["us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6", "gpt-5-pro", "us.anthropic.claude-opus-4-8"] },
    ] });
    expect(fresh!.refresh!.litellm).toBe("ok");
    for (const key of ["us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6"]) {
      expect(fresh!.entries![key]?.input_cost_per_token ?? 3.9e-6, key).toBe(3.9e-6);
      expect(fresh!.entries![key]?.output_cost_per_token ?? 1.65e-5, key).toBe(1.65e-5);
    }
    expect(fresh!.entries!["gpt-5-pro"]).toMatchObject({ input_cost_per_token: 1.5e-5, output_cost_per_token: 1.2e-4 });
    expect(fresh!.entries!["us.anthropic.claude-opus-4-8"]).toMatchObject({ input_cost_per_token: 5.5e-6, output_cost_per_token: 2.75e-5 });
  });

  itPython("replaces the guard's own estimate with a real upstream price, however much lower: the model is then priced at it, no longer estimated, with none of the estimate's cache rates left", () => {
    const upstreamPrice = { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2e-7, output_cost_per_token: 8e-7 };
    const [estimated, refreshed, priced] = run({ deployments: [NEW_OPENAI], model_cost: withFiller, steps: [
      { op: "call", model: "gpt-new", max_tokens: 1000 },
      { op: "refresh", sources: { [GITHUB]: { ...withFiller, "gpt-new": upstreamPrice } }, inspect: ["gpt-new", "openai/gpt-new"] },
      { op: "call", model: "gpt-new", max_tokens: 1000 },
    ] });
    expect(estimated).toMatchObject({ status: 200, prices: [true] });
    expect(refreshed!.refresh!.litellm).toBe("ok");
    for (const key of ["gpt-new", "openai/gpt-new"]) {
      expect(refreshed!.entries![key], key).toMatchObject({ input_cost_per_token: 2e-7, output_cost_per_token: 8e-7 });
      expect(Object.keys(refreshed!.entries![key]!), key).not.toContain("cache_read_input_token_cost");
    }
    expect(priced).toMatchObject({ status: 200, prices: [false] });
    expect(priced!.held).toBeLessThan(2_000);                      // 1,000 tokens at $0.80 per million, not at the estimate's $180
  });

  itPython("rejects an upstream price of zero for a served model: its entry is not registered, and the model stays held at an estimate", () => {
    const zero = { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 0, output_cost_per_token: 0 };
    const [fresh, call] = run({ deployments: [NEW_CLAUDE, deployment("us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-sonnet-4-6")], model_cost: withFiller, steps: [
      { op: "refresh", sources: { [GITHUB]: { ...withFiller, "us.anthropic.claude-haiku-9": zero, "us.anthropic.claude-sonnet-4-6": { ...KNOWN["us.anthropic.claude-sonnet-4-6"], input_cost_per_token: 0, output_cost_per_token: 1.65e-5 } } }, inspect: ["us.anthropic.claude-haiku-9", "us.anthropic.claude-sonnet-4-6", "bedrock/us.anthropic.claude-haiku-9"] },
      { op: "call", model: "us.anthropic.claude-haiku-9", max_tokens: 1000 },
    ] });
    expect(fresh!.refresh!.litellm).toBe("ok");
    expect(fresh!.entries!["us.anthropic.claude-haiku-9"]).toBeNull();
    expect(fresh!.entries!["bedrock/us.anthropic.claude-haiku-9"]?.input_cost_per_token ?? 1.1e-5).toBeGreaterThan(0);
    expect(fresh!.entries!["us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token).toBe(3.3e-6);
    expect(call).toMatchObject({ status: 200, prices: [true] });
  });

  itPython("never overwrites Rovara's verified override from the upstream map, whether the upstream price is lower or higher", () => {
    const override = deployment("us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-haiku-5-5", { input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7, rovara_price_override: true, id: "dep-haiku" });
    const model_cost = { ...withFiller, "dep-haiku": { input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7 } };
    const haiku = (input: number, output: number) => ({ ...withFiller, "us.anthropic.claude-haiku-5-5": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: input, output_cost_per_token: output } });
    const [lower, higher] = run({ deployments: [override], model_cost, steps: [
      { op: "refresh", sources: { [GITHUB]: haiku(2e-8, 1e-7) }, inspect: ["dep-haiku", "us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-haiku-5-5"] },
      { op: "refresh", sources: { [GITHUB]: haiku(9e-7, 4e-6) }, inspect: ["dep-haiku", "us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-haiku-5-5"] },
    ] });
    for (const step of [lower!, higher!]) {
      expect(step.refresh!.litellm).toBe("ok");
      expect(step.entries!["dep-haiku"]).toMatchObject({ input_cost_per_token: 1.1e-7, output_cost_per_token: 5.5e-7 });
      for (const key of ["us.anthropic.claude-haiku-5-5", "bedrock/us.anthropic.claude-haiku-5-5"]) expect(step.entries![key]?.input_cost_per_token ?? 1.1e-7, key).toBe(1.1e-7);
    }
  });

  itPython("falls back when the source cannot be reached or answers something that is not JSON", () => {
    const refreshed = run({ deployments: [NEW_CLAUDE], model_cost: KNOWN, steps: [{ op: "refresh", sources: {}, inspect: ["us.anthropic.claude-sonnet-4-6"] }] })[0]!;
    expect(refreshed.refresh!.litellm).toBe("OSError");
    expect(refreshed.entries!["us.anthropic.claude-sonnet-4-6"]!.input_cost_per_token).toBe(3.3e-6);
  });
});

describe("the company's month (DECISIONS 180)", () => {
  const team = (spend: number, cap = 1000) => ({ id: "org-1", cap, spend });
  const small = (step: Step): Step => ({ op: "call", model: "mystery", cap: 0.01, want_message: true, ...step });
  const mystery = [deployment("mystery", "mystery")];
  const CHEAP = { cost: 0.001, usage: { prompt_tokens: 10, completion_tokens: 10 } };      // the call that took the slot is over and cost little: the month has room again, but no slot

  itPython("lets one estimated call from the company's keys pass the month's cap; the next, from another key, is refused like an overrun of its key, with the output limit the month's room pays for", () => {
    // The month has $5 and nothing spent; the call's worst case (about $11.5) could pass it: the first call takes the month's one slot, and costs $0.001.
    const calls = run({ deployments: mystery, model_cost: KNOWN, steps: [small({ token: "k1", team: team(0, 5), ...CHEAP }), small({ token: "k2", team: team(0, 5) })] });
    expect(calls[0]).toMatchObject({ status: 200, gate: true });
    expect(calls[1]).toMatchObject({ status: 422, type: "budget_max_tokens" });
    expect(Number(calls[1]!.headers!["x-rovara-max-tokens"])).toBeGreaterThanOrEqual(4096);
    expect(calls[1]!.message).not.toContain("Team=");
  });

  itPython("says the company's month is spent (Team=) only when it is at its cap; with a slot taken and almost no room left it is the plain budget_exceeded of the key", () => {
    const [blocked] = run({ deployments: mystery, model_cost: KNOWN, steps: [small({ team: team(1, 1) })] });
    expect(blocked).toMatchObject({ status: 422, type: "budget_exceeded" });
    expect(blocked!.message).toMatch(/^Budget has been exceeded! Team=org-1 /u);
    const [first, second] = run({ deployments: mystery, model_cost: KNOWN, steps: [small({ token: "k1", team: team(0.5, 1), ...CHEAP }), small({ token: "k2", team: team(0.5, 1) })] });
    expect(first).toMatchObject({ status: 200 });
    expect(second).toMatchObject({ status: 422, type: "budget_exceeded" });
    expect(second!.message).toMatch(/^Budget has been exceeded! Key=/u);
  });

  itPython("takes no slot for calls whose worst cases together fit the month, and a key with no company month keeps the one-call rule of DECISIONS 165", () => {
    const calls = run({ deployments: mystery, model_cost: KNOWN, steps: [
      small({ token: "k1", team: team(0, 100_000) }), small({ token: "k2", team: team(0, 100_000) }), small({ token: "k3" }),
    ] });
    expect(calls.map((call) => call.status)).toEqual([200, 200, 200]);
    expect(calls.map((call) => call.gate)).toEqual([true, true, false]);
  });

  itPython("counts the held worst case of calls in flight against the month: four estimated calls on a month with room for two get two", () => {
    // Each call's worst case is about $11.5; the month has $30 and nothing spent: two fit (23), the third could pass the month and takes its one slot, the fourth is refused.
    const calls = run({ deployments: mystery, model_cost: KNOWN, steps: [1, 2, 3, 4].map((n) => small({ token: `k${String(n)}`, team: team(0, 30) })) });
    expect(calls.map((call) => call.status)).toEqual([200, 200, 200, 422]);
  });
});

describe("fetching a price file", () => {
  const fetchStep = (extra: Step = {}): Step => ({ op: "fetch", url: "https://raw.githubusercontent.com/BerriAI/litellm/main/x.json", host: "raw.githubusercontent.com", body: "{\"a\": 1}", ...extra });
  const one = (step: Step) => run({ deployments: [], model_cost: {}, steps: [step] })[0]!;

  itPython("reads a price file from the fixed host", () => {
    expect(one(fetchStep())).toEqual({ fetched: { a: 1 } });
  });

  itPython("refuses a redirect, and a reply whose final address is not the fixed https host", () => {
    expect(one({ op: "redirect" })).toMatchObject({ refused: true });
    expect(one(fetchStep({ final_url: "https://elsewhere.example/x.json" }))).toMatchObject({ error: "ValueError" });
    expect(one(fetchStep({ final_url: "http://raw.githubusercontent.com/x.json" }))).toMatchObject({ error: "ValueError" });
  });

  itPython("stops a reply that is still coming after the total deadline, and a LiteLLM map over its own smaller size cap", () => {
    expect(one(fetchStep({ delay: 0.06, body: "{\"a\": \"" + "x".repeat(200_000) + "\"}", limits: { PRICE_FETCH_DEADLINE_SECONDS: 0.1 } }))).toMatchObject({ error: "ValueError", detail: expect.stringContaining("deadline") as string });
    expect(one(fetchStep({ body: "{\"a\": \"" + "x".repeat(2_000) + "\"}", limits: { LITELLM_MAP_MAX_BYTES: 1_000 } }))).toMatchObject({ error: "ValueError", detail: expect.stringContaining("too large") as string });
    // The size cap is the LiteLLM map's own: the same body from the price list's host is read (its cap is the larger PRICE_FILE_MAX_BYTES).
    expect(one(fetchStep({ url: "https://pricing.us-east-1.amazonaws.com/x.json", host: "pricing.us-east-1.amazonaws.com", final_url: "https://pricing.us-east-1.amazonaws.com/x.json", body: "{\"a\": \"" + "x".repeat(2_000) + "\"}", limits: { LITELLM_MAP_MAX_BYTES: 1_000 } }))).toMatchObject({ fetched: { a: expect.any(String) as string } });
  });
});

describe("the guard's own file", () => {
  it("no longer refuses a model for lack of a price, and says so", () => {
    expect(ROVARA_GUARD_PY).not.toContain("model_not_priced");
    expect(ROVARA_GUARD_PY).toContain("CAUTION_FACTOR = 1.5");
  });
});
