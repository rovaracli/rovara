import type { FakeDynamoDb } from "./fake-dynamodb.js";

/** The deployed pre-org shape, retaining charges and provenance but no org field on either row. */
export function legacySlackThread(db: FakeDynamoDb, workspaceId: string) {
  const workspace = db.get(`WORKSPACE#${workspaceId}`, "META");
  const thread = db.find((row) => row.entityType === "SLACK_THREAD" && row.workspaceId === workspaceId)[0];
  if (workspace === undefined || thread === undefined || typeof workspace.ownerKey !== "string") throw new Error("missing legacy fixture");
  const legacy: Record<string, unknown> = { ...thread, pk: `SLACK_THREAD#${workspace.ownerKey}` };
  delete legacy.orgId;
  db.delete({ pk: String(thread.pk), sk: String(thread.sk) });
  db.set(legacy);
  delete workspace.orgId;
  return legacy;
}
