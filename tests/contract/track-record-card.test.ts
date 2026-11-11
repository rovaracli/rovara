// Track record (v1.2 slice 1, UI part): the How we work cards. The words of each claim (plan check, code and security review, tests), the "not enough history" line, the cap, the limits line,
// a read that fails (the field is left out: no record, never a zero), the risk claim that never reaches the shared card, and the mapping of a less-safe change to its stage.
import { describe, expect, it } from "vitest";
import { stepOfLessSafeReason, HowWeWorkViewReaderSchema, HowWeWorkViewSchema, OUTCOME_READ_CAP, ROVARA_CODE_AGENT_ID, agentXError, stageOfLessSafeReason, trackRecordLines, type HowWeWorkTrackRecord, type HowWeWorkView, type OutcomeClaim, type OutcomeState } from "@rovara-code/contracts";
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

  it("adds the cap when the read stopped at it; code and security review share one read, so theirs counts reviews", () => {
    expect(OUTCOME_READ_CAP).toBe(2000);
    expect(trackRecordLines(record({ capped: true, held: 1500, notHeld: 400 })).rate).toBe("The person approved the plan 1500 of 1900 times (last 30 days) (based on the latest 2000)");
    expect(trackRecordLines(record({ claim: "review_pass:CRITIC", capped: true, held: 1500, notHeld: 400 })).rate).toBe("No changes requested by a person on 1500 of 1900 merged PRs (last 30 days) (based on the latest 2000 reviews)");
  });

  it("lists the limits: closed unmerged, merged without a person's review, then the reverts sentence, leaving out any count that is 0", () => {
    const limits = (over: Partial<HowWeWorkTrackRecord>) => trackRecordLines(record({ claim: "review_pass:CRITIC", ...over })).limits;
    expect(limits({ closedUnmerged: 2, unreviewedMerges: 3 })).toBe(`2 PRs closed unmerged · 3 merged without a person's review · ${REVERTS}`);
    expect(limits({ closedUnmerged: 2 })).toBe(`2 PRs closed unmerged · ${REVERTS}`);
    expect(limits({ unreviewedMerges: 3 })).toBe(`3 merged without a person's review · ${REVERTS}`);
    expect(limits({})).toBe(REVERTS);
    expect(limits({ noOutcome: 4 })).toBe(`4 with no result to check · ${REVERTS}`);
  });

  it("puts the reverts sentence on the review lines only; the plan check has none, and the tests line says CI failures unrelated to the change count", () => {
    expect(trackRecordLines(record({ closedUnmerged: 1 })).limits).toBe("1 PR closed unmerged");
    expect(trackRecordLines(record()).limits).toBeUndefined();
    expect(trackRecordLines(record({ claim: "proves_change", closedUnmerged: 2 })).limits).toBe("2 PRs closed unmerged · CI failures unrelated to the change also count");
    expect(trackRecordLines(record({ claim: "proves_change", closedUnmerged: 1 })).limits).not.toContain("Reverts");
  });
});

describe("a less-safe change and its stage", () => {
  const stages = [
    { id: "plan", name: "Plan", kind: "plan" }, { id: "plan_critic", name: "Plan check", kind: "plan_critic" }, { id: "build", name: "Build", kind: "build" },
    { id: "check", name: "Checks", kind: "check" }, { id: "review", name: "Review", kind: "review" }, { id: "pull_request", name: "Pull request", kind: "pull_request" },
  ];
  it("maps a change about who reviews or checks at a stage, or about removing or weakening it, to that stage", () => {
    expect(stageOfLessSafeReason('Changes the instructions of the plan check "Plan check"', stages)).toBe("plan_critic");
    expect(stageOfLessSafeReason('Removes the review step "Review"', stages)).toBe("review");
    expect(stageOfLessSafeReason('Gives the review step "Review" fewer reviewers', stages)).toBe("review");
    expect(stageOfLessSafeReason('Moves the review step "Review" to a weaker model', stages)).toBe("review");
    expect(stageOfLessSafeReason('Makes the plan check "Plan check" use the same model as the plan step "Plan"', stages)).toBe("plan_critic");
    expect(stageOfLessSafeReason('Stops the review step "Review" needing a different AI company from the step it checks', stages)).toBe("review");
    expect(stageOfLessSafeReason('Stops the review step "Review" sending findings back', stages)).toBe("review");
    expect(stageOfLessSafeReason('Lowers how many times the review step "Review" sends findings back, from 3 to 1', stages)).toBe("review");
    expect(stageOfLessSafeReason("Removes the plan check", stages)).toBe("plan_critic");
  });
  it("shows nothing for a tool, spending, time or connector change that only quotes the step's name, or for a change about no stage with a record", () => {
    expect(stageOfLessSafeReason('Raises the time the step "Review" may run, from 60 to 90 minutes', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Removes the time limit of the step "Plan check"', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Raises the spending limit of the step "Review", from $5 to $9', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Allows more tools in the step "Review"', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Removes the tool limit on the step "Review"', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Gives the step "Review" read access to the project\'s files', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Lets the step "Review" send data to a new AI company (OpenAI)', stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Raises the time the step "Checks" may run, from 60 to 90 minutes', stages)).toBeUndefined();
    expect(stageOfLessSafeReason("Raises the agent's autonomy from suggest to run", stages)).toBeUndefined();
    expect(stageOfLessSafeReason("Moves the company plan_check default to a weaker model", stages)).toBeUndefined();
    expect(stageOfLessSafeReason('Removes the approval step "Ship it"', stages)).toBeUndefined();
  });
  it("matches by the step's kind, so an agent step that has the same name never gets a stage's record", () => {
    const withOwn = [{ id: "own_review", name: "Review", kind: "agent" }, { id: "own_check", name: "Checks", kind: "agent" }, ...stages];
    expect(stageOfLessSafeReason('Changes the instructions of the review step "Review"', withOwn)).toBe("review");
    expect(stageOfLessSafeReason('Removes the review step "Review"', [{ id: "own_review", name: "Review", kind: "agent" }])).toBeUndefined();
    // A step that reuses a stage's id with another kind is not the stage: the step found is the one of the right kind.
    const reused = [{ id: "review", name: "Review", kind: "agent" }, { id: "review", name: "Review", kind: "review" }];
    expect(stepOfLessSafeReason('Changes the instructions of the review step "Review"', reused)).toEqual({ id: "review", name: "Review", kind: "review" });
    expect(stepOfLessSafeReason('Changes the instructions of the review step "Review"', [reused[0]!])).toBeUndefined();
    expect(stageOfLessSafeReason('Removes the review step "Review"', [{ id: "own_review", name: "Review", kind: "agent" }, { id: "review", name: "Code review", kind: "review" }])).toBeUndefined();
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
    expect(v.stages.flatMap((entry) => entry.trackRecord ?? []).every((entry) => (entry.claim as string) !== "risk_low")).toBe(true);
    // A risk record somebody sends anyway is dropped on reading, and the rest of the view still loads.
    const sent = { ...v, stages: v.stages.map((entry) => entry.id === "review" ? { ...entry, trackRecord: [record({ claim: "risk_low" as never })] } : entry) };
    expect(HowWeWorkViewSchema.parse(sent).stages.flatMap((entry) => entry.trackRecord ?? [])).toEqual(v.stages.flatMap((entry) => entry.id === "review" ? [] : entry.trackRecord ?? []));
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

describe("reading a record a newer server may send", () => {
  it("reads a different window and bigger counts without failing the view", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const v = await view(w);
    const sent = { ...v, stages: v.stages.map((entry) => entry.id === "plan_critic" ? { ...entry, trackRecord: [{ ...record({ held: 3000, notHeld: 10 }), windowDays: 60, extra: "from a newer server" }] } : entry) };
    for (const schema of [HowWeWorkViewSchema, HowWeWorkViewReaderSchema]) {
      const read = schema.parse(sent) as HowWeWorkView;
      expect(stage(read, "plan_critic").trackRecord).toMatchObject([{ held: 3000, notHeld: 10, windowDays: 60 }]);
      expect(trackRecordLines(stage(read, "plan_critic").trackRecord![0]!).rate).toBe("The person approved the plan 3000 of 3010 times (last 60 days)");
    }
  });

  it("drops a malformed record and keeps the rest of the view, including the stage's other record", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const v = await view(w);
    const sent = { ...v, stages: v.stages.map((entry) => entry.id === "review"
      ? { ...entry, trackRecord: [{ claim: "review_pass:CRITIC", held: "many" }, record({ claim: "review_pass:SECURITY", held: 12, notHeld: 1 }), { claim: "a_new_claim", held: 1, notHeld: 0, closedUnmerged: 0, noOutcome: 0, unreviewedMerges: 0, windowDays: 30, capped: false, enough: false }, 7, null] }
      : entry.id === "plan_critic" ? { ...entry, trackRecord: "nonsense" } : entry) };
    for (const schema of [HowWeWorkViewSchema, HowWeWorkViewReaderSchema]) {
      const read = schema.safeParse(sent);
      expect(read.success).toBe(true);
      const stages = (read.data as HowWeWorkView).stages;
      expect(stages.find((entry) => entry.id === "review")!.trackRecord?.map((entry) => entry.claim)).toEqual(["review_pass:SECURITY"]);
      expect(stages.map((entry) => entry.id)).toEqual(v.stages.map((entry) => entry.id));
    }
  });
});

describe("how long the card waits for its records", () => {
  it("reads each kind of stage once, all together: four reads for the plan check, both reviews and the tests", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const queries: string[] = [];
    const counting = { send: async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, string> } }) => {
      if (command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues?.[":pk"] ?? "").includes("OUTCOME_SCORED")) queries.push(command.input.ExpressionAttributeValues![":pk"]!);
      return w.db.send(command);
    } };
    await view(w, counting);
    expect(queries.map((pk) => pk.split("#").slice(-2).join("#")).sort()).toEqual(["web#check", "web#plan_critic", "web#review", "web#review"]);
  });

  it("gives up on the records at the deadline and renders the rest of the view without them", async () => {
    const w = mergeWorld();
    await adoptVersion2(w);
    const slow = { send: async (command: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, string> } }) =>
      command.constructor.name === "QueryCommand" && (command.input.ExpressionAttributeValues?.[":pk"] ?? "").includes("OUTCOME_SCORED") ? await new Promise<never>(() => undefined) : w.db.send(command) };
    const started = Date.now();
    const v = await getProjectHowWeWork({ ...deps(w, slow), trackRecordDeadlineMs: 60 }, w.caller(MAX), "web");
    expect(Date.now() - started).toBeLessThan(1500);
    for (const entry of v.stages) expect(entry).not.toHaveProperty("trackRecord");
    expect(v.stages.map((entry) => entry.id)).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
  });
});
