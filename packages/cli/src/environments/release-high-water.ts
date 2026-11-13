// The highest release an environment ever ran: /agentx/<env>/release-high-water, a plain x.y.z in a record of its own (never in the strict
// settings schema, which every older agentx must still read). Raised by every upgrade and bundle approval, never lowered: a rollback leaves
// it where it was, so the rollback floors (upgrade/target.ts) of a release rolled back past keep applying to the next rollback too.
// Absent on every install made before 0.5.17: the recorded version stands in for it.
import { agentXError, environmentSettingsPrefix } from "@rovara-code/contracts";
import type { ParameterStore } from "./parameter-store.js";
import { compareVersions } from "../upgrade/target.js";

export function releaseHighWaterParameter(env: string): string {
  return `${environmentSettingsPrefix(env)}release-high-water`;
}

/** The recorded mark, or undefined when none is recorded. A value that is not x.y.z is a refusal: a rollback never guesses it lower. */
export async function readReleaseHighWater(store: ParameterStore, env: string): Promise<string | undefined> {
  const stored = await store.get(releaseHighWaterParameter(env));
  if (stored === undefined) return undefined;
  const value = stored.value.trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw agentXError("CONFIG_INVALID", `${releaseHighWaterParameter(env)} holds "${value.slice(0, 40)}", not a release version (x.y.z); fix it by hand to the highest release ${env} ever ran, then try again; nothing was changed`);
  return value;
}

/** Raises the mark to `version` when it is higher (or none is recorded); never lowers it. Returns the mark after the call. */
export async function raiseReleaseHighWater(store: ParameterStore, env: string, version: string): Promise<string> {
  const current = await readReleaseHighWater(store, env);
  if (current !== undefined && compareVersions(current, version) >= 0) return current;
  await store.put(releaseHighWaterParameter(env), version);
  return version;
}
