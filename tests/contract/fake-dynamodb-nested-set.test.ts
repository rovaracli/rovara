import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

describe("FakeDynamoDb SET into a map", () => {
  it("sets a key inside an existing map, conditions on it, and refuses a missing parent", async () => {
    const db = new FakeDynamoDb();
    const send = (command: Parameters<FakeDynamoDb["send"]>[0]) => db.send(command);
    await send(new PutCommand({ TableName: "t", Item: { pk: "a", sk: "b", members: {} } }));
    const update = (value: string) => send(new UpdateCommand({
      TableName: "t", Key: { pk: "a", sk: "b" }, UpdateExpression: "SET #m.#p = :v", ConditionExpression: "attribute_not_exists(#m.#p) OR #m.#p < :v",
      ExpressionAttributeNames: { "#m": "members", "#p": "U1" }, ExpressionAttributeValues: { ":v": value },
    }));
    await update("2026|0");
    await expect(update("2026|0")).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    await update("2026|1");
    expect(db.find((item) => item.pk === "a")[0]).toMatchObject({ members: { U1: "2026|1" } });
    expect(Object.keys(db.find((item) => item.pk === "a")[0] ?? {})).not.toContain("members.U1");
    await send(new PutCommand({ TableName: "t", Item: { pk: "c", sk: "d" } }));
    await expect(send(new UpdateCommand({ TableName: "t", Key: { pk: "c", sk: "d" }, UpdateExpression: "SET #m.#p = :v", ExpressionAttributeNames: { "#m": "members", "#p": "U1" }, ExpressionAttributeValues: { ":v": "x" } }))).rejects.toMatchObject({ name: "ValidationException" });
  });
});
