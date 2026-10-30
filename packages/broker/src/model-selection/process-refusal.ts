import type {StageId,StageModelRefusalCode} from "@agentx/contracts";
/** Fixed structured resolver refusal, safe for the publish dialog and pointer routes. */
export class ProcessModelRefusal extends Error {
 readonly statusCode=409;
 constructor(readonly code:StageModelRefusalCode,readonly stage:StageId,readonly fixHref:string) {
  super(`${stage}: ${code}`);
  this.name="ProcessModelRefusal";
 }
}
export function processModelRefusalBody(error:ProcessModelRefusal) {
 return {code:error.code,stage:error.stage,fixHref:error.fixHref,message:error.message};
}
