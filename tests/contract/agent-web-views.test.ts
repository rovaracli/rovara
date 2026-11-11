import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDeveloperTaskBroker, MAYA, OMAR } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { fakeHost } from "../web/support/fake-host.js";
import { createAgentApi } from "../../packages/ui/src/api/agents.js";
import { AgentWriteResponseReaderSchema, AgentDirectoryResponseSchema, AgentProfileResponseSchema, AgentDraftResponseSchema, AgentVersionsResponseSchema, AgentSharesResponseSchema, AgentSpendResponseSchema } from "@agentx/cloud-contracts/web";
it("reads actual existing broker agent projections and writes shares without audit fields", async () => {
 const h = await createDeveloperTaskBroker({ register: false, brokerExtra: { agents: { projectMembers: new FakeProjectMembers() } } });
 const created = await h.dev(MAYA, "POST", "/v1/app/agents", { requestId: randomUUID(), name: "Contract method", overlay: { instructions: "Read and summarise the request.", sequence: [{ id: "work", name: "Investigate", kind: "agent", workspace: "none" }] } });
 expect(created.status).toBe(201);const agent = AgentWriteResponseReaderSchema.parse(created.body).agent;
 const f = fakeHost(async request => h.dev(MAYA, request.method, request.path, request.body)), api = createAgentApi(f.host);
 const stripEnvelope = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));
 for (const [path, schema] of [["/v1/app/agents?scope=mine", AgentDirectoryResponseSchema], ["/v1/app/agents/" + agent.agentId, AgentProfileResponseSchema], ["/v1/app/agents/" + agent.agentId + "/draft", AgentDraftResponseSchema], ["/v1/app/agents/" + agent.agentId + "/versions", AgentVersionsResponseSchema], ["/v1/app/agents/" + agent.agentId + "/shares", AgentSharesResponseSchema], ["/v1/app/agents/" + agent.agentId + "/spend?month=2026-10", AgentSpendResponseSchema]] as const) {
  const result = await h.dev(MAYA, "GET", path);expect(result.status, path).toBe(200);expect(() => schema.parse(stripEnvelope(result.body)), path).not.toThrow();
 }
 const shared = await api.share(agent.agentId, [{ principal: { kind: "member", developerId: OMAR.developerId }, level: "view" }]);expect(shared.kind).toBe("done");
 expect((await api.shares(agent.agentId)).shares).toMatchObject([{ principal: { kind: "member", developerId: OMAR.developerId }, level: "view", grantedBy: MAYA.developerId }]);
 const draft = await api.draft(agent.agentId), published = await h.dev(MAYA, "POST", "/v1/app/agents/" + agent.agentId + "/publish", { requestId: randomUUID(), expectedRevision: draft.draft.revision });expect(published.status).toBe(200);
 expect((await api.read(agent.agentId)).current?.version).toBe(1);expect((await api.versions(agent.agentId)).versions[0]?.safety).toBe("current");
});
