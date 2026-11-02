// Saved environments (SH25): the saved image field of a prepare invocation. The rules are in ../../test-env/saved-env.ts (`savedEnvForPrepare`); this file only asks the installed resolver, and never lets it
// block or fail a preparation. A run that runs none of the project's code (`readOnly`) is sent nothing: it has no setup to save.
import type { PrepareSavedEnv } from "@agentx/contracts";
import type { AwsBrokerDependencies, RegisteredProjectRecord } from "./definitions.js";

/** `{ savedEnv }` for a prepare payload, or nothing. */
export async function savedEnvPrepareOf(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, options: { readOnly?: boolean; orgId: string | undefined }): Promise<{ savedEnv?: PrepareSavedEnv }> {
  const resolve = dependencies.savedEnvPrepare;
  if (resolve === undefined || options.readOnly === true || options.orgId === undefined) return {};
  try { return await resolve({ orgId: options.orgId, projectName: project.definition.name }); } catch { return {}; }
}
