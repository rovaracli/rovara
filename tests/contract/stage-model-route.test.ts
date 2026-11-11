import { expect,it } from "vitest";
import {randomUUID} from "node:crypto";
import {createDeveloperTaskBroker,MAYA} from "../support/developer-task-broker.js";
import {TEST_ORG} from "../support/orgs.js";
import { projectMemberKey } from "@rovara-code/contracts";
import { StageModelsResponseReaderSchema } from "@rovara-code/contracts";
it("serves stage models through the real project gate and refuses draft reads for contributors",async()=>{
 const h=await createDeveloperTaskBroker({brokerExtra:{agents:{}}});
 h.db.set({...projectMemberKey(TEST_ORG,MAYA.developerId,"payments"),entityType:"MEMBERSHIP",ownerKey:MAYA.developerId,projectName:"payments",grantId:randomUUID(),role:"developer",projectRole:"contributor",grantedAt:new Date().toISOString()});
 const read=await h.dev(MAYA,"GET","/v1/app/projects/payments/stage-models");
 expect(read.status,JSON.stringify(read.body)).toBe(200);expect(StageModelsResponseReaderSchema.safeParse(read.body).success).toBe(true);
 expect((await h.dev(MAYA,"GET","/v1/app/projects/nothing/stage-models")).status).toBe(404);
 expect((await h.dev(MAYA,"GET","/v1/app/projects/payments/stage-models?draft=1")).status).toBe(403);
 expect((await h.dev(MAYA,"GET","/v1/app/projects/payments/stage-models?orgId=foreign")).status).toBe(400);
 expect((await h.dev(MAYA,"PUT","/v1/app/projects/payments/stage-models",{})).status).toBeGreaterThanOrEqual(400);
});
