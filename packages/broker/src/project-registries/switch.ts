// N9 (INTG2): the install switch for a project's private package registries. A packed broker setting (`projectRegistries`, present only when the install is synthesised with
// `rovaraCodeArtifactDomains`) that reaches the broker as PROJECT_REGISTRIES_ENABLED; on only when it is exactly "1". Leaf module.
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

export const projectRegistriesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.projectRegistries.variable]);
