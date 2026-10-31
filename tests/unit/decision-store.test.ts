// Decisions D2: the DynamoDB form of the decision store keeps the evidence-opened record per person, card, tab and digest, and writes a decision once per request id.
import { describe, expect, it } from "vitest";
import type { GetCommand} from "@aws-sdk/lib-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoDecisionStore, DECISION_EVIDENCE_OPEN_TTL_MS } from "../../packages/broker/src/decisions/store.js";

function fakeTable() {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;
  const documentClient = {
    async send(command: GetCommand | PutCommand): Promise<unknown> {
      if (command instanceof PutCommand) {
        const item = command.input.Item as Record<string, unknown>;
        const k = key(item["pk"], item["sk"]);
        if (command.input.ConditionExpression !== undefined && rows.has(k)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
        rows.set(k, item);
        return {};
      }
      const found = rows.get(key(command.input.Key?.["pk"], command.input.Key?.["sk"]));
      return found === undefined ? {} : { Item: found };
    },
  };
  return { rows, documentClient };
}

describe("dynamoDecisionStore", () => {
  const who = { orgId: "org1", developerId: "dev1" };
  it("remembers the opened digest for this person, card and tab only", async () => {
    const table = fakeTable();
    const now = Date.parse("2026-10-30T10:00:00.000Z");
    const store = dynamoDecisionStore({ documentClient: table.documentClient, tableName: "t", now: () => now });
    await store.recordEvidenceOpened({ ...who, cardId: "approve_plan:a", tab: "design" }, "d1", "2026-10-30T10:00:00.000Z");
    expect(await store.evidenceOpenedAt({ ...who, cardId: "approve_plan:a", tab: "design" }, "d1")).toBe("2026-10-30T10:00:00.000Z");
    expect(await store.evidenceOpenedAt({ ...who, cardId: "approve_plan:a", tab: "design" }, "d2")).toBeUndefined();
    expect(await store.evidenceOpenedAt({ ...who, cardId: "approve_plan:a" }, "d1")).toBeUndefined();
    expect(await store.evidenceOpenedAt({ orgId: "org1", developerId: "dev2", cardId: "approve_plan:a", tab: "design" }, "d1")).toBeUndefined();
    const expired = dynamoDecisionStore({ documentClient: table.documentClient, tableName: "t", now: () => now + DECISION_EVIDENCE_OPEN_TTL_MS + 1 });
    expect(await expired.evidenceOpenedAt({ ...who, cardId: "approve_plan:a", tab: "design" }, "d1")).toBeUndefined();
  });
  it("sets a row expiry and writes a decision once per request id", async () => {
    const table = fakeTable();
    const store = dynamoDecisionStore({ documentClient: table.documentClient, tableName: "t", now: () => 1_000_000 });
    const record = { ...who, cardId: "merge:x", kind: "merge" as const, risk: "low" as const, outcome: "approved" as const, requestId: "r1", createdAt: "2026-10-30T10:00:00.000Z", decidedAt: "2026-10-30T10:01:00.000Z" };
    await store.recordDecision(record);
    await store.recordDecision({ ...record, outcome: "rejected" });
    const rows = [...table.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "approved", entityType: "DECISION_RECORD" });
    expect(typeof rows[0]?.["indexExpiresAt"]).toBe("number");
  });
});
