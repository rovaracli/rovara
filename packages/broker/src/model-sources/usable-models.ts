// Owner decision 2026-11-03: Rovara picks only models the customer's account can actually call. An Amazon Bedrock account enables Claude models one by one (an "agreement"), and a model it has not enabled answers 403
// "is not available for this account" through the model proxy. Rovara's catalog lists every Claude model, so without this the plan check, the review default and the second review chose models that could only fail.
//
// What the broker knows, per catalog model, from two cheap signals kept in ONE record (`SETTINGS` / `MODEL_USABILITY`, flat attributes, no table scan):
//   1. The probe: `bedrock:GetFoundationModelAvailability` for each foundation model behind the catalog's inference profiles (agreement and authorization status, the same reading model discovery makes). It runs at most once
//      every PROBE_TTL_MS, on first use after that, and is bounded. A probe that cannot run (no permission yet, the control plane unreachable) leaves what is known unchanged and is not retried until the next TTL.
//   2. The failure: a model call refused as not enabled (`ModelNotEnabled`, see the worker's model-call monitor) marks that model unusable for FAILURE_TTL_MS, whatever the probe says (an SCP or a marketplace
//      subscription can refuse a model the agreement lists).
// Both are advice for DEFAULT choices only. Nothing here refuses a model somebody chose, and it never narrows a list to nothing: with no usable model left, the full list stands and today's per-task fallbacks handle it.
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { canonicalModelName, type ModelIdentifier } from "@agentx/contracts";
import { bedrockClaudeModelIds, type ProxyGeography } from "@agentx/model-runtime/catalog";
import { foundationModelIdOf, type AvailabilityRow } from "@agentx/model-runtime/model-discovery";

export const MODEL_USABILITY_KEY = { pk: "SETTINGS", sk: "MODEL_USABILITY" } as const;
/** How long a probe's answer is trusted before the next use asks again. */
export const PROBE_TTL_MS = 10 * 60_000;
/** A probe answer older than this (the probe has failed since) is no longer used: the model counts as unknown, which is usable. */
export const PROBE_MAX_AGE_MS = 24 * 60 * 60_000;
/** How long a refused call keeps its model out of default choices. Short, so a model the owner has just enabled comes back soon. */
export const FAILURE_TTL_MS = 30 * 60_000;
/** The whole probe, and each call in it, is bounded: a slow control plane never holds a request for long. */
const PROBE_TOTAL_MS = 6_000;

/** The availability of one foundation model (`anthropic.claude-opus-5-5-...`), read with the broker's role. Throws when it cannot be read. */
export type AvailabilityProbe = (foundationModelId: string) => Promise<AvailabilityRow>;

export interface UsableModels {
  /** The canonical names (`canonicalModelName`) of Rovara's catalog models this account is known not to be able to call now. Never throws; unknown is not listed. */
  unusable(): Promise<ReadonlySet<string>>;
  /** A call to `model` was refused as not enabled for the account: keep it out of default choices for a while. Never throws. */
  markUnusable(model: ModelIdentifier): Promise<void>;
}

export interface UsableModelsDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  geography: ProxyGeography;
  /** Absent: only refused calls teach the broker (the broker's role has no availability permission yet). */
  probe?: AvailabilityProbe | undefined;
}

const logError = (event: string, error: unknown): void => {
  // The error's name only: its words could hold an id or a host.
  console.log(JSON.stringify({ component: "broker", event, errorName: error instanceof Error ? error.name : "unknown" }));
};

/** What the probe calls a model it cannot use: the agreement or the authorization is not in place. Unreadable (null) is not a denial. */
export function availabilityDenied(row: AvailabilityRow): boolean {
  return (row.agreement !== null && row.agreement !== "AVAILABLE") || (row.authorization !== null && row.authorization !== "AUTHORIZED");
}

const catalogNames = (geography: ProxyGeography): Map<string, string[]> => {
  const byFoundation = new Map<string, string[]>();
  for (const modelId of bedrockClaudeModelIds(geography)) {
    const foundation = foundationModelIdOf(modelId);
    byFoundation.set(foundation, [...(byFoundation.get(foundation) ?? []), canonicalModelName({ provider: "amazon-bedrock", modelId })]);
  }
  return byFoundation;
};

const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export function createUsableModels(deps: UsableModelsDependencies): UsableModels {
  const catalog = catalogNames(deps.geography);
  const known = new Set([...catalog.values()].flat());
  /** The probe in progress, when there is one (`refresh` never rejects). */
  let probing: Promise<Record<string, unknown>> | undefined;

  async function read(): Promise<Record<string, unknown>> {
    const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: MODEL_USABILITY_KEY, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    return found.Item ?? {};
  }

  /** Asks about every foundation model behind the catalog, together, within the bound. A model whose answer could not be read is left out (unknown). */
  async function probeAll(probe: AvailabilityProbe): Promise<Map<string, boolean>> {
    const answers = new Map<string, boolean>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, PROBE_TOTAL_MS); timer.unref?.(); });
    const asked = Promise.all([...catalog.entries()].map(async ([foundation, names]) => {
      try {
        const denied = availabilityDenied(await probe(foundation));
        for (const name of names) answers.set(name, denied);
      } catch { /* this model's answer stays unknown */ }
    }));
    try { await Promise.race([asked, deadline]); } finally { if (timer !== undefined) clearTimeout(timer); }
    return new Map(answers);
  }

  async function refresh(probe: AvailabilityProbe, item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = deps.now();
    const answers = await probeAll(probe);
    const names: Record<string, string> = { "#at": "probedAt" };
    const values: Record<string, unknown> = { ":now": now };
    const sets = ["#at = :now"];
    if (answers.size > 0) { names["#ok"] = "probeOkAt"; sets.push("#ok = :now"); }
    [...answers.entries()].forEach(([name, denied], index) => { names[`#p${String(index)}`] = `probe#${name}`; values[`:p${String(index)}`] = denied ? "no" : "yes"; sets.push(`#p${String(index)} = :p${String(index)}`); });
    try {
      await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: MODEL_USABILITY_KEY, UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
    } catch (error) { logError("model_usability.probe_not_saved", error); }
    // What this request goes on with, saved or not.
    const next: Record<string, unknown> = { ...item, probedAt: now };
    if (answers.size > 0) next.probeOkAt = now;
    for (const [name, denied] of answers) next[`probe#${name}`] = denied ? "no" : "yes";
    return next;
  }

  return {
    async unusable() {
      try {
        const now = deps.now();
        let item = await read();
        const probedAt = numberOf(item.probedAt);
        if (deps.probe !== undefined && (probedAt === undefined || now - probedAt >= PROBE_TTL_MS || probedAt > now)) {
          // Single flight: one probe at a time in this broker instance. A request that finds one running does not wait for it (each wait could be the full bound) and goes on with the record as it is.
          if (probing === undefined) {
            const started = refresh(deps.probe, item).finally(() => { probing = undefined; });
            probing = started;
            item = await started;
          }
        }
        const probeFresh = (numberOf(item.probeOkAt) ?? -Infinity) > now - PROBE_MAX_AGE_MS;
        const out = new Set<string>();
        for (const name of known) {
          const failedAt = numberOf(item[`failed#${name}`]);
          if (failedAt !== undefined && failedAt <= now && now - failedAt < FAILURE_TTL_MS) out.add(name);
          else if (probeFresh && item[`probe#${name}`] === "no") out.add(name);
        }
        return out;
      } catch (error) {
        // A record that cannot be read teaches nothing: every model stays usable, as before this check existed.
        logError("model_usability.unreadable", error);
        return new Set<string>();
      }
    },
    async markUnusable(model) {
      const name = canonicalModelName(model);
      if (!known.has(name)) return;
      try {
        await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: MODEL_USABILITY_KEY, UpdateExpression: "SET #failed = :now", ExpressionAttributeNames: { "#failed": `failed#${name}` }, ExpressionAttributeValues: { ":now": deps.now() } }));
      } catch (error) { logError("model_usability.mark_failed", error); }
    },
  };
}

/** The catalog models of `models` this account can call: the models unchanged, less those known not to work. Never empty because of this: with none usable left the list stands as it was. */
export function withoutUnusable(models: readonly ModelIdentifier[], unusable: ReadonlySet<string>): ModelIdentifier[] {
  if (unusable.size === 0) return [...models];
  const kept = models.filter((model) => !unusable.has(canonicalModelName(model)));
  return kept.length === 0 ? [...models] : kept;
}
