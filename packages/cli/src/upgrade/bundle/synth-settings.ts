// Enterprise upgrades are built at approval (owner decision 2026-10-31, option A). The settings a build is made from are the install's OWN, recorded by the
// customer's administrators in Parameter Store (`/agentx/<env>/synth-settings`). They are read here, from the install, and from nowhere else: not from a bundle,
// not from a flag, not from anything the Rovara operator can reach (the operator role has no Parameter Store access).
import { SynthSettingsSchema, agentXError, synthSettingsParameter, synthSettingsSha256, type SynthSettings } from "@agentx/contracts";
import type { EnvironmentSettings } from "../../environments/settings.js";
import type { ParameterStore } from "../../environments/parameter-store.js";

export { synthSettingsParameter };

/** The recorded settings, or a refusal. Absent, unreadable, or another install's: nothing is built from a guess. */
export async function readSynthSettings(store: ParameterStore, install: Pick<EnvironmentSettings, "env" | "region" | "identity">): Promise<SynthSettings> {
  const name = synthSettingsParameter(install.env);
  const stored = await store.get(name);
  if (stored === undefined) {
    throw agentXError("CONFIG_INVALID", `this Enterprise install has no recorded build settings at ${name}; your administrators record them with: agentx bundle record-settings --file <settings.json>. Nothing was built`);
  }
  let settings: SynthSettings;
  try {
    settings = SynthSettingsSchema.parse(JSON.parse(stored.value));
  } catch {
    throw agentXError("CONFIG_INVALID", `the recorded build settings at ${name} are not valid; record them again with: agentx bundle record-settings --file <settings.json>. Nothing was built`);
  }
  assertSettingsAreThisInstalls(settings, install);
  return settings;
}

/** A settings record that names another environment, region or identity mode than the install it sits in is refused. */
export function assertSettingsAreThisInstalls(settings: SynthSettings, install: Pick<EnvironmentSettings, "env" | "region" | "identity">): void {
  if (settings.env !== install.env) throw agentXError("CONFIG_INVALID", `the recorded build settings are for environment ${settings.env}, not ${install.env}; nothing was built`);
  if (settings.region !== install.region) throw agentXError("CONFIG_INVALID", `the recorded build settings are for region ${settings.region}, not ${install.region}; nothing was built`);
  if (settings.identityMode !== install.identity.mode) throw agentXError("CONFIG_INVALID", `the recorded build settings say identity mode ${settings.identityMode}, the install uses ${install.identity.mode}; nothing was built`);
}

/** Records the settings. Run by an administrator with their own credentials; replaces the earlier record, which ends every approval built from it (the deployer compares hashes). */
export async function recordSynthSettings(input: { store: ParameterStore; install: Pick<EnvironmentSettings, "env" | "region" | "identity">; settings: unknown }): Promise<{ sha256: string; settings: SynthSettings }> {
  const parsed = SynthSettingsSchema.safeParse(input.settings);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `the build settings are not valid: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim());
  }
  assertSettingsAreThisInstalls(parsed.data, input.install);
  await input.store.put(synthSettingsParameter(input.install.env), JSON.stringify(parsed.data));
  return { sha256: synthSettingsSha256(parsed.data), settings: parsed.data };
}
