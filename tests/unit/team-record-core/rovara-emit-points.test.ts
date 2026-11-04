// Team record source-row lane, T4: Rovara's own events reach the record. Four hook points (a remembered note, a plan's outcome, a published review's outcome, the end of the task) announce through
// `lessons/record-events.ts`; `installTeamRecordEmitter` registers the listener and the task-end handler only where the record is on. Three layers are proved:
//  1. the registration list (off: nothing is registered, so the callers are what they were);
//  2. each hook point announces the right event with the task's visibility and the actor, never throws into its caller and never holds it past the budget;
//  3. the real runtime's emitter writes the rows: no `rovara:project/<p>` row means the default retention, a row means ITS retention, audience and switch, and a private task stays restricted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerOrgKey, githubMemberKey } from "@agentx/contracts";
import type { WorkflowSnapshot } from "../../../packages/contracts/src/index.js";
import { hasTaskEndHandlers, onTaskEnded, registerTaskEndHandler } from "../../../packages/broker/src/agents/task-end.js";
import { installTeamRecordEmitter, teamRecordEmitterInstalled, uninstallTeamRecordEmitter } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { rememberTaskComment } from "../../../packages/broker/src/learning/capture-comment.js";
import {
  RECORD_EMIT_BUDGET_MS, recordListenerOf, recordTaskEndHandler, registerRovaraRecordListener, rovaraRecordListenerCount, taskVisibilityOf, type RovaraRecordEvent,
} from "../../../packages/broker/src/lessons/record-events.js";
import { outcomeRoundOf, recordPlanOutcome, recordPublicationOutcomes, type OutcomeTask } from "../../../packages/broker/src/rovara-code/outcome-hooks.js";
import type { OutcomeDependencies } from "../../../packages/broker/src/rovara-code/outcomes.js";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { putSourceConfig } from "../../../packages/broker/src/team-record/store.js";
import { SdkUnavailableError } from "../../../packages/broker/src/team-record/aws-adapters.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";
import { PRIYA, RETRY_TEXT, SAM, learningTask, seedComment, seedPerson } from "../../support/learning-page.js";
import { pageTask } from "../../support/page-tasks.js";
import { T0 } from "../../support/team-record-core.js";

const removers: Array<() => void> = [];
afterEach(() => {
  uninstallTeamRecordEmitter();
  for (const remove of removers.splice(0)) remove();
  vi.restoreAllMocks();
});

const listen = (): RovaraRecordEvent[] => {
  const heard: RovaraRecordEvent[] = [];
  removers.push(registerRovaraRecordListener(async (event) => { heard.push(event); }));
  return heard;
};
const AT = "2026-10-30T09:00:00.000Z";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "c".repeat(64);

// ---- 1. the registration list
describe("the registration list", () => {
  it("record off: nothing is registered (no listener, no task-end handler), and the hook points are no-ops", async () => {
    installTeamRecordEmitter({ teamRecord: undefined });
    expect(teamRecordEmitterInstalled()).toBe(false);
    expect(rovaraRecordListenerCount()).toBe(0);
    expect(hasTaskEndHandlers()).toBe(false);
    const builder = vi.fn();
    const { announceRovaraEvent } = await import("../../../packages/broker/src/lessons/record-events.js");
    await announceRovaraEvent("remembered", builder);
    expect(builder).not.toHaveBeenCalled();
  });

  it("record on: one listener and one task-end handler, once however often the broker starts; uninstall takes both off", () => {
    const fake = { emitter: {} } as unknown as TeamRecordRuntime;
    installTeamRecordEmitter({ teamRecord: fake });
    installTeamRecordEmitter({ teamRecord: fake });
    expect(rovaraRecordListenerCount()).toBe(1);
    expect(hasTaskEndHandlers()).toBe(true);
    uninstallTeamRecordEmitter();
    expect(rovaraRecordListenerCount()).toBe(0);
    expect(hasTaskEndHandlers()).toBe(false);
  });
});

// ---- 2. the hook points
describe("remembered", () => {
  const membersTask = () => {
    const fixture = learningTask();
    seedPerson(fixture.db, PRIYA, "contributor");
    seedPerson(fixture.db, SAM, "contributor");
    return fixture;
  };

  it("a shared task: announced once, for the author of the words, with the same text the correction keeps; a repeat announces nothing more", async () => {
    const heard = listen();
    const fixture = membersTask();
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    const answer = await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      kind: "remembered", workspaceId: TEST_ORG, project: "payments", taskId: fixture.taskId, noteId: answer.correction.id, actorDeveloperId: SAM.developerId, visibility: { kind: "shared" },
    });
    expect((heard[0] as { text: string }).text).toContain("shared retry helper");
    expect(heard[0]).not.toHaveProperty("origin");
  });

  it("a private task: the visibility is the owner's alone; a Slack origin is carried when the caller says so", async () => {
    const heard = listen();
    const fixture = membersTask();
    fixture.db.set({ ...fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!, shared: false });
    const comment = seedComment(fixture, SAM, RETRY_TEXT);
    await rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, comment.commentId, { origin: "slack" });
    expect(heard[0]).toMatchObject({ visibility: { kind: "private", ownerDeveloperId: PRIYA.developerId }, origin: "slack" });
  });

  it("a refused Remember announces nothing, and a listener that throws does not change the answer", async () => {
    const heard = listen();
    removers.push(registerRovaraRecordListener(async () => { throw new Error("secret detail from the table"); }));
    const fixture = learningTask();
    seedPerson(fixture.db, PRIYA, "viewer");
    const refused = seedComment(fixture, SAM, RETRY_TEXT);
    await expect(rememberTaskComment(fixture.deps, PRIYA, fixture.taskId, refused.commentId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(heard).toEqual([]);
    const ok = membersTask();
    const comment = seedComment(ok, SAM, RETRY_TEXT);
    await expect(rememberTaskComment(ok.deps, PRIYA, ok.taskId, comment.commentId)).resolves.toMatchObject({ correction: { standing: "member" } });
    expect(heard).toHaveLength(1);
    const logs = JSON.stringify((ok.deps.log as unknown as ReturnType<typeof vi.fn>).mock.calls);
    expect(logs).toContain("record.emit_failed");
    expect(logs).toContain("remembered");
    expect(logs).not.toContain("secret detail");
  });
});

const critique = { status: "done", critiques: [{ verdict: "ok", model: { provider: "t", modelId: "m" } }] } as unknown as WorkflowSnapshot["critique"];
const task = (extra: Record<string, unknown> = {}): OutcomeTask => ({ taskId: TASK_ID, orgId: TEST_ORG, project: "payments", shared: true, ...extra });
function outcomeDeps(): OutcomeDependencies & { logs: string[] } {
  const db = new FakeDynamoDb();
  const logs: string[] = [];
  return { ddb: db, tableName: "State", log: (event) => logs.push(event), logs };
}

describe("planOutcome", () => {
  it("announces the person's decision on the plan check's claim, for the plan revision", async () => {
    const heard = listen();
    await recordPlanOutcome(outcomeDeps(), task(), { critique, revision: 4, decision: "APPROVE", at: AT });
    await recordPlanOutcome(outcomeDeps(), task(), { critique, revision: 5, decision: "REJECT", at: AT });
    expect(heard).toMatchObject([
      { kind: "planOutcome", workspaceId: TEST_ORG, project: "payments", taskId: TASK_ID, planId: "4", outcome: "plan_approved", claims: 1, claimsHeld: 1, visibility: { kind: "shared" }, at: AT },
      { kind: "planOutcome", planId: "5", outcome: "plan_rejected", claims: 1, claimsHeld: 0 },
    ]);
  });

  it("a plan with no claim, or a task with no stated visibility, announces nothing; a failed track-record write does not stop the record's own", async () => {
    const heard = listen();
    await recordPlanOutcome(outcomeDeps(), task(), { critique: undefined, revision: 1, decision: "APPROVE", at: AT });
    await recordPlanOutcome(outcomeDeps(), task({ shared: undefined }), { critique, revision: 1, decision: "APPROVE", at: AT });
    expect(heard).toEqual([]);
    const broken = { ...outcomeDeps(), ddb: { send: async () => { throw new Error("down"); } } };
    await recordPlanOutcome(broken, task(), { critique, revision: 2, decision: "APPROVE", at: AT });
    expect(heard).toHaveLength(1);
  });

  it("a private task is announced as the owner's; one with no readable owner is not announced", async () => {
    const heard = listen();
    await recordPlanOutcome(outcomeDeps(), task({ shared: false, developerId: PRIYA.developerId, developerName: "Priya", provider: "slack" }), { critique, revision: 1, decision: "SKIP", at: AT });
    await recordPlanOutcome(outcomeDeps(), task({ shared: false }), { critique, revision: 2, decision: "SKIP", at: AT });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ outcome: "plan_skipped", visibility: { kind: "private", ownerDeveloperId: PRIYA.developerId } });
  });

  it("a listener that throws never reaches the caller; one that never answers holds it only for the budget", async () => {
    removers.push(registerRovaraRecordListener(async () => { throw new Error("boom"); }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(recordPlanOutcome(outcomeDeps(), task(), { critique, revision: 1, decision: "APPROVE", at: AT })).resolves.toBeUndefined();
    removers.splice(0).forEach((remove) => remove());
    removers.push(registerRovaraRecordListener(() => new Promise<void>(() => undefined)));
    vi.useFakeTimers();
    try {
      let finished = false;
      const call = recordPlanOutcome(outcomeDeps(), task(), { critique, revision: 2, decision: "APPROVE", at: AT }).then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(RECORD_EMIT_BUDGET_MS - 100);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await call;
      expect(finished).toBe(true);
    } finally { vi.useRealTimers(); }
    expect(RECORD_EMIT_BUDGET_MS).toBeLessThanOrEqual(2_000);
  });
});

describe("reviewOutcome", () => {
  const review = (role: "CRITIC" | "SECURITY") => ({ operationId: "o", candidateDigest: CANDIDATE, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: AT });
  const published = { candidate: { digest: CANDIDATE }, reviews: [review("CRITIC"), review("SECURITY")], risk: { level: "low", reasons: [], candidateDigest: CANDIDATE } } as unknown as WorkflowSnapshot;

  it("announces the publication with the number of claims it made (all still pending, so none held yet)", async () => {
    const heard = listen();
    await recordPublicationOutcomes(outcomeDeps(), task(), { workflow: published, proof: { verdicts: ["proves_change"], candidateDigest: CANDIDATE }, now: AT });
    expect(heard).toMatchObject([{ kind: "reviewOutcome", taskId: TASK_ID, publicationId: outcomeRoundOf(CANDIDATE), outcome: "published", claims: 4, claimsHeld: 0, visibility: { kind: "shared" }, at: AT }]);
  });

  it("a publication that makes no claim announces nothing", async () => {
    const heard = listen();
    await recordPublicationOutcomes(outcomeDeps(), task(), { workflow: { ...published, reviews: [], risk: undefined }, proof: { unavailable: "not_found" }, now: AT });
    expect(heard).toEqual([]);
  });
});

describe("taskEnded", () => {
  function ended(options: { shared?: boolean; decisions?: Array<{ source: string }>; org?: string } = {}) {
    const fixture = pageTask({ shared: options.shared !== false });
    const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!;
    fixture.db.set({ ...record, workflow: { ...(record as { workflow: object }).workflow, decisions: options.decisions ?? [] } });
    const deps = { documentClient: fixture.db, tableName: "state", now: () => Date.parse(AT) };
    const taskRecord = () => fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as never;
    removers.push(registerTaskEndHandler(recordTaskEndHandler()));
    return { fixture, end: (outcome: Parameters<typeof onTaskEnded>[2]) => onTaskEnded(deps, taskRecord(), outcome, {}, { record: true }) };
  }

  it("a merged task: outcome, rounds and send-backs (a person's and Rovara's own), the task's project and visibility", async () => {
    const heard = listen();
    const { fixture, end } = ended({ decisions: [{ source: "SEND_BACK" }, { source: "AUTO_FIX" }, { source: "AUTO_RETRY" }, { source: "PAGE" }] });
    await expect(end("merged")).resolves.toBe("called");
    expect(heard).toMatchObject([{ kind: "taskEnded", workspaceId: TEST_ORG, project: "payments", taskId: fixture.taskId, outcome: "merged", rounds: 3, sendBacks: 2, visibility: { kind: "shared" }, at: AT }]);
  });

  it.each([["closed", "closed"], ["failed", "failed"], ["cancelled", "cancelled"], ["creator_removed", "cancelled"]] as const)("an end of %s is the record's %s", async (outcome, expected) => {
    const heard = listen();
    await ended().end(outcome);
    expect(heard[0]).toMatchObject({ kind: "taskEnded", outcome: expected, rounds: 1, sendBacks: 0 });
  });

  it("an end that teaches nothing (an agent step that succeeded, a question answered) is not announced", async () => {
    const heard = listen();
    await ended().end("succeeded");
    await ended().end("answered");
    expect(heard).toEqual([]);
  });

  it("a private task is the owner's alone", async () => {
    const heard = listen();
    await ended({ shared: false }).end("merged");
    expect(heard[0]).toMatchObject({ visibility: { kind: "private", ownerDeveloperId: PRIYA.developerId } });
  });

  it("another org's end event for the task announces nothing", async () => {
    const heard = listen();
    const handler = recordTaskEndHandler();
    const fixture = pageTask();
    await handler({ documentClient: fixture.db, tableName: "state", now: () => Date.parse(AT) }, { orgId: "org_zzzzzzzzzzzzzzzzzzzz", taskId: fixture.taskId, outcome: "merged", runLimitUsd: 1, spentUsd: 0 });
    expect(heard).toEqual([]);
  });

  it("a failing listener never fails the end: the end is recorded as told, all handlers", async () => {
    removers.push(registerRovaraRecordListener(async () => { throw new Error("boom"); }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(ended().end("merged")).resolves.toBe("called");
  });
});

describe("visibility", () => {
  it("shared is the project's, private is the owner's, and an unstated or ownerless task is nobody's (fail closed)", () => {
    expect(taskVisibilityOf({ shared: true })).toEqual({ kind: "shared" });
    expect(taskVisibilityOf({ shared: false, developerId: "d".repeat(64), developerName: "Dee", provider: "slack" })).toEqual({ kind: "private", ownerDeveloperId: "d".repeat(64) });
    expect(taskVisibilityOf({})).toBeUndefined();
    expect(taskVisibilityOf({ shared: false })).toBeUndefined();
    // A taker is the owner now, not the creator.
    expect(taskVisibilityOf({ shared: false, developerId: "d".repeat(64), developerName: "Dee", provider: "slack", currentOwner: { developerId: "e".repeat(64), name: "Eve", provider: "slack", since: AT } })).toEqual({ kind: "private", ownerDeveloperId: "e".repeat(64) });
  });
});

// ---- 3. the real runtime's emitter: the rows
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const noSdk = async (): Promise<never> => { throw new SdkUnavailableError(); };
const DEV = "d".repeat(64);
const OWNER = "a".repeat(64);

function recordWorld() {
  const db = new FakeDynamoDb({ indexKeys });
  db.set({ ...githubMemberKey(TEST_ORG, "123"), entityType: "GITHUB_MEMBER", developerId: DEV, orgId: TEST_ORG });
  db.set({ ...developerOrgKey(DEV), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "member" });
  const runtime = createTeamRecordRuntime({ env: { ...ON, TEAM_RECORD_VECTORS_ROLE_ARN: undefined }, documentClient: db, stateTableName: "State", now: () => T0, sdk: noSdk });
  if (runtime === undefined) throw new Error("the runtime was not built");
  installTeamRecordEmitter({ teamRecord: runtime });
  const rows = () => db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
  const addRovaraRow = async (over: Record<string, unknown> = {}) => {
    const result = await putSourceConfig({ documentClient: db, tableName: "TeamRecord" }, {
      workspaceId: TEST_ORG, project: "payments", source: "rovara", scope: "rovara:project/payments", enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: DEV,
      updatedAt: "2026-10-30T10:00:00.000Z", ...over,
    } as never, { edition: "enterprise" });
    expect(result).toMatchObject({ status: "saved" });
  };
  return { db, runtime, rows, addRovaraRow };
}

const base = (visibility: RovaraRecordEvent["visibility"], taskId = TASK_ID) => ({ workspaceId: TEST_ORG, project: "payments", taskId, visibility, at: AT });
const shared = { kind: "shared" } as const;
const privateTo = { kind: "private", ownerDeveloperId: OWNER } as const;

describe("what the emitter writes (the real runtime)", () => {
  it("with no rovara row the default retention applies: structured parts are kept, a note's text is kept as the default allows, and the audience follows the task", async () => {
    const w = recordWorld();
    const send = recordListenerOf(w.runtime.emitter);
    await send({ ...base(shared), kind: "planOutcome", planId: "1", outcome: "plan_approved", claims: 1, claimsHeld: 1 });
    await send({ ...base(shared), kind: "reviewOutcome", publicationId: "abc", outcome: "published", claims: 4, claimsHeld: 0 });
    await send({ ...base(shared), kind: "remembered", noteId: "n1", text: "use the shared retry helper", actorDeveloperId: DEV });
    await send({ ...base(shared), kind: "taskEnded", outcome: "merged", rounds: 2, sendBacks: 1 });
    const stored = w.rows();
    expect(stored.map((row) => row.kind).sort()).toEqual(["rovara.plan", "rovara.remembered", "rovara.review", "rovara.task"]);
    expect(stored.every((row) => row.retention === "C" && (row.audience as { kind: string }).kind === "project" && row.scope === "rovara:project/payments")).toBe(true);
    expect(stored.find((row) => row.kind === "rovara.task")).toMatchObject({ structured: { outcome: "merged", rounds: 2, sendBacks: 1, taskId: TASK_ID } });
    expect(stored.find((row) => row.kind === "rovara.remembered")).toMatchObject({ text: "use the shared retry helper", actor: { developerId: DEV } });
  });

  it("a rovara row applies: retention A keeps the structured parts and drops the note's text; audience maintainers narrows a shared task's rows", async () => {
    const w = recordWorld();
    await w.addRovaraRow({ retention: "A", audienceDefault: "maintainers" });
    const send = recordListenerOf(w.runtime.emitter);
    await send({ ...base(shared), kind: "remembered", noteId: "n1", text: "use the shared retry helper", actorDeveloperId: DEV });
    await send({ ...base(shared), kind: "taskEnded", outcome: "closed", rounds: 1, sendBacks: 0 });
    const stored = w.rows();
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.retention === "A" && row.text === undefined)).toBe(true);
    expect(stored.every((row) => (row.audience as { kind: string; acl?: { groups?: string[] } }).kind === "restricted" && (row.audience as { acl: { groups: string[] } }).acl.groups.includes("project:maintainers"))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("shared retry helper");
  });

  it("a disabled rovara row stops the project's own events", async () => {
    const w = recordWorld();
    await w.addRovaraRow({ enabled: false });
    await recordListenerOf(w.runtime.emitter)({ ...base(shared), kind: "taskEnded", outcome: "merged", rounds: 1, sendBacks: 0 });
    expect(w.rows()).toEqual([]);
  });

  it("a rovara row of another project does not apply to this one's events (they follow the default)", async () => {
    const w = recordWorld();
    await w.addRovaraRow({ project: "other", scope: "rovara:project/other", retention: "A", enabled: false });
    await recordListenerOf(w.runtime.emitter)({ ...base(shared), kind: "taskEnded", outcome: "merged", rounds: 1, sendBacks: 0 });
    expect(w.rows()).toHaveLength(1);
  });

  it("a private task's events are restricted to its owner, whatever the row says, and never project-wide", async () => {
    const w = recordWorld();
    const send = recordListenerOf(w.runtime.emitter);
    await send({ ...base(privateTo), kind: "planOutcome", planId: "1", outcome: "plan_skipped", claims: 1, claimsHeld: 1 });
    await send({ ...base(privateTo), kind: "taskEnded", outcome: "failed", rounds: 1, sendBacks: 0 });
    await w.addRovaraRow({ audienceDefault: "project" });
    await send({ ...base(privateTo, "22222222-2222-4222-8222-222222222222"), kind: "taskEnded", outcome: "failed", rounds: 1, sendBacks: 0 });
    const stored = w.rows();
    expect(stored).toHaveLength(3);
    for (const row of stored) expect(row.audience).toMatchObject({ kind: "restricted", acl: { principals: [OWNER] } });
  });

  it("a rovara row above the default retention still stores a private task's events (the row is looked up by project, not by the task's own place)", async () => {
    const w = recordWorld();
    await w.addRovaraRow({ retention: "D" });
    await recordListenerOf(w.runtime.emitter)({ ...base(privateTo), kind: "taskEnded", outcome: "merged", rounds: 1, sendBacks: 0 });
    expect(w.rows()).toMatchObject([{ retention: "D", kind: "rovara.task" }]);
  });

  it("the hooks reach the record end to end through the installed listener (a plan decision on a shared task)", async () => {
    const w = recordWorld();
    await recordPlanOutcome(outcomeDeps(), task(), { critique, revision: 7, decision: "APPROVE", at: AT });
    expect(w.rows()).toMatchObject([{ kind: "rovara.plan", structured: { outcome: "plan_approved", claims: 1, claimsHeld: 1 } }]);
  });
});
