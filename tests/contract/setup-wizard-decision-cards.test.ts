// Setup wizard (E4), the decision cards for the test environment, through the whole broker: `approve_test_env` (a proved proposal waiting for a maintainer) and `confirm_env_change` (a running task offered a newer
// revision). A card is a projection; the performer calls the wizard's own approval, which re-checks the caller's authority, so a card never decides more than the wizard would.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, testEnvDigest, type DecisionCard } from "../../packages/contracts/src/index.js";
import { answerEnvChange, takesTheChange } from "../../packages/broker/src/decisions/test-env-source.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ENV, NAME, command, draftBody, draftOf, errorOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";

const withCards = async <T>(run: () => Promise<T>): Promise<T> => {
  const before = process.env.DECISION_CARDS_ENABLED;
  process.env.DECISION_CARDS_ENABLED = "1";
  try { return await run(); } finally { if (before === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = before; }
};
afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; delete process.env.DECISION_CARDS_ENABLED; });

const cards = async (t: Bench, who = OMAR) => {
  const reply = await t.dev(who, "GET", "/v1/app/decisions");
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const { requestId: _gateway, ...own } = reply.body; void _gateway;
  const view = DecisionCardsViewSchema.parse(own);
  return { cards: view.cards, digests: view.digests };
};
const ofKind = (list: readonly DecisionCard[], kind: string) => list.filter((card) => card.kind === kind);

/** A proposal for the draft, proved but not approved. */
async function provedProposal(t: Bench, draft = draftOf()): Promise<string> {
  await t.drafted(draft);
  expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
  const digest = testEnvDigest(draft.environment);
  t.setupCheckPassed();
  expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
  return digest;
}
const NIGHTLY = draftBody({ nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" } });

describe("approve_test_env", () => {
  it("a proved proposal is a medium card a maintainer approves in two steps (open the evidence, then approve), and it is the wizard's own approval", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      const digest = await provedProposal(t);
      const { cards: list, digests } = await cards(t);
      const [card] = ofKind(list, "approve_test_env");
      expect(card).toMatchObject({ id: `approve_test_env:${digest}`, project: NAME, risk: "medium", status: "pending" });
      expect(card!.actions.map((action) => action.kind)).toEqual(expect.arrayContaining(["approve", "open"]));
      const base = `/v1/app/decisions/approve_test_env/${digest}`;
      // The evidence of a medium card is opened first.
      const early = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
      expect(early.status).toBe(409);
      expect((await t.dev(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card!.id] })).status).toBe(200);
      const approved = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")).toHaveLength(1);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")[0]).toMatchObject({ digest, approvedBy: OMAR.developerId, revision: 1 });
      expect(ofKind((await cards(t)).cards, "approve_test_env")).toEqual([]);
    }));
  });

  it("a later revision is approved from its card at the revision the person looked at, and a card for a revision that has moved on is refused as changed", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      await t.approveFirst();
      const next = draftBody({ selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [".github/**"] } });
      await t.web(OMAR, "POST", `${ENV}/edit`, { environment: next });
      const digest = testEnvDigest(next);
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
      const { cards: list, digests } = await cards(t);
      const card = ofKind(list, "approve_test_env")[0]!;
      const base = `/v1/app/decisions/approve_test_env/${digest}`;
      await t.dev(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      // Someone approves another revision first (a different environment), so the card's revision has moved on.
      const other = draftBody({ selection: { method: "coverage_map", alwaysRun: ["unit"], fullSuiteOn: [] } });
      await t.web(OMAR, "POST", `${ENV}/edit`, { environment: other });
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest: testEnvDigest(other) });
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest: testEnvDigest(other), expectedRevision: 1 })).status).toBe(200);
      const stale = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")).toHaveLength(2);
    }));
  });

  it("is listed only for a maintainer, only when proved, and not at all with a switch off", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "member", "contributor");
    await withSwitch("1", () => withCards(async () => {
      await t.drafted();
      await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      expect(ofKind((await cards(t)).cards, "approve_test_env")).toEqual([]); // not proved
      t.setupCheckPassed();
      await t.dev(OMAR, "POST", `${ENV}/prove`, { digest: testEnvDigest(draftBody()) });
      expect(ofKind((await cards(t)).cards, "approve_test_env")).toHaveLength(1);
      expect(ofKind((await cards(t, MAYA)).cards, "approve_test_env")).toEqual([]); // a contributor cannot approve it
    }));
    await withSwitch(undefined, () => withCards(async () => { expect(ofKind((await cards(t)).cards, "approve_test_env")).toEqual([]); }));
  });

  it("a less-safe proposal is a HIGH card with no approve action: it opens the setup page, and an approve sent anyway decides nothing", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      await t.approveFirst();
      expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: NIGHTLY })).status).toBe(200);
      const digest = testEnvDigest(NIGHTLY);
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
      const { cards: list, digests } = await cards(t);
      const [card] = ofKind(list, "approve_test_env");
      expect(card).toMatchObject({ risk: "high" });
      expect(card!.riskReasons.join(" ")).toContain("nightly enabled");
      expect(card!.actions.map((action) => action.kind)).toEqual(["open"]);
      expect(card!.actions[0]!.href).toBe(`/app/onboard?project=${NAME}&step=setup`);
      const pressed = await t.dev(OMAR, "POST", `/v1/app/decisions/approve_test_env/${digest}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
      expect(pressed.status).toBe(404);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")).toHaveLength(1);
    }));
  });

  it("the performer's approval is the wizard's: a less-safe item pressed directly is refused by the approval itself", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      await t.approveFirst();
      await t.web(OMAR, "POST", `${ENV}/edit`, { environment: NIGHTLY });
      const digest = testEnvDigest(NIGHTLY);
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
      // Even a press that reaches the approval (a token, or a browser with no second person) decides nothing.
      const viaToken = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(viaToken.status).toBe(403);
      expect(errorOf(viaToken).message).toContain("browser");
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")).toHaveLength(1);
    }));
  });
});

describe("confirm_env_change", () => {
  const selectionChanged = () => draftBody({ selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [".github/**"] } });
  const startTask = async (t: Bench): Promise<string> => {
    const started = await t.dev(OMAR, "POST", `/v1/app/projects/${NAME}/code`, { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    return (started.body.task as { taskId: string }).taskId;
  };
  /** Revision 2: `body` proposed, proved and approved (not less safe, so by the maintainer alone). */
  const approveSecond = async (t: Bench, body = selectionChanged()) => {
    expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: body })).status).toBe(200);
    const digest = testEnvDigest(body);
    expect((await t.web(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
    const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return digest;
  };
  const pinOf = (t: Bench, taskId: string) => t.db.find((item) => item.entityType === "TEST_ENV_PIN" && item.taskId === taskId)[0] as { revision: number; digest: string; declined?: string };

  it("a running task is offered the newer revision when only the selection changed; approving moves its pin, and only the task's owner is asked", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "member", "contributor");
    await withSwitch("1", () => withCards(async () => {
      await t.approveFirst();
      const taskId = await startTask(t);
      expect(pinOf(t, taskId)).toMatchObject({ revision: 1 });
      expect(ofKind((await cards(t)).cards, "confirm_env_change")).toEqual([]); // nothing newer yet
      const second = await approveSecond(t);
      const { cards: list, digests } = await cards(t);
      const [card] = ofKind(list, "confirm_env_change");
      expect(card).toMatchObject({ id: `confirm_env_change:${taskId}`, risk: "medium", taskId });
      expect(ofKind((await cards(t, MAYA)).cards, "confirm_env_change")).toEqual([]);
      const base = `/v1/app/decisions/confirm_env_change/${taskId}`;
      await t.dev(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
      const answered = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      expect(pinOf(t, taskId)).toMatchObject({ revision: 2, digest: second });
      expect(ofKind((await cards(t)).cards, "confirm_env_change")).toEqual([]);
    }));
  });

  it("'Not now' keeps the task on its revision and the card does not come back for that revision, but does for a newer one", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      await t.approveFirst();
      const taskId = await startTask(t);
      const second = await approveSecond(t);
      const { cards: list } = await cards(t);
      const card = ofKind(list, "confirm_env_change")[0]!;
      expect(card.id).toBe(`confirm_env_change:${taskId}`);
      const declined = await t.dev(OMAR, "POST", `/v1/app/decisions/confirm_env_change/${taskId}/reject`, { requestId: randomUUID(), reason: "not_now" });
      expect(declined.status, JSON.stringify(declined.body)).toBe(200);
      expect(pinOf(t, taskId)).toMatchObject({ revision: 1, declined: second });
      expect(ofKind((await cards(t)).cards, "confirm_env_change")).toEqual([]);
      // A newer revision is a new question.
      const third = draftBody({ selection: { method: "coverage_map", alwaysRun: ["unit"], fullSuiteOn: [".github/**"] } });
      expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: third })).status).toBe(200);
      const digest = testEnvDigest(third);
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 2 })).status).toBe(200);
      expect(ofKind((await cards(t)).cards, "confirm_env_change")).toHaveLength(1);
    }));
  });

  it("is not offered when the checks themselves changed, to a task that has ended, or with a switch off", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      await t.approveFirst();
      const taskId = await startTask(t);
      // A different command for the same check: the task keeps the revision it started with.
      const other = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test", "--fast"], 1800), kind: "test" }] }] });
      await t.web(OMAR, "POST", `${ENV}/edit`, { environment: other });
      const digest = testEnvDigest(other);
      t.setupCheckPassed(1);
      const proved = await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
      // The setup check has not run `--fast`, so this is not provable here; apply the commands, then it can be.
      expect(proved.status).toBe(400);
      expect(ofKind((await cards(t)).cards, "confirm_env_change")).toEqual([]);
      expect(pinOf(t, taskId)).toMatchObject({ revision: 1 });
    }));
    const ended = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      await ended.approveFirst();
      const taskId = await startTask(ended);
      await approveSecond(ended);
      expect(ofKind((await cards(ended)).cards, "confirm_env_change")).toHaveLength(1);
      const task = ended.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
      ended.db.set({ ...task, closedAt: new Date().toISOString() });
      expect(ofKind((await cards(ended)).cards, "confirm_env_change")).toEqual([]);
      ended.db.set(task);
      expect(ofKind((await cards(ended)).cards, "confirm_env_change")).toHaveLength(1);
    }));
    await withSwitch(undefined, () => withCards(async () => { expect(ofKind((await cards(ended)).cards, "confirm_env_change")).toEqual([]); }));
  });

  it("only the task's CURRENT owner is asked and can answer: after a take-over the card moves with the task, and a non-owner's answer changes nothing", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "member", "maintainer");
    await withSwitch("1", () => withCards(async () => {
      await t.approveFirst();
      const taskId = await startTask(t);
      await approveSecond(t);
      expect(ofKind((await cards(t)).cards, "confirm_env_change")).toHaveLength(1);
      const task = t.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
      const ports = { store: { documentClient: t.db, tableName: "state", now: () => Date.now() }, task: async () => t.db.get(`DEVTASK#${taskId}`, "META") as never };
      // Maya answers a task that is Omar's: nothing.
      expect(await answerEnvChange(ports as never, { orgId: TEST_ORG, developerId: MAYA.developerId }, taskId, "approve")).toBe("gone");
      expect(pinOf(t, taskId)).toMatchObject({ revision: 1 });
      // The task is taken over by Maya: it is no longer Omar's to answer.
      t.db.set({ ...task, currentOwner: { developerId: MAYA.developerId, name: MAYA.name, provider: MAYA.provider, since: new Date().toISOString() } });
      expect(await answerEnvChange(ports as never, { orgId: TEST_ORG, developerId: OMAR.developerId }, taskId, "approve")).toBe("gone");
      expect(ofKind((await cards(t)).cards, "confirm_env_change")).toEqual([]);
      expect(pinOf(t, taskId)).toMatchObject({ revision: 1 });
      expect(await answerEnvChange(ports as never, { orgId: TEST_ORG, developerId: MAYA.developerId }, taskId, "approve")).toBe("moved");
      expect(pinOf(t, taskId)).toMatchObject({ revision: 2 });
    }));
  });

  it("a running task is never moved to something less safe, or to different checks (the rule on its own)", () => {
    const base = draftBody();
    expect(takesTheChange(base, draftBody({ selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] } }))).toBe(true);
    expect(takesTheChange(base, draftBody({ nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" } }))).toBe(false);
    expect(takesTheChange(base, draftBody({ roundBudgetMin: 60 }))).toBe(false);
    expect(takesTheChange(base, draftBody({ capture: { screenshots: "failed", video: true, traces: false } }))).toBe(false);
    expect(takesTheChange(base, draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }] }))).toBe(false);
    expect(takesTheChange(base, draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Renamed", command: command("make", ["old-test"], 1800), kind: "test" }] }] }))).toBe(true);
  });
});
