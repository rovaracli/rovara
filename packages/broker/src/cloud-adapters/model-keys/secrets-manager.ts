// Convergence lane A3 (Cloud adapter, private): Code's `model-keys` port (`ModelKeyStore`) over the keys this install already holds, so no key moves.
//
// What Cloud holds today, and what this reads:
//   - The install's keyed providers (OpenRouter, Anthropic, OpenAI): one Secrets Manager secret each holding the raw API key, named by ARN in the stack parameter
//     `<Provider>SecretArn` and handed to the process as `AGENTX_<PROVIDER>_SECRET_ARN` (`KEYED_MODEL_PROVIDERS`, infra/lib/model-keys.ts). The secret may be encrypted with a customer KMS key;
//     a key policy that does not let this role decrypt is reported as such (a fixed sentence), never as "no key".
//   - A company's OWN keys (its AI sources) are NOT here: they go to the model proxy's credential store (`ModelAccess.upsertSource`) and never come back out, so the proxy is the only holder.
//     The `model-provider` adapters for the proxy (litellm.ts) sign with a short-lived proxy key instead.
// So `get(company, provider)` is the install's key for every company (the install pays, as today), and a company with its own source is served through the proxy, not this store.
//
// WHO MAY HOLD THIS: the broker and the model proxy. What holds today: this model key store is never imported by worker code (tests/unit/cloud-adapters-models.test.ts checks it).
// It does NOT mean no worker ever sees an install key secret: older direct-key paths outside this store still hand a secret ARN to some runs (session-steps.ts, runtime-requalify-steps.ts,
// swebench-settings.ts, and the worker's e2e model check via e2eAgentInstallationFromEnvironment); they are tracked as A3-OLD-DIRECT-KEY-PATHS and not changed here.
//
// Rules kept: a key is a `SecretValue` (prints as `[secret]`); a value, a secret ARN and Secrets Manager's own words never reach an error or a log; a provider id that is not a plain id is
// "no key" with no call made; the company id is checked (`org_` + 20) before anything is read.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { KEYED_MODEL_PROVIDERS, KEYED_PROVIDER_IDS, OrgIdSchema, SecretValue, type ModelKeyStore } from "@rovara-code/contracts";

const PROVIDER = /^[a-z][a-z0-9-]{0,63}$/u;
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/u;

export interface ModelKeySecretsClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined; SecretBinary?: Uint8Array | undefined }>;
}

/** A refusal this store can say out loud: a fixed sentence, no ARN, no value. */
export class CloudModelKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudModelKeyError";
  }
}

export interface CloudModelKeyStoreOptions {
  secrets: ModelKeySecretsClient;
  /** Provider id to the ARN of the secret holding its raw key. `installModelKeyArns(process.env)` reads them the way the stacks hand them over. */
  installKeys: Readonly<Record<string, string>>;
  /** How long a read key is kept in memory. Default 0: read on every call, so a rotation takes effect at once. A failed read is never kept. */
  cacheMs?: number;
  now?: () => number;
}

/** The ARNs the stacks give this process (`AGENTX_OPENROUTER_SECRET_ARN` and the others). An empty, `none` or malformed value is no key. */
export function installModelKeyArns(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const arns: Record<string, string> = {};
  for (const provider of KEYED_PROVIDER_IDS) {
    const value = environment[KEYED_MODEL_PROVIDERS[provider].secretArnVariable]?.trim();
    if (value !== undefined && SECRET_ARN.test(value)) arns[provider] = value;
  }
  return arns;
}

export function createCloudModelKeyStore(options: CloudModelKeyStoreOptions): ModelKeyStore {
  for (const [provider, arn] of Object.entries(options.installKeys)) {
    if (!PROVIDER.test(provider) || !SECRET_ARN.test(arn)) throw new CloudModelKeyError("an install model key is a provider id and the ARN of a Secrets Manager secret");
  }
  const cacheMs = options.cacheMs ?? 0;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: SecretValue | undefined; until: number }>();

  async function read(provider: string): Promise<SecretValue | undefined> {
    const arn = Object.hasOwn(options.installKeys, provider) ? options.installKeys[provider] : undefined;
    if (arn === undefined) return undefined;
    const kept = cache.get(provider);
    if (kept !== undefined && kept.until > now()) return kept.value;
    let found: { SecretString?: string | undefined; SecretBinary?: Uint8Array | undefined };
    try {
      found = await options.secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "ResourceNotFoundException" || name === "InvalidRequestException") return undefined;
      if (name === "AccessDeniedException") throw new CloudModelKeyError(`the ${provider} key's secret may not be read by this role`);
      if (name === "DecryptionFailure") throw new CloudModelKeyError(`the ${provider} key's secret could not be decrypted (check its KMS key policy)`);
      throw new CloudModelKeyError(`the ${provider} key could not be read right now`);
    }
    const text = found.SecretString?.trim();
    if (text === undefined && found.SecretBinary !== undefined) throw new CloudModelKeyError(`the ${provider} key's secret is not a plain key`);
    const value = text === undefined || text === "" ? undefined : new SecretValue(text);
    if (cacheMs > 0) cache.set(provider, { value, until: now() + cacheMs });
    return value;
  }

  return {
    async get(companyId, provider) {
      if (!OrgIdSchema.safeParse(companyId).success) throw new CloudModelKeyError("a model key is read for a company id");
      if (!PROVIDER.test(provider)) return undefined;
      return read(provider);
    },
    async providers(companyId) {
      if (!OrgIdSchema.safeParse(companyId).success) throw new CloudModelKeyError("a model key is read for a company id");
      const providers = Object.keys(options.installKeys).sort();
      const held = await Promise.all(providers.map(async (provider) => {
        try { return (await read(provider)) !== undefined; } catch { return false; }
      }));
      return providers.filter((_, index) => held[index]);
    },
  };
}
