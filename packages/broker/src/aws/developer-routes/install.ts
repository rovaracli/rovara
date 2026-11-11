// Enterprise foundations E2: GET /v1/app/install. The UI hides what the edition turns off; it never decides access (the broker does, with `requireFeature`).
import { agentXError } from "@rovara-code/contracts";
import { installInfo, type InstallInfo } from "@agentx/cloud-contracts";
import type { DeveloperRouteDependencies } from "./types.js";

/** An install deployed before editions has no stamp and no table: it answers not found rather than guess an edition. */
export function getInstallInfo(deps: DeveloperRouteDependencies): InstallInfo {
  if (deps.editionPolicy === undefined) throw agentXError("NOT_FOUND", "this install has no edition");
  return installInfo(deps.editionPolicy);
}
