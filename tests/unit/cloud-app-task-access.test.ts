// Review round 2 (M9, M10): the start rule of `cloudTaskAccess` (cloud/app/entry.ts) is Cloud's own, read from the real project and role records: the project role (checkProjectAccess)
// and the refusals that belong where new work starts (requireNewWorkAllowed: an archived project, a role that may not start tasks).
import { describe, expect, it } from "vitest";
import { projectMetaKey, orgProjectCatalogKey, projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { cloudTaskAccess } from "../../packages/broker/src/cloud/app/index.js";
import { createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import { PEOPLE_ORG, createPeopleWorld, type Person, type PeopleWorld } from "../support/cloud-people-world.js";

const seedProject = (world: PeopleWorld, options: { archived?: boolean } = {}) => {
  world.db.set({
    ...projectRevisionKey(PEOPLE_ORG, "payments", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z",
    definition: { name: "payments", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/payments.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
  });
  world.db.set({ ...orgProjectCatalogKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  world.db.set({
    ...projectMetaKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: options.archived === true ? "archived" : "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: world.people.owner.developerId,
    ...(options.archived === true ? { archivedAt: "2026-10-03T00:00:00.000Z", archivedBy: world.people.owner.developerId } : {}),
  });
};
const grant = (world: PeopleWorld, who: Person, role: "developer" | "viewer") =>
  world.db.set({ ...projectMemberKey(PEOPLE_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", role });

async function startAs(world: PeopleWorld, who: Person, project = "payments") {
  const principal = (await createCloudIdentityProvider(world.routes).getPrincipal(PEOPLE_ORG, who.developerId)) ?? { companyId: PEOPLE_ORG, personId: who.developerId, roles: [who.role], displayName: who.name, provider: "oidc", methods: [] };
  return await cloudTaskAccess(() => world.routes).checkStart(principal, project);
}

describe("cloudTaskAccess.checkStart is Cloud's own start rule", () => {
  it("a member with a developer grant, and a company admin (a maintainer of every project), may start", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "developer");
    expect(await startAs(world, world.people.member)).toEqual({ allowed: true });
    expect(await startAs(world, world.people.maintainer)).toEqual({ allowed: true });
    expect(await startAs(world, world.people.owner)).toEqual({ allowed: true });
  });

  it("a member with no grant on the project is refused as Cloud refuses it (a denied project)", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    expect(await startAs(world, world.people.member)).toMatchObject({ allowed: false, code: "PROJECT_ACCESS_DENIED" });
  });

  it("a viewer is refused where new work starts, in the viewer's own words", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "viewer");
    const refused = await startAs(world, world.people.member);
    expect(refused).toMatchObject({ allowed: false, code: "PROJECT_ACCESS_DENIED" });
    expect((refused as { message: string }).message).toMatch(/can view `payments` but not start/);
  });

  it("an archived project refuses every kind of new work, a maintainer's included", async () => {
    const world = createPeopleWorld();
    seedProject(world, { archived: true });
    grant(world, world.people.member, "developer");
    for (const who of [world.people.member, world.people.owner]) expect(await startAs(world, who), who.key).toMatchObject({ allowed: false, code: "PROJECT_ARCHIVED" });
  });

  it("a project that does not exist, and the Auditor (who has no project role), are refused", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    expect(await startAs(world, world.people.owner, "ghost")).toMatchObject({ allowed: false, code: "PROJECT_NOT_FOUND" });
    expect((await startAs(world, world.people.auditor)).allowed).toBe(false);
  });

  it("a person who is revoked or of another company cannot be found as a caller and starts nothing", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    const access = cloudTaskAccess(() => world.routes);
    for (const who of [world.people.revoked, world.people.stranger]) {
      expect(await access.checkStart({ companyId: PEOPLE_ORG, personId: who.developerId, roles: ["owner"] } as never, "payments"), who.key).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    }
  });
});
