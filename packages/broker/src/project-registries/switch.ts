// N9 (INTG2): the install switch for a project's private package registries. A packed broker setting (`projectRegistries`, present only when the install is synthesised with
// `rovaraCodeArtifactDomains`) that reaches the broker as PROJECT_REGISTRIES_ENABLED; on only when it is exactly "1". Leaf module.
import { BOUND_REGISTRY_DOMAINS_VARIABLE, BROKER_SETTINGS, liveInteractionFlagOn, parseBoundRegistryDomains, type BoundRegistryDomain } from "@agentx/contracts";

export const projectRegistriesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.projectRegistries.variable]);

/** The CodeArtifact domains the install bound to an org (infra/lib/registry-access.ts). Unset or malformed: none, so no CodeArtifact registry is usable (fail closed). */
export const boundRegistryDomains = (env: NodeJS.ProcessEnv = process.env): BoundRegistryDomain[] => parseBoundRegistryDomains(env[BOUND_REGISTRY_DOMAINS_VARIABLE]);
