// srv/needs-broker-ui-2 item 9: `GET /v1/app/org/approvals/pending-summary`. An org owner or admin (their role read from the member record now) sees how many approvals of THEIR company wait
// and the newest page of them, in the words of the confirmation page, with no subject, arguments, digest or diff. Everyone else is refused. The open index is one partition for every
// company on the install, so these tests hold two companies in it.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ORG_PENDING_APPROVALS_MAX, OrgPendingApprovalsSummaryReaderSchema, OrgPendingApprovalsSummarySchema, orgMemberKey } from "@agentx/cloud-contracts";
import { approvalKey, type OrgId } from "@rovara-code/contracts";
import {
  approvalTaskEventKey, createPendingChange, createStepApproval, createWriteApprovalRecord, getAnyApproval, type ApprovalDependencies, type WriteApprovalRecord,
} from "../../packages/broker/src/agents/approvals.js";
import { approvalDecideKind, confirmTitleOf, changeTitleOf, STEP_APPROVAL_TITLE, WRITE_APPROVAL_TITLE } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { orgAdminApprovers } from "../../packages/broker/src/agents/changes.js";
import { ORG_PENDING_SCAN_MAX, orgPendingApprovals } from "../../packages/broker/src/agents/org-pending-summary.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { ADA, BEN, CARL, DEB, ORG_B, person, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";

const BETH = person("6", "Beth Owner");
const PATH = "/v1/app/org/approvals/pending-summary";
const orgResolver: OrgResolver = async (subject) => (subject.developerId === BETH.developerId ? ORG_B : TEST_ORG);

async function world() {
  const t = await setup({ decide: true, orgResolver });
  const { db } = t;
  db.set({ pk: `SESSION#${BETH.sessionId}`, sk: "META", sessionId: BETH.sessionId, developerId: BETH.developerId, amr: BETH.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  db.set({ pk: `DEVELOPER#${BETH.developerId}`, sk: "META", developerId: BETH.developerId, provider: BETH.provider, displayName: BETH.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  await t.orgOf(BETH);
  seedMembership(db, BETH.developerId, { orgId: ORG_B, role: "owner" });
  const deps = t.deps() as ApprovalDependencies;
  const taskId = randomUUID();
  // Recent times, so nothing has expired by the real clock the route reads.
  let clock = Date.now() - 6 * 3_600_000;
  const tick = () => { clock += 60_000; return new Date(clock).toISOString(); };

  /** A change somebody asked for (a company admin decides it), in `orgId`, as `by`. */
  const change = async (orgId: OrgId = TEST_ORG, by = CARL.developerId, project = "payments") => {
    const record = await createPendingChange({ ...deps, now: () => clock }, {
      orgId, requestId: randomUUID(), requestedBy: by, subject: { kind: "code_settings", project, settingsRevision: 0, changes: { allowSelfApproval: true } },
      changes: [`Let a person approve a pull request that Rovara made for them, in project ${project}`], approvers: await orgAdminApprovers(deps, orgId),
    });
    clock += 60_000;
    return record;
  };
  let writes = 0;
  const write = async (orgId: OrgId = TEST_ORG, ownerOf = BEN) => {
    writes += 1;
    const approvalId = `apr_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const createdAt = tick();
    const record: WriteApprovalRecord = {
      orgId, approvalId, kind: "write", subject: { kind: "agent_run", taskId, stepId: `investigate-${String(writes)}` }, operationId: randomUUID(), connector: "linear", connectorType: "linear", tool: "save_issue", toolAccess: "write",
      scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: { title: "WRITE-ARGUMENT-SECRET" }, argumentsHash: "c".repeat(64), summary: "create the issue WRITE-SUMMARY",
      class: "consequential", approvers: { kind: "ids", ids: [ownerOf.developerId] }, status: "PENDING", project: "payments", owner: { developerId: ownerOf.developerId, name: ownerOf.name },
      attempts: 0, createdAt, expiresAt: new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString(),
    };
    const event = { Put: { TableName: "state", Item: { ...approvalTaskEventKey(taskId, createdAt, approvalId), entityType: "TASK_EVENT", orgId, kind: "status", text: "Agent wants to create the issue.", at: createdAt } } };
    expect(await createWriteApprovalRecord({ ...deps, now: () => clock }, record, [event], 8)).toBe("created");
    return record;
  };
  const step = async (orgId: OrgId = TEST_ORG) => createStepApproval({ ...deps, now: () => clock }, {
    orgId, subject: { kind: "agent_run", taskId: randomUUID(), stepId: "report" }, prompt: "Send the STEP-PROMPT report?", approvers: { kind: "ids", ids: [BEN.developerId] }, project: "payments",
    owner: { developerId: BEN.developerId, name: BEN.name }, expiresAt: new Date(clock + 30 * 86_400_000).toISOString(),
  });
  const get = (who: typeof ADA, path = PATH) => t.dev(who, "GET", path);
  return { ...t, approvals: deps, change, write, step, get };
}
const bodyOf = (reply: { body: Record<string, unknown> }) => { const { requestId: _id, ...rest } = reply.body; return rest; }; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id

describe("the company's pending approvals, at a glance", () => {
  it("shows an owner and an admin the count and the newest first, in the words of the confirmation page, with the page's own link", async () => {
    const t = await world();
    const first = await t.change(TEST_ORG, CARL.developerId);
    const second = await t.write();
    const third = await t.step();
    for (const who of [ADA, DEB]) {
      const reply = await t.get(who);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const answer = bodyOf(reply);
      expect(OrgPendingApprovalsSummarySchema.parse(answer)).toEqual(answer);
      expect(OrgPendingApprovalsSummaryReaderSchema.safeParse(answer).success).toBe(true);
      const summary = OrgPendingApprovalsSummarySchema.parse(answer);
      expect(summary.total).toBe(3);
      expect(summary.truncated).toBeUndefined();
      // Newest first, each with the title its confirmation page shows, who it names, when it was asked and the bare link.
      expect(summary.approvals.map((entry) => entry.approvalId)).toEqual([third.approvalId, second.approvalId, first.approvalId]);
      expect(summary.approvals.map((entry) => [entry.kind, entry.title])).toEqual([
        ["step", STEP_APPROVAL_TITLE], ["write", WRITE_APPROVAL_TITLE], ["change", changeTitleOf("code_settings")],
      ]);
      expect(summary.approvals[2]).toMatchObject({ subjectKind: "code_settings", proposedBy: "Carl Contributor", createdAt: first.createdAt, confirmUrl: expect.stringMatching(new RegExp(`/v1/app/approve/${first.approvalId}$`)) as string });
      expect(summary.approvals[1]).toMatchObject({ proposedBy: "Ben Maintainer", createdAt: second.createdAt });
      expect(summary.approvals[0]).toMatchObject({ proposedBy: "Ben Maintainer" });
      expect(summary.approvals[0]).not.toHaveProperty("subjectKind");
    }
  });

  it("uses the very title the confirmation page shows for each kind of approval", async () => {
    const t = await world();
    const records = [await t.change(), await t.write(), await t.step()];
    const kind = approvalDecideKind(t.approvals);
    const listed = (await t.get(ADA)).body.approvals as Array<{ approvalId: string; title: string }>;
    expect(listed).toHaveLength(3);
    for (const record of records) {
      // The page is open to whoever may decide it: an admin for a change, the run's owner for a write or a step.
      const inspected = await kind.inspect({ orgId: TEST_ORG, developerId: (record.kind === "change" ? ADA : BEN).developerId, approvalId: record.approvalId });
      const pageTitle = inspected.status === "open" ? inspected.view.title : undefined;
      expect(pageTitle, record.kind).toBeDefined();
      expect(listed.find((entry) => entry.approvalId === record.approvalId)?.title, record.kind).toBe(pageTitle);
      expect(confirmTitleOf(record as never)).toBe(pageTitle);
    }
  });

  it("holds no subject, arguments, digest, diff, prompt, summary or project in the answer", async () => {
    const t = await world();
    await t.change();
    await t.write();
    await t.step();
    const text = JSON.stringify((await t.get(ADA)).body);
    for (const leak of ["WRITE-ARGUMENT-SECRET", "WRITE-SUMMARY", "STEP-PROMPT", "argumentsHash", "arguments", "schemaHash", "scopeDigest", "digest", "payments", "settingsRevision", "changes", "approvers", "subject\"", "expiresAt", "Let a person approve"]) {
      expect(text, leak).not.toContain(leak);
    }
    // Positive control: the same records do hold those words, so the answer is what leaves them out.
    const stored = JSON.stringify(t.db.find((item) => String(item.pk).includes("#APPROVAL#")));
    expect(stored).toContain("WRITE-ARGUMENT-SECRET");
  });

  it("lists only the first page of the newest, with the count of everything waiting", async () => {
    const t = await world();
    const made: string[] = [];
    for (let n = 0; n < ORG_PENDING_APPROVALS_MAX + 3; n += 1) made.push((await t.write()).approvalId);
    const summary = OrgPendingApprovalsSummarySchema.parse(bodyOf(await t.get(DEB)));
    expect(summary.total).toBe(ORG_PENDING_APPROVALS_MAX + 3);
    expect(summary.approvals).toHaveLength(ORG_PENDING_APPROVALS_MAX);
    expect(summary.approvals.map((entry) => entry.approvalId)).toEqual(made.slice(3).reverse());
  });

  it("refuses everyone who is not an org owner or admin, and says nothing of what waits", async () => {
    const t = await world();
    await t.change();
    await t.write();
    for (const who of [BEN, CARL]) {
      const reply = await t.get(who);
      expect(reply.status, who.name).toBe(403);
      expect(JSON.stringify(reply.body), who.name).not.toMatch(/apr_|total|approvals"/);
    }
    // A viewer, a contributor or a maintainer of a project is still only a member of the company (BEN maintains payments).
    expect((await t.get(ADA)).status).toBe(200);
  });

  it("reads the role from the member record now: a demoted admin is refused, a promoted member is let in, a removed one is not found", async () => {
    const t = await world();
    await t.change();
    expect((await t.get(DEB)).status).toBe(200);
    seedMembership(t.db, DEB.developerId, { orgId: TEST_ORG, role: "member" });
    expect((await t.get(DEB)).status).toBe(403);
    seedMembership(t.db, CARL.developerId, { orgId: TEST_ORG, role: "admin" });
    expect((await t.get(CARL)).status).toBe(200);
    t.db.delete(orgMemberKey(TEST_ORG, CARL.developerId));
    expect((await t.get(CARL)).status).not.toBe(200);
  });

  it("judges the live role even when the caller object (the token's view) says admin", async () => {
    const t = await world();
    await t.change();
    const deps = t.approvals;
    // Carl is a member on record: a caller that still claims "admin" gets nothing, and Ada (owner on record) gets the list whatever her caller says.
    await expect(orgPendingApprovals(deps, { orgId: TEST_ORG, developerId: CARL.developerId, orgRole: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await orgPendingApprovals(deps, { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "member" })).total).toBe(1);
  });

  it("is the caller's own company only: another company's approvals are not listed or counted, and ours are not shown to it", async () => {
    const t = await world();
    const ours = [await t.change(), await t.write(), await t.step()];
    const theirs = [await t.change(ORG_B, BETH.developerId), await t.write(ORG_B), await t.step(ORG_B)];
    const mine = OrgPendingApprovalsSummarySchema.parse(bodyOf(await t.get(ADA)));
    expect(mine.total).toBe(3);
    expect(mine.approvals.map((entry) => entry.approvalId).sort()).toEqual(ours.map((record) => record.approvalId).sort());
    const beth = await t.get(BETH);
    expect(beth.status, JSON.stringify(beth.body)).toBe(200);
    const hers = OrgPendingApprovalsSummarySchema.parse(bodyOf(beth));
    expect(hers.total).toBe(3);
    expect(hers.approvals.map((entry) => entry.approvalId).sort()).toEqual(theirs.map((record) => record.approvalId).sort());
    // An index item of ours that names the other company's approval (a stale or forged one) counts nothing and shows nothing.
    const orgBApproval = theirs[0]!;
    t.db.set({ pk: "OPEN_APPROVALS", sk: `${orgBApproval.createdAt}#${TEST_ORG}#${orgBApproval.approvalId}`, entityType: "OPEN_APPROVAL", orgId: TEST_ORG, approvalId: orgBApproval.approvalId });
    expect(OrgPendingApprovalsSummarySchema.parse(bodyOf(await t.get(ADA))).total).toBe(3);
  });

  it("counts only approvals still waiting: not one that was decided, one that has expired, or one whose record is gone", async () => {
    const t = await world();
    const live = await t.change();
    const decided = await t.write();
    const expired = await t.change(TEST_ORG, CARL.developerId, "web");
    const record = (id: string) => t.db.get(approvalKey(TEST_ORG, id))!;
    t.db.set({ ...record(decided.approvalId), status: "DECLINED" });
    t.db.set({ ...record(expired.approvalId), expiresAt: new Date(Date.now() - 1000).toISOString() });
    const summary = OrgPendingApprovalsSummarySchema.parse(bodyOf(await t.get(ADA)));
    expect(summary.approvals.map((entry) => entry.approvalId)).toEqual([live.approvalId]);
    expect(summary.total).toBe(1);
    expect(await getAnyApproval(t.approvals, TEST_ORG, decided.approvalId as never)).toMatchObject({ status: "DECLINED" });
  });

  it("is read-only: it writes nothing, and answers only GET", async () => {
    const t = await world();
    await t.change();
    const before = JSON.stringify(t.db.find(() => true));
    expect((await t.get(ADA)).status).toBe(200);
    expect(JSON.stringify(t.db.find(() => true))).toBe(before);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await t.dev(ADA, method, PATH, {})).status, method).toBe(404);
    expect(JSON.stringify(t.db.find(() => true))).toBe(before);
  });

  it("says so when the open index is longer than one request reads", async () => {
    const t = await world();
    const mine = await t.change();
    // Other companies' items fill the index ahead of ours (it is in expiry order): the scan is bounded, and the answer says the count may be short.
    for (let n = 0; n < ORG_PENDING_SCAN_MAX + 5; n += 1) {
      const id = `apr_${String(n).padStart(20, "0")}`;
      t.db.set({ pk: "OPEN_APPROVALS", sk: `2026-01-01T00:00:00.000Z#${ORG_B}#${id}`, entityType: "OPEN_APPROVAL", orgId: ORG_B, approvalId: id });
    }
    // Every read of an approval record is counted: another company's items are skipped on the index item alone, so no record is read for any of them.
    const recordReads: string[] = [];
    const original = t.db.send.bind(t.db) as (command: unknown) => Promise<unknown>;
    (t.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      const input = (command as { input?: { Key?: { pk?: unknown } } }).input;
      if (typeof input?.Key?.pk === "string" && input.Key.pk.includes("#APPROVAL#")) recordReads.push(input.Key.pk);
      return original(command);
    };
    const summary = OrgPendingApprovalsSummarySchema.parse(bodyOf(await t.get(ADA)));
    expect(summary.truncated).toBe(true);
    expect(summary.total).toBe(0);
    expect(summary.approvals).toEqual([]);
    expect(recordReads).toEqual([]);
    // Positive control: with the scan not full, our own approval's record is read (the counter sees reads).
    for (let n = 0; n < ORG_PENDING_SCAN_MAX + 5; n += 1) t.db.delete({ pk: "OPEN_APPROVALS", sk: `2026-01-01T00:00:00.000Z#${ORG_B}#apr_${String(n).padStart(20, "0")}` });
    expect(OrgPendingApprovalsSummarySchema.parse(bodyOf(await t.get(ADA))).total).toBe(1);
    expect(recordReads.length).toBeGreaterThan(0);
    expect(mine.status).toBe("PENDING");
  });
});
