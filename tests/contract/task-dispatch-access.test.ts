import { slackBindingPk } from "../../packages/contracts/src/org-scoped-keys.js";
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { agentXError, type OrgId } from "../../packages/contracts/src/index.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { guardTaskDispatch, isTaskDispatchGuardRetryError, resumeTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { ProjectAuthorityWitness } from "../../packages/broker/src/developer/task-project-access.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { projectMemberKey, projectRevisionKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { orgMemberKey } from "../../packages/contracts/src/org-node.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "a".repeat(64);
const OWNER_SLACK = "U0OWNER001";

function task(): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID,
    developerId: OWNER, provider: "slack", developerName: "Avery", slackUserId: OWNER_SLACK,
    client: "slack", project: "payments", title: "Payments", workspaceId: WORKSPACE_ID,
    ownerKey: "f".repeat(64), conversationId: randomUUID(), startingRevision: 1,
    charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
    shared: true, share: { teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", mode: "view", sharedReason: "requested", sharedAt: "2026-10-11T10:00:00.000Z" },
    createdAt: "2026-10-11T10:00:00.000Z", updatedAt: "2026-10-11T10:00:00.000Z",
    workflow: { revision: 7, stage: "IMPLEMENT", state: "RUNNING" } as never,
  };
}

function record(): Ec2OutboxRecord {
  const operationId = randomUUID();
  return {
    id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: WORKSPACE_ID, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "task", operationId, workspaceId: WORKSPACE_ID, fence: 4, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "continue", conversationStarted: true } },
  };
}

function harness(withPeople = true) {
  const db = new FakeDynamoDb();
  const current = task();
  const outbox = record();
  db.set(current as unknown as Record<string, unknown>);
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID, developerId: OWNER });
  db.set({ pk: `OUTBOX#${outbox.id}`, sk: "OUTBOX", ...outbox });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: `OPERATION#${outbox.operationId}`, status: "DISPATCHING", fence: 4 });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "META", status: "BUSY", activeOperationId: outbox.operationId, fence: 4 });
  if (withPeople) db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false,
    people: [{ developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "owner" }] });
  const checkTaskPerson = vi.fn(async () => ({
    subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
    identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
    eligible: true, channelMember: true,
  }));
  return { db, current, outbox, checkTaskPerson };
}

describe("task dispatch access", () => {
  it("classifies only rejected core guard decisions as retryable and preserves the original failure", async () => {
    const original = agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
    const guard = guardTaskDispatch({ documentClient: { async send() { throw original; } }, tableName: "state" }, record());
    let caught: unknown;
    try { await guard; } catch (error) { caught = error; }
    expect(isTaskDispatchGuardRetryError(caught)).toBe(true);
    expect(caught).toMatchObject({ name: "TaskDispatchGuardRetryError", message: original.message, code: original.code, cause: original });
    expect(isTaskDispatchGuardRetryError(agentXError("RUNTIME_UNAVAILABLE", original.message))).toBe(false);
  });

  it.each(["deleted", "downgraded"] as const)("requalifies after the sole developer grant is %s before the final State fence", async (change) => {
    const h = harness();
    const revision = {
      ...projectRevisionKey(TEST_ORG, "payments", 7),
      definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: false } },
    };
    const membership = { ...projectMemberKey(TEST_ORG, OWNER, "payments"), projectName: "payments", role: "developer" };
    h.db.set(revision);
    h.db.set(membership);
    h.checkTaskPerson.mockImplementationOnce(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: true, channelMember: true,
    })).mockImplementation(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: false, channelMember: true,
    }));
    let changed = false;
    const documentClient = {
      async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        void options;
        if (!changed && command instanceof TransactWriteCommand) {
          const input = command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> };
          if (input.TransactItems?.some((item) => item.ConditionCheck?.Key?.pk === membership.pk && item.ConditionCheck.Key.sk === membership.sk)) {
            changed = true;
            if (change === "deleted") h.db.delete(membership.pk, membership.sk);
            else h.db.set({ ...membership, role: "administrator" });
          }
        }
        return h.db.send(command as never);
      },
    };
    const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted",
      projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
      membership: { pk: membership.pk, sk: membership.sk, projectName: "payments", role: "developer" },
    };
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
    }, h.outbox)).resolves.toBe("PARKED");
    expect(changed).toBe(true);
    expect(h.checkTaskPerson).toHaveBeenCalledTimes(2);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it.each(["binding", "policy"] as const)("requalifies after the qualifying channel %s changes before the final State fence", async (changedWitness) => {
    const h = harness();
    const revision = {
      ...projectRevisionKey(TEST_ORG, "payments", 7),
      definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: true } },
    };
    const binding = { pk: slackBindingPk(TEST_ORG, "T0PEOPLE1"), sk: "CHANNEL#C0PEOPLE1", teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", projectName: "payments", updatedAt: "2026-10-11T10:00:00.000Z" };
    h.db.set(revision);
    h.db.set(binding);
    h.checkTaskPerson.mockImplementationOnce(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: true, channelMember: true,
    })).mockImplementation(async () => ({
      subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
      identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
      eligible: false, channelMember: true,
    }));
    let changed = false;
    const documentClient = {
      async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        void options;
        if (!changed && command instanceof TransactWriteCommand) {
          const input = command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> };
          const pk = changedWitness === "binding" ? binding.pk : revision.pk;
          const sk = changedWitness === "binding" ? binding.sk : revision.sk;
          if (input.TransactItems?.some((item) => item.ConditionCheck?.Key?.pk === pk && item.ConditionCheck.Key.sk === sk)) {
            changed = true;
            if (changedWitness === "binding") h.db.set({ ...binding, updatedAt: "2026-10-12T10:00:00.000Z" });
            else h.db.set({ ...revision, definition: { ...revision.definition, developerTasks: { enabled: true, channelMembersMayUse: false } } });
          }
        }
        return h.db.send(command as never);
      },
    };
    const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "channel",
      projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
      binding,
    };
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
    }, h.outbox)).resolves.toBe("PARKED");
    expect(changed).toBe(true);
    expect(h.checkTaskPerson).toHaveBeenCalledTimes(2);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  describe("an org owner or admin with no grant (final review I1)", () => {
    const seeded = () => {
      const h = harness();
      const revision = { ...projectRevisionKey(TEST_ORG, "payments", 7), definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: false } } };
      const orgMember = { ...orgMemberKey(TEST_ORG, OWNER), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: OWNER, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" };
      h.db.set(revision);
      h.db.set(orgMember);
      const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
        taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted",
        projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
        orgMember: { pk: orgMember.pk, sk: orgMember.sk, role: "owner" },
      };
      return { h, orgMember, witness };
    };

    it("allows the dispatch while the org member row still holds the owner or admin role", async () => {
      const { h, witness } = seeded();
      await expect(guardTaskDispatch({
        documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson,
        stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
      }, h.outbox)).resolves.toBe("ALLOWED");
    });

    it.each(["demoted", "removed"] as const)("requalifies after the person is %s before the final State fence", async (change) => {
      const { h, orgMember, witness } = seeded();
      h.checkTaskPerson.mockImplementationOnce(async () => ({
        subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
        identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
        eligible: true, channelMember: true,
      })).mockImplementation(async () => ({
        subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
        identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
        eligible: false, channelMember: true,
      }));
      let changed = false;
      const documentClient = {
        async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
          void options;
          if (!changed && command instanceof TransactWriteCommand) {
            const input = command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> };
            if (input.TransactItems?.some((item) => item.ConditionCheck?.Key?.pk === orgMember.pk && item.ConditionCheck.Key.sk === orgMember.sk)) {
              changed = true;
              if (change === "removed") h.db.delete(orgMember.pk, orgMember.sk);
              else h.db.set({ ...orgMember, role: "member" });
            }
          }
          return h.db.send(command as never);
        },
      };
      await expect(guardTaskDispatch({
        documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
        stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
      }, h.outbox)).resolves.toBe("PARKED");
      expect(changed).toBe(true);
      expect(h.checkTaskPerson).toHaveBeenCalledTimes(2);
    });

    it("refuses an org member witness keyed to another developer or org", async () => {
      const { h, witness } = seeded();
      const stolen = { ...witness, orgMember: { ...orgMemberKey(TEST_ORG, "b".repeat(64)), role: "owner" as const } };
      await expect(guardTaskDispatch({
        documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson,
        stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? stolen : undefined,
      }, h.outbox)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    });
  });

  it("parks without demoting the owner when the final authority query is unavailable", async () => {
    const h = harness();
    await expect(guardTaskDispatch({
      documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async () => { throw new Error("project query unavailable"); },
    }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")?.people).toEqual([
      { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "owner" },
    ]);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it("requalifies through current channel policy after a direct developer grant is removed", async () => {
    const h = harness();
    const revision = {
      ...projectRevisionKey(TEST_ORG, "payments", 7),
      definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: true } },
    };
    const membership = { ...projectMemberKey(TEST_ORG, OWNER, "payments"), projectName: "payments", role: "developer" };
    const binding = { pk: slackBindingPk(TEST_ORG, "T0PEOPLE1"), sk: "CHANNEL#C0PEOPLE1", teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", projectName: "payments", updatedAt: "2026-10-11T10:00:00.000Z" };
    h.db.set(revision);
    h.db.set(membership);
    h.db.set(binding);
    let grantRemoved = false;
    const documentClient = {
      async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        void options;
        if (!grantRemoved && command instanceof TransactWriteCommand) {
          const input = command.input as { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> };
          if (input.TransactItems?.some((item) => item.ConditionCheck?.Key?.pk === membership.pk && item.ConditionCheck.Key.sk === membership.sk)) {
            grantRemoved = true;
            h.db.delete(membership.pk, membership.sk);
          }
        }
        return h.db.send(command as never);
      },
    };
    const projectRevision = { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks };
    const directWitness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted", projectRevision,
      membership: { pk: membership.pk, sk: membership.sk, projectName: "payments", role: "developer" },
    };
    const channelWitness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
      taskId: TASK_ID, developerId: OWNER, project: "payments", access: "channel", projectRevision, binding,
    };
    let witnessReads = 0;
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId !== taskOwnerKey(OWNER, TASK_ID)
        ? undefined : (witnessReads++ === 0 ? directWitness : channelWitness),
    }, h.outbox)).resolves.toBe("ALLOWED");
    expect(grantRemoved).toBe(true);
    expect(witnessReads).toBe(2);
  });

  describe("a task that names its own org (Task 3 fix round 1)", () => {
    const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
    const seeded = (witnessOrg: OrgId) => {
      const h = harness();
      h.db.set({ ...h.current, orgId: ORG_B });
      const revision = { ...projectRevisionKey(witnessOrg, "payments", 7), definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: true } } };
      const membership = { ...projectMemberKey(witnessOrg, OWNER, "payments"), projectName: "payments", role: "developer" };
      h.db.set(revision);
      h.db.set(membership);
      const witness: ProjectAuthorityWitness & { taskId: string; developerId: string; project: string } = {
        taskId: TASK_ID, developerId: OWNER, project: "payments", access: "granted",
        projectRevision: { pk: revision.pk, sk: revision.sk, revision: 7, developerTasksPresent: true, developerTasks: revision.definition.developerTasks },
        membership: { pk: membership.pk, sk: membership.sk, projectName: "payments", role: "developer" },
      };
      return { h, witness };
    };

    it("allows a witness in the task's org although the guard's own org is another", async () => {
      const { h, witness } = seeded(ORG_B);
      await expect(guardTaskDispatch({
        documentClient: h.db, tableName: "state", orgId: TEST_ORG, checkTaskPerson: h.checkTaskPerson,
        stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
      }, h.outbox)).resolves.toBe("ALLOWED");
    });

    it("refuses a witness in the guard's org when the task names another", async () => {
      const { h, witness } = seeded(TEST_ORG);
      await expect(guardTaskDispatch({
        documentClient: h.db, tableName: "state", orgId: TEST_ORG, checkTaskPerson: h.checkTaskPerson,
        stateAuthorityWitnessForOwnerActor: async (_task, actorId) => actorId === taskOwnerKey(OWNER, TASK_ID) ? witness : undefined,
      }, h.outbox)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    });
  });

  it("leaves legacy work without a PEOPLE sidecar unchanged", async () => {
    const h = harness(false);
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).resolves.toBe("ALLOWED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("keeps terminal cleanup independent when a PEOPLE task is ownerless", async () => {
    const h = harness();
    const cleanup = { ...h.outbox, invocation: { ...h.outbox.invocation, kind: "close", payload: {} } } as Ec2OutboxRecord;
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, cleanup)).resolves.toBe("ALLOWED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("retries instead of acknowledging when a task pointer cannot be verified", async () => {
    const h = harness();
    h.db.delete(`DEVTASK#${TASK_ID}`, "META");
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).rejects.toThrow(/could not be verified/);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("allows a freshly qualified effective owner without storing an allow receipt", async () => {
    const h = harness();
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("ALLOWED");
    expect(h.checkTaskPerson).toHaveBeenCalledWith(h.current, OWNER, undefined);
    expect(h.db.find((item) => String(item.sk).includes("TASK_ACCESS"))).toEqual([]);
  });

  it("counts every guard GetItem against the single shared authority admission", async () => {
    const h = harness();
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson, admission }, h.outbox)).resolves.toBe("ALLOWED");
    expect(admission.remainingStateReads()).toBe(124);
  });

  it("refuses a positive proof whose PEOPLE revision changes before acceptance", async () => {
    const h = harness();
    h.checkTaskPerson.mockImplementation(async () => {
      h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: true,
        people: [{ developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "denied" }] });
      return {
        subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
        identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
        eligible: true, channelMember: true,
      };
    });

    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
  });

  it("refuses ALLOWED when the shared admission expires during proof before the final State fence", async () => {
    const h = harness();
    let now = 1_000;
    const admission = createTaskAuthorityAdmission({ now: () => now, lambdaRemainingMs: 20_000 });
    h.checkTaskPerson.mockImplementation(async () => {
      now = admission.deadlineAt;
      return {
        subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
        identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
        eligible: true, channelMember: true,
      };
    });

    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson, admission }, h.outbox))
      .rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
  });

  it("retries rather than acknowledging if the pause reserve is exhausted", async () => {
    const h = harness();
    h.checkTaskPerson.mockResolvedValue({ ...(await h.checkTaskPerson()), eligible: false, channelMember: false });

    await expect(guardTaskDispatch({
      documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson, remainingTimeMs: () => 2_000,
    }, h.outbox)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
  });

  it("acknowledges as closed, without retry, pause or write, a terminal workflow that still awaits its closedAt write", async () => {
    const h = harness();
    h.db.set({ ...h.current, workflow: { revision: 8, stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED" } });

    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("CLOSED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
    expect(h.checkTaskPerson).not.toHaveBeenCalled();
  });

  it("acknowledges as closed a task that was closed (closedAt) after the message was queued", async () => {
    const h = harness();
    h.db.set({ ...h.current, closedAt: "2026-10-11T11:00:00.000Z" });
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("CLOSED");
    expect(h.checkTaskPerson).not.toHaveBeenCalled();
  });

  describe("a race while the access is verified", () => {
    /** Runs `change` just before the Nth final State fence (the TransactWrite), so the fence sees what changed. */
    function racing(h: ReturnType<typeof harness>, change: (fence: number) => void) {
      let fences = 0;
      const transactions = vi.fn();
      return {
        transactions,
        documentClient: {
          async send(command: unknown): Promise<unknown> {
            if (command instanceof TransactWriteCommand) { fences += 1; transactions(); change(fences); }
            return h.db.send(command as never);
          },
        },
      };
    }
    const reviseTask = (h: ReturnType<typeof harness>) => h.db.set({ ...h.db.get(`DEVTASK#${TASK_ID}`, "META")!, workflow: { revision: Number((h.db.get(`DEVTASK#${TASK_ID}`, "META") as { workflow: { revision: number } }).workflow.revision) + 1, stage: "IMPLEMENT", state: "RUNNING" } });

    it("a transient change and then open is dispatched", async () => {
      const h = harness();
      const r = racing(h, (fence) => { if (fence === 1) reviseTask(h); });
      await expect(guardTaskDispatch({ documentClient: r.documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("ALLOWED");
      expect(r.transactions).toHaveBeenCalledTimes(2);
    });

    it("a change and then the task closing is acknowledged as closed", async () => {
      const h = harness();
      const r = racing(h, (fence) => { if (fence === 1) h.db.set({ ...h.db.get(`DEVTASK#${TASK_ID}`, "META")!, closedAt: "2026-10-11T11:00:00.000Z" }); });
      await expect(guardTaskDispatch({ documentClient: r.documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("CLOSED");
      expect(r.transactions).toHaveBeenCalledTimes(1);
    });

    it("a change and then the operation ending (cancelled) with the task still open is acknowledged as closed", async () => {
      const h = harness();
      const operation = { pk: `WORKSPACE#${WORKSPACE_ID}`, sk: `OPERATION#${h.outbox.operationId}` };
      const r = racing(h, (fence) => { if (fence === 1) h.db.set({ ...h.db.get(operation.pk, operation.sk)!, status: "CANCELLED" }); });
      await expect(guardTaskDispatch({ documentClient: r.documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("CLOSED");
    });

    it("an operation whose row is gone is acknowledged as closed", async () => {
      const h = harness();
      h.db.delete(`WORKSPACE#${WORKSPACE_ID}`, `OPERATION#${h.outbox.operationId}`);
      await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("CLOSED");
    });

    it("a task that closes during the last pass is found by the final re-read and acknowledged as closed", async () => {
      const h = harness();
      const r = racing(h, (fence) => { if (fence < 3) reviseTask(h); else h.db.set({ ...h.db.get(`DEVTASK#${TASK_ID}`, "META")!, closedAt: "2026-10-11T11:00:00.000Z" }); });
      await expect(guardTaskDispatch({ documentClient: r.documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("CLOSED");
      expect(r.transactions).toHaveBeenCalledTimes(3);
    });

    it("a task that keeps changing but stays open is still retried (the guard's own retryable error)", async () => {
      const h = harness();
      const r = racing(h, () => reviseTask(h));
      const caught = await guardTaskDispatch({ documentClient: r.documentClient, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox).catch((error: unknown) => error);
      expect(isTaskDispatchGuardRetryError(caught)).toBe(true);
      expect(caught).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(String((caught as Error).message)).toContain("access changed while it was being verified");
      expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    });
  });

  it("durably parks PEOPLE work when proof is unconfigured and preserves operation identity", async () => {
    const h = harness();
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS", operationId: h.outbox.operationId, invocation: h.outbox.invocation });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ taskId: TASK_ID, peopleRevision: 3, reason: "PROOF_UNAVAILABLE" });
    expect(h.db.get(`DEVTASK#${TASK_ID}`, `TASK_ACCESS_PAUSE#${h.outbox.id}`)).toMatchObject({ operationId: h.outbox.operationId, workspaceId: WORKSPACE_ID });
  });

  it("parks ownerless work and a duplicate remains parked without another proof attempt", async () => {
    const h = harness();
    h.checkTaskPerson.mockResolvedValue({ ...(await h.checkTaskPerson()), eligible: false, channelMember: false });
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    h.checkTaskPerson.mockClear();
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    expect(h.checkTaskPerson).not.toHaveBeenCalled();
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")?.reason).toBe("OWNERLESS");
  });

  it("parks unknown proof without treating it as a departed owner", async () => {
    const h = harness();
    h.checkTaskPerson.mockRejectedValue(new Error("proof unavailable"));
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")?.reason).toBe("PROOF_UNAVAILABLE");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")?.orphaned).toBe(false);
  });

  it("uses stable effective owner actor IDs", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox);
    expect(taskOwnerKey(OWNER, TASK_ID)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redrives the exact parked invocation only after an explicit current-owner request", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox);
    const original = structuredClone(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX"));
    const newOwner = "b".repeat(64);
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false,
      people: [{ developerId: newOwner, slackUserId: "U0NEWOWNER1", name: "Bailey", role: "owner" }] });
    const requestId = randomUUID();
    const payloadHash = "d".repeat(64);

    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash,
    })).resolves.toBe(true);

    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")).toMatchObject({
      status: "PENDING", operationId: original?.operationId, invocation: original?.invocation,
    });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
    expect(h.db.get(`DEVTASK#${TASK_ID}`, `TASK_ACCESS_RETRY#${requestId}`)).toMatchObject({
      actorId: taskOwnerKey(newOwner, TASK_ID), operationId: h.outbox.operationId, payloadHash,
    });
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash,
    })).resolves.toBe(true);
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash: "e".repeat(64),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("reauthorizes the caller before a conditional historical redrive answer", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox);
    const requestId = randomUUID();
    const send = h.db.send.bind(h.db);
    let current = true;
    h.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("TASK_ACCESS_RETRY")) {
        await send(command);
        current = false;
        throw Object.assign(new Error("concurrent retry won"), { name: "TransactionCanceledException" });
      }
      return send(command);
    };

    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 3, actorId: taskOwnerKey(OWNER, TASK_ID), requestId, payloadHash: "d".repeat(64),
      reauthorize: async () => { if (!current) throw new Error("caller revoked"); },
    })).rejects.toThrow("caller revoked");
  });

  it("reauthorizes the caller before returning a prior redrive audit", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox);
    const requestId = randomUUID();
    let current = true;
    const input = {
      task: h.current, peopleRevision: 3, actorId: taskOwnerKey(OWNER, TASK_ID), requestId, payloadHash: "d".repeat(64),
      reauthorize: async () => { if (!current) throw new Error("caller revoked"); },
    };
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, input as never)).resolves.toBe(true);
    current = false;
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, input as never)).rejects.toThrow("caller revoked");
  });
});
