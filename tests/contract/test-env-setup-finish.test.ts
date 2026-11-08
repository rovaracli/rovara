// TS-UX-1 finish (setup pattern: detect -> one screen -> one "Check it works" -> one inline Approve). Through the whole broker: the approval's own settings write does not stale the look (item 5); one check press
// proposes, checks and proves (item 2); the project's own setup check runs with the approved test services (item 3); the second person's confirmation is a card on the same screen (item 1).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { projectPk, testEnvDigest, type TestEnvironmentBody } from "../../packages/contracts/src/index.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { lookIsStale, ownWriteOf, recordOwnSettingsWrite, readOwnSettingsWrite } from "../../packages/broker/src/test-env/own-settings-write.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { ENV, NAME, command, draftBody, draftOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; delete process.env.TEST_SERVICES_ENABLED; });

describe("item 5: the approval's own settings write does not stale its own look", () => {
  it("after an approval that wrote its commands, the look is still current; a person's own settings save makes it stale again", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      // A draft with commands the settings do not hold yet, so the approval writes them.
      await t.approveFirst(draftOf(draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900), command("make", ["deps"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }, { id: "smoke", label: "Smoke", command: command("make", ["smoke"], 600), kind: "smoke" }] }] })));
      // The approval wrote its commands (revision 1 -> 2): the look was based on revision 1, and it is still the current one.
      const own = t.db.find((item) => item.entityType === "TEST_ENV_OWN_SETTINGS_WRITE")[0];
      expect(own).toMatchObject({ from: 1, to: 2 });
      const after = await t.state();
      expect(after.approved?.revision).toBe(1);
      expect(after.draft.status).toBe("ready");
      // What is already approved is not offered again as a proposal.
      expect(after.proposal).toBeUndefined();
      // UX-4b review I1 (owner decision 11): with the test environment on, a browser save that changes the commands is refused (they are proved there first); it changes nothing, so the look stays current.
      const changed = await t.web(OMAR, "PUT", `/v1/app/projects/${NAME}/settings`, { requestId: crypto.randomUUID(), expectedRevision: 2, setupCommands: ["make old-setup", "make deps", "make other"] });
      expect(changed.status, JSON.stringify(changed.body)).toBe(400);
      expect((await t.state()).draft.status).toBe("ready");
      // A person's own save of something else (here the dev container) moves the settings on: the look is stale again (positive control for the same read).
      const saved = await t.web(OMAR, "PUT", `/v1/app/projects/${NAME}/settings`, { requestId: crypto.randomUUID(), expectedRevision: 2, devcontainer: { repository: "web", configPath: ".devcontainer/ci.json" } });
      expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
      expect((await t.state()).draft.status).toBe("stale");
    });
  });
  it("the rule: only the test environment's own writes, in a row, from the look's revision on", async () => {
    expect(lookIsStale(3, 3, undefined)).toBe(false);
    expect(lookIsStale(2, 3, undefined)).toBe(true);
    expect(lookIsStale(2, 3, { from: 2, to: 3 })).toBe(false);
    expect(lookIsStale(1, 3, { from: 2, to: 3 })).toBe(true);
    expect(lookIsStale(2, 4, { from: 2, to: 3 })).toBe(true);
    // Review M3: a person's save straight after the apply (the revision read back is two on) is not recorded as the test environment's own.
    expect(ownWriteOf(2, 3)).toEqual({ from: 2, to: 3 });
    expect(ownWriteOf(2, 4)).toBeUndefined();
    expect(ownWriteOf(2, 2)).toBeUndefined();
    const db = new FakeDynamoDb();
    await recordOwnSettingsWrite(db, "t", TEST_ORG, NAME, { from: 2, to: 3 });
    await recordOwnSettingsWrite(db, "t", TEST_ORG, NAME, { from: 3, to: 4 });
    expect(await readOwnSettingsWrite(db, "t", TEST_ORG, NAME)).toEqual({ from: 2, to: 4 });
    await recordOwnSettingsWrite(db, "t", TEST_ORG, NAME, { from: 6, to: 7 });
    expect(await readOwnSettingsWrite(db, "t", TEST_ORG, NAME)).toEqual({ from: 6, to: 7 });
    db.set({ pk: projectPk(TEST_ORG, NAME), sk: "TESTENV#OWN_SETTINGS_WRITE", orgId: TEST_ORG, project: NAME, from: "2", to: 9 });
    expect(await readOwnSettingsWrite(db, "t", TEST_ORG, NAME)).toBeUndefined();
    void MAYA; void ENV;
  });
});

const postgres = {
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "src/db.ts", line: 1 }], usedBy: ["unit"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
};
const withPostgres = (): TestEnvironmentBody => draftBody({ dependencies: [postgres], repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }] });
/** An approved revision 1, as `approveTestEnvironment` stores it. */
function approvedAs(t: Bench, environment: TestEnvironmentBody): void {
  const digest = testEnvDigest(environment);
  t.db.set({ pk: projectPk(TEST_ORG, NAME), sk: "TESTENV#LATEST", entityType: "TEST_ENV_LATEST", orgId: TEST_ORG, project: NAME, revision: 1, digest });
  t.db.set({ pk: projectPk(TEST_ORG, NAME), sk: "TESTENV#REV#00000001", entityType: "TEST_ENV_REVISION", orgId: TEST_ORG, project: NAME, revision: 1, approvedAt: new Date().toISOString(), approvedBy: OMAR.developerId, digest, requestId: "r".repeat(16), lessSafe: [], environment });
}
const projectCheckPayload = (t: Bench) => (t.db.find((item) => item.entityType === "OUTBOX") as unknown as Array<{ invocation: { payload: Record<string, unknown> } }>).map((item) => item.invocation.payload);
const benchWithCatalog = () => setupWizardBench({ autoCandidate: false, brokerExtra: { serviceCatalog: async () => verifiedCatalog(pinnedCatalog()) } });
const startProjectCheck = async (t: Bench) => {
  const started = await t.web(OMAR, "POST", `/v1/app/projects/${NAME}/setup-check`, { requestId: randomUUID() });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  return projectCheckPayload(t).at(-1)!;
};

describe("item 3: the project's own setup check runs with the approved test services", () => {
  it("sends the approved environment's pinned plan with the project's own check", async () => {
    const t = await benchWithCatalog();
    process.env.TEST_SERVICES_ENABLED = "1";
    await withSwitch("1", async () => {
      approvedAs(t, withPostgres());
      const sent = (await startProjectCheck(t))["testServices"] as { dependencies: Array<{ id: string; catalogId: string }> };
      expect(sent.dependencies.map((entry) => [entry.id, entry.catalogId])).toEqual([["postgres", "postgres@16"]]);
    });
  });
  it("sends none with no approved environment, with one that has no dependencies, or with test services off (the check still starts, as before)", async () => {
    process.env.TEST_SERVICES_ENABLED = "1";
    await withSwitch("1", async () => {
      expect(await startProjectCheck(await benchWithCatalog())).not.toHaveProperty("testServices");
      const plain = await benchWithCatalog();
      approvedAs(plain, draftBody());
      expect(await startProjectCheck(plain)).not.toHaveProperty("testServices");
    });
    delete process.env.TEST_SERVICES_ENABLED;
    await withSwitch("1", async () => {
      const off = await benchWithCatalog();
      approvedAs(off, withPostgres());
      expect(await startProjectCheck(off)).not.toHaveProperty("testServices");
    });
  });
});

describe("item 2: one 'Check it works' press: propose, check, and the Prove read from the check", () => {
  it("a check with no digest proposes what the look found and checks it; a passed check shows as proved with no Prove press, and Approve keeps the report", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      await t.drafted();
      expect((await t.state()).proposal).toBeUndefined();
      const pressed = await t.web(OMAR, "POST", `${ENV}/check`, { requestId: randomUUID() });
      expect(pressed.status, JSON.stringify(pressed.body)).toBe(202);
      const digest = testEnvDigest(draftBody());
      const shown = await t.state();
      expect(shown.proposal?.digest).toBe(digest);
      expect(shown.proposal?.check.status).toBe("checking");
      expect(shown.proposal?.proved).toBe(false);
      // The check passes: the proposal reads as proved, and nothing was kept by the read.
      t.candidatePassed(digest);
      const passed = await t.state();
      expect(passed.proposal?.proved).toBe(true);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROVE")).toEqual([]);
      // Approve with no Prove press: the derived report is kept, and the environment is approved.
      const approved = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROVE")).toHaveLength(1);
      expect((await t.state()).approved?.revision).toBe(1);
    });
  });
  it("a second press with a proposal shown checks that proposal (no second proposal), and with no look it is refused as before", async () => {
    const empty = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const refused = await empty.web(OMAR, "POST", `${ENV}/check`, { requestId: randomUUID() });
      expect(refused.status).toBe(409);
    });
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      await t.drafted();
      expect((await t.web(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      const before = t.db.find((item) => String(item.sk).startsWith("TESTENV#PROPOSAL#")).length;
      expect((await t.web(OMAR, "POST", `${ENV}/check`, { requestId: randomUUID() })).status).toBe(202);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#PROPOSAL#")).length).toBe(before);
    });
  });
  it("a check that has not passed proves nothing", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      await t.drafted();
      expect((await t.web(OMAR, "POST", `${ENV}/check`, { requestId: randomUUID() })).status).toBe(202);
      const approved = await t.web(OMAR, "POST", `${ENV}/approve`, { digest: testEnvDigest(draftBody()), expectedRevision: 0 });
      expect(approved.status).toBe(400);
      expect((await t.state()).proposal?.proved).toBe(false);
    });
  });
});

describe("item 1: the second person's confirmation is a card on the same screen", () => {
  const NIGHTLY = { nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" } };
  async function lessSafeProposal(t: Bench): Promise<string> {
    await t.approveFirst();
    expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: draftBody(NIGHTLY) })).status).toBe(200);
    const digest = testEnvDigest(draftBody(NIGHTLY));
    expect((await t.web(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
    return digest;
  }
  const approvalOf = async (t: Bench, who = OMAR) => (await t.web(who, "GET", ENV)).body as { proposal?: { approval: { status: string; askedByYou?: boolean; youConfirm?: boolean; approvalId?: string; waitingFor?: string } } };

  it("the asker sees who it waits for; the second person sees the card itself; anyone else learns only that it waits", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "admin");
    const viewer = { developerId: "f".repeat(64), name: "Vic Viewer", provider: "oidc", sessionId: "s-vic" } as typeof MAYA;
    await t.person(viewer, "member", "viewer");
    t.db.set({ pk: `SESSION#${viewer.sessionId}`, sk: "META", sessionId: viewer.sessionId, developerId: viewer.developerId, amr: viewer.provider, startedAt: new Date().toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600 });
    t.db.set({ pk: `DEVELOPER#${viewer.developerId}`, sk: "META", developerId: viewer.developerId, provider: viewer.provider, displayName: viewer.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(t);
      expect((await approvalOf(t)).proposal?.approval).toEqual({ status: "none", askedByYou: false, youConfirm: false });
      expect((await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 })).status).toBe(200);
      const card = t.approvals()[0]!;
      expect(await approvalOf(t).then((state) => state.proposal?.approval)).toEqual({ status: "pending", askedByYou: true, youConfirm: false, approvalId: card.approvalId, waitingFor: "second_person" });
      expect(await approvalOf(t, MAYA).then((state) => state.proposal?.approval)).toEqual({ status: "pending", askedByYou: false, youConfirm: true, approvalId: card.approvalId });
      const seen = (await t.dev(viewer, "GET", ENV)).body as Awaited<ReturnType<typeof approvalOf>>;
      expect(seen.proposal?.approval).toEqual({ status: "pending", askedByYou: false, youConfirm: false });
      // Her decide sign-in comes back to this screen (decision cards on), and only for a person who may decide it; with the cards off it is the confirmation page's, as before.
      const kind = approvalDecideKind({ documentClient: t.db, tableName: (t.brokerInput as { tableName: string }).tableName, now: Date.now, modelSignInTableName: "signin", signInStore: { getDeveloper: async () => undefined } } as never);
      process.env.DECISION_CARDS_ENABLED = "1";
      try {
        expect(await kind.returnPath!({ orgId: TEST_ORG, developerId: MAYA.developerId, approvalId: card.approvalId })).toBe(`/app/onboard?project=${NAME}&step=setup`);
        expect(await kind.returnPath!({ orgId: TEST_ORG, developerId: viewer.developerId, approvalId: card.approvalId })).toBeUndefined();
      } finally { delete process.env.DECISION_CARDS_ENABLED; }
      expect(await kind.returnPath!({ orgId: TEST_ORG, developerId: MAYA.developerId, approvalId: card.approvalId })).toBeUndefined();
      // Maya confirms on the card; the asker then finishes the approval on the same screen.
      t.confirmCard(card.approvalId, MAYA);
      expect(await approvalOf(t).then((state) => state.proposal?.approval.status)).toBe("approved");
      const approved = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    });
  });

  it("the company's only owner is told it waits for them, and sees the card to confirm it themselves", async () => {
    const solo = await setupWizardBench();
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(solo);
      expect((await solo.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 })).status).toBe(200);
      const approval = (await approvalOf(solo)).proposal?.approval;
      expect(approval).toMatchObject({ status: "pending", askedByYou: true, youConfirm: true, waitingFor: "you_sole_owner" });
      expect(approval?.approvalId).toBe(solo.approvals()[0]!.approvalId);
    });
  });
});

describe("review I3 (SEED-FILE-LOCK): a seed file's content is bound to the approval", () => {
  const withFileSeed = (): TestEnvironmentBody => draftBody({ dependencies: [{ ...postgres, seeds: [{ fixturePath: "repo/web/db/seeds/users.sql" }] }], repos: withPostgres().repos });
  const SHA = "5".repeat(64);
  async function proposedAndChecked(t: Bench, usage: Record<string, unknown> | undefined): Promise<string> {
    const { proposeTestEnvironment } = await import("../../packages/broker/src/org/test-environment.js");
    const { candidateCheckKey } = await import("../../packages/broker/src/org/test-env-candidate.js");
    const proposed = await proposeTestEnvironment({ documentClient: t.db, tableName: "state", now: () => Date.now() }, { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body: withFileSeed() });
    t.candidatePassed(proposed.digest);
    if (usage !== undefined) {
      const key = candidateCheckKey(TEST_ORG, NAME, proposed.digest, 1);
      t.db.set({ ...(t.db.get(key) as Record<string, unknown>), usage });
    }
    return proposed.digest;
  }
  const usageWith = (seedFiles: unknown[]) => ({ schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 800, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 }, seedFiles });

  it("the approval keeps the sha256 the check loaded, and a plan of the approved environment carries it", async () => {
    const t = await benchWithCatalog();
    process.env.TEST_SERVICES_ENABLED = "1";
    await withSwitch("1", async () => {
      const digest = await proposedAndChecked(t, usageWith([{ id: "postgres", path: "repo/web/db/seeds/users.sql", sha256: SHA }]));
      const approved = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const { readApprovedSeedFiles } = await import("../../packages/broker/src/org/test-environment.js");
      expect(await readApprovedSeedFiles({ documentClient: t.db, tableName: "state", now: () => Date.now() }, TEST_ORG, NAME, 1)).toEqual([{ id: "postgres", path: "repo/web/db/seeds/users.sql", sha256: SHA }]);
      // The project's own check (an approved environment) sends the bound content.
      const sent = (await startProjectCheck(t))["testServices"] as { dependencies: Array<{ seeds: unknown[] }> };
      expect(sent.dependencies[0]!.seeds).toEqual([{ fixturePath: "repo/web/db/seeds/users.sql", sha256: SHA }]);
    });
  });
  it("is refused when the check did not load the file (nothing to bind), and an approved environment with an unbound file seed plans nothing", async () => {
    const t = await benchWithCatalog();
    process.env.TEST_SERVICES_ENABLED = "1";
    await withSwitch("1", async () => {
      // A check that started Postgres but reports no seed file loaded (an older worker, or the load did not happen).
      const { seedFiles: _none, ...noFiles } = usageWith([]);
      void _none;
      const digest = await proposedAndChecked(t, noFiles);
      const refused = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(refused.status).toBe(400);
      expect((refused.body.error as { message: string }).message).toContain("did not load this test environment's test data file");
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")).toEqual([]);
    });
    const { taskDependencyPlansOf } = await import("../../packages/broker/src/test-env/dependency-plan.js");
    const catalog = verifiedCatalog(pinnedCatalog());
    expect(taskDependencyPlansOf({ body: withFileSeed(), catalog, edition: "public", projectId: NAME, approvedSeedFiles: [] })).toEqual({ ok: false, reason: "seed_file_unbound" });
    const candidate = taskDependencyPlansOf({ body: withFileSeed(), catalog, edition: "public", projectId: NAME });
    expect(candidate.ok && candidate.dependencies[0]!.seeds).toEqual([{ fixturePath: "repo/web/db/seeds/users.sql" }]);
  });
});
