// Learning v2 WL-6 wiring: what the DISPATCHER needs to build a stage's lessons from the lesson store at delivery (`deliver.ts`). The dispatcher is not the broker: it has the State table and, where the
// Team record is on, read access to the record's table (infra grants it and sets TEAM_RECORD_TABLE_NAME there). Without that table name nothing is built (no lessons are delivered), so an install with the
// Team record off does nothing here. It reads; it never writes.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, memberGithubKey, type LearnedContext, type LearnedRefs } from "@agentx/contracts";
import { createAccessCheckPort } from "../team-record/access-port.js";
import { tableTaskVisibilityPort } from "../team-record/live-audience-port.js";
import type { TeamRecordTable } from "../team-record/types.js";
import { learnedContextFromRefs } from "./deliver.js";
import { tableLessonAudiencePort, withLessonAudiences } from "./task-audience.js";
import { tableProjectRepoScopes, withProjectRepoScopes } from "./project-repo-audience.js";
import { dynamoLearningSettings, DynamoTier0Settings } from "./dynamo-settings.js";
import { DynamoLessonStore } from "./dynamo-store.js";
import { dynamoEvalSnapshotStore, dynamoSnapshotStore } from "./replay-snapshot-store.js";

export interface LessonDeliveryInput {
  /** The State table's client and name (a developer's linked accounts). */
  documentClient: { send(command: unknown): Promise<unknown> };
  stateTable: string;
  /** The Team record's table name (`TEAM_RECORD_TABLE_NAME`), or undefined where the record is off. */
  recordTable: string | undefined;
  /**
   * The install switch for lessons reaching an agent (`LEARNED_LESSONS_ENABLED`), asked at every delivery. Off: nothing is built, so a stage that was queued, parked or retried while the switch was on
   * still gets no lessons once an owner turns it off. Absent: treated as off (fail closed).
   */
  enabled?: () => boolean;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** The lesson reader for delivery, or undefined where the install has no Team record table. */
export function createLessonDelivery(input: LessonDeliveryInput): ((refs: LearnedRefs) => Promise<LearnedContext | undefined>) | undefined {
  if (input.recordTable === undefined || input.recordTable === "") return undefined;
  const now = input.now ?? Date.now;
  const table: TeamRecordTable = { documentClient: input.documentClient, tableName: input.recordTable };
  const deps = {
    store: new DynamoLessonStore(table, now),
    settings: dynamoLearningSettings(table, new DynamoTier0Settings(table)),
    access: createAccessCheckPort(table, { taskVisibility: withProjectRepoScopes(withLessonAudiences(tableTaskVisibilityPort({ documentClient: input.documentClient, tableName: input.stateTable, now }), tableLessonAudiencePort({ documentClient: input.documentClient, tableName: input.stateTable, now })), tableProjectRepoScopes({ documentClient: input.documentClient, tableName: input.stateTable }, { record: table })), ...(input.log === undefined ? {} : { log: input.log }) }),
    now,
    snapshots: dynamoSnapshotStore(table),
    evalSnapshots: dynamoEvalSnapshotStore(table, undefined, now),
    ...(input.log === undefined ? {} : { log: input.log }),
    // The reader's identity: the accounts the developer linked (a GitHub account, today), as the broker's own directory reads them.
    async identity(workspaceId: string, developerId: string) {
      const org = OrgIdSchema.safeParse(workspaceId);
      if (!org.success) throw new Error("not a company id");
      const item = ((await input.documentClient.send(new GetCommand({ TableName: input.stateTable, Key: memberGithubKey(org.data, developerId), ConsistentRead: true }))) as { Item?: { githubUserId?: unknown } }).Item;
      return { principals: typeof item?.githubUserId === "string" ? [item.githubUserId] : [], groups: [] as string[] };
    },
  };
  const enabled = input.enabled;
  // Lane 7: refs that name a frozen snapshot are a replay copy's, delivered whatever the install's switch says (the harness names this); every other ref needs the switch.
  return async (refs) => (refs.snapshotId !== undefined || enabled?.() === true ? learnedContextFromRefs(deps, refs) : undefined);
}
