// Review round 2 (M9, M10): the start rule of `cloudTaskAccess` (cloud/app/entry.ts) is Cloud's own, read from the real project and role records: the project role (checkProjectAccess)
// and the refusals that belong where new work starts (requireNewWorkAllowed: an archived project, a role that may not start tasks).
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { projectMetaKey, orgProjectCatalogKey, projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { STEP_OWNER_CHANGED_WORDS, cloudTaskAccess, isStepFence, stepFence } from "../../packages/broker/src/cloud/app/index.js";
import { createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import { PEOPLE_ORG, createPeopleWorld, type Person, type PeopleWorld } from "../support/cloud-people-world.js";

const seedProject = (world: PeopleWorld, options: { archived?: boolean; tasksOff?: boolean } = {}) => {
  world.db.set({
    ...projectRevisionKey(PEOPLE_ORG, "payments", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z",
    definition: { name: "payments", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/payments.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work.", ...(options.tasksOff === true ? { developerTasks: { enabled: false } } : {}) },
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

describe("cloudTaskAccess.canAct is v2's set: the task's owner, and no one else", () => {
  const TASK = "22222222-2222-4222-8222-222222222222";
  const seedTask = (world: PeopleWorld, owner: Person) => world.db.set({
    pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", taskId: TASK, orgId: PEOPLE_ORG, project: "payments", developerId: owner.developerId, developerName: owner.name, ownerKey: taskOwnerKey(owner.developerId, TASK),
    workspaceId: "33333333-3333-4333-8333-333333333333", status: "RUNNING", createdAt: "2026-11-12T10:00:00.000Z",
  });
  const canAct = async (world: PeopleWorld, who: Person) => await cloudTaskAccess(() => world.routes).canAct(
    (await createCloudIdentityProvider(world.routes).getPrincipal(PEOPLE_ORG, who.developerId)) ?? { companyId: PEOPLE_ORG, personId: who.developerId, roles: [who.role], displayName: who.name, provider: "oidc", methods: [] },
    { taskId: TASK, developerId: world.people.owner.developerId, project: "payments" } as never,
  );

  it("the owner may act; a company admin, a contributor and a viewer who are not the owner may not", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    seedTask(world, world.people.owner);
    grant(world, world.people.member, "developer");
    expect(await canAct(world, world.people.owner)).toBe(true);
    expect(await canAct(world, world.people.maintainer)).toBe(false);
    expect(await canAct(world, world.people.member)).toBe(false);
    grant(world, world.people.member, "viewer");
    expect(await canAct(world, world.people.member)).toBe(false);
  });

  it("a task row as the CORE writes it (it names `companyId`, no `orgId`) is the same task: the owner acts and the others do not, and a step is allowed", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "developer");
    world.db.set({
      pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", taskId: TASK, companyId: PEOPLE_ORG, project: "payments", developerId: world.people.member.developerId, developerName: "Mia",
      ownerKey: taskOwnerKey(world.people.member.developerId, TASK), workspaceId: "33333333-3333-4333-8333-333333333333", status: "RUNNING", createdAt: "2026-11-12T10:00:00.000Z",
    });
    expect(await canAct(world, world.people.member)).toBe(true);
    expect(await canAct(world, world.people.maintainer)).toBe(false);
    expect(await cloudTaskAccess(() => world.routes).checkStep(world.db.get(`DEVTASK#${TASK}`, "META") as never)).toMatchObject({ allowed: true });
  });

  it("a person who is revoked, of another company, or the Auditor may not", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    seedTask(world, world.people.owner);
    for (const who of [world.people.revoked, world.people.stranger, world.people.auditor]) expect(await canAct(world, who), who.key).toBe(false);
  });

  it("a task of another company, or one that does not exist, is not actable", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    expect(await canAct(world, world.people.owner)).toBe(false);
    world.db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", taskId: TASK, orgId: "org_s3other000000000000z", project: "payments", developerId: world.people.owner.developerId, ownerKey: taskOwnerKey(world.people.owner.developerId, TASK) });
    expect(await canAct(world, world.people.owner)).toBe(false);
  });
});

describe("switch blocker 1: cloudTaskAccess.checkStep is v2's dispatch check, fenced into the step", () => {
  const TASK = "44444444-4444-4444-8444-444444444444";
  const taskOf = (world: PeopleWorld, creator: Person, extra: Record<string, unknown> = {}) => ({
    pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", taskId: TASK, orgId: PEOPLE_ORG, project: "payments", developerId: creator.developerId, developerName: creator.name, provider: "oidc",
    ownerKey: taskOwnerKey(creator.developerId, TASK), workspaceId: "55555555-5555-4555-8555-555555555555", ...extra,
  });
  // The task row is in the table as the core keeps it (the step re-reads it, M-4), unless a test stores another.
  const step = async (world: PeopleWorld, task: Record<string, unknown>, stored: Record<string, unknown> | null = task) => {
    if (stored !== null) world.db.set(stored);
    return await cloudTaskAccess(() => world.routes).checkStep(task as never);
  };

  it("the owner of a task in an open project may have a step, and the answer fences the owner's seat, grant, the project's revision and its archive status", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "developer");
    const verdict = await step(world, taskOf(world, world.people.member));
    expect(verdict).toMatchObject({ allowed: true });
    const items = (verdict as unknown as { items: Array<{ key: { pk: string; sk: string }; condition: unknown }> }).items;
    expect(items).toHaveLength(5);
    // Every item is marked as the step's fence, so a transaction that fails on one is retried, not dropped (cloud-app-step-fence.test.ts).
    expect(items.every((item) => isStepFence(item))).toBe(true);
    // The fence holds as long as nothing changed, and refuses the step when any of the four does.
    const store = new MemoryDocumentStore();
    const copy = (key: { pk: string; sk: string }) => { const row = world.db.get(key); if (row !== undefined) void store.put({ item: row as never }); };
    for (const item of items) copy(item.key);
    await Promise.resolve();
    const fenced = async () => (await store.transact(items.map((item) => ({ kind: "check" as const, key: item.key, condition: item.condition as never })))).applied;
    expect(await fenced()).toBe(true);
    const [member, , catalog, meta, people] = items;
    await store.put({ item: { ...(world.db.get(member!.key) as object), role: "auditor" } as never });
    expect(await fenced()).toBe(false);
    await store.put({ item: world.db.get(member!.key) as never });
    expect(await fenced()).toBe(true);
    await store.put({ item: { ...(world.db.get(catalog!.key) as object), latestRevision: 2 } as never });
    expect(await fenced()).toBe(false);
    await store.put({ item: world.db.get(catalog!.key) as never });
    await store.put({ item: { ...(world.db.get(meta!.key) as object), status: "archived" } as never });
    expect(await fenced()).toBe(false);
    await store.put({ item: world.db.get(meta!.key) as never });
    // A grant demoted to a viewer between the check and the commit refuses the step, as does a grant that is gone.
    const grantRow = world.db.get(items[1]!.key) as object;
    await store.put({ item: { ...grantRow, role: "viewer" } as never });
    expect(await fenced()).toBe(false);
    await store.put({ item: { ...grantRow, projectRole: "maintainer" } as never });
    expect(await fenced()).toBe(false);
    await store.put({ item: grantRow as never });
    expect(await fenced()).toBe(true);
    // A take-over (it writes the task's PEOPLE sidecar) between the check and the commit refuses the step.
    await store.put({ item: { pk: people!.key.pk, sk: people!.key.sk, revision: 1 } });
    expect(await fenced()).toBe(false);
    await store.delete({ key: people!.key });
    await store.delete({ key: items[1]!.key });
    expect(await fenced()).toBe(false);
  });

  it("with a PEOPLE sidecar present the fence holds its revision, and a change of it refuses the step", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "developer");
    world.db.set({ pk: `DEVTASK#${TASK}`, sk: "PEOPLE", revision: 3 });
    const verdict = await step(world, taskOf(world, world.people.member));
    const people = (verdict as unknown as { items: Array<{ key: { pk: string; sk: string }; condition: unknown }> }).items.at(-1)!;
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", revision: 3 } });
    const holds = async () => (await store.transact([{ kind: "check", key: people.key, condition: people.condition as never }])).applied;
    expect(await holds()).toBe(true);
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", revision: 4 } });
    expect(await holds()).toBe(false);
  });

  it("the fence of a step by channel access names each bound channel, and holds the catalog as absent where it was", async () => {
    const base = { orgId: PEOPLE_ORG, project: "payments", taskId: TASK, developerId: "e".repeat(64), orgRole: "member", revision: 1, grant: undefined, people: undefined };
    const items = stepFence({ ...base, catalog: undefined, channelKeys: [{ pk: `ORG#${PEOPLE_ORG}#SLACK_BINDING#T0PEOPLE1`, sk: "CHANNEL#C0CHAN" }] });
    const store = new MemoryDocumentStore();
    const run = async () => (await store.transact(items.map((item) => ({ kind: "check" as const, key: item.key, condition: item.condition })))).applied;
    // No grant row, no binding row: the person's channel access is gone.
    expect(await run()).toBe(false);
    await store.put({ item: { ...orgMemberKey(PEOPLE_ORG, base.developerId), role: "member" } });
    await store.put({ item: { pk: `ORG#${PEOPLE_ORG}#SLACK_BINDING#T0PEOPLE1`, sk: "CHANNEL#C0CHAN", projectName: "payments" } });
    expect(await run()).toBe(true);
    // The channel rebound to another project, or the catalog row appearing where there was none, refuses the step.
    await store.put({ item: { pk: `ORG#${PEOPLE_ORG}#SLACK_BINDING#T0PEOPLE1`, sk: "CHANNEL#C0CHAN", projectName: "other" } });
    expect(await run()).toBe(false);
  });

  it("a company admin (a maintainer of every project) owns a task with no grant: the fence has no grant to hold", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    const verdict = await step(world, taskOf(world, world.people.maintainer));
    expect(verdict).toMatchObject({ allowed: true });
    expect((verdict as unknown as { items: unknown[] }).items).toHaveLength(4);
  });

  it("a removed or revoked owner, an owner of another company, and a demoted Auditor get no step", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    for (const who of [world.people.revoked, world.people.stranger, world.people.auditor]) expect(await step(world, taskOf(world, who)), who.key).toMatchObject({ allowed: false });
  });

  it("an owner who lost their grant, a viewer, a project with its tasks off and an archived project get no step", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    expect(await step(world, taskOf(world, world.people.member))).toMatchObject({ allowed: false });
    grant(world, world.people.member, "viewer");
    expect(await step(world, taskOf(world, world.people.member))).toMatchObject({ allowed: false });
    const off = createPeopleWorld();
    seedProject(off, { tasksOff: true });
    grant(off, off.people.member, "developer");
    expect(await step(off, taskOf(off, off.people.member))).toMatchObject({ allowed: false });
    const archived = createPeopleWorld();
    seedProject(archived, { archived: true });
    expect(await step(archived, taskOf(archived, archived.people.owner))).toMatchObject({ allowed: false });
  });

  it("M-4: a task whose row names another owner than the record the step was given (a take-over between the two reads) is held back with words, never run for the wrong person; a task with no row is too", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "developer");
    grant(world, world.people.owner, "developer");
    const record = taskOf(world, world.people.member);
    const taken = { ...record, currentOwner: { developerId: world.people.owner.developerId, name: "Owner", provider: "oidc", since: "2026-11-13T09:00:00.000Z" } };
    expect(await step(world, record, taken)).toEqual({ allowed: false, message: STEP_OWNER_CHANGED_WORDS });
    expect(await step(world, record, record)).toMatchObject({ allowed: true });
    const lonely = createPeopleWorld();
    seedProject(lonely);
    grant(lonely, lonely.people.member, "developer");
    expect(await step(lonely, taskOf(lonely, lonely.people.member), null)).toEqual({ allowed: false, message: STEP_OWNER_CHANGED_WORDS });
  });

  it("M-4: the fence is built from rows read BEFORE the checks decide: a People change that lands during the checks still trips the commit", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "developer");
    world.db.set({ pk: `DEVTASK#${TASK}`, sk: "PEOPLE", revision: 3 });
    world.db.set(taskOf(world, world.people.member));
    // A take-over lands the moment the checks first look at the project's own rows (after the fence's rows were read).
    const real = world.routes.documentClient;
    let landed = false;
    const documentClient = { ...real, send: async (command: { input?: { Key?: { pk?: string; sk?: string } } }) => {
      if (!landed && command.input?.Key?.pk?.includes("#PROJECT#") === true && command.input.Key.sk === "META") { landed = true; world.db.set({ pk: `DEVTASK#${TASK}`, sk: "PEOPLE", revision: 4 }); }
      return await (real).send(command);
    } };
    const verdict = await cloudTaskAccess(() => ({ ...world.routes, documentClient })).checkStep(taskOf(world, world.people.member));
    expect(verdict).toMatchObject({ allowed: true });
    expect(landed, "the take-over landed during the checks").toBe(true);
    const people = (verdict as unknown as { items: Array<{ key: { pk: string; sk: string }; condition: unknown }> }).items.at(-1)!;
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", revision: 4 } });
    // The fence holds the revision read first (3): the store now holds 4, so the step does not commit.
    expect((await store.transact([{ kind: "check", key: people.key, condition: people.condition as never }])).applied).toBe(false);
  });

  it("after a take-over the step is judged on the taker, not the creator", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    grant(world, world.people.member, "developer");
    const taken = { currentOwner: { developerId: world.people.revoked.developerId, name: "Gone", provider: "oidc", since: "2026-11-13T09:00:00.000Z" } };
    expect(await step(world, taskOf(world, world.people.member, taken))).toMatchObject({ allowed: false });
    expect(await step(world, taskOf(world, world.people.member))).toMatchObject({ allowed: true });
  });

  it("a task naming no company, or whose owner cannot be read, gets no step", async () => {
    const world = createPeopleWorld();
    seedProject(world);
    expect(await step(world, { ...taskOf(world, world.people.owner), orgId: undefined })).toMatchObject({ allowed: false });
    expect(await step(world, { ...taskOf(world, world.people.owner), developerId: undefined, ownerKey: undefined })).toMatchObject({ allowed: false });
  });
});
