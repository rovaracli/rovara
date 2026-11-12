// The control plane's callback signing key: a per-environment secret the deploy orchestrator reads
// (creating it on first use) and passes to the control-plane stack as the CallbackSigningKey
// parameter. Never logged, never returned in an error message: callers of `callbackSigningKey` get
// only the value itself, to hold in memory for the length of one deploy.
import { randomBytes } from "node:crypto";
import { CreateSecretCommand, GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { agentXError } from "@rovara-code/contracts";
import { callbackSigningKeySecretName as derivedCallbackSigningKeySecretName, erasureHashKeySecretName as derivedErasureHashKeySecretName } from "@agentx/cloud-contracts";

/** The number of random bytes in a freshly created callback signing key (before base64url encoding).
 * Exported so callers that must bound a buffer against "the longest secret we ever redact"
 * (commands.ts's line-buffered stream redaction) can derive that length from the one real source
 * of truth, instead of duplicating a magic number that could silently drift out of sync. */
export const CALLBACK_SIGNING_KEY_BYTES = 48;

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

/** Thrown by `SecretValueStore.create` when another caller already created the secret first: a
 * typed signal, never a raw SDK error, so callers can race-recover by re-reading the winning value. */
export class SecretAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`secret ${name} already exists`);
    this.name = "SecretAlreadyExistsError";
  }
}

/** FR-047: every resource carries agentx:env. A secret the CLI creates under agentx/<env>/ is
 * tagged with that environment; the legacy agentx/connectors/ name is not (it names no single
 * environment). Any other name is not a value the caller chose but a name it built wrong, so this
 * refuses it rather than silently creating an untagged secret. */
export function secretTags(name: string): Array<{ Key: string; Value: string }> {
  if (name.startsWith("agentx/connectors/")) return [];
  const match = /^agentx\/([a-z0-9-]{1,20})\//.exec(name);
  if (match === null) {
    throw agentXError("CONFIG_INVALID", `secret name "${name}" is not a valid agentx secret name; it must start with agentx/<env>/ or be the legacy agentx/connectors/...`);
  }
  return [{ Key: "agentx:env", Value: match[1]! }];
}

/** What `callbackSigningKey` needs from Secrets Manager. */
export interface SecretValueStore {
  /** The secret's current value, or undefined when it does not exist. */
  get(name: string): Promise<string | undefined>;
  /** Creates the secret with this value. Throws `SecretAlreadyExistsError` (never a raw SDK error)
   * when another caller created it first between this store's own existence check and this call. */
  create(name: string, value: string): Promise<void>;
}

/** Reads and creates plain-string secrets with Secrets Manager. */
export function secretsManagerValueStore(client: SecretsManagerClient): SecretValueStore {
  return {
    async get(name) {
      try {
        const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: name }));
        return SecretString;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return undefined;
        throw error;
      }
    },
    async create(name, value) {
      try {
        const tags = secretTags(name);
        await client.send(new CreateSecretCommand({ Name: name, SecretString: value, ...(tags.length === 0 ? {} : { Tags: tags }) }));
      } catch (error) {
        if (errorName(error) === "ResourceExistsException") throw new SecretAlreadyExistsError(name);
        throw error;
      }
    },
  };
}

/** `agentx/<env>/callback-signing-key`, exactly as the control-plane stack's operator guide names it. */
export function callbackSigningKeySecretName(env: string): string {
  return derivedCallbackSigningKeySecretName(env);
}

/** `agentx/<env>/erasure-hash-key`: the key erased people's names and aliases (and Ask question hashes) are hashed with (0.5.15). */
export function erasureHashKeySecretName(env: string): string {
  return derivedErasureHashKeySecretName(env);
}

/**
 * The environment's callback signing key, creating it (48 random bytes, base64url) the first time
 * it is needed. Never logs or prints the value. Race-safe: if another caller creates the secret
 * between this call's own `get` and `create` (`SecretAlreadyExistsError`), re-reads and returns the
 * winning value instead of the one generated (but not stored) here.
 */
export async function callbackSigningKey(store: SecretValueStore, env: string): Promise<string> {
  const name = callbackSigningKeySecretName(env);
  const existing = await store.get(name);
  if (existing !== undefined) return existing;
  const value = randomBytes(CALLBACK_SIGNING_KEY_BYTES).toString("base64url");
  try {
    await store.create(name, value);
    return value;
  } catch (error) {
    if (!(error instanceof SecretAlreadyExistsError)) throw error;
    const winner = await store.get(name);
    if (winner === undefined) throw error;
    return winner;
  }
}

/**
 * 0.5.15 signing-key lane: makes sure the environment's erasure hash key exists, creating it the first time with the value of the callback signing key
 * the caller already holds (`callbackSigningKey` above), so every hash stored before the split still matches. Never overwrites: an existing erasure key
 * is kept whatever it holds (it is never rotated by a deploy; a later rotation of the callback signing key must not change it). Race-safe like
 * `callbackSigningKey`: a create that loses to another caller keeps the winner's value. Never logs, prints or returns either value.
 *
 * This runs in the deploy before any stack, so the control plane's functions (which read the secret at cold start and refuse to serve without it) never
 * start without it. CloudFormation never holds or manages the value, so no stack update or deletion can regenerate, overwrite or delete it.
 */
export async function ensureErasureHashKey(store: SecretValueStore, env: string, currentCallbackSigningKey: string): Promise<"created" | "kept"> {
  const name = erasureHashKeySecretName(env);
  if (currentCallbackSigningKey.length < 32) throw agentXError("CONFIG_INVALID", "the callback signing key is too short to seed the erasure hash key");
  if ((await store.get(name)) !== undefined) return "kept";
  try {
    await store.create(name, currentCallbackSigningKey);
    return "created";
  } catch (error) {
    if (!(error instanceof SecretAlreadyExistsError)) throw error;
    return "kept";
  }
}
