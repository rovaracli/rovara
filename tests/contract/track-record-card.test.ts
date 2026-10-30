// Track record (v1.2 slice 1, UI part): the How we work cards. The words of each claim (plan check, code and security review, tests), the "not enough history" line, the cap, the limits line,
// a read that fails (the field is left out: no record, never a zero), the risk claim that never reaches the shared card, and the mapping of a less-safe change to its stage.
import { describe, expect, it } from "vitest";
import {
  HowWeWorkViewReaderSchema, HowWeWorkViewSchema, OUTCOME_READ_CAP, ROVARA_CODE_AGENT_ID, agentXError, stageOfLessSafeReason, trackRecordLines,
  type HowWeWorkTrackRecord, type HowWeWorkView, type OutcomeClaim, type OutcomeState,
} from "../../packages/contracts/src/index.js";
import { getProjectHowWeWork, type HowWeWorkDependencies } from "../../packages/broker/src/playbook/routes.js";
import { recordOutcomeSample } from "../../packages/broker/src/rovara-code/outcomes.js";
import { MAX, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const REVERTS = "Reverts after merge aren't tracked yet";
const record = (over: Partial<HowWeWorkTrackRecord> = {}): HowWeWorkTrackRecord => ({
  claim: "plan_ready", held: 14, notHeld: 3, closedUnmerged: 0, noOutcome: 0, unreviewedMerges: 0, windowDays: 30, capped: false, enough: true, ...over,
});

describe("the words of a track record", () => {
  it("says the person approved the plan N of M times for the plan check", () => {
    expect(trackRecordLines(record())).toEqual({ title: "Plan check", rate: "The person approved the plan 14 of 17 times (last 30 days)" });
  });

  it("says no changes were requested by a person on N of M merged PRs for code review and for security review", () => {
    expect(trackRecordLines(record({ claim: "review_pass:CRITIC", held: 9, notHeld: 1 }))).toEqual({
      title: "Code review", rate: "No changes requested by a person on 9 of 10 merged PRs (last 30 days)", limits: REVERTS,
    });
    expect(trackRecordLines(record({ claim: "review_pass:SECURITY", held: 12, notHeld: 0 }))).toMatchObject({ title: "Security review", rate: "No changes requested by a person on 12 of 12 merged PRs (last 30 days)" });
  });

  it("says CI passed on N of M PRs where tests said they prove the change", () => {
    expect(trackRecordLines(record({ claim: "proves_change", held: 7, notHeld: 1, enough: false })).rate).toBe("Not enough history yet (8 so far)");
    expect(trackRecordLines(record({ claim: "proves_change", held: 14, notHeld: 2 }))).toMatchObject({
      title: "Tests", rate: "CI passed on 14 of 16 PRs where tests said they prove the change (last 30 days)",
    });
  });

  it("reads \"Not enough history yet (N so far)\" below ten scored samples, for every claim, using held plus not held", () => {
    for (const claim of ["plan_ready", "review_pass:CRITIC", "review_pass:SECURITY", "proves_change"] as const) {
      expect(trackRecordLines(record({ claim, held: 4, notHeld: 2, closedUnmerged: 5, noOutcome: 1, enough: false })).rate).toBe("Not enough history yet (6 so far)");
    }
    expect(trackRecordLines(record({ held: 0, notHeld: 0, enough: false })).rate).toBe("Not enough history yet (0 so far)");
  });

  it("adds the cap, \"(based on the latest 2000)\", when the read stopped at it", () => {
    expect(OUTCOME_READ_CAP).toBe(2000);
    expect(trackRecordLines(record({ capped: true, held: 1500, notHeld: 400 })).rate).toBe("The person approved the plan 1500 of 1900 times (last 30 days) (based on the latest 2000)");
  });

  it("lists the limits: closed unmerged, merged without a person's review, then the reverts sentence, leaving out any count that is 0", () => {
    const limits = (over: Partial<HowWeWorkTrackRecord>) => trackRecordLines(record({ claim: "review_pass:CRITIC", ...over })).limits;
    expect(limits({ closedUnmerged: 2, unreviewedMerges: 3 })).toBe(`2 closed unmerged · 3 merged without a person's review · ${REVERTS}`);
    expect(limits({ closedUnmerged: 2 })).toBe(`2 closed unmerged · ${REVERTS}`);
    expect(limits({ unreviewedMerges: 3 })).toBe(`3 merged without a person's review · ${REVERTS}`);
    expect(limits({})).toBe(REVERTS);
    expect(limits({ noOutcome: 4 })).toBe(`4 with no result to check · ${REVERTS}`);
  });

  it("puts the reverts sentence on the review lines only; the plan check has none, and the tests line says CI failures unrelated to the change count", () => {
    expect(trackRecordLines(record({ closedUnmerged: 1 })).limits).toBe("1 closed unmerged");
    expect(trackRecordLines(record()).limits).toBeUndefined();
    expect(trackRecordLines(record({ claim: "proves_change", closedUnmerged: 2 })).limits).toBe("2 closed unmerged · CI failures unrelated to the change also count");
    expect(trackRecordLines(record({ claim: "proves_change", closedUnmerged: 1 })).limits).not.toContain("Reverts");
  });
});

describe("a less-safe change and its stage", () => {
  const stages = [
    { id: "plan", name: "Plan", kind: "plan" }, { id: "plan_critic", name: "Plan check", kind: "plan_critic" }, { id: "build", name: "Build", kind: "build" },
    { id: "check", name: "Checks", kind: "check" }, { id: "review", name: "Review", kind: "review" }, { id: "pull_request", name: "Pull request", kind: "pull_request" },
  ];
  it("maps a change that names a step, or says plan check or review step, to that stage", () => {
    expect(stageOfLessSafeReason('Changes the instructions of the plan check "Plan check"', stages)).toBe("plan_critic");
    expect(stageOfLessSafeReason('Removes the review step "Review"', stages)).toBe("review");
    expect(stageOfLessSafeReason('Gives the review step "Review" fewer reviewers', stages)).toBe("review");
    expect(stageOfLessSafeReason('Moves the review step "Review" to a weaker model', stages)).toBe("review");
    expect(stageOfLessSafeReason('Raises the time the step "Checks" may run, from 60 to 90 minutes', stages)).toBe("check");
    expect(stageOfLessSafeReason("Removes the plan check", stages)).toBe("plan_critic");
  });
  it("shows nothing for a change that is not about a stage with a record", () => {
    expect(stageOfLessSafeReason('Lets the step "Build" send data to a new AI company (OpenAI)', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Removes the time limit of the step "Pull request"', stages)).toBeUndefined();
    expect(stageOfLessSafeReason("Raises the agent's autonomy from suggest to run", stages)).toBeUndefined();
    expect(stageOfLessSafeReason("Moves the company plan_check default to a weaker model", stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Removes the approval step "Ship it"', stages)).toBeUndefined();
  });
});

// ---- the broker fills the field

const DAY = 86_400_000;
const deps = (w: MergeWorld, send?: HowWeWorkDependencies["documentClient"]): HowWeWorkDependencies => ({
  documentClient: send ?? w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
  projectFor: async (caller, rawName) => ({ name: rawName, role: (await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: "member" }))! }),
});
const view = (w: MergeWorld, send?: HowWeWorkDependencies["documentClient"]) => getProjectHowWeWork(deps(w, send), w.caller(MAX), "web");
const stage = (v: HowWeWorkView, id: string) => v.stages.find((entry) => entry.id === id)!;
let counter = 0;
async function seed(w: MergeWorld, claim: OutcomeClaim, state: Exclude<OutcomeState, "pending">, count: number, extra: { unreviewedMerge?: true; project?: string; scoredDaysAgo?: number } = {}) {
  const stageId = claim === "plan_ready" ? "plan_critic" : claim === "proves_change" ? "check" : claim === "risk_low" ? "risk" : "review";
  for (let index = 0; index < count; index += 1) {
    counter += 1;
    const scoredAt = new Date(w.clock.now - (extra.scoredDaysAgo ?? 3) * DAY).toISOString();
    const made = await recordOutcomeSample({ ddb: w.db, tableName: "state" }, {
      orgId: ORG_A, project: extra.project ?? "web", stage: stageId, taskId: `task-${String(counter)}`, claim, round: "r1", state, reason: state === "held" ? "ci_passing" : "closed_unmerged",
      ...(extra.unreviewedMerge === undefined ? {} : { unreviewedMerge: extra.unreviewedMerge }),
      agent: { id: ROVARA_CODE_AGENT_ID, version: "3", digest: "d".repeat(64) }, model: "anthropic/test", createdAt: new Date(w.clock.now - 20 * DAY).toISOString(), scoredAt,
    });
    expect(made.created).toBe(true);
  }
}
async function adoptVersion2(w: MergeWorld) {
  await w.store.adoptBuiltinVersion({ orgId: ORG_A, agentId: ROVARA_CODE_AGENT_ID, version: 2, expectedPinnedVersion: await w.store.pinnedBuiltinVersion(ORG_A, ROVARA_CODE_AGENT_ID), by: MAX });
}

describe("How we work carries each stage's record", () => {
  it("fills the plan check, both reviews and the tests, from the samples scored in the last 30 days of this project", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    await seed(w, "plan_ready", "held", 14); await seed(w, "plan_ready", "not_held", 3);
    await seed(w, "review_pass:CRITIC", "held", 9, { unreviewedMerge: true }); await seed(w, "review_pass:CRITIC", "not_held", 1); await seed(w, "review_pass:CRITIC", "closed_unmerged", 2);
    await seed(w, "review_pass:SECURITY", "held", 4);
    await seed(w, "proves_change", "held", 7); await seed(w, "proves_change", "not_held", 1);
    await seed(w, "plan_ready", "held", 5, { project: "other" }); await seed(w, "plan_ready", "held", 5, { scoredDaysAgo: 40 });
    const v = await view(w);
    expect(HowWeWorkViewSchema.safeParse(v).success).toBe(true);
    expect(HowWeWorkViewReaderSchema.safeParse(v).success).toBe(true);
    expect(stage(v, "plan_critic").trackRecord).toEqual([record({ held: 14, notHeld: 3 })]);
    expect(stage(v, "review").trackRecord).toEqual([
      record({ claim: "review_pass:CRITIC", held: 9, notHeld: 1, closedUnmerged: 2, unreviewedMerges: 9 }),
      record({ claim: "review_pass:SECURITY", held: 4, notHeld: 0, enough: false }),
    ]);
    expect(stage(v, "check").trackRecord).toEqual([record({ claim: "proves_change", held: 7, notHeld: 1, enough: false })]);
    for (const id of ["plan", "build", "pull_request"]) expect(stage(v, id)).not.toHaveProperty("trackRecord");
  });

  it("shows an empty record as not enough history, never as a missing stage", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const v = await view(w);
    expect(stage(v, "plan_critic").trackRecord).toEqual([record({ held: 0, notHeld: 0, enough: false })]);
    expect(trackRecordLines(stage(v, "plan_critic").trackRecord![0]!).rate).toBe("Not enough history yet (0 so far)");
  });

  it("never puts the PR risk claim on the card, even when risk samples exist", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    await seed(w, "risk_low", "held", 12);
    const v = await view(w);
    const text = JSON.stringify(v);
    expect(text).not.toContain("risk_low");
    expect(v.stages.some((entry) => entry.id === "risk")).toBe(false);
    expect(v.stages.flatMap((entry) => entry.trackRecord ?? []).every((entry) => entry.claim !== "risk_low")).toBe(true);
    expect(HowWeWorkViewSchema.safeParse({ ...v, stages: v.stages.map((entry) => entry.id === "review" ? { ...entry, trackRecord: [record({ claim: "risk_low" as never })] } : entry) }).success).toBe(false);
  });

  it("leaves the field out when the read fails: no record rather than zero, and the rest of the view is unchanged", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    await seed(w, "plan_ready", "held", 12);
    const failing = { send: async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, string> } }) => {
      if (command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues?.[":pk"] ?? "").includes("OUTCOME_SCORED")) throw Object.assign(new Error("secret table text"), { name: "ProvisionedThroughputExceededException" });
      return w.db.send(command);
    } };
    const whole = await view(w, failing);
    for (const entry of whole.stages) expect(entry).not.toHaveProperty("trackRecord");
    expect(JSON.stringify(whole)).not.toContain("secret table text");
    const { stages: withRecord, ...rest } = await view(w);
    const { stages: without, ...sameRest } = whole;
    expect(rest).toEqual(sameRest);
    expect(without.map((entry) => entry.id)).toEqual(withRecord.map((entry) => entry.id));
    expect(stage(await view(w), "plan_critic").trackRecord?.[0]).toMatchObject({ held: 12 });
  });

  it("keeps the record of the code review when only the security review's read fails", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    await seed(w, "review_pass:CRITIC", "held", 10);
    // The two reviews share one stage key: the second read of it (the security review's) fails.
    const failures = { count: 0 };
    const send = { send: async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, string> } }) => {
      if (command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues?.[":pk"] ?? "").includes("OUTCOME_SCORED#web#review")) {
        failures.count += 1;
        if (failures.count === 2) throw new Error("boom");
      }
      return w.db.send(command);
    } };
    const v = await view(w, send);
    expect(stage(v, "review").trackRecord).toHaveLength(1);
    expect(stage(v, "review").trackRecord![0]!.claim).toBe("review_pass:CRITIC");
  });

  it("is still a view of the project whose reads are refused for others", async () => {
    const w = mergeWorld();
    await expect(getProjectHowWeWork({ ...deps(w), projectFor: async () => { throw agentXError("PROJECT_NOT_FOUND", "project not found"); } }, w.caller(MAX), "web")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});
