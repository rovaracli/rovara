// Owner decision 2026-11-02: the one-time, per-company notice that reviews now use a model from a different company. Any member reads it; only an owner or admin dismisses it for the company; the dismissal is
// stored once per company and audited in the same transaction.
import { describe, expect, it } from "vitest";
import { ReviewDefaultNoticeAnswerReaderSchema, ReviewDefaultNoticeAnswerSchema, orgSettingsKey, type OrgId } from "../../packages/contracts/src/index.js";
import { dismissReviewDefaultNotice, readReviewDefaultNotice } from "../../packages/broker/src/model-selection/review-default-notice.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MEMBER = "c".repeat(64);
const who = (developerId: string, orgRole: string, orgId: OrgId = TEST_ORG) => ({ orgId, developerId, orgRole });
function setup(withAudit = true) {
  const db = new FakeDynamoDb(), clock = { ms: Date.parse("2026-11-02T12:00:00Z") };
  const audit = capturingAuditDeps({ db, now: () => clock.ms });
  const deps = { documentClient: db, tableName: "state", now: () => clock.ms, ...(withAudit ? { audit: audit.audit } : {}) };
  return { db, audit, deps };
}
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => ({ code: error.code }));

describe("the review-default notice", () => {
  it("is not dismissed at first; any member reads it, and only an owner or admin may dismiss", async () => {
    const s = setup();
    expect(await readReviewDefaultNotice(s.deps, who(MEMBER, "member"))).toEqual({ dismissed: false, canDismiss: false });
    expect(await readReviewDefaultNotice(s.deps, who(ADMIN, "admin"))).toEqual({ dismissed: false, canDismiss: true });
    expect(await readReviewDefaultNotice(s.deps, who(OWNER, "owner"))).toEqual({ dismissed: false, canDismiss: true });
    expect(ReviewDefaultNoticeAnswerSchema.safeParse({ dismissed: false, canDismiss: false }).success).toBe(true);
    expect(ReviewDefaultNoticeAnswerReaderSchema.safeParse({ dismissed: true, canDismiss: false, later: 1 }).success).toBe(true);
  });

  it("an admin's dismissal is stored once for the company and every member then sees it dismissed", async () => {
    const s = setup();
    expect(await dismissReviewDefaultNotice(s.deps, who(ADMIN, "admin"))).toEqual({ dismissed: true, canDismiss: true });
    expect(s.db.get(orgSettingsKey(TEST_ORG, "REVIEW_DEFAULT_NOTICE"))).toMatchObject({ orgId: TEST_ORG, dismissedBy: ADMIN });
    expect(await readReviewDefaultNotice(s.deps, who(MEMBER, "member"))).toEqual({ dismissed: true, canDismiss: false });
  });

  it("is per company: another company still sees it", async () => {
    const s = setup();
    await dismissReviewDefaultNotice(s.deps, who(OWNER, "owner"));
    expect(await readReviewDefaultNotice(s.deps, who(OWNER, "owner", OTHER_ORG))).toEqual({ dismissed: false, canDismiss: true });
    expect(s.db.get(orgSettingsKey(OTHER_ORG, "REVIEW_DEFAULT_NOTICE"))).toBeUndefined();
  });

  it("refuses a member, writing and auditing nothing", async () => {
    const s = setup();
    expect(await failure(dismissReviewDefaultNotice(s.deps, who(MEMBER, "member")))).toEqual({ code: "FORBIDDEN" });
    expect(s.db.get(orgSettingsKey(TEST_ORG, "REVIEW_DEFAULT_NOTICE"))).toBeUndefined();
    expect(s.audit.pending()).toEqual([]);
    expect(s.audit.flushed()).toEqual([]);
  });

  it("audits the dismissal once, as the person, on the company, with no facts; dismissing again audits nothing more", async () => {
    const s = setup();
    await dismissReviewDefaultNotice(s.deps, who(ADMIN, "admin"));
    await dismissReviewDefaultNotice(s.deps, who(OWNER, "owner"));
    const events = s.audit.flushed();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "review_default_notice.dismissed", orgId: TEST_ORG, target: { kind: "org", id: TEST_ORG }, actor: { kind: "member", id: ADMIN } });
    expect(events[0]!.facts ?? {}).toEqual({});
    expect(s.db.get(orgSettingsKey(TEST_ORG, "REVIEW_DEFAULT_NOTICE"))).toMatchObject({ dismissedBy: ADMIN });
  });

  it("writes the audit event in the dismissal's own transaction: with the queue down it waits in the outbox, never lost", async () => {
    const s = setup();
    s.audit.sqs.mode = "throw";
    expect(await dismissReviewDefaultNotice(s.deps, who(ADMIN, "admin"))).toEqual({ dismissed: true, canDismiss: true });
    expect(s.audit.pending()).toHaveLength(1);
    expect(s.audit.pending()[0]).toMatchObject({ action: "review_default_notice.dismissed", orgId: TEST_ORG });
  });

  it("does not dismiss without the audit ledger", async () => {
    const s = setup(false);
    expect(await failure(dismissReviewDefaultNotice(s.deps, who(ADMIN, "admin")))).toEqual({ code: "AUDIT_UNAVAILABLE" });
    expect(s.db.get(orgSettingsKey(TEST_ORG, "REVIEW_DEFAULT_NOTICE"))).toBeUndefined();
  });

  it("two admins dismissing at once leave one record and one audit event", async () => {
    const s = setup();
    const answers = await Promise.all([dismissReviewDefaultNotice(s.deps, who(ADMIN, "admin")), dismissReviewDefaultNotice(s.deps, who(OWNER, "owner"))]);
    expect(answers.every((answer) => answer.dismissed)).toBe(true);
    expect(s.audit.flushed()).toHaveLength(1);
  });
});

// ---- through the whole broker, with a live browser session ----
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { setupWizardBench } from "../support/setup-wizard-testenv.js";
const PATH = "/v1/app/org/review-default-notice";
describe("the route", () => {
  it("is browser-only, open to members for reading, and dismissed by an admin with one audit event; a member and a bad body are refused", async () => {
    const audit = capturingAuditDeps();
    const t = await setupWizardBench({ audit });
    await t.person(MAYA, "member");
    expect((await t.dev(MAYA, "GET", PATH)).status).toBe(403);
    expect((await t.dev(OMAR, "POST", PATH, { action: "dismiss" })).status).toBe(403);
    expect(await t.web(MAYA, "GET", PATH)).toMatchObject({ status: 200, body: { dismissed: false, canDismiss: false } });
    expect((await t.web(MAYA, "POST", PATH, { action: "dismiss" })).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "dismiss", extra: true })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, {})).status).toBe(400);
    expect(await t.web(OMAR, "POST", PATH, { action: "dismiss" })).toMatchObject({ status: 200, body: { dismissed: true } });
    expect(await t.web(MAYA, "GET", PATH)).toMatchObject({ status: 200, body: { dismissed: true, canDismiss: false } });
    expect(audit.recorded().filter((event) => event.action === "review_default_notice.dismissed")).toHaveLength(1);
  });
});
