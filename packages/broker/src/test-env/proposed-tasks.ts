// Setup and test health SH28: the store of PROPOSED fix tasks. A night with failing tests (and a project that turned `nightly.proposeFixTask` on) proposes one task per new set of failing tests. A proposal is
// a small record, never a task: nothing here starts work, spends money or contacts anyone. A person reads the project's list, and starts a task from one (or dismisses it).
//
// One item per set (`TESTENV#PROPOSEDTASK#<key>`, the key is the hash of the sorted test ids). Writing the same key again changes nothing, open or dismissed, for 30 days: the store IS the memory of what was proposed
// (the health logic keeps none), so a retry, a later night or a set that comes back never proposes again meanwhile. ONE proposal is open per project: a new set puts the older open one away (it stays, dismissed,
// so it is not proposed again either). Holds fixed words, a count, a day and test ids (already bounded by the nightly contract); no output, no message text. Whatever builds a task from a proposal treats
// `title` and `testIds` as DATA, never as instructions. Not behind the `nh` switch: what was stored is read and dismissed with it off.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, NIGHTLY_FAILED_MAX, agentXError, projectAllows, projectPk, type OrgId, type ProjectRole } from "@agentx/contracts";
import { z } from "zod";
import type { TestEnvDeps } from "../org/test-environment.js";
import type { ProposedFixTaskPort } from "./health.js";

/** One open proposal per project. */
export const PROPOSED_OPEN_MAX = 1;
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
  const sorted = parsed.sort((a, b) => (a.status === b.status ? b.proposedAt.localeCompare(a.proposedAt) : a.status === "open" ? -1 : 1));
  // Two open ones can exist for a moment (two nights recorded together): the newest is the open one.
  return sorted.map((entry, index) => (entry.status === "open" && index >= PROPOSED_OPEN_MAX ? { ...entry, status: "dismissed" as const } : entry));
}

/** The port the health logic calls. Repeating a call for the same set stores nothing more. Past the open cap the proposal is not stored (and nothing fails). */
export function proposedFixTaskStore(deps: TestEnvDeps): ProposedFixTaskPort {
  return {
    async propose(input) {
      const proposal = ProposedFixTaskSchema.parse({ key: input.key, title: input.title, failingCount: input.failingCount, testIds: input.testIds.slice(0, PROPOSED_TEST_IDS_MAX), proposedAt: new Date(deps.now()).toISOString(), status: "open" });
      const existing = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(input.orgId, input.project, proposal.key), ConsistentRead: true })) as { Item?: unknown }).Item;
      if (existing !== undefined) return;
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: { ...keyOf(input.orgId, input.project, proposal.key), entityType: "TEST_ENV_PROPOSED_FIX_TASK", orgId: input.orgId, project: input.project, proposal, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + TTL_MS) / 1000) },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
      } catch (error) {
        if (errorName(error) === "ConditionalCheckFailedException") return;
        throw error;
      }
      // One open per project: the older open ones are put away (and kept, so their sets are not proposed again).
      for (const row of await rowsOf(deps, input.orgId, input.project)) {
        if (typeof row.pk !== "string" || typeof row.sk !== "string" || row.sk === `${PREFIX}${proposal.key}` || typeof row.dismissedAt === "string") continue;
        // Only an OLDER one is put away (a tie goes to the larger key), so two proposals that land together leave exactly one open.
        const theirs = ProposedFixTaskSchema.safeParse(row.proposal);
        if (!theirs.success || theirs.data.proposedAt > proposal.proposedAt || (theirs.data.proposedAt === proposal.proposedAt && theirs.data.key > proposal.key)) continue;
        await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: { pk: row.pk, sk: row.sk }, UpdateExpression: "SET dismissedAt = :at", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":at": proposal.proposedAt } })).catch(() => undefined);
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
