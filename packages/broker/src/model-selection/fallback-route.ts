import {agentXError,type OrgId,type ModelSelection,type StageId} from "@agentx/contracts";
import {routeStep} from "../agents/dispatch.js";
import {effectiveSources,type RoutingDependencies} from "../model-sources/routing.js";
/** Route the sole resolver's selected model; never accepts route fields from the worker. */
export async function routeTaskFallback(deps:RoutingDependencies,input:{orgId:OrgId;project:string;agent:string;stage:StageId;model:ModelSelection;sourceId:string}) {
 const effective=await effectiveSources(deps,input.orgId,input.project);
 if(effective!==undefined&&!effective.order.includes(input.sourceId))throw agentXError("MODEL_NOT_ALLOWED","The task's fallback source changed. Check How we work.");
 // Restrict this invocation to the resolver's verified source; never persist or broaden source order.
 const routing=effective===undefined?deps:{...deps,projectSourceOrder:async()=>[input.sourceId]};
 const routed=await routeStep(routing,{orgId:input.orgId,project:input.project,agent:input.agent,step:input.stage,model:input.model});
 const sourceId=routed.route?.sourceId??"rovara";
 if(sourceId!==input.sourceId||sourceId==="personal-chatgpt"||(sourceId!=="rovara"&&routed.wire===undefined))throw agentXError("MODEL_NOT_ALLOWED","The task's fallback source changed. Check How we work.");
 // Legacy direct-Bedrock payloads omit the wire route, but an authorized switch through
 // a configured proxy must retain its alias for the subsequent existing key-access check.
 const wire=routed.wire??(routed.route?.alias===undefined||routed.route.api===undefined?undefined:{alias:routed.route.alias,api:routed.route.api,catalog:routed.route.catalog});
 return wire===undefined?undefined:{sourceId,wire};
}
