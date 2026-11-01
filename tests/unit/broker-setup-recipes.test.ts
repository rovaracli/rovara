// Setup and test health SH29: company setup recipes and company locks (admin only with a fresh sign-in; locks stricter only; no repository names stored).
import { describe, expect, it } from "vitest";
import { AgentXError, TestEnvironmentBodySchema, setupFingerprint, type OrgId, type SetupRecipeBody, SetupRecipeBodySchema } from "@agentx/contracts";
import {
  SETUP_LIMIT_MAXIMA, SETUP_RECIPES_MAX_PER_ORG, SETUP_RECIPES_MAX_PROPOSED, applyCompanyLocks, approveRecipe, companyApprovedHosts, createRecipeAsAdmin, offeredRecipes, proposeRecipe, readCompanyLocks,
  recipeBodyFromProjectSetup, revokeRecipe, setCompanyLocks, setRecipeScope, type CompanySetupLocks, type ProjectSetupSettings, type RecipeCaller, type SetupRecipeDeps,
} from "../../packages/broker/src/org/setup-recipes.js";
import { memorySetupRecipeStore } from "../support/memory-setup-recipe-store.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ADMIN = "a".repeat(64);
const MAINTAINER = "b".repeat(64);
const NOW = new Date("2026-11-01T12:00:00.000Z");
const FRESH = "2026-11-01T11:58:00.000Z";
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

function harness(options: { admins?: string[]; maintainers?: Record<string, string[]>; refusedHosts?: string[] } = {}) {
  const store = memorySetupRecipeStore();
  const admins = new Set(options.admins ?? [ADMIN]);
  const maintainers = options.maintainers ?? { [MAINTAINER]: ["orders"] };
  const refused = new Set(options.refusedHosts ?? ["evil.example.net"]);
  const clock = { now: NOW };
  let counter = 0;
  const calls: string[] = [];
  const deps: SetupRecipeDeps = {
    store: {
      ...store,
      getRecipe: (...args) => { calls.push("store"); return store.getRecipe(...args); },
      listRecipes: (...args) => { calls.push("store"); return store.listRecipes(...args); },
      getLocks: (...args) => { calls.push("store"); return store.getLocks(...args); },
    },
    requireAdmin: (caller) => { calls.push("admin"); return admins.has(caller.developerId) ? Promise.resolve() : Promise.reject(new AgentXError("FORBIDDEN", "Live company owner or admin access is required.", 403)); },
    requireProjectMaintainer: (caller, project) => (maintainers[caller.developerId]?.includes(project) ? Promise.resolve() : Promise.reject(new AgentXError("FORBIDDEN", "no", 403))),
    isHostRefused: (host) => refused.has(host),
    now: () => clock.now,
    newRecipeSuffix: () => { counter += 1; return counter.toString(16).padStart(20, "0"); },
  };
  const admin: RecipeCaller = { orgId: ORG, developerId: ADMIN, freshSignInAt: FRESH };
  const maintainer: RecipeCaller = { orgId: ORG, developerId: MAINTAINER };
  return { store, deps, admin, maintainer, clock, calls, refused };
}
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? "OTHER"; }
  return "NO_ERROR";
};

describe("admin authority", () => {
  it("refuses a non-admin for every admin action and writes nothing", async () => {
    const { deps, store, maintainer } = harness();
    const asMaintainer = { ...maintainer, freshSignInAt: FRESH };
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
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
    await code(approveRecipe(deps, { ...maintainer, freshSignInAt: FRESH }, { recipeId: `rcp_${"0".repeat(20)}`, expectedRevision: 1, expectedDigest: "x" }));
    expect(calls).toEqual(["admin"]);
    expect(await code(createRecipeAsAdmin(deps, { orgId: "nope", developerId: ADMIN, freshSignInAt: FRESH }, { body: body() }))).toBe("FORBIDDEN");
    expect(await code(createRecipeAsAdmin(deps, { orgId: ORG, developerId: "short", freshSignInAt: FRESH }, { body: body() }))).toBe("FORBIDDEN");
  });

  it("needs a fresh sign-in: none, too old, or from the future is REAUTH_REQUIRED", async () => {
    const { deps, store, admin } = harness();
    for (const freshSignInAt of [undefined, "2026-11-01T11:49:59.000Z", "2026-11-01T12:05:00.000Z", "not a date"]) {
      expect(await code(createRecipeAsAdmin(deps, { ...admin, freshSignInAt }, { body: body() })), String(freshSignInAt)).toBe("REAUTH_REQUIRED");
    }
    expect(store.recipes.size).toBe(0);
    expect(await code(createRecipeAsAdmin(deps, { ...admin, freshSignInAt: "2026-11-01T11:50:30.000Z" }, { body: body() }))).toBe("NO_ERROR");
  });

  it("lets a project maintainer propose but never approve or write an approved recipe", async () => {
    const { deps, maintainer, store } = harness();
    expect(await code(proposeRecipe(deps, { orgId: ORG, developerId: "c".repeat(64) }, { project: "orders", repositoryNames: [], body: body() }))).toBe("FORBIDDEN");
    expect(await code(proposeRecipe(deps, maintainer, { project: "billing", repositoryNames: [], body: body() }))).toBe("FORBIDDEN");
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
    expect(proposed.status).toBe("proposed");
    expect(await code(approveRecipe(deps, maintainer, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("FORBIDDEN");
    expect(store.recipes.get(`${ORG}#${proposed.recipeId}`)?.status).toBe("proposed");
  });
});

describe("approval", () => {
  it("is pinned to the revision and digest the admin saw", async () => {
    const { deps, maintainer, admin } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 2, expectedDigest: proposed.bodyDigest }))).toBe("CHANGE_STALE");
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: "0".repeat(64) }))).toBe("CHANGE_STALE");
    const approved = await approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest });
    expect(approved).toMatchObject({ status: "approved", revision: 2, approvedBy: ADMIN, approvedAt: NOW.toISOString() });
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 2, expectedDigest: proposed.bodyDigest }))).toBe("CHANGE_STALE");
  });

  it("is refused when the row changed under the admin, and when the recipe is not found or is another company's", async () => {
    const { deps, maintainer, admin, store } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
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
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
    refused.add("pypi.internal.example.com");
    expect(await code(approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest }))).toBe("CONFIG_INVALID");
  });
});

describe("what is stored", () => {
  it("refuses a body that names the repository, whoever writes it, and stores nothing", async () => {
    const { deps, maintainer, admin, store } = harness();
    const names = ["acme/orders-service"];
    const naming = body({ setupCommands: [cmd("make", ["-C", "orders-service"])] });
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: names, body: naming }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { repositoryNames: names, body: body({ label: "Acme setup" }) }))).toBe("CONFIG_INVALID");
    expect(store.recipes.size).toBe(0);
    expect(store.audit).toEqual([]);
  });

  it("keeps no repository name, project name or recipe text in a stored row's provenance, nor in the audit", async () => {
    const { deps, maintainer, admin, store } = harness();
    const names = ["acme/orders-service", "orders-service"];
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: names, body: body() });
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
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body({ approvedHosts: ["evil.example.net"] }) }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ approvedHosts: ["evil.example.net"] }) }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: { ...body(), approvedHosts: ["*.example.com"] } }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: { ...body(), env: { A: "b" } } }))).toBe("CONFIG_INVALID");
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body(), scope: { kind: "projects", projects: [] } }))).toBe("CONFIG_INVALID");
  });

  it("answers the first proposal when the same project proposes the same body again", async () => {
    const { deps, maintainer, store } = harness({ maintainers: { [MAINTAINER]: ["orders", "billing"] } });
    const first = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
    const again = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
    expect(again.recipeId).toBe(first.recipeId);
    await proposeRecipe(deps, maintainer, { project: "billing", repositoryNames: [], body: body() });
    expect(store.recipes.size).toBe(2);
  });

  it("bounds what is waiting and what is kept", async () => {
    const { deps, admin, maintainer, store } = harness();
    for (let index = 0; index < SETUP_RECIPES_MAX_PROPOSED; index += 1) await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body({ label: `Recipe ${String(index)}` }) });
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body({ label: "One more" }) }))).toBe("CONFIG_INVALID");
    for (let index = SETUP_RECIPES_MAX_PROPOSED; index < SETUP_RECIPES_MAX_PER_ORG; index += 1) await createRecipeAsAdmin(deps, admin, { body: body({ label: `Recipe ${String(index)}` }) });
    expect(store.recipes.size).toBe(SETUP_RECIPES_MAX_PER_ORG);
    expect(await code(createRecipeAsAdmin(deps, admin, { body: body({ label: "Over" }) }))).toBe("CONFIG_INVALID");
  });
});

describe("who a recipe is offered to", () => {
  it("offers only approved recipes, to projects in scope, whose fingerprint fits", async () => {
    const { deps, admin, maintainer } = harness();
    const proposed = await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body() });
    expect(await offeredRecipes(deps, { orgId: ORG, project: "orders", repository: FITS })).toEqual([]);
    const approved = await approveRecipe(deps, admin, { recipeId: proposed.recipeId, expectedRevision: 1, expectedDigest: proposed.bodyDigest });
    const offered = await offeredRecipes(deps, { orgId: ORG, project: "anything", repository: FITS });
    expect(offered).toEqual([{ recipeId: approved.recipeId, revision: 2, bodyDigest: approved.bodyDigest, body: approved.body }]);
    expect(await offeredRecipes(deps, { orgId: ORG, project: "anything", repository: { markerFiles: ["package.json"], registryHosts: [] } })).toEqual([]);
    expect(await offeredRecipes(deps, { orgId: ORG, project: "anything", repository: { markerFiles: [], registryHosts: [] } })).toEqual([]);
    expect(await offeredRecipes(deps, { orgId: OTHER_ORG, project: "anything", repository: FITS })).toEqual([]);
  });

  it("offers only to the listed projects when the admin says so, and back to all", async () => {
    const { deps, admin } = harness();
    const created = await createRecipeAsAdmin(deps, admin, { body: body(), scope: { kind: "projects", projects: ["orders", "billing"] } });
    expect((await offeredRecipes(deps, { orgId: ORG, project: "orders", repository: FITS })).length).toBe(1);
    expect(await offeredRecipes(deps, { orgId: ORG, project: "search", repository: FITS })).toEqual([]);
    expect(await code(setRecipeScope(deps, admin, { recipeId: created.recipeId, expectedRevision: 9, scope: { kind: "company" } }))).toBe("CHANGE_STALE");
    const widened = await setRecipeScope(deps, admin, { recipeId: created.recipeId, expectedRevision: 1, scope: { kind: "company" } });
    expect(widened.revision).toBe(2);
    expect((await offeredRecipes(deps, { orgId: ORG, project: "search", repository: FITS })).length).toBe(1);
  });

  it("stops offering a revoked recipe, and keeps it", async () => {
    const { deps, admin, store } = harness();
    const created = await createRecipeAsAdmin(deps, admin, { body: body() });
    expect(await code(revokeRecipe(deps, admin, { recipeId: created.recipeId, expectedRevision: 5 }))).toBe("CHANGE_STALE");
    const revoked = await revokeRecipe(deps, admin, { recipeId: created.recipeId, expectedRevision: 1 });
    expect(revoked.status).toBe("revoked");
    expect(await offeredRecipes(deps, { orgId: ORG, project: "orders", repository: FITS })).toEqual([]);
    expect(await companyApprovedHosts(deps, ORG)).toEqual([]);
    expect(store.recipes.size).toBe(1);
    expect(store.audit.map((entry) => entry.action)).toEqual(["recipe_created", "recipe_revoked"]);
  });

  it("does not offer a recipe whose dev container image is not on the company's list", async () => {
    const { deps, admin } = harness();
    await createRecipeAsAdmin(deps, admin, { body: body() });
    const locks = await setCompanyLocks(deps, admin, { locks: { devcontainerImages: ["mcr.microsoft.com/devcontainers/go:1.23"] }, expectedRevision: null });
    expect(await offeredRecipes(deps, { orgId: ORG, project: "orders", repository: FITS })).toEqual([]);
    await setCompanyLocks(deps, admin, { locks: { devcontainerImages: ["mcr.microsoft.com/devcontainers/python:3.12"] }, expectedRevision: locks.revision });
    expect((await offeredRecipes(deps, { orgId: ORG, project: "orders", repository: FITS })).length).toBe(1);
  });

  it("lists the hosts approved through recipes, once each, for approved recipes only", async () => {
    const { deps, admin, maintainer } = harness();
    await createRecipeAsAdmin(deps, admin, { body: body() });
    await createRecipeAsAdmin(deps, admin, { body: body({ label: "Second", approvedHosts: ["pypi.internal.example.com", "repo.example.org"] }) });
    await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: [], body: body({ label: "Third", approvedHosts: ["waiting.example.com"] }) });
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
    const { deps, admin, store } = harness();
    expect(await code(setCompanyLocks(deps, admin, { locks: { setupAgentOff: true }, expectedRevision: 1 }))).toBe("CHANGE_STALE");
    const first = await setCompanyLocks(deps, admin, { locks: { setupAgentOff: true }, expectedRevision: null });
    expect(first).toMatchObject({ orgId: ORG, revision: 1, updatedBy: ADMIN, locks: { setupAgentOff: true } });
    expect(await code(setCompanyLocks(deps, admin, { locks: {}, expectedRevision: null }))).toBe("CHANGE_STALE");
    store.failNextCommit();
    expect(await code(setCompanyLocks(deps, admin, { locks: {}, expectedRevision: 1 }))).toBe("CHANGE_STALE");
    const second = await setCompanyLocks(deps, admin, { locks: { nightlyHealthOn: true }, expectedRevision: 1 });
    expect(second.revision).toBe(2);
    expect((await readCompanyLocks(deps, ORG))?.locks).toEqual({ nightlyHealthOn: true });
    expect(await readCompanyLocks(deps, OTHER_ORG)).toBeUndefined();
    expect(store.audit.map((entry) => entry.action)).toEqual(["locks_changed", "locks_changed"]);
    expect(await code(setCompanyLocks(deps, { ...admin, freshSignInAt: undefined }, { locks: {}, expectedRevision: 2 }))).toBe("REAUTH_REQUIRED");
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
      checks: [{ id: "unit", label: "Unit", command: { cwd: "svc/tests", executable: "pytest", args: [], timeoutSeconds: 600 }, kind: "test", reportPath: "reports/junit.xml", selectArgs: ["{tests}"] }],
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
    expect(result.body.match.markerFiles).toEqual(["pyproject.toml"]);
    expect(setupFingerprint(result.body.match)).toBe(setupFingerprint(FITS));
  });

  it("stops when a command runs outside the repository, or the repository is not in the environment", () => {
    expect(recipeBodyFromProjectSetup({ ...input, repositoryDir: "other" })).toEqual({ ok: false, reason: "command_outside_repository" });
    expect(recipeBodyFromProjectSetup({ ...input, repositoryId: "nope" })).toEqual({ ok: false, reason: "repository_not_in_environment" });
    expect(recipeBodyFromProjectSetup({ ...input, approvedHosts: ["10.0.0.1"] })).toEqual({ ok: false, reason: "invalid_recipe" });
  });

  it("refuses a repository directory that is not a plain relative path", () => {
    for (const repositoryDir of [".", "", "/abs", "../x"]) expect(recipeBodyFromProjectSetup({ ...input, repositoryDir })).toEqual({ ok: false, reason: "command_outside_repository" });
  });

  it("feeds proposeRecipe: the shared body is checked for the repository's names", async () => {
    const { deps, maintainer } = harness();
    const result = recipeBodyFromProjectSetup({ ...input, label: "svc defaults" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await code(proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: ["acme/svc"], body: result.body }))).toBe("CONFIG_INVALID");
    expect((await proposeRecipe(deps, maintainer, { project: "orders", repositoryNames: ["acme/orders-service"], body: result.body })).status).toBe("proposed");
  });
});
