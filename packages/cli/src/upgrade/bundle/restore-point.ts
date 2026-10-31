// Enterprise foundations, task N3: what an upgrade records before it changes anything, so a rollback knows where to go back to: the instant
// (for a DynamoDB point-in-time restore), the version it left and the bundle id it left (null when that install never ran a bundle).
import { InstalledBundleSchema, RestorePointSchema, agentXError, installedBundleParameter, restorePointParameter, type InstalledBundle, type RestorePoint } from "@agentx/contracts";
import { ParameterExistsError, type ParameterStore } from "../../environments/parameter-store.js";

export { RestorePointSchema, installedBundleParameter, restorePointParameter, type InstalledBundle, type RestorePoint };

/** The bundle the last complete bundle upgrade installed, or undefined for an install that never ran one. An unreadable record is a refusal, not "none". */
export async function readInstalledBundle(store: ParameterStore, env: string): Promise<InstalledBundle | undefined> {
  const stored = await store.get(installedBundleParameter(env));
  if (stored === undefined) return undefined;
  try {
    return InstalledBundleSchema.parse(JSON.parse(stored.value));
  } catch {
    throw agentXError("CONFIG_INVALID", `the record of the installed bundle at ${installedBundleParameter(env)} is unreadable; nothing was changed. Fix or delete it, then run the upgrade again`);
  }
}

/** Written (and read back) before the first stack changes. A restore point that cannot be written stops the upgrade; one is never overwritten. */
export async function recordRestorePoint(input: { store: ParameterStore; env: string; now: number; fromVersion: string; targetVersion: string; targetBundleId: string }): Promise<RestorePoint> {
  const takenAt = new Date(input.now).toISOString();
  const previous = await readInstalledBundle(input.store, input.env);
  const point = RestorePointSchema.parse({
    schemaVersion: 1, takenAt, pitrTimestamp: takenAt, fromVersion: input.fromVersion, previousBundleId: previous?.bundleId ?? null,
    targetVersion: input.targetVersion, targetBundleId: input.targetBundleId,
  } satisfies RestorePoint);
  const name = restorePointParameter(input.env, takenAt);
  try {
    await input.store.put(name, JSON.stringify(point), { createOnly: true });
  } catch (error) {
    if (error instanceof ParameterExistsError) throw agentXError("CONFIG_INVALID", `a restore point already exists at ${name}; nothing was changed. Run the upgrade again`);
    throw agentXError("CONFIG_INVALID", `the restore point could not be recorded at ${name}; nothing was changed`);
  }
  const readBack = await input.store.get(name);
  if (readBack === undefined || readBack.value !== JSON.stringify(point)) throw agentXError("CONFIG_INVALID", `the restore point at ${name} could not be read back; nothing was changed`);
  return point;
}

/** After every stack deployed. A failure here is reported by the caller; the restore point already exists. */
export async function recordInstalledBundle(input: { store: ParameterStore; env: string; now: number; version: string; bundleId: string }): Promise<void> {
  const record: InstalledBundle = { schemaVersion: 1, bundleId: input.bundleId, version: input.version, installedAt: new Date(input.now).toISOString() };
  await input.store.put(installedBundleParameter(input.env), JSON.stringify(record));
}
