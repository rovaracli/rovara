// Saved project images (SV wiring): the three handlers over the stored records. The rules are in ../../test-env/saved-env-lease.ts; this file only reads the operation and its workspace.
import { agentXError } from "@agentx/contracts";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { operationKey, requireOperation } from "../cancellation.js";
import { requireWorkspace } from "./records.js";
import { savedEnvFallbackCore, SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION, type SavedEnvLeaseContext } from "../../test-env/saved-env-lease.js";
import { parseBody } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import type { AdaptedHttpRequest } from "../lambda.js";

export function savedEnvLeaseContext(dependencies: AwsBrokerDependencies): SavedEnvLeaseContext {
  return {
    deps: dependencies.savedEnvDeps,
    inspectGrant: (grant) => dependencies.repositoryGrants.inspect(grant),
    countPushLogin: (workspace, operation) => countOperationAttribute(dependencies, workspace, operation, "savedEnvPushLoginCount", SAVED_ENV_PUSH_LOGIN_MAX_PER_OPERATION),
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

/** The fallback report of a preparation that started from an image (the only one of these routes that answers to the repository grant). */
export async function handleSavedEnvFallback(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, workspaceId: string, operationId: string): Promise<unknown> {
  return savedEnvFallbackCore(savedEnvLeaseContext(dependencies), { grant: request.headers["x-agentx-repository-grant"], workspaceId, operationId, body: bodyOf(request) });
}

/** One more on a counter of the operation's record, only while it is under the limit (a conditional ADD, so two requests at once cannot both pass the last slot). */
async function countOperationAttribute(dependencies: AwsBrokerDependencies, workspaceId: string, operationId: string, attribute: "savedEnvPushLoginCount", max: number): Promise<boolean> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: operationKey(workspaceId, operationId),
      UpdateExpression: `ADD ${attribute} :one`,
      ConditionExpression: `attribute_exists(pk) AND (attribute_not_exists(${attribute}) OR ${attribute} < :max)`,
      ExpressionAttributeValues: { ":one": 1, ":max": max },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
