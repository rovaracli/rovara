// Where the recipe code reads the company's setup locks. The locks are OWNED by lane su-musts (one row, one store, one admin route, the setup.locks_* audit actions, `rovara-code/setup-locks-store.ts`); the recipe code
// reads only the dev container image list, only through that store's `getCompanySetupLocks`, and holds no locks row, store or route of its own. A row that does not read makes the read throw (never "no locks"), so the offers
// are empty and the host marks are empty until it is put right.
import { getCompanySetupLocks } from "../rovara-code/setup-locks-store.js";
import type { CompanyLocksReader } from "./setup-recipes.js";

export interface CompanyLocksTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The reader every recipe read of the locks goes through. Always present: a missing reader would mean "no lock", which is the one thing a lock must never default to. */
export function companyLocksReaderFor(table: CompanyLocksTable): CompanyLocksReader {
  return { getCompanySetupLocks: (orgId) => getCompanySetupLocks({ documentClient: table.documentClient, tableName: table.tableName }, orgId) };
}
