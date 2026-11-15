import { record, whole, type TaskClaims } from "./model-gateway-token.js";
export interface Caps { task: number; personMonth?: number; projectMonth: number; companyMonth?: number }
export type CapsScope = Pick<TaskClaims, "iss" | "cid" | "pid" | "tid" | "per">;
export interface CapsSource { capsFor(scope: CapsScope, signal?: AbortSignal): Promise<Caps> }
export class FixedCapsSource implements CapsSource {
  constructor(private readonly caps: Caps) {}
  async capsFor(): Promise<Caps> { return { ...this.caps }; }
}
export function validCaps(value: unknown): value is Caps {
  const c = record(value);
  return c !== undefined && whole(c.task) && whole(c.projectMonth) && (c.personMonth === undefined || whole(c.personMonth)) && (c.companyMonth === undefined || whole(c.companyMonth)) && Object.keys(c).every((k) => ["task", "personMonth", "projectMonth", "companyMonth"].includes(k));
}
