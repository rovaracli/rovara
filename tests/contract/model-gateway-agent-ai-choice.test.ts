// DEC 240: the gateway reads the agent AI choice Cloud's company backend writes. Cloud's own store (DynamoCompanyStore) saves a
// company's choice; the gateway's own reader (CompanyAgentAiSource) reads that very item back through its wire-level client. The
// key, the field and the source names have to agree, or this fails. Two companies never see each other's choice.
import { denyNetwork } from "../unit/model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_AI_SOURCES as CLOUD_SOURCES, DynamoCompanyStore } from "../../packages/cloud-server/src/index.js";
import { AGENT_AI_SOURCES as GATEWAY_SOURCES, CompanyAgentAiSource } from "../../packages/model-gateway/src/agent-ai.js";
import { GATEWAY_COMPANY_AGENT_AI } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "../unit/model-gateway-wire-dynamo.js";

const TABLE = "cloud-companies";
const A = `org_${"a".repeat(20)}`;
const B = `org_${"b".repeat(20)}`;
const at = "2026-11-15T12:00:00.000Z";

function both() {
  const wire = new WireDynamo([TABLE]);
  const store = new DynamoCompanyStore(wire.fake, TABLE);
  const reader = new CompanyAgentAiSource(new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport }), TABLE);
  return { wire, store, reader };
}

describe("the gateway's agent AI reader matches Cloud's company store", () => {
  it("names the same sources and the same key", () => {
    expect([...GATEWAY_SOURCES]).toEqual([...CLOUD_SOURCES]);
    expect(GATEWAY_COMPANY_AGENT_AI).toEqual({ partitionPrefix: "COMPANY#", sortKey: "AGENT_AI" });
  });

  it("reads back each company's own saved choice; a change applies to the next read (two companies)", async () => {
    const { wire, store, reader } = both();
    expect(await reader.sourceFor(A)).toBeUndefined();
    await store.putAgentAi({ companyId: A, source: "rovara", updatedAt: at, updatedBy: "d".repeat(64) }, 0);
    expect(wire.fake.get(`${GATEWAY_COMPANY_AGENT_AI.partitionPrefix}${A}`, GATEWAY_COMPANY_AGENT_AI.sortKey)).toBeDefined();
    expect(await reader.sourceFor(A)).toBe("rovara");
    expect(await reader.sourceFor(B)).toBeUndefined();
    await store.putAgentAi({ companyId: B, source: "anthropic_key", updatedAt: at, updatedBy: "e".repeat(64) }, 0);
    await store.putAgentAi({ companyId: A, source: "anthropic_key", updatedAt: at, updatedBy: "d".repeat(64) }, 1);
    expect(await reader.sourceFor(A)).toBe("anthropic_key");
    expect(await reader.sourceFor(B)).toBe("anthropic_key");
    expect(await store.agentAi(A)).toMatchObject({ companyId: A, source: "anthropic_key", version: 2 });
    // A stale write is refused, leaving the saved choice as it was.
    await expect(store.putAgentAi({ companyId: A, source: "rovara", updatedAt: at, updatedBy: "d".repeat(64) }, 1)).rejects.toThrow();
    expect(await reader.sourceFor(A)).toBe("anthropic_key");
  });

  it("a row that names another company, or an unknown source, reads as nothing saved in Cloud and fails closed at the gateway", async () => {
    const { wire, store, reader } = both();
    wire.fake.set({ pk: `COMPANY#${A}`, sk: "AGENT_AI", companyId: B, source: "rovara", version: 1, updatedAt: at, updatedBy: "d".repeat(64) });
    expect(await store.agentAi(A)).toBeUndefined();
    await expect(reader.sourceFor(A)).rejects.toThrow();
    wire.fake.set({ pk: `COMPANY#${B}`, sk: "AGENT_AI", companyId: B, source: "openai", version: 1, updatedAt: at, updatedBy: "e".repeat(64) });
    expect(await store.agentAi(B)).toBeUndefined();
    await expect(reader.sourceFor(B)).rejects.toThrow();
  });
});
