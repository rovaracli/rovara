// Plan 2, Task 21, fix round 3: one gate for "viewers only view". A person who holds a project grant that cannot start tasks (a viewer) can
// look at a task and cancel it, but every action that changes it or starts work is refused with the viewer message, on every surface, and no
// dispatch for a viewer's task starts, tasks without a People sidecar included. People with no grant keep the share design.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgBanKey, orgMemberKey, orgRemovedKey, projectMemberKey, sharedTaskKey, slackTeamOrgKey, type ProjectRole } from "../../packages/contracts/src/index.js";
import { guardTaskDispatch, resumeTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { pageAccess, requireProjectWorkRole } from "../../packages/broker/src/developer/task-access.js";
import { registerRevision } from "../support/developer-task-broker.js";
import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace, loadSlackBroker, serviceCall } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
describe("I2: a Slack-linked Auditor is read-only on every Slack route that starts or changes work", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000701`;
  const AUDITOR = "U0AUDITSL01";

  it("the service routes refuse an Auditor who also holds a contributor grant (it was resolved to a contributor)", async () => {
    const h = await withKit();
    const developerId = developerIdForSlackUser(AUDITOR);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "auditor" });
    setGrant(h.db, { ...KIT, developerId }, "contributor");
    const created = await ensureWorkspace(h.handler, thread, "U0MAYA001");
    expect(created.status).toBe(200);
    const workspaceId = String(created.body.workspaceId);
    const calls: Array<[string, string, string, unknown]> = [
      ["PUT", "/v1/service/project/model", "model", { provider: "openai", modelId: "gpt-5" }],
      ["POST", "/v1/service/evals/swebench", "swebench run", {}],
      ["POST", "/v1/service/evals/batches", "swebench batch", {}],
      ["POST", "/v1/service/threads/workspace/prepare", "prepare (start work)", { requestId: randomUUID() }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, "pull request", { requestId: randomUUID(), repository: "demo", title: "Fix" }],
      ["POST", `/v1/service/workspaces/${workspaceId}/connectors/github/call`, "connector call", { tool: "x", arguments: {} }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-request-actions`, "pull request action", { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "sync" }],
    ];
    for (const [method, path, label, body] of calls) {
      const refused = await serviceCall(h.handler, thread, AUDITOR, method, path, body);
      expect(refused.status, `${label} ${JSON.stringify(refused.body)}`).toBe(403);
      expect(refused.body.error, label).toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("the same Auditor with no grant at all (the channel would have made it a contributor) is refused too", async () => {
    const h = await withKit();
    seedMembership(h.db, developerIdForSlackUser(AUDITOR), { orgId: TEST_ORG, role: "auditor" });
    const refused = await serviceCall(h.handler, thread, AUDITOR, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
  });

  it("cannot start a task or decide one from a Slack thread", async () => {
    const h = await withKit();
    const slackThread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000702" };
    const owner = "U0SLACKOWN2";
    const ownerId = developerIdForSlackUser(owner), auditorId = developerIdForSlackUser(AUDITOR);
    seedMembership(h.db, ownerId, { orgId: TEST_ORG, role: "member" });
    setGrant(h.db, { ...KIT, developerId: ownerId }, "contributor");
    seedMembership(h.db, auditorId, { orgId: TEST_ORG, role: "auditor" });
    setGrant(h.db, { ...KIT, developerId: auditorId }, "contributor");
    const refusedStart = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { ...slackThread, threadTs: "1695500000.000703" }, userId: AUDITOR, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    expect(refusedStart.statusCode).toBe(403);
    const started = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: slackThread, userId: owner, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    for (const taskAction of ["decide", "retry", "publish", "feedback"]) {
      const answer = await h.handler({ source: "agentx.slack-ingress", action: "task-people-authorize", taskAction, taskId, userId: AUDITOR, thread: slackThread });
      expect(answer.statusCode, taskAction).toBe(403);
    }
  });
});

describe("a Slack requester who is not a current writer of the team's org is refused on every Slack service route (ONE rule with the ingress callers)", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000801`;
  const MAYA = "U0MAYA001";
  const GUEST = "U0GUESTSL01";
  const guestId = developerIdForSlackUser(GUEST);
  const OTHER_ORG = "org_cccccccccccccccccccc";

  /** Every route that starts work or changes the project, for the workspace Maya made: the guest must be refused on each. */
  async function refusedOnEveryRoute(h: Harness, who: string) {
    const created = await ensureWorkspace(h.handler, thread, MAYA);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const workspaceId = String(created.body.workspaceId);
    const calls: Array<[string, string, string, unknown]> = [
      ["POST", "/v1/service/threads/workspace/prepare", "prepare", { requestId: randomUUID() }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, "pull request", { requestId: randomUUID(), repository: "demo", title: "Fix" }],
      ["POST", `/v1/service/workspaces/${workspaceId}/connectors/github/call`, "connector call", { tool: "x", arguments: {} }],
      ["PUT", "/v1/service/project/model", "project model", { provider: "openai", modelId: "gpt-5" }],
    ];
    const ensure = await ensureWorkspace(h.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000802`, who);
    expect(ensure.status, `ensure ${JSON.stringify(ensure.body)}`).toBe(403);
    for (const [method, path, label, body] of calls) {
      const refused = await serviceCall(h.handler, thread, who, method, path, body);
      expect(refused.status, `${label} ${JSON.stringify(refused.body)}`).toBe(403);
    }
  }

  it("a member merged into a surviving Auditor is the Auditor (the Slack id has no record of its own)", async () => {
    const h = await withKit();
    const survivor = "7".repeat(64);
    seedMembership(h.db, survivor, { orgId: TEST_ORG, role: "auditor" });
    h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: survivor });
    await refusedOnEveryRoute(h, GUEST);
  });

  it("a member removed from a cloud org is refused: the removal row ends the implicit membership there too", async () => {
    const h = await withKit({ brokerExtra: { cloud: true } });
    h.db.set({ ...orgRemovedKey(TEST_ORG, guestId), orgId: TEST_ORG, developerId: guestId });
    await refusedOnEveryRoute(h, GUEST);
  });

  it("a removed member and a banned member are refused even on a single-org install", async () => {
    for (const row of [orgRemovedKey(TEST_ORG, guestId), orgBanKey(TEST_ORG, guestId)]) {
      const h = await withKit();
      h.db.set({ ...row, orgId: TEST_ORG, developerId: guestId });
      await refusedOnEveryRoute(h, GUEST);
    }
  });

  it("a removal or ban row under the merge survivor's id alone refuses the merged-away Slack id", async () => {
    const survivor = "9".repeat(64);
    for (const row of [orgRemovedKey(TEST_ORG, survivor), orgBanKey(TEST_ORG, survivor)]) {
      const h = await withKit();
      h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: survivor });
      // The harness records a signed-in developer as a member; a merge deletes the duplicate's member record (retire), so the Slack id is left with none.
      h.db.delete(orgMemberKey(TEST_ORG, guestId));
      h.db.set({ ...row, orgId: TEST_ORG, developerId: survivor });
      await refusedOnEveryRoute(h, GUEST);
    }
  });

  /** The Slack id merged into a chain of `merges` developers, each merged into the next (the last is the survivor). */
  const mergeChain = (h: Harness, merges: number) => {
    const ids = [guestId, ...Array.from({ length: merges }, (_, index) => String(index + 1).padStart(2, "0").repeat(32))];
    ids.forEach((id, index) => { if (index < merges) h.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, mergedInto: ids[index + 1] }); });
    h.db.set({ pk: `DEVELOPER#${ids[merges]!}`, sk: "META", developerId: ids[merges] });
    h.db.delete(orgMemberKey(TEST_ORG, guestId));
    return ids;
  };

  it("follows a merge chain up to the hop limit, and refuses one that reaches it or loops back", async () => {
    const served = await withKit();
    mergeChain(served, 8);
    const answered = await serviceCall(served.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect((answered.body.error as { code?: string } | undefined)?.code, JSON.stringify(answered.body)).not.toBe("FORBIDDEN");
    const tooLong = await withKit();
    mergeChain(tooLong, 9);
    await refusedOnEveryRoute(tooLong, GUEST);
    const looping = await withKit();
    const ids = mergeChain(looping, 2);
    looping.db.set({ pk: `DEVELOPER#${ids[2]!}`, sk: "META", developerId: ids[2], mergedInto: guestId });
    await refusedOnEveryRoute(looping, GUEST);
  });

  it("a requester of another org (a Slack Connect guest, a stale link) is refused", async () => {
    const orgResolver = async (subject: { developerId?: string; ownerKey?: string }) => (subject.developerId === guestId ? OTHER_ORG : TEST_ORG) as never;
    const h = await withKit({ brokerExtra: { orgResolver } });
    seedMembership(h.db, developerIdForSlackUser(MAYA), { orgId: TEST_ORG, role: "member" });
    seedMembership(h.db, guestId, { orgId: OTHER_ORG, role: "member" });
    h.db.set({ ...slackTeamOrgKey(SLACK_TEAM), orgId: TEST_ORG });
    await refusedOnEveryRoute(h, GUEST);
  });

  it("a removed or banned member is refused with REMOVED_FROM_ORG on the read-only service routes too, and a person who never joined is served", async () => {
    const readOnly = (h: Harness, who: string) => serviceCall(h.handler, thread, who, "GET", "/v1/service/project/models");
    for (const row of [orgRemovedKey(TEST_ORG, guestId), orgBanKey(TEST_ORG, guestId)]) {
      const h = await withKit();
      h.db.set({ ...row, orgId: TEST_ORG, developerId: guestId });
      const refused = await readOnly(h, GUEST);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toMatchObject({ code: "REMOVED_FROM_ORG" });
    }
    const never = await readOnly(await withKit(), GUEST);
    expect((never.body.error as { code?: string } | undefined)?.code, JSON.stringify(never.body)).not.toBe("REMOVED_FROM_ORG");
    expect(never.status, JSON.stringify(never.body)).not.toBe(403);
  });

  it("an unreadable member record (no role, a role this release does not know, or one under the merge survivor) is refused on the read-only service routes too", async () => {
    const survivor = "9".repeat(64);
    for (const arrange of [
      (h: Harness) => { h.db.set({ ...orgMemberKey(TEST_ORG, guestId), orgId: TEST_ORG, developerId: guestId }); },
      (h: Harness) => { h.db.set({ ...orgMemberKey(TEST_ORG, guestId), orgId: TEST_ORG, developerId: guestId, role: "future-role" }); },
      (h: Harness) => { h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: survivor }); h.db.set({ ...orgMemberKey(TEST_ORG, survivor), orgId: TEST_ORG, developerId: survivor }); },
    ]) {
      const h = await withKit();
      arrange(h);
      await refusedOnEveryRoute(h, GUEST);
      expect((await serviceCall(h.handler, thread, GUEST, "GET", "/v1/service/project/models")).status).toBe(403);
    }
  });

  it("an Auditor reads on the read-only service routes and starts or changes nothing on the others", async () => {
    const h = await withKit();
    seedMembership(h.db, guestId, { orgId: TEST_ORG, role: "auditor" });
    const read = await serviceCall(h.handler, thread, GUEST, "GET", "/v1/service/project/models");
    expect(read.status, JSON.stringify(read.body)).not.toBe(403);
    await refusedOnEveryRoute(h, GUEST);
  });

  it("a member record with no role field is unreadable and refused, not defaulted to member", async () => {
    const h = await withKit();
    seedMembership(h.db, guestId, { orgId: TEST_ORG, role: "member" });
    const key = orgMemberKey(TEST_ORG, guestId);
    const record = h.db.get(key.pk, key.sk)!;
    const withoutRole: Record<string, unknown> = { ...record };
    delete withoutRole["role"];
    h.db.set(withoutRole);
    await refusedOnEveryRoute(h, GUEST);
  });

  // The implicit member is the existing behaviour for an unlinked requester on a single-org install (the budget ruling R31 only says such a requester answers to the org alone).
  it("a merge survivor of another org refuses the Slack id, though the Slack id itself resolves to the team's org", async () => {
    const SURVIVOR = "9".repeat(64);
    const orgResolver = async (subject: { developerId?: string; ownerKey?: string }) => (subject.developerId === SURVIVOR ? OTHER_ORG : TEST_ORG) as never;
    const h = await withKit({ brokerExtra: { orgResolver } });
    seedMembership(h.db, developerIdForSlackUser(MAYA), { orgId: TEST_ORG, role: "member" });
    seedMembership(h.db, guestId, { orgId: TEST_ORG, role: "member" });
    seedMembership(h.db, SURVIVOR, { orgId: OTHER_ORG, role: "member" });
    h.db.set({ ...slackTeamOrgKey(SLACK_TEAM), orgId: TEST_ORG });
    h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: SURVIVOR });
    await refusedOnEveryRoute(h, GUEST);
  });

  it("the survivor's current role wins over a stale merged-away record's role", async () => {
    const SURVIVOR = "8".repeat(64);
    const h = await withKit();
    // The stale duplicate record says owner (an owner is maintainer everywhere); the survivor is a member, and the Slack id holds a viewer grant.
    h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: SURVIVOR });
    h.db.set({ ...orgMemberKey(TEST_ORG, guestId), orgId: TEST_ORG, developerId: guestId, role: "owner" });
    seedMembership(h.db, SURVIVOR, { orgId: TEST_ORG, role: "member" });
    setGrant(h.db, { ...KIT, developerId: guestId }, "viewer");
    const refused = await serviceCall(h.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    // A survivor who is an Auditor is refused outright, whatever the stale record says.
    const auditor = await withKit();
    auditor.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: SURVIVOR });
    auditor.db.set({ ...orgMemberKey(TEST_ORG, guestId), orgId: TEST_ORG, developerId: guestId, role: "owner" });
    seedMembership(auditor.db, SURVIVOR, { orgId: TEST_ORG, role: "auditor" });
    await refusedOnEveryRoute(auditor, GUEST);
  });

  /** The Slack identity linked to a developer and then unlinked from it: the identity is its own developer again, with no merge and no member record. */
  const unlinkedFrom = (h: Harness, developer: string) => {
    h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId });
    h.db.delete(orgMemberKey(TEST_ORG, guestId));
    h.db.set({ pk: `SIGNIN_IDENTITY#${guestId}`, sk: "META", identityKey: guestId, developerId: developer, provider: "slack", linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z", unlinkedFrom: developer, unlinkedAt: "2026-10-20T00:00:00.000Z" });
  };

  it("a Slack identity unlinked from a removed or banned developer is still refused, so unlinking does not clear a removal", async () => {
    const SURVIVOR = "7".repeat(64);
    for (const row of [orgRemovedKey(TEST_ORG, SURVIVOR), orgBanKey(TEST_ORG, SURVIVOR)]) {
      const h = await withKit();
      h.db.set({ ...row, orgId: TEST_ORG, developerId: SURVIVOR });
      unlinkedFrom(h, SURVIVOR);
      await refusedOnEveryRoute(h, GUEST);
    }
  });

  it("control: a Slack identity unlinked from a developer who is still a member is an unlinked requester, served as before", async () => {
    const SURVIVOR = "7".repeat(64);
    const h = await withKit();
    seedMembership(h.db, SURVIVOR, { orgId: TEST_ORG, role: "member" });
    unlinkedFrom(h, SURVIVOR);
    const answered = await serviceCall(h.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect((answered.body.error as { code?: string } | undefined)?.code, JSON.stringify(answered.body)).not.toBe("FORBIDDEN");
  });

  /** The Slack identity linked to `developer` again after an unlink: the link is active, and the merge the unlink dropped is not restored. */
  const relinkedTo = (h: Harness, developer: string) => {
    h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId });
    h.db.delete(orgMemberKey(TEST_ORG, guestId));
    h.db.set({ pk: `SIGNIN_IDENTITY#${guestId}`, sk: "META", identityKey: guestId, developerId: developer, provider: "slack", linkedAt: "2026-10-21T00:00:00.000Z", lastSignInAt: "2026-10-21T00:00:00.000Z" });
  };
  const LINKED = "6".repeat(64);

  it("a relinked Slack identity is judged by the developer it is linked to now: once that developer is removed or banned it is refused", async () => {
    for (const row of [orgRemovedKey(TEST_ORG, LINKED), orgBanKey(TEST_ORG, LINKED)]) {
      const h = await withKit();
      h.db.set({ ...row, orgId: TEST_ORG, developerId: LINKED });
      relinkedTo(h, LINKED);
      await refusedOnEveryRoute(h, GUEST);
    }
  });

  it("a relinked Slack identity keeps the role of the developer it is linked to: an owner or admin stays one, a member stays bound by a viewer grant, an Auditor is refused", async () => {
    for (const [role, expected] of [["owner", "served"], ["admin", "served"], ["member", "viewer"], ["auditor", "refused"]] as const) {
      const h = await withKit();
      seedMembership(h.db, LINKED, { orgId: TEST_ORG, role });
      relinkedTo(h, LINKED);
      setGrant(h.db, { ...KIT, developerId: guestId }, "viewer");
      const answered = await serviceCall(h.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
      const code = (answered.body.error as { code?: string } | undefined)?.code;
      if (expected === "viewer") expect(code, role).toBe("PROJECT_ACCESS_DENIED");
      else if (expected === "refused") expect(code, role).toBe("FORBIDDEN");
      else { expect(code, `${role} ${JSON.stringify(answered.body)}`).not.toBe("PROJECT_ACCESS_DENIED"); expect(code).not.toBe("FORBIDDEN"); }
    }
  });

  it("an owner or admin working through their own Slack identity is served on the service routes (control)", async () => {
    for (const role of ["owner", "admin"] as const) {
      const h = await withKit();
      seedMembership(h.db, guestId, { orgId: TEST_ORG, role });
      setGrant(h.db, { ...KIT, developerId: guestId }, "viewer");
      const answered = await serviceCall(h.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
      const code = (answered.body.error as { code?: string } | undefined)?.code;
      expect(code, `${role} ${JSON.stringify(answered.body)}`).not.toBe("PROJECT_ACCESS_DENIED");
      expect(code).not.toBe("FORBIDDEN");
    }
  });

  it("a Slack identity unlinked from a developer who was removed and then invited again is allowed: the new membership stands", async () => {
    const h = await withKit();
    h.db.set({ ...orgRemovedKey(TEST_ORG, LINKED), orgId: TEST_ORG, developerId: LINKED });
    seedMembership(h.db, LINKED, { orgId: TEST_ORG, role: "member" });
    unlinkedFrom(h, LINKED);
    const answered = await serviceCall(h.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect((answered.body.error as { code?: string } | undefined)?.code, JSON.stringify(answered.body)).not.toBe("FORBIDDEN");
  });

  it("a merge survivor with no org refuses an identity that is placed in the team's org, and is accepted for one that is unplaced too", async () => {
    const SURVIVOR = "5".repeat(64);
    const placedGuest = async (guestOrg: string | undefined) => {
      const orgResolver = async (subject: { developerId?: string; ownerKey?: string }) => (subject.developerId === guestId ? guestOrg : subject.developerId === SURVIVOR ? undefined : TEST_ORG) as never;
      const h = await withKit({ brokerExtra: { orgResolver } });
      seedMembership(h.db, developerIdForSlackUser(MAYA), { orgId: TEST_ORG, role: "member" });
      h.db.set({ ...slackTeamOrgKey(SLACK_TEAM), orgId: TEST_ORG });
      h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: SURVIVOR });
      return h;
    };
    const placed = await placedGuest(TEST_ORG);
    seedMembership(placed.db, guestId, { orgId: TEST_ORG, role: "member" });
    await refusedOnEveryRoute(placed, GUEST);
    const unplaced = await placedGuest(undefined);
    await ensureWorkspace(unplaced.handler, thread, MAYA);
    const answered = await serviceCall(unplaced.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect((answered.body.error as { code?: string } | undefined)?.code, JSON.stringify(answered.body)).not.toBe("FORBIDDEN");
  });

  /** A chain of developers: each id merged into the next, the last a survivor. */
  const mergeInto = (h: Harness, ids: string[]) => ids.forEach((id, index) => h.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, ...(index < ids.length - 1 ? { mergedInto: ids[index + 1] } : {}) }));
  const idOf = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, "0")}`.padEnd(64, "0");
  const prepared = async (h: Harness) => (await serviceCall(h.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() })).body.error as { code?: string } | undefined;

  it("the hop limit and the loop check cover the merges and the link as one walk", async () => {
    // A merge chain of four, then the link to a developer who is itself merged on: within the cap it is served, one hop over it is refused.
    for (const [linkMerges, served] of [[3, true], [4, false]] as const) {
      const h = await withKit();
      const own = [guestId, idOf("a", 1), idOf("a", 2), idOf("a", 3), idOf("a", 4)];
      mergeInto(h, own);
      const linked = Array.from({ length: linkMerges + 1 }, (_, index) => idOf("b", index));
      mergeInto(h, linked);
      h.db.set({ pk: `SIGNIN_IDENTITY#${guestId}`, sk: "META", identityKey: guestId, developerId: linked[0], provider: "slack", linkedAt: "2026-10-21T00:00:00.000Z", lastSignInAt: "2026-10-21T00:00:00.000Z" });
      h.db.delete(orgMemberKey(TEST_ORG, guestId));
      if (served) expect((await prepared(h))?.code).not.toBe("FORBIDDEN");
      else await refusedOnEveryRoute(h, GUEST);
    }
  });

  it("a relinked identity whose developer was merged elsewhere is served (within the cap), and one linked to a developer of another org is refused", async () => {
    const h = await withKit();
    mergeInto(h, [idOf("c", 1), idOf("c", 2)]);
    relinkedTo(h, idOf("c", 1));
    expect((await prepared(h))?.code).not.toBe("FORBIDDEN");
    const orgResolver = async (subject: { developerId?: string; ownerKey?: string }) => (subject.developerId === idOf("d", 1) ? OTHER_ORG : TEST_ORG) as never;
    const other = await withKit({ brokerExtra: { orgResolver } });
    seedMembership(other.db, developerIdForSlackUser(MAYA), { orgId: TEST_ORG, role: "member" });
    seedMembership(other.db, guestId, { orgId: TEST_ORG, role: "member" });
    seedMembership(other.db, idOf("d", 1), { orgId: OTHER_ORG, role: "member" });
    other.db.set({ ...slackTeamOrgKey(SLACK_TEAM), orgId: TEST_ORG });
    other.db.set({ pk: `SIGNIN_IDENTITY#${guestId}`, sk: "META", identityKey: guestId, developerId: idOf("d", 1), provider: "slack", linkedAt: "2026-10-21T00:00:00.000Z", lastSignInAt: "2026-10-21T00:00:00.000Z" });
    await refusedOnEveryRoute(other, GUEST);
  });

  /** Slack identity S reaches developer `SURVIVOR` by a merge, by an active link with its merge, or by a relink that did not restore the merge. */
  const SURVIVOR_ID = "4".repeat(63) + "7";
  const reaching: Array<[string, (h: Harness) => void]> = [
    ["merged", (h) => { h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: SURVIVOR_ID }); h.db.delete(orgMemberKey(TEST_ORG, guestId)); }],
    ["linked", (h) => { h.db.set({ pk: `DEVELOPER#${guestId}`, sk: "META", developerId: guestId, mergedInto: SURVIVOR_ID }); h.db.delete(orgMemberKey(TEST_ORG, guestId)); h.db.set({ pk: `SIGNIN_IDENTITY#${guestId}`, sk: "META", identityKey: guestId, developerId: SURVIVOR_ID, provider: "slack", linkedAt: "2026-10-21T00:00:00.000Z", lastSignInAt: "2026-10-21T00:00:00.000Z" }); }],
    ["relinked", (h) => relinkedTo(h, SURVIVOR_ID)],
  ];

  it("a viewer grant of the developer a Slack identity reaches binds it, so the project's channel does not make it a contributor", async () => {
    for (const [how, reach] of reaching) {
      const h = await withKit();
      seedMembership(h.db, SURVIVOR_ID, { orgId: TEST_ORG, role: "member" });
      setGrant(h.db, { ...KIT, developerId: SURVIVOR_ID }, "viewer");
      reach(h);
      await refusedOnEveryRoute(h, GUEST);
      expect((await prepared(h))?.code, how).toBe("PROJECT_ACCESS_DENIED");
    }
  });

  it("a contributor grant of the developer a Slack identity reaches gives it contributor (control), and the survivor's grant wins over a stale one under the Slack id", async () => {
    for (const [how, reach] of reaching) {
      const h = await withKit();
      seedMembership(h.db, SURVIVOR_ID, { orgId: TEST_ORG, role: "member" });
      setGrant(h.db, { ...KIT, developerId: SURVIVOR_ID }, "contributor");
      reach(h);
      expect((await prepared(h))?.code, how).not.toBe("PROJECT_ACCESS_DENIED");
      setGrant(h.db, { ...KIT, developerId: guestId }, "viewer");
      expect((await prepared(h))?.code, `${how} with a stale viewer grant under the Slack id`).not.toBe("PROJECT_ACCESS_DENIED");
    }
  });

  it("control: a single-org install still treats a person with no record as the implicit member", async () => {
    const h = await withKit();
    const answered = await serviceCall(h.handler, thread, GUEST, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect((answered.body.error as { code?: string } | undefined)?.code).not.toBe("FORBIDDEN");
  });
});

describe("the task paths read a member record that has no role as unreadable", () => {
  it("refuses it, whatever grant the person still holds, and does not for a member with the same grant", async () => {
    const h = await withKit();
    const who = "6".repeat(64);
    const { requireProjectAuthority } = await loadSlackBroker() as unknown as { requireProjectAuthority: (...args: unknown[]) => Promise<unknown> };
    h.db.set({ ...projectMemberKey(TEST_ORG, who, "payments"), entityType: "MEMBERSHIP", ownerKey: who, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: "g2" });
    seedMembership(h.db, who, { orgId: TEST_ORG, role: "member" });
    await expect(requireProjectAuthority(h.brokerInput, TEST_ORG, who, "payments")).resolves.toMatchObject({ kind: "grant" });
    h.db.set({ ...orgMemberKey(TEST_ORG, who), orgId: TEST_ORG, developerId: who });
    await expect(requireProjectAuthority(h.brokerInput, TEST_ORG, who, "payments")).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });
});

describe("Slack model access for a project viewer or an Auditor", () => {
  const VIEWER = "U0VIEWERSL2";
  const viewerId = developerIdForSlackUser(VIEWER);
  const taskThread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000901" };
  const subject = `${SLACK_TEAM}/${SLACK_CHANNEL}/${taskThread.threadTs}`;
  const modelAccessInstall = async (role: "owner" | "admin" | "member" | "auditor" = "member") => {
    const mintKey = vi.fn(async () => ({ key: "sk-proxy-per-turn-key-0001", expiresAt: Date.now() + 900_000 }));
    const orgFigures = () => ({ spentUsd: 0, limitUsd: 500 });
    const access = { upsertOrg: vi.fn(), upsertMember: vi.fn(), spend: vi.fn(async () => ({ member: { spentUsd: 0, limitUsd: 29 }, org: orgFigures() })), orgSpend: vi.fn(async () => orgFigures()), keySpend: vi.fn(), mintKey, revokeKey: vi.fn(), blockKey: vi.fn(), upsertSource: vi.fn(), removeSource: vi.fn(), checkSource: vi.fn(), listSources: vi.fn(), auditKeys: vi.fn() };
    const h = await withKit({ brokerExtra: { modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true } });
    seedMembership(h.db, viewerId, { orgId: TEST_ORG, role });
    setGrant(h.db, { ...KIT, developerId: viewerId }, "viewer");
    return { ...h, mintKey };
  };
  const sharedTask = (h: Harness, extra: Record<string, unknown> = {}) => {
    const taskId = randomUUID();
    h.db.set({ ...sharedTaskKey(taskThread), taskId, workspaceId: randomUUID(), ownerKey: taskOwnerKey(KIT.developerId, taskId), developerId: KIT.developerId, developerName: "Kit Alvarez", project: "payments", mode: "view", sharedAt: new Date().toISOString(), workflowThread: true, ...extra });
  };
  const ask = (h: Harness) => serviceCall(h.handler, subject, VIEWER, "POST", "/v1/service/model-access", { turnId: "Ev1" });

  it("gets a key for a read-only task answer in a Slack-started task's thread, and is still refused one for any working thread", async () => {
    const answer = await modelAccessInstall();
    sharedTask(answer);
    const answered = await ask(answer);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answer.mintKey).toHaveBeenCalledTimes(1);
    // An ordinary channel thread, a closed task thread and a task thread opened for continuing are working threads.
    const ordinary = await modelAccessInstall();
    const refusedOrdinary = await ask(ordinary);
    expect(refusedOrdinary.status).toBe(403);
    expect(refusedOrdinary.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(ordinary.mintKey).not.toHaveBeenCalled();
    for (const extra of [{ closedAt: new Date().toISOString() }, { workflowThread: undefined, mode: "continue" }]) {
      const h = await modelAccessInstall();
      sharedTask(h, extra);
      const refused = await ask(h);
      expect(refused.status, JSON.stringify(extra)).toBe(403);
      expect(h.mintKey).not.toHaveBeenCalled();
    }
  });

  it("gives an Auditor a key for a task answer only: read-only is read-only, and a working thread is refused", async () => {
    const answer = await modelAccessInstall("auditor");
    sharedTask(answer);
    expect((await ask(answer)).status).toBe(200);
    expect(answer.mintKey).toHaveBeenCalledTimes(1);
    const ordinary = await modelAccessInstall("auditor");
    expect((await ask(ordinary)).status).toBe(403);
    expect(ordinary.mintKey).not.toHaveBeenCalled();
  });

  it("a viewer grant of the developer the identity reaches binds it for a key too, except the read-only task answer; a contributor grant gives a key (control)", async () => {
    const other = "9".repeat(64);
    const reaches: Array<[string, (h: Awaited<ReturnType<typeof modelAccessInstall>>) => void]> = [
      ["merged", (h) => h.db.set({ pk: `DEVELOPER#${viewerId}`, sk: "META", developerId: viewerId, mergedInto: other })],
      ["relinked", (h) => h.db.set({ pk: `SIGNIN_IDENTITY#${viewerId}`, sk: "META", identityKey: viewerId, developerId: other, provider: "slack", linkedAt: "2026-10-21T00:00:00.000Z", lastSignInAt: "2026-10-21T00:00:00.000Z" })],
    ];
    for (const [how, reach] of reaches) {
      for (const grant of ["viewer", "contributor"] as const) {
        const h = await modelAccessInstall();
        h.db.delete(orgMemberKey(TEST_ORG, viewerId));
        h.db.delete(projectMemberKey(TEST_ORG, viewerId, "payments"));
        seedMembership(h.db, other, { orgId: TEST_ORG, role: "member" });
        setGrant(h.db, { ...KIT, developerId: other }, grant);
        reach(h);
        h.db.delete(orgMemberKey(TEST_ORG, viewerId));
        const ordinary = await ask(h);
        expect(ordinary.status, `${how} ${grant}`).toBe(grant === "viewer" ? 403 : 200);
        expect(h.mintKey).toHaveBeenCalledTimes(grant === "viewer" ? 0 : 1);
        if (grant === "viewer") {
          sharedTask(h);
          expect((await ask(h)).status, `${how} task answer`).toBe(200);
          expect(h.mintKey).toHaveBeenCalledTimes(1);
        }
      }
    }
  });

  it("is refused a key in a task thread of another project, though the thread is a Slack-started task's", async () => {
    const h = await modelAccessInstall();
    sharedTask(h, { project: "ledger" });
    const refused = await ask(h);
    expect(refused.status).toBe(403);
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it("serves an owner or admin a key in an ordinary thread, through their own Slack identity or one relinked to them (control)", async () => {
    for (const role of ["owner", "admin"] as const) {
      for (const relinked of [false, true]) {
        const h = await modelAccessInstall(role);
        if (relinked) {
          const other = "9".repeat(64);
          h.db.delete(orgMemberKey(TEST_ORG, viewerId));
          seedMembership(h.db, other, { orgId: TEST_ORG, role });
          h.db.set({ pk: `SIGNIN_IDENTITY#${viewerId}`, sk: "META", identityKey: viewerId, developerId: other, provider: "slack", linkedAt: "2026-10-21T00:00:00.000Z", lastSignInAt: "2026-10-21T00:00:00.000Z" });
        }
        const answered = await ask(h);
        expect(answered.status, `${role} relinked=${String(relinked)} ${JSON.stringify(answered.body)}`).toBe(200);
        expect(h.mintKey).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("is refused a key once the developer the identity was relinked to is removed or banned", async () => {
    const other = "9".repeat(64);
    for (const row of [orgRemovedKey(TEST_ORG, other), orgBanKey(TEST_ORG, other)]) {
      const h = await modelAccessInstall();
      h.db.delete(orgMemberKey(TEST_ORG, viewerId));
      h.db.delete(projectMemberKey(TEST_ORG, viewerId, "payments")); // no viewer grant: only the relinked developer's removal can refuse the key
      h.db.set({ ...row, orgId: TEST_ORG, developerId: other });
      h.db.set({ pk: `SIGNIN_IDENTITY#${viewerId}`, sk: "META", identityKey: viewerId, developerId: other, provider: "slack", linkedAt: "2026-10-21T00:00:00.000Z", lastSignInAt: "2026-10-21T00:00:00.000Z" });
      expect((await ask(h)).status).toBe(403);
      expect(h.mintKey).not.toHaveBeenCalled();
    }
  });

  it("is refused a task-answer key once removed from the company, or with a record that has no role", async () => {
    const removed = await modelAccessInstall();
    sharedTask(removed);
    removed.db.delete(orgMemberKey(TEST_ORG, viewerId));
    removed.db.set({ ...orgRemovedKey(TEST_ORG, viewerId), orgId: TEST_ORG, developerId: viewerId });
    expect((await ask(removed)).status).toBe(403);
    expect(removed.mintKey).not.toHaveBeenCalled();
    const unreadable = await modelAccessInstall();
    sharedTask(unreadable);
    unreadable.db.set({ ...orgMemberKey(TEST_ORG, viewerId), orgId: TEST_ORG, developerId: viewerId });
    expect((await ask(unreadable)).status).toBe(403);
    expect(unreadable.mintKey).not.toHaveBeenCalled();
  });
});

const RESUMED_ORIGINAL = "This task was paused while you could only view the project. It has resumed with its original instructions; the instructions you just sent were not used, so send them again once it finishes.";
const VIEWER_MESSAGE = "You can view `payments` but not start tasks in it. Ask a maintainer to make you a contributor.";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

function setGrant(db: FakeDynamoDb, who: Developer, role: ProjectRole): void {
  db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(),
    role: role === "viewer" ? "viewer" : "developer", projectRole: role });
}

async function withKit(options: Parameters<typeof createSingleAnswerPlanBroker>[0] = {}): Promise<Harness> {
  const h = await createSingleAnswerPlanBroker(options);
  await h.orgOf(KIT);
  h.db.set({ pk: `SESSION#${KIT.sessionId}`, sk: "META", sessionId: KIT.sessionId, developerId: KIT.developerId, amr: KIT.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  h.db.set({ pk: `DEVELOPER#${KIT.developerId}`, sk: "META", developerId: KIT.developerId, provider: "oidc", displayName: KIT.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: "member" });
  setGrant(h.db, KIT, "contributor");
  return h;
}

const operations = (h: Harness, workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

/** Kit's Quick workflow task (no People sidecar: a legacy task), planned and waiting for the owner's decision on the plan. */
async function planWaiting(h: Harness) {
  const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = String(h.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
  await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n";
  await finishPlanningWithMarkdown(h, workspaceId, String(operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
  const revision = (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow.revision;
  return { taskId, workspaceId, revision, digest: createHash("sha256").update(plan).digest("hex") };
}

describe("requireProjectWorkRole: the one gate", () => {
  const task = { project: "payments" };
  const actor = (orgRole: "member" | "admin" = "member") => ({ developerId: KIT.developerId, orgId: TEST_ORG, orgRole });
  const rows = (item?: Record<string, unknown>) => ({ send: async () => ({ Item: item }) });
  const failing = { send: async () => { throw new Error("DynamoDB is down"); } };
  const deps = (checkAccess: () => Promise<unknown>, documentClient: { send(command: unknown): Promise<unknown> } = rows()) =>
    ({ checkAccess, documentClient, tableName: "state" }) as never;
  const access = (granted: "granted" | "channel", role: ProjectRole) => async () => ({ revision: 1, policy: {}, access: granted, channelIds: [], role });
  const refuse = (code: string) => { const error = Object.assign(new Error(code), { code }); return async () => { throw error; }; };
  const grantRow = (role: "viewer" | "developer", projectRole: ProjectRole) => ({ role, projectRole });

  it("refuses an actor who holds a grant that cannot start tasks, with the viewer message", async () => {
    await expect(requireProjectWorkRole(deps(access("granted", "viewer")), task, actor())).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
  });

  it("allows a maintainer, a contributor, and an actor with no grant (the share design is unchanged)", async () => {
    for (const role of ["maintainer", "contributor"] as const) await expect(requireProjectWorkRole(deps(access("granted", role)), task, actor())).resolves.toBeUndefined();
    await expect(requireProjectWorkRole(deps(access("channel", "contributor")), task, actor())).resolves.toBeUndefined();
    await expect(requireProjectWorkRole(deps(access("channel", "viewer")), task, actor())).resolves.toBeUndefined();
  });

  it("when the project check throws (tasks turned off, a transient error), reads the actor's grant and org role directly: a viewer is refused", async () => {
    for (const code of ["PROJECT_TASKS_DISABLED", "SLACK_UNAVAILABLE", "PROJECT_ACCESS_DENIED"]) {
      await expect(requireProjectWorkRole(deps(refuse(code), rows(grantRow("viewer", "viewer"))), task, actor()), code).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    }
  });

  it("when the project check throws, a contributor, a maintainer, an old grant, an org admin with a stray viewer row and a grantless actor keep today's behaviour", async () => {
    for (const item of [grantRow("developer", "contributor"), grantRow("developer", "maintainer"), { role: "developer" }, undefined]) {
      await expect(requireProjectWorkRole(deps(refuse("PROJECT_TASKS_DISABLED"), rows(item)), task, actor())).resolves.toBeUndefined();
    }
    await expect(requireProjectWorkRole(deps(refuse("PROJECT_TASKS_DISABLED"), rows(grantRow("viewer", "viewer"))), task, actor("admin"))).resolves.toBeUndefined();
  });

  it("refuses when the fallback read fails too: the gate never fails open", async () => {
    await expect(requireProjectWorkRole(deps(refuse("SLACK_UNAVAILABLE"), failing), task, actor())).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("an owner lowered to viewer on a task with no People sidecar", () => {
  it("cannot approve the plan: nothing changes and nothing is dispatched; a contributor's approval works", async () => {
    const h = await withKit();
    const { taskId, workspaceId, revision, digest } = await planWaiting(h);
    expect(h.db.get(`DEVTASK#${taskId}`, "PEOPLE")).toBeUndefined();
    const before = JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"));
    const dispatchedBefore = operations(h, workspaceId).length;
    setGrant(h.db, KIT, "viewer");
    const decision = { requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest };
    const refused = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, decision);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    expect(JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"))).toBe(before);
    expect(operations(h, workspaceId)).toHaveLength(dispatchedBefore);
    // The same request from the owner once they are a contributor again goes through and starts the implementation.
    setGrant(h.db, KIT, "contributor");
    expect((await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, decision)).status).toBe(200);
    expect(operations(h, workspaceId).some((item) => item.workflowMode === "IMPLEMENT")).toBe(true);
  });

  it("cannot resolve findings (FIX), decide PR feedback, retry a publication, keep pull requests, open a pull request or share", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    const before = JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"));
    setGrant(h.db, KIT, "viewer");
    const post = (path: string, body: unknown) => h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/${path}`, body);
    const findings = { requestId: randomUUID(), expectedRevision: 1, candidateDigest: "a".repeat(64), resolutions: [{ findingId: "b".repeat(64), action: "FIX", note: "" }] };
    const attempts: Array<[string, unknown]> = [
      ["workflow/review-findings", findings],
      ["workflow/feedback-decision", { requestId: randomUUID(), expectedRevision: 1, reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)], decision: "APPROVE", selectedFindingIds: ["finding-1"] }],
      ["workflow/feedback-retry", { reviewDigest: "a".repeat(64) }],
      ["workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 1 }],
      ["workflow/keep-pull-requests", { requestId: randomUUID(), expectedRevision: 1 }],
      ["pull-requests", { requestId: randomUUID(), title: "Fix", repository: "demo" }],
      ["share", { requestId: randomUUID(), shareMode: "view" }],
    ];
    for (const [path, body] of attempts) {
      const refused = await post(path, body);
      expect(refused.status, path).toBe(403);
      expect(refused.body.error, path).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    }
    expect(JSON.stringify(h.db.get(`DEVTASK#${taskId}`, "META"))).toBe(before);
    // Looking and cancelling stay open.
    expect((await h.dev(KIT, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(200);
    expect((await post("cancel", { requestId: randomUUID() })).status).toBe(200);
  });

  it("is refused the task page's ask, and posts no comment with it", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    setGrant(h.db, KIT, "viewer");
    const { createPageComment } = await import("../../packages/broker/src/aws/developer-tasks.js");
    const routeDeps = (await import("../../packages/broker/src/aws/developer-routes.js")).developerTaskRouteDependencies;
    const caller = { developerId: KIT.developerId, sessionId: KIT.sessionId, amr: KIT.provider, name: KIT.name, orgId: TEST_ORG, orgRole: "member" as const };
    const deps = routeDeps({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now, tasks: h.actions }, caller);
    await expect(createPageComment(deps, caller, taskId, { text: "What does step 1 do?", ask: true, anchor: { document: "plan" } } as never)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(h.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("COMMENT#"))).toHaveLength(0);
  });

  it("gets no dispatch: the guard parks the operation, and a raised owner can resume it", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as never;
    const workspaceId = String((task as { workspaceId: string }).workspaceId);
    expect(h.db.get(`DEVTASK#${taskId}`, "PEOPLE")).toBeUndefined();
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)[0] as never;
    const outboxId = (record as { id: string }).id;
    const deps = { documentClient: h.db, tableName: "state", orgId: TEST_ORG, now: () => Date.now() } as never;
    // A contributor owner is allowed (a task with no People sidecar).
    expect(await guardTaskDispatch(deps, record)).toBe("ALLOWED");
    setGrant(h.db, KIT, "viewer");
    expect(await guardTaskDispatch(deps, record)).toBe("PARKED");
    expect(h.db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS" });
    // Raised again, the owner resumes the one parked operation, which goes back to PENDING and is allowed.
    setGrant(h.db, KIT, "contributor");
    const current = h.db.get(`DEVTASK#${taskId}`, "META") as never;
    expect(await resumeTaskDispatch(deps, { task: current, peopleRevision: 0, actorId: `owner-${taskId}`, requestId: randomUUID(), payloadHash: "p" })).toBe(true);
    expect(h.db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
    expect(await guardTaskDispatch(deps, record)).toBe("ALLOWED");
  });

  it("does not park a close or a cancel: cleanup is independent of the role", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const workspaceId = String(h.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META")?.workspaceId);
    setGrant(h.db, KIT, "viewer");
    const deps = { documentClient: h.db, tableName: "state", orgId: TEST_ORG, now: () => Date.now() } as never;
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)[0]!;
    for (const kind of ["close", "cancel"]) {
      expect(await guardTaskDispatch(deps, { ...record, invocation: { ...(record.invocation as object), kind } } as never)).toBe("ALLOWED");
    }
  });
});

describe("the Slack service routes that change a project or start work refuse a project viewer", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000501`;
  const asSlackPerson = (h: Harness, slackUserId: string, role?: ProjectRole) => {
    const developerId = developerIdForSlackUser(slackUserId);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "member" });
    if (role !== undefined) setGrant(h.db, { ...KIT, developerId }, role);
  };

  it("PUT /v1/project/model, SWE-bench run and batch starts, preparing the thread workspace and both pull request routes", async () => {
    const h = await withKit();
    asSlackPerson(h, "U0VIEWERSL1", "viewer");
    asSlackPerson(h, "U0CONTRIBSL1", "contributor");
    const created = await ensureWorkspace(h.handler, thread, "U0MAYA001");
    expect(created.status).toBe(200);
    const workspaceId = String(created.body.workspaceId);
    const calls: Array<[string, string, string, unknown]> = [
      ["PUT", "/v1/service/project/model", "model", { provider: "openai", modelId: "gpt-5" }],
      ["POST", "/v1/service/evals/swebench", "swebench run", {}],
      ["POST", "/v1/service/evals/batches", "swebench batch", {}],
      ["POST", "/v1/service/threads/workspace/prepare", "prepare", { requestId: randomUUID() }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, "pull request", { requestId: randomUUID(), repository: "demo", title: "Fix" }],
      ["POST", `/v1/service/workspaces/${workspaceId}/connectors/github/call`, "connector call", { tool: "x", arguments: {} }],
      ["POST", `/v1/service/workspaces/${workspaceId}/pull-request-actions`, "pull request action", { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "sync" }],
    ];
    for (const [method, path, label, body] of calls) {
      const refused = await serviceCall(h.handler, thread, "U0VIEWERSL1", method, path, body);
      expect(refused.status, `${label} ${JSON.stringify(refused.body)}`).toBe(403);
      expect(refused.body.error, label).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    }
    // Others are not refused for their role (their request may fail for other reasons, such as an unapproved model).
    for (const [method, path, label, body] of calls) {
      const answered = await serviceCall(h.handler, thread, "U0CONTRIBSL1", method, path, body);
      expect(answered.body.error ?? {}, label).not.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    }
  });
});

describe("round 4: the org role, a disabled project, the pre-checks and resuming a plain task", () => {
  const startWorkflowTask = async (h: Harness) => {
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = String(h.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
    return { taskId, workspaceId, record: h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === workspaceId)[0] as never };
  };
  const guardDeps = (h: Harness) => ({ documentClient: h.db, tableName: "state", orgId: TEST_ORG, now: () => Date.now() }) as never;

  it("PROBE A: an org owner or admin with a stray viewer row is never parked by the dispatch guard (they maintain every project); a plain viewer still is", async () => {
    for (const orgRole of ["member", "admin", "owner"] as const) {
      const h = await withKit();
      const { record } = await startWorkflowTask(h);
      setGrant(h.db, KIT, "viewer");
      seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: orgRole });
      expect(await guardTaskDispatch(guardDeps(h), record), orgRole).toBe(orgRole === "member" ? "PARKED" : "ALLOWED");
    }
  });

  it("PROBE B: when the project turns off tasks from AI tools, a lowered owner still cannot approve the plan; a contributor owner still can", async () => {
    const h = await withKit();
    const first = await planWaiting(h);
    const decision = (taskId: string, revision: number, digest: string) => ({ requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest });
    await registerRevision(h.handler, 2, { enabled: false, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true });
    setGrant(h.db, KIT, "viewer");
    const before = JSON.stringify(h.db.get(`DEVTASK#${first.taskId}`, "META"));
    const refused = await h.dev(KIT, "POST", `/v1/dev/tasks/${first.taskId}/workflow/decision`, decision(first.taskId, first.revision, first.digest));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining(VIEWER_MESSAGE) as string });
    expect(JSON.stringify(h.db.get(`DEVTASK#${first.taskId}`, "META"))).toBe(before);
    // A contributor on the same project keeps today's behaviour (the decision is not blocked by the gate).
    setGrant(h.db, KIT, "contributor");
    const allowed = await h.dev(KIT, "POST", `/v1/dev/tasks/${first.taskId}/workflow/decision`, decision(first.taskId, first.revision, first.digest));
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it("the task page does not offer decide or ask to an owner lowered to viewer, and still does to a contributor", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    const { getTaskPageState } = await import("../../packages/broker/src/aws/developer-tasks.js");
    const routeDeps = (await import("../../packages/broker/src/aws/developer-routes.js")).developerTaskRouteDependencies;
    const caller = { developerId: KIT.developerId, sessionId: KIT.sessionId, amr: KIT.provider, name: KIT.name, orgId: TEST_ORG, orgRole: "member" as const };
    const state = () => getTaskPageState(routeDeps({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now, tasks: h.actions }, caller), caller, taskId);
    expect(await state()).toMatchObject({ canDecide: true });
    setGrant(h.db, KIT, "viewer");
    expect(await state()).toMatchObject({ canRead: true, canDecide: false, canAsk: false });
  });

  it("pageAccess offers decide and ask only where work is allowed (commenting is unaffected)", () => {
    const open = { task: { closedAt: undefined, workflow: undefined } as never, role: "owner" as const, ownerActorIds: [] };
    expect(pageAccess(open)).toMatchObject({ canComment: true, canDecide: true, canAsk: true });
    expect(pageAccess(open, false)).toEqual({ role: "owner", canComment: true, canSuggest: false, canDecide: false, canAsk: false });
  });

  it("the Slack pre-check does not authorize decide, retry, publish or feedback for a lowered owner, and still authorizes stop and close", async () => {
    const h = await withKit();
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000601" };
    const owner = "U0SLACKOWN1";
    const developerId = developerIdForSlackUser(owner);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "member" });
    setGrant(h.db, { ...KIT, developerId }, "contributor");
    const started = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: owner, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const authorize = async (taskAction: string) => (await h.handler({ source: "agentx.slack-ingress", action: "task-people-authorize", taskAction, taskId, userId: owner, thread })).statusCode;
    for (const action of ["decide", "retry", "publish", "feedback"]) expect(await authorize(action), action).toBe(200);
    setGrant(h.db, { ...KIT, developerId }, "viewer");
    for (const action of ["decide", "retry", "publish", "feedback"]) expect(await authorize(action), action).toBe(403);
    for (const action of ["close", "control"]) expect(await authorize(action), action).toBe(200);
  });

  it("canvas closeout retry is a step of close, which a lowered owner may still do: it is not refused as new work", async () => {
    const h = await withKit();
    const { taskId } = await planWaiting(h);
    setGrant(h.db, KIT, "viewer");
    const answer = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/canvas-closeout/retry`, { requestId: randomUUID(), workflowRevision: 1 });
    expect((answer.body.error as { code?: string } | undefined)?.code).not.toBe("PROJECT_ACCESS_DENIED");
  });

  it("a parked plain task (no workflow) resumes when its creator is a contributor again, instead of only being cancellable", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workspaceId: string; workflow?: unknown };
    expect(task.workflow).toBeUndefined();
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === task.workspaceId)[0] as never;
    const outboxId = (record as { id: string }).id;
    setGrant(h.db, KIT, "viewer");
    expect(await guardTaskDispatch(guardDeps(h), record)).toBe("PARKED");
    // A viewer owner cannot continue it; once raised, continue brings the parked operation back instead of reporting the task busy.
    expect((await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Go on" })).status).toBe(403);
    setGrant(h.db, KIT, "contributor");
    const resumed = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Go on" });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(h.db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
  });

  // Task 22, folded in from the Task 21 re-check: a continue that resumes a parked plain task runs the ORIGINAL instructions (the parked operation is
  // redriven as it was; rewriting its stored invocation is not safe). The new instructions are not used, and the person is told so in the task's own
  // events, which every client (the app, the CLI, an AI tool) already shows, rather than in a field some of them drop.
  it("a continue that resumes a parked plain task says, in the task's events, that it resumed with the original instructions", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workspaceId: string };
    const record = h.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === task.workspaceId)[0] as never;
    setGrant(h.db, KIT, "viewer");
    expect(await guardTaskDispatch(guardDeps(h), record)).toBe("PARKED");
    setGrant(h.db, KIT, "contributor");
    const requestId = randomUUID();
    const resumed = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId, instructions: "Actually, also fix the timeout" });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const events = (resumed.body.task as { events: Array<{ kind: string; text: string }> }).events;
    expect(events).toContainEqual({ at: expect.any(String) as string, kind: "progress", text: RESUMED_ORIGINAL });
    // A repeat of the same request adds the note once.
    await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId, instructions: "Actually, also fix the timeout" });
    const stored = h.db.find((item) => item.entityType === "EVENT" && JSON.stringify(item.payload).includes("original instructions"));
    expect(stored).toHaveLength(1);
  });

  it("a continue that finds nothing parked says nothing about original instructions", async () => {
    const h = await withKit();
    const started = await h.dev(KIT, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workspaceId: string };
    const prepareId = String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, prepareId, "SUCCEEDED", PREPARED);
    const taskOperation = String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, taskOperation, "SUCCEEDED");
    const next = await h.dev(KIT, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Go on" });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(JSON.stringify(next.body)).not.toContain("original instructions");
  });
});
