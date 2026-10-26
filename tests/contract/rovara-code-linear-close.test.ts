// Plan 6 Task 20: until Plan 9 closes Linear issues itself, Linear's own GitHub integration closes one when a pull request whose title or body says "Fixes <KEY>" merges. The key
// comes only from the session's own Linear binding in the task's org; it is checked to be an issue key (never free text); and no model-written line can say a second one.
import { describe, expect, it } from "vitest";
import { sessionBindingKey, type SessionBinding } from "@agentx/contracts";
import { inertLine } from "../../packages/broker/src/rovara-code/inert-text.js";
import { breakLinearCloseWords, linearCloseLine, linearIssueKeyOf, linearIssueKeyOfTask } from "../../packages/broker/src/rovara-code/linear-close.js";
import { ORG_A, ORG_B, sessionWorld } from "../support/agent-session-world.js";

const issue = (issueId: string, url = "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug"): SessionBinding => ({ kind: "linear_issue", issueId, url });
const THREAD: SessionBinding = { kind: "slack_thread", teamId: "T0TEAM001", channelId: "C0CHAN001", threadTs: "1695500000.000031" };
const closers = (text: string) => text.match(/\b(?:fix|fixes|fixed|fixing|close|closes|closed|closing|resolve|resolves|resolved|resolving|complete|completes|completed|completing)\s+[a-z][a-z0-9]*-\d+/giu) ?? [];

describe("linearIssueKeyOf", () => {
  it("reads the key from the issue id, or from the issue's link", () => {
    expect(linearIssueKeyOf(issue("ENG-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("eng-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://linear.app/acme/issue/eng-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("ENG-142", "https://linear.app/acme/issue/ENG-142"))).toBe("ENG-142");
    expect(linearIssueKeyOf(issue("A2-7", "https://linear.app/acme/issue/A2-7/x"))).toBe("A2-7");
  });

  it("is nothing for a Slack thread, an id and a link that disagree, a link that is not Linear's, or anything that is not an issue key", () => {
    expect(linearIssueKeyOf(THREAD)).toBeUndefined();
    expect(linearIssueKeyOf(issue("ENG-142", "https://linear.app/acme/issue/OPS-9/x"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://evil.example/acme/issue/ENG-142/x"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://linear.app.evil.example/acme/issue/ENG-142/x"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("7c1f2d9e-4b1a-4f66-9d0e-5a3c1b2d4e6f", "https://linear.app/acme/project/ENG-142"))).toBeUndefined();
    for (const id of ["ENG", "ENG-", "-142", "ENG-0", "ENG_142", "ENG-142x", "ENG-12345678901", "TOOLONGTEAMKEY-1"]) {
      expect(linearIssueKeyOf(issue(id, "https://linear.app/acme/team/all")), id).toBeUndefined();
    }
  });

  it("says Fixes <KEY>", () => {
    expect(linearCloseLine("ENG-142")).toBe("Fixes ENG-142");
  });
});

describe("linearIssueKeyOfTask", () => {
  function world() {
    const w = sessionWorld();
    const { sessionId } = w.seedSession();
    const table = { documentClient: w.db, tableName: "state" };
    const put = (binding: SessionBinding, orgId = ORG_A, keyedBy = ORG_A) =>
      w.db.set({ ...sessionBindingKey(keyedBy, sessionId, binding.kind), entityType: "AGENT_SESSION_BINDING", orgId, sessionId, binding, at: "2026-10-26T12:00:00.000Z" });
    return { w, table, sessionId, put };
  }

  it("reads the key from the session's Linear binding in the task's org", async () => {
    const { table, sessionId, put } = world();
    put(issue("ENG-142"));
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_A, sessionId })).toBe("ENG-142");
  });

  it("is nothing without a session, an org, a Linear binding, or when the binding belongs to another org", async () => {
    const { table, sessionId, put } = world();
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_A, sessionId })).toBeUndefined();
    put(THREAD);
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_A, sessionId })).toBeUndefined();
    put(issue("ENG-142"));
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_A })).toBeUndefined();
    expect(await linearIssueKeyOfTask(table, { sessionId })).toBeUndefined();
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_B, sessionId })).toBeUndefined();
    // An item at this org's key that says it is another org's.
    put(issue("ENG-142"), ORG_B);
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_A, sessionId })).toBeUndefined();
  });

  it("is nothing, and says so in the log, when the binding cannot be read", async () => {
    const { sessionId, put } = world();
    put(issue("ENG-142"));
    const logs: string[] = [];
    const table = { documentClient: { send: async () => { throw Object.assign(new Error("table down"), { name: "ServiceUnavailable" }); } }, tableName: "state", log: (event: string) => { logs.push(event); } };
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_A, sessionId })).toBeUndefined();
    expect(logs).toEqual(["linear_close.binding_unreadable"]);
  });
});

describe("a model-written line cannot say Fixes <KEY>", () => {
  it.each([
    "Fixes ENG-142", "fixes eng-142", "Closes ENG-142.", "closed ENG-142", "Resolves: ENG-142", "Completes   ENG-142", "fixing ENG-142", "Fix ENG-142 properly",
    "Fixes ENG-1, ENG-2", "closes ENG-1 and OPS-2", "resolves ENG-1 & OPS-2", "(fixes ENG-1)",
  ])("breaks the key in %j and keeps it readable", (line) => {
    expect(closers(line).length).toBeGreaterThan(0);
    const broken = breakLinearCloseWords(line);
    expect(closers(broken), broken).toEqual([]);
    expect(broken.replaceAll("‍", "")).toBe(line);
    expect(closers(inertLine(line, 200))).toEqual([]);
  });

  it("leaves other text alone", () => {
    for (const line of ["Add a retry flag", "Related to ENG-142", "See ENG-142", "Part of ENG-142", "The fix for UTF8 is done", "Use sha-256 for the digest", "ENG-142 is the issue"]) {
      expect(breakLinearCloseWords(line), line).toBe(line);
    }
  });
});
