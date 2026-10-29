// G1's prospective pure calculation. NOT an authorization, preview or admission API.
// Future server callers must load/revalidate org/project authority, locks, revisions and
// the payable policy snapshot. Raw browser proposals are not an authoritative snapshot.
// No caller may treat this result as paid-start permission: runtime enforcement is not wired.
import { z } from "zod";
export const TaskStopMicrousdSchema = z.number().int().min(0).max(1_000_000_000_000).transform(value => value === 0 ? 0 : value);
export const TaskStopCalculationInputSchema = z.object({
 companyDefaultMicrousd: TaskStopMicrousdSchema,
 ceilingMicrousd: TaskStopMicrousdSchema,
 projectStopMicrousd: TaskStopMicrousdSchema.optional(),
 agentStopMicrousd: TaskStopMicrousdSchema.optional(),
}).strict();
export type TaskStopBindingScope = "company_ceiling" | "company_default" | "project" | "agent";
export type TaskStopCalculation =
 | { kind: "resolved"; effectiveStopMicrousd: number; bindingScopes: TaskStopBindingScope[]; usesCompanyDefault: boolean; enforcement: "not_connected" }
 | { kind: "unavailable"; reason: "INVALID_OR_MISSING_POLICY"; enforcement: "not_connected" };
/** Finite known policies only. Unset overrides inherit; zero remains an explicit stop. */
export function calculateTaskStop(input: unknown): TaskStopCalculation {
 const parsed = TaskStopCalculationInputSchema.safeParse(input);
 if (!parsed.success) return { kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY", enforcement: "not_connected" };
 const policy = parsed.data;
 const candidates: Array<{ scope: TaskStopBindingScope; value: number }> = [{ scope: "company_ceiling", value: policy.ceilingMicrousd }];
 if (policy.projectStopMicrousd !== undefined) candidates.push({ scope: "project", value: policy.projectStopMicrousd });
 if (policy.agentStopMicrousd !== undefined) candidates.push({ scope: "agent", value: policy.agentStopMicrousd });
 const usesCompanyDefault = candidates.length === 1;
 if (usesCompanyDefault) candidates.push({ scope: "company_default", value: policy.companyDefaultMicrousd });
 const effectiveStopMicrousd = Math.min(...candidates.map(candidate => candidate.value));
 return { kind: "resolved", effectiveStopMicrousd, bindingScopes: candidates.filter(candidate => candidate.value === effectiveStopMicrousd).map(candidate => candidate.scope), usesCompanyDefault, enforcement: "not_connected" };
}
