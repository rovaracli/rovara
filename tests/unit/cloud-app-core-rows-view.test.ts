// The view of a core task row for Cloud's readers (cloud/app/core-task-rows.ts), and the retention of the root's own rows.
import { BatchGetCommand, GetCommand, TransactGetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { retentionFor, viewCoreTaskRowsClient, withCloudRetention, coreInUseKey } from "../../packages/broker/src/cloud/app/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const CORE = { pk: "DEVTASK#t-core", sk: "META", entityType: "DEVTASK", companyId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "t-core" };
const CLOUD = { pk: "DEVTASK#t-cloud", sk: "META", entityType: "DEVTASK", orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "t-cloud" };
const OTHER = { pk: "DEVTASK#t-core", sk: "PEOPLE", companyId: "org_aaaaaaaaaaaaaaaaaaaa", revision: 1 };

const world = () => { const db = new FakeDynamoDb(); for (const row of [CORE, CLOUD, OTHER]) db.set(row); return viewCoreTaskRowsClient(db as never) as unknown as { send(command: unknown): Promise<Record<string, unknown>>; items: Map<string, unknown> }; };

describe("a core task row, as Cloud's readers see it", () => {
  it("a Get of a task META row that names only companyId reads as having orgId too; a Cloud row and other rows are untouched", async () => {
    const client = world();
    const get = async (key: { pk: string; sk: string }) => (await client.send(new GetCommand({ TableName: "state", Key: key }))).Item as Record<string, unknown> | undefined;
    expect(await get(CORE)).toMatchObject({ companyId: CORE.companyId, orgId: CORE.companyId });
    expect(await get(CLOUD)).toEqual(expect.objectContaining({ orgId: CLOUD.orgId }));
    expect((await get(CLOUD))?.["companyId"]).toBeUndefined();
    expect((await get(OTHER))?.["orgId"]).toBeUndefined();
    expect(await get({ pk: "DEVTASK#nope", sk: "META" })).toBeUndefined();
  });

  it("a BatchGet and a TransactGet see the same", async () => {
    const client = world();
    const batch = await client.send(new BatchGetCommand({ RequestItems: { state: { Keys: [{ pk: CORE.pk, sk: CORE.sk }, { pk: CLOUD.pk, sk: CLOUD.sk }, { pk: OTHER.pk, sk: OTHER.sk }] } } }));
    const items = (batch["Responses"] as Record<string, Array<Record<string, unknown>>>)["state"]!;
    expect(items.find((item) => item["taskId"] === "t-core")?.["orgId"]).toBe(CORE.companyId);
    expect(items.find((item) => item["sk"] === "PEOPLE")?.["orgId"]).toBeUndefined();
    const transact = await client.send(new TransactGetCommand({ TransactItems: [{ Get: { TableName: "state", Key: { pk: CORE.pk, sk: CORE.sk } } }, { Get: { TableName: "state", Key: { pk: OTHER.pk, sk: OTHER.sk } } }] }));
    const responses = transact["Responses"] as Array<{ Item?: Record<string, unknown> }>;
    expect(responses[0]?.Item?.["orgId"]).toBe(CORE.companyId);
    expect(responses[1]?.Item?.["orgId"]).toBeUndefined();
  });

  it("the view writes nothing and keeps the rest of the client", async () => {
    const db = new FakeDynamoDb();
    db.set(CORE);
    const client = viewCoreTaskRowsClient(db as never) as unknown as { send(command: unknown): Promise<unknown>; items: Map<string, Record<string, unknown>> };
    await client.send(new GetCommand({ TableName: "state", Key: { pk: CORE.pk, sk: CORE.sk } }));
    expect(db.get(CORE.pk, CORE.sk)?.["orgId"]).toBeUndefined();
    expect(client.items).toBe(db.items);
  });
});

describe("the root's own rows keep what Cloud keeps", () => {
  it("the in-use mark and the engine stamp are kinds Cloud does not expire: a core expiry on them is removed before the write", () => {
    for (const kind of ["CORE_ENGINE_IN_USE", "TASK_ENGINE"]) {
      expect(retentionFor(kind), kind).toBe("strip");
      expect(INDEX_EXPIRY_ATTRIBUTE in withCloudRetention({ pk: "p", sk: "s", entityType: kind, [INDEX_EXPIRY_ATTRIBUTE]: 1 }), kind).toBe(false);
    }
    expect(coreInUseKey("org_aaaaaaaaaaaaaaaaaaaa").sk).toBe("MARK");
  });
});
