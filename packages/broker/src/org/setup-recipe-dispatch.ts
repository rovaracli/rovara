// Company setup recipes as a proposal source (SH30 + SR-3), the broker's dispatch half: which approved recipes a SETUP_DRAFT run is offered when the broker dispatches it. The same list is recorded on the operation
// (`setupRecipeOffers`: id and revision), so what the run later REPORTS using is intersected with what the broker actually sent (`offeredRecipesNamedBy`). Reads only. Off (switch `sp`), or on any read failure:
// no offers, and the setup draft runs exactly as it does today (a recipe is an optional shortcut; never a reason to fail a run).
import type { OrgId, SetupRecipeOffer } from "@agentx/contracts";
import { logDeveloperEvent } from "../developer/log.js";
import { setupRecipesEnabled } from "../rovara-code/setup-recipes-switch.js";
import { recipeOffersForProject, type RecordedOffer } from "./setup-recipe-offers.js";
import { dynamoSetupRecipeStore } from "./setup-recipe-store.js";

export interface RecipeDispatchTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The recipes this run is offered, newest first, at most the contract's bounds. Never throws. */
export async function setupRecipeOffersFor(table: RecipeDispatchTable, orgId: OrgId, project: string, env: NodeJS.ProcessEnv = process.env): Promise<SetupRecipeOffer[]> {
  if (!setupRecipesEnabled(env)) return [];
  try {
    return await recipeOffersForProject({ store: dynamoSetupRecipeStore({ documentClient: table.documentClient, tableName: table.tableName, now: Date.now }) }, { orgId, project });
  } catch (error) {
    logDeveloperEvent({ event: "developer.setup_recipe_offers_unreadable", orgId, project, error: error instanceof Error ? error.name : "unknown" });
    return [];
  }
}

/** What the operation records of an offer: which recipe and which revision, never the body. */
export const recordedOffersOf = (offers: readonly SetupRecipeOffer[]): RecordedOffer[] => offers.map((offer) => ({ recipeId: offer.recipeId, revision: offer.revision }));
