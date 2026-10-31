// Meta repo lane F (F2): the notice a project's maintainers get when an intake source keeps failing. Fixed words and ids only: the source's system name (a checked short name), the project's
// name and a number of minutes; never a tracker's message. One item per maintainer, in the maintainer's own partition of the org (`intakeNoticeKey`), like a trigger's notice.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, intakeNoticeKey } from "@agentx/contracts";
import type { IntakeNotice } from "../triggers/poll-intake.js";
import type { IntakeTable } from "./store.js";

/** The most maintainers one notice goes to. */
export const INTAKE_NOTICE_RECIPIENTS_MAX = 20;
const NOTICE_KEPT_SECONDS = 30 * 86_400;

/** The words of a notice. */
export function intakeNoticeText(notice: Pick<IntakeNotice, "project" | "system" | "failingMinutes">): string {
  return `Rovara can't read the ${notice.system} tickets for ${notice.project}: reading them has failed for ${String(notice.failingMinutes)} minutes. Check the connection in the project's settings. Nothing was started, and nothing will be started twice.`;
}

/** Writes the notice for each maintainer (at most `INTAKE_NOTICE_RECIPIENTS_MAX`). Throws if a write fails, so the poll keeps the notice to send again. */
export async function writeIntakeNotice(table: IntakeTable, maintainers: readonly string[], notice: IntakeNotice): Promise<number> {
  const at = new Date(table.now()).toISOString();
  const text = intakeNoticeText(notice);
  let written = 0;
  for (const developerId of maintainers.slice(0, INTAKE_NOTICE_RECIPIENTS_MAX)) {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: {
        ...intakeNoticeKey(notice.orgId, developerId, at, notice.sourceId), entityType: "INTAKE_NOTICE", orgId: notice.orgId, project: notice.project, sourceId: notice.sourceId,
        developerId, code: notice.code, text, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(table.now() / 1000) + NOTICE_KEPT_SECONDS,
      },
    }));
    written += 1;
  }
  return written;
}
