// Company setup recipes and the host ask (SH30 wiring item 4): which hosts of a project's website ask its company has ALREADY approved through a recipe. A mark only. It changes no allow list and answers no ask: the
// project's website approval (`planProjectEgressChange`, the second-person rule, Cloud's staff step) is still the only way a host becomes reachable (SH-3). The mark is for the card to say "your company already approved
// this in a recipe", so an admin is not left wondering why the repository wants a host.
//
// Which recipes the project USED comes from the project's latest setup draft: the `recipe:<id>@<revision>` sources of its values, INTERSECTED with the offers the broker recorded on that draft's operation at
// dispatch (SR-3: a worker's report is only a claim). `preApprovedRecipeHosts` then reads each used recipe again NOW (approved, same revision, same company, in scope, inside the locks, host not refused). Off (`sp`) or
// on any read failure: no marks, and the ask is exactly what it was.
import type { OrgId, TestEnvProdDeny } from "@agentx/contracts";
import { readSetupDraftPointer } from "../rovara-code/setup-draft.js";
import { refuseSetupHost } from "../rovara-code/setup-host-ask.js";
import { setupRecipesEnabled } from "../rovara-code/setup-recipes-switch.js";
import { readTestEnvDraft } from "../test-env/draft.js";
import { preApprovedRecipeHosts } from "./setup-recipe-offers.js";
import { companyLocksReaderFor } from "./setup-recipe-locks.js";
import { dynamoSetupRecipeStore } from "./setup-recipe-store.js";

export interface HostMarkTable {
  documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number;
  /** The company's production deny list for the project (the host ask's own reader). A host it matches is never marked. If it cannot be read, nothing is marked. */
  prodDeny?: ((orgId: OrgId, project: string) => Promise<TestEnvProdDeny | undefined>) | undefined;
}

/** The hosts of `project` its company approved through the recipes the project's setup used, by host name. Empty unless `sp` is on. Never throws. */
export async function companyApprovedHostMarks(table: HostMarkTable, input: { orgId: OrgId; project: string; cloud: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<ReadonlyMap<string, { source: string; staffApprovalRequired: boolean }>> {
  const none = new Map<string, { source: string; staffApprovalRequired: boolean }>();
  if (!setupRecipesEnabled(env)) return none;
  try {
    const pointer = await readSetupDraftPointer(table.documentClient, table.tableName, input.orgId, input.project);
    if (pointer === undefined) return none;
    const prodDeny = await table.prodDeny?.(input.orgId, input.project);
    const stored = await readTestEnvDraft(table.documentClient, table.tableName, input.orgId, input.project, pointer.taskId, table.now());
    if (stored === undefined || stored.recipeOffers.length === 0) return none;
    const hosts = await preApprovedRecipeHosts({ store: dynamoSetupRecipeStore({ documentClient: table.documentClient, tableName: table.tableName, now: () => table.now() }), locks: companyLocksReaderFor(table) }, {
      orgId: input.orgId, project: input.project, sources: stored.draft.valueSources.map((entry) => entry.source), recorded: stored.recipeOffers, cloud: input.cloud, isHostRefused: (host) => refuseSetupHost(host, prodDeny) !== undefined,
    });
    return new Map(hosts.map((entry) => [entry.host, { source: entry.source, staffApprovalRequired: entry.staffApprovalRequired }]));
  } catch { return none; }
}
