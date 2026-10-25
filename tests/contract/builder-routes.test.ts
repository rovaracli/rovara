import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDeveloperTaskBroker, MAYA, OMAR } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { AgentWriteResponseReaderSchema } from "@agentx/contracts/web";
it("dispatches the member model picker route outside the agent pattern and includes actual sources", async () => {
 const h = await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:new FakeProjectMembers()}}});const result = await h.dev(MAYA,"GET","/v1/app/models");expect(result.status).toBe(200);expect(result.body.models).toEqual(expect.arrayContaining([expect.objectContaining({provider:"amazon-bedrock",company:"anthropic",sources:["rovara"]})]));
});
it("returns all structural draft problems in path order with no cross-member draft leak", async () => {
 const h=await createDeveloperTaskBroker({register:false,brokerExtra:{agents:{projectMembers:new FakeProjectMembers()}}});const created=await h.dev(MAYA,"POST","/v1/app/agents",{requestId:randomUUID(),name:"Repair me",overlay:{sequence:[{id:"one",name:"One",kind:"agent",workspace:"none"},{id:"one",name:"Duplicate",kind:"agent",workspace:"none"}],steps:{missing:{instructions:"Nowhere"}}}});expect(created.status).toBe(201);const id=AgentWriteResponseReaderSchema.parse(created.body).agent.agentId;
 const read=await h.dev(MAYA,"GET","/v1/app/agents/"+id+"/draft");expect(read.status).toBe(200);expect(read.body.problems).toEqual(expect.arrayContaining([expect.objectContaining({path:"steps.missing"}),expect.objectContaining({path:"steps.1.id"})]));const problems=read.body.problems as Array<{path:string}>;expect(problems.map(p=>p.path)).toEqual(problems.map(p=>p.path).sort());expect((await h.dev(OMAR,"GET","/v1/app/agents/"+id+"/draft")).status).toBe(404);
});
