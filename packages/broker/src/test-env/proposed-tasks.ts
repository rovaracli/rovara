// Setup and test health SH28: the store of PROPOSED fix tasks. A night with failing tests (and a project that turned `nightly.proposeFixTask` on) proposes one task per new set of failing tests. A proposal is
// a small record, never a task: nothing here starts work, spends money or contacts anyone. A person reads the project's list, and starts a task from one (or dismisses it).
//
// One item per set (`TESTENV#PROPOSEDTASK#<key>`, the key is the hash of the sorted test ids). Writing the same key again changes nothing, dismissed or not, so a retry or a later night never brings back a
// proposal a person put away. At most `PROPOSED_OPEN_MAX` are open per project: the rest are not stored (a project with that many unread proposals does not need another). Each expires after 30 days.
// Holds fixed words, a count, a day and test ids (already bounded by the nightly contract); no output, no message text. Not behind the `nh` switch: what was stored is read, dismissed and erased with it off.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, NIGHTLY_FAILED_MAX, agentXError, projectAllows, projectPk, type OrgId, type ProjectRole } from "@agentx/contracts";
import { z } from "zod";
import type { TestEnvDeps } from "../org/test-environment.js";
import type { ProposedFixTaskPort } from "./health.js";

export const PROPOSED_OPEN_MAX = 20;
export const PROPOSED_TEST_IDS_MAX = 20;
const TTL_MS = 30 * 86_400_000;
const PREFIX = "TESTENV#PROPOSEDTASK#";
const PAGE = 50;

const Key = z.string().regex(/^[a-f0-9]{64}$/u);
const TestId = z.string().min(1).max(500).regex(/^[^\p{Cc}\p{Cf}\s]+$/u);
export const ProposedFixTaskSchema = z
  .object({
    key: Key,
    /** Fixed words, a count, a branch name of plain characters and a day. */
    title: z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u),
    failingCount: z.number().int().min(1).max(NIGHTLY_FAILED_MAX),
    testIds: z.array(TestId).max(PROPOSED_TEST_IDS_MAX),
    proposedAt: z.string().datetime(),
    status: z.enum(["open", "dismissed"]),
  })
  .strict();
export type ProposedFixTask = z.infer<typeof ProposedFixTaskSchema>;

const keyOf = (orgId: OrgId, project: string, key: string) => ({ pk: projectPk(orgId, project), sk: `${PREFIX}${key}` });
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function rowsOf(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < 4; page += 1) {
    const reply = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PREFIX },
      ConsistentRead: true, Limit: PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    out.push(...(reply.Items ?? []));
    if (reply.LastEvaluatedKey === undefined) break;
    start = reply.LastEvaluatedKey;
  }
  return out;
}

/** The project's proposals, open first and newest first. An item that does not read back is left out (never shown, never guessed at). */
export async function listProposedFixTasks(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<ProposedFixTask[]> {
  const parsed = (await rowsOf(deps, orgId, project)).flatMap((row) => {
    const found = ProposedFixTaskSchema.safeParse(row.proposal);
    return found.success ? [{ ...found.data, status: typeof row.dismissedAt === "string" ? "dismissed" as const : "open" as const }] : [];
  });
  return parsed.sort((a, b) => (a.status === b.status ? b.proposedAt.localeCompare(a.proposedAt) : a.status === "open" ? -1 : 1));
}

/** The port the health logic calls. Repeating a call for the same set stores nothing more. Past the open cap the proposal is not stored (and nothing fails). */
export function proposedFixTaskStore(deps: TestEnvDeps): ProposedFixTaskPort {
  return {
    async propose(input) {
      const proposal = ProposedFixTaskSchema.parse({ key: input.key, title: input.title, failingCount: input.failingCount, testIds: input.testIds.slice(0, PROPOSED_TEST_IDS_MAX), proposedAt: new Date(deps.now()).toISOString(), status: "open" });
      const existing = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(input.orgId, input.project, proposal.key), ConsistentRead: true })) as { Item?: unknown }).Item;
      if (existing !== undefined) return;
      const open = (await rowsOf(deps, input.orgId, input.project)).filter((row) => typeof row.dismissedAt !== "string").length;
      if (open >= PROPOSED_OPEN_MAX) return;
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: { ...keyOf(input.orgId, input.project, proposal.key), entityType: "TEST_ENV_PROPOSED_FIX_TASK", orgId: input.orgId, project: input.project, proposal, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + TTL_MS) / 1000) },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    },
  };
}

/** A maintainer puts a proposal away. It stays (dismissed) until it expires, so the same set is not proposed again meanwhile. */
export async function dismissProposedFixTask(deps: TestEnvDeps, input: { orgId: OrgId; project: string; role: ProjectRole | undefined; key: string }): Promise<void> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can dismiss a proposed task");
  if (!Key.safeParse(input.key).success) throw agentXError("CONFIG_INVALID", "key: not a proposal");
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: keyOf(input.orgId, input.project, input.key), UpdateExpression: "SET dismissedAt = :at", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":at": new Date(deps.now()).toISOString() },
    }));
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") throw agentXError("CHANGE_STALE", "that proposed task is gone");
    throw error;
  }
}

/** Deletes the project's proposals (a project archive or a company close). Bounded to a few pages; the 30 day expiry takes what is left. */
export async function eraseProposedFixTasks(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<void> {
  for (const row of await rowsOf(deps, orgId, project)) {
    if (typeof row.pk === "string" && typeof row.sk === "string") await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: row.pk, sk: row.sk } }));
  }
}
