// wire-team-record: the existing delete paths reach the Team record: a person's erase (with the v1.2 learning walk), a project's archive, and a send-back (the Rovara emitter). With the record off
// (`teamRecord` absent) each path is exactly what it was.
import { afterEach, describe, expect, it } from "vitest";
import { learningEraseHook, learningWalkDeps } from "../../../packages/broker/src/learning/cleanup.js";
import { clearArchivedProjectLearning } from "../../../packages/broker/src/aws/developer-routes/project-archive-setup.js";
import { announceHumanSendBack, sendBackToRecord } from "../../../packages/broker/src/lessons/send-back-events.js";
import { installTeamRecordEmitter, teamRecordEmitterInstalled, uninstallTeamRecordEmitter } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A } from "../../support/team-record-core.js";

afterEach(() => { uninstallTeamRecordEmitter(); });
const DEV = "d".repeat(64);

describe("a person's erase", () => {
  const deps = () => learningWalkDeps({ documentClient: new FakeDynamoDb(), tableName: "State", now: () => Date.parse("2026-10-30T12:00:00Z") });

  it("runs the record's erase after the learning walk finished, with the org and the person", async () => {
    const calls: string[][] = [];
    await learningEraseHook(deps(), undefined, async (orgId, developerId) => { calls.push([orgId, developerId]); })(ORG_A, DEV);
    expect(calls).toStrictEqual([[ORG_A, DEV]]);
  });

  it("fails the request when the record's erase does not finish, so the request is repeated; and does nothing extra when the record is off", async () => {
    await expect(learningEraseHook(deps(), undefined, async () => { throw Object.assign(new Error("x"), { name: "TeamRecordUnfinished" }); })(ORG_A, DEV)).rejects.toThrow();
    await expect(learningEraseHook(deps())(ORG_A, DEV)).resolves.toBeUndefined();
  });
});

describe("a project's archive", () => {
  const base = { documentClient: new FakeDynamoDb(), tableName: "State", now: () => Date.parse("2026-10-30T12:00:00Z") };

  it("erases the project's record, scoped to the org and project that were archived", async () => {
    const calls: unknown[][] = [];
    const teamRecord = { erase: { project: async (...args: unknown[]) => { calls.push(args); } } };
    await clearArchivedProjectLearning({ ...base, teamRecord: teamRecord as never }, ORG_A, "web");
    expect(calls).toStrictEqual([[ORG_A, "web", "project_archived"]]);
  });

  it("never fails the archive when the record's erase fails, and does nothing when the record is off", async () => {
    const teamRecord = { erase: { project: async () => { throw new Error("storage detail"); } } };
    await expect(clearArchivedProjectLearning({ ...base, teamRecord: teamRecord as never }, ORG_A, "web")).resolves.toBeUndefined();
    await expect(clearArchivedProjectLearning(base, ORG_A, "web")).resolves.toBeUndefined();
  });
});

describe("a human send-back", () => {
  const event = { workspaceId: ORG_A, project: "web", taskId: "t1", requestId: "r1", actorDeveloperId: DEV, instructions: "use withRetry", round: 1, shared: true, ownerDeveloperId: DEV, at: "2026-10-30T10:00:00.000Z" };

  it("is written to the record through the Rovara emitter, naming the person, once the record is on; and by nobody when it is off", async () => {
    const sent: unknown[] = [];
    const asked: unknown[] = [];
    // Who may read the row is the task's Plan 5 visibility, read from the runtime when the row is written; the event's own `shared` (the Slack-channel flag) is not it.
    const teamRecord = { emitter: { sendBack: async (input: unknown) => { sent.push(input); } }, taskVisibility: async (orgId: string, taskId: string) => { asked.push([orgId, taskId]); return { kind: "shared_with", developerIds: [DEV, "e".repeat(64)] }; } };
    installTeamRecordEmitter({ teamRecord: teamRecord as never });
    await announceHumanSendBack(event);
    expect(sent).toHaveLength(1);
    expect(asked).toEqual([[ORG_A, "t1"]]);
    expect(sent[0]).toMatchObject({ workspaceId: ORG_A, project: "web", taskId: "t1", origin: "human", actorDeveloperId: DEV, visibility: { kind: "shared_with", developerIds: [DEV, "e".repeat(64)] } });
    uninstallTeamRecordEmitter();
    await announceHumanSendBack(event);
    expect(sent).toHaveLength(1);
  });

  it("with no visibility reader the row is the owner's alone, whatever the event's Slack-channel flag says; a task the reader cannot place is not written", async () => {
    const sent: unknown[] = [];
    const emitter = { sendBack: async (input: unknown) => { sent.push(input); } };
    await sendBackToRecord(emitter)(event);
    expect(sent[0]).toMatchObject({ visibility: { kind: "private", ownerDeveloperId: DEV } });
    await sendBackToRecord(emitter, async () => undefined)(event);
    expect(sent).toHaveLength(1);
  });

  it("registers no listener at all while the record is off", () => {
    installTeamRecordEmitter({ teamRecord: undefined });
    expect(teamRecordEmitterInstalled()).toBe(false);
    installTeamRecordEmitter({ teamRecord: { emitter: { sendBack: async () => undefined } } as never });
    expect(teamRecordEmitterInstalled()).toBe(true);
    uninstallTeamRecordEmitter();
    expect(teamRecordEmitterInstalled()).toBe(false);
  });

  it("follows the latest broker: a broker without the record writes nothing", async () => {
    const sent: unknown[] = [];
    installTeamRecordEmitter({ teamRecord: { emitter: { sendBack: async (input: unknown) => { sent.push(input); } } } as never });
    installTeamRecordEmitter({ teamRecord: undefined });
    await announceHumanSendBack(event);
    expect(sent).toStrictEqual([]);
  });
});
