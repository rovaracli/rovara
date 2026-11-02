// Company recipes as a proposal source (SH30), the broker's half. Reads only: it offers a project's setup run the recipes it may start from, and says which hosts a used recipe lets the host ask treat as already approved.
// It writes nothing and grants nothing. The authority around recipes (who proposes, who approves, the locks) is setup-recipes.ts (SH29); this file only reads what that approved, through the same store interface.
//
// Main branch only (ED-1): nothing here reads a repository, a branch or a SHA. The offers are chosen by company, project and status; WHICH offer fits is decided by the run, from the default-branch files it reads.
import { OrgIdSchema, SETUP_RECIPE_OFFERS_MAX, SETUP_RECIPE_OFFERS_MAX_BYTES, SetupRecipeOfferSchema, parseSetupRecipeSource, type OrgId, type SetupRecipeOffer, type TestEnvValueSource } from "@agentx/contracts";
import { SETUP_RECIPES_MAX_PER_ORG, recipeOfferedTo, type SetupRecipeDeps, type StoredRecipe } from "./setup-recipes.js";

type Reads = Pick<SetupRecipeDeps, "store">;

/** Whether a recipe may be used for a project now: approved, of this company, offered to the project by scope, and its dev container image (if any) on the company's list when the lock has one. */
async function usableFor(deps: Reads, orgId: OrgId, project: string, recipes: readonly StoredRecipe[]): Promise<StoredRecipe[]> {
  const locks = await deps.store.getLocks(orgId);
  const images = locks?.orgId === orgId ? locks.locks.devcontainerImages : undefined;
  return recipes.filter((recipe) => recipe.orgId === orgId && recipe.status === "approved" && recipeOfferedTo(recipe, project)
    && (images === undefined || recipe.body.devcontainerBaseImage === undefined || images.includes(recipe.body.devcontainerBaseImage)));
}

/**
 * The recipes a setup run for `project` may start from, newest first: approved, offered to the project, within the company's locks, ONE per fingerprint (the newest; an older recipe with the same fingerprint could
 * never be used), at most `SETUP_RECIPE_OFFERS_MAX` and `SETUP_RECIPE_OFFERS_MAX_BYTES` of bodies. Server-side use; not a route. Empty for an invalid company id.
 */
export async function recipeOffersForProject(deps: Reads, input: { orgId: OrgId; project: string }): Promise<SetupRecipeOffer[]> {
  if (!OrgIdSchema.safeParse(input.orgId).success) return [];
  const approved = await deps.store.listRecipes(input.orgId, SETUP_RECIPES_MAX_PER_ORG, ["approved"]);
  const newestFirst = (await usableFor(deps, input.orgId, input.project, approved))
    .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.recipeId < right.recipeId ? -1 : 1));
  const seen = new Set<string>();
  const offers: SetupRecipeOffer[] = [];
  let bytes = 0;
  for (const recipe of newestFirst) {
    if (seen.has(recipe.fingerprint)) continue;
    seen.add(recipe.fingerprint);
    const offer = SetupRecipeOfferSchema.safeParse({ recipeId: recipe.recipeId, revision: recipe.revision, body: recipe.body });
    if (!offer.success) continue;
    const size = Buffer.byteLength(JSON.stringify(offer.data), "utf8");
    if (offers.length >= SETUP_RECIPE_OFFERS_MAX || bytes + size > SETUP_RECIPE_OFFERS_MAX_BYTES) break;
    bytes += size;
    offers.push(offer.data);
  }
  return offers;
}

/** The recipes a proposal's value sources name (`recipe:<id>@<revision>`), once each, in order. A source that is not a recipe's, or does not parse, names none. */
export function recipesNamedBy(sources: ReadonlyArray<TestEnvValueSource>): Array<{ recipeId: string; revision: number }> {
  const out = new Map<string, number>();
  for (const source of sources) {
    const parsed = typeof source === "string" ? parseSetupRecipeSource(source) : undefined;
    if (parsed !== undefined && !out.has(parsed.id)) out.set(parsed.id, parsed.revision);
  }
  return [...out].map(([recipeId, revision]) => ({ recipeId, revision }));
}

export interface PreApprovedHost {
  host: string;
  /** The recipe that lists it, as a value source. */
  source: string;
  /** On Rovara Cloud a new host also waits for Rovara staff (the cell-wide list): the admin's approval of the recipe is not enough there. */
  staffApprovalRequired: boolean;
}

/**
 * The hosts a recipe the proposal USED lets a project's host ask treat as already approved by the company. Each recipe is read again NOW and must still be what the run used: approved, of this company, offered to this
 * project, at the same revision, and within the company's dev container lock; a revoked, changed or re-scoped recipe contributes nothing. A host the refusal list refuses today (`isHostRefused`: IP literals, pastes,
 * raw storage, production names) is dropped even if an admin once approved it. Hosts are exact (the recipe schema allows no wildcard).
 *
 * This is a LIST, never a grant (SH-3): it changes no allow list. A host still reaches the sandbox only through the project's website approval (`planProjectEgressChange`, owned by the host ask), and on Cloud only
 * after Rovara staff approve it (`staffApprovalRequired`). It is for the host ask to say "your company already approved this host" and to skip asking an admin twice.
 */
export async function preApprovedRecipeHosts(
  deps: Reads, input: { orgId: OrgId; project: string; sources: ReadonlyArray<TestEnvValueSource>; cloud: boolean; isHostRefused(host: string): boolean },
): Promise<PreApprovedHost[]> {
  if (!OrgIdSchema.safeParse(input.orgId).success) return [];
  const named = recipesNamedBy(input.sources).slice(0, SETUP_RECIPE_OFFERS_MAX);
  const stored: StoredRecipe[] = [];
  for (const { recipeId, revision } of named) {
    const found = await deps.store.getRecipe(input.orgId, recipeId);
    if (found !== undefined && found.revision === revision) stored.push(found);
  }
  const usable = await usableFor(deps, input.orgId, input.project, stored);
  const hosts = new Map<string, PreApprovedHost>();
  for (const recipe of usable) {
    for (const host of recipe.body.approvedHosts) {
      if (input.isHostRefused(host) || hosts.has(host)) continue;
      hosts.set(host, { host, source: `recipe:${recipe.recipeId}@${String(recipe.revision)}`, staffApprovalRequired: input.cloud });
    }
  }
  return [...hosts.values()].sort((left, right) => (left.host < right.host ? -1 : 1));
}
