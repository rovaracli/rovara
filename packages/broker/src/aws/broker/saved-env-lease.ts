// Saved project images (SV wiring): the three handlers over the stored records. The rules are in ../../test-env/saved-env-lease.ts; this file only reads the operation and its workspace.
import { agentXError } from "@agentx/contracts";
import { requireOperation } from "../cancellation.js";
import { requireWorkspace } from "./records.js";
import { savedEnvFallbackCore, savedEnvPushLoginCore, savedEnvResultCore, type SavedEnvLeaseContext } from "../../test-env/saved-env-lease.js";
import { parseBody } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import type { AdaptedHttpRequest } from "../lambda.js";

export function savedEnvLeaseContext(dependencies: AwsBrokerDependencies): SavedEnvLeaseContext {
  return {
    deps: dependencies.savedEnvDeps,
    inspectGrant: (grant) => dependencies.repositoryGrants.inspect(grant),
    readOperation: async (workspace, operation) => {
      const record = await requireOperation(dependencies, workspace, operation);
      const instance = await requireWorkspace(dependencies, workspace);
      return {
        kind: record.kind, status: record.status, savedEnvJobId: record.savedEnvJobId, savedEnvDigest: record.savedEnvDigest,
        orgId: typeof instance.orgId === "string" ? instance.orgId : undefined, projectName: instance.projectName, workspace: { status: instance.status, activeOperationId: instance.activeOperationId },
      };
    },
  };
}

function bodyOf(request: AdaptedHttpRequest): unknown {
  const parsed = parseBody(request.body);
  if (parsed === undefined || parsed === null) throw agentXError("CONFIG_INVALID", "saved environment request is invalid");
  return parsed;
}

export type SavedEnvLeaseRoute = "push-login" | "result" | "fallback";

export async function handleSavedEnvLease(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, workspaceId: string, operationId: string, route: SavedEnvLeaseRoute): Promise<unknown> {
  const input = { grant: request.headers["x-agentx-repository-grant"], workspaceId, operationId, body: bodyOf(request) };
  const context = savedEnvLeaseContext(dependencies);
  if (route === "push-login") return savedEnvPushLoginCore(context, input);
  if (route === "result") return savedEnvResultCore(context, input);
  return savedEnvFallbackCore(context, input);
}
