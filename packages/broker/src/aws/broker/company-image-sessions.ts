// The registry sessions the company image login uses (the saved-environment pull role, for a company image's mirror repository), built from the broker's own settings, or the ones a test injected. Built once per
// container. Undefined (with the missing setting logged by `savedEnvConfigOf`) where the install has no registry for images.
import type { SavedEnvSessionConfig, SavedEnvSessionPorts } from "../../test-env/saved-env-session.js";
import { realSavedEnvAwsClients, savedEnvSessionPorts } from "./saved-env-aws.js";
import { savedEnvConfigOf } from "./saved-env-config.js";
import type { AwsBrokerDependencies } from "./definitions.js";

let built: { config: SavedEnvSessionConfig; ports: SavedEnvSessionPorts } | undefined;

export function companyImageSessionsOf(dependencies: Pick<AwsBrokerDependencies, "companyImageSessions">, env: NodeJS.ProcessEnv = process.env): { config: SavedEnvSessionConfig; ports: SavedEnvSessionPorts } | undefined {
  if (dependencies.companyImageSessions !== undefined) return dependencies.companyImageSessions;
  if (built !== undefined) return built;
  const config = savedEnvConfigOf(env);
  if (config === undefined) return undefined;
  built = {
    config: { enabled: true, env: config.env, scope: config.scope, kmsKeyArn: config.kmsKeyArn },
    // The pull session needs no approved environment or Prove report: the bindings are never asked.
    ports: savedEnvSessionPorts(realSavedEnvAwsClients(config.scope.region), { readApproved: async () => undefined, proveHolds: async () => false, now: Date.now }),
  };
  return built;
}
