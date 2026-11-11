// Plan 5 Task 1: the agent session contracts: ids, limits, records, events, views, keys and error codes.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { atLeast, newPrefixedId } from "../../packages/contracts/src/agent-node.js";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  AgentSessionRecordSchema,
  DEVICE_LABEL_MAX,
  DeviceIdSchema,
  ENDED_SESSION_STATUSES,
  LEVEL_WORDS,
  LOCAL_TOOLS,
  SESSION_EVENT_TEXT_MAX,
  SESSION_KINDS,
  SESSION_LEGS_MAX,
  SESSION_MODES,
  SESSION_PEEK_MAX_CHARS,
  SESSION_STATUSES,
  STATUS_WORDS,
  SessionBindingSchema,
  SessionOwnerSchema,
  cleanSessionName,
  SessionEventSchema,
  SessionIdSchema,
  SessionLegSchema,
  SessionMessageIdSchema,
  SessionMessageSchema,
  SessionSubjectSchema,
  SessionSummarySchema,
  SessionWhereSchema,
  localAgentsNotAllowedOnProjectMessage,
  localToolNotAllowedMessage,
  sessionEventId,
  sessionLevelRequiredMessage,
  sessionLink,
  sessionOnMacMessage,
  sessionViewerOnlyMessage,
  SESSION_ENDED_MESSAGE,
  SESSION_REVISION_CONFLICT_MESSAGE,
} from "../../packages/contracts/src/agent-sessions-node.js";
import { AgentXErrorCodeSchema, agentXError, errorStatus } from "../../packages/contracts/src/errors.js";
import {
  SESSION_SWEEP_CURSOR_KEY,
  agentSessionKey,
  changesKey,
  deviceCommandKey,
  deviceKey,
  endedSessionWorkKey,
  liveSessionKey,
  memberDevicesKey,
  mySessionsKey,
  openAgentSessionKey,
  sessionQueuedSteersKey,
  orgSettingsKey,
  projectMonthStatsKey,
  projectSessionsKey,
  sessionEventSk,
  sessionRateKey,
  sessionRequestKey,
  sessionBindingKey,
  sessionSurfaceKey,
  sharedSessionsKey,
  taskSpendKey,
} from "../../packages/contracts/src/org-scoped-keys.js";
import { HomeCardReaderSchema, HomeCardSchema, HomeResponseReaderSchema, HomeResponseSchema } from "../../packages/contracts/src/home.js";
import { OrgIdSchema } from "../../packages/contracts/src/org-node.js";
import {
  NeedsConfirmationSchema,
  ProjectOverviewReaderSchema,
  ProjectOverviewSchema,
  SessionEventPageReaderSchema,
  SessionEventPageSchema,
  SessionEventReaderSchema,
  SessionTileReaderSchema,
  SessionTileSchema,
  SessionViewReaderSchema,
  SessionViewSchema,
} from "../../packages/contracts/src/session-views.js";
import * as contracts from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG_A = OrgIdSchema.parse("org_aaaaaaaaaaaaaaaaaaaa");
const ORG_B = OrgIdSchema.parse("org_bbbbbbbbbbbbbbbbbbbb");
const DEV = "a".repeat(64);
const SESSION = "ses_0123456789abcdefghij";
const CHAIN_RUN = "crn_0123456789abcdefghij";
const DEVICE = "dvc_0123456789abcdefghij";
const MESSAGE = "msg_0123456789abcdefghij";
const TASK = "5c2f4f0e-2d7e-4a53-9a3c-2f1d0f6f6b11";
const NOW = "2026-10-22T09:30:00.000Z";
const LATER = "2026-10-22T09:31:00.000Z";

const summary = {
  status: "running",
  step: "Writing the migration",
  peek: "npm test",
  costUsd: 1.25,
  needsPeople: [],
  pendingApprovals: 0,
  digest: "d".repeat(64),
  computedAt: NOW,
};

const record = {
  orgId: ORG_A,
  sessionId: SESSION,
  kind: "task",
  mode: "delegate",
  subject: { kind: "task", taskId: TASK },
  legs: [{ seq: 1, subject: { kind: "task", taskId: TASK }, where: { kind: "cloud" }, startedAt: NOW }],
  where: { kind: "cloud" },
  project: "web",
  agent: { agentId: "rovara-code", name: "Rovara Code", version: 3 },
  title: "Bump the Stripe SDK",
  owner: { developerId: DEV, name: "Priya" },
  startedBy: { kind: "member", developerId: DEV },
  origin: "app",
  followerCount: 0,
  summary,
  summaryRevision: 1,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const view = {
  contractVersion: AGENT_SESSION_CONTRACT_VERSION,
  sessionId: SESSION,
  kind: "task",
  mode: "delegate",
  title: "Bump the Stripe SDK",
  owner: { developerId: DEV, name: "Priya" },
  startedBy: { kind: "member", developerId: DEV },
  where: { kind: "cloud" },
  status: "running",
  step: "Writing the migration",
  cost: { spentUsd: 1.25, payer: { kind: "member", name: "Priya" } },
  approvals: [],
  followers: 1,
  viewingNow: [],
  you: { level: "view", owner: false, following: true, actions: ["watch", "comment"] },
  link: `https://app.rovara.example/app/sessions/${SESSION}`,
  bindings: [],
  legs: [],
  revision: 2,
  createdAt: NOW,
  updatedAt: LATER,
  body: { kind: "local", tool: "claude-code" },
};

const tile = {
  contractVersion: AGENT_SESSION_CONTRACT_VERSION,
  sessionId: SESSION,
  kind: "task",
  title: "Bump the Stripe SDK",
  owner: { developerId: DEV, name: "Priya" },
  where: { kind: "cloud" },
  level: "view",
  revision: 2,
  summary,
  createdAt: NOW,
  updatedAt: LATER,
};

const event = { eventId: sessionEventId("comment", MESSAGE), at: NOW, type: "comment", text: "Looks good" };

describe("session ids", () => {
  it("accepts a ses_ id from newPrefixedId and a Plan 4 chain run id, and refuses agent ids and task UUIDs", () => {
    expect(SessionIdSchema.safeParse(newPrefixedId("ses")).success).toBe(true);
    expect(SessionIdSchema.safeParse(CHAIN_RUN).success).toBe(true);
    expect(SessionIdSchema.safeParse(newPrefixedId("agt")).success).toBe(false);
    expect(SessionIdSchema.safeParse(TASK).success).toBe(false);
    expect(SessionIdSchema.safeParse("ses_short").success).toBe(false);
    expect(SessionIdSchema.safeParse(`${SESSION}x`).success).toBe(false);
    expect(SessionIdSchema.safeParse(SESSION.toUpperCase()).success).toBe(false);
  });

  it("makes device and message ids with their own prefixes", () => {
    expect(DeviceIdSchema.safeParse(newPrefixedId("dvc")).success).toBe(true);
    expect(SessionMessageIdSchema.safeParse(newPrefixedId("msg")).success).toBe(true);
    expect(DeviceIdSchema.safeParse(newPrefixedId("msg")).success).toBe(false);
    expect(SessionMessageIdSchema.safeParse(newPrefixedId("dvc")).success).toBe(false);
    expect(SessionIdSchema.safeParse(newPrefixedId("dvc")).success).toBe(false);
  });

  it("makes a stable event id that differs by kind and by occurrence", () => {
    expect(sessionEventId("comment", "msg_x")).toBe(sessionEventId("comment", "msg_x"));
    expect(sessionEventId("comment", "msg_x")).not.toBe(sessionEventId("steer", "msg_x"));
    expect(sessionEventId("comment", "msg_x")).not.toBe(sessionEventId("comment", "msg_y"));
    expect(sessionEventId("comment", "msg_x")).toMatch(/^evt_[0-9a-f]{24}$/);
    // The kind and the occurrence are separated by a newline, so moving a character between them changes the id.
    expect(sessionEventId("ab", "c")).not.toBe(sessionEventId("a", "bc"));
  });

  it("builds a link from the origin and the session id", () => {
    expect(sessionLink("https://app.rovara.example", SESSION)).toBe(`https://app.rovara.example/app/sessions/${SESSION}`);
    expect(sessionLink("https://app.rovara.example/", SESSION)).toBe(`https://app.rovara.example/app/sessions/${SESSION}`);
  });
});

describe("the fixed words and limits", () => {
  it("pins the kinds, statuses, modes, tools and their words", () => {
    expect(AGENT_SESSION_CONTRACT_VERSION).toBe(1);
    expect(SESSION_KINDS).toEqual(["task", "chain", "local"]);
    expect(SESSION_STATUSES).toEqual(["starting", "running", "needs_person", "paused", "waiting", "stopped", "succeeded", "failed", "cancelled"]);
    expect(ENDED_SESSION_STATUSES).toEqual(["succeeded", "failed", "cancelled"]);
    expect(SESSION_MODES).toEqual(["delegate"]);
    expect(LOCAL_TOOLS).toEqual(["rovara", "claude-code", "codex", "gemini-cli", "cursor-cli"]);
    expect(STATUS_WORDS).toEqual({ waiting: "Waiting for you", stopped: "Stopped", paused: "Paused for budget", needs_person: "Needs a person" });
    expect(LEVEL_WORDS).toEqual({ view: "can view", use: "can use", edit: "can edit" });
    for (const ended of ENDED_SESSION_STATUSES) expect(SESSION_STATUSES).toContain(ended);
  });

  it("pins the limits the plan names", async () => {
    const limits = await import("../../packages/contracts/src/agent-sessions-node.js");
    expect({
      SESSION_TITLE_MAX: limits.SESSION_TITLE_MAX,
      SESSION_PEEK_MAX_CHARS: limits.SESSION_PEEK_MAX_CHARS,
      SESSION_EVENT_TEXT_MAX: limits.SESSION_EVENT_TEXT_MAX,
      SESSION_EVENTS_PAGE_MAX: limits.SESSION_EVENTS_PAGE_MAX,
      SESSION_MESSAGE_MAX_CHARS: limits.SESSION_MESSAGE_MAX_CHARS,
      SESSION_MESSAGES_MAX: limits.SESSION_MESSAGES_MAX,
      STEER_RATE: limits.STEER_RATE,
      SESSION_SHARES_MAX: limits.SESSION_SHARES_MAX,
      LOCAL_REGISTER_SHARES_MAX: limits.LOCAL_REGISTER_SHARES_MAX,
      SESSION_FOLLOWERS_MAX: limits.SESSION_FOLLOWERS_MAX,
      PRESENCE_TTL_SECONDS: limits.PRESENCE_TTL_SECONDS,
      PRESENCE_HEARTBEAT_SECONDS: limits.PRESENCE_HEARTBEAT_SECONDS,
      LIVE_ENDED_KEEP_HOURS: limits.LIVE_ENDED_KEEP_HOURS,
      LIVE_PAGE_MAX: limits.LIVE_PAGE_MAX,
      LIVE_INDEX_SCAN_MAX: limits.LIVE_INDEX_SCAN_MAX,
      HOME_CARDS_MAX: limits.HOME_CARDS_MAX,
      HOME_CARD_BUTTONS_MAX: limits.HOME_CARD_BUTTONS_MAX,
      HOME_FAILURE_DAYS: limits.HOME_FAILURE_DAYS,
      SESSION_RETENTION_DAYS: limits.SESSION_RETENTION_DAYS,
      CHANGES_FEED_DAYS: limits.CHANGES_FEED_DAYS,
      CHANGES_PAGE_MAX: limits.CHANGES_PAGE_MAX,
      CHANGES_SETTLE_MS: limits.CHANGES_SETTLE_MS,
      SESSION_SWEEP_PAGE: limits.SESSION_SWEEP_PAGE,
      SESSION_SWEEP_BUDGET_MS: limits.SESSION_SWEEP_BUDGET_MS,
      PROJECTOR_SESSIONS_PER_BATCH_MAX: limits.PROJECTOR_SESSIONS_PER_BATCH_MAX,
      PROJECTOR_CONCURRENCY: limits.PROJECTOR_CONCURRENCY,
      REALTIME_EVENTS_PER_PUBLISH: limits.REALTIME_EVENTS_PER_PUBLISH,
      REALTIME_PUBLISH_DEADLINE_MS: limits.REALTIME_PUBLISH_DEADLINE_MS,
      REALTIME_TOKEN_SECONDS: limits.REALTIME_TOKEN_SECONDS,
      LOCAL_HEARTBEAT_SECONDS: limits.LOCAL_HEARTBEAT_SECONDS,
      LOCAL_OFFLINE_MINUTES: limits.LOCAL_OFFLINE_MINUTES,
      LOCAL_UPDATE_TURNS_MAX: limits.LOCAL_UPDATE_TURNS_MAX,
      LOCAL_TURN_MAX_CHARS: limits.LOCAL_TURN_MAX_CHARS,
      LOCAL_TURNS_MAX: limits.LOCAL_TURNS_MAX,
      DEVICE_LABEL_MAX: limits.DEVICE_LABEL_MAX,
      DEVICES_PER_MEMBER_MAX: limits.DEVICES_PER_MEMBER_MAX,
      HANDOFF_SUMMARY_MAX_BYTES: limits.HANDOFF_SUMMARY_MAX_BYTES,
      SESSION_LEGS_MAX: limits.SESSION_LEGS_MAX,
    }).toEqual({
      SESSION_TITLE_MAX: 200,
      SESSION_PEEK_MAX_CHARS: 280,
      SESSION_EVENT_TEXT_MAX: 500,
      SESSION_EVENTS_PAGE_MAX: 200,
      SESSION_MESSAGE_MAX_CHARS: 2000,
      SESSION_MESSAGES_MAX: 1000,
      STEER_RATE: { perPersonPerHour: 20, perSessionPerHour: 60 },
      SESSION_SHARES_MAX: 50,
      LOCAL_REGISTER_SHARES_MAX: 10,
      SESSION_FOLLOWERS_MAX: 200,
      PRESENCE_TTL_SECONDS: 90,
      PRESENCE_HEARTBEAT_SECONDS: 30,
      LIVE_ENDED_KEEP_HOURS: 24,
      LIVE_PAGE_MAX: 100,
      LIVE_INDEX_SCAN_MAX: 1000,
      HOME_CARDS_MAX: 10,
      HOME_CARD_BUTTONS_MAX: 3,
      HOME_FAILURE_DAYS: 7,
      SESSION_RETENTION_DAYS: 365,
      CHANGES_FEED_DAYS: 7,
      CHANGES_PAGE_MAX: 500,
      CHANGES_SETTLE_MS: 30000,
      SESSION_SWEEP_PAGE: 100,
      SESSION_SWEEP_BUDGET_MS: 20000,
      PROJECTOR_SESSIONS_PER_BATCH_MAX: 100,
      PROJECTOR_CONCURRENCY: 8,
      REALTIME_EVENTS_PER_PUBLISH: 5,
      REALTIME_PUBLISH_DEADLINE_MS: 1000,
      REALTIME_TOKEN_SECONDS: 900,
      LOCAL_HEARTBEAT_SECONDS: 60,
      LOCAL_OFFLINE_MINUTES: 10,
      LOCAL_UPDATE_TURNS_MAX: 40,
      LOCAL_TURN_MAX_CHARS: 4000,
      LOCAL_TURNS_MAX: 2000,
      DEVICE_LABEL_MAX: 60,
      DEVICES_PER_MEMBER_MAX: 10,
      HANDOFF_SUMMARY_MAX_BYTES: 8192,
      SESSION_LEGS_MAX: 20,
    });
  });

  it("orders the session levels with the agent access levels", () => {
    expect(atLeast("edit", "use")).toBe(true);
    expect(atLeast("view", "use")).toBe(false);
  });
});

describe("the session record and its parts", () => {
  it("accepts a task session and a chain session record", () => {
    expect(AgentSessionRecordSchema.safeParse(record).success).toBe(true);
    const chain = {
      ...record,
      sessionId: CHAIN_RUN,
      kind: "chain",
      subject: { kind: "chain", chainRunId: CHAIN_RUN },
      legs: [],
      agent: undefined,
      startedBy: { kind: "schedule", triggerId: "ctr_0123456789abcdefghij" },
      origin: "schedule",
      payer: { kind: "project", project: "web" },
      retryOf: "ses_aaaaaaaaaaaaaaaaaaaa",
    };
    delete (chain as { agent?: unknown }).agent;
    expect(AgentSessionRecordSchema.safeParse(chain).success).toBe(true);
  });

  it("accepts a local session on a Mac with no project and a draft agent", () => {
    const local = {
      ...record,
      kind: "local",
      subject: { kind: "local", deviceId: DEVICE, tool: "claude-code" },
      where: { kind: "mac", deviceId: DEVICE, label: "Priya's MacBook" },
      legs: [],
      agent: { agentId: "rovara-code", name: "Rovara Code", version: "draft" },
      startedBy: { kind: "local" },
      origin: "local",
    };
    delete (local as { project?: unknown }).project;
    expect(AgentSessionRecordSchema.safeParse(local).success).toBe(true);
  });

  it("refuses an unknown field, an unknown status and 21 legs", () => {
    expect(AgentSessionRecordSchema.safeParse({ ...record, surprise: true }).success).toBe(false);
    expect(AgentSessionRecordSchema.safeParse({ ...record, summary: { ...summary, status: "frozen" } }).success).toBe(false);
    const leg = (seq: number) => ({ seq, subject: record.subject, where: { kind: "cloud" }, startedAt: NOW });
    const legs = (count: number) => Array.from({ length: count }, (_, index) => leg(index + 1));
    expect(AgentSessionRecordSchema.safeParse({ ...record, legs: legs(SESSION_LEGS_MAX) }).success).toBe(true);
    expect(AgentSessionRecordSchema.safeParse({ ...record, legs: legs(SESSION_LEGS_MAX + 1) }).success).toBe(false);
  });

  it("refuses a mode other than delegate, a bad id and a title over its limit", () => {
    expect(AgentSessionRecordSchema.safeParse({ ...record, mode: "pair" }).success).toBe(false);
    expect(AgentSessionRecordSchema.safeParse({ ...record, sessionId: "agt_0123456789abcdefghij" }).success).toBe(false);
    expect(AgentSessionRecordSchema.safeParse({ ...record, title: "t".repeat(200) }).success).toBe(true);
    expect(AgentSessionRecordSchema.safeParse({ ...record, title: "t".repeat(201) }).success).toBe(false);
    expect(AgentSessionRecordSchema.safeParse({ ...record, title: "" }).success).toBe(false);
    expect(AgentSessionRecordSchema.safeParse({ ...record, origin: "carrier-pigeon" }).success).toBe(false);
  });

  it("takes a subject of each kind and refuses a mismatched or loose one", () => {
    expect(SessionSubjectSchema.safeParse({ kind: "task", taskId: TASK }).success).toBe(true);
    expect(SessionSubjectSchema.safeParse({ kind: "chain", chainRunId: CHAIN_RUN }).success).toBe(true);
    expect(SessionSubjectSchema.safeParse({ kind: "local", deviceId: DEVICE, tool: "codex" }).success).toBe(true);
    expect(SessionSubjectSchema.safeParse({ kind: "task", taskId: "not-a-uuid" }).success).toBe(false);
    expect(SessionSubjectSchema.safeParse({ kind: "chain", chainRunId: SESSION }).success).toBe(false);
    expect(SessionSubjectSchema.safeParse({ kind: "local", deviceId: DEVICE, tool: "emacs" }).success).toBe(false);
    expect(SessionSubjectSchema.safeParse({ kind: "task", taskId: TASK, extra: 1 }).success).toBe(false);
  });

  it("takes a Mac label up to its limit, counting characters", () => {
    const mac = (label: string) => SessionWhereSchema.safeParse({ kind: "mac", deviceId: DEVICE, label }).success;
    expect(SessionWhereSchema.safeParse({ kind: "cloud" }).success).toBe(true);
    expect(mac("a".repeat(DEVICE_LABEL_MAX))).toBe(true);
    expect(mac("a".repeat(DEVICE_LABEL_MAX + 1))).toBe(false);
    // 60 emoji are 120 UTF-16 units but 60 characters.
    expect(mac("😀".repeat(DEVICE_LABEL_MAX))).toBe(true);
    expect(mac("")).toBe(false);
    expect(mac("bad\u0000label")).toBe(false);
  });

  it("takes a leg that ends by a handoff or an end, and refuses another reason", () => {
    const leg = { seq: 1, subject: record.subject, where: { kind: "cloud" }, startedAt: NOW };
    expect(SessionLegSchema.safeParse(leg).success).toBe(true);
    expect(SessionLegSchema.safeParse({ ...leg, endedAt: LATER, endedBy: "handoff" }).success).toBe(true);
    expect(SessionLegSchema.safeParse({ ...leg, endedAt: LATER, endedBy: "end" }).success).toBe(true);
    expect(SessionLegSchema.safeParse({ ...leg, endedAt: LATER, endedBy: "crash" }).success).toBe(false);
    expect(SessionLegSchema.safeParse({ ...leg, seq: 1.5 }).success).toBe(false);
  });

  it("limits a summary's peek, people and cost, and refuses unknown fields", () => {
    const parse = (change: object) => SessionSummarySchema.safeParse({ ...summary, ...change }).success;
    expect(parse({})).toBe(true);
    expect(parse({ peek: "p".repeat(SESSION_PEEK_MAX_CHARS) })).toBe(true);
    expect(parse({ peek: "p".repeat(SESSION_PEEK_MAX_CHARS + 1) })).toBe(false);
    expect(parse({ peek: "😀".repeat(SESSION_PEEK_MAX_CHARS) })).toBe(true);
    expect(parse({ peek: "line one\nline two" })).toBe(true);
    expect(parse({ peek: "bad\u0000peek" })).toBe(false);
    expect(parse({ needsPeople: Array.from({ length: 50 }, (_, index) => `p${String(index)}`) })).toBe(true);
    expect(parse({ needsPeople: Array.from({ length: 51 }, (_, index) => `p${String(index)}`) })).toBe(false);
    expect(parse({ costUsd: -1 })).toBe(false);
    expect(parse({ lastRunFailed: true, offline: true, runLimitUsd: 5, stopAtUsd: 4 })).toBe(true);
    expect(parse({ lastRunFailed: false })).toBe(false);
    expect(parse({ offline: false })).toBe(false);
    expect(parse({ workflowBlocked: true })).toBe(true);
    expect(parse({ workflowBlocked: false })).toBe(false);
    expect(parse({ surprise: 1 })).toBe(false);
  });

  it("takes the event types and refuses text over its limit or an unknown type", () => {
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...event, actor: { kind: "member", developerId: DEV, name: "Priya" }, source: "slack", messageId: MESSAGE }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...event, actor: { kind: "agent" } }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...event, actor: { kind: "system" } }).success).toBe(true);
    for (const type of ["started", "status", "step", "comment", "steer", "steer_delivered", "steer_not_delivered", "take_over", "stopped", "retried", "shared", "handoff", "local_turn", "ended"]) {
      expect(SessionEventSchema.safeParse({ ...event, type }).success).toBe(true);
    }
    expect(SessionEventSchema.safeParse({ ...event, type: "pair_started" }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...event, text: "t".repeat(SESSION_EVENT_TEXT_MAX) }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...event, text: "t".repeat(SESSION_EVENT_TEXT_MAX + 1) }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...event, source: "fax" }).success).toBe(false);
    // Text may span lines, but holds no other control character.
    expect(SessionEventSchema.safeParse({ ...event, text: "one\ntwo\tthree" }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ ...event, text: "one\u0000two" }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...event, text: "one\u001b[31mred" }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...event, eventId: "evt_x" }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...event, extra: 1 }).success).toBe(false);
  });

  it("takes a message with its delivery state and refuses a bad kind, source or delivery", () => {
    const message = {
      messageId: MESSAGE,
      sessionId: SESSION,
      kind: "steer",
      source: "app",
      author: { developerId: DEV, name: "Priya" },
      text: "Use the v2 API",
      createdAt: NOW,
      rev: 1,
    };
    expect(SessionMessageSchema.safeParse(message).success).toBe(true);
    expect(SessionMessageSchema.safeParse({ ...message, delivery: { state: "not_delivered", at: LATER, reason: "ended" }, editedAt: LATER, deletedAt: LATER }).success).toBe(true);
    expect(SessionMessageSchema.safeParse({ ...message, source: "mac" }).success).toBe(false);
    expect(SessionMessageSchema.safeParse({ ...message, kind: "shout" }).success).toBe(false);
    expect(SessionMessageSchema.safeParse({ ...message, delivery: { state: "lost", at: LATER } }).success).toBe(false);
    expect(SessionMessageSchema.safeParse({ ...message, text: "t".repeat(2001) }).success).toBe(false);
    expect(SessionMessageSchema.safeParse({ ...message, text: "" }).success).toBe(false);
  });

  it("takes a Slack thread or a Linear issue binding, and refuses a key-breaking id", () => {
    expect(SessionBindingSchema.safeParse({ kind: "slack_thread", teamId: "T0123ABC", channelId: "C0123ABC", threadTs: "1760000000.123456" }).success).toBe(true);
    expect(SessionBindingSchema.safeParse({ kind: "slack_thread", teamId: "T0123ABC", channelId: "C0123ABC", threadTs: "17600" }).success).toBe(false);
    expect(SessionBindingSchema.safeParse({ kind: "linear_issue", issueId: "a".repeat(64), url: "https://linear.app/acme/issue/ENG-1" }).success).toBe(true);
    expect(SessionBindingSchema.safeParse({ kind: "linear_issue", issueId: "a".repeat(65), url: "https://linear.app/acme/issue/ENG-1" }).success).toBe(false);
    expect(SessionBindingSchema.safeParse({ kind: "linear_issue", issueId: "a#b", url: "https://linear.app/acme/issue/ENG-1" }).success).toBe(false);
    expect(SessionBindingSchema.safeParse({ kind: "linear_issue", issueId: "abc", url: "javascript:alert(1)" }).success).toBe(false);
    expect(SessionBindingSchema.safeParse({ kind: "linear_issue", issueId: "abc", url: "not a url" }).success).toBe(false);
  });
});

describe("names in a session", () => {
  it("keeps the joiners that real names and emoji need, and strips every other control or format character", () => {
    for (const name of ["Priya \u{1F469}\u200D\u{1F4BB}", "\u0639\u0644\u06CC\u200C\u0631\u0636\u0627", "Sam \u{1F1EC}\u{1F1E7}", "Ana \u2764\uFE0F", "Ana \u2764\uFE0E"]) {
      expect(cleanSessionName(name), name).toBe(name);
    }
    expect(cleanSessionName("Sam \u{1F3F4}\u{E0067}\u{E007F}")).toBe("Sam \u{1F3F4}");
    expect(cleanSessionName("Eve \u202Eevil\u202C")).toBe("Eve evil");
    expect(cleanSessionName("Ann\u00ADa")).toBe("Anna");
    expect(cleanSessionName("a\tb\nc")).toBe("a b c");
    expect(cleanSessionName("\u202E\u200B")).toBeUndefined();
    expect([...cleanSessionName("n".repeat(200))!]).toHaveLength(80);
  });

  it("is the same rule the schema applies: a name the helper leaves alone is valid, and one it would change is not", () => {
    const parse = (name: string) => SessionOwnerSchema.safeParse({ developerId: DEV, name }).success;
    expect(parse("Priya \u{1F469}\u200D\u{1F4BB}")).toBe(true);
    expect(parse("\u0639\u0644\u06CC\u200C\u0631\u0636\u0627")).toBe(true);
    expect(parse("Eve \u202Eevil")).toBe(false);
    expect(parse("Ann\u00ADa")).toBe(false);
    expect(parse("Sam \u{1F3F4}\u{E0067}")).toBe(false);
    expect(parse("a\u0000b")).toBe(false);
    expect(parse("n".repeat(81))).toBe(false);
  });
});

describe("the view schemas", () => {
  it("pins the keys of the session view, the tile and the event", () => {
    // Removing or renaming a key below bumps AGENT_SESSION_CONTRACT_VERSION and needs Plans 5, 7 and 8 (the screens read these).
    // Adding an optional key or a new enum value stays under version 1.
    expect(Object.keys(SessionViewSchema.shape).sort()).toEqual([
      "agent", "anchors", "approvals", "bindings", "body", "contractVersion", "cost", "createdAt", "display", "endedAt", "errorRef", "followers", "kind", "lastRunFailed", "legs", "link", "mode",
      "owner", "peek", "project", "retryOf", "revision", "sessionId", "startedBy", "status", "step", "title", "updatedAt", "viewingNow", "where", "you",
    ]);
    expect(Object.keys(SessionTileSchema.shape).sort()).toEqual([
      "agent", "contractVersion", "createdAt", "endedAt", "finishedAs", "kind", "level", "owner", "project", "revision", "sessionId", "summary", "title", "updatedAt", "where",
    ]);
    expect(Object.keys(SessionEventSchema.shape).sort()).toEqual(["actor", "at", "eventId", "messageId", "source", "text", "type"]);
  });

  it("accepts a current view, tile and event page with the strict and the reader schemas", () => {
    for (const schema of [SessionViewSchema, SessionViewReaderSchema]) expect(schema.safeParse(view).success).toBe(true);
    for (const schema of [SessionTileSchema, SessionTileReaderSchema]) expect(schema.safeParse(tile).success).toBe(true);
    const page = { events: [event], next: `${NOW}#${event.eventId}` };
    for (const schema of [SessionEventPageSchema, SessionEventPageReaderSchema]) expect(schema.safeParse(page).success).toBe(true);
    expect(SessionEventPageSchema.safeParse({ events: Array.from({ length: 201 }, () => event) }).success).toBe(false);
  });

  it("reads a newer server's view: unknown values read as unknown, the extra field is kept, and the strict schemas refuse it", () => {
    const newer = { ...view, status: "frozen", kind: "pair", where: { kind: "tablet", serial: "x1" }, you: { ...view.you, level: "own" }, futureField: { a: 1 } };
    expect(SessionViewSchema.safeParse(newer).success).toBe(false);
    const read = SessionViewReaderSchema.parse(newer);
    expect(read.status).toBe("unknown");
    expect(read.kind).toBe("unknown");
    expect(read.you.level).toBe("unknown");
    expect(read.where.kind).toBe("unknown");
    expect((read.where as Record<string, unknown>).serial).toBe("x1");
    expect((read as Record<string, unknown>).futureField).toEqual({ a: 1 });
    // A value it knows is read as it is.
    expect(SessionViewReaderSchema.parse(view).status).toBe("running");
  });

  // Plan 4's run view is the body of a chain session (the merge replaced Plan 5's loose placeholder). A gate's confirmUrl is Plan 4's to leave out: it is absent for a person who may not decide it.
  describe("the body of a chain session", () => {
    const run = {
      contractVersion: 1, sessionId: CHAIN_RUN, kind: "chain", chain: { chainId: "chn_0123456789abcdefghij", name: "Investigate", version: 2 }, project: "web",
      chainOwner: { kind: "member", id: DEV, name: "Priya" }, owner: { developerId: DEV, name: "Priya" }, startedBy: { kind: "member", developerId: DEV, name: "Priya" },
      status: "waiting", currentSeq: 2, createdAt: NOW, updatedAt: LATER, cost: { spentUsd: 0.5, runLimitUsd: 30 },
      sections: [
        { seq: 1, stepId: "investigate", name: "Find the cause", kind: "agent", status: "succeeded", attempt: 1, startedAt: NOW },
        { seq: 2, stepId: "approve", name: "Approve the fix", kind: "gate", status: "waiting", attempt: 1, startedAt: NOW, gate: { prompt: "Fix it?", status: "PENDING", approvers: "Max" } },
      ],
    };
    const chainView = (chain: unknown) => ({ ...view, sessionId: CHAIN_RUN, kind: "chain", body: { kind: "chain", chain } });

    it("takes the run view with a gate that has no confirmUrl, and with one", () => {
      for (const schema of [SessionViewSchema, SessionViewReaderSchema]) {
        expect(schema.safeParse(chainView(run)).success).toBe(true);
        const withLink = { ...run, sections: [run.sections[0], { ...run.sections[1], gate: { ...run.sections[1]!.gate, confirmUrl: "https://app.rovara.example/v1/app/approve/apr_0123456789abcdefg" } }] };
        expect(schema.safeParse(chainView(withLink)).success).toBe(true);
      }
    });

    it("refuses a body that is not a run view, and reads a newer run's status as unknown", () => {
      expect(SessionViewSchema.safeParse(chainView({})).success).toBe(false);
      expect(SessionViewSchema.safeParse(chainView({ ...run, status: "frozen" })).success).toBe(false);
      expect(SessionViewReaderSchema.parse(chainView({ ...run, status: "frozen", extra: 1 })).body).toMatchObject({ kind: "chain", chain: { status: "unknown", extra: 1 } });
    });
  });

  it("reads a newer server's event page and tile", () => {
    const newerEvent = { ...event, type: "pair_started", extra: "kept", actor: { kind: "robot", model: "x" } };
    const page = { events: [newerEvent], next: "n", more: true };
    expect(SessionEventPageSchema.safeParse(page).success).toBe(false);
    const read = SessionEventPageReaderSchema.parse(page);
    expect(read.events[0]?.type).toBe("unknown");
    expect((read.events[0] as Record<string, unknown>).extra).toBe("kept");
    expect((read as Record<string, unknown>).more).toBe(true);
    expect(SessionEventReaderSchema.parse(newerEvent).type).toBe("unknown");
    const newerTile = { ...tile, summary: { ...summary, status: "frozen", brandNew: 1 }, extra: 1 };
    expect(SessionTileSchema.safeParse(newerTile).success).toBe(false);
    expect(SessionTileReaderSchema.parse(newerTile).summary.status).toBe("unknown");
  });

  it("keeps a missing required value an error in the reader, not an unknown", () => {
    expect(SessionViewReaderSchema.safeParse({ ...view, title: undefined }).success).toBe(false);
    expect(SessionViewReaderSchema.safeParse({ ...view, status: undefined }).success).toBe(false);
    expect(SessionViewReaderSchema.safeParse({ ...view, status: 7 }).success).toBe(false);
    // A kind it knows with a broken field is an error, not an "unknown" kind.
    expect(SessionViewReaderSchema.safeParse({ ...view, where: { kind: "mac", label: "", offline: false } }).success).toBe(false);
    expect(SessionViewReaderSchema.safeParse({ ...view, where: { kind: "mac", label: "Mac", offline: false } }).success).toBe(true);
  });

  it("declares the home, project and confirmation shapes, strict and reader", () => {
    expect(HomeCardSchema).toBeDefined();
    expect(HomeResponseSchema).toBeDefined();
    expect(ProjectOverviewSchema).toBeDefined();
    expect(HomeCardReaderSchema).toBeDefined();
    expect(HomeResponseReaderSchema).toBeDefined();
    expect(ProjectOverviewReaderSchema).toBeDefined();
    const confirmation = { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://app.rovara.example/confirm/abc", changes: ["Take over Bump the Stripe SDK"] };
    expect(NeedsConfirmationSchema.safeParse(confirmation).success).toBe(true);
    expect(NeedsConfirmationSchema.safeParse({ ...confirmation, code: "FORBIDDEN" }).success).toBe(false);
    expect(NeedsConfirmationSchema.safeParse({ ...confirmation, status: "OK" }).success).toBe(false);
    expect(NeedsConfirmationSchema.safeParse({ ...confirmation, confirmUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(NeedsConfirmationSchema.safeParse({ ...confirmation, extra: 1 }).success).toBe(false);
  });

  it("is exported from the contracts barrel", () => {
    expect(contracts.AgentSessionRecordSchema).toBe(AgentSessionRecordSchema);
    expect(contracts.SessionViewSchema).toBe(SessionViewSchema);
    expect(contracts.agentSessionKey).toBe(agentSessionKey);
  });
});

describe("session keys", () => {
  const orgKeyBuilders: Array<[string, (orgId: typeof ORG_A) => { pk: string; sk: string }]> = [
    ["agentSessionKey META", (org) => agentSessionKey(org, SESSION, "META")],
    ["agentSessionKey SHARE", (org) => agentSessionKey(org, SESSION, `SHARE#MEMBER#${DEV}`)],
    ["agentSessionKey FOLLOWER", (org) => agentSessionKey(org, SESSION, `FOLLOWER#${DEV}`)],
    ["agentSessionKey PRESENCE", (org) => agentSessionKey(org, SESSION, `PRESENCE#${DEV}`)],
    ["agentSessionKey MESSAGE", (org) => agentSessionKey(org, SESSION, `MESSAGE#${MESSAGE}`)],
    ["agentSessionKey TURN", (org) => agentSessionKey(org, SESSION, `TURN#${NOW}#1`)],
    ["agentSessionKey EVENT", (org) => agentSessionKey(org, SESSION, sessionEventSk(NOW, event.eventId))],
    ["sessionBindingKey", (org) => sessionBindingKey(org, SESSION, "slack_thread")],
    ["agentSessionKey LEG", (org) => agentSessionKey(org, SESSION, "LEG#1")],
    ["liveSessionKey", (org) => liveSessionKey(org, SESSION)],
    ["mySessionsKey", (org) => mySessionsKey(org, DEV, NOW, SESSION)],
    ["projectSessionsKey", (org) => projectSessionsKey(org, "web", NOW, SESSION)],
    ["sharedSessionsKey member", (org) => sharedSessionsKey(org, { kind: "member", developerId: DEV }, SESSION)],
    ["sharedSessionsKey project", (org) => sharedSessionsKey(org, { kind: "project", project: "web" }, SESSION)],
    ["sharedSessionsKey org", (org) => sharedSessionsKey(org, { kind: "org" }, SESSION)],
    ["sessionRequestKey", (org) => sessionRequestKey(org, DEV, "req-1")],
    ["sessionRateKey", (org) => sessionRateKey(org, SESSION, DEV, "comment")],
    ["taskSpendKey", (org) => taskSpendKey(org, TASK)],
    ["sessionSurfaceKey slack", (org) => sessionSurfaceKey(org, { kind: "slack_thread", teamId: "T0123ABC", channelId: "C0123ABC", threadTs: "1760000000.123456" })],
    ["sessionSurfaceKey linear", (org) => sessionSurfaceKey(org, { kind: "linear_issue", issueId: "abc", url: "https://linear.app/acme/issue/ENG-1" })],
    ["changesKey", (org) => changesKey(org, DEV, NOW, 3)],
    ["projectMonthStatsKey", (org) => projectMonthStatsKey(org, "web", "2026-10")],
    ["deviceKey", (org) => deviceKey(org, DEVICE)],
    ["memberDevicesKey", (org) => memberDevicesKey(org, DEV, DEVICE)],
    ["deviceCommandKey", (org) => deviceCommandKey(org, DEVICE, 7)],
  ];

  it.each(orgKeyBuilders)("%s puts the org in the partition key and differs by org", (_name, build) => {
    const a = build(ORG_A);
    const b = build(ORG_B);
    expect(a.pk.startsWith(`ORG#${ORG_A}#`)).toBe(true);
    expect(b.pk.startsWith(`ORG#${ORG_B}#`)).toBe(true);
    expect(a.pk).not.toBe(b.pk);
    expect(a.pk).not.toContain(ORG_B);
  });

  it("names each key's partition and sort key", () => {
    expect(agentSessionKey(ORG_A, SESSION, "META")).toEqual({ pk: `ORG#${ORG_A}#AGENT_SESSION#${SESSION}`, sk: "META" });
    expect(liveSessionKey(ORG_A, SESSION)).toEqual({ pk: `ORG#${ORG_A}#LIVE_SESSIONS`, sk: SESSION });
    expect(mySessionsKey(ORG_A, DEV, NOW, SESSION)).toEqual({ pk: `ORG#${ORG_A}#MY_SESSIONS#${DEV}`, sk: `${NOW}#${SESSION}` });
    expect(projectSessionsKey(ORG_A, "web", NOW, SESSION)).toEqual({ pk: `ORG#${ORG_A}#PROJECT_SESSIONS#web`, sk: `${NOW}#${SESSION}` });
    expect(sharedSessionsKey(ORG_A, { kind: "member", developerId: DEV }, SESSION)).toEqual({ pk: `ORG#${ORG_A}#SHARED_SESSIONS#MEMBER#${DEV}`, sk: SESSION });
    expect(sessionRequestKey(ORG_A, DEV, "req-1")).toEqual({ pk: `ORG#${ORG_A}#SESSION_REQUEST#${DEV}`, sk: "req-1" });
    expect(sessionRateKey(ORG_A, SESSION, DEV, "change")).toEqual({ pk: `ORG#${ORG_A}#SESSION_RATE#${SESSION}`, sk: `change#${DEV}` });
    expect(sessionBindingKey(ORG_A, SESSION, "linear_issue")).toEqual({ pk: `ORG#${ORG_A}#SESSION_BINDING#${SESSION}`, sk: "BINDING#linear_issue" });
    expect(taskSpendKey(ORG_A, TASK).pk).toBe(`ORG#${ORG_A}#TASK_SPENT#${TASK}`);
    expect(deviceKey(ORG_A, DEVICE).pk).toBe(`ORG#${ORG_A}#DEVICE#${DEVICE}`);
    expect(memberDevicesKey(ORG_A, DEV, DEVICE)).toEqual({ pk: `ORG#${ORG_A}#MEMBER_DEVICES#${DEV}`, sk: DEVICE });
    expect(orgSettingsKey(ORG_A, "LOCAL_AGENTS")).toEqual({ pk: `ORG#${ORG_A}#SETTINGS`, sk: "LOCAL_AGENTS" });
  });

  it("canonicalises times and pads counters so keys sort in order", () => {
    expect(mySessionsKey(ORG_A, DEV, "2026-10-22T09:30:00Z", SESSION).sk).toBe(`2026-10-22T09:30:00.000Z#${SESSION}`);
    expect(() => mySessionsKey(ORG_A, DEV, "yesterday", SESSION)).toThrow();
    expect(sessionEventSk("2026-10-22T09:30:00Z", event.eventId)).toBe(`EVENT#2026-10-22T09:30:00.000Z#${event.eventId}`);
    const ordered = [changesKey(ORG_A, DEV, NOW, 2).sk, changesKey(ORG_A, DEV, NOW, 10).sk, changesKey(ORG_A, DEV, LATER, 0).sk];
    expect([...ordered].sort()).toEqual(ordered);
    const commands = [deviceCommandKey(ORG_A, DEVICE, 9).sk, deviceCommandKey(ORG_A, DEVICE, 10).sk];
    expect([...commands].sort()).toEqual(commands);
    expect(() => changesKey(ORG_A, DEV, NOW, -1)).toThrow();
    expect(() => deviceCommandKey(ORG_A, DEVICE, 1.5)).toThrow();
    expect(() => projectMonthStatsKey(ORG_A, "web", "2026-13")).toThrow();
    expect(() => projectMonthStatsKey(ORG_A, "web", "October")).toThrow();
  });

  it("keeps the three global partitions out of the org prefix, with the org in the sort key", () => {
    expect(openAgentSessionKey(ORG_A, SESSION)).toEqual({ pk: "OPEN_AGENT_SESSIONS", sk: `${ORG_A}#${SESSION}` });
    expect(openAgentSessionKey(ORG_B, SESSION).sk).not.toBe(openAgentSessionKey(ORG_A, SESSION).sk);
    expect(endedSessionWorkKey("2026-10-22", ORG_A, SESSION)).toEqual({ pk: "ENDED_AGENT_SESSIONS#2026-10-22", sk: `${ORG_A}#${SESSION}` });
    expect(endedSessionWorkKey("2026-10-22", ORG_B, SESSION).sk.startsWith(`${ORG_B}#`)).toBe(true);
    expect(() => endedSessionWorkKey("22 Oct", ORG_A, SESSION)).toThrow();
    expect(SESSION_SWEEP_CURSOR_KEY.pk).toBe("SESSION_SWEEP_CURSOR");
    // A session's count of messages to the agent that are still queued sits in its own partition, among the messages (so retention reaches it), and never reads as a message.
    expect(sessionQueuedSteersKey(ORG_A, SESSION)).toEqual({ pk: agentSessionKey(ORG_A, SESSION, "META").pk, sk: "MESSAGE#QUEUED" });
    expect(sessionQueuedSteersKey(ORG_A, SESSION).sk.startsWith("MESSAGE#msg_")).toBe(false);
    expect(sessionQueuedSteersKey(ORG_B, SESSION).pk).not.toBe(sessionQueuedSteersKey(ORG_A, SESSION).pk);
    expect(JSON.stringify(SESSION_SWEEP_CURSOR_KEY)).not.toContain("org_");
  });

  it("keys a Slack thread and a Linear issue differently, and one binding to one key", () => {
    const slack = { kind: "slack_thread", teamId: "T0123ABC", channelId: "C0123ABC", threadTs: "1760000000.123456" } as const;
    const other = { ...slack, threadTs: "1760000000.123457" } as const;
    const linear = { kind: "linear_issue", issueId: "abc", url: "https://linear.app/acme/issue/ENG-1" } as const;
    expect(sessionSurfaceKey(ORG_A, slack)).toEqual(sessionSurfaceKey(ORG_A, slack));
    expect(sessionSurfaceKey(ORG_A, slack)).not.toEqual(sessionSurfaceKey(ORG_A, other));
    expect(sessionSurfaceKey(ORG_A, slack)).not.toEqual(sessionSurfaceKey(ORG_A, linear));
    // The linear url is not part of the key: the same issue is the same surface.
    expect(sessionSurfaceKey(ORG_A, linear)).toEqual(sessionSurfaceKey(ORG_A, { ...linear, url: "https://linear.app/acme/issue/ENG-1/renamed" }));
  });

  it("refuses a segment that holds the key separator", () => {
    expect(() => mySessionsKey(ORG_A, "a#b", NOW, SESSION)).toThrow();
    expect(() => mySessionsKey(ORG_A, "", NOW, SESSION)).toThrow();
    expect(() => liveSessionKey(ORG_A, "")).toThrow();
    expect(() => mySessionsKey(ORG_A, "a\u0000b", NOW, SESSION)).toThrow();
    expect(() => agentSessionKey(ORG_A, "ses_x#y", "META")).toThrow();
  });
});

describe("error codes", () => {
  it("adds the five codes with their statuses", () => {
    const expected: Record<string, number> = {
      SESSION_LEVEL_REQUIRED: 403,
      SESSION_ENDED: 409,
      SESSION_REVISION_CONFLICT: 409,
      SESSION_ON_MAC: 409,
      LOCAL_AGENT_NOT_ALLOWED: 403,
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(AgentXErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(errorStatus(code as never)).toBe(status);
      expect(agentXError(code as never, "x").statusCode).toBe(status);
    }
  });

  it("words each message exactly", () => {
    expect(sessionLevelRequiredMessage("edit", "stop it", "Priya")).toBe('You need "can edit" on this session to stop it. Ask Priya to share it with you.');
    expect(sessionLevelRequiredMessage("use", "message the agent", "Arjun")).toBe('You need "can use" on this session to message the agent. Ask Arjun to share it with you.');
    expect(sessionLevelRequiredMessage("view", "see it", "Ola")).toBe('You need "can view" on this session to see it. Ask Ola to share it with you.');
    expect(sessionViewerOnlyMessage("web")).toBe("Viewers of web can only watch its sessions.");
    expect(SESSION_ENDED_MESSAGE).toBe("This session has ended.");
    expect(SESSION_REVISION_CONFLICT_MESSAGE).toBe("This session changed since you loaded it. Reload it and try again.");
    expect(sessionOnMacMessage("Priya")).toBe("This session runs on Priya's Mac. Ask Priya to move it to the cloud first.");
    expect(localToolNotAllowedMessage("codex")).toBe("codex isn't allowed in your company. Ask an admin to allow it.");
    expect(localAgentsNotAllowedOnProjectMessage("web")).toBe("Local agents aren't allowed on web. Ask an admin to allow them.");
  });

  it("uses no em dash in any message", () => {
    const messages = [
      sessionLevelRequiredMessage("edit", "stop it", "Priya"),
      sessionViewerOnlyMessage("web"),
      SESSION_ENDED_MESSAGE,
      SESSION_REVISION_CONFLICT_MESSAGE,
      sessionOnMacMessage("Priya"),
      localToolNotAllowedMessage("codex"),
      localAgentsNotAllowedOnProjectMessage("web"),
    ];
    for (const message of messages) expect(message).not.toContain("—");
  });
});

describe("FakeDynamoDb.transactions", () => {
  it("lists the items of each transaction, in the order sent", async () => {
    const table = new FakeDynamoDb();
    const put = (id: string) => ({ Put: { TableName: "State", Item: { pk: `T#${id}`, sk: "META", id } } });
    await table.send(new TransactWriteCommand({ TransactItems: [put("1"), put("2")] }));
    await table.send(new TransactWriteCommand({ TransactItems: [put("3")] }));
    expect(table.transactions()).toEqual([[put("1"), put("2")], [put("3")]]);
  });

  it("holds nothing before a transaction and ignores other commands", async () => {
    const table = new FakeDynamoDb();
    expect(table.transactions()).toEqual([]);
    table.set({ pk: "A", sk: "B" });
    expect(table.transactions()).toEqual([]);
  });

  it("lists a transaction a condition cancelled too, since it was sent", async () => {
    const table = new FakeDynamoDb();
    table.set({ pk: "A", sk: "B" });
    const put = { Put: { TableName: "State", Item: { pk: "A", sk: "B" }, ConditionExpression: "attribute_not_exists(pk)" } };
    await expect(table.send(new TransactWriteCommand({ TransactItems: [put] }))).rejects.toThrow();
    expect(table.transactions()).toEqual([[put]]);
  });

  it("hands back copies, so a caller cannot change what was recorded", async () => {
    const table = new FakeDynamoDb();
    await table.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "State", Item: { pk: "A", sk: "B" } } }] }));
    const first = table.transactions();
    first[0]?.splice(0, 1);
    expect(table.transactions()[0]).toHaveLength(1);
  });
});
