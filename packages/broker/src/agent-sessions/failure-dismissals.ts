// The failures a person dismissed (Home's "Dismiss", and the Work list's: one store). A failed session's card is `failure:<sessionId>`, and what a dismissal hides is one HAPPENING of it (`occurrence`), so a session
// that fails again comes back. Home reads these rows to leave a card off its list and its count; the Live wall's Failed filter (the Work list's Needs attention) reads the same rows, so a failure the owner dismissed is
// in neither. Rows live in the person's own partition and expire (`HOME_DISMISS_DAYS`).
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, homeDismissedKey, type AgentSessionRecord, type OrgId } from "@rovara-code/contracts";
import { HomeCardIdSchema } from "@agentx/cloud-contracts";
import type { Item } from "../agents/table-writes.js";

/** The most of a person's dismissals read. */
export const HOME_DISMISSED_READ_MAX = 300;
const PAGE = 100;
/** The form of an occurrence as a dismissal link carries it and a dismissal row keeps it. */
export const OCCURRENCE_PATTERN = /^[A-Za-z0-9:.+_-]{1,64}$/u;

/** The Home card id of a session's failure (and the id its dismissal is kept under). */
export const failureCardIdOf = (sessionId: string): string => `failure:${sessionId}`;

/** Which happening of a session's failure this is: its end (an ended session) or its summary revision (an open one whose last run failed). A dismissal hides this one and not a later one. */
export const failureOccurrenceOf = (session: Pick<AgentSessionRecord, "endedAt" | "summaryRevision">): string => (session.endedAt !== undefined ? `ended:${session.endedAt}` : `rev:${String(session.summaryRevision)}`);

/**
 * The cards the caller dismissed, each with the occurrence they dismissed, whose dismissal has not run out (the table deletes late). One query, a fixed number of rows at most. A row that names no
 * occurrence is left out: it hides nothing.
 */
export async function homeDismissalsOf(
  deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number; log?: ((entry: Record<string, unknown>) => void) | undefined },
  caller: { orgId: OrgId; developerId: string },
): Promise<Map<string, string>> {
  const pk = homeDismissedKey(caller.orgId, caller.developerId, "x:x").pk;
  const found = new Map<string, string>();
  const nowSeconds = Math.floor(deps.now() / 1000);
  let start: Record<string, unknown> | undefined;
  let read = 0;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, Limit: PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      read += 1;
      const expires = item[INDEX_EXPIRY_ATTRIBUTE];
      if (item["orgId"] !== caller.orgId || (typeof expires === "number" && expires <= nowSeconds)) continue;
      const cardId = HomeCardIdSchema.safeParse(item["cardId"]);
      const occurrence = item["occurrence"];
      if (cardId.success && typeof occurrence === "string" && OCCURRENCE_PATTERN.test(occurrence)) found.set(cardId.data, occurrence);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && read < HOME_DISMISSED_READ_MAX);
  if (start !== undefined) (deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "home.dismissals_truncated" });
  return found;
}
