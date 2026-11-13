// The highest release an environment ever ran: /agentx/<env>/release-high-water, a plain x.y.z in a record of its own (never in the strict
// settings schema, which every older agentx must still read). Raised by every upgrade and bundle approval, never lowered: a rollback leaves
// it where it was, so the rollback floors (upgrade/target.ts) of a release rolled back past keep applying to the next rollback too.
// Absent on every install made before 0.5.17: the recorded version stands in for it.
import { agentXError } from "@rovara-code/contracts";
import { releaseHighWaterParameter as contractParameter } from "@agentx/cloud-contracts";
import type { ParameterStore } from "./parameter-store.js";
import { compareVersions } from "../upgrade/target.js";

export function releaseHighWaterParameter(env: string): string {
  return contractParameter(env);
}

/** The recorded mark, or undefined when none is recorded. A value that is not x.y.z is a refusal: a rollback never guesses it lower. */
export async function readReleaseHighWater(store: ParameterStore, env: string): Promise<string | undefined> {
  const stored = await store.get(releaseHighWaterParameter(env));
  if (stored === undefined) return undefined;
  const value = stored.value.trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw agentXError("CONFIG_INVALID", `${releaseHighWaterParameter(env)} holds "${value.slice(0, 40)}", not a release version (x.y.z); fix it by hand to the highest release ${env} ever ran, then try again; nothing was changed`);
  return value;
}

/** How many times a raise writes and reads back before it gives up: another writer can put a lower value between the read and the write. */
export const HIGH_WATER_ATTEMPTS = 3;

/** Raises the mark to `version` when it is higher (or none is recorded); never lowers it. After each write it reads the mark back, and writes
 * again while another writer left it lower, a bounded number of times. Returns the mark after the call. */
export async function raiseReleaseHighWater(store: ParameterStore, env: string, version: string): Promise<string> {
  for (let attempt = 0; attempt < HIGH_WATER_ATTEMPTS; attempt += 1) {
    const current = await readReleaseHighWater(store, env);
    if (current !== undefined && compareVersions(current, version) >= 0) return current;
    await store.put(releaseHighWaterParameter(env), version);
  }
  const after = await readReleaseHighWater(store, env);
  if (after !== undefined && compareVersions(after, version) >= 0) return after;
  throw agentXError("CONFIG_INVALID", `${releaseHighWaterParameter(env)} was lowered by another writer ${HIGH_WATER_ATTEMPTS} times while ${version} was being recorded; stop the other agentx run, then try again; nothing was changed`);
}
