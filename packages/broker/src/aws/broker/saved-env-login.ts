// Saved environments (SH25, review M1): the route's handler. The rules are in ../../test-env/saved-env-login.ts; this file only reads the stored records they ask for.
import { agentXError } from "@agentx/contracts";
import { requireOperation } from "../cancellation.js";
import { requireWorkspace } from "./records.js";
import { exchangeSavedEnvLoginCore } from "../../test-env/saved-env-login.js";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import { parseBody } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import type { AdaptedHttpRequest } from "../lambda.js";

export async function exchangeSavedEnvLogin(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, workspaceId: string, operationId: string) {
  const login = dependencies.savedEnvLogin;
  return exchangeSavedEnvLoginCore({
    enabled: savedEnvEnabled() && login !== undefined,
    inspectGrant: (grant) => dependencies.repositoryGrants.inspect(grant),
    readOperation: async (workspace, operation) => {
      const record = await requireOperation(dependencies, workspace, operation);
      const instance = await requireWorkspace(dependencies, workspace);
      return { kind: record.kind, status: record.status, savedEnvDigest: record.savedEnvDigest, orgId: typeof instance.orgId === "string" ? instance.orgId : undefined, projectName: instance.projectName, workspace: { status: instance.status, activeOperationId: instance.activeOperationId } };
    },
    login: async (input) => login?.(input),
  }, { grant: request.headers["x-agentx-repository-grant"], workspaceId, operationId, body: parseBodyObject(request.body) });
}

function parseBodyObject(body: string | undefined): unknown {
  const parsed = parseBody(body);
  if (parsed === undefined || parsed === null) throw agentXError("CONFIG_INVALID", "saved environment login request is invalid");
  return parsed;
}
