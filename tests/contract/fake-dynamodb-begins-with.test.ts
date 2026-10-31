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
