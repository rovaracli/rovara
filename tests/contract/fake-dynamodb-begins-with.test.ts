import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

describe("the fake table's begins_with on an index", () => {
  const db = () => {
    const fake = new FakeDynamoDb({ indexKeys: { byPlace: { partition: "placePk", sort: "placeSk" } } });
    fake.set({ pk: "a", sk: "1", placePk: "P", placeSk: "slack:T1/C9", other: "slack:T1/C9" });
    return fake;
  };
  const query = (fake: FakeDynamoDb, condition: string, names: Record<string, string> = {}) => fake.send(new QueryCommand({
    TableName: "t", IndexName: "byPlace", KeyConditionExpression: condition, ExpressionAttributeValues: { ":v": "P", ":p": "slack:T1/" },
    ...(Object.keys(names).length === 0 ? {} : { ExpressionAttributeNames: names }),
  }));

  it("accepts the sort key of the index", async () => {
    expect(((await query(db(), "placePk = :v AND begins_with(placeSk, :p)")) as { Items: unknown[] }).Items).toHaveLength(1);
  });
  it("refuses the partition key, a non-key attribute, and a sort key of another index, as DynamoDB does", async () => {
    await expect(query(db(), "placePk = :v AND begins_with(placePk, :p)")).rejects.toMatchObject({ name: "ValidationException" });
    await expect(query(db(), "placePk = :v AND begins_with(other, :p)")).rejects.toMatchObject({ name: "ValidationException" });
    await expect(query(db(), "placePk = :v AND begins_with(sk, :p)")).rejects.toMatchObject({ name: "ValidationException" });
  });
});

describe("the fake table's begins_with on the base table", () => {
  const run = (values: Record<string, unknown>, condition = "pk = :pk AND begins_with(sk, :prefix)") => {
    const fake = new FakeDynamoDb();
    fake.set({ pk: "a", sk: "1" });
    return fake.send(new QueryCommand({ TableName: "t", KeyConditionExpression: condition, ExpressionAttributeValues: values }));
  };

  it("refuses an empty prefix, as DynamoDB does (the intake poll sent one every minute)", async () => {
    await expect(run({ ":pk": "a", ":prefix": "" })).rejects.toMatchObject({ name: "ValidationException" });
  });
  it("reads a whole partition when the key condition is the partition alone, and a prefix when there is one", async () => {
    expect(((await run({ ":pk": "a" }, "pk = :pk")) as { Items: unknown[] }).Items).toHaveLength(1);
    expect(((await run({ ":pk": "a", ":prefix": "1" })) as { Items: unknown[] }).Items).toHaveLength(1);
  });
});
