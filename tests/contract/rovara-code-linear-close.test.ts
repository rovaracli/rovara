// Plan 6 Task 20: until Plan 9 closes Linear issues itself, Linear's own GitHub integration closes one when a pull request whose title or body says "Fixes <KEY>" merges. The key
// comes only from the session's own Linear binding in the task's org; it is checked to be an issue key (never free text); and no model-written line can say a second one.
import { describe, expect, it } from "vitest";
import { sessionBindingKey, type SessionBinding } from "@agentx/contracts";
import { inertLine } from "../../packages/broker/src/rovara-code/inert-text.js";
import { breakLinearKeys, linearCloseLine, linearIssueKeyOf, linearIssueKeyOfTask, parseLinearIssue, sealLinearKeys } from "../../packages/broker/src/rovara-code/linear-close.js";
import { ORG_A, ORG_B, sessionWorld } from "../support/agent-session-world.js";

const issue = (issueId: string, url = "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug"): SessionBinding => ({ kind: "linear_issue", issueId, url });
const THREAD: SessionBinding = { kind: "slack_thread", teamId: "T0TEAM001", channelId: "C0CHAN001", threadTs: "1695500000.000031" };
const closers = (text: string) => text.match(/\b(?:fix|fixes|fixed|fixing|close|closes|closed|closing|resolve|resolves|resolved|resolving|complete|completes|completed|completing)[\s:]+[a-z][a-z0-9]*-\d+/giu) ?? [];

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

  it("reads nothing at all without a session or an org", async () => {
    const reads: string[] = [];
    const table = { documentClient: { send: async () => { reads.push("read"); return {}; } }, tableName: "state" };
    expect(await linearIssueKeyOfTask(table, { orgId: ORG_A })).toBeUndefined();
    expect(await linearIssueKeyOfTask(table, { sessionId: "ses_00000000000000000001" })).toBeUndefined();
    expect(reads).toEqual([]);
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

/** Every Linear-key-shaped token in a text, as Linear's reader would see it (a joiner in it makes it not one). */
const keys = (text: string) => text.match(/[A-Za-z][A-Za-z0-9]*-\d+/gu) ?? [];

describe("a model-written line cannot name a Linear issue at all", () => {
  it.each([
    "Fixes ENG-142", "fixes eng-142", "Closes ENG-142.", "closed ENG-142", "Resolves: ENG-142", "Completes   ENG-142", "fixing ENG-142", "Fix ENG-142 properly",
    "Fixes ENG-1, ENG-2", "closes ENG-1 and OPS-2", "resolves ENG-1 & OPS-2", "(fixes ENG-1)",
    // Markdown, code spans, brackets and punctuation between the word and the key.
    "_Fixes ENG-1_", "__Fixes__ ENG-1", "**Fixes** ENG-1", "Fixes **ENG-1**", "Fixes `ENG-1`", "Fixes (ENG-1)", "Fixes - ENG-1", "Fixes #ENG-1", "Fix-ENG-1", "_ENG-1_", "~~ENG-1~~", "[ENG-1](x)", "<ENG-1>", "\"ENG-1\"",
    // More than one key, with any separator.
    "Fixes ENG-1 ENG-2", "Fixes ENG-1, and ENG-2", "fixes ENG-1;OPS-2", "Fixes ENG-1/ENG-2", "Fixes ENG-1\tENG-2", "ENG-1|ENG-2",
    // A word Linear may learn tomorrow, a bare key, a long team key, a key with a digit, and one that follows a letter or an underscore.
    "Ships ENG-1", "ENG-1", "ABCDEFGHIJKLM-12", "A2-7", "x_ENG-1", "abc9ENG-1", "See https://linear.app/acme/issue/ENG-1/slug",
  ])("breaks every key in %j and keeps it readable", (line) => {
    expect(keys(line).length).toBeGreaterThan(0);
    const broken = breakLinearKeys(line);
    expect(keys(broken), broken).toEqual([]);
    expect(broken.replaceAll("\u200D", "")).toBe(line);
  });

  it("is what inertLine does to every line it makes inert", () => {
    for (const line of ["_Fixes OPS-3_ by retrying", "Fixes `OPS-3`", "OPS-3 is related", "see (OPS-3)"]) expect(keys(inertLine(line, 200)), line).toEqual([]);
    expect(inertLine("_Fixes OPS-3_ by retrying", 200).replaceAll("\u200D", "")).toBe("_Fixes OPS-3_ by retrying");
  });

  it("leaves text without a key alone, dates and version numbers included", () => {
    for (const line of ["Add a retry flag", "The fix for UTF8 is done", "ENG 142", "ENG-", "-142", "2026-10-26", "v1.2.3", "12-34", "Fixes #12", "Fixes nothing"]) {
      expect(breakLinearKeys(line), line).toBe(line);
    }
  });

  it("seals every line but Rovara's own Fixes line", () => {
    const lines = ["Fixes ENG-142", "- note: fixes ENG-142 too", "Fixes ENG-142 ", "fixes ENG-142", "Fixes ENG-1432", "FixesENG-142"];
    const sealed = sealLinearKeys(lines, "ENG-142");
    expect(sealed[0]).toBe("Fixes ENG-142");
    for (const line of sealed.slice(1)) expect(keys(line), line).toEqual([]);
    expect(sealLinearKeys(lines, undefined).every((line) => keys(line).length === 0)).toBe(true);
    expect(sealLinearKeys(["Fixes ENG-142"], undefined)).not.toEqual(["Fixes ENG-142"]);
  });
});

describe("parseLinearIssue", () => {
  it("keeps only the key and Linear's short link: a typed workspace is dropped, as the company's own workspace is not known", () => {
    expect(parseLinearIssue("eng-142")).toEqual({ issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" });
    expect(parseLinearIssue("https://linear.app/othercorp/issue/ENG-142/slug?x=1#y")).toEqual({ issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" });
    expect(parseLinearIssue("https://linear.app/issue/ENG-142")).toEqual({ issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" });
    expect(parseLinearIssue("https://evil.example/acme/issue/ENG-142")).toBeUndefined();
  });
});

describe("a binding whose link is not Linear's", () => {
  it("names no issue, even when its id is a key", () => {
    expect(linearIssueKeyOf(issue("ENG-5", "https://evil.com/acme/issue/ENG-6"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("ENG-5", "https://linear.app.evil.example/acme/issue/ENG-5"))).toBeUndefined();
    expect(linearIssueKeyOf(issue("ENG-5", "https://linear.app/acme/issue/ENG-5"))).toBe("ENG-5");
    expect(linearIssueKeyOf(issue("ENG-5", "https://linear.app/issue/ENG-5"))).toBe("ENG-5");
  });
});
