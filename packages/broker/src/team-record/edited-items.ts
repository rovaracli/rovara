// TRW-4 fix round 1 (B1): the items an edit by someone other than the author touched (`EditedByOtherPort`, sources/ports.ts). One item per marked source item in the org's record partition, keyed by a hash of the
// source, system and id. It holds no text and no person, and goes with the company erase (`EDITED#` is one of its workspace prefixes).
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, OrgIdSchema } from "@agentx/contracts";
import type { EditedByOtherPort } from "./sources/ports.js";
import type { TeamRecordTable } from "./types.js";

export const EDITED_PREFIX = "EDITED#";

const keyOf = (input: { workspaceId: string; source: string; system: string; id: string }): { pk: string; sk: string; orgId: string } => {
  const orgId = OrgIdSchema.parse(input.workspaceId);
  return { pk: teamRecordPk(orgId), sk: `${EDITED_PREFIX}${createHash("sha256").update(`${input.source}\u0000${input.system}\u0000${input.id}`).digest("hex")}`, orgId };
};

export function createEditedItemsPort(table: TeamRecordTable, now: () => number): EditedByOtherPort {
  return {
    async mark(input) {
      const { pk, sk, orgId } = keyOf(input);
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { pk, sk, entityType: "TEAM_RECORD_EDITED_BY_OTHER", orgId, at: new Date(now()).toISOString() } }));
    },
    async isMarked(input) {
      const { pk, sk } = keyOf(input);
      return ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk, sk }, ConsistentRead: true }))) as { Item?: unknown }).Item !== undefined;
    },
  };
}
