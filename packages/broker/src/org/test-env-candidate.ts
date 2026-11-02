// TE-2: the stored result of a proposal's CANDIDATE check. A candidate check prepares a fresh workspace from the commands a test-environment proposal would put in the project's settings (the settings' own commands
// plus the proposal's), so the commands are run BEFORE they are applied. Its record is keyed by (project, proposal digest, settings revision) and holds the workspace (whose status is the result, read live as the
// project's own setup check is) and the exact command lists the check ran. Nothing else reads a candidate: the Prove derives its report from it, and the approval writes into the settings only what it ran.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, ProjectCommandSchema, projectPk, type OrgId, type OrgKey, type ProjectCommand } from "@agentx/contracts";
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
});
export interface CandidateCheck { workspaceId: string; revision: number; startedAt: string; startedBy: string; digest: string; setup: ProjectCommand[]; readiness: ProjectCommand[] }

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
