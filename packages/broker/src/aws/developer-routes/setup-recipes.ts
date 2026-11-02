// Setup and test health SH29 wiring (switch `sp`): company setup recipes and company locks, as routes. Behind `sp`: with it off every path here is not found, as any unknown path. `org` and `projects` are browser
// route families, so the app reaches them as `/v1/web/...`; a token is refused here and before this in the entry file, for reads and writes alike.
//   GET   /v1/app/org/setup-recipes                    a live company owner or admin: every live recipe (what it runs, where it is offered, its digest), the company locks and a waiting loosening, and the lists the screen offers.
//   POST  /v1/app/org/setup-recipes                    a live company owner or admin, from a live browser session, and for every change but a stricter lock a sign-in within the last 10 minutes:
//           { action: "create", body, scope? }                     the admin writes a recipe: approved by the same act;
//           { action: "approve", recipeId, expectedRevision, expectedDigest }   a waiting proposal, pinned to the revision and digest the admin saw;
//           { action: "revoke", recipeId, expectedRevision }
//           { action: "scope", recipeId, expectedRevision, scope } "offer only to these projects" (or back to the whole company);
//           { action: "locks_set", locks, expectedRevision }       stricter applies at once; a loosening waits for a DIFFERENT admin (or the sole-owner exception: one admin, after the cool-off);
//           { action: "locks_approve", expectedRevision, expectedDigest }
//   POST  /v1/app/projects/{name}/setup-recipe         "share as company recipe": a maintainer of the project, from a browser. The recipe is built by the broker from the project's APPROVED test environment (a
//           request supplies only the repository, a label, the fingerprint and which of the project's own allowed websites to share), is stored as `proposed` and offered to nobody until an admin approves it.
// The authority is `org/setup-recipes.ts` (stale-pinned, fresh sign-in read from the stored session, repository names refused, secrets refused, audited in the write's own transaction); this file builds its dependencies.
// Answers are fixed words, booleans, ids and the recipe text an admin must read to approve it (commands, hosts, fingerprint); never a person's name, a repository name or a secret.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  SETUP_MARKER_FILES, agentXError, formatCommandLine, markerFilesOf, orgProjectCatalogPk, projectAllows, type OrgId, type SetupFingerprintInput,
} from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { requireLiveCompanyAdmin } from "../../org/company-authority.js";
import { readApprovedTestEnvironment } from "../../org/test-environment.js";
import { readSecondPersonApprovalEvidence } from "../../org/second-person-evidence.js";
import { dynamoSetupRecipeStore } from "../../org/setup-recipe-store.js";
import {
  SETUP_RECIPES_MAX_PER_ORG, approveLocksChange, approveRecipe, createRecipeAsAdmin, proposeRecipe, readCompanyLocks, recipeBodyFromProjectSetup, revokeRecipe, setCompanyLocks, setRecipeScope,
  type RecipeCaller, type SetupRecipeDeps, type StoredRecipe,
} from "../../org/setup-recipes.js";
import { refuseSetupHost } from "../../rovara-code/setup-host-ask.js";
import { setupRecipesEnabled } from "../../rovara-code/setup-recipes-switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { getSignIn } from "./authentication.js";
import { bodyError } from "./common.js";
import { jsonBody } from "./organization.js";
import { REVISION_READS_AT_ONCE, latestProjectRecord, mapLimit, queryAll, repositoryFullName, visibleProjectRoles } from "./project-list.js";
import { testEnvStoreOf } from "./test-environment.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const SETUP_RECIPES_PATH = "/v1/app/org/setup-recipes";
export const SETUP_RECIPE_SHARE_PATH = /^\/v1\/app\/projects\/([^/]+)\/setup-recipe$/u;
export const SETUP_RECIPES_BROWSER_MESSAGE = "Use a live browser session for company setup recipes.";
/** Whether the path is one of this file's (the entry file refuses a token for these before anything is read). */
export const isSetupRecipesPath = (pathname: string): boolean => pathname === SETUP_RECIPES_PATH || SETUP_RECIPE_SHARE_PATH.test(pathname);

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Revision = z.number().int().min(1).max(999_999_999);
const RecipeId = z.string().regex(/^rcp_[a-f0-9]{20}$/u);
const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), body: z.unknown(), scope: z.unknown().optional() }).strict(),
  z.object({ action: z.literal("approve"), recipeId: RecipeId, expectedRevision: Revision, expectedDigest: Digest }).strict(),
  z.object({ action: z.literal("revoke"), recipeId: RecipeId, expectedRevision: Revision }).strict(),
  z.object({ action: z.literal("scope"), recipeId: RecipeId, expectedRevision: Revision, scope: z.unknown() }).strict(),
  z.object({ action: z.literal("locks_set"), locks: z.unknown(), expectedRevision: Revision.nullable() }).strict(),
  z.object({ action: z.literal("locks_approve"), expectedRevision: Revision, expectedDigest: Digest }).strict(),
]);
const ShareSchema = z.object({
  repositoryId: z.string().min(1).max(200), label: z.string().min(1).max(80),
  buildSystems: z.array(z.string()).min(1).max(8), toolchains: z.array(z.object({ tool: z.string(), version: z.string() }).strict()).max(16),
  markerFiles: z.array(z.string()).min(1).max(SETUP_MARKER_FILES.length), registryHosts: z.array(z.string().max(253)).max(32),
  /** Hosts to share: only those among the project's OWN allowed websites are kept (a request cannot add one). */
  approvedHosts: z.array(z.string().max(253)).max(50).default([]),
  devcontainerBaseImage: z.string().max(256).optional(),
}).strict();

const BROWSER_ONLY = () => agentXError("FORBIDDEN", SETUP_RECIPES_BROWSER_MESSAGE);

/** The names a project's repositories go by, for the "no repository name in a recipe" check: full name, short name, the directory and its last part. */
function namesOfRepositories(repositories: ReadonlyArray<{ name: string; url: string; path: string }>): string[] {
  return repositories.flatMap((repository) => {
    const full = repositoryFullName(repository);
    return [repository.name, full, repository.path, repository.path.split("/").pop() ?? ""];
  }).filter((name) => name !== "");
}

/** Everything `org/setup-recipes.ts` needs, built from this request's dependencies. ONE clock: the stored session's freshness, the recipe times and the approval evidence all read `deps.now()`. */
export function recipeDepsOf(deps: DeveloperRouteDependencies, request: DeveloperCaller): SetupRecipeDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "Company setup recipes are not available here.");
  const clock = (): number => deps.now();
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const evidence = { ...table, signInTableName, now: clock };
  return {
    store: dynamoSetupRecipeStore({ ...table, now: clock, audit: deps.audit }),
    requireAdmin: (caller) => requireLiveCompanyAdmin({ ...table, signInTableName }, caller),
    async repositoryNamesOf(orgId, project) {
      if (project !== undefined) {
        const record = await latestProjectRecord(deps, orgId, project);
        return record === undefined ? [] : namesOfRepositories(record.definition.repositories);
      }
      const catalog = await queryAll<{ name?: unknown }>(deps, orgProjectCatalogPk(orgId), "PROJECT#");
      const records = await mapLimit(catalog.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])), REVISION_READS_AT_ONCE, (name) => latestProjectRecord(deps, orgId, name));
      return records.flatMap((record) => (record === undefined ? [] : namesOfRepositories(record.definition.repositories)));
    },
    approvalEvidence: (scope) => readSecondPersonApprovalEvidence(evidence, scope),
    async readSession(sessionId) {
      try { return await getSignIn<{ authTime?: string; developerId: string; revokedAt?: string }>(deps, `SESSION#${sessionId}`); } catch { return undefined; }
    },
    async requireProjectMaintainer(caller, project) {
      // The role is read live for the authenticated caller (an org owner or admin counts as a maintainer of every project); the module's caller must be that same person.
      if (caller.orgId !== request.orgId || caller.developerId !== request.developerId) throw agentXError("FORBIDDEN", "Only a project maintainer can share a project's setup.");
      const role = (await visibleProjectRoles(deps, request, project)).get(project);
      if (role === undefined || !projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "Only a project maintainer can share a project's setup.");
    },
    isHostRefused: (host) => refuseSetupHost(host) !== undefined,
    now: () => new Date(clock()),
    newRecipeSuffix: () => randomBytes(10).toString("hex"),
  };
}

const callerOf = (caller: DeveloperCaller): RecipeCaller => ({ orgId: caller.orgId, developerId: caller.developerId, sessionId: caller.sessionId });

/** A recipe as the admin's screen shows it: what it runs and where it is offered. The commands are shown whole because the admin approves what RUNS, not only the hosts. */
function recipeView(recipe: StoredRecipe, caller: DeveloperCaller) {
  const lines = (commands: ReadonlyArray<{ cwd: string; executable: string; args: string[]; timeoutSeconds: number }>) => commands.map((command) => `${command.cwd}: ${formatCommandLine(command)}`);
  return {
    recipeId: recipe.recipeId, revision: recipe.revision, status: recipe.status, digest: recipe.bodyDigest, label: recipe.body.label, buildSystems: recipe.body.buildSystems,
    toolchains: recipe.body.toolchains, setup: lines(recipe.body.setupCommands), update: lines(recipe.body.updateCommands),
    checks: recipe.body.checks.map((check) => ({ id: check.id, label: check.label, kind: check.kind, command: `${check.command.cwd}: ${formatCommandLine(check.command)}` })),
    approvedHosts: recipe.body.approvedHosts, ...(recipe.body.devcontainerBaseImage === undefined ? {} : { devcontainerBaseImage: recipe.body.devcontainerBaseImage }),
    match: { markerFiles: recipe.body.match.markerFiles, registryHosts: recipe.body.match.registryHosts },
    scope: recipe.scope.kind === "company" ? { kind: "company" as const } : { kind: "projects" as const, projects: recipe.scope.projects },
    fromProject: recipe.proposedFromProjectHash !== undefined, createdByYou: recipe.createdBy === caller.developerId, createdAt: recipe.createdAt, updatedAt: recipe.updatedAt,
  };
}

async function stateOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, recipeDeps: SetupRecipeDeps) {
  const [recipes, locks, catalog] = await Promise.all([
    recipeDeps.store.listRecipes(caller.orgId, SETUP_RECIPES_MAX_PER_ORG + 50),
    readCompanyLocks(recipeDeps, caller.orgId),
    queryAll<{ name?: unknown }>(deps, orgProjectCatalogPk(caller.orgId), "PROJECT#"),
  ]);
  const order = { proposed: 0, approved: 1, revoked: 2 } as const;
  return {
    recipes: recipes.sort((a, b) => order[a.status] - order[b.status] || (a.updatedAt < b.updatedAt ? 1 : -1)).map((recipe) => recipeView(recipe, caller)),
    locks: { revision: locks?.revision ?? null, locks: locks?.locks ?? {}, ...(locks?.pending === undefined ? {} : { pending: { digest: locks.pending.digest, locks: locks.pending.locks, proposedByYou: locks.pending.proposedBy === caller.developerId, proposedAt: locks.pending.proposedAt } }) },
    projects: catalog.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])).sort(),
    markerFiles: [...SETUP_MARKER_FILES],
  };
}

/** The reply, or undefined when the switch is off or the path is not one of this file's. */
export async function routeSetupRecipes(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!setupRecipesEnabled(env)) return undefined;
  const share = SETUP_RECIPE_SHARE_PATH.exec(url.pathname);
  if (url.pathname !== SETUP_RECIPES_PATH && share === null) return undefined;
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  // Defence in depth: the entry file refuses a token for these paths before this, and so does this.
  if (caller.browserSession !== true) throw BROWSER_ONLY();
  const recipeDeps = recipeDepsOf(deps, caller);
  const orgId: OrgId = caller.orgId;
  if (share !== null) {
    if (request.method !== "POST") return undefined;
    return shareFromProject(deps, caller, recipeDeps, share[1]!, jsonBody(request));
  }
  if (request.method === "GET") {
    await recipeDeps.requireAdmin({ orgId, developerId: caller.developerId });
    return new StatusReply(200, await stateOf(deps, caller, recipeDeps));
  }
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) throw bodyError(parsed.error);
  const input = parsed.data;
  const who = callerOf(caller);
  switch (input.action) {
    case "create": await createRecipeAsAdmin(recipeDeps, who, { body: input.body, ...(input.scope === undefined ? {} : { scope: input.scope as never }) }); break;
    case "approve": await approveRecipe(recipeDeps, who, input); break;
    case "revoke": await revokeRecipe(recipeDeps, who, input); break;
    case "scope": await setRecipeScope(recipeDeps, who, { recipeId: input.recipeId, expectedRevision: input.expectedRevision, scope: input.scope as never }); break;
    case "locks_set": {
      const result = await setCompanyLocks(recipeDeps, who, { locks: input.locks, expectedRevision: input.expectedRevision });
      logDeveloperEvent({ event: "developer.setup_locks_set", orgId, status: result.status });
      return new StatusReply(result.status === "applied" ? 200 : 202, { status: result.status, ...(await stateOf(deps, caller, recipeDeps)) });
    }
    case "locks_approve": await approveLocksChange(recipeDeps, who, input); break;
  }
  logDeveloperEvent({ event: "developer.setup_recipes_changed", orgId, action: input.action });
  return new StatusReply(200, { status: "done", ...(await stateOf(deps, caller, recipeDeps)) });
}

/** "Share as company recipe": the broker builds the recipe from the project's approved test environment; the request supplies only the generic descriptors. */
async function shareFromProject(deps: DeveloperRouteDependencies, caller: DeveloperCaller, recipeDeps: SetupRecipeDeps, rawName: string, raw: unknown): Promise<StatusReply> {
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw agentXError("PROJECT_NOT_FOUND", "project not found"); }
  const parsed = ShareSchema.safeParse(raw);
  if (!parsed.success) throw bodyError(parsed.error);
  const input = parsed.data;
  // Maintainer first: nothing about the project is read for anyone else.
  await recipeDeps.requireProjectMaintainer({ orgId: caller.orgId, developerId: caller.developerId }, name);
  const record = await latestProjectRecord(deps, caller.orgId, name);
  const repository = record?.definition.repositories.find((item) => item.name === input.repositoryId);
  if (record === undefined || repository === undefined) throw agentXError("CONFIG_INVALID", "Pick one of this project's repositories.");
  const approved = await readApprovedTestEnvironment(testEnvStoreOf(deps), caller.orgId, name);
  if (approved === undefined) throw agentXError("CONFIG_INVALID", "This project has no approved test environment to share yet.");
  const own = new Set((record.definition.network?.allowedDomains ?? []).map((host) => host.toLowerCase()));
  const match: SetupFingerprintInput = { markerFiles: markerFilesOf(input.markerFiles), registryHosts: input.registryHosts };
  const built = recipeBodyFromProjectSetup({
    environment: approved.environment, repositoryId: repository.name, repositoryDir: repository.path, label: input.label, buildSystems: input.buildSystems, toolchains: input.toolchains,
    approvedHosts: input.approvedHosts.map((host) => host.toLowerCase()).filter((host) => own.has(host)), ...(input.devcontainerBaseImage === undefined ? {} : { devcontainerBaseImage: input.devcontainerBaseImage }), match,
  });
  if (!built.ok) throw agentXError("CONFIG_INVALID", SHARE_REFUSALS[built.reason]);
  const recipe = await proposeRecipe(recipeDeps, callerOf(caller), { project: name, body: built.body });
  logDeveloperEvent({ event: "developer.setup_recipe_shared", orgId: caller.orgId, project: name });
  return new StatusReply(200, { status: "proposed", recipeId: recipe.recipeId, revision: recipe.revision, digest: recipe.bodyDigest });
}

const SHARE_REFUSALS = {
  repository_not_in_environment: "The approved test environment does not cover that repository.",
  command_outside_repository: "A command of this setup runs outside that repository's folder, so it cannot be shared.",
  path_outside_repository: "A report path of this setup is outside that repository's folder, so it cannot be shared.",
  invalid_recipe: "This setup cannot be shared as a recipe. Check the build systems, toolchains, fingerprint and image.",
} as const;
