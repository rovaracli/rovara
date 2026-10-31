// Enterprise foundations E2: the edition of this install, read once at cold start from the deploy stamp (ROVARA_EDITION).
//
// The stamp is set by the CDK synth (infra/lib/edition-env.ts) on every function. It is the ONLY source: never a request, an org setting, the database or the old
// `cloud` flag. An install with no stamp is an existing install (it was deployed before editions): it keeps today's behaviour, which is "no edition gates", and it
// is never treated as Enterprise. A stamp that is present but wrong stops the process from starting.
import { EDITION_ENV_VAR, agentXError, editionPolicy, resolveEdition, type EditionPolicy } from "@agentx/contracts";

/**
 * @param environment the process environment
 * @param cloud whether this install is the hosted cloud (the org resolver is configured); used only to cross-check the stamp, never to choose the edition
 * @returns the policy for the stamped edition, or undefined for an existing install with no stamp
 * @throws CONFIG_INVALID when the stamp is not exactly "enterprise" or "public" (an empty value included), or when it disagrees with the cloud flag
 */
export function installEditionPolicy(environment: Record<string, string | undefined>, cloud: boolean): EditionPolicy | undefined {
  const configured = environment[EDITION_ENV_VAR];
  if (configured === undefined) return undefined;
  const edition = resolveEdition({ configured, cloud, allowDerivedFromCloud: false });
  // The synth refuses these two combinations already; a process that meets one anyway has been deployed by hand or from another source, and must not run.
  if (edition === "enterprise" && cloud) throw agentXError("CONFIG_INVALID", `${EDITION_ENV_VAR} is "enterprise" but this install is the hosted cloud.`);
  if (edition === "public" && !cloud) throw agentXError("CONFIG_INVALID", `${EDITION_ENV_VAR} is "public" but this install is not the hosted cloud.`);
  return editionPolicy(edition);
}
