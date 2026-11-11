// Company rules (G-04): the path of the company's connected rules file, for the merge guard (`rovara-code/merge.ts`): a Rovara task's pull request may not change it. Read only while the `si` switch is on. A company with no file link
// has none (`ok: true`, no path: the default path is still guarded by the caller). A link that cannot be read is `ok: false`: the guard then refuses the merge instead of passing a path it could not check.
import { OrgIdSchema, type OrgId } from "@rovara-code/contracts";
import { standingInstructionsEnabled } from "../instructions/switch.js";
import { dynamoCompanyRulesStore, type CompanyRulesTable } from "./store.js";

export async function connectedCompanyRulesPath(table: Pick<CompanyRulesTable, "documentClient" | "tableName">, orgId: OrgId, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; path?: string } | { ok: false; path?: undefined }> {
  if (!standingInstructionsEnabled(env) || !OrgIdSchema.safeParse(orgId).success) return { ok: true };
  try {
    const sync = await dynamoCompanyRulesStore(table).sync(orgId);
    return sync === undefined ? { ok: true } : { ok: true, path: sync.path };
  } catch {
    return { ok: false };
  }
}
