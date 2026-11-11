import {z} from "zod";
import { AgentXError, StageIdSchema, StageModelRefusalCodeSchema, StageModelFixHrefSchema } from "@rovara-code/contracts";
import type { StageId, StageModelRefusalCode } from "@rovara-code/contracts";
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

export const ModelApplyRefusalSchema=z.object({code:z.union([StageModelRefusalCodeSchema,z.literal("MODEL_NOT_ALLOWED")]),reason:StageModelRefusalCodeSchema,stage:StageIdSchema.optional(),fixHref:StageModelFixHrefSchema}).strict();
export function modelApplyRefusalOf(error:unknown):z.infer<typeof ModelApplyRefusalSchema>|undefined {
 if(error instanceof ProcessModelRefusal)return {code:error.code,reason:error.code,stage:error.stage,fixHref:error.fixHref};
 if(error instanceof AgentXError&&"reason" in error&&"fixHref" in error){const parsed=ModelApplyRefusalSchema.safeParse({code:error.code,reason:error.reason,fixHref:error.fixHref});if(parsed.success)return parsed.data;}
 return undefined;
}
