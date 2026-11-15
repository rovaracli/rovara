import { record, whole, type TaskClaims } from "./model-gateway-token.js";
/**
 * `combinedCompanyMonth` (DEC 228c): the company's ONE monthly cap over agent and product spend together, held on the agent
 * meter's company row. Only a meter that combines with the agent meter (the product meter) reads it; it must then be present.
 */
/**
 * `learningMonth` (DEC 226): the company's own cap on learning calls, from its settings (company-caps.ts). Only the learning route reads
 * it (createLearningCaps); absent: the learning default applies. Every other meter ignores it.
 */
export interface Caps { task: number; personMonth?: number; projectMonth: number; companyMonth?: number; combinedCompanyMonth?: number; learningMonth?: number }
export type CapsScope = Pick<TaskClaims, "iss" | "cid" | "pid" | "tid" | "per">;
export interface CapsSource { capsFor(scope: CapsScope, signal?: AbortSignal): Promise<Caps> }
export class FixedCapsSource implements CapsSource {
  constructor(private readonly caps: Caps) {}
  async capsFor(): Promise<Caps> { return { ...this.caps }; }
}
export function validCaps(value: unknown): value is Caps {
  const c = record(value);
  return c !== undefined && whole(c.task) && whole(c.projectMonth) && (c.personMonth === undefined || whole(c.personMonth)) && (c.companyMonth === undefined || whole(c.companyMonth)) && (c.combinedCompanyMonth === undefined || whole(c.combinedCompanyMonth)) && (c.learningMonth === undefined || whole(c.learningMonth)) && Object.keys(c).every((k) => ["task", "personMonth", "projectMonth", "companyMonth", "combinedCompanyMonth", "learningMonth"].includes(k));
}
