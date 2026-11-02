// The Setup recipes calls (SH29 wiring, switch `sp` on the server: with it off every path is "not found", and the screen says so). Company recipes are offered to a project's setup run as a proposal only; an admin
// approves each one. Every write is sent once from the browser session: a refusal is thrown as an `ApiError` for the screen to show and is never repeated here. The server decides who may and what a recipe means; this
// file reads its fixed shapes (zod here, not in the browser contract entry: nothing else in the app reads them).
import { z } from "zod";
import { createApiClient } from "./client.js";
import type { AppHost } from "../host.js";

export const SETUP_RECIPES_PATH = "/v1/app/org/setup-recipes";
const NEVER = { retry: "never" } as const;
const line = z.string().max(2_000);
const Recipe = z.object({
  recipeId: z.string(), revision: z.number().int(), status: z.enum(["proposed", "approved", "revoked"]), digest: z.string(), label: line, buildSystems: z.array(line),
  toolchains: z.array(z.object({ tool: line, version: line })), setup: z.array(line), update: z.array(line), checks: z.array(z.object({ id: line, label: line, kind: line, command: line })),
  approvedHosts: z.array(line), devcontainerBaseImage: line.optional(), match: z.object({ markerFiles: z.array(line), registryHosts: z.array(line) }),
  scope: z.union([z.object({ kind: z.literal("company") }), z.object({ kind: z.literal("projects"), projects: z.array(line) })]),
  fromProject: z.boolean(), createdByYou: z.boolean(), updatedAt: z.string(),
});
export const SetupRecipesStateReader = z.object({
  recipes: z.array(Recipe),
  locks: z.object({ revision: z.number().int().nullable(), pending: z.object({ proposedByYou: z.boolean() }).optional() }),
  projects: z.array(line), markerFiles: z.array(line),
});
export type SetupRecipesState = z.infer<typeof SetupRecipesStateReader>;
export type SetupRecipe = SetupRecipesState["recipes"][number];
const Done = z.object({ status: z.literal("done") }).passthrough();
const Shared = z.object({ status: z.literal("proposed"), recipeId: z.string() });
export interface ShareInput { project: string; repositoryId: string; label: string; buildSystems: string[]; toolchains: Array<{ tool: string; version: string }>; markerFiles: string[]; registryHosts: string[]; approvedHosts: string[] }

export function createSetupRecipesApi(host: AppHost) {
 const api = createApiClient(host);
 const post = async (body: unknown) => { const sent = await api.send("POST", SETUP_RECIPES_PATH, body, Done, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); };
 return {
  list: (): Promise<SetupRecipesState> => api.get(SETUP_RECIPES_PATH, SetupRecipesStateReader),
  /** Approves exactly the revision and digest the admin saw; the server answers CHANGE_STALE if either moved. Needs a sign-in within the last 10 minutes. */
  approve: (recipe: SetupRecipe) => post({ action: "approve", recipeId: recipe.recipeId, expectedRevision: recipe.revision, expectedDigest: recipe.digest }),
  revoke: (recipe: SetupRecipe) => post({ action: "revoke", recipeId: recipe.recipeId, expectedRevision: recipe.revision }),
  /** "Offer only to these projects"; an empty list means every project of the company. */
  setScope: (recipe: SetupRecipe, projects: string[]) => post({ action: "scope", recipeId: recipe.recipeId, expectedRevision: recipe.revision, scope: projects.length === 0 ? { kind: "company" } : { kind: "projects", projects } }),
  share: async (input: ShareInput) => {
   const { project, ...body } = input;
   const sent = await api.send("POST", "/v1/app/projects/" + encodeURIComponent(project) + "/setup-recipe", body, Shared, NEVER);
   if (sent.kind !== "done") throw new Error("unreadable");
   return sent.value;
  },
 };
}
