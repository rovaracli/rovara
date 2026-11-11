// Saved environments (SH25): the saved image field of a prepare invocation, and the install of the registry's hooks. The rules are in ../../test-env/saved-env.ts (`savedEnvForPrepare`, `savedEnvPullLogin`); this
// file only asks the installed resolver, and never lets it block or fail a preparation.
//
// What is sent, and when: the field is a REFERENCE (repository, digest, revision, key, the task's pinned revision). It is stored with the invocation (outbox, stream, queue), so it holds no credential: the worker
// asks for the pull login at pull time (`exchangeSavedEnvLogin`). Only a developer task's start (and the continue of a held start) sends the task's approved-environment pin; a preparation without one (a thread
// workspace, project registration, a setup draft, a run that runs none of the project's code) is sent nothing.
import type { PrepareSavedEnv } from "@agentx/cloud-contracts";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import { savedEnvForPrepare, savedEnvPullLogin } from "../../test-env/saved-env.js";
import type { AwsBrokerDependencies, RegisteredProjectRecord } from "./definitions.js";

/** `{ savedEnv }` for a prepare payload, or nothing. */
export async function savedEnvPrepareOf(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
  options: { readOnly?: boolean; orgId: string | undefined; setupDraft?: boolean; testEnvPin?: { revision: number; digest: string } | undefined },
): Promise<{ savedEnv?: PrepareSavedEnv }> {
  const resolve = dependencies.savedEnvPrepare;
  if (resolve === undefined || options.readOnly === true || options.setupDraft === true || options.orgId === undefined || options.testEnvPin === undefined) return {};
  try { return await resolve({ orgId: options.orgId, projectName: project.definition.name, testEnvPin: options.testEnvPin }); } catch { return {}; }
}

/**
 * The two hooks, from the registry's ports, and only while the `sv` switch is on. With it off (or no ports) both are set to undefined EXPLICITLY, so a hook that arrived with the input is cleared too:
 * nothing is sent and no login is given.
 */
export function installSavedEnv(input: Pick<AwsBrokerDependencies, "savedEnvDeps">, env: NodeJS.ProcessEnv = process.env): { savedEnvPrepare: AwsBrokerDependencies["savedEnvPrepare"] | undefined; savedEnvLogin: AwsBrokerDependencies["savedEnvLogin"] | undefined } {
  const deps = input.savedEnvDeps;
  if (deps === undefined || !savedEnvEnabled(env)) return { savedEnvPrepare: undefined, savedEnvLogin: undefined };
  return {
    savedEnvPrepare: ({ orgId, projectName, testEnvPin }) => savedEnvForPrepare(deps, { orgId, projectId: projectName }, testEnvPin),
    savedEnvLogin: async ({ orgId, projectName, digest }) => {
      const login = await savedEnvPullLogin(deps, { orgId, projectId: projectName }, digest);
      return login.ok ? login.auth : undefined;
    },
  };
}
