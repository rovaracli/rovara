// Plan 3 Task 20b: write classification for agents. `prepareAgentWrite` makes the call what will be sent (mentions stripped, the `rovara` label added to a
// tracker create) before it is classified or an approval is stored; `classifyWrite` is the pure core (steps 1 to 8 of the plan, in order); `classifyAgentWrite`
// resolves its async inputs (the repository rule, label names, the run's own items) and fails closed on any lookup that breaks; `recordOwnItems` keeps
// what a create made so a later change to it is `safe`.
import { describe, expect, it, vi } from "vitest";
import type { ActionPolicy, AgentConnectorType, GrantedTool, OrgId, ToolFacts } from "@rovara-code/contracts";
import {
  READ_NAME_EXCEPTIONS,
  WRITE_CLASS_OVERRIDES,
  classifyAgentWrite,
  classifyWrite,
  isReadByName,
  loadOwnItems,
  nonTextFactProblems,
  prepareAgentWrite,
  recordOwnItems,
  type ClassifyWriteInput,
} from "../../packages/broker/src/agents/write-class.js";
import type { LabelLister } from "../../packages/broker/src/agents/label-names.js";
import { memoryRunCache, taskRunCache } from "../../packages/broker/src/agents/run-cache.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { treeReader, workflow } from "../support/fake-repository.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

interface GrantOptions extends Partial<Omit<ToolFacts, "connector" | "upstreamName" | "access">> {
  access?: "read" | "write";
  connector?: string;
}

/** A granted tool. `itemArguments` defaults to none (a create); the connector name defaults to the type's name. */
function grant(type: AgentConnectorType, upstreamName: string, options: GrantOptions = {}): GrantedTool {
  const { access = "write", connector = type, ...rest } = options;
  const facts: ToolFacts = { connector, upstreamName, access, itemArguments: [], ...rest };
  return { connector, type, upstreamName, presentedName: `${connector}__${upstreamName}`, access, facts };
}

// GitHub's tools name the repository in `owner` and `repo`; Task 19 declares them as item scope arguments so `owner` is not read as an assignee.
const REPOSITORY_ARGUMENTS = ["owner", "repo"];
const saveIssue = (over: GrantOptions = {}) => grant("linear", "save_issue", { itemArguments: ["id"], labelArgument: "labels", labelIdArguments: ["labelIds"], ...over });
const githubIssue = (over: GrantOptions = {}) => grant("github", "issue_write", { itemArguments: ["issue_number"], labelArgument: "labels", labelIdArguments: ["label_ids"], itemScopeArguments: REPOSITORY_ARGUMENTS, ...over });
const linearComment = () => grant("linear", "create_comment");
const githubComment = () => grant("github", "add_issue_comment", { itemScopeArguments: REPOSITORY_ARGUMENTS });
const githubReview = () => grant("github", "pull_request_review_write", { itemScopeArguments: REPOSITORY_ARGUMENTS });
const mcp = (name: string, over: GrantOptions = {}) => grant("mcp", name, over);

const LABELS = new Map<string, string | undefined>([["lbl-bug", "bug"], ["lbl-deploy", "deploy"], ["lbl-auto", "automerge"], ["101", "bug"], ["102", "automerge"]]);

function classify(tool: GrantedTool, args: Record<string, unknown>, over: Partial<ClassifyWriteInput> = {}) {
  return classifyWrite({
    tool, args, rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false, ownItems: new Set<string>(),
    labelNames: LABELS, repositoryRule: { consequential: false }, ...over,
  });
}
const classOf = (...parameters: Parameters<typeof classify>) => classify(...parameters).class;

const policy = (...rules: ActionPolicy["rules"]): ActionPolicy => ({ rules });
const PLAIN = "Looks good to me, thanks for the report.";

describe("the write-class overrides", () => {
  it("are empty here", () => {
    expect(WRITE_CLASS_OVERRIDES).toEqual({});
  });
});

describe("classifyWrite: Linear and GitHub item changes (Review Focus 1)", () => {
  it("makes a label-only change safe, even on an item the run did not create", () => {
    expect(classOf(saveIssue(), { id: "ENG-9", labelIds: ["lbl-bug"] })).toBe("safe");
    expect(classOf(saveIssue(), { id: "ENG-9", labels: ["bug"], priority: 2, estimate: 3 })).toBe("safe");
  });

  it("makes a state, assignee or close change consequential", () => {
    for (const args of [{ id: "ENG-12", stateId: "s1" }, { id: "ENG-12", assigneeId: "u1" }, { id: "ENG-12", closed: true }, { id: "ENG-12", state: "Done" }]) {
      expect(classOf(saveIssue(), args, { ownItems: new Set(["linear##ENG-12"]) }), JSON.stringify(args)).toBe("consequential");
    }
  });

  it("makes a title change safe on an item the run created and consequential otherwise (Linear identifier, GitHub number)", () => {
    expect(classOf(saveIssue(), { id: "ENG-12", title: "New title" }, { ownItems: new Set(["linear##ENG-12"]) })).toBe("safe");
    expect(classOf(saveIssue(), { id: "ENG-12", title: "New title" })).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-13", title: "New title" }, { ownItems: new Set(["linear##ENG-12"]) })).toBe("consequential");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, title: "New title" }, { ownItems: new Set(["github#o/r#42"]) })).toBe("safe");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, title: "New title" })).toBe("consequential");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 43, title: "New title" }, { ownItems: new Set(["github#o/r#42"]) })).toBe("consequential");
  });

  it("needs every item a call names to be the run's own, and the connector to match", () => {
    const batch = grant("mcp", "update_items", { itemArguments: ["items[].id"] });
    const own = new Set(["mcp##a", "mcp##b"]);
    expect(classOf(batch, { items: [{ id: "a", title: "x" }, { id: "b", title: "y" }] }, { ownItems: own })).toBe("safe");
    expect(classOf(batch, { items: [{ id: "a", title: "x" }, { id: "c", title: "y" }] }, { ownItems: own })).toBe("consequential");
    expect(classOf(batch, { items: [{ id: "a", title: "x" }] }, { ownItems: new Set(["other##a"]) })).toBe("consequential");
  });

  it("does not let an own item excuse an assignee, a state change or a reviewer", () => {
    const own = { ownItems: new Set(["linear##ENG-12"]) };
    expect(classOf(saveIssue(), { id: "ENG-12", title: "t", assignee: "me" }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", title: "t", teamId: "t1" }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", fields: { owner: "x" } }, own)).toBe("consequential");
  });

  it("makes a call with no argument besides the item itself consequential unless the item is the run's own", () => {
    const acknowledge = mcp("acknowledge_alert", { itemArguments: ["alertId"] });
    expect(classOf(acknowledge, { alertId: "a1" })).toBe("consequential");
    // The name must say it records something for an own item to be safe.
    expect(classOf(acknowledge, { alertId: "a1" }, { ownItems: new Set(["mcp##a1"]) })).toBe("consequential");
    expect(classOf(mcp("update_alert", { itemArguments: ["alertId"] }), { alertId: "a1" }, { ownItems: new Set(["mcp##a1"]) })).toBe("safe");
  });

  it("makes a comment safe, and a create carrying an assignee or an approving review consequential", () => {
    expect(classOf(linearComment(), { issueId: "ENG-1", body: PLAIN })).toBe("safe");
    expect(classOf(githubComment(), { owner: "o", repo: "r", issue_number: 1, body: PLAIN })).toBe("safe");
    expect(classOf(linearComment(), { issueId: "ENG-1", body: PLAIN, assignee: "someone" })).toBe("consequential");
    expect(classOf(githubReview(), { pullNumber: 5, body: PLAIN, event: "COMMENT" })).toBe("safe");
    expect(classOf(githubReview(), { pullNumber: 5, body: PLAIN, event: "APPROVE" })).toBe("consequential");
    expect(classOf(githubReview(), { pullNumber: 5, body: PLAIN, event: "request_changes" })).toBe("consequential");
  });

  it("compares the consequential keys like the lifecycle keys: case and separators ignored, nested too", () => {
    for (const args of [{ body: PLAIN, Assignee_Id: "u" }, { body: PLAIN, "assignee-id": "u" }, { body: PLAIN, fields: { reviewers: ["a"] } }, { body: PLAIN, input: { items: [{ owner_id: "u" }] } }]) {
      expect(classOf(linearComment(), args), JSON.stringify(args)).toBe("consequential");
    }
    // Present but empty is not set.
    expect(classOf(linearComment(), { body: PLAIN, assignee: null, assignees: [], owner: "" })).toBe("safe");
  });

  it("makes a write naming six items consequential and five safe", () => {
    const note = mcp("create_note");
    expect(classOf(note, { text: "x", tags: ["a", "b", "c", "d", "e"] })).toBe("safe");
    expect(classOf(note, { text: "x", tags: ["a", "b", "c", "d", "e", "f"] })).toBe("consequential");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN, items: [1, 2, 3, 4, 5, 6] })).toBe("consequential");
  });

  it("treats a vendor's destructive hint as a reason to ask only where the connector declares no item arguments", () => {
    const undeclared = mcp("update_widget", { itemArguments: undefined, hints: { destructiveHint: true } });
    expect(classOf(undeclared, { labels: ["bug"] })).toBe("consequential");
    const declared = mcp("update_widget", { itemArguments: ["id"], hints: { destructiveHint: true } });
    expect(classOf(declared, { id: "w1", labels: ["bug"] })).toBe("safe");
  });

  it("fails closed on arguments that are not a plain object", () => {
    expect(classOf(linearComment(), "just text" as unknown as Record<string, unknown>)).toBe("consequential");
    expect(classOf(linearComment(), [] as unknown as Record<string, unknown>)).toBe("consequential");
  });
});

describe("classifyWrite: name rules (R2-2)", () => {
  it("never makes a write-approved tool a read because of its name", () => {
    for (const name of ["get_and_rotate_key", "fetch_and_refund", "read_then_execute", "lookup_and_revoke"]) {
      const result = classify(mcp(name), { key: "k1" });
      expect(result.class, name).toBe("consequential");
      expect(classOf(mcp(name, { itemArguments: ["key"] }), { key: "k1" }), name).toBe("consequential");
    }
    expect(classOf(mcp("list_and_create_items"), { text: "x" })).not.toBe("read");
  });

  it("makes get_and_rotate_key, approved as a read, consequential and never a read", () => {
    const tool = mcp("get_and_rotate_key", { access: "read" });
    expect(classOf(tool, { key: "k1" })).toBe("consequential");
    expect(classOf(tool, {})).toBe("consequential");
  });

  it("keeps a closed-filter list a read", () => {
    expect(classOf(grant("linear", "list_issues", { access: "read" }), { state: "closed" })).toBe("read");
  });

  it("makes an outward post consequential: MCP post_to_url { url }", () => {
    expect(classOf(mcp("post_to_url"), { url: "https://example.com/hook" })).toBe("consequential");
  });

  it("asks for a write whose name says it acts, even when it names no item", () => {
    for (const name of ["run_workflow", "deploy_service", "trigger_build", "restart_service", "grant_access", "refund_payment"]) {
      expect(classOf(mcp(name), { target: "x" }), name).toBe("consequential");
    }
    for (const name of ["create_note", "add_note", "save_note", "upsert_note", "write_note", "update_note", "edit_note", "set_note"]) {
      expect(classOf(mcp(name, { itemArguments: name.startsWith("create") || name.startsWith("add") || name.startsWith("save") || name.startsWith("write") ? [] : ["id"] }), { id: "n1", text: "x" }, { ownItems: new Set(["mcp##n1"]) }), name).toBe("safe");
    }
  });
});

describe("classifyWrite: labels and repositories", () => {
  const own = { ownItems: new Set(["linear##ENG-12"]) };

  it("makes adding a trigger label consequential and adding bug safe", () => {
    expect(classOf(saveIssue(), { id: "ENG-12", labels: ["automerge"] }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", labels: ["Deploy-prod"] }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", labels: ["bug"] }, own)).toBe("safe");
    expect(classOf(saveIssue(), { id: "ENG-12", addLabels: ["automerge"] }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", labels: "bug, automerge" }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", labels: "bug, ui" }, own)).toBe("safe");
  });

  it("reads the declared label argument as labels, whatever it is called", () => {
    const tagged = saveIssue({ labelArgument: "tags" });
    expect(classOf(tagged, { title: "t", tags: ["automerge", "rovara"] })).toBe("consequential");
    expect(classOf(tagged, { title: "t", tags: ["bug", "rovara"] })).toBe("safe");
  });

  it("applies the org's own extra trigger labels and command words", () => {
    const guardrails = { extraTriggerLabels: ["ship-it*"], extraCommandWords: ["engage"] };
    expect(classOf(saveIssue(), { id: "ENG-12", labels: ["ship-it-now"] }, { ...own, guardrails })).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", labels: ["bug"] }, { ...own, guardrails })).toBe("safe");
    expect(classOf(linearComment(), { issueId: "1", body: "please engage the thrusters" }, { guardrails })).toBe("consequential");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { guardrails })).toBe("safe");
  });

  it("resolves label ids to names: a trigger label id is consequential, bug is safe, an unknown id is consequential", () => {
    expect(classOf(saveIssue(), { id: "ENG-12", labelIds: ["lbl-deploy"] }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", labelIds: ["lbl-bug"] }, own)).toBe("safe");
    expect(classOf(saveIssue(), { id: "ENG-12", labelIds: ["lbl-bug", "nobody-knows"] }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", addedLabelIds: ["lbl-auto"] }, own)).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-12", labelIds: ["lbl-bug"] }, { ...own, labelNames: new Map([["lbl-bug", undefined]]) })).toBe("consequential");
  });

  it("fails closed when no label names were looked up at all", () => {
    expect(classOf(saveIssue(), { id: "ENG-12", labelIds: ["lbl-bug"] }, { ...own, labelNames: undefined })).toBe("consequential");
    // A call with no label ids needs none.
    expect(classOf(saveIssue(), { id: "ENG-12", title: "t" }, { ...own, labelNames: undefined })).toBe("safe");
  });

  it("resolves a GitHub label set by id the same way", () => {
    const github = { ownItems: new Set(["github#o/r#42"]) };
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, label_ids: ["102"] }, github)).toBe("consequential");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, label_ids: ["101"] }, github)).toBe("safe");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, label_ids: ["999"] }, github)).toBe("consequential");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, label_ids: [101] }, github)).toBe("safe");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, label_ids: [{ id: 101 }] }, github)).toBe("consequential");
  });

  it("makes a plain comment consequential in a repository whose workflows listen to comments, and only a GitHub write", () => {
    const body = { owner: "o", repo: "r", issue_number: 1, body: PLAIN };
    expect(classOf(githubComment(), body, { repositoryRule: { consequential: true } })).toBe("consequential");
    expect(classOf(githubComment(), body, { repositoryRule: { consequential: false } })).toBe("safe");
    expect(classOf(githubReview(), { pullNumber: 5, body: PLAIN }, { repositoryRule: { consequential: true } })).toBe("consequential");
    expect(classOf(githubIssue(), { ...REPO, issue_number: 42, labels: ["bug"] }, { repositoryRule: { consequential: true } })).toBe("consequential");
    // A Linear comment is not in a repository.
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { repositoryRule: { consequential: true } })).toBe("safe");
  });

  it("fails closed when a GitHub write comes with no repository rule", () => {
    expect(classOf(githubComment(), { body: PLAIN }, { repositoryRule: undefined })).toBe("consequential");
  });
});

describe("classifyWrite: reads never wait, and only reads", () => {
  const read = (name: string, type: AgentConnectorType = "linear") => grant(type, name, { access: "read" });

  it("makes filtered lists and searches reads, with no argument inspected", () => {
    expect(classOf(read("list_issues"), { state: "open" })).toBe("read");
    expect(classOf(read("list_issues"), { state: "closed" })).toBe("read");
    expect(classOf(read("search_issues"), { status: "Done" })).toBe("read");
    expect(classOf(read("search_issues", "jira"), { jql: "project = X AND status = Done", status: "Done" })).toBe("read");
    expect(classOf(read("list_closed_issues"), {})).toBe("read");
    expect(classOf(read("get_merged_pull_requests", "github"), {})).toBe("read");
    expect(classOf(read("list_issues"), { text: "/deploy bors r+ @mergifyio", assignee: "me", event: "APPROVE" })).toBe("read");
    expect(classOf(read("list_issues"), "not an object" as unknown as Record<string, unknown>)).toBe("read");
    expect(isReadByName(read("list_issues"))).toBe(true);
  });

  it("does not treat a read-approved tool the vendor marks as writing as a read", () => {
    expect(classOf(grant("linear", "list_issues", { access: "read", hints: { readOnlyHint: false } }), {})).toBe("consequential");
    expect(classOf(grant("linear", "list_issues", { access: "read", hints: { destructiveHint: true } }), {})).toBe("consequential");
    expect(classOf(grant("linear", "list_issues", { access: "read", hints: { readOnlyHint: true } }), {})).toBe("read");
  });

  it("reads a plural or a gerund of a destructive word as that word, and the past tense as a filter", () => {
    for (const name of ["get_transitions", "list_deletes", "cancelling_jobs", "closing_issues", "removes_items", "archiving_items"]) {
      expect(classOf(read(name), {}), name).toBe("consequential");
    }
    for (const name of ["list_deleted_items", "list_archived_items", "get_cancelled_jobs", "list_resolved_issues"]) expect(classOf(read(name), {}), name).toBe("read");
  });

  it("does not treat get_and_close_issue as a read", () => {
    const result = classify(read("get_and_close_issue"), { id: "ENG-1" });
    expect(result.class).toBe("consequential");
    expect(isReadByName(read("get_and_close_issue"))).toBe(false);
  });

  it("is not fooled by a tool approved as a write", () => {
    expect(isReadByName(grant("linear", "list_issues", { access: "write" }))).toBe(false);
    expect(classOf(grant("linear", "list_issues", { access: "write" }), { state: "open" })).not.toBe("read");
  });

  it("still lets a project deny rule refuse a read", () => {
    const result = classify(read("list_issues"), { state: "open" }, { projectPolicy: policy({ tool: "list_issues", connector: "linear", outcome: "deny", reason: "no reads here" }) });
    expect(result.class).toBe("read");
    expect(result.denied).toEqual({ rule: 1, reason: "no reads here" });
  });

  it("does not make a read wait for an ask rule, always-ask or suggest autonomy", () => {
    const result = classify(read("list_issues"), {}, { projectPolicy: policy({ tool: "list_*", connector: "linear", outcome: "ask" }), rules: { alwaysAsk: ["list_*"] }, autonomy: "suggest" });
    expect(result.class).toBe("read");
    expect(result.denied).toBeUndefined();
    expect(result.ignoredRules).toEqual([1]);
  });
});

describe("classifyWrite: destructive words only on non-reads", () => {
  it("makes a delete_widget the project approved as a read consequential", () => {
    expect(classOf(mcp("delete_widget", { access: "read" }), { id: "w" })).toBe("consequential");
  });

  it("makes merge_* approved as a read consequential, and approved as a write it is merge", () => {
    expect(classOf(grant("github", "merge_pull_request", { access: "read" }), { pullNumber: 5 })).toBe("consequential");
    expect(classOf(grant("github", "merge_pull_request"), { pullNumber: 5 })).toBe("merge");
    expect(classOf(mcp("merge_branches", { access: "read" }), {})).toBe("consequential");
    expect(classOf(mcp("merge_branches"), {})).toBe("merge");
    for (const name of ["merges_things", "things_merged", "merging_things", "mergeThings"]) expect(classOf(mcp(name), {}), name).toBe("merge");
  });

  it("makes a destructive name or a lifecycle key on a write consequential", () => {
    expect(classOf(mcp("delete_widget"), { id: "w" })).toBe("consequential");
    expect(classOf(mcp("remove_label"), {})).toBe("consequential");
    expect(classOf(mcp("update_widget", { itemArguments: ["id"] }), { id: "w", status: "done" })).toBe("consequential");
  });

  it("keeps merge a merge whatever else the call carries", () => {
    const tool = grant("github", "merge_pull_request");
    expect(classOf(tool, { pullNumber: 5, assignee: "x", body: "/deploy" }, { rules: { alwaysAsk: ["merge_*"] }, autonomy: "suggest" })).toBe("merge");
    expect(classOf(tool, { pullNumber: 5 }, { overrides: { github: { merge_pull_request: "safe" } } })).toBe("merge");
    expect(classOf(tool, { pullNumber: 5 }, { overrides: { github: { merge_pull_request: "consequential" } } })).toBe("merge");
  });
});

describe("classifyWrite: outward creates", () => {
  it("makes sends, posts, notifications, publications, SMS and invites consequential whatever the item arguments say", () => {
    for (const name of ["send_email", "post_message", "notify_team", "publish_page", "send_sms", "invite_user"]) {
      expect(classOf(mcp(name, { itemArguments: [] }), { subject: "hello", text: "x" }), name).toBe("consequential");
    }
    expect(classOf(mcp("send_email", { itemArguments: undefined }), { subject: "hello" })).toBe("consequential");
  });

  it("makes a create with a recipient, phone, url, webhook or endpoint argument consequential", () => {
    expect(classOf(mcp("create_note"), { text: "x", to: ["a@b.com"] })).toBe("consequential");
    for (const key of ["cc", "bcc", "recipient", "recipients", "email", "emails", "phone", "url", "webhook", "endpoint"]) {
      expect(classOf(mcp("create_note"), { text: "x", [key]: "v" }), key).toBe("consequential");
    }
    expect(classOf(mcp("create_note"), { text: "x", meta: { to: "a@b.com" } })).toBe("consequential");
  });

  it("makes a create whose name says message, email or sms consequential even without a send verb", () => {
    for (const name of ["create_message", "create_email", "create_sms", "add_message"]) expect(classOf(mcp(name), { text: "x" }), name).toBe("consequential");
  });

  it("makes a plain note safe", () => {
    expect(classOf(mcp("create_note"), { text: "x" })).toBe("safe");
  });
});

describe("classifyWrite: tracker creates", () => {
  it("makes a Linear create without the rovara label consequential and, with it, safe", () => {
    const tool = saveIssue();
    expect(classOf(tool, { title: "Broken", labels: ["bug"] })).toBe("consequential");
    expect(classOf(tool, { title: "Broken" })).toBe("consequential");
    expect(classOf(tool, { title: "Broken", labels: ["bug", "rovara"] })).toBe("safe");
    expect(classOf(tool, { title: "Broken", labels: ["Rovara"] })).toBe("safe");
    expect(classOf(saveIssue({ labelArgument: "tags" }), { title: "Broken", tags: "bug, rovara" })).toBe("safe");
  });

  it("gets the label from prepareAgentWrite, which keeps the agent's own labels", () => {
    const tool = saveIssue();
    const prepared = prepareAgentWrite(tool, { title: "Broken", labels: ["bug"] }, { allowMentions: false });
    expect(prepared.args).toEqual({ title: "Broken", labels: ["bug", "rovara"] });
    expect(classOf(tool, prepared.args)).toBe("safe");
  });

  it("keeps a Jira create consequential: its schema declares no label argument", () => {
    const jira = grant("jira", "create_issue", { itemArguments: [] });
    const prepared = prepareAgentWrite(jira, { summary: "Broken", labels: ["bug"] }, { allowMentions: false });
    expect(prepared.args).toEqual({ summary: "Broken", labels: ["bug"] });
    expect(classOf(jira, prepared.args)).toBe("consequential");
  });

  it("does not take a label in another argument, a label that only contains rovara, or one that is not in the declared argument", () => {
    const tool = saveIssue();
    expect(classOf(tool, { title: "rovara", description: "rovara", labels: ["rovara-x", "not-rovara"] })).toBe("consequential");
    expect(classOf(tool, { title: "t", addLabels: ["rovara"] })).toBe("consequential");
  });

  it("does not call a comment, a reply or a review a tracker create", () => {
    expect(classOf(grant("linear", "create_issue_comment"), { issueId: "1", body: PLAIN })).toBe("safe");
    expect(classOf(grant("github", "add_issue_comment", { labelArgument: "labels" }), { body: PLAIN })).toBe("safe");
  });

  it("calls a GitHub issue create a tracker create", () => {
    expect(classOf(githubIssue(), { title: "t", labels: ["bug"] })).toBe("consequential");
    expect(classOf(githubIssue(), { title: "t", labels: ["bug", "rovara"] })).toBe("safe");
  });
});

describe("classifyWrite: commands in comments", () => {
  const COMMANDS = ["bors r+", "bors try", "/deploy production", "/merge", "/ship", "/approve", "/lgtm"];
  const tools: Array<[string, GrantedTool, (body: string) => Record<string, unknown>]> = [
    ["add_issue_comment", githubComment(), (body) => ({ owner: "o", repo: "r", issue_number: 1, body })],
    ["create_comment", linearComment(), (body) => ({ issueId: "ENG-1", body })],
    ["pull_request_review_write", githubReview(), (body) => ({ pullNumber: 5, body, event: "COMMENT" })],
  ];

  for (const [name, tool, args] of tools) {
    it(`makes a command in ${name} consequential and a plain comment safe`, () => {
      for (const command of COMMANDS) expect(classOf(tool, args(`Thanks.\n${command}`)), command).toBe("consequential");
      expect(classOf(tool, args("Thanks.\n@mergifyio queue"), { allowMentions: true })).toBe("consequential");
      expect(classOf(tool, args("Thanks.\n@mergifyio queue"), { allowMentions: false })).toBe("consequential");
      expect(classOf(tool, args(PLAIN))).toBe("safe");
    });
  }

  it("finds a command in any string at any depth, and not only in a comment tool", () => {
    expect(classOf(mcp("create_note"), { note: { parts: [{ text: "/deploy production" }] } })).toBe("consequential");
    expect(classOf(mcp("create_note"), { text: "x", extra: { deep: ["bors r+"] } })).toBe("consequential");
  });

  it("strips a mention in prepareAgentWrite and then calls the comment safe", () => {
    const prepared = prepareAgentWrite(linearComment(), { issueId: "ENG-1", body: "cc @alice" }, { allowMentions: false });
    expect(prepared.args).toEqual({ issueId: "ENG-1", body: "cc alice" });
    expect(prepared.strippedMentions).toEqual(["@alice"]);
    expect(classOf(linearComment(), prepared.args)).toBe("safe");
  });

  it("keeps a mention when the recipe allows them, and then asks", () => {
    const prepared = prepareAgentWrite(linearComment(), { issueId: "ENG-1", body: "cc @alice" }, { allowMentions: true });
    expect(prepared.args).toEqual({ issueId: "ENG-1", body: "cc @alice" });
    expect(prepared.strippedMentions).toEqual([]);
    expect(classOf(linearComment(), prepared.args, { allowMentions: true })).toBe("consequential");
  });

  it("does not read an item reference, or a path or URL argument the schema declares, as a command", () => {
    const tool = mcp("create_note", { nonTextArguments: ["path", "branch"], itemArguments: [] });
    expect(classOf(tool, { text: "x", path: "/usr/local/bin" })).toBe("safe");
    expect(classOf(tool, { text: "x", branch: "/deploy" })).toBe("safe");
    expect(classOf(tool, { text: "x", other: "/deploy" })).toBe("consequential");
    const byId = mcp("update_item", { itemArguments: ["id"] });
    expect(classOf(byId, { id: "/deploy", labels: ["bug"] })).toBe("safe");
  });
});

describe("classifyWrite: project rules only raise", () => {
  const closeIssue = grant("linear", "close_issue", { itemArguments: ["id"] });

  it("ignores a treatAs read rule and an allow rule on close_issue, and lists them", () => {
    const result = classify(closeIssue, { id: "ENG-1" }, { projectPolicy: policy(
      { tool: "close_issue", connector: "linear", treatAs: "read" },
      { tool: "close_issue", connector: "linear", outcome: "allow" },
    ) });
    expect(result.class).toBe("consequential");
    expect(result.ignoredRules).toEqual([1, 2]);
  });

  it("ignores an allow rule on a comment, a wildcard allow and a lowering treatAs on a change", () => {
    const result = classify(linearComment(), { issueId: "1", body: "/deploy" }, { projectPolicy: policy({ tool: "*", outcome: "allow" }) });
    expect(result.class).toBe("consequential");
    expect(result.ignoredRules).toEqual([1]);
    const lowering = classify(saveIssue(), { id: "ENG-1", title: "t" }, { projectPolicy: policy({ tool: "save_issue", connector: "linear", treatAs: "create" }) });
    expect(lowering.class).toBe("consequential");
    expect(lowering.ignoredRules).toEqual([1]);
  });

  it("makes a project ask rule on create_comment consequential", () => {
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { projectPolicy: policy({ tool: "create_comment", connector: "linear", outcome: "ask" }) })).toBe("consequential");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { projectPolicy: policy({ tool: "create_*", outcome: "ask" }) })).toBe("safe");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { projectPolicy: policy({ tool: "linear__create_*", outcome: "ask" }) })).toBe("consequential");
  });

  it("applies a treatAs rule toward a stricter class", () => {
    expect(classOf(mcp("create_note"), { text: "x" }, { projectPolicy: policy({ tool: "create_*", connector: "mcp", treatAs: "destructive" }) })).toBe("consequential");
    expect(classOf(mcp("create_note"), { text: "x" }, { projectPolicy: policy({ tool: "create_note", connector: "mcp", treatAs: "change" }) })).toBe("consequential");
    // A change that sets only safe keys is still safe: the change rules decide, not the word.
    expect(classOf(mcp("create_note"), { labels: ["bug"] }, { projectPolicy: policy({ tool: "create_note", connector: "mcp", treatAs: "change" }) })).toBe("safe");
  });

  it("limits a rule to the calls that set its argument", () => {
    const rule: ActionPolicy["rules"][number] = { tool: "create_comment", connector: "linear", outcome: "ask", whenArguments: ["assigneeId"] };
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { projectPolicy: policy(rule) })).toBe("safe");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN, assigneeId: "u" }, { projectPolicy: policy(rule) })).toBe("consequential");
  });

  it("reports a deny rule for decideWrite to refuse, with the rule's reason", () => {
    const result = classify(linearComment(), { issueId: "1", body: PLAIN }, { projectPolicy: policy({ tool: "create_comment", connector: "linear", outcome: "deny" }) });
    expect(result.denied).toMatchObject({ rule: 1 });
    expect(result.denied?.reason).toContain("create_comment");
    expect(classify(linearComment(), { issueId: "1", body: PLAIN }).denied).toBeUndefined();
  });

  it("lists nothing for rules that matched nothing", () => {
    expect(classify(linearComment(), { issueId: "1", body: PLAIN }, { projectPolicy: policy({ tool: "other_tool", outcome: "allow" }) }).ignoredRules).toEqual([]);
  });
});

describe("classifyWrite: always-ask and autonomy", () => {
  it("makes create_comment consequential under alwaysAsk create_*", () => {
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { rules: { alwaysAsk: ["create_*"] } })).toBe("consequential");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { rules: { alwaysAsk: ["linear__create_*"] } })).toBe("consequential");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { rules: { alwaysAsk: ["delete_*"] } })).toBe("safe");
  });

  it("makes a comment consequential for an agent that only suggests, and not one that prepares or runs", () => {
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { autonomy: "suggest" })).toBe("consequential");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { autonomy: "prepare" })).toBe("safe");
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { autonomy: "run" })).toBe("safe");
  });
});

describe("classifyWrite: overrides", () => {
  const acknowledge = mcp("acknowledge_alert", { itemArguments: ["alertId"] });
  const overrides = { mcp: { acknowledge_alert: "safe" as const } };

  it("lets an override lower a plain consequential call to safe", () => {
    expect(classOf(acknowledge, { alertId: "a1" })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1" }, { overrides })).toBe("safe");
  });

  it("does not lower a bulk call, a call with assigneeId, an outward send or a command comment", () => {
    expect(classOf(acknowledge, { alertId: "a1", alertIds: [1, 2, 3, 4, 5, 6] }, { overrides })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1", assigneeId: "u" }, { overrides })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1", to: ["a@b.com"] }, { overrides })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1", note: "/deploy production" }, { overrides })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1", note: "bors r+" }, { overrides })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1", labels: ["automerge"] }, { overrides })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1", event: "APPROVE" }, { overrides })).toBe("consequential");
  });

  it("does not lower an unlabelled tracker create", () => {
    const create = saveIssue();
    expect(classOf(create, { title: "t" }, { overrides: { linear: { save_issue: "safe" } } })).toBe("consequential");
  });

  it("does not lower a destructive name, a lifecycle key, a project ask, always-ask or suggest autonomy", () => {
    expect(classOf(mcp("delete_widget"), { id: "w" }, { overrides: { mcp: { delete_widget: "safe" } } })).toBe("consequential");
    const update = mcp("update_alert", { itemArguments: ["alertId"] });
    expect(classOf(update, { alertId: "a", state: "x" }, { overrides: { mcp: { update_alert: "safe" } } })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1" }, { overrides, projectPolicy: policy({ tool: "acknowledge_alert", connector: "mcp", outcome: "ask" }) })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1" }, { overrides, rules: { alwaysAsk: ["acknowledge_*"] } })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1" }, { overrides, autonomy: "suggest" })).toBe("consequential");
  });

  it("does not lower a tool the project approved only as a read", () => {
    expect(classOf(mcp("update_alert", { access: "read" }), { alertId: "a1" }, { overrides: { mcp: { update_alert: "safe" } } })).toBe("consequential");
    // A read stays a read with an override of its own that says nothing about it.
    expect(classOf(mcp("acknowledge_alert", { access: "read" }), { alertId: "a1" }, { overrides })).toBe("read");
  });

  it("applies an override only to the connector type and tool it names", () => {
    expect(classOf(acknowledge, { alertId: "a1" }, { overrides: { linear: { acknowledge_alert: "safe" } } })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1" }, { overrides: { mcp: { other_alert: "safe" } } })).toBe("consequential");
    expect(classOf(acknowledge, { alertId: "a1" }, { overrides: { mcp: Object.create({ acknowledge_alert: "safe" }) as Record<string, "safe"> } })).toBe("consequential");
  });

  it("lets an override raise a safe call", () => {
    expect(classOf(linearComment(), { issueId: "1", body: PLAIN }, { overrides: { linear: { create_comment: "consequential" } } })).toBe("consequential");
  });
});

describe("prepareAgentWrite", () => {
  it("strips mentions from every text argument, however deep, and lists what it removed", () => {
    const prepared = prepareAgentWrite(mcp("create_note"), { text: "hi @alice and @acme/team", nested: { items: [{ body: "ping @bob" }] } }, { allowMentions: false });
    expect(prepared.args).toEqual({ text: "hi alice and acme/team", nested: { items: [{ body: "ping bob" }] } });
    expect([...prepared.strippedMentions].sort()).toEqual(["@acme/team", "@alice", "@bob"]);
  });

  it("leaves an item reference and a declared non-text argument exactly as given", () => {
    const tool = mcp("update_item", { itemArguments: ["id", "items[].ref"], nonTextArguments: ["handle"] });
    const prepared = prepareAgentWrite(tool, { id: "@weird", items: [{ ref: "@x", body: "@y" }], handle: "@h", body: "@z" }, { allowMentions: false });
    expect(prepared.args).toEqual({ id: "@weird", items: [{ ref: "@x", body: "y" }], handle: "@h", body: "z" });
  });

  it("does not change its input", () => {
    const input = { title: "t", labels: ["bug"], body: "cc @alice" };
    const copy = structuredClone(input);
    prepareAgentWrite(saveIssue(), input, { allowMentions: false });
    expect(input).toEqual(copy);
  });

  it("returns the cleaned text even when mentions are allowed", () => {
    const prepared = prepareAgentWrite(mcp("create_note"), { text: "cc @alice​" }, { allowMentions: true });
    expect(prepared.args).toEqual({ text: "cc @alice" });
  });

  it("adds rovara to a tracker create: an array stays an array, a comma list stays one, a missing argument gets the declared shape", () => {
    expect(prepareAgentWrite(saveIssue(), { title: "t" }, { allowMentions: false }).args).toEqual({ title: "t", labels: ["rovara"] });
    expect(prepareAgentWrite(saveIssue(), { title: "t", labels: [] }, { allowMentions: false }).args).toEqual({ title: "t", labels: ["rovara"] });
    expect(prepareAgentWrite(saveIssue({ labelArgument: "tags", labelArgumentShape: "comma_list" }), { title: "t", tags: "bug, ui" }, { allowMentions: false }).args).toEqual({ title: "t", tags: "bug, ui, rovara" });
    expect(prepareAgentWrite(saveIssue({ labelArgument: "tags", labelArgumentShape: "comma_list" }), { title: "t", tags: "bug,ui" }, { allowMentions: false }).args).toEqual({ title: "t", tags: "bug,ui,rovara" });
    expect(prepareAgentWrite(saveIssue({ labelArgument: "tags", labelArgumentShape: "comma_list" }), { title: "t" }, { allowMentions: false }).args).toEqual({ title: "t", tags: "rovara" });
    expect(prepareAgentWrite(saveIssue({ labelArgument: "tags", labelArgumentShape: "comma_list" }), { title: "t", tags: "" }, { allowMentions: false }).args).toEqual({ title: "t", tags: "rovara" });
  });

  it("adds it inside a nested argument path, creating the parent when it is missing", () => {
    const jira = grant("jira", "create_issue", { labelArgument: "fields.labels" });
    expect(prepareAgentWrite(jira, { fields: { summary: "s", labels: ["bug"] } }, { allowMentions: false }).args).toEqual({ fields: { summary: "s", labels: ["bug", "rovara"] } });
    expect(prepareAgentWrite(jira, { summary: "s" }, { allowMentions: false }).args).toEqual({ summary: "s", fields: { labels: ["rovara"] } });
    expect(classOf(jira, { fields: { labels: ["bug", "rovara"] } })).toBe("safe");
  });

  it("does not take a label that only contains rovara as the label", () => {
    const comma = saveIssue({ labelArgument: "tags", labelArgumentShape: "comma_list" });
    expect(prepareAgentWrite(comma, { title: "t", tags: "bug, not-rovara" }, { allowMentions: false }).args).toEqual({ title: "t", tags: "bug, not-rovara, rovara" });
  });

  it("does not add it twice, in any case", () => {
    expect(prepareAgentWrite(saveIssue(), { title: "t", labels: ["ROVARA", "bug"] }, { allowMentions: false }).args).toEqual({ title: "t", labels: ["ROVARA", "bug"] });
  });

  it("leaves a label argument of a shape it can't extend alone, and the call stays consequential", () => {
    for (const labels of [7, { a: 1 }, [1, 2], true]) {
      const prepared = prepareAgentWrite(saveIssue(), { title: "t", labels }, { allowMentions: false });
      expect(prepared.args).toEqual({ title: "t", labels });
      expect(classOf(saveIssue(), prepared.args), JSON.stringify(labels)).toBe("consequential");
    }
  });

  it("adds nothing to a change, a comment, a note or a tool that declares no label argument", () => {
    expect(prepareAgentWrite(saveIssue(), { id: "ENG-1", title: "t" }, { allowMentions: false }).args).toEqual({ id: "ENG-1", title: "t" });
    expect(prepareAgentWrite(grant("linear", "create_comment", { labelArgument: "labels" }), { issueId: "1", body: "b" }, { allowMentions: false }).args).toEqual({ issueId: "1", body: "b" });
    expect(prepareAgentWrite(mcp("create_note", { labelArgument: "labels" }), { text: "b" }, { allowMentions: false }).args).toEqual({ text: "b" });
    expect(prepareAgentWrite(saveIssue({ labelArgument: undefined }), { title: "t" }, { allowMentions: false }).args).toEqual({ title: "t" });
    expect(prepareAgentWrite(saveIssue({ access: "read" }), { title: "t" }, { allowMentions: false }).args).toEqual({ title: "t" });
  });

  it("does not add the label to a call whose connector declares no item arguments", () => {
    const undeclared = saveIssue({ itemArguments: undefined });
    expect(prepareAgentWrite(undeclared, { title: "t" }, { allowMentions: false }).args).toEqual({ title: "t" });
  });

  it("refuses arguments nested too deeply to check, as stripMentions does", () => {
    let deep: unknown = "x";
    for (let level = 0; level < 100; level += 1) deep = { deeper: deep };
    expect(() => prepareAgentWrite(mcp("create_note"), { deep }, { allowMentions: false })).toThrow(/nested too deeply/u);
  });
});

// ---------------------------------------------------------------------------------------------
// The wrapper: lookups that fail close
// ---------------------------------------------------------------------------------------------

const WORKFLOW = ".github/workflows/triage.yml";
/** The repository the wrapper tests work in: a GitHub call names it in `owner` and `repo`. */
const DEMO = { owner: "example", repo: "demo" };

function wrapper(options: { files?: Record<string, string>; down?: boolean; lists?: Record<string, LabelLister> } = {}) {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  const reads = vi.fn();
  const readerFor = async () => {
    reads();
    if (options.down === true) throw new Error("GitHub is down");
    return treeReader(options.files ?? { [WORKFLOW]: workflow("push") });
  };
  const github: LabelLister = vi.fn(async () => new Map([["101", "bug"], ["102", "automerge"]]));
  const deps = {
    documentClient: db, tableName: "state", now: Date.now, audit: audit.audit,
    repositoryReader: readerFor,
    labelListers: options.lists ?? { github, linear: vi.fn(async () => new Map([["lbl-bug", "bug"], ["lbl-deploy", "deploy"]])) },
    runCache: (scope: { orgId: OrgId; taskId: string }) => taskRunCache({ documentClient: db, tableName: "state", now: Date.now }, scope),
  };
  const base = { orgId: TEST_ORG, taskId: "task-1", project: "payments", repository: "example/demo", rules: { alwaysAsk: [] }, autonomy: "run" as const, allowMentions: false };
  return { db, deps, reads, github, base };
}

/** What a successful create of `connector#value` left behind for the run. */
function seedOwn(w: { db: FakeDynamoDb }, connector: string, value: string, scope = "", orgId: OrgId = TEST_ORG, taskId = "task-1"): void {
  w.db.set({ pk: `ORG#${orgId}#AGENT_ITEMS#${taskId}`, sk: `${connector}#${scope}#${value}`, orgId, taskId, entityType: "AGENT_ITEM" });
}

describe("classifyAgentWrite", () => {
  it("scans the repository for a GitHub write and finds a comment-triggered workflow consequential", async () => {
    const w = wrapper({ files: { [WORKFLOW]: workflow("issue_comment") } });
    const result = await classifyAgentWrite(w.deps, { ...w.base, tool: githubComment(), args: { ...DEMO, body: PLAIN } });
    expect(result.class).toBe("consequential");
    expect(w.reads).toHaveBeenCalled();
  });

  it("holds the scan to the installation the project pinned for the repository", async () => {
    const seen: unknown[] = [];
    const w = wrapper();
    const deps = { ...w.deps, repositoryReader: async (request: { installationId?: number }) => { seen.push(request.installationId); return treeReader({ [WORKFLOW]: workflow("push") }); } };
    await classifyAgentWrite(deps, { ...w.base, tool: githubComment(), args: { ...DEMO, body: PLAIN }, installationId: 4242 });
    await classifyAgentWrite(deps, { ...w.base, taskId: "task-2", tool: githubComment(), args: { ...DEMO, body: PLAIN } });
    expect(seen).toEqual([4242, undefined]);
  });

  it("calls a plain comment safe when no workflow reacts to comments, and scans once per run", async () => {
    const w = wrapper();
    for (let call = 0; call < 3; call += 1) expect((await classifyAgentWrite(w.deps, { ...w.base, tool: githubComment(), args: { ...DEMO, body: PLAIN } })).class).toBe("safe");
    expect(w.reads).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the repository can't be read, and when the call names no repository", async () => {
    const down = wrapper({ down: true });
    expect((await classifyAgentWrite(down.deps, { ...down.base, tool: githubComment(), args: { ...DEMO, body: PLAIN } })).class).toBe("consequential");
    const noRepository = wrapper();
    const { repository: _repository, ...without } = noRepository.base;
    void _repository;
    expect((await classifyAgentWrite(noRepository.deps, { ...without, tool: githubComment(), args: { ...DEMO, body: PLAIN } })).class).toBe("consequential");
    expect(noRepository.reads).not.toHaveBeenCalled();
  });

  it("fails closed when the repository reader throws something that is not an Error, or the scan itself breaks", async () => {
    const w = wrapper();
    const broken = { ...w.deps, repositoryReader: async () => { throw "boom"; } }; // eslint-disable-line @typescript-eslint/only-throw-error -- a non-Error rejection
    expect((await classifyAgentWrite(broken, { ...w.base, tool: githubComment(), args: { ...DEMO, body: PLAIN } })).class).toBe("consequential");
  });

  it("does not scan for a Linear write, or for a read", async () => {
    const w = wrapper({ files: { [WORKFLOW]: workflow("issue_comment") } });
    expect((await classifyAgentWrite(w.deps, { ...w.base, tool: linearComment(), args: { issueId: "1", body: PLAIN } })).class).toBe("safe");
    expect((await classifyAgentWrite(w.deps, { ...w.base, tool: grant("github", "list_issues", { access: "read" }), args: { state: "open" } })).class).toBe("read");
    expect(w.reads).not.toHaveBeenCalled();
  });

  it("resolves label ids through the connector's lister, once per run", async () => {
    const w = wrapper();
    const tool = githubIssue();
    const args = (ids: string[]) => ({ ...DEMO, issue_number: 42, label_ids: ids });
    seedOwn(w, "github", "42", "example/demo");
    const ask = (ids: string[]) => classifyAgentWrite(w.deps, { ...w.base, tool, args: args(ids) });
    expect((await ask(["101"])).class).toBe("safe");
    expect((await ask(["102"])).class).toBe("consequential");
    expect((await ask(["999"])).class).toBe("consequential");
    expect(w.github).toHaveBeenCalledTimes(1);
    expect(w.github).toHaveBeenCalledWith({ orgId: TEST_ORG, connector: { type: "github", id: "github", repository: "example/demo" } });
  });

  it("fails closed when the label lookup fails or the connector type has no lister", async () => {
    const failing = wrapper({ lists: { github: async () => { throw new Error("down"); } } });
    seedOwn(failing, "github", "42", "example/demo");
    expect((await classifyAgentWrite(failing.deps, { ...failing.base, tool: githubIssue(), args: { ...DEMO, issue_number: 42, label_ids: ["101"] } })).class).toBe("consequential");
    const none = wrapper({ lists: {} });
    seedOwn(none, "linear", "ENG-1");
    expect((await classifyAgentWrite(none.deps, { ...none.base, tool: saveIssue(), args: { id: "ENG-1", labelIds: ["lbl-bug"] } })).class).toBe("consequential");
    // No ids, no lookup.
    expect((await classifyAgentWrite(none.deps, { ...none.base, tool: saveIssue(), args: { id: "ENG-1", title: "t" } })).class).toBe("safe");
  });

  it("reads the run's own items from the table, under the org and the task", async () => {
    const w = wrapper();
    const tool = saveIssue({ resultItemArguments: ["identifier"] });
    const created = prepareAgentWrite(tool, { title: "Broken" }, { allowMentions: false }).args;
    expect((await classifyAgentWrite(w.deps, { ...w.base, tool, args: created })).class).toBe("safe");
    const recorded = await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool, args: created, resultText: JSON.stringify({ id: "uuid-1", identifier: "ENG-12" }) });
    expect(recorded).toEqual({ recorded: 2, failed: false });
    const change = { id: "ENG-12", title: "New title" };
    expect((await classifyAgentWrite(w.deps, { ...w.base, tool, args: change })).class).toBe("safe");
    expect((await classifyAgentWrite(w.deps, { ...w.base, tool, args: { id: "ENG-13", title: "t" } })).class).toBe("consequential");
    // Another task or another org sees nothing of it.
    expect((await classifyAgentWrite(w.deps, { ...w.base, taskId: "task-2", tool, args: change })).class).toBe("consequential");
    expect((await classifyAgentWrite(w.deps, { ...w.base, orgId: ORG_B, tool, args: change })).class).toBe("consequential");
  });

  it("fails closed when the run's own items can't be read", async () => {
    const w = wrapper();
    const tool = saveIssue({ resultItemArguments: ["identifier"] });
    await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool, args: { title: "t" }, resultText: JSON.stringify({ identifier: "ENG-12" }) });
    const broken = { ...w.deps, documentClient: { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "QueryCommand") throw new Error("table down"); return w.db.send(command as never); } } };
    expect((await classifyAgentWrite(broken as never, { ...w.base, tool, args: { id: "ENG-12", title: "t" } })).class).toBe("consequential");
  });

  it("fails closed when the opt-out can't be read after a clean scan, and when the run cache breaks", async () => {
    const w = wrapper();
    const flaky = { ...w.deps, documentClient: { send: async (command: { constructor: { name: string } }) => { if (command.constructor.name === "GetCommand") throw new Error("table down"); return w.db.send(command as never); } } };
    expect((await classifyAgentWrite(flaky as never, { ...w.base, tool: githubComment(), args: { ...DEMO, body: PLAIN } })).class).toBe("consequential");
    const noCache = { ...w.deps, runCache: () => ({ get: async () => { throw new Error("cache down"); }, set: async () => { throw new Error("cache down"); } }) };
    seedOwn(w, "linear", "ENG-1");
    expect((await classifyAgentWrite(noCache, { ...w.base, tool: saveIssue(), args: { id: "ENG-1", labelIds: ["lbl-bug"] } })).class).toBe("consequential");
  });

  it("uses the org's guardrails passed in, and the project's policy", async () => {
    const w = wrapper();
    const guardrails = { extraTriggerLabels: [], extraCommandWords: ["engage"] };
    expect((await classifyAgentWrite(w.deps, { ...w.base, tool: linearComment(), args: { issueId: "1", body: "engage" }, guardrails })).class).toBe("consequential");
    const denied = await classifyAgentWrite(w.deps, { ...w.base, tool: linearComment(), args: { issueId: "1", body: PLAIN }, projectPolicy: policy({ tool: "create_comment", connector: "linear", outcome: "deny" }) });
    expect(denied.denied).toMatchObject({ rule: 1 });
  });

  it("keeps the run cache and the own items under the run's org", async () => {
    const w = wrapper({ files: { [WORKFLOW]: workflow("issue_comment") } });
    await classifyAgentWrite(w.deps, { ...w.base, tool: githubComment(), args: { ...DEMO, body: PLAIN } });
    const cached = w.db.find((item) => item.entityType === "RUN_CACHE");
    expect(cached.length).toBeGreaterThan(0);
    for (const item of cached) expect(item.pk).toContain(`ORG#${TEST_ORG}#`);
  });
});

describe("recordOwnItems and loadOwnItems", () => {
  const tool = saveIssue({ resultItemArguments: ["identifier"] });
  const key = (value: string, connector = "linear") => ({ pk: `ORG#${TEST_ORG}#AGENT_ITEMS#task-1`, sk: `${connector}##${value}` });

  it("records every value at the item paths of the result after a create, under AGENT_ITEMS#<task>", async () => {
    const w = wrapper();
    const outcome = await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool, args: { title: "t" }, resultText: JSON.stringify({ id: "uuid-1", identifier: "ENG-12", title: "t" }) });
    expect(outcome).toEqual({ recorded: 2, failed: false });
    const items = w.db.find((item) => String(item.pk).includes("AGENT_ITEMS#"));
    expect(items.map((item) => [item.pk, item.sk]).sort()).toEqual([[key("ENG-12").pk, key("ENG-12").sk], [key("uuid-1").pk, key("uuid-1").sk]].sort());
    for (const item of items) expect(item).toMatchObject({ orgId: TEST_ORG, taskId: "task-1" });
    expect(typeof items[0]!.indexExpiresAt).toBe("number");
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1" })).toEqual(new Set(["linear##ENG-12", "linear##uuid-1"]));
  });

  it("records a GitHub number as a string, and reads an MCP result's text content", async () => {
    const w = wrapper();
    const github = githubIssue({ resultItemArguments: ["number"] });
    await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool: github, args: { ...REPO, title: "t" }, resultText: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ number: 42, id: 9001 }) }] }) });
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1" })).toEqual(new Set(["github#o/r#42"]));
  });

  it("records nothing for a change, a read, a result that is not JSON or holds no value at the paths", async () => {
    const w = wrapper();
    const result = JSON.stringify({ identifier: "ENG-99" });
    expect(await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool, args: { id: "ENG-1", title: "t" }, resultText: result })).toEqual({ recorded: 0, failed: false });
    expect(await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool: saveIssue({ access: "read" }), args: { title: "t" }, resultText: result })).toEqual({ recorded: 0, failed: false });
    expect(await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool, args: { title: "t" }, resultText: "created it, thanks" })).toEqual({ recorded: 0, failed: false });
    expect(await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool, args: { title: "t" }, resultText: JSON.stringify({ other: 1 }) })).toEqual({ recorded: 0, failed: false });
    expect(w.db.find((item) => String(item.pk).includes("AGENT_ITEMS#"))).toEqual([]);
  });

  it("skips values it won't key on: empty, control characters, very long, not a string or number", async () => {
    const w = wrapper();
    const outcome = await recordOwnItems(w.deps, {
      orgId: TEST_ORG, taskId: "task-1", tool: mcp("create_thing", { itemArguments: ["id"], resultItemArguments: ["items[].id", "obj"] }), args: { title: "t" },
      resultText: JSON.stringify({ id: "ok-1", items: [{ id: "" }, { id: "bad\u0000id" }, { id: "x".repeat(300) }, { id: "fine-2" }, { id: true }], obj: { a: 1 } }),
    });
    expect(outcome).toEqual({ recorded: 2, failed: false });
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1" })).toEqual(new Set(["mcp##ok-1", "mcp##fine-2"]));
  });

  it("keeps a repeat of the same result to the same items, and never lets one task or org see another's", async () => {
    const w = wrapper();
    const input = { orgId: TEST_ORG, taskId: "task-1", tool, args: { title: "t" }, resultText: JSON.stringify({ identifier: "ENG-12" }) };
    await recordOwnItems(w.deps, input);
    await recordOwnItems(w.deps, input);
    expect(w.db.find((item) => String(item.pk).includes("AGENT_ITEMS#"))).toHaveLength(1);
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-2" })).toEqual(new Set());
    expect(await loadOwnItems(w.deps, { orgId: ORG_B, taskId: "task-1" })).toEqual(new Set());
    const [item] = w.db.find((candidate) => String(candidate.pk).includes("AGENT_ITEMS#"));
    w.db.set({ ...item!, orgId: ORG_B });
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1" })).toEqual(new Set());
    w.db.set({ ...item!, taskId: "task-9" });
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1" })).toEqual(new Set());
  });

  it("reports a failed write instead of throwing, so a create that happened is not reported as failed", async () => {
    const w = wrapper();
    const broken = { ...w.deps, documentClient: { send: async () => { throw new Error("table down"); } } };
    const outcome = await recordOwnItems(broken, { orgId: TEST_ORG, taskId: "task-1", tool, args: { title: "t" }, resultText: JSON.stringify({ identifier: "ENG-12" }) });
    expect(outcome).toEqual({ recorded: 0, failed: true });
  });

  it("refuses a task id that is not a plain id, before it reaches a key", async () => {
    const w = wrapper();
    for (const taskId of ["", "a#b", "a b", "x".repeat(101), "../x"]) {
      expect(await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId, tool, args: { title: "t" }, resultText: JSON.stringify({ identifier: "ENG-12" }) })).toEqual({ recorded: 0, failed: true });
      await expect(loadOwnItems(w.deps, { orgId: TEST_ORG, taskId })).rejects.toThrow();
    }
    expect(w.db.find((item) => String(item.pk).includes("AGENT_ITEMS#"))).toEqual([]);
  });

  it("keeps at most 50 items of one result, in one transaction, so a later change to the rest asks", async () => {
    const w = wrapper();
    const items = Array.from({ length: 150 }, (_, index) => ({ id: `id-${String(index)}` }));
    const outcome = await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool: mcp("create_things", { itemArguments: ["id"], resultItemArguments: ["items[].id"] }), args: { title: "t" }, resultText: JSON.stringify({ items }) });
    expect(outcome).toEqual({ recorded: 50, failed: false });
    expect(w.db.find((item) => String(item.pk).includes("AGENT_ITEMS#"))).toHaveLength(50);
  });
});

describe("the memory-only run cache still works with the wrapper's lookups", () => {
  it("scans through a cache that holds nothing across calls", async () => {
    const w = wrapper();
    const deps = { ...w.deps, runCache: () => memoryRunCache() };
    expect((await classifyAgentWrite(deps, { ...w.base, tool: githubComment(), args: { ...DEMO, body: PLAIN } })).class).toBe("safe");
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1 (review task-20b-review.md): every probe of the review's tables, and the controller's rulings
// ---------------------------------------------------------------------------------------------

/** GitHub's tools: the repository is the scope of an item number. */
const ghScope = ["owner", "repo"];
const gh = (name: string, over: GrantOptions = {}) => grant("github", name, { itemScopeArguments: ghScope, ...over });
const OWN_GH = new Set(["github#o/r#42"]);
const REPO = { owner: "o", repo: "r" };

describe("fix round 1: C1, a write is safe only when its name says it records something", () => {
  it("makes every write with a verb outside the record verbs consequential, whatever its item arguments", () => {
    const names = [
      "drop_table", "truncate_table", "terminate_instance", "wipe_disk", "erase_device", "uninstall_app", "ban_user", "rerun_workflow", "redeploy_service",
      "unpublish_page", "scale_deployment", "invoke_lambda", "launch_instance", "exec_command", "bash", "sql", "share_file", "upload_file",
    ];
    for (const name of names) {
      expect(classOf(mcp(name), { target: "x" }), name).toBe("consequential");
      expect(classOf(mcp(name, { itemArguments: undefined }), { target: "x" }), `${name} undeclared`).toBe("consequential");
    }
  });

  it("keeps the record verbs safe", () => {
    const names = ["create_note", "add_note", "new_document", "insert_note", "save_draft", "upsert_document", "write_note", "log_comment", "note_down", "comment_on", "reply_to_comment", "post_comment", "append_comment", "record_note", "annotate_document"];
    for (const name of names) expect(classOf(mcp(name), { text: "x" }), name).toBe("safe");
  });

  it("is a soft cause: a code override may lower it", () => {
    expect(classOf(mcp("drop_table"), { target: "x" }, { overrides: { mcp: { drop_table: "safe" } } })).toBe("safe");
    // But not when something else hard also raised the call.
    expect(classOf(mcp("drop_table"), { target: "x", assigneeId: "u" }, { overrides: { mcp: { drop_table: "safe" } } })).toBe("consequential");
  });

  it("does not make a reply or a post a record unless it is a comment", () => {
    expect(classOf(mcp("reply_email"), { text: "x" })).toBe("consequential");
    expect(classOf(mcp("post_message"), { text: "x" })).toBe("consequential");
    expect(classOf(mcp("post_comment"), { text: "x" })).toBe("safe");
  });
});

describe("fix round 1: C2 and M3, names split on every character that is not a letter or digit, after NFKC", () => {
  it("finds a merge in a namespaced name, and in a fullwidth one", () => {
    const own = { ownItems: new Set(["github#o/r#9"]) };
    expect(classOf(gh("pulls.merge", { itemArguments: ["pull_number"] }), { ...REPO, pull_number: 9, commit_title: "x" }, own)).toBe("merge");
    for (const name of ["pulls/merge", "pulls:merge", "pulls merge", "ｍｅｒｇｅ_pr", "pulls.ｍｅｒｇｅ", "squashMergePR"]) expect(classOf(mcp(name), {}), name).toBe("merge");
  });

  it("finds outward words and destructive words in namespaced names", () => {
    for (const name of ["email.send", "sms/send", "chat:post", "messages.send", "mail.send"]) expect(classOf(mcp(name), { text: "x" }), name).toBe("consequential");
    expect(classOf(mcp("repos.delete"), { id: "r" })).toBe("consequential");
  });

  it("does not make a namespaced read a write, and keeps a read-approved write word consequential", () => {
    expect(classOf(grant("mcp", "repos.delete", { access: "read" }), { id: "r" })).toBe("consequential");
    expect(classOf(grant("mcp", "repos.pulls.merge", { access: "read" }), {})).toBe("consequential");
    expect(classOf(grant("mcp", "repos.list", { access: "read" }), {})).toBe("read");
    expect(classOf(grant("mcp", "ｌｉｓｔ_issues", { access: "read" }), {})).toBe("read");
    expect(classOf(grant("mcp", "ｄｅｌｅｔｅ_issue", { access: "read" }), {})).toBe("consequential");
  });

  it("finds a destructive name in the destructive signal too", () => {
    expect(classOf(mcp("repos.close", { itemArguments: ["id"] }), { id: "r", labels: ["bug"] })).toBe("consequential");
  });
});

describe("fix round 1: I1, outward keys and words by containment", () => {
  it("makes a create carrying a recipient-like key consequential", () => {
    for (const key of ["emailAddress", "recipientEmail", "toAddress", "phoneNumber", "webhookUrl", "callbackUrl", "channel", "channelId", "shareWith", "to", "cc"]) {
      expect(classOf(mcp("create_note"), { text: "x", [key]: "attacker@example.com" }), key).toBe("consequential");
    }
    expect(classOf(mcp("create_note"), { text: "x", meta: { notify_email: "a@b.com" } })).toBe("consequential");
    expect(classOf(mcp("create_note"), { text: "x", title: "t" })).toBe("safe");
  });

  it("makes more outward names consequential", () => {
    for (const name of ["share_file", "forward_message", "mail_user", "dm_user", "chat_send", "tweet_status", "broadcast_update", "create_share", "add_forward", "create_dm", "create_tweet", "create_broadcast", "create_mail", "create_chat"]) {
      expect(classOf(mcp(name), { text: "x" }), name).toBe("consequential");
    }
  });
});

describe("fix round 1: I2, keys that assign work, request a review or hand something over", () => {
  it("makes a labelled tracker create carrying one consequential", () => {
    const create = saveIssue();
    for (const key of ["assignee_ids", "assigneeIds", "reviewer_ids", "team_reviewers", "assignedTo", "assignee_gid", "reviewer", "leadId", "memberIds", "subscriberIds", "delegateTo", "ownerEmail", "ownership"]) {
      expect(classOf(create, { title: "t", labels: ["bug", "rovara"], [key]: ["5"] }), key).toBe("consequential");
    }
    expect(classOf(create, { title: "t", labels: ["bug", "rovara"] })).toBe("safe");
  });

  it("makes them consequential on an item the run created too, but not a declared scope argument", () => {
    const own = { ownItems: new Set(["linear##ENG-1"]) };
    expect(classOf(saveIssue(), { id: "ENG-1", title: "t", team_reviewers: ["a"] }, own)).toBe("consequential");
    expect(classOf(gh("add_issue_comment", { itemArguments: [] }), { ...REPO, issue_number: 1, body: PLAIN })).toBe("safe");
    expect(classOf(grant("github", "add_issue_comment", { itemArguments: [] }), { ...REPO, issue_number: 1, body: PLAIN })).toBe("consequential");
  });
});

describe("fix round 1: I3, tracker creates by plural, compound and more words", () => {
  const names = ["create_issues", "create_tasks", "batch_create_tickets", "create_subtask", "create_subissue", "create_card", "add_todo", "create_stories", "create_bugs", "create_epics", "create_story"];
  it("makes each consequential without the label and safe with it", () => {
    for (const name of names) {
      const tool = mcp(name, { labelArgument: "labels" });
      expect(classOf(tool, { title: "t" }), name).toBe("consequential");
      expect(classOf(tool, { title: "t", labels: ["rovara"] }), `${name} labelled`).toBe("safe");
      expect(prepareAgentWrite(tool, { title: "t" }, { allowMentions: false }).args, `${name} prepared`).toEqual({ title: "t", labels: ["rovara"] });
    }
  });
});

describe("fix round 1: I4, labels at any depth", () => {
  const ownJira = { ownItems: new Set(["jira##PROJ-1"]) };
  const edit = (over: GrantOptions = {}) => grant("jira", "edit_issue", { itemArguments: ["issueKey"], ...over });

  it("scans labels nested in fields and in Jira update operations", () => {
    expect(classOf(edit(), { issueKey: "PROJ-1", fields: { labels: ["deploy"] } }, ownJira)).toBe("consequential");
    expect(classOf(edit(), { issueKey: "PROJ-1", fields: { labels: ["bug"] } }, ownJira)).toBe("safe");
    expect(classOf(edit({ labelArgument: "fields.labels" }), { issueKey: "PROJ-1", update: { labels: [{ add: "automerge" }] } }, ownJira)).toBe("consequential");
    expect(classOf(edit(), { issueKey: "PROJ-1", update: { labels: [{ add: "bug" }] } }, ownJira)).toBe("safe");
  });

  it("scans a singular label and resolves a singular label id", () => {
    const addLabel = grant("linear", "add_issue_label", { itemArguments: ["issueId"] });
    const own = { ownItems: new Set(["linear##ENG-1"]) };
    expect(classOf(addLabel, { issueId: "ENG-1", label: "automerge" }, own)).toBe("consequential");
    expect(classOf(addLabel, { issueId: "ENG-1", label: "bug" }, own)).toBe("safe");
    expect(classOf(addLabel, { issueId: "ENG-1", labelId: "lbl-deploy" }, own)).toBe("consequential");
    expect(classOf(addLabel, { issueId: "ENG-1", labelId: "lbl-bug" }, own)).toBe("safe");
    expect(classOf(addLabel, { issueId: "ENG-1", labelId: "nobody" }, own)).toBe("consequential");
  });

  it("resolves label ids nested in a create's input", () => {
    const create = mcp("create_note");
    expect(classOf(create, { input: { labelIds: ["lbl-deploy"] } })).toBe("consequential");
    expect(classOf(create, { input: { labelIds: ["lbl-bug"] } })).toBe("safe");
    expect(classOf(create, { input: { nested: { addedLabelIds: ["nobody"] } } })).toBe("consequential");
    expect(classOf(create, { items: [{ addLabelIds: ["lbl-auto"] }] })).toBe("consequential");
  });

  it("uses the same ids in the wrapper's lookup", async () => {
    const w = wrapper();
    const create = grant("linear", "create_note");
    const names = await classifyAgentWrite(w.deps, { ...w.base, tool: create, args: { input: { labelIds: ["lbl-deploy"] } } });
    expect(names.class).toBe("consequential");
    expect((await classifyAgentWrite(w.deps, { ...w.base, tool: create, args: { input: { labelIds: ["lbl-bug"] } } })).class).toBe("safe");
  });
});

describe("fix round 1: I5, removing labels or replacing the label set", () => {
  it("makes removing a label from an item the run did not create consequential", () => {
    const tool = gh("issue_write", { itemArguments: ["issue_number"] });
    expect(classOf(tool, { ...REPO, issue_number: 7, removeLabels: ["do-not-merge"] })).toBe("consequential");
    expect(classOf(tool, { ...REPO, issue_number: 7, removedLabelIds: ["lbl-bug"] })).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-9", removedLabelIds: ["lbl-bug"] })).toBe("consequential");
    expect(classOf(grant("jira", "edit_issue", { itemArguments: ["issueKey"] }), { issueKey: "P-1", update: { labels: [{ remove: "hold" }] } })).toBe("consequential");
    expect(classOf(grant("jira", "edit_issue", { itemArguments: ["issueKey"] }), { issueKey: "P-1", update: { labels: [{ set: ["bug"] }] } })).toBe("consequential");
  });

  it("makes replacing GitHub's whole label set consequential, and adding a label safe", () => {
    const tool = gh("issue_write", { itemArguments: ["issue_number"] });
    expect(classOf(tool, { ...REPO, issue_number: 7, labels: ["bug"] })).toBe("consequential");
    expect(classOf(tool, { ...REPO, issue_number: 7, addLabels: ["bug"] }, { labelNames: LABELS })).toBe("safe");
  });

  it("replaces a label set only where the tool says it replaces", () => {
    expect(classOf(saveIssue(), { id: "ENG-9", labelIds: ["lbl-bug"] })).toBe("safe");
    expect(classOf(saveIssue({ labelsReplace: true }), { id: "ENG-9", labelIds: ["lbl-bug"] })).toBe("consequential");
    expect(classOf(saveIssue({ labelsReplace: true }), { id: "ENG-9", labels: ["bug"] })).toBe("consequential");
    expect(classOf(gh("issue_write", { itemArguments: ["issue_number"], labelsReplace: false }), { ...REPO, issue_number: 7, labels: ["bug"] })).toBe("safe");
  });

  it("allows both on an item the run created", () => {
    const tool = gh("issue_write", { itemArguments: ["issue_number"] });
    expect(classOf(tool, { ...REPO, issue_number: 42, labels: ["bug"] }, { ownItems: OWN_GH })).toBe("safe");
    expect(classOf(tool, { ...REPO, issue_number: 42, removeLabels: ["wip"] }, { ownItems: OWN_GH })).toBe("safe");
  });
});

describe("fix round 1: I6, own items are scoped by the repository", () => {
  const tool = gh("issue_write", { itemArguments: ["issue_number"] });

  it("treats the same number in another repository as someone else's", () => {
    expect(classOf(tool, { ...REPO, issue_number: 42, title: "ok" }, { ownItems: OWN_GH })).toBe("safe");
    expect(classOf(tool, { owner: "o", repo: "OTHER", issue_number: 42, title: "pwned", body: "x" }, { ownItems: OWN_GH })).toBe("consequential");
    expect(classOf(tool, { owner: "x", repo: "r", issue_number: 42, title: "t" }, { ownItems: OWN_GH })).toBe("consequential");
    expect(classOf(tool, { owner: "O", repo: "R", issue_number: 42, title: "ok" }, { ownItems: OWN_GH })).toBe("safe");
  });

  it("gives a GitHub tool that declares no scope no own-item exemption", () => {
    const unscoped = grant("github", "issue_write", { itemArguments: ["issue_number"] });
    expect(classOf(unscoped, { issue_number: 42, title: "t" }, { ownItems: new Set(["github##42", "github#o/r#42"]) })).toBe("consequential");
  });

  it("needs every scope argument in the call", () => {
    expect(classOf(tool, { owner: "o", issue_number: 42, title: "t" }, { ownItems: OWN_GH })).toBe("consequential");
  });

  it("records items under connector, scope and value, and finds them again", async () => {
    const w = wrapper();
    const create = gh("issue_write", { itemArguments: ["issue_number"], resultItemArguments: ["number"], labelArgument: "labels" });
    const created = { ...REPO, title: "t", labels: ["bug", "rovara"] };
    expect(await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool: create, args: created, resultText: JSON.stringify({ number: 42 }) })).toEqual({ recorded: 1, failed: false });
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1" })).toEqual(new Set(["github#o/r#42"]));
    const edit = await classifyAgentWrite(w.deps, { ...w.base, repository: "o/r", tool: create, args: { ...REPO, issue_number: 42, title: "new" } });
    expect(edit.class).toBe("safe");
    const other = await classifyAgentWrite(w.deps, { ...w.base, repository: "o/r2", tool: create, args: { owner: "o", repo: "r2", issue_number: 42, title: "new" } });
    expect(other.class).toBe("consequential");
  });

  it("records nothing when the create's scope arguments are missing, and keys a scope-free connector with an empty scope", async () => {
    const w = wrapper();
    const create = gh("issue_write", { itemArguments: ["issue_number"], resultItemArguments: ["number"] });
    expect(await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool: create, args: { title: "t" }, resultText: JSON.stringify({ number: 1 }) })).toEqual({ recorded: 0, failed: false });
    await recordOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1", tool: saveIssue({ resultItemArguments: ["identifier"] }), args: { title: "t" }, resultText: JSON.stringify({ identifier: "ENG-12" }) });
    expect(await loadOwnItems(w.deps, { orgId: TEST_ORG, taskId: "task-1" })).toEqual(new Set(["linear##ENG-12"]));
  });
});

describe("fix round 1: I7, the repository of a GitHub call is the call's own", () => {
  const comment = gh("add_issue_comment", { itemArguments: [] });
  const run = (args: Record<string, unknown>, repository = "example/demo") => {
    const w = wrapper();
    return classifyAgentWrite(w.deps, { ...w.base, repository, tool: comment, args }).then((result) => ({ result, reads: w.reads }));
  };

  it("makes a call to another repository, or one with no repository arguments, consequential without scanning", async () => {
    const other = await run({ owner: "example", repo: "other", issue_number: 1, body: PLAIN });
    expect(other.result.class).toBe("consequential");
    expect(other.reads).not.toHaveBeenCalled();
    const missing = await run({ issue_number: 1, body: PLAIN });
    expect(missing.result.class).toBe("consequential");
    expect((await run({ owner: "example", issue_number: 1, body: PLAIN })).result.class).toBe("consequential");
    expect((await run({ owner: 5, repo: "demo", issue_number: 1, body: PLAIN })).result.class).toBe("consequential");
  });

  it("matches the repository without regard to case", async () => {
    const same = await run({ owner: "Example", repo: "DEMO", issue_number: 1, body: PLAIN });
    expect(same.result.class).toBe("safe");
    expect(same.reads).toHaveBeenCalled();
  });
});

describe("fix round 1: I8, only item and scope arguments are exempt from the safe-change check", () => {
  it("treats an enum non-text argument as content of the change", () => {
    const tool = mcp("update_doc", { itemArguments: ["docId"], nonTextArguments: ["sharing"] });
    expect(classOf(tool, { docId: "d", labels: ["x"], sharing: "public" })).toBe("consequential");
    expect(classOf(tool, { docId: "d", labels: ["x"] })).toBe("safe");
    const scoped = mcp("update_doc", { itemArguments: ["docId"], itemScopeArguments: ["workspace"] });
    expect(classOf(scoped, { docId: "d", workspace: "w", labels: ["x"] })).toBe("safe");
  });
});

describe("fix round 1: M1, an exact ask rule or always-ask entry makes a read wait", () => {
  const read = grant("linear", "list_issues", { access: "read" });

  it("honours an admin ask rule that names the read tool exactly", () => {
    const exact = classify(read, {}, { projectPolicy: policy({ tool: "list_issues", connector: "linear", outcome: "ask" }) });
    expect(exact.class).toBe("consequential");
    expect(exact.ignoredRules).toEqual([]);
    const presented = classify(read, {}, { projectPolicy: policy({ tool: "linear__list_issues", outcome: "ask" }) });
    expect(presented.class).toBe("consequential");
  });

  it("honours an always-ask entry that names it exactly", () => {
    expect(classOf(read, {}, { rules: { alwaysAsk: ["list_issues"] } })).toBe("consequential");
    expect(classOf(read, {}, { rules: { alwaysAsk: ["linear__list_issues"] } })).toBe("consequential");
  });

  it("still lets a wildcard, a raising treatAs and suggest autonomy pass a read", () => {
    const wildcard = classify(read, {}, { projectPolicy: policy({ tool: "list_*", connector: "linear", outcome: "ask" }), rules: { alwaysAsk: ["list_*", "*"] }, autonomy: "suggest" });
    expect(wildcard.class).toBe("read");
    expect(wildcard.ignoredRules).toEqual([1]);
    expect(classOf(read, {}, { projectPolicy: policy({ tool: "list_issues", connector: "linear", treatAs: "destructive" }) })).toBe("read");
  });

  it("still refuses on an exact deny", () => {
    const denied = classify(read, {}, { projectPolicy: policy({ tool: "list_issues", connector: "linear", outcome: "deny" }) });
    expect(denied.denied).toMatchObject({ rule: 1 });
  });
});

describe("fix round 1: M4, any name word containing merge is a merge", () => {
  it("makes enable_automerge a merge for a write, and consequential for a read", () => {
    expect(classOf(mcp("enable_automerge"), {})).toBe("merge");
    expect(classOf(mcp("automerge_pr"), {})).toBe("merge");
    expect(classOf(mcp("enable_automerge"), {}, { overrides: { mcp: { enable_automerge: "safe" } } })).toBe("merge");
    expect(classOf(grant("mcp", "enable_automerge", { access: "read" }), {})).toBe("consequential");
    expect(classOf(mcp("create_emergency_note"), { name: "x" })).toBe("safe");
  });
});

describe("fix round 1: M5, comma lists and item-path values count for bulk", () => {
  it("counts a comma list in a declared item argument", () => {
    const tool = mcp("update_items", { itemArguments: ["ids"] });
    const own = { ownItems: new Set(["mcp##1", "mcp##2", "mcp##3", "mcp##4", "mcp##5", "mcp##6", "mcp##7", "mcp##8"]) };
    expect(classOf(tool, { ids: "1,2,3,4,5", labels: ["bug"] })).toBe("safe");
    expect(classOf(tool, { ids: "1,2,3,4,5,6", labels: ["bug"] })).toBe("consequential");
    expect(classOf(tool, { ids: "1, 2, 3, 4, 5, 6,7,8", labels: ["bug"] }, own)).toBe("consequential");
  });

  it("counts the values at an item path across an array of objects", () => {
    const tool = mcp("update_items", { itemArguments: ["a.b.items[].id"] });
    const items = (count: number) => ({ a: { b: { items: Array.from({ length: count }, (_, index) => ({ id: String(index) })) } }, labels: ["bug"] });
    const own = { ownItems: new Set(Array.from({ length: 10 }, (_, index) => `mcp##${String(index)}`)) };
    expect(classOf(tool, items(5), own)).toBe("safe");
    expect(classOf(tool, items(6), own)).toBe("consequential");
  });
});

describe("fix round 1: the read-name exceptions", () => {
  it("lists a few code-owned names that stay reads", () => {
    expect(Object.keys(READ_NAME_EXCEPTIONS).sort()).toEqual(["jira", "mcp"]);
    for (const names of Object.values(READ_NAME_EXCEPTIONS)) expect(names).toContain("get_transitions");
  });

  it("makes get_transitions a read for Jira and MCP, in any spelling of the name", () => {
    for (const name of ["get_transitions", "list_transitions", "getTransitionsForJiraIssue", "getIssueTransitions", "get.transitions"]) {
      expect(classOf(grant("jira", name, { access: "read" }), { issueKey: "P-1" }), `jira ${name}`).toBe("read");
      expect(classOf(grant("mcp", name, { access: "read" }), { issueKey: "P-1" }), `mcp ${name}`).toBe("read");
    }
  });

  it("covers only the listed names, only for the listed connector types, and only a read-approved tool", () => {
    expect(classOf(grant("github", "get_transitions", { access: "read" }), {})).toBe("consequential");
    expect(classOf(grant("jira", "get_transitions_and_apply", { access: "read" }), {})).toBe("consequential");
    expect(classOf(grant("jira", "transition_issue", { access: "read" }), {})).toBe("consequential");
    expect(classOf(grant("jira", "get_transitions", { access: "write" }), {})).not.toBe("read");
    expect(classOf(grant("jira", "get_transitions", { access: "read", hints: { readOnlyHint: false } }), {})).toBe("consequential");
    expect(isReadByName(grant("jira", "get_transitions", { access: "read" }))).toBe(true);
    expect(isReadByName(grant("github", "get_transitions", { access: "read" }))).toBe(false);
  });
});

describe("fix round 1: non-text arguments never name content", () => {
  it("reports a fact that names title, body, text, description, comment, message or summary", () => {
    for (const name of ["title", "body", "text", "description", "comment", "message", "summary", "fields.description", "input.Body", "Title"]) {
      expect(nonTextFactProblems({ connector: "x", upstreamName: "y", access: "write", nonTextArguments: [name] }), name).toHaveLength(1);
      expect(nonTextFactProblems({ connector: "x", upstreamName: "y", access: "write", itemScopeArguments: [name] }), `scope ${name}`).toHaveLength(1);
    }
    expect(nonTextFactProblems({ connector: "x", upstreamName: "y", access: "write", nonTextArguments: ["owner", "repo", "path", "sharing"], itemScopeArguments: ["owner", "repo"] })).toEqual([]);
    expect(nonTextFactProblems({ connector: "x", upstreamName: "y", access: "write" })).toEqual([]);
  });

  it("makes the classifier scan such an argument anyway", () => {
    const tool = mcp("create_note", { nonTextArguments: ["body", "path"] });
    expect(classOf(tool, { body: "/deploy production" })).toBe("consequential");
    expect(classOf(tool, { body: "plain", path: "/usr/bin" })).toBe("safe");
    expect(prepareAgentWrite(tool, { body: "cc @alice", path: "@x" }, { allowMentions: false }).args).toEqual({ body: "cc alice", path: "@x" });
  });
});

describe("fix round 1: pins from the mutation run", () => {
  it("makes a name that records something and also acts on the world consequential", () => {
    for (const name of ["create_and_deploy", "update_and_restart", "add_and_run", "save_and_trigger"]) expect(classOf(mcp(name), { target: "x" }), name).toBe("consequential");
  });

  it("makes a label operation that removes or sets labels consequential on an item the run did not create", () => {
    expect(classOf(saveIssue(), { id: "ENG-9", labels: [{ remove: "hold" }] })).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-9", labels: [{ set: ["bug"] }] })).toBe("consequential");
    expect(classOf(saveIssue(), { id: "ENG-9", labels: [{ add: "bug" }] })).toBe("safe");
  });

  it("compares the call's repository with the given one without regard to case on both sides", async () => {
    const w = wrapper();
    const result = await classifyAgentWrite(w.deps, { ...w.base, repository: "Example/Demo", tool: githubComment(), args: { ...DEMO, body: PLAIN } });
    expect(result.class).toBe("safe");
  });

  it("counts an array at a deep item path for bulk", () => {
    const tool = mcp("update_items", { itemArguments: ["a.b.ids"] });
    const own = { ownItems: new Set(["mcp##[1,2,3,4,5,6]", "mcp##[1,2,3]"]) };
    expect(classOf(tool, { a: { b: { ids: [1, 2, 3] } }, labels: ["bug"] }, own)).toBe("safe");
    expect(classOf(tool, { a: { b: { ids: [1, 2, 3, 4, 5, 6] } }, labels: ["bug"] }, own)).toBe("consequential");
  });

  it("scans a scope argument that names a free-text field", () => {
    const tool = mcp("create_note", { itemScopeArguments: ["title"] });
    expect(classOf(tool, { title: "/deploy production" })).toBe("consequential");
  });

  it("keeps the destructive signal on a namespaced name hard, so an override cannot lower it", () => {
    const tool = mcp("repos.close", { itemArguments: ["id"] });
    expect(classOf(tool, { id: "r", labels: ["bug"] }, { overrides: { mcp: { "repos.close": "safe" } } })).toBe("consequential");
  });

  it("matches project rules against the tool's name as the connector writes it", () => {
    const tool = mcp("createComment");
    expect(classOf(tool, { text: "x" })).toBe("safe");
    expect(classOf(tool, { text: "x" }, { projectPolicy: policy({ tool: "createComment", connector: "mcp", outcome: "ask" }) })).toBe("consequential");
    expect(classify(tool, { text: "x" }, { projectPolicy: policy({ tool: "createComment", connector: "mcp", outcome: "deny" }) }).denied).toMatchObject({ rule: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 2 (task-20b-recheck-1.md): N1 to N4
// ---------------------------------------------------------------------------------------------

describe("fix round 2: N1, a create is safe only for a record verb and a record object", () => {
  it("makes a create of something that moves money, grants access, deploys or pages consequential", () => {
    const names = [
      "create_payment", "create_payout", "create_invoice", "create_payment_link", "record_payment", "create_order", "add_collaborator", "add_member", "add_admin",
      "create_user", "create_api_key", "create_access_token", "add_ssh_key", "save_secret", "create_deployment", "new_deployment", "create_release", "create_build",
      "create_pipeline", "create_job", "create_schedule", "create_webhook", "create_or_update_file", "create_incident", "create_alert", "create_page", "create_campaign",
    ];
    for (const name of names) {
      expect(classOf(mcp(name), { name: "x", value: "y" }), name).toBe("consequential");
      expect(classOf(mcp(name, { itemArguments: undefined }), { name: "x", value: "y" }), `${name} undeclared`).toBe("consequential");
    }
    expect(classOf(gh("add_collaborator", { itemArguments: [] }), { ...REPO, username: "u", permission: "admin" })).toBe("consequential");
  });

  it("keeps a create of a record safe", () => {
    const names = [
      "create_comment", "create_note", "add_note", "create_label", "add_tag", "create_reaction", "create_draft", "create_document", "create_doc", "create_branch",
      "create_pull_request", "create_pr", "create_pullrequest", "add_comment", "create_notes", "create_comments", "add_issue_comment", "post_comment",
    ];
    for (const name of names) expect(classOf(mcp(name), { text: "x" }), name).toBe("safe");
  });

  it("makes the object of the tracker words and their forms a record, which still needs the label", () => {
    expect(classOf(mcp("create_issues", { labelArgument: "labels" }), { title: "t", labels: ["rovara"] })).toBe("safe");
    expect(classOf(mcp("create_issues", { labelArgument: "labels" }), { title: "t" })).toBe("consequential");
  });

  it("is a soft cause: a code override may lower it, but not when something hard also raised the call", () => {
    expect(classOf(mcp("create_payment"), { name: "x" }, { overrides: { mcp: { create_payment: "safe" } } })).toBe("safe");
    expect(classOf(mcp("create_payment"), { name: "x", to: "a@b.com" }, { overrides: { mcp: { create_payment: "safe" } } })).toBe("consequential");
  });
});

describe("fix round 2: N2, any key with label or tag in it is a label path", () => {
  const ownJira = { ownItems: new Set(["mcp##I-1"]) };
  const update = mcp("update_issue", { itemArguments: ["id"] });

  it("scans label names under labelNames, label_names, label_name and tags", () => {
    for (const key of ["labelNames", "label_names", "label_name", "tags", "tagNames", "issueLabels"]) {
      expect(classOf(mcp("create_note"), { text: "x", [key]: ["deploy"] }), `create ${key}`).toBe("consequential");
      expect(classOf(mcp("update_issue", { itemArguments: ["id"] }), { id: "I-1", [key]: ["automerge"] }, { ownItems: new Set(["mcp##I-1"]) }), `own ${key}`).toBe("consequential");
      expect(classOf(mcp("update_issue", { itemArguments: ["id"] }), { id: "I-1", [key]: ["bug"] }, { ownItems: new Set(["mcp##I-1"]) }), `own bug ${key}`).toBe("safe");
    }
    expect(classOf(update, { id: "I-1", tags: "bug, automerge" }, ownJira)).toBe("consequential");
  });

  it("resolves ids under tagIds, label_ids and other keys that hold label or tag ids", () => {
    for (const key of ["tagIds", "tag_ids", "labelIdList", "issueLabelIds"]) {
      expect(classOf(mcp("create_note"), { text: "x", [key]: ["lbl-deploy"] }), `${key} deploy`).toBe("consequential");
      expect(classOf(mcp("create_note"), { text: "x", [key]: ["lbl-bug"] }), `${key} bug`).toBe("safe");
      expect(classOf(mcp("create_note"), { text: "x", [key]: ["nobody"] }), `${key} unknown`).toBe("consequential");
    }
  });

  it("does not take stage as a tag", () => {
    expect(classOf(mcp("create_note"), { text: "x", stageId: "s1" })).toBe("safe");
  });

  it("counts the remove and removed forms of any such key as removing labels", () => {
    for (const key of ["removeTags", "remove_tag_ids", "removedLabelNames", "removeLabelNames", "removeTagIds"]) {
      expect(classOf(mcp("update_issue", { itemArguments: ["id"] }), { id: "I-9", [key]: ["x"] }), `${key} someone else's`).toBe("consequential");
      expect(classOf(mcp("update_issue", { itemArguments: ["id"] }), { id: "I-1", [key]: ["wip"] }, { ownItems: new Set(["mcp##I-1"]) }), `${key} own`).toBe("safe");
    }
  });
});

describe("fix round 2: removing a label from an own item is not a trigger", () => {
  it("does not scan a remove key as labels being added", () => {
    const tool = mcp("update_issue", { itemArguments: ["id"] });
    expect(classOf(tool, { id: "I-1", removeLabels: ["automerge"] }, { ownItems: new Set(["mcp##I-1"]) })).toBe("safe");
    expect(classOf(tool, { id: "I-1", removedLabelIds: ["lbl-deploy"] }, { ownItems: new Set(["mcp##I-1"]) })).toBe("safe");
  });
});

describe("fix round 2: N3, team and project keys", () => {
  it("makes any key with team or project in it consequential", () => {
    for (const key of ["team", "teamIds", "team_ids", "project", "projectIds", "project_ids", "projects", "teamId", "projectId"]) {
      expect(classOf(mcp("create_note"), { text: "x", [key]: ["t1"] }), key).toBe("consequential");
    }
  });

  it("keeps a declared scope argument exempt", () => {
    const tool = mcp("create_note", { itemScopeArguments: ["project"] });
    expect(classOf(tool, { text: "x", project: "p1" })).toBe("safe");
    expect(classOf(gh("add_issue_comment", { itemArguments: [] }), { ...REPO, issue_number: 1, body: PLAIN })).toBe("safe");
  });

  it("still lets a Linear change that sets only safe keys be safe", () => {
    expect(classOf(saveIssue(), { id: "ENG-9", labelIds: ["lbl-bug"], priority: 2 })).toBe("safe");
    expect(classOf(saveIssue(), { id: "ENG-9", projectId: "p1" })).toBe("consequential");
  });
});

describe("fix round 2: N4, a merge set by an argument is a merge", () => {
  const prOwn = { ownItems: new Set(["github#o/r#9", "mcp##9", "mcp##PR-1"]) };

  it("makes auto-complete, auto-merge and completion options a merge, even on a pull request the run created", () => {
    const azure = mcp("update_pull_request", { itemArguments: ["id"] });
    expect(classOf(azure, { id: "PR-1", autoCompleteSetBy: "me", completionOptions: { mergeStrategy: "squash" } }, prOwn)).toBe("merge");
    expect(classOf(azure, { id: "PR-1", completionOptions: { deleteSourceBranch: true } }, prOwn)).toBe("merge");
    const github = gh("update_pull_request", { itemArguments: ["n"] });
    expect(classOf(github, { ...REPO, n: 9, auto_merge: true }, { ownItems: new Set(["github#o/r#9"]) })).toBe("merge");
    expect(classOf(github, { ...REPO, n: 9, method: "merge" }, { ownItems: new Set(["github#o/r#9"]) })).toBe("merge");
    expect(classOf(github, { ...REPO, n: 9, enableAutoMerge: true }, { ownItems: new Set(["github#o/r#9"]) })).toBe("merge");
  });

  it("makes a create that sets auto-complete or auto-merge a merge", () => {
    const create = mcp("create_pull_request");
    expect(classOf(create, { title: "t", autoComplete: true })).toBe("merge");
    expect(classOf(create, { title: "t", auto_merge: true })).toBe("merge");
    expect(classOf(create, { title: "t", nested: { mergeWhenReady: "yes" } })).toBe("merge");
  });

  it("makes a method, action or merge method of merge, squash or rebase a merge", () => {
    const tool = mcp("update_pull_request", { itemArguments: ["n"] });
    for (const [key, value] of [["method", "merge"], ["method", "SQUASH"], ["action", "rebase"], ["mergeMethod", "squash"], ["merge_method", "rebase"], ["Action", "Merge"]] as Array<[string, string]>) {
      expect(classOf(tool, { n: 9, [key]: value }, { ownItems: new Set(["mcp##9"]) }), `${key}=${value}`).toBe("merge");
    }
    expect(classOf(tool, { n: 9, method: "create", labels: ["bug"] }, { ownItems: new Set(["mcp##9"]) })).toBe("safe");
    expect(classOf(mcp("create_comment"), { issueId: "1", body: "squash these", method: "comment" })).toBe("safe");
  });

  it("does not take an unset or false merge key for a merge", () => {
    const create = mcp("create_pull_request");
    expect(classOf(create, { title: "t", auto_merge: false })).toBe("safe");
    expect(classOf(create, { title: "t", autoComplete: null, completionOptions: {} })).toBe("safe");
  });

  it("stays a merge whatever else the call carries, and an override does not lower it", () => {
    const create = mcp("create_pull_request");
    expect(classOf(create, { title: "t", auto_merge: true, assigneeId: "u" }, { overrides: { mcp: { create_pull_request: "safe" } }, autonomy: "suggest" })).toBe("merge");
  });

  it("looks up nothing for a merge call in the wrapper", async () => {
    const w = wrapper();
    const github = gh("update_pull_request", { itemArguments: ["n"] });
    const result = await classifyAgentWrite(w.deps, { ...w.base, tool: github, args: { ...DEMO, n: 9, auto_merge: true } });
    expect(result.class).toBe("merge");
    expect(w.reads).not.toHaveBeenCalled();
  });

  it("does not make a read a merge", () => {
    expect(classOf(grant("mcp", "list_pull_requests", { access: "read" }), { auto_merge: true, method: "merge" })).toBe("read");
  });
});

// ---------------------------------------------------------------------------------------------
// Hardening 1 (review task-17-review.md M-2): a word for re-running something is a write word
// ---------------------------------------------------------------------------------------------

describe("hardening 1: rerun, retry, redeploy, rebuild and replay are write verbs", () => {
  const NAMES = ["rerun_failed_jobs", "retry_failed_jobs", "redeploy_service", "rebuild_project", "replay_webhook_delivery", "rerunFailedJobs", "retry-deployment"];

  it("makes a tool the project approved only for reading, whose name says one of them, wait", () => {
    for (const name of NAMES) {
      const tool = mcp(name, { access: "read" });
      expect(isReadByName(tool), name).toBe(false);
      expect(classOf(tool, {}), name).toBe("consequential");
      expect(classify(tool, {}).reason, name).toContain("approved this tool only for reading");
    }
  });

  it("does the same on a vendor connector, and keeps a hint that says read-only from lifting it", () => {
    for (const name of NAMES) {
      expect(classOf(grant("github", name, { access: "read", hints: { readOnlyHint: true } }), {}), name).toBe("consequential");
    }
  });

  it("makes the same tools, approved for writing, consequential too", () => {
    for (const name of NAMES) expect(classOf(mcp(name), { target: "x" }), name).toBe("consequential");
  });

  it("leaves ordinary reads alone, including names that only share letters with these verbs", () => {
    for (const name of ["list_failed_jobs", "get_workflow_status", "list_deployments", "list_replays_of_tests"]) {
      expect(classOf(mcp(name, { access: "read" }), {}), name).toBe("read");
    }
  });
});
