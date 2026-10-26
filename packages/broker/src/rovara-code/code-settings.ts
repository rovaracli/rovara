// Rovara Code (Plan 6 Task 14): a project's code settings, read only. Task 19 writes them; until a project has any, it has the defaults (self-approval off, squash,
// no reviewers). An item that does not parse is read as the defaults too, which is the cautious reading of every setting.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { CodeSettingsSchema, DEFAULT_CODE_SETTINGS, codeSettingsKey, type CodeSettings, type OrgId } from "@agentx/contracts";

export interface CodeSettingsReader {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** The project's code settings, read fresh (never cached: a changed setting applies to the next decision). */
export async function readCodeSettings(deps: CodeSettingsReader, orgId: OrgId, project: string): Promise<CodeSettings> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: codeSettingsKey(orgId, project), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = found.Item;
  if (item === undefined) return DEFAULT_CODE_SETTINGS;
  const parsed = CodeSettingsSchema.safeParse({
    allowSelfApproval: item["allowSelfApproval"], mergeMethod: item["mergeMethod"], codeReviewers: item["codeReviewers"], revision: item["revision"],
  });
  return parsed.success ? parsed.data : DEFAULT_CODE_SETTINGS;
}
