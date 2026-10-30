// Plan 3 Task 9: the org's skills registry. A skill is a SKILL.md an agent can read; an agent version pins the digest of each skill it
// uses when it is published, and a running step reads exactly those pinned contents through the internal route.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { getApprovalSubjectHandler, type ApprovalDependencies, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft } from "../../packages/broker/src/agents/changes.js";
import { validateRecipeForOrg } from "../../packages/broker/src/agents/guardrails.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { SKILL_CONTENT_MAX_BYTES, SkillStore, parseSkillMarkdown, skillDigest } from "../../packages/broker/src/agents/skills.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import type { AgentOwner } from "../../packages/contracts/src/agent-node.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import type { OrgId } from "../../packages/contracts/src/org-node.js";
import { agentKey, skillKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { AGENT_STEP_INSTRUCTIONS_MAX_BYTES, AgentStepPayloadSchema } from "../../packages/contracts/src/protocol.js";
import { MAX_RESOLVED_SKILLS, ResolvedRecipeSchema } from "../../packages/contracts/src/agent-recipe-node.js";
import type { OrgRole } from "../../packages/contracts/src/org-node.js";
import type { AgentId } from "../../packages/contracts/src/agent-node.js";
import { orgProjectCatalogKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { call as callBroker, loadSlackBroker } from "../support/slack-broker.js";
import { agentSkillsSource } from "../../packages/worker/src/agent-step.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const MEMBER: AgentOwner = { kind: "member", developerId: ALICE };
const START = Date.parse("2026-10-21T09:00:00.000Z");

/** The refusal a promise ends in: its code and its message without the `CODE: ` prefix the error class adds. */
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const skillFile = (name: string, description = "Use when triaging tickets.", body = "# Steps\n\n1. Read the ticket.\n") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { workspaceId: string; operationId: string; fence: number; actions: string[]; expiresAt: number };
const signing = { callbackSigningKey: "test-signing-key" };
const BASE = ["artifacts", "events", "result"];

describe("issueCapability", () => {
  it("grants the three base actions and nothing else by default", () => {
    expect(claimsOf(issueCapability(signing, "ws", "op", 3)).actions).toEqual(BASE);
    expect(claimsOf(issueCapability(signing, "ws", "op", 3, {})).actions).toEqual(BASE);
  });

  it("keeps the workspace, operation and fence in the claims and signs the body", () => {
    const token = issueCapability(signing, "ws-1", "op-1", 7);
    expect(claimsOf(token)).toMatchObject({ workspaceId: "ws-1", operationId: "op-1", fence: 7 });
    expect(token.split(".")).toHaveLength(2);
  });

  it.each([
    ["pullRequest", ["pull-request", "pull-request-update", "codebuild"]],
    ["feedbackBundles", ["feedback-bundles"]],
    ["feedbackApproval", ["feedback-approval"]],
    ["chatGptToken", ["chatgpt-token", "chatgpt-status"]],
    ["candidateExport", ["candidate-export", "candidate-build-source", "baseline-source"]],
    ["e2eModelBudget", ["e2e-model-budget"]],
    ["workflowE2E", ["e2e-admission", "e2e-evidence"]],
    ["modelAccess", ["model-access"]],
    ["agentSkills", ["agent-skills"]],
  ] as const)("%s adds its own actions and no others", (flag, added) => {
    const actions = claimsOf(issueCapability(signing, "ws", "op", 1, { [flag]: true })).actions;
    expect(actions.slice(0, 3)).toEqual(BASE);
    expect([...actions].sort()).toEqual([...BASE, ...added].sort());
  });

  it("a flag set to false adds nothing", () => {
    expect(claimsOf(issueCapability(signing, "ws", "op", 1, { pullRequest: false, agentSkills: false, modelAccess: false })).actions).toEqual(BASE);
  });

  it("lists every action in the order the positional flags always produced (the task capability of a workflow step)", () => {
    const all = issueCapability(signing, "ws", "op", 1, {
      pullRequest: true, feedbackBundles: true, feedbackApproval: true, chatGptToken: true, candidateExport: true, workflowE2E: true, modelAccess: true, agentSkills: true,
    });
    expect(claimsOf(all).actions).toEqual([
      "artifacts", "events", "result",
      "candidate-export", "candidate-build-source", "baseline-source", "e2e-admission", "e2e-evidence", "feedback-bundles", "feedback-approval", "chatgpt-token", "chatgpt-status", "model-access",
      "pull-request", "pull-request-update", "codebuild",
      "agent-skills",
    ]);
  });
});

describe("parseSkillMarkdown", () => {
  it("reads the name and description from the front matter", () => {
    expect(parseSkillMarkdown(skillFile("triage-notes"))).toMatchObject({ name: "triage-notes", description: "Use when triaging tickets." });
  });

  it("reads quoted values, CRLF line endings and any order of the two keys", () => {
    const parsed = parseSkillMarkdown('---\r\ndescription: "Say: \\"hi\\" first"\r\nname: \'my-skill\'\r\n---\r\nBody\r\n');
    expect(parsed).toMatchObject({ name: "my-skill", description: 'Say: "hi" first' });
  });

  it("refuses any other key, such as allowed-tools", () => {
    const content = `---\nname: triage-notes\ndescription: x\nallowed-tools: Bash\n---\nbody`;
    expect(() => parseSkillMarkdown(content)).toThrow(/CONFIG_INVALID: content: front matter key "allowed-tools" isn't allowed/);
  });

  it.each([
    ["no front matter", "just text", /must start with a front matter block/],
    ["an unclosed front matter", "---\nname: a\ndescription: b\n", /no closing ---/],
    ["a missing name", "---\ndescription: b\n---\n", /front matter needs a name/],
    ["a missing description", "---\nname: a\n---\n", /front matter needs a description/],
    ["an empty description", "---\nname: a\ndescription:\n---\n", /description must be 1 to 1024 characters/],
    ["a name with capitals", "---\nname: Triage\ndescription: b\n---\n", /name must be 1 to 64 lowercase letters, digits or hyphens/],
    ["a name that starts with a hyphen", "---\nname: -triage\ndescription: b\n---\n", /name must be 1 to 64/],
    ["a name of 65 characters", `---\nname: ${"a".repeat(65)}\ndescription: b\n---\n`, /name must be 1 to 64/],
    ["a description of 1025 characters", `---\nname: a\ndescription: ${"d".repeat(1025)}\n---\n`, /description must be 1 to 1024 characters/],
    ["a repeated key", "---\nname: a\nname: b\ndescription: c\n---\n", /key "name" appears twice/],
    ["a nested value", "---\nname: a\ndescription: b\n  more: c\n---\n", /line 4/],
    ["a list", "---\nname: a\ndescription:\n  - b\n---\n", /line 4/],
    ["a block scalar", "---\nname: a\ndescription: >\n  folded\n---\n", /line 4/],
    ["an unquoted value that starts like YAML syntax", "---\nname: a\ndescription: [x]\n---\n", /write the description as plain text or in quotes/],
    ["a quoted value that is not closed", '---\nname: a\ndescription: "x\n---\n', /write the description as plain text or in quotes/],
    ["a comment line", "---\n# note\nname: a\ndescription: b\n---\n", /line 2/],
    ["an empty file", "", /content/],
    ["a bare number as the name", "---\nname: 123\ndescription: b\n---\n", /put the name in quotes/],
    ["a hexadecimal number", "---\nname: a\ndescription: 0x1F\n---\n", /put the description in quotes/],
    ["a decimal", "---\nname: a\ndescription: -1.5e3\n---\n", /put the description in quotes/],
    ["true", "---\nname: a\ndescription: true\n---\n", /put the description in quotes/],
    ["False in any case", "---\nname: a\ndescription: False\n---\n", /put the description in quotes/],
    ["null", "---\nname: a\ndescription: null\n---\n", /put the description in quotes/],
    ["a tilde", "---\nname: a\ndescription: ~\n---\n", /put the description in quotes/],
    ["a comment tail", "---\nname: a\ndescription: Use it # for tickets\n---\n", /put the description in quotes/],
    ["an unquoted colon and space", "---\nname: a\ndescription: Use: it\n---\n", /put the description in quotes/],
    ["a trailing colon", "---\nname: a\ndescription: Use it:\n---\n", /put the description in quotes/],
    ["a next-line character", "---\nname: a\ndescription: one\u0085two\n---\n", /line 3/],
    ["a next-line character inside quotes", '---\nname: a\ndescription: "one\u0085two"\n---\n', /line 3/],
  ])("refuses %s as CONFIG_INVALID", (_label, content, message) => {
    expect(() => parseSkillMarkdown(content)).toThrow(message);
    expect(() => parseSkillMarkdown(content)).toThrow(/^CONFIG_INVALID: content/);
  });

  it("keeps accepting what is quoted, and a # or colon that is not a comment or a key", () => {
    expect(parseSkillMarkdown('---\nname: "123"\ndescription: "true"\n---\n')).toEqual({ name: "123", description: "true" });
    expect(parseSkillMarkdown("---\nname: 'a'\ndescription: 'Use it # now: always'\n---\n").description).toBe("Use it # now: always");
    expect(parseSkillMarkdown('---\nname: a\ndescription: "null"\n---\n').description).toBe("null");
    expect(parseSkillMarkdown("---\nname: a\ndescription: Issue#12 at 10:30 and truer or nullable\n---\n").description).toBe("Issue#12 at 10:30 and truer or nullable");
  });

  it("counts the description in characters, not UTF-16 units: 1024 emoji pass and 1025 do not", () => {
    expect(parseSkillMarkdown(skillFile("emoji", "😀".repeat(1024), "")).description).toHaveLength(2048);
    expect(() => parseSkillMarkdown(skillFile("emoji", "😀".repeat(1025), ""))).toThrow(/description must be 1 to 1024 characters/);
  });

  it("allows a description of exactly 1024 characters and a file of exactly 32,768 bytes, counting UTF-8 bytes", () => {
    const header = skillFile("big", "d".repeat(1024), "");
    expect(parseSkillMarkdown(header).description).toHaveLength(1024);
    const exact = header + "é".repeat((SKILL_CONTENT_MAX_BYTES - Buffer.byteLength(header)) / 2);
    expect(Buffer.byteLength(exact)).toBe(SKILL_CONTENT_MAX_BYTES);
    expect(parseSkillMarkdown(exact).name).toBe("big");
    expect(() => parseSkillMarkdown(exact + "x")).toThrow(/content: a skill is at most 32768 bytes/);
    // 16,385 two-byte characters are 16,385 characters but more than the limit in bytes.
    expect(() => parseSkillMarkdown(header + "é".repeat(SKILL_CONTENT_MAX_BYTES / 2))).toThrow(/at most 32768 bytes/);
  });

  it("digests the UTF-8 content as SHA-256 hex (the digest the worker checks)", () => {
    const content = skillFile("triage-notes", "Ünïcode ✓");
    expect(skillDigest(content)).toBe(createHash("sha256").update(content, "utf8").digest("hex"));
  });
});

function skillSetup() {
  const db = new FakeDynamoDb();
  const clock = { now: START };
  let counter = 0;
  const store = new SkillStore({ documentClient: db, tableName: "T", now: () => clock.now, newId: () => `skl_${String(++counter).padStart(20, "0")}` });
  return { db, clock, store };
}

describe("skill size limits", () => {
  it("keeps one skill below what an agent step's instructions may hold, so anything saved can be read into a step", () => {
    expect(SKILL_CONTENT_MAX_BYTES).toBeLessThanOrEqual(AGENT_STEP_INSTRUCTIONS_MAX_BYTES);
  });

  it("keeps the names and descriptions of the most skills a recipe may list (20) far below the instructions limit", () => {
    const listed = Array.from({ length: MAX_RESOLVED_SKILLS }, (_, index) => `  <skill>\n    <name>${"n".repeat(60)}${String(index).padStart(4, "0")}</name>\n    <description>${"&amp;".repeat(205)}</description>\n  </skill>`).join("\n");
    expect(Buffer.byteLength(listed)).toBeLessThan(AGENT_STEP_INSTRUCTIONS_MAX_BYTES / 2);
  });

  it("fits a step payload that names 20 skills and has the largest instructions", () => {
    const parsed = AgentStepPayloadSchema.safeParse({
      kind: "agent", agentId: "ticket-triage", version: 1, stepId: "work", instructions: "i".repeat(AGENT_STEP_INSTRUCTIONS_MAX_BYTES), workspace: "none", inputs: "go",
      skills: Array.from({ length: MAX_RESOLVED_SKILLS }, (_, index) => ({ skillId: `skl_${String(index).padStart(20, "0")}`, digest: String(index).padStart(64, "a") })),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("SkillStore", () => {
  it("creates a skill from its SKILL.md: a record, its first version, a directory item and a name item", async () => {
    const { db, store } = skillSetup();
    const content = skillFile("triage-notes");
    const skill = await store.create({ orgId: ORG_A, content, owner: MEMBER, by: ALICE });
    expect(skill).toEqual({
      orgId: ORG_A, skillId: "skl_00000000000000000001", name: "triage-notes", description: "Use when triaging tickets.", owner: MEMBER,
      currentDigest: skillDigest(content), createdAt: "2026-10-21T09:00:00.000Z", updatedAt: "2026-10-21T09:00:00.000Z",
    });
    expect(await store.get(ORG_A, skill.skillId)).toEqual(skill);
    expect(await store.getVersion(ORG_A, skill.skillId, skill.currentDigest)).toEqual({ digest: skill.currentDigest, content, createdBy: ALICE, createdAt: "2026-10-21T09:00:00.000Z" });
    expect(await store.list(ORG_A)).toEqual([skill]);
    expect(db.get(skillKey(ORG_A, skill.skillId, "META").pk, "META")).toBeDefined();
  });

  it("keeps one org's skills out of another's: get, list, version and resolve", async () => {
    const { store } = skillSetup();
    const skill = await store.create({ orgId: ORG_A, content: skillFile("triage-notes"), owner: MEMBER, by: ALICE });
    expect(await store.get(ORG_B, skill.skillId)).toBeUndefined();
    expect(await store.list(ORG_B)).toEqual([]);
    expect(await store.getVersion(ORG_B, skill.skillId, skill.currentDigest)).toBeUndefined();
    expect(await code(store.resolve(ORG_B, { skillId: skill.skillId }))).toEqual({ code: "CONFIG_INVALID", message: "skills: unknown skill" });
  });

  it("refuses a second skill with the same name in the org, and writes nothing", async () => {
    const { db, store } = skillSetup();
    await store.create({ orgId: ORG_A, content: skillFile("triage-notes"), owner: MEMBER, by: ALICE });
    const before = [...db.items.keys()].sort();
    expect(await code(store.create({ orgId: ORG_A, content: skillFile("triage-notes", "Other"), owner: MEMBER, by: BOB }))).toEqual({ code: "CONFIG_INVALID", message: "name: another skill in your company is called triage-notes" });
    expect([...db.items.keys()].sort()).toEqual(before);
    // Another org may use the name.
    await store.create({ orgId: ORG_B, content: skillFile("triage-notes"), owner: MEMBER, by: ALICE });
  });

  it("refuses a name that differs from the front matter's", async () => {
    const { store } = skillSetup();
    expect(await code(store.create({ orgId: ORG_A, name: "other-name", content: skillFile("triage-notes"), owner: MEMBER, by: ALICE })))
      .toEqual({ code: "CONFIG_INVALID", message: 'name: the file says "triage-notes", not "other-name"' });
    expect(await store.create({ orgId: ORG_A, name: "triage-notes", content: skillFile("triage-notes"), owner: MEMBER, by: ALICE })).toMatchObject({ name: "triage-notes" });
  });

  it("replaces the content as a new version while the digest is the one the writer read, and keeps every version", async () => {
    const { clock, store } = skillSetup();
    const first = skillFile("triage-notes", "First");
    const skill = await store.create({ orgId: ORG_A, content: first, owner: MEMBER, by: ALICE });
    clock.now += 60_000;
    const second = skillFile("triage-notes", "Second description", "# Steps\n\nNew steps.\n");
    const updated = await store.putContent({ orgId: ORG_A, skillId: skill.skillId, content: second, expectedDigest: skill.currentDigest, by: BOB });
    expect(updated).toMatchObject({ currentDigest: skillDigest(second), description: "Second description", name: "triage-notes", updatedAt: "2026-10-21T09:01:00.000Z", createdAt: "2026-10-21T09:00:00.000Z" });
    expect(await store.getVersion(ORG_A, skill.skillId, skillDigest(first))).toMatchObject({ content: first, createdBy: ALICE });
    expect(await store.getVersion(ORG_A, skill.skillId, skillDigest(second))).toMatchObject({ content: second, createdBy: BOB });
    expect(await store.get(ORG_A, skill.skillId)).toEqual(updated);
  });

  it("refuses a change that was made against an older digest, and writes nothing", async () => {
    const { db, store } = skillSetup();
    const skill = await store.create({ orgId: ORG_A, content: skillFile("triage-notes", "First"), owner: MEMBER, by: ALICE });
    await store.putContent({ orgId: ORG_A, skillId: skill.skillId, content: skillFile("triage-notes", "Second"), expectedDigest: skill.currentDigest, by: ALICE });
    const before = [...db.items.keys()].sort();
    expect(await code(store.putContent({ orgId: ORG_A, skillId: skill.skillId, content: skillFile("triage-notes", "Third"), expectedDigest: skill.currentDigest, by: BOB })))
      .toEqual({ code: "AGENT_REVISION_CONFLICT", message: "Someone else changed this skill. Reload it and make your change again." });
    expect([...db.items.keys()].sort()).toEqual(before);
  });

  it("refuses a front matter name that is not the skill's, for the wrong org's skill id, and for a missing skill", async () => {
    const { store } = skillSetup();
    const skill = await store.create({ orgId: ORG_A, content: skillFile("triage-notes"), owner: MEMBER, by: ALICE });
    expect(await code(store.putContent({ orgId: ORG_A, skillId: skill.skillId, content: skillFile("renamed"), expectedDigest: skill.currentDigest, by: ALICE })))
      .toEqual({ code: "CONFIG_INVALID", message: 'content: the name is "renamed" but this skill is called "triage-notes"; a skill\'s name never changes' });
    expect(await code(store.putContent({ orgId: ORG_B, skillId: skill.skillId, content: skillFile("triage-notes"), expectedDigest: skill.currentDigest, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(store.putContent({ orgId: ORG_A, skillId: "skl_zzzzzzzzzzzzzzzzzzzz", content: skillFile("triage-notes"), expectedDigest: skill.currentDigest, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("restoring an earlier content makes it current again without rewriting its version", async () => {
    const { clock, store } = skillSetup();
    const first = skillFile("triage-notes", "First");
    const skill = await store.create({ orgId: ORG_A, content: first, owner: MEMBER, by: ALICE });
    const second = skillFile("triage-notes", "Second");
    await store.putContent({ orgId: ORG_A, skillId: skill.skillId, content: second, expectedDigest: skill.currentDigest, by: ALICE });
    clock.now += 1000;
    const back = await store.putContent({ orgId: ORG_A, skillId: skill.skillId, content: first, expectedDigest: skillDigest(second), by: BOB });
    expect(back.currentDigest).toBe(skillDigest(first));
    expect(await store.getVersion(ORG_A, skill.skillId, skillDigest(first))).toMatchObject({ createdBy: ALICE, createdAt: "2026-10-21T09:00:00.000Z" });
  });

  it("an identical save changes nothing but is not an error", async () => {
    const { store } = skillSetup();
    const content = skillFile("triage-notes");
    const skill = await store.create({ orgId: ORG_A, content, owner: MEMBER, by: ALICE });
    expect(await store.putContent({ orgId: ORG_A, skillId: skill.skillId, content, expectedDigest: skill.currentDigest, by: BOB })).toMatchObject({ currentDigest: skill.currentDigest });
  });

  it("lists the org's skills in the order of their ids", async () => {
    const { store } = skillSetup();
    await store.create({ orgId: ORG_A, content: skillFile("a-skill"), owner: MEMBER, by: ALICE });
    await store.create({ orgId: ORG_A, content: skillFile("b-skill"), owner: MEMBER, by: ALICE });
    expect((await store.list(ORG_A)).map((skill) => skill.name)).toEqual(["a-skill", "b-skill"]);
  });

  it("resolves a reference to its name, description and digest: unpinned to the current content, pinned to that version", async () => {
    const { store } = skillSetup();
    const first = skillFile("triage-notes", "First");
    const skill = await store.create({ orgId: ORG_A, content: first, owner: MEMBER, by: ALICE });
    const second = skillFile("triage-notes", "Second");
    await store.putContent({ orgId: ORG_A, skillId: skill.skillId, content: second, expectedDigest: skill.currentDigest, by: ALICE });
    expect(await store.resolve(ORG_A, { skillId: skill.skillId })).toEqual({ skillId: skill.skillId, name: "triage-notes", description: "Second", digest: skillDigest(second) });
    expect(await store.resolve(ORG_A, { skillId: skill.skillId, digest: skillDigest(first) })).toEqual({ skillId: skill.skillId, name: "triage-notes", description: "First", digest: skillDigest(first) });
  });

  it("calls an unknown skill or a digest the skill never had `skills: unknown skill`", async () => {
    const { store } = skillSetup();
    const one = await store.create({ orgId: ORG_A, content: skillFile("one-skill"), owner: MEMBER, by: ALICE });
    const two = await store.create({ orgId: ORG_A, content: skillFile("two-skill"), owner: MEMBER, by: ALICE });
    const unknown = { code: "CONFIG_INVALID", message: "skills: unknown skill" };
    expect(await code(store.resolve(ORG_A, { skillId: "skl_zzzzzzzzzzzzzzzzzzzz" }))).toEqual(unknown);
    expect(await code(store.resolve(ORG_A, { skillId: one.skillId, digest: "f".repeat(64) }))).toEqual(unknown);
    // Another skill's digest is not this skill's version.
    expect(await code(store.resolve(ORG_A, { skillId: one.skillId, digest: two.currentDigest }))).toEqual(unknown);
    expect(await code(store.requireRefs(ORG_A, [{ skillId: one.skillId }, { skillId: "skl_zzzzzzzzzzzzzzzzzzzz" }]))).toEqual(unknown);
    await store.requireRefs(ORG_A, [{ skillId: one.skillId }, { skillId: two.skillId, digest: two.currentDigest }]);
  });
});

describe("skills in agents", () => {
  const STEP = { id: "work", name: "Work", kind: "agent", workspace: "none" } as const;
  const withSkills = (add: Array<{ skillId: string; digest?: string }>): RecipeOverlay => ({ instructions: "Work.", sequence: [STEP], skills: { add } });

  function agentSetup() {
    const db = new FakeDynamoDb();
    const clock = { now: START };
    let counter = 0;
    const store = new AgentStore({ documentClient: db, tableName: "T", now: () => clock.now, newId: () => `agt_${String(++counter).padStart(20, "0")}` });
    const skill = (name: string, description = "Use it.", orgId: OrgId = ORG_A) => store.skills.create({ orgId, content: skillFile(name, description), owner: MEMBER, by: ALICE });
    const make = (overlay: RecipeOverlay, orgId: OrgId = ORG_A) => store.create({ orgId, name: `Agent ${String(counter + 1)}`, owner: MEMBER, overlay, createdBy: ALICE });
    const publish = async (agentId: string, extra: { skillDigests?: Record<string, string> } = {}) => {
      const agent = (await store.get(ORG_A, agentId))!;
      return store.publish({ orgId: ORG_A, agentId, expectedDraftRevision: agent.draftRevision, digest: "d".repeat(64), by: ALICE, ...extra });
    };
    return { db, clock, store, skill, make, publish };
  }

  it("refuses an unknown skill, another org's skill and a digest the skill never had when a draft is created or saved", async () => {
    const { store, skill, make } = agentSetup();
    const mine = await skill("triage-notes");
    const theirs = await skill("their-notes", "Theirs", ORG_B);
    const unknown = { code: "CONFIG_INVALID", message: "skills: unknown skill" };
    expect(await code(make(withSkills([{ skillId: "skl_zzzzzzzzzzzzzzzzzzzz" }])))).toEqual(unknown);
    expect(await code(make(withSkills([{ skillId: theirs.skillId }])))).toEqual(unknown);
    expect(await code(make(withSkills([{ skillId: mine.skillId, digest: "f".repeat(64) }])))).toEqual(unknown);
    const agent = await make(withSkills([{ skillId: mine.skillId }]));
    expect(await code(store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: withSkills([{ skillId: theirs.skillId }]), expectedRevision: 1, by: ALICE }))).toEqual(unknown);
    expect((await store.getDraft(ORG_A, agent.agentId))!.revision).toBe(1);
  });

  it("refuses the same skill listed twice in a draft, with or without a digest, when it is created or saved", async () => {
    const { store, skill, make } = agentSetup();
    const mine = await skill("triage-notes");
    const twice = { code: "CONFIG_INVALID", message: "skills.add: a skill is listed twice" };
    expect(await code(make(withSkills([{ skillId: mine.skillId }, { skillId: mine.skillId }])))).toEqual(twice);
    expect(await code(make(withSkills([{ skillId: mine.skillId }, { skillId: mine.skillId, digest: mine.currentDigest }])))).toEqual(twice);
    const agent = await make(withSkills([{ skillId: mine.skillId }]));
    expect(await code(store.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: withSkills([{ skillId: mine.skillId }, { skillId: mine.skillId }]), expectedRevision: 1, by: ALICE }))).toEqual(twice);
    expect((await store.getDraft(ORG_A, agent.agentId))!.revision).toBe(1);
  });

  it("publishes a draft that already holds a duplicate (saved before the refusal) with the skill pinned once", async () => {
    const { db, store, skill, make, publish } = agentSetup();
    const mine = await skill("triage-notes");
    const agent = await make(withSkills([{ skillId: mine.skillId }]));
    const key = agentKey(ORG_A, agent.agentId, "DRAFT");
    const stored = db.get(key.pk, key.sk) as Record<string, unknown> & { overlay: RecipeOverlay };
    db.set({ ...stored, overlay: withSkills([{ skillId: mine.skillId }, { skillId: mine.skillId }]) });
    const version = await publish(agent.agentId);
    expect(version.overlay.skills?.add).toEqual([{ skillId: mine.skillId, digest: mine.currentDigest }]);
    expect((await store.getVersion(ORG_A, agent.agentId, 1))!.overlay.skills?.add).toHaveLength(1);
  });

  it("resolves a draft's skills to the skill's current content", async () => {
    const { store, skill, make } = agentSetup();
    const mine = await skill("triage-notes", "Triage help");
    const agent = await make(withSkills([{ skillId: mine.skillId }]));
    const recipe = await resolveAgent(store, ORG_A, agent.agentId, "draft");
    expect(recipe.skills).toEqual([{ skillId: mine.skillId, name: "triage-notes", description: "Triage help", digest: mine.currentDigest }]);
  });

  it("pins every skill without a digest to its current digest when the draft is published, and keeps the draft unpinned", async () => {
    const { store, skill, make, publish } = agentSetup();
    const a = await skill("a-skill");
    const b = await skill("b-skill");
    const agent = await make(withSkills([{ skillId: a.skillId }, { skillId: b.skillId, digest: b.currentDigest }]));
    const version = await publish(agent.agentId);
    expect(version.overlay.skills?.add).toEqual([{ skillId: a.skillId, digest: a.currentDigest }, { skillId: b.skillId, digest: b.currentDigest }]);
    expect((await store.getVersion(ORG_A, agent.agentId, 1))!.overlay.skills?.add).toEqual(version.overlay.skills?.add);
    expect((await store.getDraft(ORG_A, agent.agentId))!.overlay.skills?.add).toEqual([{ skillId: a.skillId }, { skillId: b.skillId, digest: b.currentDigest }]);
  });

  it("a later edit of the skill does not change the published version's digest, only the draft's", async () => {
    const { store, skill, make, publish } = agentSetup();
    const a = await skill("a-skill", "First");
    const agent = await make(withSkills([{ skillId: a.skillId }]));
    await publish(agent.agentId);
    const edited = skillFile("a-skill", "Second");
    await store.skills.putContent({ orgId: ORG_A, skillId: a.skillId, content: edited, expectedDigest: a.currentDigest, by: ALICE });
    const published = await resolveAgent(store, ORG_A, agent.agentId, 1);
    const draft = await resolveAgent(store, ORG_A, agent.agentId, "draft");
    expect(published.skills).toEqual([{ skillId: a.skillId, name: "a-skill", description: "First", digest: a.currentDigest }]);
    expect(draft.skills).toEqual([{ skillId: a.skillId, name: "a-skill", description: "Second", digest: skillDigest(edited) }]);
    // Publishing again pins the new content as version 2 and leaves version 1 alone.
    const second = await publish(agent.agentId);
    expect(second.overlay.skills?.add).toEqual([{ skillId: a.skillId, digest: skillDigest(edited) }]);
    expect((await resolveAgent(store, ORG_A, agent.agentId, 1)).skills[0]!.digest).toBe(a.currentDigest);
  });

  it("pins the digest the caller resolved the recipe with, and refuses when the skill has moved since", async () => {
    const { db, store, skill, make, publish } = agentSetup();
    const a = await skill("a-skill", "First");
    const agent = await make(withSkills([{ skillId: a.skillId }]));
    await store.skills.putContent({ orgId: ORG_A, skillId: a.skillId, content: skillFile("a-skill", "Second"), expectedDigest: a.currentDigest, by: ALICE });
    const before = [...db.items.keys()].sort();
    expect(await code(publish(agent.agentId, { skillDigests: { [a.skillId]: a.currentDigest } })))
      .toEqual({ code: "AGENT_REVISION_CONFLICT", message: "A skill this agent uses changed while it was being published. Publish again." });
    expect([...db.items.keys()].sort()).toEqual(before);
    const current = (await store.skills.get(ORG_A, a.skillId))!.currentDigest;
    expect((await publish(agent.agentId, { skillDigests: { [a.skillId]: current } })).overlay.skills?.add).toEqual([{ skillId: a.skillId, digest: current }]);
  });

  it("refuses a publish when a skill it names has gone from the org, and leaves the agent as it was", async () => {
    const { db, store, make, publish, skill } = agentSetup();
    const a = await skill("a-skill");
    const agent = await make(withSkills([{ skillId: a.skillId }]));
    db.delete(skillKey(ORG_A, a.skillId, "META"));
    const before = [...db.items.keys()].sort();
    expect(await code(publish(agent.agentId))).toEqual({ code: "CONFIG_INVALID", message: "skills: unknown skill" });
    expect([...db.items.keys()].sort()).toEqual(before);
    expect((await store.get(ORG_A, agent.agentId))!.latestVersion).toBe(0);
  });

  it("builds on a base that has skills: the base's pinned skills reach the child's recipe, and a child may remove one", async () => {
    const { store, skill, make, publish } = agentSetup();
    const a = await skill("a-skill");
    const b = await skill("b-skill");
    const base = await make(withSkills([{ skillId: a.skillId }, { skillId: b.skillId }]));
    await publish(base.agentId);
    const child = await store.create({ orgId: ORG_A, name: "Child", owner: MEMBER, extends: base.agentId, overlay: { skills: { remove: [a.skillId] } }, createdBy: ALICE });
    expect((await resolveAgent(store, ORG_A, child.agentId, "draft")).skills.map((entry) => entry.name)).toEqual(["b-skill"]);
  });
});

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web
const CARL = person("3", "Carl"); // contributor on web
const EVE = person("4", "Eve"); // a member with no role anywhere
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);

type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

async function routeSetup() {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({ orgResolver, register: false, brokerExtra: { agents: { projectMembers: members } } });
  const enroll = async (who: Developer, role: OrgRole) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  };
  await enroll(DANA, "admin");
  for (const who of [MAX, CARL, EVE]) await enroll(who, "member");
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
  members.grant(TEST_ORG, "web", CARL.developerId, "contributor");
  // The same table, so a test can read or seed what the routes wrote.
  const skills = new SkillStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's own id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const add = async (who: Developer, content: string, extra: Record<string, unknown> = {}) => {
    const reply = await call(who, "POST", "/v1/app/skills", { content, ...extra });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return reply.body.skill as { skillId: string; currentDigest: string; name: string; owner: AgentOwner };
  };
  // Beside the broker's own store, for the confirm handlers and for reading what a publish wrote.
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: h.db, tableName: "state", now: Date.now, confirmOrigin: "https://cell.example.com",
    signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
  };
  const create = async (who: Developer, overlay: RecipeOverlay, extra: Record<string, unknown> = {}): Promise<Reply> => call(who, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay, ...extra });
  const draftRevision = async (who: Developer, agentId: string) => ((await call(who, "GET", `/v1/app/agents/${agentId}/draft`)).body.draft as { revision: number }).revision;
  const saveDraft = async (who: Developer, agentId: string, overlay: RecipeOverlay): Promise<Reply> => call(who, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: await draftRevision(who, agentId), overlay });
  const publish = async (who: Developer, agentId: string): Promise<Reply> => call(who, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: await draftRevision(who, agentId) });
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as ApprovalRecord[];
  return { ...h, members, skills, store, deps, call, add, create, saveDraft, publish, approvals };
}

describe("skills routes", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  it("adds a skill from its SKILL.md, owned by the caller, and shows it in the list and by id with its content", async () => {
    const { call, add } = await routeSetup();
    const content = skillFile("triage-notes");
    const created = await call(MAYA, "POST", "/v1/app/skills", { content });
    expect(created.status).toBe(201);
    const skill = created.body.skill as Record<string, unknown>;
    expect(skill).toMatchObject({ name: "triage-notes", description: "Use when triaging tickets.", owner: { kind: "member", developerId: MAYA.developerId }, currentDigest: skillDigest(content) });
    expect(skill.skillId).toMatch(/^skl_[0-9a-z]{20}$/);
    expect(Object.keys(skill)).not.toContain("orgId");
    expect(Object.keys(skill)).not.toContain("content");

    const other = await add(CARL, skillFile("carl-notes"));
    const list = await call(EVE, "GET", "/v1/app/skills");
    expect(list.status).toBe(200);
    expect((list.body.skills as Array<{ name: string }>).map((entry) => entry.name).sort()).toEqual(["carl-notes", "triage-notes"]);
    expect(JSON.stringify(list.body)).not.toContain("Steps");

    const one = await call(EVE, "GET", `/v1/app/skills/${String(skill.skillId)}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ skill: { name: "triage-notes", canEdit: false }, content });
    expect((await call(MAYA, "GET", `/v1/app/skills/${String(skill.skillId)}`)).body).toMatchObject({ skill: { canEdit: true } });
    expect((await call(EVE, "GET", `/v1/app/skills/${other.skillId}`)).status).toBe(200);
  });

  it("refuses a mismatched name, an extra front matter key, an oversized file and a taken name, each as 400 with nothing written", async () => {
    const { call, add, db } = await routeSetup();
    await add(MAYA, skillFile("triage-notes"));
    const before = [...db.items.keys()].sort();
    const refuse = async (body: Record<string, unknown>) => { const reply = await call(MAYA, "POST", "/v1/app/skills", body); expect(reply.status).toBe(400); return errorOf(reply); };
    expect(await refuse({ name: "other-name", content: skillFile("new-skill") })).toEqual({ code: "CONFIG_INVALID", message: 'name: the file says "new-skill", not "other-name"' });
    expect((await refuse({ content: "---\nname: new-skill\ndescription: x\nallowed-tools: Bash\n---\n" })).message).toBe('content: front matter key "allowed-tools" isn\'t allowed; only name and description are');
    expect((await refuse({ content: skillFile("big-skill", "x", "é".repeat(SKILL_CONTENT_MAX_BYTES)) })).message).toBe("content: a skill is at most 32768 bytes");
    expect((await refuse({ content: skillFile("triage-notes", "Again") })).message).toBe("name: another skill in your company is called triage-notes");
    expect((await refuse({ content: skillFile("a-skill"), extra: true })).code).toBe("CONFIG_INVALID");
    expect((await call(MAYA, "POST", "/v1/app/skills", { content: skillFile("a-skill"), requestId: "not-a-uuid" })).status).toBe(400);
    expect([...db.items.keys()].sort()).toEqual(before);
  });

  it("applies the owner rules of agents to a skill's owner", async () => {
    const { call } = await routeSetup();
    const project = { kind: "project", project: "web" };
    expect((await call(CARL, "POST", "/v1/app/skills", { content: skillFile("a-skill"), owner: project })).status).toBe(403);
    expect((await call(CARL, "POST", "/v1/app/skills", { content: skillFile("a-skill"), owner: { kind: "member", developerId: EVE.developerId } })).status).toBe(403);
    const mine = await call(MAX, "POST", "/v1/app/skills", { content: skillFile("a-skill"), owner: project });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.skill).toMatchObject({ owner: project });
    const forEve = await call(DANA, "POST", "/v1/app/skills", { content: skillFile("b-skill"), owner: { kind: "member", developerId: EVE.developerId } });
    expect(forEve.status).toBe(201);
    expect(errorOf(await call(CARL, "POST", "/v1/app/skills", { content: skillFile("c-skill"), owner: project })).message).toBe("Only a maintainer of web can make it a skill's owner.");
  });

  it("answers a repeated create with the outcome it stored, even after the skill was edited", async () => {
    const { call, skills } = await routeSetup();
    const requestId = randomUUID();
    const first = await call(MAYA, "POST", "/v1/app/skills", { requestId, content: skillFile("triage-notes", "First") });
    const created = first.body.skill as { skillId: string; currentDigest: string };
    await skills.putContent({ orgId: TEST_ORG, skillId: created.skillId, content: skillFile("triage-notes", "Second"), expectedDigest: created.currentDigest, by: MAYA.developerId });
    const again = await call(MAYA, "POST", "/v1/app/skills", { requestId, content: skillFile("triage-notes", "First") });
    expect(again).toEqual(first);
    expect(again.body.skill).toMatchObject({ description: "First", currentDigest: created.currentDigest });
  });

  it("answers a repeated request from the first one, and refuses the same id for a different request", async () => {
    const { call, db, skills } = await routeSetup();
    const requestId = randomUUID();
    const first = await call(MAYA, "POST", "/v1/app/skills", { requestId, content: skillFile("triage-notes") });
    expect(first.status).toBe(201);
    const before = [...db.items.keys()].sort();
    const again = await call(MAYA, "POST", "/v1/app/skills", { requestId, content: skillFile("triage-notes") });
    expect(again).toEqual(first);
    expect([...db.items.keys()].sort()).toEqual(before);
    expect(await skills.list(TEST_ORG)).toHaveLength(1);
    const different = await call(MAYA, "POST", "/v1/app/skills", { requestId, content: skillFile("other-skill") });
    expect(different.status).toBe(400);
    expect(errorOf(different).message).toBe("requestId: this request ID was already used for a different request");
    expect([...db.items.keys()].sort()).toEqual(before);
    // The mark was written in the same transaction as the skill, so a refused create leaves none.
    const refused = await call(MAYA, "POST", "/v1/app/skills", { requestId: randomUUID(), content: skillFile("triage-notes", "Dup") });
    expect(refused.status).toBe(400);
    expect([...db.items.keys()].sort()).toEqual(before);
  });

  describe("changing the content", () => {
    it("lets the owner, an admin and a maintainer of the owning project change it, and nobody else", async () => {
      const { call, add } = await routeSetup();
      const mine = await add(MAYA, skillFile("my-skill"));
      const edit = (who: Developer, skill: { skillId: string; currentDigest: string; name: string }, description: string, extra: Record<string, unknown> = {}) =>
        call(who, "PUT", `/v1/app/skills/${skill.skillId}/content`, { content: skillFile(skill.name, description), expectedDigest: skill.currentDigest, ...extra });
      expect((await edit(EVE, mine, "Eve's")).status).toBe(403);
      expect((await edit(CARL, mine, "Carl's")).status).toBe(403);
      const byOwner = await edit(MAYA, mine, "Maya's");
      expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
      expect(byOwner.body.skill).toMatchObject({ description: "Maya's", currentDigest: skillDigest(skillFile("my-skill", "Maya's")) });
      const afterOwner = { ...mine, currentDigest: (byOwner.body.skill as { currentDigest: string }).currentDigest };
      expect((await edit(DANA, afterOwner, "Dana's")).status).toBe(200);

      const project = await add(MAX, skillFile("web-skill"), { owner: { kind: "project", project: "web" } });
      expect((await edit(CARL, project, "Carl's")).status).toBe(403);
      expect((await edit(EVE, project, "Eve's")).status).toBe(403);
      expect((await edit(MAX, project, "Max's")).status).toBe(200);
      expect(errorOf(await edit(CARL, project, "x")).message).toBe("Only the skill's owner, a maintainer of web, or an org admin can change it.");
      expect(errorOf(await edit(EVE, mine, "x")).message).toBe("Only the skill's owner or an org admin can change it.");
    });

    it("answers 409 for a stale digest, 400 for a changed name or a bad file, 404 for a missing skill, each writing nothing", async () => {
      const { call, add, db } = await routeSetup();
      const skill = await add(MAYA, skillFile("my-skill"));
      const put = (body: Record<string, unknown>, id = skill.skillId) => call(MAYA, "PUT", `/v1/app/skills/${id}/content`, body);
      const before = [...db.items.keys()].sort();
      const stale = await put({ content: skillFile("my-skill", "Other"), expectedDigest: "0".repeat(64) });
      expect(stale.status).toBe(409);
      expect(errorOf(stale)).toEqual({ code: "AGENT_REVISION_CONFLICT", message: "Someone else changed this skill. Reload it and make your change again." });
      const renamed = await put({ content: skillFile("renamed"), expectedDigest: skill.currentDigest });
      expect(renamed.status).toBe(400);
      expect(errorOf(renamed).message).toBe('content: the name is "renamed" but this skill is called "my-skill"; a skill\'s name never changes');
      expect((await put({ content: "no front matter", expectedDigest: skill.currentDigest })).status).toBe(400);
      expect((await put({ content: skillFile("my-skill"), expectedDigest: "short" })).status).toBe(400);
      expect((await put({ content: skillFile("my-skill") })).status).toBe(400);
      expect((await put({ content: skillFile("my-skill"), expectedDigest: skill.currentDigest }, "skl_zzzzzzzzzzzzzzzzzzzz")).status).toBe(404);
      expect((await put({ content: skillFile("my-skill"), expectedDigest: skill.currentDigest }, "not-a-skill-id")).status).toBe(404);
      expect([...db.items.keys()].sort()).toEqual(before);
    });

    it("answers a repeat from the first answer and writes nothing; the same id for another file is refused", async () => {
      const { call, add, db, skills } = await routeSetup();
      const skill = await add(MAYA, skillFile("my-skill"));
      const requestId = randomUUID();
      const body = { requestId, content: skillFile("my-skill", "Second"), expectedDigest: skill.currentDigest };
      const first = await call(MAYA, "PUT", `/v1/app/skills/${skill.skillId}/content`, body);
      expect(first.status).toBe(200);
      const before = [...db.items.keys()].sort();
      // The repeat names the digest it read first, which is no longer current: it is answered, not refused as a conflict.
      expect(await call(MAYA, "PUT", `/v1/app/skills/${skill.skillId}/content`, body)).toEqual(first);
      expect([...db.items.keys()].sort()).toEqual(before);
      const different = await call(MAYA, "PUT", `/v1/app/skills/${skill.skillId}/content`, { ...body, content: skillFile("my-skill", "Third") });
      expect(errorOf(different).message).toBe("requestId: this request ID was already used for a different request");
      expect((await skills.get(TEST_ORG, skill.skillId))!.description).toBe("Second");
    });
  });

  it("gives another org's member 404 for a skill id, in the list, by id and on a change, and writes nothing", async () => {
    const { call, add, db, skills } = await routeSetup();
    const skill = await add(MAYA, skillFile("triage-notes"));
    const before = [...db.items.keys()].sort();
    expect((await call(OMAR, "GET", "/v1/app/skills")).body.skills).toEqual([]);
    const read = await call(OMAR, "GET", `/v1/app/skills/${skill.skillId}`);
    expect(read.status).toBe(404);
    expect(errorOf(read).code).toBe("NOT_FOUND");
    const change = await call(OMAR, "PUT", `/v1/app/skills/${skill.skillId}/content`, { content: skillFile("triage-notes", "Theirs"), expectedDigest: skill.currentDigest });
    expect(change.status).toBe(404);
    expect([...db.items.keys()].sort()).toEqual(before);
    expect((await skills.get(TEST_ORG, skill.skillId))!.description).toBe("Use when triaging tickets.");
    // The other org can use the same name for its own skill.
    expect((await call(OMAR, "POST", "/v1/app/skills", { content: skillFile("triage-notes") })).status).toBe(201);
  });
});

describe("skills in published agents (routes)", () => {
  beforeAll(async () => { await loadSlackBroker(); });
  const STEP = { id: "work", name: "Work", kind: "agent", workspace: "none" } as const;
  const overlayWith = (add: Array<{ skillId: string; digest?: string }>, extra: Partial<RecipeOverlay> = {}): RecipeOverlay => ({ instructions: "Work.", sequence: [STEP], skills: { add }, ...extra });
  const agentIdOf = (reply: Reply) => (reply.body.agent as { agentId: AgentId }).agentId;

  it("refuses a draft or a new agent that names a skill the company does not have, with `skills: unknown skill`", async () => {
    const { call, add, create, saveDraft } = await routeSetup();
    const mine = await add(MAYA, skillFile("my-skill"));
    const theirs = await call(OMAR, "POST", "/v1/app/skills", { content: skillFile("their-skill") });
    const theirId = (theirs.body.skill as { skillId: string }).skillId;
    const unknown = { code: "CONFIG_INVALID", message: "skills: unknown skill" };
    for (const skillId of [theirId, "skl_zzzzzzzzzzzzzzzzzzzz"]) {
      const made = await create(MAYA, overlayWith([{ skillId }]));
      expect(made.status).toBe(400);
      expect(errorOf(made)).toEqual(unknown);
    }
    const agent = agentIdOf(await create(MAYA, overlayWith([{ skillId: mine.skillId }])));
    const saved = await saveDraft(MAYA, agent, overlayWith([{ skillId: theirId }]));
    expect(saved.status).toBe(400);
    expect(errorOf(saved)).toEqual(unknown);
    expect(errorOf(await saveDraft(MAYA, agent, overlayWith([{ skillId: mine.skillId, digest: "a".repeat(64) }])))).toEqual(unknown);
  });

  it("publishes with each skill pinned to its digest at that moment, and a later edit changes only the draft", async () => {
    const { call, add, create, publish, store, skills } = await routeSetup();
    const skill = await add(MAYA, skillFile("my-skill", "First"));
    const agent = agentIdOf(await create(MAYA, overlayWith([{ skillId: skill.skillId }])));
    const first = await publish(MAYA, agent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((first.body.version as { overlay: RecipeOverlay }).overlay.skills?.add).toEqual([{ skillId: skill.skillId, digest: skill.currentDigest }]);
    const edited = skillFile("my-skill", "Second");
    expect((await call(MAYA, "PUT", `/v1/app/skills/${skill.skillId}/content`, { content: edited, expectedDigest: skill.currentDigest })).status).toBe(200);
    const version = await call(MAYA, "GET", `/v1/app/agents/${agent}/versions/1`);
    expect((version.body.recipe as { skills: unknown }).skills).toEqual([{ skillId: skill.skillId, name: "my-skill", description: "First", digest: skill.currentDigest }]);
    const shown = await call(MAYA, "GET", `/v1/app/agents/${agent}`);
    expect(shown.body).toMatchObject({ current: { version: 1, changed: true } });
    expect((await store.getVersion(TEST_ORG, agent, 1))!.overlay.skills?.add).toEqual([{ skillId: skill.skillId, digest: skill.currentDigest }]);
    expect((await skills.get(TEST_ORG, skill.skillId))!.currentDigest).toBe(skillDigest(edited));
  });

  it("pins the digest the page was shown when a waiting publish is confirmed, and refuses it if the skill was edited since", async () => {
    const { call, add, create, saveDraft, publish, approvals, deps, store, skills } = await routeSetup();
    const skill = await add(MAYA, skillFile("my-skill", "First"));
    const agent = agentIdOf(await create(MAYA, overlayWith([{ skillId: skill.skillId }])));
    expect((await publish(MAYA, agent)).status).toBe(200);
    // allowMentions can only make comments wait for a person, but turning it on is a change that waits for the page.
    await saveDraft(MAYA, agent, overlayWith([{ skillId: skill.skillId }], { allowMentions: true }));
    const waiting = await publish(MAYA, agent);
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
    const [record] = approvals();
    const handler = getApprovalSubjectHandler("agent_publish")!;
    await handler(deps, { ...record!, decidedBy: DANA.developerId });
    expect((await store.getVersion(TEST_ORG, agent, 2))!.overlay.skills?.add).toEqual([{ skillId: skill.skillId, digest: skill.currentDigest }]);

    // A second waiting publish, with the skill edited before it is confirmed.
    await saveDraft(MAYA, agent, overlayWith([{ skillId: skill.skillId }], { allowMentions: false }));
    expect((await publish(MAYA, agent)).status).toBe(200);
    await saveDraft(MAYA, agent, overlayWith([{ skillId: skill.skillId }], { allowMentions: true, instructions: "Work harder." }));
    expect((await publish(MAYA, agent)).status).toBe(202);
    const second = approvals().find((entry) => entry.approvalId !== record!.approvalId)!;
    await skills.putContent({ orgId: TEST_ORG, skillId: skill.skillId, content: skillFile("my-skill", "Edited"), expectedDigest: skill.currentDigest, by: MAYA.developerId });
    const refused = await handler(deps, { ...second, decidedBy: DANA.developerId }).then(() => undefined, (thrown: Error) => thrown);
    expect(refused?.message).toBe("AGENT_REVISION_CONFLICT: The draft changed after this was asked. Publish again.");
    expect((await call(MAYA, "GET", `/v1/app/agents/${agent}/versions`)).body.versions).toHaveLength(3);
  });

  it("refuses a publish when the skill is edited after the draft was resolved, instead of publishing content nobody compared", async () => {
    const { add, create, deps, store, skills } = await routeSetup();
    const skill = await add(MAYA, skillFile("my-skill", "First"));
    const agentId = agentIdOf(await create(MAYA, overlayWith([{ skillId: skill.skillId }])));
    const agent = (await store.get(TEST_ORG, agentId))!;
    // The skill changes between resolving the draft and writing the version.
    const racing = Object.create(store) as AgentStore;
    racing.publish = async (input) => {
      await skills.putContent({ orgId: TEST_ORG, skillId: skill.skillId, content: skillFile("my-skill", "Edited"), expectedDigest: skill.currentDigest, by: MAYA.developerId });
      return store.publish(input);
    };
    const caller = { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "member" as const };
    const refused = await publishDraft({ ...deps, store: racing }, caller, agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision }).then(() => undefined, (thrown: Error) => thrown);
    expect(refused?.message).toMatch(/^AGENT_REVISION_CONFLICT: /);
    expect(await store.listVersions(TEST_ORG, agentId)).toEqual([]);
  });

  it("validateRecipeForOrg reports a skill, or a pinned digest, the company does not have", async () => {
    const { deps, add } = await routeSetup();
    const skill = await add(MAYA, skillFile("my-skill"));
    const recipe = (skills: Array<{ skillId: string; digest: string }>) => ({
      schemaVersion: 1, chain: [], instructions: [], steps: [{ id: "work", name: "Work", kind: "agent", workspace: "none", settings: { instructions: [] } }], tools: [],
      approvals: { alwaysAsk: [] }, triggers: [{ kind: "person" }], autonomy: "prepare", allowMentions: false,
      skills: skills.map((entry) => ({ ...entry, name: "my-skill", description: "x" })),
    }) as unknown as Parameters<typeof validateRecipeForOrg>[2];
    const problems = (value: Parameters<typeof validateRecipeForOrg>[2], orgId = TEST_ORG) => validateRecipeForOrg(deps, orgId, value).then((found) => found.filter((entry) => entry.path.startsWith("skills")));
    expect(await problems(recipe([{ skillId: skill.skillId, digest: skill.currentDigest }]))).toEqual([]);
    expect(await problems(recipe([{ skillId: skill.skillId, digest: skill.currentDigest }, { skillId: "skl_zzzzzzzzzzzzzzzzzzzz", digest: "a".repeat(64) }, { skillId: skill.skillId, digest: "b".repeat(64) }])))
      .toEqual([{ path: "skills.1", message: "unknown skill" }, { path: "skills.2", message: "unknown skill" }]);
    expect(await problems(recipe([{ skillId: skill.skillId, digest: skill.currentDigest }]), ORG_B)).toEqual([{ path: "skills.0", message: "unknown skill" }]);
  });
});

describe("GET /v1/internal/agent-skills", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  /** A running developer task whose operation holds a capability that grants agent-skills, and a snapshot item seeded the way Task 15 will write it. */
  async function runningTask() {
    const h = await createDeveloperTaskBroker({ orgResolver });
    // C53 ordinary turns require a current non-viewer native project grant.
    h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", role: "developer", ownerKey: MAYA.developerId, projectName: "payments", projectRole: "contributor", grantId: "skills-fixture" });
    const skills = new SkillStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; orgId: string };
    const workspaceId = task.workspaceId;
    const active = () => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    // The first operation prepares the workspace; the task's own operation follows it.
    await h.finish(workspaceId, active(), "SUCCEEDED");
    const operationId = active();
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    expect(outbox, "authorized skills fixture must enqueue its task").toBeDefined();
    const invocation = outbox.invocation as { callbackCapability: string; fence: number };
    const grant = issueCapability({ callbackSigningKey: "c".repeat(64) }, workspaceId, operationId, invocation.fence, { agentSkills: true });
    const ask = (header: string | null = grant) => callBroker(h.handler, { method: "GET", path: "/v1/internal/agent-skills", ...(header === null ? {} : { headers: { "x-agentx-callback-capability": header } }) });
    const seedSnapshot = (pinned: Array<{ skillId: string; name: string; description: string; digest: string }>, orgId: string = task.orgId) =>
      h.db.set({ pk: `DEVTASK#${taskId}`, sk: "RECIPE", entityType: "TASK_RECIPE", orgId, digest: "d".repeat(64), recipe: { schemaVersion: 1, skills: pinned } });
    return { ...h, skills, task, taskId, workspaceId, operationId, fence: invocation.fence, grant, ordinary: invocation.callbackCapability, ask, seedSnapshot };
  }
  const pinnedOf = (skill: { skillId: string; name: string; currentDigest: string }, description = "Use when triaging tickets.") => ({ skillId: skill.skillId, name: skill.name, description, digest: skill.currentDigest });

  it("serves the pinned contents of the task's snapshot, in its order", async () => {
    const h = await runningTask();
    const one = await h.skills.create({ orgId: TEST_ORG, content: skillFile("one-skill", "First skill"), owner: MEMBER, by: ALICE });
    const two = await h.skills.create({ orgId: TEST_ORG, content: skillFile("two-skill", "Second skill", "Body two.\n"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(two, "Second skill"), pinnedOf(one, "First skill")]);
    const answer = await h.ask();
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.skills).toEqual([
      { name: "two-skill", description: "Second skill", digest: two.currentDigest, content: skillFile("two-skill", "Second skill", "Body two.\n") },
      { name: "one-skill", description: "First skill", digest: one.currentDigest, content: skillFile("one-skill", "First skill") },
    ]);
  });

  it("serves the version the snapshot pinned, not what the skill says now", async () => {
    const h = await runningTask();
    const skill = await h.skills.create({ orgId: TEST_ORG, content: skillFile("one-skill", "Old"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(skill, "Old")]);
    await h.skills.putContent({ orgId: TEST_ORG, skillId: skill.skillId, content: skillFile("one-skill", "New"), expectedDigest: skill.currentDigest, by: ALICE });
    expect((await h.ask()).body.skills).toEqual([{ name: "one-skill", description: "Old", digest: skill.currentDigest, content: skillFile("one-skill", "Old") }]);
  });

  it("is read by the worker's own client, which checks each content against its digest", async () => {
    const h = await runningTask();
    const skill = await h.skills.create({ orgId: TEST_ORG, content: skillFile("one-skill", "Use it"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(skill, "Use it")]);
    const transport = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const reply = await callBroker(h.handler, { method: "GET", path, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const served = await agentSkillsSource({ controlPlaneUrl: "https://control.example.test", capability: h.grant, fetch: transport })();
    expect(served).toEqual([{ name: "one-skill", description: "Use it", digest: skill.currentDigest, content: skillFile("one-skill", "Use it") }]);
  });

  it("serves the largest skill the registry accepts to the worker's client", async () => {
    const h = await runningTask();
    const header = `---\nname: ${"n".repeat(64)}\ndescription: ${"d".repeat(1024)}\n---\n`;
    const room = SKILL_CONTENT_MAX_BYTES - Buffer.byteLength(header);
    const content = header + "é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2);
    expect(Buffer.byteLength(content)).toBe(SKILL_CONTENT_MAX_BYTES);
    const skill = await h.skills.create({ orgId: TEST_ORG, content, owner: MEMBER, by: ALICE });
    h.seedSnapshot([{ skillId: skill.skillId, name: skill.name, description: "d".repeat(1024), digest: skill.currentDigest }]);
    const transport = (async (url: string | URL, init?: RequestInit) => {
      const reply = await callBroker(h.handler, { method: "GET", path: new URL(String(url)).pathname, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
    const served = await agentSkillsSource({ controlPlaneUrl: "https://control.example.test", capability: h.grant, fetch: transport })();
    expect(served).toHaveLength(1);
    expect(served[0]!.content).toBe(content);
  });

  it("serves a skill whose description is 1024 emoji, which the snapshot schema and the worker's client both accept", async () => {
    const h = await runningTask();
    const description = "😀".repeat(1024);
    const skill = await h.skills.create({ orgId: TEST_ORG, content: skillFile("emoji-skill", description, "Body.\n"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(skill, description)]);
    const transport = (async (url: string | URL, init?: RequestInit) => {
      const reply = await callBroker(h.handler, { method: "GET", path: new URL(String(url)).pathname, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
    const served = await agentSkillsSource({ controlPlaneUrl: "https://control.example.test", capability: h.grant, fetch: transport })();
    expect(served.map((entry) => entry.description)).toEqual([description]);
    expect(ResolvedRecipeSchema.shape.skills.safeParse([pinnedOf(skill, description)]).success).toBe(true);
    expect(ResolvedRecipeSchema.shape.skills.safeParse([pinnedOf(skill, "😀".repeat(1025))]).success).toBe(false);
  });

  it("refuses an operation that is being stopped, or is not the workspace's active one, like the tool routes do", async () => {
    const h = await runningTask();
    const skill = await h.skills.create({ orgId: TEST_ORG, content: skillFile("one-skill", "Mine", "SECRET-MINE\n"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(skill, "Mine")]);
    expect((await h.ask()).status).toBe(200);
    const operation = h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${h.operationId}`) as Record<string, unknown>;
    h.db.set({ ...operation, status: "CANCEL_REQUESTED" });
    const stopping = await h.ask();
    expect(stopping.status).toBe(409);
    expect(JSON.stringify(stopping.body)).not.toContain("SECRET-MINE");
    h.db.set(operation);
    const workspace = h.db.get(`WORKSPACE#${h.workspaceId}`, "META") as Record<string, unknown>;
    h.db.set({ ...workspace, activeOperationId: randomUUID() });
    const superseded = await h.ask();
    expect(superseded.status).toBe(409);
    expect(JSON.stringify(superseded.body)).not.toContain("SECRET-MINE");
    h.db.set(workspace);
    expect((await h.ask()).status).toBe(200);
  });

  it("refuses, with 404 and no content, a task whose org is not the operation's, in either direction", async () => {
    const h = await runningTask();
    const skill = await h.skills.create({ orgId: TEST_ORG, content: skillFile("one-skill", "Mine", "SECRET-MINE\n"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(skill, "Mine")]);
    expect((await h.ask()).status).toBe(200);
    const operation = h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${h.operationId}`) as Record<string, unknown>;
    expect(operation.orgId).toBe(TEST_ORG);
    // The operation belongs to another org than its task.
    h.db.set({ ...operation, orgId: ORG_B });
    const answer = await h.ask();
    expect(answer.status).toBe(404);
    expect(JSON.stringify(answer.body)).not.toContain("SECRET-MINE");
    // The task belongs to another org than its operation.
    h.db.set({ ...operation, orgId: TEST_ORG });
    h.db.set({ ...h.task, orgId: ORG_B });
    const other = await h.ask();
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain("SECRET-MINE");
  });

  it("answers an empty list for a task with no snapshot", async () => {
    const h = await runningTask();
    expect(await h.ask()).toMatchObject({ status: 200, body: { skills: [] } });
  });

  it("refuses a missing, forged, expired-looking or wrongly scoped capability with 401, reading nothing", async () => {
    const h = await runningTask();
    const skill = await h.skills.create({ orgId: TEST_ORG, content: skillFile("one-skill"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(skill)]);
    const [body] = h.grant.split(".");
    expect((await h.ask(null)).status).toBe(401);
    expect((await h.ask("not-a-capability")).status).toBe(401);
    expect((await h.ask(`${body}.${Buffer.from("forged").toString("base64url")}`)).status).toBe(401);
    // The capability the operation was dispatched with does not grant agent-skills.
    const ordinary = await h.ask(h.ordinary);
    expect(ordinary.status).toBe(401);
    expect(JSON.stringify(ordinary.body)).not.toContain("Steps");
    // A signed capability for another action is no better.
    const modelOnly = issueCapability({ callbackSigningKey: "c".repeat(64) }, h.workspaceId, h.operationId, h.fence, { modelAccess: true });
    expect((await h.ask(modelOnly)).status).toBe(401);
  });

  it("refuses a stale fence and a finished operation", async () => {
    const h = await runningTask();
    const stale = issueCapability({ callbackSigningKey: "c".repeat(64) }, h.workspaceId, h.operationId, h.fence + 5, { agentSkills: true });
    expect(await h.ask(stale)).toMatchObject({ status: 409, body: { error: { code: "STALE_FENCE" } } });
    await h.finish(h.workspaceId, h.operationId, "SUCCEEDED");
    expect(await h.ask()).toMatchObject({ status: 409, body: { error: { code: "STALE_FENCE" } } });
  });

  it("reads under the operation's org: a snapshot that names another org's skill gets no content", async () => {
    const h = await runningTask();
    const theirs = await h.skills.create({ orgId: ORG_B, content: skillFile("their-skill", "Theirs", "SECRET-THEIRS\n"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(theirs, "Theirs")]);
    const answer = await h.ask();
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain("SECRET-THEIRS");
  });

  it("refuses a snapshot recorded for another org than the task's", async () => {
    const h = await runningTask();
    const theirs = await h.skills.create({ orgId: ORG_B, content: skillFile("their-skill", "Theirs", "SECRET-THEIRS\n"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(theirs, "Theirs")], ORG_B);
    const answer = await h.ask();
    expect(answer.status).toBe(404);
    expect(JSON.stringify(answer.body)).not.toContain("SECRET-THEIRS");
  });

  it("does not serve a stored content that no longer hashes to its digest", async () => {
    const h = await runningTask();
    const skill = await h.skills.create({ orgId: TEST_ORG, content: skillFile("one-skill"), owner: MEMBER, by: ALICE });
    h.seedSnapshot([pinnedOf(skill)]);
    const key = skillKey(TEST_ORG, skill.skillId, `VERSION#${skill.currentDigest}`);
    h.db.set({ ...(h.db.get(key.pk, key.sk) as Record<string, unknown>), content: skillFile("one-skill", "Tampered") });
    const answer = await h.ask();
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain("Tampered");
  });
});
