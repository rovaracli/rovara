// Setup and test health SH29: company setup recipes and company locks (admin only with a fresh sign-in; locks stricter only; no repository names stored).
import { describe, expect, it } from "vitest";
import { AgentXError, orgMemberKey, orgMetaKey, TestEnvironmentBodySchema, setupFingerprint, type OrgId, type SetupRecipeBody, SetupRecipeBodySchema } from "@agentx/contracts";
import {
  SETUP_LIMIT_MAXIMA, SETUP_RECIPES_MAX_PER_ORG, SETUP_RECIPES_MAX_PROPOSED, applyCompanyLocks, approveRecipe, companyApprovedHosts, createRecipeAsAdmin, offeredRecipes, proposeRecipe, readCompanyLocks,
  recipeBodyFromProjectSetup, revokeRecipe, setCompanyLocks, approveLocksChange, isLoosening, setRecipeScope, type CompanySetupLocks, type ProjectSetupSettings, type RecipeCaller, type SetupRecipeDeps,
} from "../../packages/broker/src/org/setup-recipes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { memorySetupRecipeStore } from "../support/memory-setup-recipe-store.js";
import { secondPersonMembershipCondition } from "../../packages/broker/src/org/second-person-approval.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ADMIN = "a".repeat(64);
const MAINTAINER = "b".repeat(64);
const NOW = new Date("2026-11-01T12:00:00.000Z");
const FRESH = "2026-11-01T11:58:00.000Z";
const SECOND_ADMIN = "d".repeat(64);
const cmd = (executable: string, args: string[] = [], cwd = "{repo}") => ({ cwd, executable, args, timeoutSeconds: 600 });
const body = (changes: Record<string, unknown> = {}): SetupRecipeBody => SetupRecipeBodySchema.parse({
  schemaVersion: 1,
  label: "Python services",
  buildSystems: ["python"],
  toolchains: [{ tool: "python", version: "3.12" }],
  setupCommands: [cmd("uv", ["sync", "--frozen"])],
  updateCommands: [],
  checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }],
  approvedHosts: ["pypi.internal.example.com"],
  devcontainerBaseImage: "mcr.microsoft.com/devcontainers/python:3.12",
  match: { markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] },
  ...changes,
});
const FITS = { markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] };

/** su-musts' reader, as the recipe code uses it: only the dev container image list, from the locks store. */
const readerOf = (deps: SetupRecipeDeps) => ({ getCompanySetupLocks: async (orgId: OrgId) => (await deps.locksStore!.getLocks(orgId))?.locks });
function harness(options: { admins?: string[]; maintainers?: Record<string, string[]>; refusedHosts?: string[]; repositoryNames?: Record<string, string[]> } = {}) {
  // The rows the evidence's conditions fence: the org META with its membership version, and the two admins' member records.
  const db = new FakeDynamoDb();
  db.set({ ...orgMetaKey(ORG), approvalMembershipVersion: 7 });
  db.set({ ...orgMemberKey(ORG, ADMIN), role: "owner" });
  db.set({ ...orgMemberKey(ORG, SECOND_ADMIN), role: "admin" });
  const hooks: { afterEvidence?: (() => void) | undefined } = {};
  const store = memorySetupRecipeStore(db);
  const admins = new Set(options.admins ?? [ADMIN, SECOND_ADMIN]);
  // The stored sessions: session id -> person and sign-in time. A session id is the route's authenticated one; its freshness is read here, never claimed by the caller.
  const sessions = new Map<string, { developerId: string; authTime?: string; revokedAt?: string }>([
    ["s-admin", { developerId: ADMIN, authTime: FRESH }], ["s-admin-2", { developerId: SECOND_ADMIN, authTime: FRESH }], ["s-maint", { developerId: MAINTAINER }],
  ]);
  const repositoryNames = options.repositoryNames ?? { orders: ["acme/orders-service", "orders-service"], billing: ["acme/billing-engine"] };
  const maintainers = options.maintainers ?? { [MAINTAINER]: ["orders"] };
  const refused = new Set(options.refusedHosts ?? ["evil.example.net"]);
  const clock = { now: NOW };
  let counter = 0;
  const calls: string[] = [];
  // Two eligible admins by default; tests change this to make a one-admin company or a recent loss.
  const evidence = { complete: true, membershipVersion: 7, ownerIds: [ADMIN], eligibleIds: [ADMIN, SECOND_ADMIN], lastEligibleLossAtMs: null as number | null };
  const deps: SetupRecipeDeps = {
    store: {
      ...store,
      getRecipe: (...args) => { calls.push("store"); return store.getRecipe(...args); },
      listRecipes: (...args) => { calls.push("store"); return store.listRecipes(...args); },
    },
    locksStore: { ...store, getLocks: (...args) => { calls.push("store"); return store.getLocks(...args); } },
    requireAdmin: (caller) => { calls.push("admin"); return admins.has(caller.developerId) ? Promise.resolve() : Promise.reject(new AgentXError("FORBIDDEN", "Live company owner or admin access is required.", 403)); },
    approvalEvidence: (scope) => {
      // As readSecondPersonApprovalEvidence does: read the version, fence it and both people's live records, and answer a decision input.
      const version = Number(db.get(orgMetaKey(ORG))?.approvalMembershipVersion);
      const person = (id: string) => ({ ConditionCheck: { TableName: "t", Key: orgMemberKey(ORG, id), ConditionExpression: "attribute_exists(pk) AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": db.get(orgMemberKey(ORG, id))?.role ?? "none" } } });
      const people = [...new Set([scope.proposerId, scope.approverId])];
      const result = {
        decisionInput: { ...evidence, membershipVersion: version, proposerId: scope.proposerId, approverId: scope.approverId, nowMs: clock.now.getTime() },
        conditions: [{ ConditionCheck: { TableName: "t", Key: orgMetaKey(ORG), ...secondPersonMembershipCondition(version) } }, ...people.map(person)],
      };
      hooks.afterEvidence?.();
      return Promise.resolve(result);
    },
    readSession: (sessionId) => Promise.resolve(sessions.get(sessionId)),
    repositoryNamesOf: (_orgId, project) => Promise.resolve(project === undefined ? Object.values(repositoryNames).flat() : (repositoryNames[project] ?? [])),
    requireProjectMaintainer: (caller, project) => (maintainers[caller.developerId]?.includes(project) ? Promise.resolve() : Promise.reject(new AgentXError("FORBIDDEN", "no", 403))),
    isHostRefused: (host) => refused.has(host),
    now: () => clock.now,
    newRecipeSuffix: () => { counter += 1; return counter.toString(16).padStart(20, "0"); },
  };
  const admin: RecipeCaller = { orgId: ORG, developerId: ADMIN, sessionId: "s-admin" };
  const admin2: RecipeCaller = { orgId: ORG, developerId: SECOND_ADMIN, sessionId: "s-admin-2" };
  const maintainer: RecipeCaller = { orgId: ORG, developerId: MAINTAINER, sessionId: "s-maint" };
  return { store, deps, admin, admin2, maintainer, clock, calls, refused, sessions, evidence, db, hooks };
}
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? "OTHER"; }
  return "NO_ERROR";
};

describe("admin authority", () => {
  it("refuses a non-admin for every admin action and writes nothing", async () => {
    const { deps, store, maintainer } = harness();
    const asMaintainer = maintainer;
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    expect(await code(createRecipeAsAdmin(deps, asMaintainer, { body: body() }))).toBe("FORBIDDEN");
    expect(await code(approveRecipe(deps, asMaintainer, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("FORBIDDEN");
    expect(await code(revokeRecipe(deps, asMaintainer, { recipeId: proposed.recipeId, expectedRevision: 1 }))).toBe("FORBIDDEN");
    expect(await code(setRecipeScope(deps, asMaintainer, { recipeId: proposed.recipeId, expectedRevision: 1, scope: { kind: "company" } }))).toBe("FORBIDDEN");
    expect(await code(setCompanyLocks(deps, asMaintainer, { locks: { setupAgentOff: true }, expectedRevision: null }))).toBe("FORBIDDEN");
    expect(store.recipes.size).toBe(1);
    expect([...store.recipes.values()][0]?.status).toBe("proposed");
    expect(store.audit.map((entry) => entry.action)).toEqual(["recipe_proposed"]);
    expect(await readCompanyLocks(deps, ORG)).toBeUndefined();
  });

  it("checks the admin before it reads anything, and a malformed caller is forbidden", async () => {
    const { deps, calls, maintainer } = harness();
    calls.length = 0;
    await code(approveRecipe(deps, maintainer, { recipeId: `rcp_${"0".repeat(20)}`, expectedRevision: 1, expectedDigest: "x" }));
    expect(calls).toEqual(["admin"]);
    expect(await code(createRecipeAsAdmin(deps, { orgId: "nope", developerId: ADMIN, sessionId: "s-admin" }, { body: body() }))).toBe("FORBIDDEN");
    expect(await code(createRecipeAsAdmin(deps, { orgId: ORG, developerId: "short", sessionId: "s-admin" }, { body: body() }))).toBe("FORBIDDEN");
  });

  it("reads freshness from the stored session by the platform's rule (isFreshSignIn), never from the caller", async () => {
    const { deps, store, admin, sessions } = harness();
    // No stored session, a session with no sign-in time, one that is too old, an unreadable time, another person's session, and a revoked one.
    sessions.delete("s-admin");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body() }))).toBe("REAUTH_REQUIRED");
    for (const session of [{ developerId: ADMIN }, { developerId: ADMIN, authTime: "2026-11-01T11:49:59.000Z" }, { developerId: ADMIN, authTime: "not a date" }, { developerId: SECOND_ADMIN, authTime: FRESH }, { developerId: ADMIN, authTime: FRESH, revokedAt: "2026-11-01T11:59:00.000Z" }]) {
      sessions.set("s-admin", session);
      expect(await code(createRecipeAsAdmin(deps, admin, { body: body() })), JSON.stringify(session)).toBe("REAUTH_REQUIRED");
    }
    expect(store.recipes.size).toBe(0);
    sessions.set("s-admin", { developerId: ADMIN, authTime: "2026-11-01T11:50:00.000Z" });
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body() }))).toBe("NO_ERROR");
    // A client field naming a fresh time is no input at all: extra properties on the caller change nothing.
    sessions.set("s-admin", { developerId: ADMIN });
    expect(await code(createRecipeAsAdmin(deps, { ...admin, freshSignInAt: FRESH } as RecipeCaller, { body: body({ label: "Again" }) }))).toBe("REAUTH_REQUIRED");
    expect(await code(createRecipeAsAdmin(deps, { ...admin, sessionId: "" }, { body: body({ label: "Again" }) }))).toBe("REAUTH_REQUIRED");
  });

  it("lets a project maintainer propose but never approve or write an approved recipe", async () => {
    const { deps, maintainer, store } = harness();
    expect(await code(proposeRecipe(deps, { orgId: ORG, developerId: "c".repeat(64), sessionId: "s-c" }, { project: "orders", body: body() }))).toBe("FORBIDDEN");
    expect(await code(proposeRecipe(deps, maintainer, { project: "billing", body: body() }))).toBe("FORBIDDEN");
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    expect(proposed.status).toBe("proposed");
    expect(await code(approveRecipe(deps, maintainer, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("FORBIDDEN");
    expect(store.recipes.get(`${ORG}#${proposed.recipeId}`)?.status).toBe("proposed");
  });
});

describe("approval", () => {
  it("is pinned to the revision and digest the admin saw", async () => {
    const { deps, maintainer, admin } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 2, expectedDigest: proposed.bodyDigest }))).toBe("CHANGE_STALE");
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: "0".repeat(64) }))).toBe("CHANGE_STALE");
    const approved = await approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest });
    expect(approved).toMatchObject({ status: "approved", revision: 2, approvedBy: ADMIN, approvedAt: NOW.toISOString() });
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 2, expectedDigest: proposed.bodyDigest }))).toBe("CHANGE_STALE");
  });

  it("is refused when the row changed under the admin, and when the recipe is not found or is another company's", async () => {
    const { deps, maintainer, admin, store } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    store.failNextCommit();
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("CHANGE_STALE");
    expect(await code(approveRecipe(deps, admin, { recipeId: `rcp_${"f".repeat(20)}`, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("NOT_FOUND");
    expect(await code(approveRecipe(deps, admin, { recipeId: "bad", expectedRevision: 1, expectedDigest: "x" }))).toBe("NOT_FOUND");
    const other = harness({ admins: [ADMIN] });
    other.store.recipes.set(`${ORG}#${proposed.recipeId}`, store.recipes.get(`${ORG}#${proposed.recipeId}`)!);
    expect(await code(approveRecipe(other.deps, { ...other.admin, orgId: OTHER_ORG }, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("NOT_FOUND");
  });

  it("treats a stored row that names another company as not found", async () => {
    const { deps, admin, store } = harness();
    const created = await createRecipeAsAdmin(deps, admin, { body: body() });
    store.recipes.set(`${ORG}#${created.recipeId}`, { ...created, orgId: OTHER_ORG, status: "proposed" });
    expect(await code(approveRecipe(deps, admin, { recipeId: created.recipeId, expectedRevision: 1, expectedDigest: created.bodyDigest }))).toBe("NOT_FOUND");
  });

  it("checks the hosts again against the host-ask list", async () => {
    const { deps, maintainer, admin, refused } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    refused.add("pypi.internal.example.com");
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("CONFIG_INVALID");
  });
});

describe("what is stored", () => {
  it("refuses a body that names the repository, whoever writes it, and stores nothing", async () => {
    const { deps, maintainer, admin, store } = harness();
    const naming = body({ setupCommands: [cmd("make", ["-C", "orders-service"])] });
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", body: naming }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ label: "Acme setup" }) }))).toBe("CONFIG_INVALID");
    expect(store.recipes.size).toBe(0);
    expect(store.audit).toEqual([]);
  });

  it("keeps no repository name, project name or recipe text in a stored row's provenance, nor in the audit", async () => {
    const { deps, maintainer, admin, store } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    await approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest });
    const row = [...store.recipes.values()][0]!;
    const rest = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "body" && key !== "scope"));
    expect(Object.keys(rest).sort()).toEqual(["approvedAt", "approvedBy", "bodyDigest", "createdAt", "createdBy", "fingerprint", "orgId", "proposedFromProjectHash", "recipeId", "revision", "status", "updatedAt"]);
    expect(JSON.stringify(rest)).not.toContain("orders");
    expect(row.proposedFromProjectHash).toMatch(/^[a-f0-9]{32}$/);
    // Positive control: the audit does name the recipe by id and digest, but holds none of its text.
    const text = JSON.stringify(store.audit);
    expect(text).toContain(proposed.recipeId);
    expect(text).toContain(proposed.bodyDigest);
    expect(text).not.toContain("Python services");
    expect(text).not.toContain("pypi");
    expect(store.audit.map((entry) => [entry.action, entry.proof])).toEqual([["recipe_proposed", "project_maintainer"], ["recipe_approved", "fresh_sign_in"]]);
  });

  it("refuses hosts the host-ask list refuses, a wildcard host and an invalid body", async () => {
    const { deps, maintainer, admin } = harness();
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", body: body({ approvedHosts: ["evil.example.net"] }) }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ approvedHosts: ["evil.example.net"] }) }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: { ...body(), approvedHosts: ["*.example.com"] } }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: { ...body(), env: { A: "b" } } }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body(), scope: { kind: "projects", projects: [] } }))).toBe("CONFIG_INVALID");
  });

  it("answers the first proposal when the same project proposes the same body again", async () => {
    const { deps, maintainer, store } = harness({ maintainers: { [MAINTAINER]: ["orders", "billing"] } });
    const first = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    const again = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    expect(again.recipeId).toBe(first.recipeId);
    await proposeRecipe(deps, maintainer, { project: "billing", body: body() });
    expect(store.recipes.size).toBe(2);
  });

  it("bounds what is waiting and what is kept", async () => {
    const { deps, admin, maintainer, store } = harness();
    for (let index = 0; index < SETUP_RECIPES_MAX_PROPOSED; index += 1) await proposeRecipe(deps, maintainer, { project: "orders", body: body({ label: `Recipe ${String(index)}` }) });
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", body: body({ label: "One more" }) }))).toBe("CONFIG_INVALID");
    for (let index = SETUP_RECIPES_MAX_PROPOSED; index < SETUP_RECIPES_MAX_PER_ORG; index += 1) await createRecipeAsAdmin(deps, admin, { body: body({ label: `Recipe ${String(index)}` }) });
    expect(store.recipes.size).toBe(SETUP_RECIPES_MAX_PER_ORG);
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ label: "Over" }) }))).toBe("CONFIG_INVALID");
  });
});

describe("who a recipe is offered to", () => {
  it("offers only approved recipes, to projects in scope, whose fingerprint fits", async () => {
    const { deps, admin, maintainer } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", body: body() });
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "orders", repository: FITS })).toEqual([]);
    const approved = await approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest });
    const offered = await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "anything", repository: FITS });
    expect(offered).toEqual([{ recipeId: approved.recipeId, revision: 2, bodyDigest: approved.bodyDigest, body: approved.body }]);
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "anything", repository: { markerFiles: ["package.json"], registryHosts: [] } })).toEqual([]);
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "anything", repository: { markerFiles: [], registryHosts: [] } })).toEqual([]);
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: OTHER_ORG, project: "anything", repository: FITS })).toEqual([]);
  });

  it("offers only to the listed projects when the admin says so, and back to all", async () => {
    const { deps, admin } = harness();
    const created = await createRecipeAsAdmin(deps, admin, { body: body(), scope: { kind: "projects", projects: ["orders", "billing"] } });
    expect((await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "orders", repository: FITS })).length).toBe(1);
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "search", repository: FITS })).toEqual([]);
    expect(await code(setRecipeScope(deps, admin, { recipeId: created.recipeId, expectedRevision: 9, scope: { kind: "company" } }))).toBe("CHANGE_STALE");
    const widened = await setRecipeScope(deps, admin, { recipeId: created.recipeId, expectedRevision: 1, scope: { kind: "company" } });
    expect(widened.revision).toBe(2);
    expect((await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "search", repository: FITS })).length).toBe(1);
  });

  it("stops offering a revoked recipe, and keeps it", async () => {
    const { deps, admin, store } = harness();
    const created = await createRecipeAsAdmin(deps, admin, { body: body() });
    expect(await code(revokeRecipe(deps, admin, { recipeId: created.recipeId, expectedRevision: 5 }))).toBe("CHANGE_STALE");
    const revoked = await revokeRecipe(deps, admin, { recipeId: created.recipeId, expectedRevision: 1 });
    expect(revoked.status).toBe("revoked");
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "orders", repository: FITS })).toEqual([]);
    expect(await companyApprovedHosts(deps, ORG)).toEqual([]);
    expect(store.recipes.size).toBe(1);
    expect(store.audit.map((entry) => entry.action)).toEqual(["recipe_created", "recipe_revoked"]);
  });

  it("does not offer a recipe whose dev container image is not on the company's list", async () => {
    const { deps, admin, admin2 } = harness();
    await createRecipeAsAdmin(deps, admin, { body: body() });
    await setCompanyLocks(deps, admin, { locks: { devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] }, expectedRevision: null });
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "orders", repository: FITS })).toEqual([]);
    // Widening the list is a loosening: a second admin approves it.
    const waiting = await setCompanyLocks(deps, admin, { locks: { devcontainerImages: ["mcr.microsoft.com/devcontainers/python:3.12"] }, expectedRevision: 1 });
    expect(waiting.status).toBe("needs_second_admin");
    expect(await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "orders", repository: FITS })).toEqual([]);
    await approveLocksChange(deps, admin2, { expectedRevision: waiting.locks.revision, expectedDigest: waiting.locks.pending!.digest });
    expect((await offeredRecipes({ ...deps, locks: readerOf(deps) }, { orgId: ORG, project: "orders", repository: FITS })).length).toBe(1);
  });

  it("lists the hosts approved through recipes, once each, for approved recipes only", async () => {
    const { deps, admin, maintainer } = harness();
    await createRecipeAsAdmin(deps, admin, { body: body() });
    await createRecipeAsAdmin(deps, admin, { body: body({ label: "Second", approvedHosts: ["pypi.internal.example.com", "repo.example.org"] }) });
    await proposeRecipe(deps, maintainer, { project: "orders", body: body({ label: "Third", approvedHosts: ["waiting.example.com"] }) });
    expect(await companyApprovedHosts(deps, ORG)).toEqual(["pypi.internal.example.com", "repo.example.org"]);
  });
});

describe("company locks", () => {
  const project: ProjectSetupSettings = {
    setupAgentEnabled: true, limits: { commands: 40, sameStepTries: 3, wallClockMinutes: 45, spendUsd: 4, hostAsks: 5 },
    hostsOnlyFromCompanyList: false, devcontainerImages: undefined, nightlyHealthEnabled: false, hostApprover: "maintainer",
  };

  it("lowers limits and turns things off or on, and nothing else", () => {
    const locked = applyCompanyLocks(project, { setupAgentOff: true, limits: { commands: 20, spendUsd: 2 }, hostsOnlyFromCompanyList: true, devcontainerImages: ["a/b:1"], nightlyHealthOn: true, hostApprover: "admin" });
    expect(locked).toEqual({
      setupAgentEnabled: false, limits: { commands: 20, sameStepTries: 3, wallClockMinutes: 45, spendUsd: 2, hostAsks: 5 },
      hostsOnlyFromCompanyList: true, devcontainerImages: ["a/b:1"], nightlyHealthEnabled: true, hostApprover: "admin",
    });
    expect(applyCompanyLocks(project, undefined)).toEqual(project);
    expect(applyCompanyLocks(project, {})).toEqual(project);
  });

  it("never loosens a project: a lock weaker than the project's own value changes nothing", () => {
    const strict: ProjectSetupSettings = {
      setupAgentEnabled: false, limits: { commands: 10, sameStepTries: 1, wallClockMinutes: 5, spendUsd: 1, hostAsks: 1 },
      hostsOnlyFromCompanyList: true, devcontainerImages: ["a/b:1"], nightlyHealthEnabled: true, hostApprover: "admin",
    };
    const weaker: CompanySetupLocks = { limits: { commands: 120, sameStepTries: 5, wallClockMinutes: 120, spendUsd: 20, hostAsks: 10 }, devcontainerImages: ["a/b:1", "c/d:2"] };
    expect(applyCompanyLocks(strict, weaker)).toEqual(strict);
  });

  it("is never looser than the project or the lock, over a grid of both (stricter only)", () => {
    const values = [1, 3, 40, 120];
    for (const projectCommands of values) for (const lockCommands of [undefined, ...values]) for (const enabled of [true, false]) for (const off of [undefined, true as const]) for (const only of [true, false]) for (const onlyLock of [undefined, true as const]) {
      const settings = { ...project, setupAgentEnabled: enabled, hostsOnlyFromCompanyList: only, limits: { ...project.limits, commands: projectCommands } };
      const locked = applyCompanyLocks(settings, { setupAgentOff: off, hostsOnlyFromCompanyList: onlyLock, limits: lockCommands === undefined ? undefined : { commands: lockCommands } });
      expect(locked.limits.commands).toBeLessThanOrEqual(projectCommands);
      if (lockCommands !== undefined) expect(locked.limits.commands).toBeLessThanOrEqual(lockCommands);
      expect(locked.setupAgentEnabled).toBe(enabled && off !== true);
      expect(locked.hostsOnlyFromCompanyList).toBe(only || onlyLock === true);
      if (enabled === false) expect(locked.setupAgentEnabled).toBe(false);
      if (only) expect(locked.hostsOnlyFromCompanyList).toBe(true);
    }
  });

  it("keeps a project's own image list, narrowed to the lock's list, and an empty lock list allows none", () => {
    expect(applyCompanyLocks({ ...project, devcontainerImages: ["a/b:1", "x/y:9"] }, { devcontainerImages: ["a/b:1", "c/d:2"] }).devcontainerImages).toEqual(["a/b:1"]);
    expect(applyCompanyLocks({ ...project, devcontainerImages: ["a/b:1"] }, { devcontainerImages: [] }).devcontainerImages).toEqual([]);
    expect(applyCompanyLocks(project, { devcontainerImages: [] }).devcontainerImages).toEqual([]);
    expect(applyCompanyLocks({ ...project, devcontainerImages: ["a/b:1"] }, {}).devcontainerImages).toEqual(["a/b:1"]);
  });

  it("is set by an admin with a fresh sign-in, against the revision they saw", async () => {
    const { deps, admin, store, sessions } = harness();
    expect(await code(setCompanyLocks(deps, admin, { locks: { setupAgentOff: true }, expectedRevision: 1 }))).toBe("CHANGE_STALE");
    const first = await setCompanyLocks(deps, admin, { locks: { setupAgentOff: true }, expectedRevision: null });
    expect(first).toMatchObject({ status: "applied", locks: { orgId: ORG, revision: 1, updatedBy: ADMIN, locks: { setupAgentOff: true } } });
    expect(await code(setCompanyLocks(deps, admin, { locks: { setupAgentOff: true }, expectedRevision: null }))).toBe("CHANGE_STALE");
    store.failNextCommit();
    expect(await code(setCompanyLocks(deps, admin, { locks: { setupAgentOff: true, nightlyHealthOn: true }, expectedRevision: 1 }))).toBe("CHANGE_STALE");
    const second = await setCompanyLocks(deps, admin, { locks: { setupAgentOff: true, nightlyHealthOn: true }, expectedRevision: 1 });
    expect(second).toMatchObject({ status: "applied", locks: { revision: 2 } });
    expect((await readCompanyLocks(deps, ORG))?.locks).toEqual({ setupAgentOff: true, nightlyHealthOn: true });
    expect(await readCompanyLocks(deps, OTHER_ORG)).toBeUndefined();
    expect(store.audit.map((entry) => [entry.action, entry.loosened])).toEqual([["locks_changed", false], ["locks_changed", false]]);
    sessions.set("s-admin", { developerId: ADMIN });
    expect(await code(setCompanyLocks(deps, admin, { locks: {}, expectedRevision: 2 }))).toBe("REAUTH_REQUIRED");
  });

  it("refuses limits above the design's maximum, below one, unknown fields and values that loosen", async () => {
    const { deps, admin } = harness();
    const bad: unknown[] = [
      { limits: { commands: SETUP_LIMIT_MAXIMA.commands + 1 } }, { limits: { spendUsd: 0 } }, { limits: { unknown: 1 } }, { unknown: true },
      { setupAgentOff: false }, { hostsOnlyFromCompanyList: false }, { nightlyHealthOn: false }, { hostApprover: "maintainer" }, { devcontainerImages: ["not an image"] },
    ];
    for (const locks of bad) expect(await code(setCompanyLocks(deps, admin, { locks, expectedRevision: null })), JSON.stringify(locks)).toBe("CONFIG_INVALID");
  });
});

describe("sharing a confirmed project setup", () => {
  const environment = TestEnvironmentBodySchema.parse({
    tier: "sandbox",
    repos: [{
      repositoryId: "svc",
      setupCommands: [{ cwd: "svc", executable: "uv", args: ["sync"], timeoutSeconds: 600, env: { TOKEN_HINT: "x" } }],
      checks: [{ id: "unit", label: "Unit", command: { cwd: "svc/tests", executable: "pytest", args: [], timeoutSeconds: 600 }, kind: "test", reportPath: "svc/reports/junit.xml", coveragePath: "svc/coverage.xml", selectArgs: ["{tests}"] }],
    }],
    roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] },
    nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
    services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] },
    capture: { screenshots: "failed", video: false, traces: false },
  });
  const input = { environment, repositoryId: "svc", repositoryDir: "svc", label: "Python", buildSystems: ["python"], toolchains: [{ tool: "python", version: "3.12" }], approvedHosts: ["pypi.internal.example.com"], match: FITS };

  it("turns working directories into {repo} templates and leaves the project's variables behind", () => {
    const result = recipeBodyFromProjectSetup(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.setupCommands).toEqual([{ cwd: "{repo}", executable: "uv", args: ["sync"], timeoutSeconds: 600 }]);
    expect(result.body.checks[0]?.command.cwd).toBe("{repo}/tests");
    expect(JSON.stringify(result.body)).not.toContain("TOKEN_HINT");
    // Report paths are {repo} templates too: the workspace directory never reaches the recipe.
    expect(result.body.checks[0]).toMatchObject({ reportPath: "{repo}/reports/junit.xml", coveragePath: "{repo}/coverage.xml" });
    expect(JSON.stringify(result.body)).not.toContain("svc/");
    expect(result.body.match.markerFiles).toEqual(["pyproject.toml"]);
    expect(setupFingerprint(result.body.match)).toBe(setupFingerprint(FITS));
  });

  it("stops when a command runs outside the repository, or the repository is not in the environment", () => {
    expect(recipeBodyFromProjectSetup({ ...input, repositoryDir: "other" })).toEqual({ ok: false, reason: "command_outside_repository" });
    expect(recipeBodyFromProjectSetup({ ...input, repositoryId: "nope" })).toEqual({ ok: false, reason: "repository_not_in_environment" });
    expect(recipeBodyFromProjectSetup({ ...input, approvedHosts: ["10.0.0.1"] })).toEqual({ ok: false, reason: "invalid_recipe" });
  });

  it("stops when a report path is outside the repository's directory", () => {
    const outsideReport = TestEnvironmentBodySchema.parse({ ...environment, repos: [{ ...environment.repos[0], checks: [{ ...environment.repos[0]!.checks[0], reportPath: "elsewhere/junit.xml" }] }] });
    expect(recipeBodyFromProjectSetup({ ...input, environment: outsideReport })).toEqual({ ok: false, reason: "path_outside_repository" });
  });

  it("refuses a repository directory that is not a plain relative path", () => {
    for (const repositoryDir of [".", "", "/abs", "../x"]) expect(recipeBodyFromProjectSetup({ ...input, repositoryDir })).toEqual({ ok: false, reason: "command_outside_repository" });
  });

  it("feeds proposeRecipe: the shared body is checked for the repository's names", async () => {
    const named = harness({ repositoryNames: { orders: ["acme/svc"] } });
    const { deps, maintainer } = harness();
    const result = recipeBodyFromProjectSetup({ ...input, label: "svc defaults" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await code(proposeRecipe(named.deps, named.maintainer, { project: "orders", body: result.body }))).toBe("CONFIG_INVALID");
    expect((await proposeRecipe(deps, maintainer, { project: "orders", body: result.body })).status).toBe("proposed");
  });
});

describe("fix round 1: loosening a lock needs a second admin (owner choice A)", () => {
  const strict: CompanySetupLocks = { setupAgentOff: true, limits: { commands: 20, spendUsd: 2 }, hostsOnlyFromCompanyList: true, devcontainerImages: ["a/b:1"], nightlyHealthOn: true, hostApprover: "admin" };

  it("tells a loosening from a stricter change, field by field", () => {
    expect(isLoosening(undefined, strict)).toBe(false);
    expect(isLoosening(strict, strict)).toBe(false);
    expect(isLoosening(strict, {})).toBe(true);
    const loosers: CompanySetupLocks[] = [
      { ...strict, setupAgentOff: undefined }, { ...strict, hostsOnlyFromCompanyList: undefined }, { ...strict, nightlyHealthOn: undefined }, { ...strict, hostApprover: undefined },
      { ...strict, limits: { commands: 21, spendUsd: 2 } }, { ...strict, limits: { spendUsd: 2 } }, { ...strict, limits: undefined },
      { ...strict, devcontainerImages: ["a/b:1", "c/d:2"] }, { ...strict, devcontainerImages: undefined },
    ];
    loosers.forEach((next, index) => expect(isLoosening(strict, next), String(index)).toBe(true));
    const stricter: CompanySetupLocks[] = [{ ...strict, limits: { commands: 10, spendUsd: 2, hostAsks: 3 } }, { ...strict, devcontainerImages: [] }, { ...strict, devcontainerImages: ["a/b:1"] }];
    stricter.forEach((next, index) => expect(isLoosening(strict, next), `s${String(index)}`).toBe(false));
    expect(isLoosening({ devcontainerImages: [] }, { devcontainerImages: ["a/b:1"] })).toBe(true);
  });

  it("applies a stricter change at once, and parks a loosening until a DIFFERENT admin approves it", async () => {
    const { deps, admin, admin2, store } = harness();
    const first = await setCompanyLocks(deps, admin, { locks: strict, expectedRevision: null });
    expect(first.status).toBe("applied");
    const loosening = await setCompanyLocks(deps, admin, { locks: { ...strict, setupAgentOff: undefined }, expectedRevision: 1 });
    expect(loosening.status).toBe("needs_second_admin");
    // The locks in force are unchanged while it waits.
    expect((await readCompanyLocks(deps, ORG))?.locks).toEqual(strict);
    const pending = (await readCompanyLocks(deps, ORG))!;
    expect(pending.pending?.proposedBy).toBe(ADMIN);
    // The proposer cannot approve their own change, however fresh; a stale pin or a wrong digest is refused.
    expect(await code(approveLocksChange(deps, admin, { expectedRevision: pending.revision, expectedDigest: pending.pending!.digest }))).toBe("FORBIDDEN");
    expect(await code(approveLocksChange(deps, admin2, { expectedRevision: pending.revision + 1, expectedDigest: pending.pending!.digest }))).toBe("CHANGE_STALE");
    expect(await code(approveLocksChange(deps, admin2, { expectedRevision: pending.revision, expectedDigest: "0".repeat(64) }))).toBe("CHANGE_STALE");
    const applied = await approveLocksChange(deps, admin2, { expectedRevision: pending.revision, expectedDigest: pending.pending!.digest });
    expect(applied.pending).toBeUndefined();
    expect(applied.locks).toEqual({ ...strict, setupAgentOff: undefined });
    expect((await readCompanyLocks(deps, ORG))?.locks.setupAgentOff).toBeUndefined();
    expect(await code(approveLocksChange(deps, admin2, { expectedRevision: applied.revision, expectedDigest: pending.pending!.digest }))).toBe("CHANGE_STALE");
    // The audit names revisions, digests and the loosened flag, and no lock text.
    const entries = store.audit.filter((entry) => entry.action.startsWith("locks"));
    expect(entries.map((entry) => [entry.action, entry.revision, entry.loosened])).toEqual([["locks_changed", 1, false], ["locks_change_proposed", 2, true], ["locks_change_approved", 3, true]]);
    for (const entry of entries) { expect(entry.previousDigest).toMatch(/^[a-f0-9]{64}$/); expect(entry.nextDigest).toMatch(/^[a-f0-9]{64}$/); }
    expect(entries[2]?.actor).toBe(SECOND_ADMIN);
  });

  it("needs a fresh sign-in and a live admin for the approval too, and a stricter change clears a waiting loosening", async () => {
    const { deps, admin, admin2, sessions } = harness();
    await setCompanyLocks(deps, admin, { locks: strict, expectedRevision: null });
    await setCompanyLocks(deps, admin, { locks: {}, expectedRevision: 1 });
    const pending = (await readCompanyLocks(deps, ORG))!;
    sessions.set("s-admin-2", { developerId: SECOND_ADMIN, authTime: "2026-11-01T11:00:00.000Z" });
    expect(await code(approveLocksChange(deps, admin2, { expectedRevision: pending.revision, expectedDigest: pending.pending!.digest }))).toBe("REAUTH_REQUIRED");
    sessions.set("s-admin-2", { developerId: SECOND_ADMIN, authTime: FRESH });
    expect(await code(approveLocksChange(deps, { ...admin2, developerId: MAINTAINER }, { expectedRevision: pending.revision, expectedDigest: pending.pending!.digest }))).toBe("FORBIDDEN");
    // The admin tightens something else meanwhile: the waiting loosening is gone, so it cannot be approved over the newer locks.
    const tighter = await setCompanyLocks(deps, admin, { locks: { ...strict, limits: { commands: 10, spendUsd: 2 } }, expectedRevision: pending.revision });
    expect(tighter.status).toBe("applied");
    expect((await readCompanyLocks(deps, ORG))?.pending).toBeUndefined();
    expect(await code(approveLocksChange(deps, admin2, { expectedRevision: pending.revision, expectedDigest: pending.pending!.digest }))).toBe("CHANGE_STALE");
  });

  describe("the sole-owner exception (owner, 2026-11-01: One-admin companies)", () => {
    const DAY = 86_400_000;
    const SOLE = { ownerIds: [ADMIN], eligibleIds: [ADMIN] };
    async function waitingLoosening(h: ReturnType<typeof harness>) {
      await setCompanyLocks(h.deps, h.admin, { locks: strict, expectedRevision: null });
      const result = await setCompanyLocks(h.deps, h.admin, { locks: {}, expectedRevision: 1 });
      expect(result.status).toBe("needs_second_admin");
      return result.locks;
    }

    it("lets the proposer approve alone when they are the only eligible admin and nobody left in 24 hours", async () => {
      const h = harness();
      Object.assign(h.evidence, SOLE);
      const waiting = await waitingLoosening(h);
      const applied = await approveLocksChange(h.deps, h.admin, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest });
      expect(applied.locks).toEqual({});
      const entry = h.store.audit.at(-1)!;
      expect(entry).toMatchObject({ action: "locks_change_approved", approvalMode: "sole_owner_exception", loosened: true, membershipVersion: 7, actor: ADMIN });
      // Positive control: with the loss exactly a day old the same call is allowed.
      const again = harness();
      Object.assign(again.evidence, SOLE, { lastEligibleLossAtMs: NOW.getTime() - DAY });
      const second = await waitingLoosening(again);
      expect((await approveLocksChange(again.deps, again.admin, { expectedRevision: second.revision, expectedDigest: second.pending!.digest })).locks).toEqual({});
    });

    it("refuses within 24 hours of another admin leaving, and says when it will be available", async () => {
      const h = harness();
      const lossAt = NOW.getTime() - 3_600_000;
      Object.assign(h.evidence, SOLE, { lastEligibleLossAtMs: lossAt });
      const waiting = await waitingLoosening(h);
      let failure: { code?: string; soleOwner?: { reasonCode: string; availableAt: string | null } } = {};
      try { await approveLocksChange(h.deps, h.admin, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest }); } catch (error) { failure = error as typeof failure; }
      expect(failure.code).toBe("FORBIDDEN");
      expect(failure.soleOwner).toEqual({ available: false, availableAt: new Date(lossAt + DAY).toISOString(), reasonCode: "SOLE_OWNER_COOL_OFF" });
      expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual(strict);
    });

    it("refuses the proposer's own approval while a second admin exists (two admins)", async () => {
      const h = harness();
      const waiting = await waitingLoosening(h);
      let failure: { soleOwner?: { reasonCode: string } } = {};
      try { await approveLocksChange(h.deps, h.admin, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest }); } catch (error) { failure = error as typeof failure; }
      expect(failure.soleOwner?.reasonCode).toBe("SECOND_PERSON_REQUIRED");
      const applied = await approveLocksChange(h.deps, h.admin2, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest });
      expect(applied.locks).toEqual({});
      expect(h.store.audit.at(-1)?.approvalMode).toBe("second_person");
    });

    it("refuses when the evidence is incomplete, or the proposer is no longer eligible", async () => {
      const h = harness();
      const waiting = await waitingLoosening(h);
      Object.assign(h.evidence, SOLE, { complete: false });
      expect(await code(approveLocksChange(h.deps, h.admin, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest }))).toBe("FORBIDDEN");
      Object.assign(h.evidence, { complete: true, eligibleIds: [SECOND_ADMIN], ownerIds: [SECOND_ADMIN] });
      expect(await code(approveLocksChange(h.deps, h.admin2, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest }))).toBe("FORBIDDEN");
    });

    it("is switched off by the company setting: a sole admin is refused, and the setting can only be removed through a second approval", async () => {
      const h = harness();
      Object.assign(h.evidence, SOLE);
      await setCompanyLocks(h.deps, h.admin, { locks: { ...strict, noSoleOwnerException: true }, expectedRevision: null });
      const waiting = await setCompanyLocks(h.deps, h.admin, { locks: strict, expectedRevision: 1 });
      // Removing the setting is itself a loosening, so it waits.
      expect(waiting.status).toBe("needs_second_admin");
      let failure: { soleOwner?: { reasonCode: string } } = {};
      try { await approveLocksChange(h.deps, h.admin, { expectedRevision: waiting.locks.revision, expectedDigest: waiting.locks.pending!.digest }); } catch (error) { failure = error as typeof failure; }
      expect(failure.soleOwner?.reasonCode).toBe("EXCEPTION_OFF");
      expect((await readCompanyLocks(h.deps, ORG))?.locks.noSoleOwnerException).toBe(true);
      // With a second admin it is still possible.
      Object.assign(h.evidence, { eligibleIds: [ADMIN, SECOND_ADMIN] });
      const applied = await approveLocksChange(h.deps, h.admin2, { expectedRevision: waiting.locks.revision, expectedDigest: waiting.locks.pending!.digest });
      expect(applied.locks.noSoleOwnerException).toBeUndefined();
    });

    describe("the evidence fences the commit (membership version and both people's live records)", () => {
      async function soleApproval(h: ReturnType<typeof harness>) {
        Object.assign(h.evidence, SOLE);
        const waiting = await waitingLoosening(h);
        return () => approveLocksChange(h.deps, h.admin, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest });
      }

      it("always passes a conditions list to the store: explicit empty for a proposal or a stricter change, the evidence's fences for an approval", async () => {
        const h = harness();
        Object.assign(h.evidence, SOLE);
        const waiting = await waitingLoosening(h); // a stricter first write, then a loosening proposal
        expect(h.store.lockCommits).toEqual([{ conditions: 0 }, { conditions: 0 }]);
        await approveLocksChange(h.deps, h.admin, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest });
        // META version + the one person (proposer and approver are the same admin).
        expect(h.store.lockCommits.at(-1)).toEqual({ conditions: 2 });
      });

      it("commits when nothing changed between the read and the write (positive control)", async () => {
        const h = harness();
        const approve = await soleApproval(h);
        expect((await approve()).locks).toEqual({});
        expect(h.store.audit.at(-1)?.approvalMode).toBe("sole_owner_exception");
      });

      it("refuses a sole-owner approval when a second admin is added (membership version moves) between the evidence read and the commit", async () => {
        const h = harness();
        const approve = await soleApproval(h);
        h.hooks.afterEvidence = () => { h.db.set({ ...orgMetaKey(ORG), approvalMembershipVersion: 8 }); h.db.set({ ...orgMemberKey(ORG, "e".repeat(64)), role: "admin" }); };
        expect(await code(approve())).toBe("CHANGE_STALE");
        expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual(strict);
        expect(h.store.audit.map((entry) => entry.action)).not.toContain("locks_change_approved");
      });

      it("refuses when the approver's or the proposer's live record changes or goes away before the write", async () => {
        for (const change of [(h: ReturnType<typeof harness>) => h.db.set({ ...orgMemberKey(ORG, ADMIN), role: "member" }), (h: ReturnType<typeof harness>) => h.db.delete(orgMemberKey(ORG, ADMIN))]) {
          const h = harness();
          const approve = await soleApproval(h);
          h.hooks.afterEvidence = () => change(h);
          expect(await code(approve())).toBe("CHANGE_STALE");
          expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual(strict);
        }
      });

      it("fences a two-admin approval the same way, and refuses evidence that names other people or carries no conditions", async () => {
        const h = harness();
        const waiting = await waitingLoosening(h);
        h.hooks.afterEvidence = () => h.db.delete(orgMemberKey(ORG, SECOND_ADMIN));
        expect(await code(approveLocksChange(h.deps, h.admin2, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest }))).toBe("CHANGE_STALE");
        h.hooks.afterEvidence = undefined;
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the harness's own arrow function, kept to wrap below
        const real = h.deps.approvalEvidence;
        h.deps.approvalEvidence = async (scope) => real({ ...scope, approverId: MAINTAINER });
        expect(await code(approveLocksChange(h.deps, h.admin2, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest }))).toBe("CHANGE_STALE");
        h.deps.approvalEvidence = async (scope) => ({ ...(await real(scope)), conditions: [] });
        expect(await code(approveLocksChange(h.deps, h.admin2, { expectedRevision: waiting.revision, expectedDigest: waiting.pending!.digest }))).toBe("CHANGE_STALE");
        expect((await readCompanyLocks(h.deps, ORG))?.locks).toEqual(strict);
      });
    });

    it("applies a stricter change directly, whatever the evidence", async () => {
      const h = harness();
      Object.assign(h.evidence, SOLE, { lastEligibleLossAtMs: NOW.getTime() - 1000 });
      await setCompanyLocks(h.deps, h.admin, { locks: {}, expectedRevision: null });
      expect((await setCompanyLocks(h.deps, h.admin, { locks: { nightlyHealthOn: true, noSoleOwnerException: true }, expectedRevision: 1 })).status).toBe("applied");
    });
  });

  it("lets nobody approve when nothing waits", async () => {
    const { deps, admin2 } = harness();
    expect(await code(approveLocksChange(deps, admin2, { expectedRevision: 1, expectedDigest: "0".repeat(64) }))).toBe("CHANGE_STALE");
  });
});

describe("fix round 1: repository names come from the broker's records, secrets are refused", () => {
  it("refuses an admin recipe whose label and args carry a repository's name or Git URL", async () => {
    const { deps, admin, store } = harness({ repositoryNames: { payments: ["acme/acme-payments-svc"] } });
    const input = body({ label: "acme-payments-svc setup", setupCommands: [cmd("git", ["clone", "git@github.com:acme/acme-payments-svc.git"])] });
    expect(await code(createRecipeAsAdmin(deps, admin, { body: input }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ setupCommands: [cmd("git", ["clone", "git@github.com:acme/acme-payments-svc.git"])] }) }))).toBe("CONFIG_INVALID");
    expect(store.recipes.size).toBe(0);
  });

  it("refuses a path that carries the project's repository directory, with no names in the request", async () => {
    const { deps, maintainer, store } = harness({ repositoryNames: { orders: ["acme/orders-api"] } });
    const input = body({ setupCommands: [cmd("pip", ["install", "-r", "/home/ci/orders-api/requirements.txt"])] });
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", body: input, repositoryNames: [] } as never))).toBe("CONFIG_INVALID");
    expect(store.recipes.size).toBe(0);
  });

  it("ignores a name list in the request, and refuses a project with no repository", async () => {
    const { deps, maintainer } = harness({ repositoryNames: { orders: ["orders-api"] } });
    const input = body({ setupCommands: [cmd("make", ["-C", "orders-api"])] });
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", body: input, repositoryNames: ["something-else"] } as never))).toBe("CONFIG_INVALID");
    const empty = harness({ repositoryNames: {} });
    expect(await code(proposeRecipe(empty.deps, empty.maintainer, { project: "orders", body: body() }))).toBe("CONFIG_INVALID");
  });

  it("refuses a body redaction would change: a credential in a URL, a key-shaped string, a credential flag value", async () => {
    const { deps, admin, maintainer, store } = harness();
    const token = `ghp_${"a1B2".repeat(9)}`; // built at runtime: no key-shaped literal in the source
    const inputs = [
      body({ setupCommands: [cmd("pip", ["install", "-r", "requirements.txt", "--index-url", `https://user:${token}@pypi.internal.example.com/simple`])] }),
      body({ setupCommands: [cmd("pip", ["install", `--extra-index-url=https://__token__:${token}@pypi.internal.example.com/simple`])] }),
      body({ setupCommands: [cmd("npm", ["config", "set", `//registry.example.com/:_authToken`, token])] }),
      body({ setupCommands: [cmd("tool", ["--password", "hunter2hunter2"])] }),
      body({ label: `Setup ${token}` }),
    ];
    for (const input of inputs) {
      expect(await code(createRecipeAsAdmin(deps, admin, { body: input })), JSON.stringify(input.setupCommands[0]?.args)).toBe("CONFIG_INVALID");
      expect(await code(proposeRecipe(deps, maintainer, { project: "orders", body: input }))).toBe("CONFIG_INVALID");
    }
    expect(store.recipes.size).toBe(0);
    // An auth setting with a plain value (not key-shaped) is refused, in the same argument or the next one, in setup, update and check commands.
    const settings: string[][] = [
      ["config", "set", "//registry.example.com/:_authToken", "plainvalue1"], ["config", "set", "//registry.example.com/:_authToken=plainvalue1"], ["config", "set", "_auth", "dXNlcjpwYXNz"],
      ["config", "set", "_password", "hunter"], ["config", "set", "_password=hunter"], ["config", "set", "npmAuthToken", "abc123"], ["config", "set", "//registry.example.com/:_authtoken", "x"],
    ];
    for (const args of settings) {
      for (const input of [body({ setupCommands: [cmd("npm", args)] }), body({ updateCommands: [cmd("npm", args)] }), body({ checks: [{ id: "unit", label: "Unit", command: cmd("npm", args), kind: "test" }] })]) {
        expect(await code(createRecipeAsAdmin(deps, admin, { body: input })), args.join(" ")).toBe("CONFIG_INVALID");
      }
    }
    expect(store.recipes.size).toBe(0);
    // Fix round 3: shell strings, spaced and quoted forms, YAML, Yarn variables, and `key=` with the value in the next argument.
    const bypasses: Array<[string, string[]]> = [
      ["shell string", ["-c", "npm config set //h/:_authToken abc"]],
      ["shell string with quotes", ["-c", "npm config set '//h/:_authToken' 'abc' && npm ci"]],
      ["spaces around =", ["config", "set", "_authToken = abc"]],
      ["yaml", ["-e", "npmAuthToken: abc"]],
      ["yaml, quoted value", ["-e", "npmAuthIdent: \"abc\""]],
      ["quoted key", ["config", "set", "\"//h/:_authToken\"=abc"]],
      ["yarn token variable", ["YARN_NPM_AUTH_TOKEN=abc", "yarn", "install"]],
      ["yarn ident variable", ["YARN_NPM_AUTH_IDENT=abc"]],
      ["yarn variable, value next, 3 args", ["env", "YARN_NPM_AUTH_TOKEN", "abc"]],
      ["yarn ident, value next, 3 args", ["env", "YARN_NPM_AUTH_IDENT", "abc"]],
      ["yarn variable in a shell string", ["-c", "export YARN_NPM_AUTH_IDENT dXNlcjpwYXNz"]],
      ["yarn variable, value next", ["YARN_NPM_AUTH_TOKEN", "abc"]],
      ["key= then value next", ["config", "set", "//h/:_authToken=", "abc"]],
      ["_auth= then value next", ["--_auth=", "abc"]],
      ["env prefix", ["-c", "NPM_CONFIG__AUTH=1 _auth=abc npm ci"]],
      ["upper case", ["config", "set", "//h/:_AUTHTOKEN=abc"]],
    ];
    for (const [name, args] of bypasses) {
      for (const input of [body({ setupCommands: [cmd("sh", args)] }), body({ updateCommands: [cmd("sh", args)] }), body({ checks: [{ id: "unit", label: "Unit", command: cmd("sh", args), kind: "test" }] })]) {
        expect(await code(createRecipeAsAdmin(deps, admin, { body: input })), name).toBe("CONFIG_INVALID");
      }
    }
    expect(store.recipes.size).toBe(0);
    // Positive controls: other settings, and a bare key with no value, are fine.
    for (const args of [["config", "set", "registry", "https://registry.example.com/"], ["config", "get", "//registry.example.com/:_authToken"], ["config", "set", "fund", "false"], ["-c", "npm config get //h/:_authToken"], ["config", "set", "_authority", "x"], ["run", "authenticate", "--_authors"]]) {
      expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ label: args.join(" "), setupCommands: [cmd("npm", args)] }) })), args.join(" ")).toBe("NO_ERROR");
    }
    store.recipes.clear();
    // Positive control: the same shape without a credential is accepted.
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ setupCommands: [cmd("pip", ["install", "-r", "requirements.txt", "--index-url", "https://pypi.internal.example.com/simple"])] }) }))).toBe("NO_ERROR");
  });
});

describe("fix round 1: revoked recipes do not fill the cap", () => {
  it("counts only proposed and approved recipes", async () => {
    const { deps, admin, store } = harness();
    for (let index = 0; index < SETUP_RECIPES_MAX_PER_ORG; index += 1) await createRecipeAsAdmin(deps, admin, { body: body({ label: `Recipe ${String(index)}` }) });
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ label: "Over" }) }))).toBe("CONFIG_INVALID");
    const first = [...store.recipes.values()][0]!;
    await revokeRecipe(deps, admin, { recipeId: first.recipeId, expectedRevision: 1 });
    expect(store.recipes.size).toBe(SETUP_RECIPES_MAX_PER_ORG);
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ label: "Fits now" }) }))).toBe("NO_ERROR");
    expect(store.recipes.size).toBe(SETUP_RECIPES_MAX_PER_ORG + 1);
  });

  it("still lets a company create and propose when all its history is revoked", async () => {
    const { deps, admin, maintainer, store } = harness();
    const made = await createRecipeAsAdmin(deps, admin, { body: body() });
    for (let index = 0; index < SETUP_RECIPES_MAX_PER_ORG + 5; index += 1) store.recipes.set(`${ORG}#rcp_${index.toString(16).padStart(20, "1")}`, { ...made, recipeId: `rcp_${index.toString(16).padStart(20, "1")}`, status: "revoked" });
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ label: "New" }) }))).toBe("NO_ERROR");
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", body: body({ label: "Proposed" }) }))).toBe("NO_ERROR");
  });
});
