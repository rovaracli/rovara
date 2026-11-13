// The control plane's two keys, read from Secrets Manager (0.5.15 signing-key lane), so no key is a Lambda environment variable.
//  - The callback signing key (kind a) signs short-lived tokens: worker callbacks, repository grants, cancel, setup and eval tokens. It can be rotated
//    (docs/runbooks/rotate-callback-signing-key.md): tokens are always issued with the current key, and for PREVIOUS_KEY_WINDOW_MS after a rotation a token
//    signed with the previous key (the secret's AWSPREVIOUS version) still verifies, so in-flight callbacks are not cut off.
//  - The erasure hash key (kind b) hashes values that are stored: erased people's names and aliases, Ask question hashes. It is never rotated here: a new value
//    would orphan every stored hash, so rotating it needs a re-hash plan first.
// Named environments read both secrets by the names the environment's name decides (@agentx/cloud-contracts derived-names.ts), and ignore any CALLBACK_SIGNING_KEY
// variable (secret first). The legacy production install keeps its CALLBACK_SIGNING_KEY variable (its template is frozen), and that one value serves both kinds, exactly as before.
// Read once per Lambda execution environment (cold start, on the first request) and kept in memory; a failed read is not kept, so the next request tries
// again. Fail closed: a missing, unreadable or short key refuses (throws a fixed message with the error's name only), never runs without a key.
// Never logs or returns a key in an error.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { callbackSigningKeySecretName, erasureHashKeySecretName } from "@agentx/cloud-contracts";

/** The shortest key accepted, in UTF-8 bytes (the broker's own check, handler.ts). */
export const MIN_SIGNING_KEY_BYTES = 32;
/** How long after a rotation (the current version's creation) a token signed with the previous key still verifies. Callback tokens live at most 9 hours. */
export const PREVIOUS_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The callback signing key: `current` issues and verifies; `previous` only verifies, and only until `acceptUntilMs`. */
export interface CallbackKeyRing {
  readonly current: string;
  readonly previous?: { readonly value: string; readonly acceptUntilMs: number } | undefined;
}

/** What the readers need from Secrets Manager. */
export interface SigningSecretReader {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined; CreatedDate?: Date | undefined }>;
}

type Environment = Readonly<Record<string, string | undefined>>;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "UnknownError");

function checkedKey(value: string | undefined, label: string): string {
  if (value === undefined || Buffer.byteLength(value, "utf8") < MIN_SIGNING_KEY_BYTES) throw new Error(`the ${label} is missing or shorter than ${MIN_SIGNING_KEY_BYTES} bytes`);
  return value;
}

/** The environment's name (AGENTX_ENV), trimmed; undefined when it is unset, empty or only whitespace (those count as the legacy install). */
export const environmentNameOf = (env: Environment): string | undefined => {
  const name = (env["AGENTX_ENV"] ?? "").trim();
  return name === "" ? undefined : name;
};

/** Whether this function belongs to a named environment (AGENTX_ENV, trimmed): its keys are its secrets, and only they. */
export const isNamedEnvironment = (env: Environment): boolean => environmentNameOf(env) !== undefined;

/**
 * The legacy install's one key (its CALLBACK_SIGNING_KEY variable), or undefined where it has none. SECRET FIRST: a function of a named environment (AGENTX_ENV set)
 * never uses the variable, even if one is left over on it, because the secret is the key that rotates and a stale variable would keep signing with the old value.
 */
export function legacyKey(env: Environment): string | undefined {
  if (isNamedEnvironment(env)) return undefined;
  const value = env["CALLBACK_SIGNING_KEY"];
  return value === undefined || value === "" ? undefined : checkedKey(value, "callback signing key");
}

function environmentName(env: Environment): string {
  const name = environmentNameOf(env);
  if (name === undefined) throw new Error("no signing key is configured: neither CALLBACK_SIGNING_KEY nor AGENTX_ENV is set");
  return name;
}

/** Whether this function has a callback signing key to read at all: the legacy variable, or a named environment's secret. */
export function callbackSigningKeyConfigured(env: Environment): boolean {
  return (env["CALLBACK_SIGNING_KEY"] ?? "") !== "" || isNamedEnvironment(env);
}

/** The legacy install's keys, available without any read: both kinds are its one CALLBACK_SIGNING_KEY. Undefined in a named environment. */
export function legacySigningKeys(env: Environment): { callback: CallbackKeyRing; erasure: string } | undefined {
  const key = legacyKey(env);
  return key === undefined ? undefined : { callback: { current: key }, erasure: key };
}

async function readSecret(secrets: SigningSecretReader, secretId: string, label: string, stage?: "AWSPREVIOUS"): Promise<{ value: string | undefined; createdAt: Date | undefined }> {
  try {
    const reply = await secrets.send(new GetSecretValueCommand({ SecretId: secretId, ...(stage === undefined ? {} : { VersionStage: stage }) }));
    return { value: reply.SecretString, createdAt: reply.CreatedDate };
  } catch (error) {
    // The previous version does not exist until the first rotation: no previous key, not a failure.
    if (stage !== undefined && errorName(error) === "ResourceNotFoundException") return { value: undefined, createdAt: undefined };
    // No cause on purpose: the refusal carries a fixed message and the error's name only, never the SDK's text.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`the ${label} could not be read (${errorName(error)})`);
  }
}

/** Reads the callback key ring from a named environment's secret: the current version, and the previous one while it is inside the window. */
export async function readCallbackKeyRing(secrets: SigningSecretReader, env: string): Promise<CallbackKeyRing> {
  const secretId = callbackSigningKeySecretName(env);
  const current = await readSecret(secrets, secretId, "callback signing key");
  const value = checkedKey(current.value, "callback signing key");
  const previous = await readSecret(secrets, secretId, "previous callback signing key", "AWSPREVIOUS");
  // Without the current version's creation time there is no window to bound the previous key by, so it is not accepted (closed).
  if (previous.value === undefined || previous.value === value || current.createdAt === undefined || Buffer.byteLength(previous.value, "utf8") < MIN_SIGNING_KEY_BYTES) return { current: value };
  return { current: value, previous: { value: previous.value, acceptUntilMs: current.createdAt.getTime() + PREVIOUS_KEY_WINDOW_MS } };
}

/** Reads a named environment's erasure hash key. */
export async function readErasureHashKey(secrets: SigningSecretReader, env: string): Promise<string> {
  return checkedKey((await readSecret(secrets, erasureHashKeySecretName(env), "erasure hash key")).value, "erasure hash key");
}

/** One read, kept once it succeeds; a failed read is forgotten so the next call tries again. */
function cachedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | undefined;
  return () => {
    kept ??= read().catch((error: unknown) => {
      kept = undefined;
      throw error;
    });
    return kept;
  };
}

/** The callback key ring for this function: the legacy variable where there is one, else the named environment's secret (read once, cached). */
export function callbackKeySource(env: Environment, secrets: () => SigningSecretReader): () => Promise<CallbackKeyRing> {
  const fromSecret = cachedRead(() => readCallbackKeyRing(secrets(), environmentName(env)));
  // Decided when first needed, not when the module loads.
  return async () => {
    const legacy = legacyKey(env);
    return legacy !== undefined ? { current: legacy } : fromSecret();
  };
}

/** The erasure hash key for this function: the legacy variable where there is one, else the named environment's secret (read once, cached). */
export function erasureKeySource(env: Environment, secrets: () => SigningSecretReader): () => Promise<string> {
  const fromSecret = cachedRead(() => readErasureHashKey(secrets(), environmentName(env)));
  return async () => legacyKey(env) ?? fromSecret();
}

/** The previous key, only while it is inside its window; never after. */
export function previousKeyOf(ring: CallbackKeyRing, nowMs: number = Date.now()): string | undefined {
  return ring.previous !== undefined && nowMs < ring.previous.acceptUntilMs ? ring.previous.value : undefined;
}

/** The keys a token may be verified with, current first: what every kind-a verifier tries. */
export function callbackVerificationKeys(dependencies: { callbackSigningKey: string; callbackPreviousKey?: (() => string | undefined) | undefined }): string[] {
  const previous = dependencies.callbackPreviousKey?.();
  return previous === undefined || previous === dependencies.callbackSigningKey ? [dependencies.callbackSigningKey] : [dependencies.callbackSigningKey, previous];
}

/** A key a dependency holds now, or reads when first needed (a scheduled function's secret). */
export type KeyOrSource = string | (() => Promise<string>);
export const resolveKey = async (key: KeyOrSource): Promise<string> => (typeof key === "string" ? key : key());

/** The key stored hashes are made with: the erasure hash key, or (a harness that sets none) the callback signing key, the one value both were before 0.5.15. */
export const erasureKeyOf = (dependencies: { callbackSigningKey: string; erasureHashKey?: string | undefined }): string => dependencies.erasureHashKey ?? dependencies.callbackSigningKey;

/**
 * A Lambda handler built once its keys are read: the first request reads them (cold start) and builds the handler; later requests reuse it. A failed read
 * refuses that request (fail closed) and the next request reads again; the handler is never built without its keys.
 */
export function handlerAfterKeys<K, A extends unknown[], R>(load: () => Promise<K>, build: (keys: K) => (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let built: Promise<(...args: A) => Promise<R>> | undefined;
  return async (...args: A) => {
    built ??= load().then(build).catch((error: unknown) => {
      built = undefined;
      throw error;
    });
    return (await built)(...args);
  };
}
