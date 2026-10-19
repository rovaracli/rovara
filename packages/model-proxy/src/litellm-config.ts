export interface LitellmConfigInput {
  /** The AWS region Bedrock is called in. */
  region: string;
  /** Bedrock model ids exactly as Pi's amazon-bedrock catalog names them, for example us.anthropic.claude-sonnet-4-6. */
  models: ReadonlyArray<{ id: string }>;
}

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** A double-quoted YAML scalar. JSON strings are valid YAML, so ids with a colon (v1:0) stay text. */
const quoted = (value: string) => JSON.stringify(value);

/**
 * The LiteLLM proxy config for Claude on Amazon Bedrock (ruling R21). Pi sends its own catalog id as
 * the request model, so each `model_name` is the id itself, and `litellm_params.model` is that same id
 * behind the `bedrock/` provider prefix. Credentials are never in the file: Bedrock is reached with the
 * task role, and the master key and database URL are read from the environment at start.
 */
export function litellmConfig(input: LitellmConfigInput): string {
  if (input.models.length === 0) throw new Error("the proxy needs at least one model");
  if (input.region === "") throw new Error("the proxy needs an AWS region");
  const seen = new Set<string>();
  const entries = input.models.map(({ id }) => {
    if (!SAFE_MODEL_ID.test(id)) throw new Error(`model id ${JSON.stringify(id)} is not a plain Bedrock model id`);
    if (seen.has(id)) throw new Error(`model id ${id} is listed twice`);
    seen.add(id);
    return [
      `  - model_name: ${quoted(id)}`,
      "    litellm_params:",
      `      model: ${quoted(`bedrock/${id}`)}`,
      `      aws_region_name: ${quoted(input.region)}`,
    ].join("\n");
  });
  return [
    "model_list:",
    ...entries,
    "general_settings:",
    "  master_key: os.environ/LITELLM_MASTER_KEY",
    "  database_url: os.environ/DATABASE_URL",
    "",
  ].join("\n");
}
