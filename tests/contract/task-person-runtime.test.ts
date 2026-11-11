import { slackBindingPk } from "@rovara-code/contracts";
import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_OIDC_ISSUER } from "@rovara-code/contracts";
import { describe, expect, it, vi } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { createTaskPersonRuntime, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES, type TaskPersonRuntimePorts } from "../../packages/broker/src/aws/task-person-runtime.js";
import { checkTaskPersonIdentity } from "../../packages/broker/src/developer/task-person-identity.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { TEST_ORG } from "../support/orgs.js";
import { projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";

const taskId = "11111111-1111-4111-8111-111111111111";
const slackUserId = "U0123456789";
const slackTeamId = "T0123456789";
const channelId = "C0123456789";
const nativeDeveloperId = developerIdForSlackUser(slackUserId);

function nativeTask(): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId,
    developerId: nativeDeveloperId, provider: "slack", developerName: "Maya", slackUserId,
    project: "payments-api", share: { teamId: slackTeamId, channelId },
  } as DeveloperTaskRecord;
}

function ports(input: { task?: DeveloperTaskRecord; memberOf?: string[]; developerRecord?: unknown; personRecords?: Record<string, unknown>[] } = {}) {
  const task = input.task ?? nativeTask();
  const readTaskRecord = vi.fn(async ({ sortKey }: { taskId: string; sortKey: string }) => sortKey === "META"
    ? task as unknown as Record<string, unknown>
    : input.personRecords?.find((record) => record.sk === sortKey));
  const readDeveloperRecord = vi.fn<TaskPersonRuntimePorts["readDeveloperRecord"]>(async (request) => {
    void request;
    return input.developerRecord as never;
  });
  const projectAuthorityReader = {
    latestRevision: vi.fn(async (_project: string, _admission: unknown, signal: AbortSignal) => ({
      revision: { ...projectRevisionKey(TEST_ORG, "payments-api", 7), revision: 7, definition: {} }, complete: !signal.aborted,
    })),
    memberships: vi.fn(async (_developerId: string, _admission: unknown, signal: AbortSignal) => ({ items: [], complete: !signal.aborted })),
    bindings: vi.fn(async (_teamId: string, _admission: unknown, signal: AbortSignal) => ({
      items: [{ pk: slackBindingPk(TEST_ORG, slackTeamId), sk: `CHANNEL#${channelId}`, teamId: slackTeamId, channelId, projectName: "payments-api", updatedAt: "2026-01-01T00:00:00.000Z" }], complete: !signal.aborted,
    })),
  };
  const taskPersonProof = vi.fn<TaskPersonRuntimePorts["taskPersonProof"]>(async (request, admission) => {
    void request;
    void admission;
    return {
    result: { ok: true as const, user: { id: slackUserId, teamId: slackTeamId, name: "Maya" }, memberOf: input.memberOf ?? [channelId] },
    slackCallsUsed: 1,
  };
  });
  // Nobody here was removed (no tombstone), and everybody is a member of the company who may write (a member row: owner decision 86, a Slack account is not a membership).
  const readOrgRecord = vi.fn<TaskPersonRuntimePorts["readOrgRecord"]>(async ({ key }) => String(key.sk).startsWith("MEMBER#") ? { ...key, role: "member" } : undefined);
  return { readTaskRecord, readDeveloperRecord, readOrgRecord, projectAuthorityReader, taskPersonProof } as unknown as TaskPersonRuntimePorts & {
    readTaskRecord: typeof readTaskRecord;
    readDeveloperRecord: typeof readDeveloperRecord;
    readOrgRecord: typeof readOrgRecord;
    projectAuthorityReader: typeof projectAuthorityReader;
    taskPersonProof: typeof taskPersonProof;
  };
}

const runtime = (admission: ReturnType<typeof createTaskAuthorityAdmission>, testPorts: TaskPersonRuntimePorts) => createTaskPersonRuntime({ orgId: TEST_ORG,
  admission, ports: testPorts, stateTableName: "state", slackTeamId, now: () => 1_000,
  uuid: () => "22222222-2222-4222-8222-222222222222",
});

describe("task person runtime factory", () => {
  it("checks a native person with fresh bounded proof and project authority", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = runtime(admission, injected);

    await expect(checker.checkTaskPerson(nativeTask(), nativeDeveloperId)).resolves.toMatchObject({
      eligible: true,
      identity: { developerId: nativeDeveloperId, method: "slack", slackUserId },
    });

    expect(injected.readTaskRecord.mock.calls.map(([request]) => request.sortKey)).toEqual(["META", `PERSON_SUBJECT#${nativeDeveloperId}`]);
    // One sign-in row read: the membership check follows the person's merges (none here) to the member record of the survivor.
    expect(injected.readDeveloperRecord.mock.calls).toHaveLength(1);
    expect(injected.readDeveloperRecord.mock.calls[0]?.[0].developerId).toBe(nativeDeveloperId);
    expect(injected.taskPersonProof.mock.calls).toEqual([[
      { kind: "task-person-proof", slackUserId, channelIds: [channelId] }, admission,
    ]]);
    expect(admission.remainingSlackCalls()).toBe(99);
  });

  it("keeps one proof admission binding stable across repeated owner checks", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = runtime(admission, injected);
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);

    expect(injected.taskPersonProof.mock.calls).toHaveLength(2);
    expect(injected.taskPersonProof.mock.calls[0]?.[1].id).toBe(admission.id);
    expect(injected.taskPersonProof.mock.calls[1]?.[1].id).toBe(admission.id);
    expect(admission.remainingSlackCalls()).toBe(98);
  });

  it("exposes a keyed positive State witness only after a fresh final project revision read", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = runtime(admission, injected);
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);

    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toMatchObject({
      taskId, developerId: nativeDeveloperId, project: "payments-api", access: "channel",
      projectRevision: { ...projectRevisionKey(TEST_ORG, "payments-api", 7), revision: 7, developerTasksPresent: false },
      binding: { pk: slackBindingPk(TEST_ORG, slackTeamId), sk: `CHANNEL#${channelId}`, teamId: slackTeamId, channelId, projectName: "payments-api" },
    });
    expect(injected.projectAuthorityReader.latestRevision.mock.calls).toHaveLength(2);

    injected.projectAuthorityReader.latestRevision.mockImplementationOnce(async () => ({
      revision: { ...projectRevisionKey(TEST_ORG, "payments-api", 8), revision: 8, definition: {} }, complete: true,
    }));
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();

    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    injected.projectAuthorityReader.latestRevision.mockImplementationOnce(async () => ({
      revision: { ...projectRevisionKey(TEST_ORG, "payments-api", 7), revision: 7, definition: { developerTasks: { enabled: false } } }, complete: true,
    }));
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();
  });

  it("refuses a missing or mismatched current-owner witness", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const checker = runtime(admission, ports());
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();
    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey("b".repeat(64), taskId))).resolves.toBeUndefined();
  });

  it("keeps target eligibility separate from the in-channel Owner witness", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports({ memberOf: [] });
    injected.projectAuthorityReader.memberships.mockResolvedValue({
      items: [{ ...projectMemberKey(TEST_ORG, nativeDeveloperId, "payments-api"), projectName: "payments-api", role: "developer" }] as never,
      complete: true,
    });
    const checker = runtime(admission, injected);
    const eligibility = await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);
    expect(eligibility).toMatchObject({ eligible: true, channelMember: false });
    await expect(checker.stateAuthorityWitnessForOwnerActor(nativeTask(), taskOwnerKey(nativeDeveloperId, taskId))).resolves.toBeUndefined();

    await expect(checker.stateAuthorityWitnessForEligiblePerson(nativeTask(), nativeDeveloperId)).resolves.toMatchObject({
      taskId, developerId: nativeDeveloperId, project: "payments-api", access: "granted",
      membership: { ...projectMemberKey(TEST_ORG, nativeDeveloperId, "payments-api"), projectName: "payments-api", role: "developer" },
      projectRevision: { ...projectRevisionKey(TEST_ORG, "payments-api", 7), revision: 7, developerTasksPresent: false },
    });
  });

  it.each(["project revision", "developer grant", "channel binding"] as const)("refuses a positive authority read with missing %s State keys", async (missing) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    if (missing === "project revision") {
      injected.projectAuthorityReader.latestRevision.mockResolvedValueOnce({
        revision: { revision: 7, definition: {} }, complete: true,
      } as never);
    } else if (missing === "developer grant") {
      injected.projectAuthorityReader.memberships.mockResolvedValueOnce({
        items: [{ projectName: "payments-api", role: "developer" }], complete: true,
      } as never);
    } else {
      injected.projectAuthorityReader.bindings.mockResolvedValue({
        items: [{ teamId: slackTeamId, channelId, projectName: "payments-api", updatedAt: "2026-01-01T00:00:00.000Z" }], complete: true,
      } as never);
    }
    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it.each(["tasks-disabled", "not-found"] as const)("does not qualify %s project authority as definite identity loss", async (mode) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    if (mode === "not-found") {
      injected.projectAuthorityReader.latestRevision.mockResolvedValue({ revision: undefined, complete: true } as never);
    } else {
      injected.projectAuthorityReader.latestRevision.mockResolvedValue({
        revision: { ...projectRevisionKey(TEST_ORG, "payments-api", 7), revision: 7, definition: { developerTasks: { enabled: false, channelMembersMayUse: true } } }, complete: true,
      });
    }

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("does not call the injected proof when Slack allowance is exhausted", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    admission.recordSlackUsage(100);
    const injected = ports();

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
  });

  it.each([
    ["eligible", { ok: true, user: { id: slackUserId, teamId: slackTeamId, name: "Maya" }, memberOf: [channelId] }],
    ["definitely ineligible", { ok: false, error: "ineligible" }],
  ] as const)("rejects a %s proof with impossible zero measured Slack calls", async (_name, result) => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    injected.taskPersonProof.mockImplementation(async () => ({ result, slackCallsUsed: 0 }) as never);

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("reads a person row only after its reverse subject row links that person", async () => {
    const personId = "22222222-2222-4222-8222-222222222222";
    const createdAt = "2026-01-01T00:00:00.000Z";
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports({ personRecords: [
      {
        pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${nativeDeveloperId}`, schemaVersion: 1,
        personId, developerId: nativeDeveloperId, createdAt,
      },
      {
        pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1,
        personId, developerId: nativeDeveloperId, slackUserId, name: "Maya", method: "slack",
        issuer: SLACK_OIDC_ISSUER, subject: slackUserId, createdAt,
      },
    ] });

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).resolves.toMatchObject({ eligible: true });

    expect(injected.readTaskRecord.mock.calls.map(([request]) => request.sortKey)).toEqual([
      "META", `PERSON_SUBJECT#${nativeDeveloperId}`, `PERSON#${personId}`, `PERSON_SUBJECT#${nativeDeveloperId}`,
    ]);
  });

  it("projects only the approved Developer fields for an external principal", async () => {
    const issuer = "https://identity.example.com";
    const subject = "subject-123";
    const externalDeveloperId = ownerKeyForSubject(issuer, subject);
    const task = { ...nativeTask(), developerId: externalDeveloperId, provider: "oidc" } as DeveloperTaskRecord;
    const record = {
      pk: `DEVELOPER#${externalDeveloperId}`, sk: "META", developerId: externalDeveloperId,
      provider: "oidc", issuer, subject, slackUserId, revoked: false, displayName: "Maya", email: "ignored@example.com",
    };
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports({ task, developerRecord: record });
    const checkIdentity = vi.fn(async (dependencies: Parameters<typeof checkTaskPersonIdentity>[0], checkedTask: DeveloperTaskRecord, checkedDeveloperId: string) => {
      const projected = await dependencies.developerRecord(checkedDeveloperId);
      expect(projected).not.toHaveProperty("email");
      return checkTaskPersonIdentity(dependencies, checkedTask, checkedDeveloperId);
    });
    const checker = createTaskPersonRuntime({ orgId: TEST_ORG,
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000,
      uuid: () => "22222222-2222-4222-8222-222222222222", checkIdentity,
    });

    await expect(checker.checkTaskPerson(task, externalDeveloperId)).resolves.toMatchObject({
      eligible: true,
      identity: { developerId: externalDeveloperId, method: "oidc", issuer, subject, slackUserId },
    });

    const developerReads = injected.readDeveloperRecord.mock.calls;
    // The check reads the person's row for the identity (twice) and once for the status, and the membership check's walk once more.
    expect(developerReads).toHaveLength(4);
    expect(developerReads[0]?.[0]).toMatchObject({
      developerId: externalDeveloperId,
      consistentRead: true,
      projection: TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES,
    });
    expect(developerReads[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("refuses arbitrary row commands and Scan before any State read", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = createTaskPersonRuntime({ orgId: TEST_ORG,
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000,
      uuid: () => "22222222-2222-4222-8222-222222222222",
      checkIdentity: async (dependencies) => {
        await dependencies.documentClient.send(new ScanCommand({ TableName: "state" }));
        return undefined as never;
      },
    });

    await expect(checker.checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.readTaskRecord.mock.calls).toHaveLength(0);
  });

  it("reads no sign-in row or member row of anyone but the person and the people their rows say they were merged into", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const stranger = "e".repeat(64);
    const checker = createTaskPersonRuntime({ orgId: TEST_ORG,
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000,
      uuid: () => "22222222-2222-4222-8222-222222222222",
      checkIdentity: async (dependencies) => {
        await expect(dependencies.developerRecord(stranger)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
        await expect(dependencies.documentClient.send(new GetCommand({
          TableName: "state", Key: { pk: `ORG#${TEST_ORG}`, sk: `MEMBER#${stranger}` }, ConsistentRead: true,
        }))).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
        return { eligible: false } as never;
      },
    });

    await checker.checkTaskPerson(nativeTask(), nativeDeveloperId);

    expect(injected.readDeveloperRecord.mock.calls).toHaveLength(0);
    expect(injected.readOrgRecord.mock.calls).toHaveLength(0);
  });

  it("refuses an unlinked PERSON row before issuing a State read", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();
    const checker = createTaskPersonRuntime({ orgId: TEST_ORG,
      admission, ports: injected, stateTableName: "state", slackTeamId, now: () => 1_000,
      uuid: () => "22222222-2222-4222-8222-222222222222",
      checkIdentity: async (dependencies) => {
        await dependencies.documentClient.send(new GetCommand({
          TableName: "state", Key: { pk: `DEVTASK#${taskId}`, sk: "PERSON#22222222-2222-4222-8222-222222222222" }, ConsistentRead: true,
        }));
        return undefined as never;
      },
    });

    await expect(checker.checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(injected.readTaskRecord.mock.calls).toHaveLength(0);
  });

  describe("on an install with no Slack team (decision 86: a web or GitHub sign-in company)", () => {
    const issuer = "https://github.com";
    const subject = "nia-12345";
    const niaId = ownerKeyForSubject(issuer, subject);
    const githubTask = () => ({ ...nativeTask(), developerId: niaId, provider: "github", slackUserId: undefined, developerName: "Nia" }) as unknown as DeveloperTaskRecord;
    const githubRecord = { pk: `DEVELOPER#${niaId}`, sk: "META", developerId: niaId, provider: "github", issuer, subject, revoked: false, displayName: "Nia" };
    const noSlack = (admission: ReturnType<typeof createTaskAuthorityAdmission>, testPorts: TaskPersonRuntimePorts, team = "") => createTaskPersonRuntime({ orgId: TEST_ORG,
      admission, ports: testPorts, stateTableName: "state", slackTeamId: team, now: () => 1_000, uuid: () => "22222222-2222-4222-8222-222222222222" });
    const grantPorts = () => {
      const injected = ports({ task: githubTask(), developerRecord: githubRecord });
      injected.projectAuthorityReader.memberships.mockImplementation(async (_developerId: string, _admission: unknown, signal: AbortSignal) => ({
        items: [{ ...projectMemberKey(TEST_ORG, niaId, "payments-api"), projectName: "payments-api", role: "developer" }] as never, complete: !signal.aborted }));
      return injected;
    };

    it("qualifies a person with no Slack account: a witness on their grant, no Slack proof, no channel bindings read", async () => {
      const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
      const injected = grantPorts();
      const checker = noSlack(admission, injected);

      await expect(checker.checkTaskPerson(githubTask(), niaId)).resolves.toMatchObject({ eligible: true, channelMember: true, identity: { developerId: niaId, method: "github" } });

      expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
      expect(injected.projectAuthorityReader.bindings.mock.calls).toHaveLength(0);
      await expect(checker.stateAuthorityWitnessForOwnerActor(githubTask(), taskOwnerKey(niaId, taskId))).resolves.toMatchObject({
        taskId, developerId: niaId, access: "granted", membership: { role: "developer", projectName: "payments-api" },
      });
    });

    it("a team id that is set but is not one still fails closed", async () => {
      const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
      await expect(noSlack(admission, grantPorts(), "not-a-team").checkTaskPerson(githubTask(), niaId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    });

    it("a person with a Slack account cannot be proved without a team: unavailable, no proof call", async () => {
      const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
      const injected = ports();
      await expect(noSlack(admission, injected).checkTaskPerson(nativeTask(), nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
      expect(injected.taskPersonProof.mock.calls).toHaveLength(0);
    });

    it("reads only the person's own sign-in row and the member rows of the people it says they were merged into", async () => {
      const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
      const survivor = "9".repeat(64);
      const injected = ports({ developerRecord: { pk: `DEVELOPER#${nativeDeveloperId}`, sk: "META", developerId: nativeDeveloperId, provider: "slack", issuer: "https://slack.com", subject: slackUserId, slackUserId, mergedInto: survivor } });
      // (The survivor has a member row here, so the person is a member through them.)
      await expect(noSlack(admission, injected, slackTeamId).checkTaskPerson(nativeTask(), nativeDeveloperId)).resolves.toMatchObject({ eligible: true });
      expect(injected.readDeveloperRecord.mock.calls.map(([request]) => request.developerId)).toEqual([nativeDeveloperId, survivor]);
      const keys = injected.readOrgRecord.mock.calls.map(([request]) => request.key.sk);
      expect([...new Set(keys)]).toEqual([`MEMBER#${nativeDeveloperId}`, `MEMBER#${survivor}`]);
    });

    it("a taker who is a company auditor has no project witness, whatever grant they hold", async () => {
      const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
      const injected = grantPorts();
      injected.readOrgRecord.mockImplementation(async ({ key }) => String(key.sk).startsWith("MEMBER#") ? { ...key, role: "auditor" } : undefined);
      const taken = { ...githubTask(), currentOwner: { developerId: niaId, name: "Nia", provider: "github", since: "2026-10-22T11:00:00.000Z" } } as unknown as DeveloperTaskRecord;
      await expect(noSlack(admission, injected).projectAuthorityWitnessForOwner(taken)).resolves.toBeUndefined();
    });
  });

  it("rejects an invalid developer identity before calling injected State ports", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const injected = ports();

    await expect(runtime(admission, injected).checkTaskPerson(nativeTask(), "invalid")).rejects.toThrow();
    expect(injected.readTaskRecord.mock.calls).toHaveLength(0);
    expect(admission.checkedIdentityCount()).toBe(0);
  });
});
