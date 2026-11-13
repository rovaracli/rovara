// DECISIONS 172 against the REAL pinned LiteLLM image: the guard's price refresh and cautious estimate drive what LiteLLM itself settles. A mock provider answer (reported usage) goes through
// LiteLLM's router with the guard as a callback; the ledger is in memory. Checks: a model nobody priced settles at the dearest known rate of its family, flagged estimated, not at LiteLLM's $0;
// after a refresh from an AWS price-list fixture Haiku 5.5 and Fable 5.2 settle at AWS's prices, Haiku 5.5's long-context tier above 100,000 prompt tokens; the stack's own override list prices
// them before any refresh, and AWS's list replaces it. Runs only where Docker answers and the pinned image is already present (it never pulls, no network is given to the container), so CI
// skips it; run it after a LiteLLM bump.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LITELLM_SOURCE_IMAGE } from "../../infra/lib/bundle-images.js";
import { litellmConfig } from "../../packages/model-proxy/src/litellm-config.js";
import { ROVARA_GUARD_PY } from "../../packages/model-proxy/src/rovara-guard.js";
import { bedrockProxyModels } from "../../packages/model-runtime/src/catalog.js";
import { AWS_HAIKU_FABLE_OFFER, awsPriceOffer } from "../support/aws-price-offer.js";

const usable = spawnSync("docker", ["image", "inspect", LITELLM_SOURCE_IMAGE], { stdio: "ignore" }).status === 0;

const DRIVER = String.raw`
import asyncio, json, os, sys
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"; os.environ["ROVARA_PRICE_REFRESH"] = "0"
scenario = json.load(sys.stdin)
open("/tmp/rovara_guard.py", "w").write(scenario["guard"]); sys.path.insert(0, "/tmp")
import yaml, litellm
from litellm import Router
from litellm.types.utils import ModelResponse, Usage, Choices, Message
import litellm.proxy.proxy_server as server
server.llm_router = Router(model_list=yaml.safe_load(scenario["config"])["model_list"], num_retries=0)
import rovara_guard as g
class Ledger:
    def __init__(self): self.settled = []
    async def take(self, key, call_id, worst, spent, cap): return "ok", None
    async def settle(self, call_id, cost, estimated=False): self.settled.append((cost, estimated))
g._LEDGER = Ledger()
litellm.callbacks = [g.proxy_handler_instance]
class Key:
    max_budget, spend, token = 100.0, 0.0, "k1"
async def call(model, prompt, completion):
    n = len(g._LEDGER.settled)
    data = {"model": model, "messages": [{"role": "user", "content": "hi"}], "stream": False, "max_tokens": 1000, "litellm_call_id": "c-%d" % id(object())}
    await g.proxy_handler_instance.async_pre_call_hook(Key(), None, data, "acompletion")
    mock = ModelResponse(choices=[Choices(message=Message(content="ok"), finish_reason="stop", index=0)], model="m", usage=Usage(prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion))
    await server.llm_router.acompletion(model=model, messages=data["messages"], mock_response=mock, litellm_call_id=data["litellm_call_id"])
    for _ in range(50):
        if len(g._LEDGER.settled) > n: break
        await asyncio.sleep(0.1)
    cost, estimated = g._LEDGER.settled[n]
    return {"micros": cost, "estimated": estimated, "held_estimated": g._hold_prices(model)[1]}
async def fetch_for(sources):
    def fetch(url, host):
        if host not in sources: raise OSError("unreachable " + host)
        return sources[host]
    return fetch
async def main():
    out = []
    for step in scenario["steps"]:
        if step["op"] == "refresh": out.append({"refresh": await g._refresh_prices(await fetch_for(step["sources"]))})
        else: out.append(await call(step["model"], step["prompt"], step["completion"]))
    out.append({"dearest": list(g._dearest_known(scenario.get("family", "openai/x")))})
    return out
print("RESULT " + json.dumps(asyncio.run(main())))
`;

type Out = { micros?: number; estimated?: boolean; held_estimated?: boolean; refresh?: Record<string, string>; dearest?: number[] };

function inImage(scenario: unknown): Out[] {
  const run = spawnSync("docker", ["run", "--rm", "-i", "--network", "none", "--entrypoint", "python", LITELLM_SOURCE_IMAGE, "-c", DRIVER], { input: JSON.stringify({ guard: ROVARA_GUARD_PY, ...(scenario as object) }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  expect(run.status, run.stderr.slice(-3000)).toBe(0);
  return JSON.parse(run.stdout.split("\n").find((line) => line.startsWith("RESULT "))!.slice(7)) as Out[];
}

const aws = "pricing.us-east-1.amazonaws.com";
const bare = (id: string) => ({ model_name: id, litellm_params: { model: `bedrock/${id}`, aws_region_name: "us-west-2" } });

describe.skipIf(!usable)("the guard's prices against the pinned LiteLLM (docker)", () => {
  it("settles a model nobody priced at the family's dearest known rate, flagged estimated, where LiteLLM alone settles it at $0; then at AWS's prices after a refresh, long-context tier included", () => {
    const config = `model_list:\n${[bare("us.anthropic.claude-haiku-5-5"), bare("us.anthropic.claude-fable-5-2")].map((m) => `  - model_name: ${m.model_name}\n    litellm_params: {model: ${m.litellm_params.model}, aws_region_name: us-west-2}`).join("\n")}\n`;
    const out = inImage({ config, family: "bedrock/us.anthropic.claude-x", steps: [
      { op: "call", model: "us.anthropic.claude-haiku-5-5", prompt: 1000, completion: 1000 },
      { op: "refresh", sources: { [aws]: AWS_HAIKU_FABLE_OFFER } },
      { op: "call", model: "us.anthropic.claude-haiku-5-5", prompt: 1000, completion: 1000 },
      { op: "call", model: "us.anthropic.claude-haiku-5-5", prompt: 100_000, completion: 1000 },
      { op: "call", model: "us.anthropic.claude-haiku-5-5", prompt: 150_000, completion: 2000 },
      { op: "call", model: "us.anthropic.claude-fable-5-2", prompt: 10_000, completion: 500 },
    ] });
    const [rateIn, rateOut] = out[out.length - 1]!.dearest!;
    // Before any price: 1,000 + 1,000 tokens at the dearest Claude rate in LiteLLM's bundled map, flagged estimated, never $0.
    expect(out[0]).toMatchObject({ estimated: true, held_estimated: true });
    expect(out[0]!.micros).toBe(Math.ceil((1000 * rateIn! + 1000 * rateOut!) * 1e6 - 1e-6));
    expect(out[0]!.micros!).toBeGreaterThan(0);
    expect(out[1]!.refresh).toMatchObject({ aws: "ok" });
    // After AWS's list: $0.11 in and $0.55 out per million; five times that above 100,000 prompt tokens; Fable 5.2 $8.80 in and $44 out.
    expect(out[2]).toMatchObject({ micros: 660, estimated: false, held_estimated: false });
    expect(out[3]).toMatchObject({ micros: 11_550, estimated: false });
    expect(out[4]).toMatchObject({ micros: 88_000, estimated: false });          // 150,000 x $0.55 + 2,000 x $2.75 per million = $0.0825 + $0.0055
    expect(out[5]).toMatchObject({ micros: 110_000, estimated: false });         // 10,000 x $8.80 + 500 x $44 per million = $0.088 + $0.022
  });

  it("prices Haiku 5.5 and Fable 5.2 from the stack's own override list before any refresh, and takes AWS's newer price over it", () => {
    const config = litellmConfig({ region: "us-west-2", models: bedrockProxyModels("us") });
    const cheaper = awsPriceOffer([["Claude Haiku 5.5", "input_tokens_standard", 0.05], ["Claude Haiku 5.5", "output_tokens_standard", 0.25]]);
    const out = inImage({ config, steps: [
      { op: "call", model: "us.anthropic.claude-haiku-5-5", prompt: 1000, completion: 1000 },
      { op: "call", model: "us.anthropic.claude-haiku-5-5", prompt: 150_000, completion: 2000 },
      { op: "call", model: "us.anthropic.claude-fable-5-2", prompt: 10_000, completion: 500 },
      { op: "refresh", sources: { [aws]: cheaper } },
      { op: "call", model: "us.anthropic.claude-haiku-5-5", prompt: 1000, completion: 1000 },
    ] });
    expect(out[0]).toMatchObject({ micros: 660, estimated: false, held_estimated: false });
    expect(out[1]).toMatchObject({ micros: 88_000, estimated: false });
    expect(out[2]).toMatchObject({ micros: 110_000, estimated: false });
    expect(out[3]!.refresh).toMatchObject({ aws: "ok" });
    expect(out[4]).toMatchObject({ micros: 300, estimated: false });             // 1,000 x $0.05 + 1,000 x $0.25 per million
  });
});
