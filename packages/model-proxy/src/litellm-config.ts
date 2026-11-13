/** The rates a model is billed at above one input-token count: every token of such a call is billed at these (LiteLLM's `*_above_<n>k_tokens` keys), in USD per token. */
export interface LitellmPriceTier {
  /** The input-token count above which the call is billed at this tier; a whole number of thousands. */
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * A model's prices written into its `model_info`, in USD per token: Rovara's small list of verified overrides for models LiteLLM's cost map (shipped in its image)
 * does not list yet (DECISIONS 172 (d)). A model with no price at all is not refused: the guard holds it at a cautious estimate. The task-budget guard reads these
 * as the deployment's own prices and holds the dearest rate any tier names, and LiteLLM bills the call from them.
 */
export interface LitellmModelPrices {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: readonly LitellmPriceTier[];
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Rovara's own verified override, not a company's price: the guard's daily refresh from AWS's price list replaces it (a company's own prices are never replaced). */
  override?: boolean;
}

export interface LitellmConfigInput {
  /** The AWS region Bedrock is called in. */
  region: string;
  /** Bedrock model ids exactly as Pi's amazon-bedrock catalog names them, for example us.anthropic.claude-sonnet-4-6. `prices` only for a model LiteLLM's cost map lacks. */
  models: ReadonlyArray<{ id: string; prices?: LitellmModelPrices }>;
}

/** Spike question 11: key revocation reaches the other replica in about this long; FINALIZE_DELAY_MS (120 s) is derived from it. */
export const USER_API_KEY_CACHE_TTL_SECONDS = 10;

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * A price as plain decimal text. Never exponent notation: PyYAML reads 1e-7 (no dot) as a string, and a string price would read as no price at all. Prices
 * are USD per token, so they carry up to ten decimals.
 */
function price(label: string, value: number): string {
  if (!Number.isFinite(value) || !(value > 0)) throw new Error(`${label} must be a positive number`);
  const text = value.toFixed(12).replace(/0+$/, "");
  if (Number(text) !== Number(value.toPrecision(10))) throw new Error(`${label} ${String(value)} does not fit twelve decimals`);
  return text.endsWith(".") ? `${text}0` : text;
}

function count(label: string, value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive whole number`);
  return String(value);
}

/** The `model_info` lines (LiteLLM's own key names) of one model's prices. */
function modelInfo(id: string, prices: LitellmModelPrices): string[] {
  const at = (name: string) => `${id} ${name}`;
  const lines = [
    `input_cost_per_token: ${price(at("input price"), prices.input)}`,
    `output_cost_per_token: ${price(at("output price"), prices.output)}`,
  ];
  if (prices.cacheRead !== undefined) lines.push(`cache_read_input_token_cost: ${price(at("cache read price"), prices.cacheRead)}`);
  if (prices.cacheWrite !== undefined) lines.push(`cache_creation_input_token_cost: ${price(at("cache write price"), prices.cacheWrite)}`);
  const seen = new Set<number>();
  for (const tier of prices.tiers ?? []) {
    if (!Number.isSafeInteger(tier.inputTokensAbove) || tier.inputTokensAbove <= 0 || tier.inputTokensAbove % 1000 !== 0) {
      throw new Error(`${id} tier threshold ${String(tier.inputTokensAbove)} must be a positive whole number of thousands of tokens`);
    }
    if (seen.has(tier.inputTokensAbove)) throw new Error(`${id} names the tier above ${String(tier.inputTokensAbove)} tokens twice`);
    seen.add(tier.inputTokensAbove);
    const above = `above_${String(tier.inputTokensAbove / 1000)}k_tokens`;
    lines.push(`input_cost_per_token_${above}: ${price(at(`${above} input price`), tier.input)}`);
    lines.push(`output_cost_per_token_${above}: ${price(at(`${above} output price`), tier.output)}`);
    if (tier.cacheRead !== undefined) lines.push(`cache_read_input_token_cost_${above}: ${price(at(`${above} cache read price`), tier.cacheRead)}`);
    if (tier.cacheWrite !== undefined) lines.push(`cache_creation_input_token_cost_${above}: ${price(at(`${above} cache write price`), tier.cacheWrite)}`);
  }
  if (prices.maxInputTokens !== undefined) lines.push(`max_input_tokens: ${count(at("input limit"), prices.maxInputTokens)}`);
  if (prices.maxOutputTokens !== undefined) lines.push(`max_output_tokens: ${count(at("output limit"), prices.maxOutputTokens)}`);
  if (prices.override === true) lines.push("rovara_price_override: true");
  return lines.map((line) => `      ${line}`);
}

/** A double-quoted YAML scalar. JSON strings are valid YAML, so ids with a colon (v1:0) stay text. */
const quoted = (value: string) => JSON.stringify(value);

/**
 * The LiteLLM proxy config for Claude on Amazon Bedrock (ruling R21). Pi sends its own catalog id as
 * the request model, so each `model_name` is the id itself, and `litellm_params.model` is that same id
 * behind the `bedrock/` provider prefix. Credentials are never in the file: Bedrock is reached with the
 * task role, and the master key and database URL are read from the environment at start. A model with `prices` also carries them as its `model_info`, for a model
 * LiteLLM's own cost map does not list (see LitellmModelPrices).
 */
export function litellmConfig(input: LitellmConfigInput): string {
  if (input.models.length === 0) throw new Error("the proxy needs at least one model");
  if (input.region === "") throw new Error("the proxy needs an AWS region");
  const seen = new Set<string>();
  const entries = input.models.map(({ id, prices }) => {
    if (!SAFE_MODEL_ID.test(id)) throw new Error(`model id ${JSON.stringify(id)} is not a plain Bedrock model id`);
    if (seen.has(id)) throw new Error(`model id ${id} is listed twice`);
    seen.add(id);
    return [
      `  - model_name: ${quoted(id)}`,
      "    litellm_params:",
      `      model: ${quoted(`bedrock/${id}`)}`,
      `      aws_region_name: ${quoted(input.region)}`,
      ...(prices === undefined ? [] : ["    model_info:", ...modelInfo(id, prices)]),
    ].join("\n");
  });
  return [
    "model_list:",
    ...entries,
    // rovara_guard.py sits beside this file (the stack writes it at start); it allow-lists request fields and stops redirects.
    "litellm_settings:",
    "  callbacks: rovara_guard.proxy_handler_instance",
    "general_settings:",
    "  master_key: os.environ/LITELLM_MASTER_KEY",
    "  database_url: os.environ/DATABASE_URL",
    // A revoked key stops working on every replica within this many seconds (the stock default is 60).
    `  user_api_key_cache_ttl: ${String(USER_API_KEY_CACHE_TTL_SECONDS)}`,
    // The guard holds every call's worst case in a ledger all replicas share (rovara_guard.py, section 4). LiteLLM's own optimistic reservation is
    // per process here (there is no Redis), so it does not bound two replicas, and it refuses a call that only other calls' holds block with a 422
    // budget_exceeded, which the worker reads as a spent budget and ends the task on. Its read-time check (spend over max_budget) still runs.
    "  disable_budget_reservation: true",
    // LiteLLM's router retries a failed call itself (twice by default) under the same call id, after the guard's hold was taken once: a retry would
    // run beside a hold sized for one attempt. Off: Pi and the provider SDKs retry, and each of their retries takes its own hold.
    "router_settings:",
    "  num_retries: 0",
    "",
  ].join("\n");
}
