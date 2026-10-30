import { expect, it } from "vitest";
import { GetCommand, TransactGetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
it("native financial snapshot preserves missing positions and returns independent copies", async () => {
  const db = new FakeDynamoDb(), a = { pk: "POLICY", sk: "A" }, b = { pk: "POLICY", sk: "B" };
  db.set({ ...a, policy: { amount: 1 } }); db.set({ ...b, policy: { amount: 2 } });
  const result = await db.send(new TransactGetCommand({ TransactItems: [a, { pk: "MISSING", sk: "META" }, b].map(Key => ({ Get: { TableName: "state", Key } })) }));
  expect(result).toMatchObject({ Responses: [{ Item: { ...a, policy: { amount: 1 } } }, {}, { Item: { ...b, policy: { amount: 2 } } }] });
  expect(db.commandNames()).toEqual(["TransactGetCommand"]);
  db.set({ ...a, policy: { amount: 3 } });
  expect(result).toMatchObject({ Responses: [{ Item: { ...a, policy: { amount: 1 } } }, {}, { Item: { ...b, policy: { amount: 2 } } }] });
});
it("native financial snapshot sees committed values even when ordinary eventual Gets are stale", async () => {
  const db = new FakeDynamoDb({ consistency: "eventual" }), key = { pk: "POLICY", sk: "A" };
  db.set({ ...key, amount: 1 });
  await db.send(new UpdateCommand({ TableName: "state", Key: key, UpdateExpression: "SET amount = :next", ExpressionAttributeValues: { ":next": 2 } }));
  expect(await db.send(new TransactGetCommand({ TransactItems: [{ Get: { TableName: "state", Key: key } }] }))).toMatchObject({ Responses: [{ Item: { amount: 2 } }] });
  expect(await db.send(new GetCommand({ TableName: "state", Key: key }))).toMatchObject({ Item: { amount: 1 } });
});
