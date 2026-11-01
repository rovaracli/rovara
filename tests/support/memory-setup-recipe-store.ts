// An in-memory SetupRecipeStore for tests: compare-and-set on the revision, and the audit entries kept beside the rows.
import type { OrgId } from "@agentx/contracts";
import type { RecipeAuditEntry, SetupRecipeStore, StoredLocks, StoredRecipe } from "../../packages/broker/src/org/setup-recipes.js";

export interface MemorySetupRecipeStore extends SetupRecipeStore {
  audit: RecipeAuditEntry[];
  recipes: Map<string, StoredRecipe>;
  /** Makes the next commit report that the row changed meanwhile. */
  failNextCommit(): void;
}

export function memorySetupRecipeStore(): MemorySetupRecipeStore {
  const recipes = new Map<string, StoredRecipe>();
  const locks = new Map<string, StoredLocks>();
  const audit: RecipeAuditEntry[] = [];
  let failNext = false;
  const key = (orgId: string, recipeId: string): string => `${orgId}#${recipeId}`;
  return {
    audit,
    recipes,
    failNextCommit() { failNext = true; },
    getRecipe: (orgId, recipeId) => Promise.resolve(recipes.get(key(orgId, recipeId))),
    listRecipes: (orgId: OrgId, limit, statuses) => Promise.resolve([...recipes.values()].filter((recipe) => recipe.orgId === orgId && (statuses === undefined || statuses.includes(recipe.status))).slice(0, limit)),
    commitRecipe(next, expectedRevision, entry) {
      if (failNext) { failNext = false; return Promise.resolve(false); }
      const current = recipes.get(key(next.orgId, next.recipeId));
      if ((current?.revision ?? null) !== expectedRevision) return Promise.resolve(false);
      recipes.set(key(next.orgId, next.recipeId), structuredClone(next));
      audit.push(structuredClone(entry));
      return Promise.resolve(true);
    },
    getLocks: (orgId) => Promise.resolve(locks.get(orgId)),
    commitLocks(next, expectedRevision, entry) {
      if (failNext) { failNext = false; return Promise.resolve(false); }
      if ((locks.get(next.orgId)?.revision ?? null) !== expectedRevision) return Promise.resolve(false);
      locks.set(next.orgId, structuredClone(next));
      audit.push(structuredClone(entry));
      return Promise.resolve(true);
    },
  };
}
