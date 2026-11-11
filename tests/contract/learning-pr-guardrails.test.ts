import { expect,it } from "vitest";
import { AgentGuardrailsWriteSchema, DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import { lessSafeGuardrailChanges } from "../../packages/broker/src/agents/guardrails.js";
it("B8 guardrail writer accepts the reader-first field",()=>{expect(AgentGuardrailsWriteSchema.safeParse({...DEFAULT_AGENT_GUARDRAILS,prCommentLearning:"locked_off"}).success).toBe(true);});
it("B8 allowing after a lock is widening, locking is immediate narrowing",()=>{
 const locked={...DEFAULT_AGENT_GUARDRAILS,prCommentLearning:"locked_off" as const};
 expect(lessSafeGuardrailChanges(locked,DEFAULT_AGENT_GUARDRAILS)).toContain("Allows learning from PR review comments again");
 expect(lessSafeGuardrailChanges(DEFAULT_AGENT_GUARDRAILS,locked)).toEqual([]);
});
