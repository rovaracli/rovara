// TRW-4 (owner, 2026-11-02): a Team record row is stored only when its author is linked to a Rovara person, because only then can a person erase reach it. A row whose author is not linked is
// skipped, and the skip is COUNTED per project and source (`SKIPPED#`, in the org's own partition: counts only, no words, no ids) so that a maintainer can see what the record is leaving out and why.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { queryPrefix } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export const SKIPPED_PREFIX = "SKIPPED#";
const keyPart = (value: string | undefined): string => (value === undefined || value === "" ? "_" : value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100));

/** Whether a draft's author must be a linked person. Rovara's own rows name the person who acted in Rovara; a bot (trust `system`) has no person to erase. Everything else (Slack, GitHub and other code hosts, Linear, Jira, MCP sources) needs a linked author. */
export function needsLinkedAuthor(draft: { source: string; actor?: { developerId?: string | undefined; trust: string } | undefined; trust?: string | undefined; text?: string | undefined; kind?: string | undefined }): boolean {
  if (draft.source === "rovara") return false;
  if (draft.actor?.trust === "system") return false;
  // A code host's CI verdict (kind github.ci, for every host) has no author and no words: nothing of a person's to erase. No other kind is exempt.
  if (draft.kind === "github.ci" && draft.actor === undefined && draft.trust === "system" && draft.text === undefined) return false;
  return draft.actor?.developerId === undefined;
}

export interface UnlinkedCounter {
  count(orgId: OrgId, project: string | undefined, source: string): Promise<void>;
  read(orgId: OrgId, project: string | undefined): Promise<Record<string, number>>;
}

export function unlinkedCounter(table: TeamRecordTable, now: () => number): UnlinkedCounter {
  return {
    async count(orgId, project, source) {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: { pk: teamRecordPk(orgId), sk: `${SKIPPED_PREFIX}${keyPart(project)}#${keyPart(source)}` },
        UpdateExpression: "ADD skipped :one SET entityType = :type, orgId = :org, lastAt = :at",
        ExpressionAttributeValues: { ":one": 1, ":type": "TEAM_RECORD_SKIPPED", ":org": orgId, ":at": new Date(now()).toISOString() },
      }));
    },
    async read(orgId, project) {
      const found = await queryPrefix(table, orgId, undefined, `${SKIPPED_PREFIX}${keyPart(project)}#`, 100);
      const out: Record<string, number> = {};
      for (const item of found.items) if (typeof item.sk === "string" && typeof item.skipped === "number") out[item.sk.slice(`${SKIPPED_PREFIX}${keyPart(project)}#`.length)] = item.skipped;
      return out;
    },
  };
}
