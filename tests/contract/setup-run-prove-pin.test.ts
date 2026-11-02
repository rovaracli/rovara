// SU-1 addendum 3: the candidate check and the Prove of a SETUP RUN's proposal are pinned to the commits the run used (its preparedBase). With no recorded commit the broker resolves a pin (setup-pins.ts). The worker
// refuses a checkout that is not at the pin (worker-clone-retry.test.ts); a proposal is proved only by a check made at those commits; main having moved asks for a re-run, never a silent mix.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { testEnvDigest, type TestEnvironmentBody } from "../../packages/contracts/src/index.js";
import { OMAR } from "../support/developer-task-broker.js";
import { proposeTestEnvironment } from "../../packages/broker/src/org/test-environment.js";
import { writeSetupRunProposal } from "../../packages/broker/src/rovara-code/setup-run-proposal.js";
import { checkedAtRunCommits } from "../../packages/broker/src/test-env/setup-run-pin.js";
import { ENV, NAME, command, draftBody, errorOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; });

const RUN_TASK = "11111111-1111-4111-8111-111111111111";
const HEAD = "c".repeat(40); // what the bench's code host answers as the default-branch head
const OLDER = "e".repeat(40);

const body = (): TestEnvironmentBody => draftBody({
  repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900), command("make", ["deps"], 900)], checks: [
    { id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" },
    { id: "smoke", label: "Smoke", command: command("make", ["smoke"], 600), kind: "smoke" },
  ] }],
});
const store = (t: Bench) => ({ documentClient: t.db, tableName: "state", now: () => Date.now() });
const candidates = (t: Bench) => t.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Array<{ workspaceId: string; pins?: Array<{ repository: string; commit: string }>; origin?: string }>;
const prepareOf = (t: Bench, workspaceId: string) => String((t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);

/** A setup run that read the repository at `base` (undefined: it kept no commit), and the proposal it made. */
async function fromRun(t: Bench, base: string | undefined): Promise<string> {
  const proposal = body();
  const digest = testEnvDigest(proposal);
  t.db.set({
    pk: `DEVTASK#${RUN_TASK}`, sk: "META", taskId: RUN_TASK, orgId: TEST_ORG, project: NAME, purpose: "setup_agent",
    ...(base === undefined ? {} : { preparedBase: [{ repositoryId: "web", baseCommitSha: base }] }),
  });
  await proposeTestEnvironment(store(t), { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body: proposal, origin: "setup_run", valueSources: [{ field: "repos[0].setupCommands[1]", source: { path: "package.json", line: 3 } }] });
  await writeSetupRunProposal(store(t), TEST_ORG, NAME, { digest, taskId: RUN_TASK, requestId: randomUUID(), by: OMAR.developerId, reply: {} });
  return digest;
}
const check = (t: Bench, digest: string) => t.dev(OMAR, "POST", `${ENV}/check`, { digest, requestId: randomUUID() });
const prove = (t: Bench, digest: string) => t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
async function finishCheck(t: Bench): Promise<void> {
  const record = candidates(t).at(-1)!;
  await t.finish(record.workspaceId, prepareOf(t, record.workspaceId), "SUCCEEDED", {});
}
const sentPins = (t: Bench) => {
  const outbox = t.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === candidates(t).at(-1)!.workspaceId)[0] as unknown as { invocation: { payload: { pins?: unknown } } };
  return outbox.invocation.payload.pins;
};

describe("the candidate check of a setup run's proposal is pinned", () => {
  it("is prepared at the commits the run used (sent as the pins), keeps them with the check, and is proved", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    t.githubHead.mockResolvedValue(OLDER); // main has not moved since the run read it
    await withSwitch("1", async () => {
      const digest = await fromRun(t, OLDER);
      expect((await check(t, digest)).status).toBe(202);
      expect(sentPins(t)).toEqual([{ repository: "web", commit: OLDER }]);
      expect(candidates(t)[0]).toMatchObject({ origin: "setup_run", pins: [{ repository: "web", commit: OLDER }] });
      await finishCheck(t);
      expect((await prove(t, digest)).status).toBe(200);
    });
  });

  it("is refused to start when main has moved since the run: a re-run is asked for, no workspace is made", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    t.githubHead.mockResolvedValue(HEAD);
    await withSwitch("1", async () => {
      const digest = await fromRun(t, OLDER);
      const refused = await check(t, digest);
      expect(refused.status).toBe(409);
      expect(errorOf(refused)).toMatchObject({ code: "CHANGE_STALE" });
      expect(errorOf(refused).message).toContain("run setup again");
      expect(candidates(t)).toEqual([]);
    });
  });

  it("falls back to the broker-resolved head when the run recorded no commit, and keeps that pin", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    t.githubHead.mockResolvedValue(HEAD);
    await withSwitch("1", async () => {
      const digest = await fromRun(t, undefined);
      expect((await check(t, digest)).status).toBe(202);
      expect(sentPins(t)).toEqual([{ repository: "web", commit: HEAD }]);
      expect(candidates(t)[0]!.pins).toEqual([{ repository: "web", commit: HEAD }]);
      await finishCheck(t);
      expect((await prove(t, digest)).status).toBe(200);
    });
  });

  it("a head that cannot be read refuses the start (never a check on an unpinned checkout)", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    t.githubHead.mockRejectedValue(new Error("GitHub is down"));
    await withSwitch("1", async () => {
      const digest = await fromRun(t, undefined);
      expect((await check(t, digest)).status).toBeGreaterThanOrEqual(500);
      expect(candidates(t)).toEqual([]);
    });
  });

  it("an ordinary proposal (not a setup run's) is checked as before, with no pins", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const proposal = body();
      await proposeTestEnvironment(store(t), { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body: proposal });
      expect((await check(t, testEnvDigest(proposal))).status).toBe(202);
      expect(sentPins(t)).toBeUndefined();
      expect(candidates(t)[0]!.pins).toBeUndefined();
    });
  });
});

describe("a setup run's proposal is proved only by a check at the run's commits", () => {
  it("a Prove is refused when the check was made at other commits than the run's, or kept none", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await fromRun(t, OLDER);
      for (const pins of [[{ repository: "web", commit: HEAD }], null] as const) {
        t.candidatePassed(digest, { pins });
        const refused = await prove(t, digest);
        expect(refused.status, JSON.stringify(pins)).toBe(400);
        expect(errorOf(refused).message).toContain("run setup again");
      }
      t.candidatePassed(digest, { pins: [{ repository: "web", commit: OLDER }] });
      expect((await prove(t, digest)).status).toBe(200);
    });
  });

  it("the approval re-verifies the pin: nothing is approved or written when the run's commits no longer match the check", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await fromRun(t, OLDER);
      t.candidatePassed(digest, { pins: [{ repository: "web", commit: OLDER }] });
      expect((await prove(t, digest)).status).toBe(200);
      // The run's recorded commits change under the proof (a re-run of the same marker, or a damaged record): the check is no longer at them.
      t.db.set({ ...(t.db.get(`DEVTASK#${RUN_TASK}`, "META") as Record<string, unknown>), preparedBase: [{ repositoryId: "web", baseCommitSha: HEAD }] });
      t.ageSignIn(OMAR, 1);
      const approved = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approved.status).toBe(400);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toEqual([]);
    });
  });

  it("another person's or another project's task is not read as the run", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const digest = await fromRun(t, OLDER);
      t.db.set({ ...(t.db.get(`DEVTASK#${RUN_TASK}`, "META") as Record<string, unknown>), project: "other" });
      // No run record: the check's own broker-resolved pin is what is left, and a missing pin still refuses.
      t.candidatePassed(digest, { pins: null });
      expect((await prove(t, digest)).status).toBe(400);
      t.candidatePassed(digest, { pins: [{ repository: "web", commit: HEAD }] });
      expect((await prove(t, digest)).status).toBe(200);
    });
  });
});

describe("checkedAtRunCommits", () => {
  const pin = (repository: string, commit: string) => ({ repository, commit });
  it("needs recorded pins; with a run record every repository must match exactly", () => {
    expect(checkedAtRunCommits(undefined, undefined)).toBe(false);
    expect(checkedAtRunCommits([], undefined)).toBe(false);
    expect(checkedAtRunCommits([pin("a", HEAD)], undefined)).toBe(true);
    expect(checkedAtRunCommits([pin("a", HEAD)], [pin("a", HEAD)])).toBe(true);
    expect(checkedAtRunCommits([pin("a", HEAD)], [pin("a", OLDER)])).toBe(false);
    expect(checkedAtRunCommits([pin("a", HEAD)], [pin("a", HEAD), pin("b", HEAD)])).toBe(false);
    expect(checkedAtRunCommits([pin("a", HEAD), pin("b", HEAD)], [pin("a", HEAD)])).toBe(false);
  });
});

