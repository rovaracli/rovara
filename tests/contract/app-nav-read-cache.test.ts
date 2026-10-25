import { BatchGetCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it, vi } from "vitest";
import { navigationReadCache } from "../../packages/broker/src/app-nav/read-cache.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { TEST_ORG } from "../support/orgs.js";
it("coalesces equal inputs regardless of object key order and keeps tables/keys separate", async () => {
 const send = vi.fn(async () => ({ Item: { ok: true } })), cache = navigationReadCache({ send });
 await Promise.all([cache.documentClient.send(new GetCommand({ TableName: "a", Key: { pk: "p", sk: "s" } })), cache.documentClient.send(new GetCommand({ Key: { sk: "s", pk: "p" }, TableName: "a" }))]);expect(send).toHaveBeenCalledTimes(1);
 await cache.documentClient.send(new GetCommand({ TableName: "b", Key: { pk: "p", sk: "s" } }));await cache.documentClient.send(new GetCommand({ TableName: "a", Key: { pk: "other", sk: "s" } }));expect(send).toHaveBeenCalledTimes(3);
});
it("coalesces queries without conflating cursors", async () => {
 const send = vi.fn(async () => ({ Items: [] })), cache = navigationReadCache({ send });
 const input = { TableName: "a", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "p" } };
 await cache.documentClient.send(new QueryCommand(input));await cache.documentClient.send(new QueryCommand(input));await cache.documentClient.send(new QueryCommand({ ...input, ExclusiveStartKey: { pk: "p", sk: "next" } }));expect(send).toHaveBeenCalledTimes(2);
});
it("evicts failed reads so retry can actually reach storage", async () => {
 const send = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error("transient")).mockResolvedValue({ Item: {} }), cache = navigationReadCache({ send });
 const command = new GetCommand({ TableName: "a", Key: { pk: "p", sk: "s" } });await expect(cache.documentClient.send(command)).rejects.toThrow("transient");await cache.documentClient.send(command);expect(send).toHaveBeenCalledTimes(2);
});
it("leaves unprocessed batch retry to the canonical batch reader", async () => {
 const send = vi.fn(async () => ({ UnprocessedKeys: { a: { Keys: [{ pk: "p", sk: "s" }] } } })), cache = navigationReadCache({ send });
 const command = new BatchGetCommand({ RequestItems: { a: { Keys: [{ pk: "p", sk: "s" }] } } });await cache.documentClient.send(command);await cache.documentClient.send(command);expect(send).toHaveBeenCalledTimes(2);
});
it("refuses writes before they reach the underlying client", async () => {
 const send = vi.fn(async () => ({})), cache = navigationReadCache({ send });await expect(cache.documentClient.send(new PutCommand({ TableName: "a", Item: { pk: "p", sk: "s" } }))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });expect(send).not.toHaveBeenCalled();
});
it("preserves AgentStore private state while coalescing pinned builtin reads", async () => {
 const send = vi.fn(async () => ({})), cache = navigationReadCache({ send }), store = cache.store(new AgentStore({ documentClient: { send }, tableName: "a", now: () => 0 }));
 const first = await store.pinnedBuiltinVersion(TEST_ORG, "root-cause-analyst");expect(await store.pinnedBuiltinVersion(TEST_ORG, "root-cause-analyst")).toBe(first);expect(store.builtinName("root-cause-analyst")).toBeTruthy();expect(send).toHaveBeenCalledTimes(1);
});
it("bounds retained read entries", async () => {
 const send = vi.fn(async () => ({})), cache = navigationReadCache({ send });for (let i = 0; i < 4097; i++) await cache.documentClient.send(new GetCommand({ TableName: "a", Key: { pk: String(i), sk: "s" } }));await cache.documentClient.send(new GetCommand({ TableName: "a", Key: { pk: "0", sk: "s" } }));expect(send).toHaveBeenCalledTimes(4098);
});
it("releases intermediate results when the navigation projection settles", async () => {
 const send = vi.fn(async () => ({})), cache = navigationReadCache({ send }), command = new GetCommand({ TableName: "a", Key: { pk: "p", sk: "s" } });
 await cache.documentClient.send(command);cache.release();await cache.documentClient.send(command);await cache.documentClient.send(command);expect(send).toHaveBeenCalledTimes(3);
});
