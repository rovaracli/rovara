// An in-memory SetupRecipeStore for tests: compare-and-set on the revision, and the audit entries kept beside the rows.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@agentx/contracts";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
import type { RecipeAuditEntry, SetupRecipeStore, StoredLocks, StoredRecipe } from "../../packages/broker/src/org/setup-recipes.js";

export interface MemorySetupRecipeStore extends SetupRecipeStore {
  audit: RecipeAuditEntry[];
  recipes: Map<string, StoredRecipe>;
  /** Makes the next commit report that the row changed meanwhile. */
  failNextCommit(): void;
}

/**
 * `conditionDb` holds the rows the approval evidence's ConditionChecks read (org META with its membership version, the members). A commit with conditions runs them as one DynamoDB transaction against it, the way the
 * real adapter does, and fails when any condition fails. Conditions without a `conditionDb` are a test mistake and throw.
 */
export function memorySetupRecipeStore(conditionDb?: FakeDynamoDb): MemorySetupRecipeStore {
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
    async commitLocks(next, expectedRevision, entry, conditions) {
      if (failNext) { failNext = false; return false; }
      if ((locks.get(next.orgId)?.revision ?? null) !== expectedRevision) return false;
      if (conditions !== undefined && conditions.length > 0) {
        if (conditionDb === undefined) throw new Error("conditions need a conditionDb");
        try { await conditionDb.send(new TransactWriteCommand({ TransactItems: [...conditions] })); } catch (error) {
          if (error instanceof Error && error.name === "TransactionCanceledException") return false;
          throw error;
        }
      }
      locks.set(next.orgId, structuredClone(next));
      audit.push(structuredClone(entry));
      return true;
    },
  };
}
