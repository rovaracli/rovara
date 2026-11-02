// Where the recipe code reads the company's setup locks. The locks are OWNED by lane su-musts (one row, one store, one admin route, the setup.locks_* audit actions); the recipe code reads only the dev container
// image list, only through that store's `getCompanySetupLocks`, and holds no locks row, store or route of its own.
// WIRING (after su-musts merges): return `{ getCompanySetupLocks: (orgId) => getCompanySetupLocks(<its table deps>, orgId) }` here. Until then there is no reader, which is "no lock" (today's behaviour: nothing locks anything).
import type { CompanyLocksReader } from "./setup-recipes.js";

export interface CompanyLocksTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

export function companyLocksReaderFor(table: CompanyLocksTable): CompanyLocksReader | undefined {
  void table;
  return undefined;
}
