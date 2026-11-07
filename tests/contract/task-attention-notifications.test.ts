// UX2 slice 2 item 5 (OWNER DECISION 4): every event that needs a person reaches them, for web-started tasks and followers too. Who is told (recipients), how (their choice, default Slack when linked,
// else email; email only through the existing sign-in notice sender), how often (one message per person per batching window), what may be in it (the title, the status sentence and the task's
// link on the configured origin, nothing else), and that a person who can no longer read the task is never told.
import { describe, expect, it } from "vitest";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { agentSessionKey, NOTIFY_BATCH_MINUTES, effectiveNotify, type AgentSessionRecord, type OrgId, type SessionSummary } from "../../packages/contracts/src/index.js";
import { ATTENTION_CHANNEL_TRIES_MAX, ATTENTION_DM_PK, ATTENTION_RETRY_BASE_MS, attentionEmail, deliverAttention, queueAttention, writePrefs, type AttentionDeliveryDependencies } from "../../packages/broker/src/notifications/attention.js";
import { deliverAttentionDm } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { noticesOf } from "../../packages/broker/src/developer/notifications.js";
import type { SessionChange } from "../../packages/broker/src/agent-sessions/notice-sink.js";
import { ARJUN, CELL, MIA, ORG_A, PRIYA, T0, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const SECRET_STEP = ["sk", "live", "PLANTED", "step"].join("_");

function setup() {
  const w = sessionWorld();
  w.clock.now = T0;
  const seeded = w.seedSession({ owner: PRIYA });
  const metaKey = agentSessionKey(ORG_A, seeded.sessionId, "META");
  const setSummary = (summary: Partial<SessionSummary> & { display?: unknown }) => {
    const meta = w.db.get(metaKey) as Item & { summary: Item };
    w.db.set({ ...meta, title: "Fix duplicate refunds", summary: { ...meta.summary, step: SECRET_STEP, peek: SECRET_STEP, ...summary } });
    return w.db.get(metaKey) as unknown as AgentSessionRecord;
  };
  const change = (previous: Partial<SessionSummary> & { display?: unknown }, next: Partial<SessionSummary> & { display?: unknown }): SessionChange => {
    const session = setSummary(next);
    const { display: _shown, ...base } = session.summary as SessionSummary & { display?: unknown }; void _shown;
    return { orgId: ORG_A, sessionId: seeded.sessionId, session, previous: { ...base, display: { state: "building" }, ...previous }, summary: session.summary, summaryRevision: 2, statusChanged: true, stepChanged: false, ended: false, at: new Date(w.clock.now).toISOString() };
  };
  const sent: Array<{ to: string[]; subject: string; text: string; html?: unknown; from: string }> = [];
  const ses = { send: async (command: unknown) => {
    const input = (command as SendEmailCommand).input;
    sent.push({ to: input.Destination?.ToAddresses ?? [], subject: input.Content?.Simple?.Subject?.Data ?? "", text: input.Content?.Simple?.Body?.Text?.Data ?? "", html: input.Content?.Simple?.Body?.Html, from: input.FromEmailAddress ?? "" });
    return {};
  } };
  const readers = new Set<string>([PRIYA, ARJUN, MIA]);
  const people: Record<string, { email?: string; slackUserId?: string }> = { [PRIYA]: { email: "priya@example.com" }, [ARJUN]: { email: "arjun@example.com", slackUserId: "U0ARJUN01" }, [MIA]: { email: "mia@example.com" } };
  const deps = (extra: Partial<AttentionDeliveryDependencies> = {}): AttentionDeliveryDependencies => ({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, origin: CELL,
    person: async (developerId) => people[developerId],
    access: async (_orgId: OrgId, developerId) => (readers.has(developerId) ? { owner: developerId === PRIYA } : undefined),
    email: { ses, from: "Rovara <notices@example.com>" }, log: () => undefined, ...extra,
  });
  const pending = () => w.db.find((item) => item["pk"] === "NOTIFY_PENDING");
  const dms = () => w.db.find((item) => item["pk"] === ATTENTION_DM_PK);
  return { w, seeded, setSummary, change, sent, readers, people, deps, pending, dms };
}

const blocked = { status: "needs_person" as const, display: { state: "needs_you", reason: "The checks didn't pass or couldn't run", next: "Send it back to coding." } };

describe("who is told", () => {
  it("queues the owner and the people the summary names for a task that now needs someone, once per person, for a web-started task with no Slack thread", async () => {
    const t = setup();
    expect(await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA, ARJUN] }), T0)).toBe(2);
    expect(t.pending().map((row) => row["developerId"]).sort()).toEqual([PRIYA, ARJUN].sort());
    expect(t.pending().every((row) => row["kind"] === "needs_you" && row["orgId"] === ORG_A)).toBe(true);
    // Nothing is queued when the state didn't change, nor for a state nobody is told about.
    expect(await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ ...blocked }, { ...blocked }), T0)).toBe(0);
    expect(await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "starting" }, { status: "running", display: { state: "building" } }), T0)).toBe(0);
  });

  it("tells followers when a task is done or failed, and a budget pause reaches whoever can raise the limit", async () => {
    const t = setup();
    t.w.follower(ORG_A, t.seeded.sessionId, MIA);
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "waiting" }, { status: "succeeded", display: { state: "merged" } }), T0);
    expect(t.pending().map((row) => `${String(row["developerId"])}:${String(row["kind"])}`).sort()).toEqual([`${MIA}:done`, `${PRIYA}:done`].sort());
    const p = setup();
    await queueAttention({ documentClient: p.w.db, tableName: "state" }, p.change({ status: "running" }, { status: "paused", needsPeople: [ARJUN], display: { state: "paused_budget", reason: "it reached its spending limit" } }), T0);
    expect(p.pending().map((row) => row["developerId"]).sort()).toEqual([PRIYA, ARJUN].sort());
  });
});

describe("how and how often", () => {
  it("emails a person without Slack (the default), direct-messages a person with Slack, through the existing sender only, and batches a busy task", async () => {
    const t = setup();
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA, ARJUN] }), T0);
    const first = await deliverAttention(t.deps());
    expect(first).toMatchObject({ people: 2, emails: 1, slack: 1 });
    expect(t.sent.map((mail) => mail.to)).toEqual([["priya@example.com"]]);
    expect(t.sent[0]!.from).toBe("Rovara <notices@example.com>");
    expect(t.dms()).toHaveLength(1);
    expect(t.dms()[0]).toMatchObject({ entityType: "TASK_ATTENTION_DM", status: "PENDING", slackUserId: "U0ARJUN01" });
    expect(t.pending()).toHaveLength(0);
    // The notifier reads the row once, when it is written; the notice holds no text.
    const notices = noticesOf(undefined, t.dms()[0]!, "2026-10-22T09:00:00.000Z", "e1");
    expect(notices).toEqual([expect.objectContaining({ kind: "attention_dm", attentionKey: t.dms()[0]!["sk"] })]);
    expect(JSON.stringify(notices)).not.toContain("Fix duplicate refunds");
    // Within the batching window a new event waits; after it, one message carries what is still current.
    t.w.clock.now += 60_000;
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { status: "waiting", display: { state: "ready_to_merge", next: "Press Merge in Rovara." } }), t.w.clock.now);
    expect(await deliverAttention(t.deps())).toMatchObject({ people: 0, emails: 0 });
    expect(t.pending()).toHaveLength(1);
    t.w.clock.now += NOTIFY_BATCH_MINUTES * 60_000;
    expect(await deliverAttention(t.deps())).toMatchObject({ people: 1, emails: 1 });
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.text).toContain("Fix duplicate refunds: Ready to merge");
  });

  it("follows the person's choice and the unsubscribe, falls back to Slack where email can't be sent, and sends no email where no sender is configured", async () => {
    expect(effectiveNotify({ channel: "email", slackLinked: true, emailAvailable: false, emailUnsubscribed: false })).toEqual({ slack: true, email: false });
    expect(effectiveNotify({ channel: "both", slackLinked: true, emailAvailable: true, emailUnsubscribed: true })).toEqual({ slack: true, email: false });
    expect(effectiveNotify({ channel: "email", slackLinked: false, emailAvailable: true, emailUnsubscribed: true })).toEqual({ slack: false, email: false });
    const t = setup();
    await writePrefs({ documentClient: t.w.db, tableName: "state", now: () => T0 }, ORG_A, ARJUN, { channel: "email" });
    await writePrefs({ documentClient: t.w.db, tableName: "state", now: () => T0 }, ORG_A, PRIYA, { channel: "email", emailUnsubscribed: true });
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA, ARJUN] }), T0);
    await deliverAttention(t.deps());
    // Arjun chose email; Priya unsubscribed and has no Slack, so nothing reaches her (Home still lists it).
    expect(t.sent.map((mail) => mail.to)).toEqual([["arjun@example.com"]]);
    expect(t.dms()).toHaveLength(0);
    const n = setup();
    await queueAttention({ documentClient: n.w.db, tableName: "state" }, n.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA, ARJUN] }), T0);
    const { email: _none, ...noSender } = n.deps(); void _none;
    expect(await deliverAttention(noSender)).toMatchObject({ emails: 0, slack: 1 });
    expect(n.sent).toHaveLength(0);
  });
});

describe("no leakage", () => {
  it("holds only the title, the status sentence and the task's link on the configured origin, as plain text, with change and stop links", async () => {
    const t = setup();
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    await deliverAttention(t.deps());
    const mail = t.sent[0]!;
    expect(mail.html).toBeUndefined();
    expect(mail.text).not.toContain(SECRET_STEP);
    expect(mail.text).not.toContain("arjun@example.com");
    expect(mail.text).toBe(attentionEmail([{ title: "Fix duplicate refunds", status: "Needs you: the checks didn't pass or couldn't run", link: `${CELL}/app/sessions/${t.seeded.sessionId}` }], 0, CELL).text);
    const links = mail.text.match(/https?:\/\/\S+/gu) ?? [];
    expect(links.length).toBe(3);
    expect(links.every((link) => link.startsWith(`${CELL}/app/`))).toBe(true);
    expect(mail.text).toContain(`${CELL}/app/account#notifications`);
    expect(mail.text).toContain(`${CELL}/app/account?notify=unsubscribe#notifications`);
  });

  it("never tells a person who can no longer read the task (positive control: one who can is told), and sends nothing on an origin that is not plain https", async () => {
    const t = setup();
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA, MIA] }), T0);
    t.readers.delete(MIA);
    const outcome = await deliverAttention(t.deps());
    expect(t.sent.map((mail) => mail.to)).toEqual([["priya@example.com"]]);
    expect(outcome.dropped).toBe(1);
    expect(t.pending()).toHaveLength(0);
    const h = setup();
    await queueAttention({ documentClient: h.w.db, tableName: "state" }, h.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    expect(await deliverAttention(h.deps({ origin: "http://cell.example.com" }))).toMatchObject({ emails: 0, slack: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it("drops a row the task has moved past (a later state supersedes it)", async () => {
    const t = setup();
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    t.setSummary({ status: "running", display: { state: "building" } });
    expect(await deliverAttention(t.deps())).toMatchObject({ emails: 0, dropped: 1 });
  });
});

describe("review fixes", () => {
  it("I3: a summary written before the status model counts as unchanged on its first refresh (no re-notify after the deploy)", async () => {
    const t = setup();
    expect(await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "needs_person", display: undefined }, { ...blocked, needsPeople: [PRIYA] }), T0)).toBe(0);
    expect(t.pending()).toHaveLength(0);
    // Positive control: the same change from a summary that has the field is told.
    expect(await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0)).toBe(1);
  });

  it("I5: an ended session is never told as needing someone, and a row for one is dropped", async () => {
    const t = setup();
    const ended = t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] });
    expect(await queueAttention({ documentClient: t.w.db, tableName: "state" }, { ...ended, session: { ...ended.session, endedAt: new Date(T0).toISOString() } }, T0)).toBe(0);
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, ended, T0);
    const meta = t.w.db.get(agentSessionKey(ORG_A, t.seeded.sessionId, "META")) as Item;
    t.w.db.set({ ...meta, endedAt: new Date(T0).toISOString() });
    expect(await deliverAttention(t.deps())).toMatchObject({ emails: 0, slack: 0, dropped: 1 });
  });

  it("I1: a failing email never holds back the Slack message, is tried again after a growing wait, gives up after the last try, and a sent email is never sent again", async () => {
    const t = setup();
    t.people[PRIYA] = { email: "priya@example.com", slackUserId: "U0PRIYA01" };
    await writePrefs({ documentClient: t.w.db, tableName: "state", now: () => T0 }, ORG_A, PRIYA, { channel: "both" });
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    let sesCalls = 0;
    const failing = { send: async () => { sesCalls += 1;throw Object.assign(new Error("rejected"), { name: "MessageRejected" }); } };
    expect(await deliverAttention(t.deps({ email: { ses: failing, from: "Rovara <notices@example.com>" } }))).toMatchObject({ slack: 1, emails: 0, failed: 1 });
    expect(t.dms()).toHaveLength(1);
    expect(t.pending()).toHaveLength(1);
    // Within the wait nothing is tried again, and Slack is not sent twice.
    t.w.clock.now += NOTIFY_BATCH_MINUTES * 60_000 + 1;
    expect(await deliverAttention(t.deps({ email: { ses: failing, from: "x@example.com" } }))).toMatchObject({ slack: 0, emails: 0 });
    expect(sesCalls).toBe(2);
    expect(t.dms()).toHaveLength(1);
    for (let attempt = 3; attempt <= ATTENTION_CHANNEL_TRIES_MAX; attempt += 1) {
      t.w.clock.now += ATTENTION_RETRY_BASE_MS * 2 ** (attempt - 1) + NOTIFY_BATCH_MINUTES * 60_000;
      await deliverAttention(t.deps({ email: { ses: failing, from: "x@example.com" } }));
    }
    expect(sesCalls).toBe(ATTENTION_CHANNEL_TRIES_MAX);
    // It gave up: the row is gone and nothing is tried again.
    expect(t.pending()).toHaveLength(0);
    t.w.clock.now += 86_400_000;
    await deliverAttention(t.deps({ email: { ses: failing, from: "x@example.com" } }));
    expect(sesCalls).toBe(ATTENTION_CHANNEL_TRIES_MAX);
  });

  it("I1: an email that went out is not sent again when the Slack message fails", async () => {
    const t = setup();
    t.people[PRIYA] = { email: "priya@example.com", slackUserId: "U0PRIYA01" };
    await writePrefs({ documentClient: t.w.db, tableName: "state", now: () => T0 }, ORG_A, PRIYA, { channel: "both" });
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    t.w.db.injectFault({ command: "PutCommand", match: (input) => (input["Item"] as Item | undefined)?.["entityType"] === "TASK_ATTENTION_DM", error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    expect(await deliverAttention(t.deps())).toMatchObject({ emails: 1, slack: 0, failed: 1 });
    expect(t.pending()[0]).toMatchObject({ emailSent: true });
    t.w.clock.now += NOTIFY_BATCH_MINUTES * 60_000 + ATTENTION_RETRY_BASE_MS;
    expect(await deliverAttention(t.deps())).toMatchObject({ emails: 0, slack: 1 });
    expect(t.sent).toHaveLength(1);
    expect(t.pending()).toHaveLength(0);
  });

  it("I2: pages the queue, leaves out expired rows, and people inside their window never use up the sweep's places", async () => {
    const t = setup();
    // 45 people were told a minute ago and have rows waiting; they sort first.
    for (let n = 0; n < 45; n += 1) {
      const id = String(n).padStart(2, "0").padEnd(64, "0");
      t.w.db.set({ pk: `NOTIFY_SENT#${ORG_A}`, sk: `DEV#${id}`, entityType: "NOTIFY_SENT", orgId: ORG_A, developerId: id, lastAt: T0 - 60_000 });
      t.readers.add(id);t.people[id] = { email: `p${String(n)}@example.com` };
      t.w.db.set({ pk: "NOTIFY_PENDING", sk: `${ORG_A}#${id}#${t.seeded.sessionId}#needs_you`, entityType: "NOTIFY_PENDING", orgId: ORG_A, developerId: id, sessionId: t.seeded.sessionId, kind: "needs_you", at: new Date(T0).toISOString() });
    }
    // And 300 rows of sessions that are gone, also before Priya's row.
    for (let n = 0; n < 300; n += 1) {
      const id = "0".repeat(60) + String(n).padStart(4, "0");
      t.w.db.set({ pk: "NOTIFY_PENDING", sk: `${ORG_A}#${id}#ses_x${String(n).padStart(19, "0")}#needs_you`, entityType: "NOTIFY_PENDING", orgId: ORG_A, developerId: id, sessionId: `ses_x${String(n).padStart(19, "0")}`, kind: "needs_you", at: new Date(T0).toISOString() });
    }
    // An expired row of Mia's is never delivered.
    t.w.db.set({ pk: "NOTIFY_PENDING", sk: `${ORG_A}#${MIA}#${t.seeded.sessionId}#needs_you`, entityType: "NOTIFY_PENDING", orgId: ORG_A, developerId: MIA, sessionId: t.seeded.sessionId, kind: "needs_you", at: new Date(T0).toISOString(), indexExpiresAt: Math.floor(T0 / 1000) - 1 });
    t.setSummary(blocked);
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    await deliverAttention(t.deps());
    expect(t.sent.map((mail) => mail.to)).toEqual([["priya@example.com"]]);
    // The 45 inside their window keep their rows for a later sweep.
    expect(t.pending().filter((row) => row["sessionId"] === t.seeded.sessionId && row["developerId"] !== MIA)).toHaveLength(45);
  });

  it("I2: stops starting new people once the sweep's time budget is spent", async () => {
    const t = setup();
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    expect(await deliverAttention(t.deps(), { deadlineMs: T0 - 1 })).toMatchObject({ people: 0, emails: 0 });
    expect(t.pending()).toHaveLength(1);
  });

  it("M5: the email carries a List-Unsubscribe header to the account page's stop link", async () => {
    const t = setup();
    const headers: unknown[] = [];
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    await deliverAttention(t.deps({ email: { ses: { send: async (command: unknown) => { headers.push((command as SendEmailCommand).input.Content?.Simple?.Headers);return {}; } }, from: "x@example.com" } }));
    expect(headers).toEqual([[{ Name: "List-Unsubscribe", Value: `<${CELL}/app/account?notify=unsubscribe#notifications>` }]]);
  });

  it("M1: a redelivered direct-message notice posts once", async () => {
    const t = setup();
    t.people[PRIYA] = { slackUserId: "U0PRIYA01" };
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    await deliverAttention(t.deps());
    const sk = String(t.dms()[0]!["sk"]);
    const posts: unknown[] = [];
    const deps = { documentClient: t.w.db, tableName: "state", now: () => T0, post: async (input: unknown) => { posts.push(input);return { ts: "1.1" }; } } as never;
    const notice = { id: `attention_dm:${sk}`, kind: "attention_dm" as const, at: new Date(T0).toISOString(), attentionKey: sk };
    expect(await Promise.all([deliverAttentionDm(deps, notice), deliverAttentionDm(deps, notice)])).toEqual(expect.arrayContaining(["sent", "already_sent"]));
    expect(await deliverAttentionDm(deps, notice)).toBe("already_sent");
    expect(posts).toHaveLength(1);
    expect(t.dms()[0]).toMatchObject({ status: "SENT" });
  });

  it("N1: people whose every channel waits for a retry take no place: with 45 of them, a healthy person is told in the same sweep", async () => {
    const t = setup();
    for (let n = 0; n < 45; n += 1) {
      const id = `${String(n).padStart(2, "0")}${"0".repeat(62)}`;
      t.readers.add(id);t.people[id] = { email: `p${String(n)}@example.com` };
      t.w.db.set({ pk: `NOTIFY_SENT#${ORG_A}`, sk: `DEV#${id}`, entityType: "NOTIFY_SENT", orgId: ORG_A, developerId: id, lastAt: 0, emailFailures: 2, emailRetryAt: T0 + 3_600_000, waitUntil: T0 + 3_600_000 });
      t.w.db.set({ pk: "NOTIFY_PENDING", sk: `${ORG_A}#${id}#${t.seeded.sessionId}#needs_you`, entityType: "NOTIFY_PENDING", orgId: ORG_A, developerId: id, sessionId: t.seeded.sessionId, kind: "needs_you", at: new Date(T0 - 60_000).toISOString() });
    }
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    await deliverAttention(t.deps());
    expect(t.sent.map((mail) => mail.to)).toEqual([["priya@example.com"]]);
  });

  it("N1: a person whose only channel failed is marked as waiting until its retry", async () => {
    const t = setup();
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    await deliverAttention(t.deps({ email: { ses: { send: async () => { throw Object.assign(new Error("x"), { name: "MessageRejected" }); } }, from: "x@example.com" } }));
    expect(t.w.db.get({ pk: `NOTIFY_SENT#${ORG_A}`, sk: `DEV#${PRIYA}` })).toMatchObject({ emailFailures: 1, waitUntil: T0 + ATTENTION_RETRY_BASE_MS });
  });

  it("N2: an email SES accepted is never sent again when its sent-mark fails to write", async () => {
    const t = setup();
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    t.w.db.injectFault({ command: "UpdateCommand", match: (input) => String(input["UpdateExpression"]).startsWith("SET emailSent"), error: { name: "ProvisionedThroughputExceededException" }, times: 5 });
    expect(await deliverAttention(t.deps())).toMatchObject({ emails: 1 });
    t.w.clock.now += NOTIFY_BATCH_MINUTES * 60_000 + 1;
    await deliverAttention(t.deps());
    expect(t.sent).toHaveLength(1);
  });

  it("N3: a direct-message claim that was never finished expires and is never posted (a live one is left alone)", async () => {
    const t = setup();
    t.people[PRIYA] = { slackUserId: "U0PRIYA01" };
    await queueAttention({ documentClient: t.w.db, tableName: "state" }, t.change({ status: "running" }, { ...blocked, needsPeople: [PRIYA] }), T0);
    await deliverAttention(t.deps());
    const row = t.dms()[0]!;
    const posts: unknown[] = [];
    let now = T0;
    const deps = { documentClient: t.w.db, tableName: "state", now: () => now, post: async (input: unknown) => { posts.push(input);return { ts: "1.1" }; } } as never;
    const notice = { id: `attention_dm:${String(row["sk"])}`, kind: "attention_dm" as const, at: new Date(T0).toISOString(), attentionKey: String(row["sk"]) };
    t.w.db.set({ ...row, status: "SENDING", claimUntil: T0 + 30_000 });
    expect(await deliverAttentionDm(deps, notice)).toBe("claimed");
    now = T0 + 31_000;
    expect(await deliverAttentionDm(deps, notice)).toBe("unknown");
    expect(await deliverAttentionDm(deps, notice)).toBe("already_sent");
    expect(posts).toHaveLength(0);
  });
});
