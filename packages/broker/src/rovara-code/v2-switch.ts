// Rovara Code v2 is turned on per environment (owner decision 2026-10-26). The control plane's stack parameter RovaraCodeV2Enabled (off by default, named
// environments only) reaches the broker in its packed settings (AGENTX_SETTINGS, code "rv"), which hydrate AGENTX_ROVARA_CODE_V2_ENABLED. Only the exact word "true" turns
// it on. It decides whether an admin may adopt version 2 and whether Understand and the plan check run (`rovaraCodeV2Live`); it moves no org by itself, and a task
// that exists keeps the version it started on. `ROVARA_CODE_V2_FOR_NEW_ORGS` (the code default) stays false.
export function rovaraCodeV2LiveFromEnvironment(environment: Record<string, string | undefined>): boolean {
  return environment["AGENTX_ROVARA_CODE_V2_ENABLED"] === "true";
}
