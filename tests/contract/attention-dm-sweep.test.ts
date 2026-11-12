import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createNotifierHandler, deliverAttentionDm } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { SlackPostError } from "../../packages/broker/src/aws/slack-web.js";
import { noticesOf, type Notice } from "../../packages/broker/src/developer/notifications.js";
import { ATTENTION_DM_MAX_AGE_MS, ATTENTION_DM_REQUEUE_AFTER_MS } from "../../packages/broker/src/notifications/attention-dm-limits.js";
import { ATTENTION_DM_REQUEUE_BATCH_MAX, attentionDmCheck, readAttentionDmProblems, sweepAttentionDms } from "../../packages/broker/src/notifications/attention-dm-sweep.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { enforceRolePolicy, notifierStatements, patternsOf, type Statement } from "../support/notifier-role-policy.js";
import { TEST_ORG } from "../support/orgs.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// Found live on staging, 2026-11-12: attention direct messages that failed at delivery (a missing IAM grant for an hour) were dropped by the notifier after its one-hour retry window, nothing queued them again, and the
// row stayed PENDING until the table expired it. The broker's session sweep now puts such a row in front of the notifier again (under 24 hours old), marks an older one MISSED (never sent), and a dropped message leaves a durable
// record on its row that Health counts. The post itself stays behind the row's claim (PENDING, SENDING, SENT), so it is never sent twice.

skipLambdaBundling();

const statements = notifierStatements();
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
const iso = (ms: number) => new Date(ms).toISOString();
const grantsKey = (statement: Statement, key: string) => { const patterns = patternsOf(statement); return patterns !== "any" && patterns !== "unreadable" && patterns.includes(key); };

function world() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const logs: Array<Record<string, unknown>> = [];
  const sent: Array<{ channel: string; text: string }> = [];
  const slack = { fail: undefined as Error | undefined };
  const post = vi.fn(async (input: { channel: string; text: string }) => {
    if (slack.fail !== undefined) throw slack.fail;
    sent.push(input);
    return { ts: "1.2", channel: "D0X" };
  });
  const failures = vi.fn();
  const retries: number[] = [];
  /** The notifier under its real IAM policy (optionally without the NOTIFY_DM grant: the staging failure). */
  const notifier = (options: { withoutDmGrant?: boolean } = {}) => {
    const policy = options.withoutDmGrant === true ? statements.filter((statement) => !grantsKey(statement, "NOTIFY_DM")) : statements;
    const denied: string[] = [];
    const handler = createNotifierHandler({ documentClient: enforceRolePolicy({ send: (command: never) => db.send(command) }, policy, denied), tableName: "state", enqueue: async () => undefined,
      retryLater: async (_handle, seconds) => { retries.push(seconds); }, post, now: () => clock.now, log: (entry) => { logs.push(entry); }, deliveryFailed: failures, reviewUrlBase: "https://agentx.example.test" });
    const deliver = (notice: Notice, messageId = "m1") => handler({ Records: [{ eventSource: "aws:sqs", messageId, receiptHandle: "r", body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } }] });
    return { deliver, denied };
  };
  const dmRow = (extra: Record<string, unknown> = {}, orgId: string = TEST_ORG, at = clock.now) => {
    const sk = `${orgId}#dev${String(db.items.size)}#${iso(at)}`;
    db.set({ pk: "NOTIFY_DM", sk, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId, slackUserId: "U0MEMBER01", text: "A task needs your attention", at: iso(at), indexExpiresAt: Math.floor(at / 1000) + 172_800, ...extra });
    return sk;
  };
  const sweep = (extra: { deadlineMs?: number } = {}) => sweepAttentionDms({ documentClient: db, tableName: "state", now: () => clock.now, log: (entry) => { logs.push(entry); } }, extra);
  const row = (sk: string) => db.get("NOTIFY_DM", sk) as Record<string, unknown>;
  /** What the table's stream hands the notifier for a change of the row. */
  const streamNotices = (before: Record<string, unknown> | undefined, sk: string) => noticesOf(before, structuredClone(row(sk)), iso(clock.now), "stream");
  return { db, clock, logs, sent, slack, post, failures, retries, notifier, dmRow, sweep, row, streamNotices };
}

describe("a stranded attention message is delivered by the sweep", () => {
  const causes: Array<[string, (w: ReturnType<typeof world>) => { fail: () => ReturnType<ReturnType<typeof world>["notifier"]>; recover: () => void }]> = [
    ["a missing DynamoDB grant (AccessDenied)", (w) => ({ fail: () => w.notifier({ withoutDmGrant: true }), recover: () => undefined })],
    ["a Slack error", (w) => ({ fail: () => { w.slack.fail = new SlackPostError("ratelimited"); return w.notifier(); }, recover: () => { w.slack.fail = undefined; } })],
  ];
  it.each(causes)("%s: the notifier gives up after an hour, the cause is mended, the sweep sends exactly one message and the row ends SENT", async (_name, make) => {
    const w = world();
    const cause = make(w);
    const sk = w.dmRow();
    const [first] = w.streamNotices(undefined, sk);
    expect(first).toMatchObject({ kind: "attention_dm", attentionKey: sk });
    const failing = cause.fail();
    // Inside the hour the notice is retried; past it, it is dropped (not a batch failure) and nothing is sent.
    expect((await failing.deliver(first!)).batchItemFailures).toHaveLength(1);
    w.clock.now = T0 + HOUR + 60_000;
    expect((await failing.deliver(first!)).batchItemFailures).toEqual([]);
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.delivery_failed", kind: "attention_dm" }));
    expect(w.sent).toEqual([]);
    expect(w.row(sk)).toMatchObject({ status: "PENDING" });
    // The sweep leaves it alone until it is past the notifier's window (plus a margin) ...
    expect(await w.sweep()).toMatchObject({ requeued: 0, missed: 0 });
    cause.recover();
    // ... and then requeues it; the row's change reaches the notifier as a fresh notice.
    w.clock.now = T0 + ATTENTION_DM_REQUEUE_AFTER_MS + 60_000;
    const before = structuredClone(w.row(sk));
    expect(await w.sweep()).toMatchObject({ read: 1, requeued: 1, missed: 0 });
    const notices = w.streamNotices(before, sk);
    expect(notices).toEqual([expect.objectContaining({ kind: "attention_dm", attentionKey: sk, id: `attention_dm:${sk}:requeue1` })]);
    const healthy = w.notifier();
    await healthy.deliver(notices[0]!);
    expect(healthy.denied).toEqual([]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ channel: "U0MEMBER01", text: "A task needs your attention" });
    expect(w.row(sk)).toMatchObject({ status: "SENT" });
    // Nothing is left to sweep, and a later sweep sends nothing more.
    w.clock.now += 3 * HOUR;
    expect(await w.sweep()).toMatchObject({ requeued: 0, missed: 0 });
    expect(w.sent).toHaveLength(1);
  });

  it("two sweeps at once requeue the row once, and two notices at once post once", async () => {
    const w = world();
    const sk = w.dmRow();
    w.clock.now = T0 + ATTENTION_DM_REQUEUE_AFTER_MS + 60_000;
    const before = structuredClone(w.row(sk));
    const [a, b] = await Promise.all([w.sweep(), w.sweep()]);
    expect(a.requeued + b.requeued).toBe(1);
    expect(w.row(sk)).toMatchObject({ resweepCount: 1, status: "PENDING" });
    const [notice] = w.streamNotices(before, sk);
    const healthy = w.notifier();
    // Even if the notifier is handed the notice twice (a repeated stream record, or two requeues), the claim lets one through.
    await Promise.all([healthy.deliver(notice!, "m1"), healthy.deliver(notice!, "m2")]);
    expect(w.sent).toHaveLength(1);
    expect(w.row(sk)).toMatchObject({ status: "SENT" });
  });

  it("a row requeued once is not requeued again until its window passes, and each requeue is its own notice", async () => {
    const w = world();
    const sk = w.dmRow();
    w.clock.now = T0 + ATTENTION_DM_REQUEUE_AFTER_MS + 1;
    await w.sweep();
    w.clock.now += 30 * 60_000;
    expect(await w.sweep()).toMatchObject({ requeued: 0 });
    const before = structuredClone(w.row(sk));
    w.clock.now += ATTENTION_DM_REQUEUE_AFTER_MS;
    expect(await w.sweep()).toMatchObject({ requeued: 1 });
    expect(w.streamNotices(before, sk)).toEqual([expect.objectContaining({ id: `attention_dm:${sk}:requeue2` })]);
    // A change of the row that is not a requeue (a claim, a failure record) says nothing to the notifier.
    expect(noticesOf(structuredClone(w.row(sk)), { ...w.row(sk), status: "PENDING", lastFailedAt: iso(w.clock.now) }, iso(w.clock.now), "s")).toEqual([]);
  });

  it("a requeue sends at most 25 rows a sweep, oldest first, and a row still inside the notifier's window is left alone", async () => {
    const w = world();
    const skews = Array.from({ length: ATTENTION_DM_REQUEUE_BATCH_MAX + 5 }, (_, n) => w.dmRow({}, TEST_ORG, T0 + n * 1000));
    w.clock.now = T0 + ATTENTION_DM_REQUEUE_AFTER_MS + 60_000;
    const fresh = w.dmRow({}, TEST_ORG, w.clock.now - 10 * 60_000);
    const outcome = await w.sweep();
    expect(outcome).toMatchObject({ requeued: ATTENTION_DM_REQUEUE_BATCH_MAX, missed: 0 });
    expect(skews.slice(0, ATTENTION_DM_REQUEUE_BATCH_MAX).every((sk) => w.row(sk).resweepCount === 1)).toBe(true);
    expect(skews.slice(ATTENTION_DM_REQUEUE_BATCH_MAX).every((sk) => w.row(sk).resweepCount === undefined)).toBe(true);
    expect(w.row(fresh).resweepCount).toBeUndefined();
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "attention_dm.swept", requeued: ATTENTION_DM_REQUEUE_BATCH_MAX, waiting: 5 }));
  });
});

describe("a message older than 24 hours is not sent", () => {
  it("the sweep marks it MISSED, sends nothing, the notifier refuses it, and Health counts it", async () => {
    const w = world();
    const sk = w.dmRow({}, TEST_ORG, T0);
    const young = w.dmRow({}, TEST_ORG, T0 + 20 * HOUR);
    w.clock.now = T0 + ATTENTION_DM_MAX_AGE_MS + 60_000;
    const before = structuredClone(w.row(sk));
    expect(await w.sweep()).toMatchObject({ missed: 1, requeued: 1 });
    expect(w.row(sk)).toMatchObject({ status: "MISSED", missedAt: iso(w.clock.now) });
    // A change to MISSED reaches the notifier as nothing, and a notice for it posts nothing.
    expect(w.streamNotices(before, sk)).toEqual([]);
    const healthy = w.notifier();
    await healthy.deliver({ id: `attention_dm:${sk}`, kind: "attention_dm", at: iso(w.clock.now), attentionKey: sk });
    expect(w.sent).toEqual([]);
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.notice", noticeId: `attention_dm:${sk}`, outcome: "missed" }));
    // The younger row is the only one the sweep put in front of the notifier; the missed row is kept two days more for Health.
    expect(w.row(young).resweepCount).toBe(1);
    expect(w.row(sk).indexExpiresAt).toBe(Math.floor(w.clock.now / 1000) + 172_800);
    const problems = await readAttentionDmProblems({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, TEST_ORG);
    expect(problems).toMatchObject({ missed: 1 });
    expect(attentionDmCheck(problems)).toMatchObject({ status: "warn", detail: expect.stringContaining("1 Slack message was not sent") as string });
  });

  it("the notifier also refuses a PENDING row that old when the sweep has not run yet", async () => {
    const w = world();
    const sk = w.dmRow({}, TEST_ORG, T0);
    w.clock.now = T0 + ATTENTION_DM_MAX_AGE_MS + 1;
    const outcome = await deliverAttentionDm({ documentClient: w.db, tableName: "state", now: () => w.clock.now, post: w.post } as never, { id: "n", kind: "attention_dm", at: iso(w.clock.now), attentionKey: sk });
    expect(outcome).toBe("stale");
    expect(w.sent).toEqual([]);
    expect(w.row(sk).status).toBe("PENDING");
  });

  it("Home's Needs you is read from the tasks, never from these rows, so a missed message still shows there", () => {
    for (const file of ["packages/broker/src/agent-sessions/home.ts", "packages/ui/src/screens/home/HomeV2.tsx", "packages/ui/src/screens/home/home-rows.ts"]) {
      expect(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), file).not.toMatch(/NOTIFY_DM|TASK_ATTENTION_DM/u);
    }
  });
});

describe("a dropped message with no task leaves a durable record", () => {
  it("the notifier records it on the message's own row (keyed by its attentionKey), once, and Health counts it", async () => {
    const w = world();
    w.slack.fail = new SlackPostError("channel_not_found");
    const sk = w.dmRow();
    const [notice] = w.streamNotices(undefined, sk);
    expect(notice!.taskId).toBeUndefined();
    const failing = w.notifier();
    // Still inside the hour: retried, no record yet.
    await failing.deliver(notice!);
    expect(w.row(sk).deliveryFailedAt).toBeUndefined();
    w.clock.now = T0 + HOUR + 60_000;
    await failing.deliver(notice!);
    expect(w.row(sk)).toMatchObject({ status: "PENDING", deliveryFailedAt: iso(w.clock.now), lastFailedAt: iso(w.clock.now), failureReason: "channel_not_found", failureCount: 1, abandonedAt: iso(w.clock.now) });
    expect(w.failures).toHaveBeenCalledTimes(1);
    // A second drop (after a requeue) keeps the first time and counts again; the reason is a fixed code, never free text.
    w.clock.now += 2 * HOUR;
    w.slack.fail = Object.assign(new Error("xoxb secret text"), { name: "bad reason with spaces" });
    await failing.deliver(notice!);
    expect(w.row(sk)).toMatchObject({ deliveryFailedAt: iso(T0 + HOUR + 60_000), lastFailedAt: iso(w.clock.now), failureReason: "unknown", failureCount: 2 });
    expect(JSON.stringify(w.row(sk))).not.toContain("xoxb");
    const problems = await readAttentionDmProblems({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, TEST_ORG);
    expect(problems).toMatchObject({ stranded: 1, missed: 0 });
    expect(attentionDmCheck(problems)).toMatchObject({ status: "warn", detail: expect.stringMatching(/1 Slack message has not been delivered and is being retried; latest /u) as string });
    // Once it is sent, it is no longer a problem.
    w.slack.fail = undefined;
    await w.notifier().deliver(notice!);
    expect(w.row(sk).status).toBe("SENT");
    expect(await readAttentionDmProblems({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, TEST_ORG)).toMatchObject({ stranded: 0, missed: 0 });
  });

  it("a stranded row Health counts even when the notifier could not write its record (the same missing grant)", async () => {
    const w = world();
    const sk = w.dmRow();
    const [notice] = w.streamNotices(undefined, sk);
    const failing = w.notifier({ withoutDmGrant: true });
    w.clock.now = T0 + HOUR + 60_000;
    await failing.deliver(notice!);
    expect(w.row(sk).deliveryFailedAt).toBeUndefined();
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.failure_record_failed", kind: "attention_dm" }));
    w.clock.now = T0 + ATTENTION_DM_REQUEUE_AFTER_MS + 1;
    expect(await readAttentionDmProblems({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, TEST_ORG)).toMatchObject({ stranded: 1 });
  });

  it("GET /v1/admin/health shows the count (and nothing when every message went out)", async () => {
    const { db, admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: {} } } });
    expect((await admin("GET", "/v1/admin/health")).body).not.toHaveProperty("attentionDmCheck");
    const now = Date.now();
    const put = (orgId: string, n: number, extra: Record<string, unknown>) => db.set({ pk: "NOTIFY_DM", sk: `${orgId}#d${String(n)}#x`, entityType: "TASK_ATTENTION_DM", orgId, slackUserId: "U0MEMBER01", text: "t", at: iso(now - 2 * HOUR), ...extra });
    put(TEST_ORG, 1, { status: "PENDING", deliveryFailedAt: iso(now - HOUR), lastFailedAt: iso(now - HOUR) });
    put(TEST_ORG, 2, { status: "MISSED", missedAt: iso(now - HOUR) });
    put(TEST_ORG, 3, { status: "SENT" });
    put(OTHER_ORG, 4, { status: "MISSED", missedAt: iso(now - HOUR) });
    put(OTHER_ORG, 5, { status: "MISSED", missedAt: iso(now - HOUR) });
    const body = (await admin("GET", "/v1/admin/health")).body;
    expect(body.attentionDmCheck).toMatchObject({ status: "warn", detail: expect.stringContaining("1 Slack message has not been delivered") as string });
    expect(String((body.attentionDmCheck as { detail: string }).detail)).toContain("1 Slack message was not sent");
  });
});

describe("company isolation", () => {
  it("the sweep acts only on well formed rows of their own company, and Health reads one company's rows only", async () => {
    const w = world();
    const own = w.dmRow({}, TEST_ORG, T0);
    const other = w.dmRow({}, OTHER_ORG, T0);
    // A row whose sort key does not begin with its own orgId is never acted on (skipped, not requeued, not marked).
    w.db.set({ pk: "NOTIFY_DM", sk: `${OTHER_ORG}#forged#1`, entityType: "TASK_ATTENTION_DM", status: "PENDING", orgId: TEST_ORG, slackUserId: "U0MEMBER01", text: "t", at: iso(T0) });
    w.clock.now = T0 + ATTENTION_DM_REQUEUE_AFTER_MS + 60_000;
    expect(await w.sweep()).toMatchObject({ requeued: 2, skipped: 1 });
    expect(w.db.get("NOTIFY_DM", `${OTHER_ORG}#forged#1`)).not.toHaveProperty("resweepCount");
    expect(w.row(own).resweepCount).toBe(1);
    expect(w.row(other).resweepCount).toBe(1);
    w.clock.now = T0 + ATTENTION_DM_MAX_AGE_MS + HOUR;
    await w.sweep();
    const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
    expect(await readAttentionDmProblems(table, TEST_ORG)).toMatchObject({ missed: 1, stranded: 0 });
    expect(await readAttentionDmProblems(table, OTHER_ORG)).toMatchObject({ missed: 1, stranded: 0 });
    // The forged row (sk of the other company, orgId of this one) counts for neither.
    expect(await readAttentionDmProblems(table, "org_cccccccccccccccccccc")).toEqual({ missed: 0, stranded: 0 });
  });
});
