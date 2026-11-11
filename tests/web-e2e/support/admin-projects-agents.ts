// Lane B browser fixture: real project/agent reads over the existing persistent fake table.
import { orgProjectCatalogKey, projectRevisionKey, projectMetaKey, projectMemberKey } from "@rovara-code/contracts";
import { StoredProjectDefinitionSchema } from "@agentx/cloud-contracts";
import { githubInstallationKey } from "@agentx/cloud-contracts";
import { AgentStore } from "../../../packages/broker/src/agents/store.js";
import { routeAgentRequest } from "../../../packages/broker/src/agents/routes.js";
import { createProjectMembers } from "../../../packages/broker/src/org/project-members.js";
import { DeveloperSignInStore } from "../../../packages/broker/src/developer/store.js";
import type { DeveloperRouteDependencies, DeveloperCaller } from "../../../packages/broker/src/aws/developer-routes.js";
import { FIXTURE_ORG, FIXTURE_DEVELOPER } from "../../web/support/fixtures.js";
export function seedLaneB(put: (row: Record<string, unknown>) => unknown) {
 for (const [org,name,status] of [[FIXTURE_ORG,"payments","active"],[FIXTURE_ORG,"old","archived"],["org_bbbbbbbbbbbbbbbbbbbb","foreign-project","active"]] as const) {
  const definition = StoredProjectDefinitionSchema.parse({ name,revision:1,repositories:[{name:"web",url:`https://github.com/acme/${name}.git`,path:"repo/web",defaultBranch:"main",credentialRef:"github-app",installationId:11,githubRepositoryId:22}],setup:[],readiness:[],orchestratorInstructions:"Read-only fixture." });
  put({...projectRevisionKey(org,name,1),entityType:"PROJECT",definition,runtimeBinding:{fixture:true},registeredBy:"fixture",registeredAt:"2026-10-01T00:00:00.000Z"});
  put({...orgProjectCatalogKey(org,name),entityType:"PROJECT_CATALOG",name,latestRevision:1});
  put({...projectMetaKey(org,name),entityType:"PROJECT_META",name,status,createdAt:"2026-10-01T00:00:00.000Z",createdBy:FIXTURE_DEVELOPER});
 }
 put({...githubInstallationKey(11),orgId:FIXTURE_ORG,status:"active"});
 put({...projectMemberKey(FIXTURE_ORG,"b".repeat(64),"payments"),entityType:"MEMBERSHIP",ownerKey:"b".repeat(64),projectName:"payments",role:"contributor"});
}
export function readLaneBAgents(deps: DeveloperRouteDependencies, caller: DeveloperCaller, path: string) {
 const store = new AgentStore({documentClient:deps.documentClient,tableName:deps.tableName,now:deps.now});
 return routeAgentRequest({...deps,store,projectMembers:createProjectMembers(deps),signInStore:new DeveloperSignInStore({documentClient:deps.documentClient,tableName:deps.tableName,now:deps.now}),confirmOrigin:"https://cell.example.test"},caller,{method:"GET",path,headers:{},requestId:"lane-b-read"},new URL(path,"https://cell.example.test"));
}
