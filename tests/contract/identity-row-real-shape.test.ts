// A real sign-in's DEVELOPER#<id>/META row has no `developerId` attribute: the id is the key (store.ts getDeveloper). Every check that reads the
// raw row, or fences it at commit, must accept that row and still refuse one that names someone else (2026-11-01, after the admin health 403).
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_OIDC_ISSUER } from "@rovara-code/contracts";
import { describe, expect, it, vi } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { oidcTaskPersonIdentityCheck } from "../../packages/broker/src/aws/broker/model-access.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { createTaskPersonRuntime, type TaskPersonRuntimePorts } from "../../packages/broker/src/aws/task-person-runtime.js";
import { projectAiCallerCheck } from "../../packages/broker/src/spend/project-ai-identity.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { slackBindingPk, projectRevisionKey } from "@rovara-code/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { realIdentityRow } from "../support/real-identity-row.js";

const issuer = "https://identity.example.com", subject = "subject-123", slackUserId = "U0123456789", slackTeamId = "T0123456789", channelId = "C0123456789";
const oidcId = ownerKeyForSubject(issuer, subject);
const oidcProfile = { developerId: oidcId, provider: "oidc" as const, issuer, subject, displayName: "Maya", slackUserId };
const slackId = developerIdForSlackUser(slackUserId);
const slackProfile = { developerId: slackId, provider: "slack" as const, issuer: SLACK_OIDC_ISSUER, subject: slackUserId, displayName: "Maya", slackUserId };

/** Runs `check` in a transaction against `db`, as the real commit does: true when it would commit. */
async function commits(db: FakeDynamoDb, check: unknown): Promise<boolean> {
  try { await db.send(new TransactWriteCommand({ TransactItems: [check as never] })); return true; }
  catch { return false; }
}

describe("project AI and spending settings: the maintainer's sign-in row", () => {
  const deps = (db: FakeDynamoDb) => ({ documentClient: db, projectAiSignInTableName: "signin" });

  it("accepts a real sign-in's row, and its commit-time check passes on that row", async () => {
    const db = new FakeDynamoDb();
    await realIdentityRow(slackProfile, {}, db);
    const check = await projectAiCallerCheck(deps(db), slackId);
    expect(await commits(db, check)).toBe(true);
  });
  it("refuses a row that names someone else, and the commit-time check fails if the row changes to one", async () => {
    const db = new FakeDynamoDb();
    const row = await realIdentityRow(slackProfile, {}, db);
    const check = await projectAiCallerCheck(deps(db), slackId);
    db.set({ ...row, developerId: "b".repeat(64) });
    expect(await commits(db, check)).toBe(false);
    await expect(projectAiCallerCheck(deps(db), slackId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("still refuses a missing, revoked or merged real row", async () => {
    await expect(projectAiCallerCheck(deps(new FakeDynamoDb()), slackId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    for (const changes of [{ revoked: true }, { mergedInto: "c".repeat(64) }]) {
      const db = new FakeDynamoDb();
      await realIdentityRow(slackProfile, changes, db);
      await expect(projectAiCallerCheck(deps(db), slackId)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
  });
});

describe("a company sign-in (OIDC) task person", () => {
  const task = {
    pk: "DEVTASK#11111111-1111-4111-8111-111111111111", sk: "META", entityType: "DEVELOPER_TASK", taskId: "11111111-1111-4111-8111-111111111111",
    developerId: oidcId, provider: "oidc", developerName: "Maya", slackUserId, project: "payments-api", share: { teamId: slackTeamId, channelId },
  } as DeveloperTaskRecord;
  function checker(developerRecord: unknown) {
    const ports = {
      readTaskRecord: vi.fn(async ({ sortKey }: { sortKey: string }) => sortKey === "META" ? task as unknown as Record<string, unknown> : undefined),
      readDeveloperRecord: vi.fn(async () => developerRecord as never),
      // Nobody was removed, and everybody is a member who may write (a member row): owner decision 86.
      readOrgRecord: vi.fn(async ({ key }: { key: { pk: string; sk: string } }) => String(key.sk).startsWith("MEMBER#") ? { ...key, role: "member" } : undefined),
      projectAuthorityReader: {
        latestRevision: vi.fn(async (_project: string, _admission: unknown, signal: AbortSignal) => ({ revision: { ...projectRevisionKey(TEST_ORG, "payments-api", 7), revision: 7, definition: {} }, complete: !signal.aborted })),
        memberships: vi.fn(async (_id: string, _admission: unknown, signal: AbortSignal) => ({ items: [], complete: !signal.aborted })),
        bindings: vi.fn(async (_team: string, _admission: unknown, signal: AbortSignal) => ({
          items: [{ pk: slackBindingPk(TEST_ORG, slackTeamId), sk: `CHANNEL#${channelId}`, teamId: slackTeamId, channelId, projectName: "payments-api", updatedAt: "2026-01-01T00:00:00.000Z" }], complete: !signal.aborted })),
      },
      taskPersonProof: vi.fn(async () => ({ result: { ok: true as const, user: { id: slackUserId, teamId: slackTeamId, name: "Maya" }, memberOf: [channelId] }, slackCallsUsed: 1 })),
    } as unknown as TaskPersonRuntimePorts;
    return createTaskPersonRuntime({ orgId: TEST_ORG, admission: createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 }), ports, stateTableName: "state",
      slackTeamId, now: () => 1_000, uuid: () => "22222222-2222-4222-8222-222222222222" });
  }

  it("is proven current from a real sign-in's row", async () => {
    await expect(checker(await realIdentityRow(oidcProfile)).checkTaskPerson(task, oidcId)).resolves.toMatchObject({ eligible: true, identity: { developerId: oidcId, method: "oidc" } });
  });
  it("is not proven from a row that names someone else", async () => {
    await expect(checker({ ...await realIdentityRow(oidcProfile), developerId: "b".repeat(64) }).checkTaskPerson(task, oidcId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  for (const [what, changes] of [["revoked", { revoked: true }], ["merged into another developer", { mergedInto: "c".repeat(64) }]] as const) {
    it(`is not eligible when their real row is ${what}`, async () => {
      await expect(checker(await realIdentityRow(oidcProfile, changes)).checkTaskPerson(task, oidcId)).resolves.toMatchObject({ eligible: false });
    });
  }

  it("the model key's commit-time identity check passes on a real row and fails when it names someone else, is revoked, is merged or changes sign-in", async () => {
    const identity = { developerId: oidcId, issuer, subject, slackUserId };
    const db = new FakeDynamoDb();
    const row = await realIdentityRow(oidcProfile, {}, db);
    expect(await commits(db, oidcTaskPersonIdentityCheck("signin", identity))).toBe(true);
    for (const changes of [{ developerId: "b".repeat(64) }, { revoked: true }, { mergedInto: "c".repeat(64) }, { subject: "someone-else" }]) {
      db.set({ ...row, ...changes });
      expect(await commits(db, oidcTaskPersonIdentityCheck("signin", identity))).toBe(false);
    }
  });
});
