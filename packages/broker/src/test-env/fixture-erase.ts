// Test services, slice 3 (M3): what a company close and a person erase do to the fixture store (test-env/fixture-store.ts).
//   - A company close deletes every row (`ORG#<org>` / `FIXTURE#...`) and then every object under `private/<org>/fixtures/`. Rows go first, so nothing can be delivered while the objects are being removed; a pass that
//     does not finish is continued by the evidence erase's pending record (rovara-code/evidence-erase.ts calls these from its company-close and person-erase walks, NOT behind the `tx` switch: a set kept while the switch was on is
//     erased after it was turned off too).
//   - A person erase replaces the person's id in `submittedBy`, `decidedBy` and `withdrawnBy` with the 64-zero stand-in (as the Team record's erase does for `addedBy`). The set, its digest and its status stay: they are the
//     company's. The row's `version` moves with the change, so a decision made from an older read of the row cannot put the id back.
import { DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, orgPk } from "@agentx/contracts";

/** The stand-in for an erased person (the same value the Team record's erase writes). */
export const FIXTURE_ERASED_ACTOR = "0".repeat(64);
export const FIXTURE_ROW_PREFIX = "FIXTURE#";
/** The fields of a fixture row that hold a developer id. */
export const FIXTURE_PERSON_FIELDS = ["submittedBy", "decidedBy", "withdrawnBy"] as const;

export interface FixtureErasePorts {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now?: (() => number) | undefined;
}

/** The prefix of every fixture object of an org (Public Cloud: the Rovara bucket's `private/` prefix). */
export const fixtureObjectsOfOrg = (orgId: string, prefix = "private"): string => `${prefix}/${OrgIdSchema.parse(orgId)}/fixtures/`;

type Key = Record<string, unknown>;
const PAGES_MAX = 200;

/** Every fixture row key of an org, a page at a time. Calls `visit` for each item; false when `stop` passed before the end. */
async function eachRow(ports: FixtureErasePorts, orgId: string, stop: number, visit: (item: Record<string, unknown>) => Promise<void>): Promise<boolean> {
  const now = ports.now ?? Date.now;
  const partition = orgPk(OrgIdSchema.parse(orgId));
  let start: Key | undefined;
  for (let page = 0; page < PAGES_MAX; page += 1) {
    if (now() >= stop) return false;
    const out = (await ports.documentClient.send(new QueryCommand({
      TableName: ports.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)", ExpressionAttributeValues: { ":pk": partition, ":sk": FIXTURE_ROW_PREFIX },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }))) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Key };
    for (const item of out.Items ?? []) await visit(item);
    start = out.LastEvaluatedKey;
    if (start === undefined) return true;
  }
  return false;
}

/** Deletes every fixture row of the org. True when the walk reached the end before `stop`. */
export async function deleteFixtureRowsOfOrg(ports: FixtureErasePorts, orgId: string, stop: number): Promise<boolean> {
  const partition = orgPk(OrgIdSchema.parse(orgId));
  return eachRow(ports, orgId, stop, async (item) => {
    if (typeof item["sk"] === "string" && item["sk"].startsWith(FIXTURE_ROW_PREFIX)) await ports.documentClient.send(new DeleteCommand({ TableName: ports.tableName, Key: { pk: partition, sk: item["sk"] } }));
  });
}

/** Replaces the developer's id in every fixture row of the org that names them. True when the walk reached the end before `stop`. */
export async function scrubFixtureDevelopers(ports: FixtureErasePorts, orgId: string, developerId: string, stop: number): Promise<boolean> {
  if (developerId.trim() === "") return true;
  const partition = orgPk(OrgIdSchema.parse(orgId));
  return eachRow(ports, orgId, stop, async (item) => {
    if (typeof item["sk"] !== "string" || !item["sk"].startsWith(FIXTURE_ROW_PREFIX)) return;
    for (const field of FIXTURE_PERSON_FIELDS) {
      if (item[field] !== developerId) continue;
      try {
        await ports.documentClient.send(new UpdateCommand({
          TableName: ports.tableName, Key: { pk: partition, sk: item["sk"] },
          UpdateExpression: "SET #field = :stand, #version = #version + :one", ConditionExpression: "#field = :developer",
          ExpressionAttributeNames: { "#field": field, "#version": "version" }, ExpressionAttributeValues: { ":stand": FIXTURE_ERASED_ACTOR, ":developer": developerId, ":one": 1 },
        }));
      } catch (error) {
        // The row changed under the walk (a decision, another field's scrub): this pass is unfinished and the erase is repeated, which reads the row again. Never a silent skip.
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw new Error("a fixture row changed while a person was erased", { cause: error });
        throw error;
      }
    }
  });
}
