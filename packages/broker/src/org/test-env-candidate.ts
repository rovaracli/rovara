// TE-2: the stored result of a proposal's CANDIDATE check. A candidate check prepares a fresh workspace from the commands a test-environment proposal would put in the project's settings (the settings' own commands
// plus the proposal's), so the commands are run BEFORE they are applied. Its record is keyed by (project, proposal digest, settings revision) and holds the workspace (whose status is the result, read live as the
// project's own setup check is) and the exact command lists the check ran. Nothing else reads a candidate: the Prove derives its report from it, and the approval writes into the settings only what it ran.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, PreparePinsSchema, ProjectCommandSchema, TestServicesUsageRecordSchema, projectPk, type OrgId, type OrgKey, type PreparePins, type ProjectCommand, type TestServicesUsageRecord } from "@agentx/contracts";
import { z } from "zod";
import { TEST_ENV_PROPOSAL_TTL_MS } from "./test-environment.js";

const REVISION_WIDTH = 8;
export const CANDIDATE_CHECK_ENTITY = "TEST_ENV_CANDIDATE_CHECK";
export const candidateCheckKey = (orgId: OrgId, project: string, digest: string, revision: number): OrgKey => ({ pk: projectPk(orgId, project), sk: `TESTENV#CANDIDATE#${digest}#${String(revision).padStart(REVISION_WIDTH, "0")}` });
/** A candidate record lives as long as the proposal it checks. */
export const candidateExpiry = (nowMs: number): number => Math.floor((nowMs + TEST_ENV_PROPOSAL_TTL_MS) / 1000);

const CommandsSchema = z.array(ProjectCommandSchema).max(64);
const CandidateCheckSchema = z.object({
  workspaceId: z.string().min(1).max(100), revision: z.number().int().positive(), startedAt: z.string().min(1).max(40), startedBy: z.string().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/u), setup: CommandsSchema, readiness: CommandsSchema,
  /** `setup_run`: the proposal this checked was marked as a setup run's when the check started (the mark outlives the proposal item). */
  origin: z.literal("setup_run").optional(),
  /** SU-1 addendum 3: the commit each repository was prepared at (the pins the preparation was sent). A setup run's proposal is proved only by a check made at the commits its run used. */
  pins: PreparePinsSchema.optional(),
  /** Test services: what the check reported of the dependencies it started (the worker's facts, validated). The Prove derives its two dependency steps from it; a record that does not read back is no record. */
  usage: TestServicesUsageRecordSchema.optional(),
});
export interface CandidateCheck { workspaceId: string; revision: number; startedAt: string; startedBy: string; digest: string; setup: ProjectCommand[]; readiness: ProjectCommand[]; origin?: "setup_run" | undefined; pins?: PreparePins | undefined; usage?: TestServicesUsageRecord | undefined }

type Send = { send(command: unknown): Promise<unknown> };

/**
 * The candidate check of `digest` at settings revision `revision`, or undefined: none was started, it expired, or the stored item does not read back as this project's check for exactly this digest and revision
 * (a damaged item is never read as a result).
 */
export async function readCandidateCheck(deps: { documentClient: Send; tableName: string; now: () => number }, orgId: OrgId, project: string, digest: string, revision: number): Promise<CandidateCheck | undefined> {
  const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: candidateCheckKey(orgId, project, digest, revision), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined) return undefined;
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires * 1000 <= deps.now()) return undefined;
  if (item.entityType !== CANDIDATE_CHECK_ENTITY || item.orgId !== orgId || item.project !== project) return undefined;
  const parsed = CandidateCheckSchema.safeParse(item);
  if (!parsed.success || parsed.data.digest !== digest || parsed.data.revision !== revision) return undefined;
  return parsed.data;
}

/**
 * Keeps the usage record a candidate check reported, on the check's own record. Validated here (bounded, strict, no secret-shaped name): a report that does not parse is not kept. Only the first record is kept
 * (a repeated report changes nothing), and only for a check that exists and has not expired. Returns whether a record was written. Never throws.
 */
export async function recordCandidateUsage(deps: { documentClient: Send; tableName: string; now: () => number }, input: { orgId: OrgId; project: string; digest: string; revision: number; usage: unknown }): Promise<boolean> {
  const parsed = TestServicesUsageRecordSchema.safeParse(input.usage);
  if (!parsed.success) return false;
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: candidateCheckKey(input.orgId, input.project, input.digest, input.revision),
      UpdateExpression: "SET #usage = :usage", ConditionExpression: "attribute_exists(pk) AND #entity = :entity AND attribute_not_exists(#usage) AND #expiry > :nowSeconds",
      ExpressionAttributeNames: { "#usage": "usage", "#entity": "entityType", "#expiry": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":usage": parsed.data, ":entity": CANDIDATE_CHECK_ENTITY, ":nowSeconds": Math.floor(deps.now() / 1000) },
    }));
    return true;
  } catch {
    return false;
  }
}
