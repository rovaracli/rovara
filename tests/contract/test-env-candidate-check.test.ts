// TE-2: tasks read the project's APPLIED settings, so a proposal's commands must not reach the settings before they are proved and approved. The proposal gets its own candidate check (a fresh broker workspace
// prepared from the proposal's commands, never from the applied settings); its result is stored for (project, digest, settings revision); the Prove reads it; and only an approval that re-verifies it writes the
// commands into the settings. These tests go through the whole broker (routes, stores, the real preparation) with the worker's report played by the test.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { projectMetaKey, projectPk, testEnvDigest, type TestEnvDraft, type TestEnvironmentBody } from "../../packages/contracts/src/index.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { approveTestEnvironment, proposeTestEnvironment, readProposalSources } from "../../packages/broker/src/org/test-environment.js";
import { ENV, NAME, command, draftBody, draftOf, errorOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; });

/** Two new setup/test commands on top of what the project already has (old-setup and old-test), all in the project's one directory. */
const proposalBody = (): TestEnvironmentBody => draftBody({
  repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900), command("make", ["deps"], 900)], checks: [
    { id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" },
    { id: "smoke", label: "Smoke", command: command("make", ["smoke"], 600), kind: "smoke" },
  ] }],
});
const argsOf = (commands: ReadonlyArray<{ args: string[] }>) => commands.map((entry) => entry.args[0]);

interface Stored { definition: { revision: number; setup: Array<{ args: string[] }>; readiness: Array<{ args: string[] }> } }
const revisions = (t: Bench) => t.db.find((item) => item.entityType === "PROJECT") as unknown as Stored[];
const settingsOf = (t: Bench) => revisions(t).sort((a, b) => a.definition.revision - b.definition.revision).at(-1)!.definition;
const candidates = (t: Bench) => t.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Array<{ origin?: string; workspaceId: string; revision: number; digest: string; setup: Array<{ args: string[]; timeoutSeconds: number; env?: unknown }>; readiness: Array<{ args: string[]; timeoutSeconds: number; env?: unknown }> }>;
const metaCheck = (t: Bench) => (t.db.get(projectMetaKey(TEST_ORG, NAME)) as { setupCheck?: unknown }).setupCheck;
const prepareOf = (t: Bench, workspaceId: string) => String((t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);

async function proposed(t: Bench, draft: TestEnvDraft = draftOf(proposalBody())): Promise<string> {
  await t.drafted(draft);
  const reply = await t.dev(OMAR, "POST", `${ENV}/propose`, {});
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return testEnvDigest(draft.environment);
}
const startCheck = (t: Bench, digest: string, who = OMAR) => t.dev(who, "POST", `${ENV}/check`, { digest, requestId: randomUUID() });
/** Plays the worker's report on the candidate check of `digest` (the newest one). */
async function reportCheck(t: Bench, status: "SUCCEEDED" | "FAILED", error?: string): Promise<string> {
  const record = candidates(t).at(-1)!;
  await t.finish(record.workspaceId, prepareOf(t, record.workspaceId), status, error === undefined ? {} : { error });
  return record.workspaceId;
}
const provedState = async (t: Bench) => (await t.state()).proposal!;

describe("the candidate check", () => {
  it("prepares a fresh workspace from the PROPOSAL's commands (not the applied settings), and leaves the settings and the project's own setup check alone", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      const started = await startCheck(t, digest);
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      // The settings are untouched: still revision 1 with the old commands only.
      expect(revisions(t)).toHaveLength(1);
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup"]);
      expect(argsOf(settingsOf(t).readiness)).toEqual(["old-test"]);
      expect(metaCheck(t)).toBeUndefined();
      // The workspace is sent the proposal's commands, in front of the worker.
      const [record] = candidates(t);
      expect(record).toMatchObject({ revision: 1, digest });
      const outbox = t.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === record!.workspaceId)[0] as unknown as { invocation: { payload: { project: { setup: Array<{ args: string[] }>; readiness: Array<{ args: string[] }> } } } };
      expect(argsOf(outbox.invocation.payload.project.setup)).toEqual(["old-setup", "deps"]);
      expect(argsOf(outbox.invocation.payload.project.readiness)).toEqual(["old-test", "smoke"]);
      expect((await provedState(t)).check).toMatchObject({ status: "checking" });
    });
  });

  it("is a maintainer's to start; a contributor and a viewer are refused, and the route does not exist with the switch off", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await t.person(MAYA, "member", "contributor");
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      expect((await startCheck(t, digest, MAYA)).status).toBe(403);
      await t.person(MAYA, "member", "viewer");
      expect((await startCheck(t, digest, MAYA)).status).toBe(403);
      expect((await startCheck(t, "d".repeat(64))).status).toBe(409);
      expect(candidates(t)).toEqual([]);
    });
    await withSwitch(undefined, async () => { expect((await startCheck(t, "d".repeat(64))).status).toBe(404); });
    expect(candidates(t)).toEqual([]);
  });

  it("a repeated request id starts nothing more, and a second press while it runs is busy", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      const requestId = randomUUID();
      expect((await t.dev(OMAR, "POST", `${ENV}/check`, { digest, requestId })).status).toBe(202);
      expect((await t.dev(OMAR, "POST", `${ENV}/check`, { digest, requestId })).status).toBe(200);
      expect(candidates(t)).toHaveLength(1);
      expect((await startCheck(t, digest)).status).toBe(409);
      expect(candidates(t)).toHaveLength(1);
    });
  });
});

describe("Prove reads the candidate result", () => {
  it("is refused with no check, while it runs, and after it failed; a failed check leaves the settings exactly as they were", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      const none = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(none.status).toBe(400);
      expect(errorOf(none).message).toContain("check");
      await startCheck(t, digest);
      const running = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(running.status).toBe(400);
      expect(errorOf(running).message).toContain("still running");
      await reportCheck(t, "FAILED", "setup step 1 (make deps in repo/web) exited 2\nLast lines:\nno rule to make target");
      const failed = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(failed.status).toBe(400);
      expect((await provedState(t)).check).toMatchObject({ status: "failed" });
      expect((await provedState(t)).check.failedStep).toMatch(/^setup: make deps/);
      expect((await provedState(t)).proved).toBe(false);
      // A failed Prove rolls nothing back because nothing was written: settings and the approved environment are as they were.
      expect(revisions(t)).toHaveLength(1);
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup"]);
      expect(argsOf(settingsOf(t).readiness)).toEqual(["old-test"]);
      expect((await t.state()).approved).toBeUndefined();
      const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approved.status).toBe(400);
      expect(revisions(t)).toHaveLength(1);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toEqual([]);
    });
  });

  it("is proved by a passing check of THIS digest only: another proposal's check proves nothing for it", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const first = await proposed(t);
      await startCheck(t, first);
      await reportCheck(t, "SUCCEEDED");
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest: first })).status).toBe(200);
      // A different proposal (one more smoke command) has no check of its own.
      const other = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }, { id: "smoke", label: "Smoke", command: command("make", ["smoke-two"], 600), kind: "smoke" }] }] });
      await t.drafted(draftOf(other));
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      const otherDigest = testEnvDigest(other);
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest: otherDigest })).status).toBe(400);
    });
  });

  it("a check on older settings proves nothing: the check is keyed by the settings revision it ran against", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      await startCheck(t, digest);
      await reportCheck(t, "SUCCEEDED");
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      // Someone saves the project's settings: revision 2. The check ran against revision 1.
      const saved = await t.dev(OMAR, "PUT", `/v1/app/projects/${NAME}/settings`, { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make old-setup", "make other"] });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const stale = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(stale.status).toBe(400);
      const approve = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approve.status).toBe(400);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toEqual([]);
    });
  });
});

describe("applying the commands", () => {
  it("is refused before approval, for every kind of proposal, and writes nothing", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const apply = (digest: string) => t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 1 });
      // Rovara's own proposal, from the detectors.
      const digest = await proposed(t);
      const detector = await apply(digest);
      expect(detector.status).toBe(400);
      expect(errorOf(detector).message).toContain("approved");
      // Even one that was proved by a passing check.
      await startCheck(t, digest);
      await reportCheck(t, "SUCCEEDED");
      await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect((await apply(digest)).status).toBe(400);
      // A maintainer's own edit.
      const edited = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900), command("make", ["edited-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }] });
      expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: edited })).status).toBe(200);
      expect((await apply(testEnvDigest(edited))).status).toBe(400);
      // A proposal the setup agent made by running commands.
      const run = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900), command("make", ["observed-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }] });
      await t.drafted({ ...draftOf(run), valueSources: [{ field: "repos[0].setupCommands[1]", source: "observed:abcdefgh#1" }] });
      await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      expect((await apply(testEnvDigest(run))).status).toBe(400);
      expect(revisions(t)).toHaveLength(1);
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup"]);
      expect(metaCheck(t)).toBeUndefined();
    });
  });
});

describe("approving writes exactly the proven commands", () => {
  it("the approval re-verifies the check, writes what the check ran into the settings as the next revision, and the settings then hold them", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      await startCheck(t, digest);
      await reportCheck(t, "SUCCEEDED");
      const [record] = candidates(t);
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      expect(revisions(t)).toHaveLength(1);
      const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ revision: 1, digest, replayed: false });
      // The settings are revision 2 and hold exactly the commands the check ran.
      expect(revisions(t)).toHaveLength(2);
      expect(argsOf(settingsOf(t).setup)).toEqual(argsOf(record!.setup));
      expect(argsOf(settingsOf(t).readiness)).toEqual(argsOf(record!.readiness));
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup", "deps"]);
      expect(argsOf(settingsOf(t).readiness)).toEqual(["old-test", "smoke"]);
      // Nothing was written by the approval of another digest, and a replay changes nothing.
      const replay = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0, requestId: (t.db.find((item) => item.entityType === "TEST_ENV_REVISION")[0] as { requestId: string }).requestId });
      expect(replay.body).toMatchObject({ revision: 1, replayed: true });
      expect(revisions(t)).toHaveLength(2);
    });
  });

  it("re-verifies at the press: a check that failed again after the Prove stopped the approval, and nothing is written", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      await startCheck(t, digest);
      await reportCheck(t, "SUCCEEDED");
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      expect((await provedState(t)).proved).toBe(true);
      // The check is run again, and this time it fails: the stored Prove is old news.
      expect((await startCheck(t, digest)).status).toBe(202);
      await reportCheck(t, "FAILED", "readiness check 1 (make smoke in repo/web) exited 1");
      const approve = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approve.status).toBe(400);
      expect(revisions(t)).toHaveLength(1);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toEqual([]);
    });
  });

  it("a proposal whose commands the settings already hold needs a check too, and the approval writes nothing more", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await t.approveFirst();
      expect(revisions(t)).toHaveLength(1);
      expect(digest).toHaveLength(64);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")).toHaveLength(1);
      // approveFirst proved it by a candidate check, as everything is now.
      expect(candidates(t).length).toBeGreaterThan(0);
    });
  });

  it("a setup-run proposal (the setup agent ran commands) needs the approver's fresh sign-in in a browser; a token and a stale sign-in are refused, and nothing is written", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const run = proposalBody();
      const digest = await proposed(t, { ...draftOf(run), valueSources: [{ field: "repos[0].setupCommands[1]", source: "observed:abcdefgh#1" }] });
      await startCheck(t, digest);
      await reportCheck(t, "SUCCEEDED");
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      const viaToken = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(viaToken.status).toBe(403);
      expect(errorOf(viaToken).message).toContain("in a browser");
      t.ageSignIn(OMAR, 11);
      const stale = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(errorOf(stale).code).toBe("REAUTH_REQUIRED");
      expect(revisions(t)).toHaveLength(1);
      t.ageSignIn(OMAR, 1);
      const fresh = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup", "deps"]);
    });
  });
});

describe("S1: what is written is what was run", () => {
  it("the check runs the commands in the form the settings save stores (no env, the list's own timeout), and the written settings are deeply the check's lists", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      // A command the settings already hold with an env and its own timeout: the save would drop the env and reset the timeout.
      const stored = t.db.find((item) => item.entityType === "PROJECT")[0] as { definition: { readiness: Array<Record<string, unknown>> } } & Record<string, unknown>;
      t.db.set({ ...stored, definition: { ...stored.definition, readiness: [{ ...stored.definition.readiness[0]!, env: { FOO: "1" }, timeoutSeconds: 77 }] } });
      const digest = await proposed(t);
      await startCheck(t, digest);
      const [record] = candidates(t);
      for (const entry of [...record!.setup, ...record!.readiness]) expect(entry.env).toBeUndefined();
      expect(record!.setup.every((entry) => entry.timeoutSeconds === 900)).toBe(true);
      expect(record!.readiness.every((entry) => entry.timeoutSeconds === 1800)).toBe(true);
      await reportCheck(t, "SUCCEEDED");
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 })).status).toBe(200);
      const written = settingsOf(t) as unknown as { setup: unknown[]; readiness: unknown[] };
      expect(written.setup).toEqual(record!.setup);
      expect(written.readiness).toEqual(record!.readiness);
    });
  });
});

describe("S1: a list the proposal adds nothing to is left as stored", () => {
  it("the check runs the stored setup list as it is (env and timeout kept), and the written settings are exactly what the check ran", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const stored = t.db.find((item) => item.entityType === "PROJECT")[0] as { definition: { setup: Array<Record<string, unknown>> } } & Record<string, unknown>;
      t.db.set({ ...stored, definition: { ...stored.definition, setup: [{ ...stored.definition.setup[0]!, env: { FOO: "1" }, timeoutSeconds: 77 }] } });
      // The proposal adds only a smoke check: the setup list is not rewritten by the save.
      const body = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [
        { id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }, { id: "smoke", label: "Smoke", command: command("make", ["smoke"], 600), kind: "smoke" }] }] });
      const digest = await proposed(t, draftOf(body));
      await startCheck(t, digest);
      const [record] = candidates(t);
      expect(record!.setup).toEqual([{ cwd: "repo/web", executable: "make", args: ["old-setup"], timeoutSeconds: 77, env: { FOO: "1" } }]);
      await reportCheck(t, "SUCCEEDED");
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 })).status).toBe(200);
      const written = settingsOf(t) as unknown as { setup: unknown[]; readiness: unknown[] };
      expect(written.setup).toEqual(record!.setup);
      expect(written.readiness).toEqual(record!.readiness);
    });
  });
});

describe("S2: an approval whose write did not land can be finished", () => {
  it("shows the approved environment's missing commands with the check state, runs the check for that digest and revision, then writes them", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await proposed(t);
      await startCheck(t, digest);
      await reportCheck(t, "SUCCEEDED");
      await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 })).status).toBe(200);
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup", "deps"]);
      // The write did not land (here: the settings were put back afterwards, revision 3).
      const put = await t.dev(OMAR, "PUT", `/v1/app/projects/${NAME}/settings`, { requestId: randomUUID(), expectedRevision: 2, setupCommands: ["make old-setup"], testCommands: ["make old-test"] });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const stuck = await t.state();
      expect(stuck.approved).toMatchObject({ digest, commandsNotInSettings: 2, check: { status: "unchecked" } });
      // Writing needs a check at THIS revision.
      const early = await t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 3 });
      expect(early.status).toBe(400);
      expect((await startCheck(t, digest)).status).toBe(202);
      expect((await t.state()).approved).toMatchObject({ check: { status: "checking" } });
      await reportCheck(t, "SUCCEEDED");
      expect((await t.state()).approved).toMatchObject({ check: { status: "ready" } });
      const written = await t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 3 });
      expect(written.status, JSON.stringify(written.body)).toBe(200);
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup", "deps"]);
      expect(argsOf(settingsOf(t).readiness)).toEqual(["old-test", "smoke"]);
      expect((await t.state()).approved).toMatchObject({ commandsNotInSettings: 0 });
    });
  });
});

describe("B1 residual: the setup-run mark survives the proposal item", () => {
  it("a check started from a marked proposal carries the mark, so approving after the proposal expired and was re-proposed from the draft still needs the fresh sign-in", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const store = { documentClient: t.db, tableName: "state", now: () => Date.now() };
      const body = proposalBody();
      await proposeTestEnvironment(store, { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body, origin: "setup_run", valueSources: [{ field: "repos[0].setupCommands[1]", source: { path: "package.json", line: 3 } }] });
      const digest = testEnvDigest(body);
      expect((await startCheck(t, digest)).status).toBe(202);
      expect(candidates(t)[0]).toMatchObject({ origin: "setup_run" });
      await reportCheck(t, "SUCCEEDED");
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      // The proposal item expires; the same body is proposed again from the draft path, with no mark.
      t.db.delete({ pk: projectPk(TEST_ORG, NAME), sk: `TESTENV#PROPOSAL#${digest}` });
      await proposeTestEnvironment(store, { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body });
      expect((await readProposalSources(store, TEST_ORG, NAME, digest)).origin).toBeUndefined();
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      const viaToken = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(viaToken.status, JSON.stringify(viaToken.body)).toBe(403);
      expect(errorOf(viaToken).message).toContain("in a browser");
      expect(revisions(t)).toHaveLength(1);
      t.ageSignIn(OMAR, 1);
      expect((await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 })).status).toBe(200);
    });
  });
});

describe("B1: the approval's own sign-in guard", () => {
  it("approveTestEnvironment itself asks for a fresh sign-in for a proposal marked as a setup run's, whoever calls it", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const store = { documentClient: t.db, tableName: "state", now: () => Date.now() };
      const body = proposalBody();
      await proposeTestEnvironment(store, { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body, origin: "setup_run", valueSources: [{ field: "repos[0].setupCommands[1]", source: { path: "package.json", line: 3 } }] });
      const digest = testEnvDigest(body);
      t.candidatePassed(digest);
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      const input = { orgId: TEST_ORG, project: NAME, digest, expectedRevision: 0, requestId: "request-12345", approvedBy: OMAR.developerId, role: "maintainer" as const };
      await expect(approveTestEnvironment(store, input)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
      await expect(approveTestEnvironment(store, { ...input, approvedBySignedInAtMs: Date.now() - 11 * 60_000 })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
      await expect(approveTestEnvironment(store, { ...input, approvedBySignedInAtMs: Date.now() - 60_000 })).resolves.toMatchObject({ revision: 1 });
    });
  });

  it("proposing the same body again without the mark does not take the mark away", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    const store = { documentClient: t.db, tableName: "state", now: () => Date.now() };
    const body = proposalBody();
    await proposeTestEnvironment(store, { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body, origin: "setup_run" });
    await proposeTestEnvironment(store, { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body });
    expect((await readProposalSources(store, TEST_ORG, NAME, testEnvDigest(body))).origin).toBe("setup_run");
  });
});
