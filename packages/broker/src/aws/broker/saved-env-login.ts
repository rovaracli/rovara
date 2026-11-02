// Saved environments (SH25, review M1): the route's handler. The rules are in ../../test-env/saved-env-login.ts; this file only reads the stored records they ask for.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError } from "@agentx/contracts";
import { operationKey, requireOperation } from "../cancellation.js";
import { requireWorkspace } from "./records.js";
import { SAVED_ENV_LOGIN_MAX_PER_OPERATION, exchangeSavedEnvLoginCore } from "../../test-env/saved-env-login.js";
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
    countLogin: (workspace, operation) => countSavedEnvLogin(dependencies, workspace, operation),
    login: async (input) => login?.(input),
  }, { grant: request.headers["x-agentx-repository-grant"], workspaceId, operationId, body: parseBodyObject(request.body) });
}

/** One more login on the operation's record, only while it is under the limit (a conditional ADD, so two requests at once cannot both pass the last slot). */
export async function countSavedEnvLogin(dependencies: AwsBrokerDependencies, workspaceId: string, operationId: string): Promise<boolean> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: operationKey(workspaceId, operationId),
      UpdateExpression: "ADD savedEnvLoginCount :one",
      ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(savedEnvLoginCount) OR savedEnvLoginCount < :max)",
      ExpressionAttributeValues: { ":one": 1, ":max": SAVED_ENV_LOGIN_MAX_PER_OPERATION },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

function parseBodyObject(body: string | undefined): unknown {
  const parsed = parseBody(body);
  if (parsed === undefined || parsed === null) throw agentXError("CONFIG_INVALID", "saved environment login request is invalid");
  return parsed;
}
