// Company rules (G-04): the Cloud adapter of the `CompanyInstructionsSource` port (`instructions/company-source.ts`). It answers the company's NEWEST APPROVED version at every call (decision 57.5: a running task uses the newest approved
// version at its next step), read consistently from the company's partition. A company with no version answers `undefined` (no rules). A head that names a version whose row cannot be read is an error, never "no rules": the port's
// reader then refuses the step (fail closed) instead of running it without rules that exist. The `company` key is the organisation id; anything else answers `undefined` (it names no company).
import { OrgIdSchema, agentXError, type CompanyInstructionsSnapshot } from "@agentx/contracts";
import type { CompanyInstructionsSource } from "../instructions/company-source.js";
import { dynamoCompanyRulesStore, type CompanyRulesStore, type CompanyRulesTable } from "./store.js";

export function companyRulesSourceOver(store: CompanyRulesStore): CompanyInstructionsSource {
  return {
    async current(company: string): Promise<CompanyInstructionsSnapshot | undefined> {
      const orgId = OrgIdSchema.safeParse(company);
      if (!orgId.success) return undefined;
      // The agent path needs the approved version only: a damaged pending proposal id (which the admin routes and the sync refuse loudly) must not take the approved rules away from every step.
      const head = await store.currentHead(orgId.data);
      if (head.latestVersion === 0) return undefined;
      const version = await store.version(orgId.data, head.latestVersion);
      if (version === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read.");
      return { version: String(version.version), rules: version.rules.map((rule) => ({ text: rule.text, priority: rule.priority })) };
    },
  };
}

/** The adapter over the State table (`audit` is not needed: it only reads). */
export const cloudCompanyInstructionsSource = (table: Pick<CompanyRulesTable, "documentClient" | "tableName">): CompanyInstructionsSource => companyRulesSourceOver(dynamoCompanyRulesStore(table));
