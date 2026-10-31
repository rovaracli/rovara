// Fix round 3 (Opus recheck 2): N1 the model never controls where a fence opens or closes, N5/N6 escaping is idempotent, N2 a failed look-up on an objector blocks, N3 back-off on the review path,
// N4 a closed workspace and a refused pull request are permanent, N7 the owner's other writes are fenced too.
import { randomUUID } from "node:crypto";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { describe, expect, it, vi } from "vitest";
import { SpecDraftSchema, SpecTargetSchema, inertSpecText, specLine, specMarkdown, type SpecFile, type SpecTarget } from "@agentx/contracts";
import { agentXError } from "@agentx/contracts";
import { readSpecPullRequestOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { createSpecHooks, type SpecStore, type SpecWorld } from "../../packages/broker/src/spec/hooks.js";
import { classifyPublishError } from "../../packages/broker/src/spec/publish.js";
import { approvingReviewer } from "../../packages/broker/src/spec/refresh.js";
import { dynamoSpecStore } from "../../packages/broker/src/spec/store.js";
import { newSpecState, publishSucceeded, specGate, specGateForReview, startWriting, writeSucceeded, type SpecState } from "../../packages/broker/src/spec/state.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK = randomUUID();
const PLAN = "a".repeat(64);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const NOW = "2026-10-31T10:00:00.000Z";
const META = "https://github.com/acme/service-meta";
const FILES: SpecFile[] = [{ path: ".kiro/specs/x/requirements.md", content: "- 1.1 WHEN a THE SYSTEM SHALL b\n" }];
const target = (overrides: Partial<SpecTarget> = {}): SpecTarget => SpecTargetSchema.parse({ format: "kiro", ...overrides });
const fresh = (): SpecState => newSpecState({ taskId: TASK, planDigest: PLAN, kind: "feature", target: target(), knowledgeCommit: BASE, now: NOW });
const written = (): SpecState => { const w = startWriting(fresh(), randomUUID(), NOW)!; return writeSucceeded(w, { operationId: w.writeOperationId!, title: "T", files: FILES, requirementCount: 1 }, NOW)!; };
const input = { task: { taskId: TASK, title: "T", knowledgeCommit: BASE }, approvedPlanDigest: PLAN, planMarkdown: () => "plan", metaRepositoryUrl: META };
const gfmRender = (markdown: string): string => micromark(markdown, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] });
const plainRender = (markdown: string): string => micromark(markdown, { allowDangerousHtml: true });
const live = (html: string): boolean => /<(?:a|img|script|iframe|style|svg|details|div|span|table|form|input|object|embed|link|meta|base)\b/iu.test(html);
const ATTACK = ['<a href="//evil.example/x">click</a>', "![px](//evil.example/p.gif)", "[go](//evil.example/y)", "https://evil.example/auto", "www.evil.example", "mail me: a@evil.example"];

describe("N1: the model never controls where a fence opens or closes", () => {
  const openers: Array<[string, string[]]> = [
    ["a fence inside a list item", ["- item", "  ```"]], ["a fence inside an ordered list item", ["1. item", "   ~~~"]], ["a fence indented by one space", [" ```"]], ["a fence indented by three spaces", ["   ```"]],
    ["a tilde fence", ["~~~"]], ["a long backtick fence", ["``````"]], ["an unclosed fence", ["```"]], ["a fence with an info string", ["```js"]], ["a fence nested in a block quote", ["> ```"]],
  ];
  for (const [name, opening] of openers) {
    for (const attack of ATTACK) {
      it(`${name}, then a dedented line and ${attack.slice(0, 22)}: everything after is inert (CommonMark and GFM)`, () => {
        const out = specMarkdown([...opening, "dedented line", attack, "after"].join("\n"));
        expect(live(plainRender(out)), plainRender(out)).toBe(false);
        expect(live(gfmRender(out)), gfmRender(out)).toBe(false);
        expect(plainRender(out)).not.toMatch(/<[a-z][^>]*\s(?:href|src)=/iu);
      });
    }
  }
  it("re-emits a code block the model wrote at column 0 inside a fence of its own, longer than any run in the content", () => {
    const out = specMarkdown(["intro", "```ts", "const a = 1;", "```", "outro"].join("\n"));
    expect(out).toBe("intro\n```ts\nconst a = 1;\n```\noutro");
    const longer = specMarkdown(["```", "has ``` inside", "and ```` too", "```"].join("\n"));
    const opening = longer.split("\n")[0]!;
    expect(opening).toMatch(/^`{5,}$/u);
    expect(live(plainRender(longer))).toBe(false);
  });
  it("closes an unclosed code block itself, so nothing after it can be swallowed or released", () => {
    const out = specMarkdown(["```", "code", "<a href=\"//evil.example\">x</a>"].join("\n"));
    expect(out.split("\n").filter((line) => /^`{3,}$/u.test(line))).toHaveLength(2);
    expect(live(plainRender(out + "\n\n[go](//evil.example)"))).toBe(true);
    expect(plainRender(out)).not.toMatch(/<[a-z][^>]*\shref=/iu);
  });
  it("lets a closing run inside the content (a different character, or a shorter run) stay content", () => {
    const out = specMarkdown(["~~~", "```", "<a href=\"//e\">x</a>", "~~~", "<a href=\"//evil.example/z\">click</a>"].join("\n"));
    expect(live(plainRender(out))).toBe(false);
  });
  it("keeps content lines as the model wrote them, in the fence", () => {
    const out = specMarkdown("```\n  indented\n<b>bold</b>\n```");
    expect(out).toContain("  indented\n<b>bold</b>");
  });
  it("is the same on a second pass for code blocks too", () => {
    for (const text of ["```ts\nconst a = 1;\n```", "```\nhas ``` inside\n```", "~~~\nopen only", "- item\n  ```\nafter"]) expect(specMarkdown(specMarkdown(text))).toBe(specMarkdown(text));
  });
  it("renders GFM autolink cases as plain text outside fences", () => {
    const out = specMarkdown("see https://evil.example/a and www.evil.example and a@evil.example and https://e.x/a_(b)");
    expect(gfmRender(out)).not.toMatch(/<a\b/u);
  });
});

describe("N5/N6: escaping is idempotent, across the worker's pass and the broker's", () => {
  const corpus = [
    "# Design\nUse the mailer.\n## Sub heading\n- item\n1. step", "**bold** and *em* and _u_", "[x](//evil.example) ![i](//e/p.gif) <b>x</b> <!-- c -->", "a@b.example and #12 and www.x.example and https://e.x", "\\ back\\slash \\* \\\\ \\[",
    "```ts\nlet a = [1];\n```\n# after", "| a | b |\n|---|---|", "> quote\n\n    indented code", "[a]:\n//e\n\n[a]", "**[x](//e)**", "**user_id**", "**a@b**", "e<b>", "x‍y @‍", "&amp; &#64; &lt;",
  ];
  it("inertSpecText gives the same text when applied twice, for @ too", () => {
    for (const text of ["a@b", "a@‍b", "https://e.x www.e.x #12", ...corpus]) expect(inertSpecText(inertSpecText(text)), text).toBe(inertSpecText(text));
  });
  it("specLine and specMarkdown are idempotent on a seeded random corpus over the active alphabet, and on the attack corpus", () => {
    const alphabet = ["\\", "[", "]", "(", ")", "<", ">", "!", "*", "_", "#", "|", "~", "`", "@", ":", "/", "-", "+", "1.", " ", "\n", "a", "b", "www.", "https", "&", ";", "‍", "\t"];
    let seed = 20261031;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const samples = [...corpus];
    for (let index = 0; index < 1500; index += 1) samples.push(Array.from({ length: 1 + (next() % 24) }, () => alphabet[next() % alphabet.length]!).join(""));
    for (const text of samples) {
      const line = specLine(text);
      expect(specLine(line), JSON.stringify(text)).toBe(line);
      const block = specMarkdown(text);
      expect(specMarkdown(block), JSON.stringify(text)).toBe(block);
    }
  });
  it("a draft parsed twice (the worker, then the broker) is the draft parsed once: design headings do not grow asterisks", () => {
    const raw = { version: 1, kind: "feature", title: "T [x](//e) _u_", summary: "s @a", planDigest: PLAN, requirements: [{ title: "R *x*", userStory: "as a@b", criteria: [{ when: "w #12", shall: "s <b>" }] }], design: "# Design\nUse **the** mailer.\n## Sub\n- item\n```ts\nlet a = 1;\n```", tasks: [{ title: "t_1", covers: [] }] };
    const once = SpecDraftSchema.parse(raw);
    const twice = SpecDraftSchema.parse(once);
    expect(twice).toEqual(once);
    expect(once.design).toContain("**Design**");
    expect(once.design).not.toContain("\\*\\*Design");
  });
  it("still escapes a bold line that is not a heading of ours", () => {
    expect(live(plainRender(specMarkdown("**[x](//evil.example/a)**")))).toBe(false);
    expect(specMarkdown("**a**b**")).not.toBe("**a**b**");
  });
});

function memory(extra: Partial<SpecWorld> = {}, initial?: SpecState, store?: Partial<SpecStore>) {
  const rows = new Map<string, SpecState>(initial === undefined ? [] : [[TASK, initial]]);
  const clock = { now: NOW };
  const base: SpecStore = {
    load: async (id) => ({ state: rows.get(id), corrupt: false }),
    save: async (next, replaces) => { if (rows.get(next.taskId)?.revision !== replaces) return false; rows.set(next.taskId, next); return true; },
    force: async (next) => { rows.set(next.taskId, next); return true; },
  };
  const world: SpecWorld = { tableName: "t", now: () => clock.now, store: { ...base, ...store }, log: () => undefined, startWrite: async () => "STARTED", publish: async () => ({ ok: false, transient: true }), ...extra };
  return { world, rows, clock };
}

describe("N2: a failed look-up never lets an objection be ignored", () => {
  it("reports the list incomplete when the objector's permission look-up errors, so the approval does not count", async () => {
    const reviews = [{ state: "APPROVED", login: "alice" }, { state: "CHANGES_REQUESTED", login: "bob" }].map((entry) => ({ ...entry, commitId: HEAD, githubUserId: `u-${entry.login}`, userType: "User" }));
    const getRepositoryPermission = vi.fn(async (_url: string, login: string) => { if (login === "bob") throw new Error("502"); return "write"; });
    const dependencies = { githubPullRequests: { getPullRequestStatus: async () => ({ state: "open", headSha: HEAD, reviews }), getRepositoryPermission } } as never;
    const facts = (await readSpecPullRequestOf(dependencies)({ orgId: "o" } as never, META, 12))!;
    expect(facts.reviewsIncomplete).toBe(true);
    expect(approvingReviewer(facts.reviews, HEAD)).toBeDefined();
    const { specStateFromFacts } = await import("../../packages/broker/src/spec/refresh.js");
    const spec = publishSucceeded(written(), { pullRequest: { number: 12, url: `${META}/pull/12`, repositoryUrl: META, headBranch: `agentx/${randomUUID()}`, commit: HEAD } }, NOW)!;
    expect(specStateFromFacts({ ...spec, target: target({ linkStyle: "spec_first" }) }, facts, NOW)).toBeUndefined();
  });
  it("does not report incomplete for a clean answer of none", async () => {
    const reviews = [{ state: "APPROVED", login: "alice" }, { state: "CHANGES_REQUESTED", login: "bob" }].map((entry) => ({ ...entry, commitId: HEAD, githubUserId: `u-${entry.login}`, userType: "User" }));
    const dependencies = { githubPullRequests: { getPullRequestStatus: async () => ({ state: "open", headSha: HEAD, reviews }), getRepositoryPermission: async (_u: string, login: string) => (login === "bob" ? "none" : "write") } } as never;
    expect((await readSpecPullRequestOf(dependencies)({ orgId: "o" } as never, META, 12))!.reviewsIncomplete).toBeUndefined();
  });
});

describe("N3: the review gate keeps the back-off", () => {
  it("holds while retryAfter is in the future, as the code pull request's gate does", () => {
    const waiting = { ...written(), transient: 2, retryAfter: new Date(Date.parse(NOW) + 60_000).toISOString() };
    expect(specGate(waiting, false, NOW)).toMatchObject({ action: "hold", reason: "publishing" });
    expect(specGateForReview(waiting, false, NOW)).toMatchObject({ action: "hold", reason: "publishing" });
  });
  it("does not call GitHub again within the wait on the review path", async () => {
    const publish = vi.fn(async () => ({ ok: false as const, transient: true }));
    const { world } = memory({ publish }, written());
    const hooks = createSpecHooks(world);
    for (let pass = 0; pass < 8; pass += 1) await hooks.gate({ ...input, purpose: "review" });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("N4: permanent failures are told apart", () => {
  it("fails the write, with Retry and Continue, when the workspace is refused for good (closed or failed preparation)", async () => {
    const { world, rows } = memory({ startWrite: async () => "REFUSED" }, fresh());
    const out = await createSpecHooks(world).gate(input);
    expect(out).toMatchObject({ proceed: false, hold: { reason: "failed", ownerActions: ["retry", "continue_without_spec"] } });
    expect(rows.get(TASK)).toMatchObject({ status: "failed", attempt: 1 });
  });
  it("classes a refused pull request (the connection's HTTP 403/422 sentence) as permanent and a 5xx as transient", () => {
    expect(classifyPublishError(agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation failed with HTTP 422: the head branch has no commits"))).toBe(false);
    expect(classifyPublishError(agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation failed with HTTP 403"))).toBe(false);
    expect(classifyPublishError(agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation failed with HTTP 502"))).toBe(true);
    expect(classifyPublishError(agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation outcome is unknown"))).toBe(true);
  });
});

describe("N7: the owner's other writes are fenced too", () => {
  it("writes a continue over a corrupt record with the fence, and refuses when the fence fails", async () => {
    const forced: unknown[][] = [];
    const { world } = memory({}, undefined, { load: async () => ({ state: undefined, corrupt: true }), force: async (...args: unknown[]) => { forced.push(args); return false; } });
    expect(await createSpecHooks(world).ownerChoice({ taskId: TASK, action: "continue_without_spec", by: "o" })).toBeUndefined();
    expect(forced).toHaveLength(1);
  });
  it("the store commits a forced write together with the fence, and loses it when the fence fails", async () => {
    const db = new FakeDynamoDb();
    const store = dynamoSpecStore({ documentClient: db, tableName: "t" });
    db.set({ pk: "FENCE", sk: "x" });
    const ok = { ConditionCheck: { TableName: "t", Key: { pk: "FENCE", sk: "x" }, ConditionExpression: "attribute_exists(pk)" } };
    const broken = { ConditionCheck: { TableName: "t", Key: { pk: "NOPE", sk: "x" }, ConditionExpression: "attribute_exists(pk)" } };
    expect(await store.force(written(), [broken])).toBe(false);
    expect((await store.load(TASK)).state).toBeUndefined();
    expect(await store.force(written(), [ok])).toBe(true);
    expect((await store.load(TASK)).state).toBeDefined();
  });
  it("the retry with no record queues the step again only with the fence", async () => {
    vi.resetModules();
    const fence = { ConditionCheck: { TableName: "t", Key: { pk: "NOPE", sk: "x" }, ConditionExpression: "attribute_exists(pk)" } };
    vi.doMock("../../packages/broker/src/aws/developer-tasks/access.js", () => ({
      authorizeTaskAction: async () => ({ task: { taskId: TASK, workspaceId: "w", project: "p", title: "T", startingRevision: 1, workflow: { stage: "REVIEW", state: "WAITING", revision: 3, candidate: { digest: "d".repeat(64) } } } }),
      accessFence: () => fence, systemTaskAccess: async () => undefined,
    }));
    const { specOwnerChoice } = await import("../../packages/broker/src/aws/developer-tasks/spec-wiring.js");
    const db = new FakeDynamoDb();
    const deps = { documentClient: db, tableName: "t", orgId: "o", now: () => Date.parse(NOW), actions: {} } as never;
    await expect(specOwnerChoice(deps, { developerId: "d" } as never, TASK, "retry")).rejects.toThrow();
    expect(db.find((item) => item.entityType === "WORKFLOW_DISPATCH")).toEqual([]);
    db.set({ pk: "NOPE", sk: "x" });
    expect(await specOwnerChoice(deps, { developerId: "d" } as never, TASK, "retry")).toEqual({ status: "retrying" });
    expect(db.find((item) => item.entityType === "WORKFLOW_DISPATCH")).toHaveLength(1);
    vi.doUnmock("../../packages/broker/src/aws/developer-tasks/access.js");
  });
  it("the owner's continue over a record that cannot be read goes through the same fence as the route", async () => {
    vi.resetModules();
    const fence = { ConditionCheck: { TableName: "t", Key: { pk: "NOPE", sk: "x" }, ConditionExpression: "attribute_exists(pk)" } };
    vi.doMock("../../packages/broker/src/aws/developer-tasks/access.js", () => ({
      authorizeTaskAction: async () => ({ task: { taskId: TASK, workspaceId: "w", project: "p", title: "T", startingRevision: 1, workflow: { stage: "REVIEW", state: "WAITING", revision: 3, candidate: { digest: "d".repeat(64) } } } }),
      accessFence: () => fence, systemTaskAccess: async () => undefined,
    }));
    const { specOwnerChoice } = await import("../../packages/broker/src/aws/developer-tasks/spec-wiring.js");
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVTASK#${TASK}`, sk: "SPEC#STATE", nonsense: true });
    const deps = { documentClient: db, tableName: "t", orgId: "o", now: () => Date.parse(NOW), actions: {} } as never;
    await expect(specOwnerChoice(deps, { developerId: "d" } as never, TASK, "continue_without_spec")).rejects.toThrow();
    expect(db.find((item) => item.sk === "SPEC#STATE")[0]).toMatchObject({ nonsense: true });
    db.set({ pk: "NOPE", sk: "x" });
    expect(await specOwnerChoice(deps, { developerId: "d" } as never, TASK, "continue_without_spec")).toEqual({ status: "skipped" });
    vi.doUnmock("../../packages/broker/src/aws/developer-tasks/access.js");
  });
});
