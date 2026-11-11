// The mirror's state, one row per approved image, in a partition of its own (`COMPANY_IMAGE_MIRROR#<org>`, sort key the image id): the mirror function may write that partition and nothing else, and the broker reads it when it
// plans a run. A state is only for the digest it names (an image id names its digest). Rows are operational, not authority: nothing here is an approval, and a missing or damaged row only means "not copied (yet)".
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { COMPANY_IMAGE_MIRROR_ATTEMPTS_MAX, COMPANY_IMAGE_MIRROR_RETRY_MS, COMPANY_IMAGE_MIRROR_STALE_MS, CompanyImageMirrorStateSchema, companyImageMirrorPartition, type CompanyImageMirrorFailure, type CompanyImageMirrorState } from "@agentx/cloud-contracts";

export interface MirrorTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
const key = (orgId: string, imageId: string): { pk: string; sk: string } => ({ pk: companyImageMirrorPartition(orgId), sk: imageId });
const conditionFailed = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** The state of one image's copy, or undefined (no row, or a row that does not parse). Never throws for a missing row; a failed read throws (the caller treats it as not ready). */
export async function readMirrorState(table: MirrorTable, orgId: string, imageId: string): Promise<CompanyImageMirrorState | undefined> {
  const found = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key(orgId, imageId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  if (found.Item === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = found.Item;
  void _pk; void _sk; void _type;
  const parsed = CompanyImageMirrorStateSchema.safeParse(rest);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a plan or an approval should start the copier now: nothing recorded, a failure old enough to retry, or a copy that has been running so long it is taken to have died. Ready or recently started: no. */
export function mirrorNeedsStart(state: CompanyImageMirrorState | undefined, digest: string, nowMs: number): boolean {
  if (state === undefined || state.digest !== digest) return true;
  const age = nowMs - Date.parse(state.updatedAt);
  if (state.state === "failed") return age >= COMPANY_IMAGE_MIRROR_RETRY_MS;
  if (state.state === "copying") return age >= COMPANY_IMAGE_MIRROR_STALE_MS;
  return false;
}

/**
 * The copier takes the job: true when this call now owns the copy (no row, a row for another digest, a failure old enough to retry, or a copy that died). A row that is `ready` for the digest, or a copy another call is
 * running, is false. The write is conditional, so two starts of the same job never both copy.
 */
export async function claimMirror(table: MirrorTable, input: { orgId: string; imageId: string; digest: string; repository: string; nowMs: number }): Promise<boolean> {
  const existing = await readMirrorState(table, input.orgId, input.imageId).catch(() => undefined);
  if (existing !== undefined && existing.digest === input.digest && !mirrorNeedsStart(existing, input.digest, input.nowMs)) return false;
  const at = new Date(input.nowMs).toISOString();
  const next: CompanyImageMirrorState = { state: "copying", digest: input.digest, repository: input.repository, attempts: Math.min(COMPANY_IMAGE_MIRROR_ATTEMPTS_MAX, (existing?.attempts ?? 0) + 1), startedAt: at, updatedAt: at };
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName, Item: { ...key(input.orgId, input.imageId), entityType: "COMPANY_IMAGE_MIRROR", ...next },
      ConditionExpression: existing === undefined ? "attribute_not_exists(pk)" : "updatedAt = :seen",
      ...(existing === undefined ? {} : { ExpressionAttributeValues: { ":seen": existing.updatedAt } }),
    }));
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}

/**
 * The copier records its result, only while it still owns the copy (the row is `copying` and was started when this call claimed it). Answers whether it did: false means the row is gone or another copy owns it (the image
 * was revoked, or revoked and approved again, while this copy ran).
 */
export async function finishMirror(table: MirrorTable, input: { orgId: string; imageId: string; startedAt: string; nowMs: number } & ({ ok: true } | { ok: false; reason: CompanyImageMirrorFailure })): Promise<boolean> {
  const at = new Date(input.nowMs).toISOString();
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: key(input.orgId, input.imageId),
      UpdateExpression: input.ok ? "SET #state = :ready, updatedAt = :at REMOVE reason" : "SET #state = :failed, updatedAt = :at, reason = :reason",
      ConditionExpression: "#state = :copying AND startedAt = :started",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":copying": "copying", ":started": input.startedAt, ":at": at, ...(input.ok ? { ":ready": "ready" } : { ":failed": "failed", ":reason": input.reason }) },
    }));
    return true;
  } catch (error) {
    if (!conditionFailed(error)) throw error;
    return false;
  }
}

export async function deleteMirrorState(table: MirrorTable, orgId: string, imageId: string): Promise<void> {
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: key(orgId, imageId) }));
}
