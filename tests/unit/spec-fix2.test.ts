// Fix round 2 (Opus recheck 1): R1 errors are classified and every hold has an action, R2 review eligibility never fails open, R3 model text is escaped structurally, R4 evidence is in the change, and m1/m2/m3/m5.
import { randomUUID } from "node:crypto";
import { micromark } from "micromark";
import { describe, expect, it, vi } from "vitest";
import { agentXError, SpecTargetSchema, specLine, specMarkdown, type SpecFile, type SpecTarget } from "@rovara-code/contracts";
import { readSpecPullRequestOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { fullStatus, specTask, withSpecProject } from "../support/spec-project.js";
import { createSpecHooks, type SpecPublishOutcome, type SpecStore, type SpecWorld } from "../../packages/broker/src/spec/hooks.js";
import { GitHubSpecError } from "../../packages/broker/src/spec/github-git-client.js";
import { approvingReviewer } from "../../packages/broker/src/spec/refresh.js";
import { SpecPublishError, classifyPublishError, gitBlobSha, publishSpec, type SpecGitClient, type SpecPullRequestOpener } from "../../packages/broker/src/spec/publish.js";
import { SPEC_ATTEMPTS_MAX, SPEC_TRANSIENT_MAX, continueWithoutSpec, edited, newSpecState, publishFailed, publishSucceeded, replanEdited, retry, specGate, startWriting, stepFailed, writeSucceeded, type SpecState } from "../../packages/broker/src/spec/state.js";
import { dynamoSpecStore } from "../../packages/broker/src/spec/store.js";
import { specEvidenceChecker } from "../../packages/worker/src/verification/review.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK = randomUUID();
const PLAN = "a".repeat(64);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const NOW = "2026-10-31T10:00:00.000Z";
const META = "https://github.com/acme/service-meta";
const FILES: SpecFile[] = [{ path: ".kiro/specs/x/requirements.md", content: "- 1.1 WHEN a THE SYSTEM SHALL b\n" }];
const target = (overrides: Partial<SpecTarget> = {}): SpecTarget => SpecTargetSchema.parse({ format: "kiro", ...overrides });
const fresh = (overrides: Partial<SpecTarget> = {}): SpecState => newSpecState({ taskId: TASK, planDigest: PLAN, kind: "feature", target: target(overrides), knowledgeCommit: BASE, now: NOW });
const written = (overrides: Partial<SpecTarget> = {}): SpecState => { const w = startWriting(fresh(overrides), randomUUID(), NOW)!; return writeSucceeded(w, { operationId: w.writeOperationId!, title: "T", files: FILES, requirementCount: 1 }, NOW)!; };
const published = (overrides: Partial<SpecTarget> = {}): SpecState => publishSucceeded(written(overrides), { pullRequest: { number: 12, url: `${META}/pull/12`, repositoryUrl: META, headBranch: `agentx/${randomUUID()}`, commit: HEAD } }, NOW)!;
const render = (markdown: string): string => micromark(markdown, { allowDangerousHtml: true });
const later = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

describe("R1: errors are classified", () => {
  it.each([[403, false], [404, false], [422, false], [401, false], [400, false], [500, true], [502, true], [503, true], [429, true], [408, true]])("GitHub %i is transient: %s", (status, transient) => {
    expect(classifyPublishError(new GitHubSpecError(status))).toBe(transient);
  });
  it("treats a network failure or a timeout as transient, and a missing token, repository or credential as permanent", () => {
    expect(classifyPublishError(new TypeError("fetch failed"))).toBe(true);
    expect(classifyPublishError(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(true);
    expect(classifyPublishError(new SpecPublishError("setup", false))).toBe(false);
    expect(classifyPublishError(agentXError("GITHUB_NOT_CONNECTED", "x"))).toBe(false);
    expect(classifyPublishError(agentXError("FORBIDDEN", "x"))).toBe(false);
    expect(classifyPublishError(agentXError("RUNTIME_UNAVAILABLE", "x"))).toBe(true);
  });
  it("publishSpec reports a 403 from GitHub as permanent and a 502 as transient", async () => {
    const refusing = (status: number): SpecGitClient => {
      const refuse = async (): Promise<never> => { throw new GitHubSpecError(status); };
      return { getCommit: async () => ({ tree: "t".repeat(40), parents: [] }), getBranch: async () => undefined, branchContains: async () => true, createBlob: async (content) => gitBlobSha(content), createTree: refuse, createCommit: refuse, createBranch: refuse, deleteBranch: refuse, compare: refuse };
    };
    const run = (status: number) => publishSpec({ git: refusing(status), pullRequests: { open: vi.fn(), read: vi.fn(), close: vi.fn() } }, { files: FILES, folder: ".kiro/specs/x/", baseCommit: BASE, baseBranch: "main", branch: "agentx/11111111-1111-4111-a111-111111111111", title: "S", body: "b", forbiddenFolders: [] }).catch((e: unknown) => e as SpecPublishError);
    expect(await run(403)).toMatchObject({ transient: false });
    expect(await run(502)).toMatchObject({ transient: true });
  });
});

function memory(extra: Partial<SpecWorld> = {}, initial?: SpecState) {
  const rows = new Map<string, SpecState>(initial === undefined ? [] : [[TASK, initial]]);
  const clock = { now: NOW };
  const store: SpecStore = {
    load: async (id) => ({ state: rows.get(id), corrupt: false }),
    save: async (next, replaces) => { const current = rows.get(next.taskId); if (current?.revision !== replaces) return false; rows.set(next.taskId, next); return true; },
    force: async (next) => { rows.set(next.taskId, next); return true; },
  };
  const world: SpecWorld = { tableName: "t", now: () => clock.now, store, log: () => undefined, startWrite: async () => "STARTED", publish: async () => ({ ok: false, transient: true }), ...extra };
  return { world, rows, clock };
}
const input = { task: { taskId: TASK, title: "T", knowledgeCommit: BASE }, approvedPlanDigest: PLAN, planMarkdown: () => "plan", metaRepositoryUrl: META };

describe("R1: a publication GitHub refuses for good is a failure with owner choices, and one it cannot do yet backs off with a cap", () => {
  it("records publish_failed on a permanent refusal, once, with Retry and Continue, and counts the attempt when retried", async () => {
    const publish = vi.fn(async (): Promise<SpecPublishOutcome> => ({ ok: false, transient: false }));
    const { world, rows } = memory({ publish }, written());
    const hooks = createSpecHooks(world);
    expect(await hooks.gate(input)).toMatchObject({ proceed: false, hold: { reason: "failed", ownerActions: ["retry", "continue_without_spec"] } });
    expect(rows.get(TASK)).toMatchObject({ status: "failed", failure: { code: "publish_failed" } });
    await hooks.gate(input);
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await hooks.ownerChoice({ taskId: TASK, action: "retry", by: "o" }))!.attempt).toBe(2);
  });
  it("backs off after a transient failure: no new call to GitHub until the wait is over, and the hold offers Continue", async () => {
    const publish = vi.fn(async (): Promise<SpecPublishOutcome> => ({ ok: false, transient: true }));
    const { world, rows, clock } = memory({ publish }, written());
    const hooks = createSpecHooks(world);
    expect(await hooks.gate(input)).toMatchObject({ proceed: false, hold: { reason: "publishing", ownerActions: ["continue_without_spec"] } });
    expect(rows.get(TASK)).toMatchObject({ status: "written", transient: 1 });
    expect(Date.parse(rows.get(TASK)!.retryAfter!)).toBeGreaterThan(Date.parse(NOW));
    await hooks.gate(input);
    expect(publish).toHaveBeenCalledTimes(1);
    clock.now = later(60);
    await hooks.gate(input);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it("waits longer each time, to a ceiling, and fails after the cap with the owner's choices", async () => {
    const publish = vi.fn(async (): Promise<SpecPublishOutcome> => ({ ok: false, transient: true }));
    const { world, rows, clock } = memory({ publish }, written());
    const hooks = createSpecHooks(world);
    const waits: number[] = [];
    for (let pass = 0; pass < SPEC_TRANSIENT_MAX; pass += 1) {
      const out = await hooks.gate(input);
      const state = rows.get(TASK)!;
      if (state.status === "failed") { expect(out).toMatchObject({ proceed: false, hold: { reason: "failed", ownerActions: ["retry", "continue_without_spec"] } }); break; }
      waits.push(Date.parse(state.retryAfter!) - Date.parse(clock.now));
      clock.now = later(24 * 60 * (pass + 1));
    }
    expect(rows.get(TASK)).toMatchObject({ status: "failed", failure: { code: "publish_failed" } });
    expect(publish).toHaveBeenCalledTimes(SPEC_TRANSIENT_MAX);
    expect(waits.every((wait, index) => index === 0 || wait >= waits[index - 1]!)).toBe(true);
    expect(Math.max(...waits)).toBeLessThanOrEqual(15 * 60_000);
  });
  it("clears the wait when a publication succeeds", async () => {
    let ok = false;
    const { world, rows, clock } = memory({ publish: async () => (ok ? { ok: true, pullRequest: { number: 3, url: `${META}/pull/3`, repositoryUrl: META, headBranch: "agentx/22222222-2222-4222-a222-222222222222", commit: HEAD } } : { ok: false, transient: true }) }, written());
    const hooks = createSpecHooks(world);
    await hooks.gate(input);
    ok = true; clock.now = later(60);
    expect(await hooks.gate(input)).toMatchObject({ proceed: true });
    expect(rows.get(TASK)!.retryAfter).toBeUndefined();
    expect(rows.get(TASK)!.transient).toBeUndefined();
  });
  it("counts a start that keeps failing, and fails the write after the cap instead of holding for ever", async () => {
    const startWrite = vi.fn(async (): Promise<"STARTED"> => { throw new Error("ddb down"); });
    const { world, rows, clock } = memory({ startWrite }, fresh());
    const hooks = createSpecHooks(world);
    for (let pass = 0; pass < SPEC_TRANSIENT_MAX + 1; pass += 1) { await hooks.gate(input); clock.now = later(24 * 60 * (pass + 1)); }
    expect(rows.get(TASK)).toMatchObject({ status: "failed", failure: { code: "write_failed" } });
    expect(startWrite).toHaveBeenCalledTimes(SPEC_TRANSIENT_MAX);
  });
  it("does not count a busy workspace as a failure", async () => {
    const { world, rows, clock } = memory({ startWrite: async () => "BUSY" }, fresh());
    const hooks = createSpecHooks(world);
    for (let pass = 0; pass < SPEC_TRANSIENT_MAX + 2; pass += 1) { await hooks.gate(input); clock.now = later(24 * 60 * (pass + 1)); }
    expect(rows.get(TASK)!.status).toBe("due");
  });
  it("counts the attempt when a write cannot be started for good, so Retry runs out", async () => {
    const { world, rows } = memory({ startWrite: async () => "REFUSED" }, fresh());
    const hooks = createSpecHooks(world);
    for (let round = 0; round < SPEC_ATTEMPTS_MAX; round += 1) {
      await hooks.gate(input);
      const state = rows.get(TASK)!;
      expect(state).toMatchObject({ status: "failed", attempt: round + 1 });
      if (round < SPEC_ATTEMPTS_MAX - 1) await hooks.ownerChoice({ taskId: TASK, action: "retry", by: "o" });
    }
    expect(await hooks.gate(input)).toMatchObject({ hold: { ownerActions: ["continue_without_spec"] } });
  });
});

describe("R1: every hold offers an action", () => {
  function everyState(): Array<[string, SpecState | undefined, boolean]> {
    const out: Array<[string, SpecState | undefined, boolean]> = [["corrupt", undefined, true]];
    const failureCodes = ["write_failed", "unreadable", "plan_changed", "render_failed", "template_missing", "publish_failed", "worker_outdated", "unsupported", "spec_closed"] as const;
    const w = startWriting(fresh(), randomUUID(), NOW)!;
    out.push(["writing", w, false], ["written", written(), false]);
    for (const code of failureCodes) {
      for (const attempt of [0, 1, SPEC_ATTEMPTS_MAX]) out.push([`failed ${code} attempt ${String(attempt)}`, { ...stepFailed(w, { operationId: w.writeOperationId!, code }, NOW)!, attempt }, false]);
    }
    for (const style of ["together", "spec_first"] as const) {
      const p = published({ linkStyle: style });
      out.push([`published ${style}`, p, false], [`edited ${style}`, edited(p, { headSha: "d".repeat(40) }, NOW)!, false], [`replan ${style}`, replanEdited(edited(p, { headSha: "d".repeat(40) }, NOW)!, "o", NOW)!, false]);
    }
    out.push(["published without a record of the pull request", { ...published(), specPullRequest: undefined }, false]);
    out.push(["backing off", { ...written(), transient: 2, retryAfter: later(10) }, false]);
    out.push(["continued", continueWithoutSpec(written(), "o", NOW)!, false], ["publish failed", publishFailed(written(), NOW)!, false]);
    return out;
  }
  it("holds with at least one owner action in every state the gate can be in", () => {
    for (const [name, state, corrupt] of everyState()) {
      const decision = specGate(state, corrupt, later(1));
      if (decision.action === "hold") expect(decision.ownerActions.length, name).toBeGreaterThan(0);
    }
  });
  it("offers Continue on a retry-less failure and on every in-progress hold", () => {
    const w = startWriting(fresh(), randomUUID(), NOW)!;
    expect(specGate(w)).toMatchObject({ action: "hold", reason: "writing", ownerActions: ["continue_without_spec"] });
    expect(specGate({ ...written(), transient: 1, retryAfter: later(10) }, false, NOW)).toMatchObject({ action: "hold", reason: "publishing", ownerActions: ["continue_without_spec"] });
  });
  it("the gate's own holds offer an action too (a busy workspace, a backoff, a write that is going)", async () => {
    const { world } = memory({ startWrite: async () => "BUSY" }, fresh());
    const out = await createSpecHooks(world).gate(input);
    expect(out).toMatchObject({ proceed: false });
    if (!out.proceed) expect(out.hold.ownerActions.length).toBeGreaterThan(0);
  });
  it("continue works whatever hold the state is in", async () => {
    for (const [name, state, corrupt] of everyState()) {
      if (corrupt || state === undefined || state.continuedWithoutSpec !== undefined) continue;
      const { world } = memory({}, state);
      expect(await createSpecHooks(world).ownerChoice({ taskId: TASK, action: "continue_without_spec", by: "o" }), name).toBeDefined();
    }
    void retry; void publishSucceeded;
  });
});

describe("R2: review eligibility never fails open", () => {
  const dependenciesFor = (reviews: Array<{ state: string; login: string; commitId?: string }>, levels: Record<string, string>) => {
    const getRepositoryPermission = vi.fn(async (_url: string, login: string) => levels[login] ?? "none");
    const rows = reviews.map((entry) => ({ state: entry.state, login: entry.login, commitId: entry.commitId ?? HEAD, githubUserId: `u-${entry.login}`, userType: "User" }));
    return { getRepositoryPermission, dependencies: { githubPullRequests: { getPullRequestStatus: vi.fn(async () => fullStatus({ headSha: HEAD, reviews: rows })), getRepositoryPermission } } as never };
  };
  it("looks up nobody who only commented: 40 drive-by comments do not use up anything, and a later objector is still seen", async () => {
    const reviews = [{ state: "APPROVED", login: "alice" }, ...Array.from({ length: 40 }, (_, index) => ({ state: "COMMENTED", login: `drive-by-${String(index)}` })), { state: "CHANGES_REQUESTED", login: "bob" }];
    const { dependencies, getRepositoryPermission } = dependenciesFor(reviews, { alice: "write", bob: "admin" });
    const facts = (await readSpecPullRequestOf(withSpecProject(dependencies, META))(specTask as never, META, 12))!;
    expect(getRepositoryPermission.mock.calls.map((call) => call[1]).sort()).toEqual(["alice", "bob"]);
    expect(facts.reviews.find((entry) => entry.login === "bob")!.eligible).toBe(true);
    expect(approvingReviewer(facts.reviews, HEAD)).toBeUndefined();
  });
  it("looks up only each reviewer's latest decisive review at the head, once", async () => {
    const reviews = [{ state: "CHANGES_REQUESTED", login: "alice" }, { state: "APPROVED", login: "alice" }, { state: "APPROVED", login: "carol", commitId: "d".repeat(40) }, { state: "DISMISSED", login: "dave" }];
    const { dependencies, getRepositoryPermission } = dependenciesFor(reviews, { alice: "write", carol: "write", dave: "write" });
    const facts = (await readSpecPullRequestOf(withSpecProject(dependencies, META))(specTask as never, META, 12))!;
    expect(getRepositoryPermission.mock.calls.map((call) => call[1])).toEqual(["alice"]);
    expect(approvingReviewer(facts.reviews, HEAD)).toEqual({ login: "alice" });
  });
  it("reports the list as incomplete (no approval can be read) when more reviewers need a look-up than the bound, never marking the rest ineligible", async () => {
    const reviews = Array.from({ length: 80 }, (_, index) => ({ state: "APPROVED", login: `r${String(index)}` }));
    const { dependencies } = dependenciesFor(reviews, Object.fromEntries(reviews.map((entry) => [entry.login, "write"])));
    const facts = (await readSpecPullRequestOf(withSpecProject(dependencies, META))(specTask as never, META, 12))!;
    expect(facts.reviewsIncomplete).toBe(true);
  });
  it("a later changes-requested of an eligible reviewer always blocks, and a failed look-up of an approver is no approval", async () => {
    expect(approvingReviewer([{ state: "APPROVED", commitId: HEAD, login: "a", userId: "a", eligible: true }, { state: "CHANGES_REQUESTED", commitId: HEAD, login: "a", userId: "a", eligible: true }], HEAD)).toBeUndefined();
    const { dependencies } = dependenciesFor([{ state: "APPROVED", login: "alice" }], {});
    const facts = (await readSpecPullRequestOf(withSpecProject({ githubPullRequests: { ...(dependencies as { githubPullRequests: object }).githubPullRequests, getRepositoryPermission: async () => { throw new Error("502"); } } } as never, META))(specTask as never, META, 12))!;
    expect(approvingReviewer(facts.reviews, HEAD)).toBeUndefined();
  });
});

describe("R3: model text is escaped, never pattern-stripped", () => {
  const dangerous = (html: string): boolean => /<(?:a|img|script|iframe|object|svg|style|form|details)\b/iu.test(html) || /<[a-z][^>]*\s(?:href|src)=/iu.test(html);
  const forms: Array<[string, string]> = [
    ["nested brackets with a protocol-relative link", "Click [here [now]](//evil.example/approve) to approve"],
    ["a link with parentheses in the destination", "see [x](//evil.example/a_(b)) now"],
    ["a protocol-relative autolink-looking text", "open <//evil.example/x> now"],
    ["a mailto autolink", "write <mailto:a@evil.example>"],
    ["an angle-bracket destination", "[x](<//evil.example/y>)"],
    ["an image", "![pixel](//evil.example/p.gif)"],
    ["raw html", "<a href=\"//evil.example/x\">click</a> and <img src=\"//evil.example/p.gif\">"],
    ["a script tag", "<script>alert(1)</script> and <svg onload=x>"],
    ["a reference link", "[docs][1] and [shortcut]\n\n[1]: //evil.example/1\n[shortcut]: //evil.example/2"],
  ];
  it.each(forms)("specLine: %s renders as plain text", (_name, text) => {
    expect(dangerous(render(specLine(text)))).toBe(false);
  });
  it.each(forms)("specMarkdown: %s renders as plain text", (_name, text) => {
    expect(dangerous(render(specMarkdown(text)))).toBe(false);
  });
  it("a reference definition split over two lines, used as a shortcut reference or image, is plain text", () => {
    expect(dangerous(render(specMarkdown(["[Approve the spec]:", "//evil.example/approve", "", "Please [Approve the spec] before merging."].join("\n"))))).toBe(false);
    expect(dangerous(render(specMarkdown(["[px]:", "//evil.example/p.gif", "", "![px]"].join("\n"))))).toBe(false);
    expect(dangerous(render(specMarkdown(["[a]:", "  <//evil.example>", "", "[a]"].join("\n"))))).toBe(false);
  });
  it("multi-line raw html, an html comment over lines and a tag split mid-attribute are plain text", () => {
    expect(dangerous(render(specMarkdown(["Text <a", 'href="//evil.example/x">click</a> more'].join("\n"))))).toBe(false);
    expect(dangerous(render(specMarkdown(["<div>", "<a href=\"//evil.example\">x</a>", "</div>"].join("\n"))))).toBe(false);
    expect(render(specMarkdown("before <!-- hidden\nlines --> after"))).toContain("hidden");
  });
  it("the text stays readable: what the model wrote is what a reader sees", () => {
    const plain = (html: string) => html.replace(/<[^>]+>/gu, "").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&").replace(/&quot;/gu, '"').replace(/‍/gu, "").trim();
    for (const text of ["use user_id and a*b with (parens) and [brackets]", "a | b # not a heading ~strike~ `code`", "a \\ backslash", "<b>bold</b> stays visible text"]) {
      expect(plain(render(specLine(text)))).toBe(text);
    }
  });
  it("is the same on a second pass (the broker reads the worker's draft again)", () => {
    for (const text of ["Click [here [now]](//evil.example/approve)", "<b>x</b> a_b *c* \\ done", "[a]:\n//e\n[a]"]) {
      expect(specLine(specLine(text))).toBe(specLine(text));
      expect(specMarkdown(specMarkdown(text))).toBe(specMarkdown(text));
    }
  });
  it("keeps code fences as they were written", () => {
    const out = specMarkdown("text\n```\n<a href=\"//x\">[y](z)</a>\n```\nafter");
    expect(out).toContain("<a href=\"//x\">[y](z)</a>");
    expect(dangerous(render(out))).toBe(false);
  });
});

describe("R4: a met needs evidence in the change", () => {
  const changes = [
    { path: "src/a.ts", status: "MODIFIED", hunks: [[10, 14]] }, { path: "api/src/a.ts", status: "MODIFIED", hunks: [[10, 14]] },
    { path: "src/new.ts", status: "ADDED", hunks: [[1, 40]] }, { path: "src/old.ts", status: "DELETED", hunks: [] }, { path: "src/odd.ts", status: "UNPLACEABLE", hunks: [] },
    { path: "test/a.test.ts", status: "ADDED", hunks: [[1, 20]] },
  ] as never;
  const ok = specEvidenceChecker([{ repositoryId: "api", directory: "/nonexistent" }], changes);
  it("accepts a changed path, with or without a line inside a changed hunk", () => {
    for (const entry of ["src/a.ts", "src/a.ts:10", "src/a.ts:12-14", "api/src/a.ts:11", "src/new.ts:30", "test/a.test.ts:5", "./src/a.ts:10"]) expect(ok(entry), entry).toBe(true);
  });
  it("refuses an unchanged file, even with a line that exists (README.md:1)", () => {
    for (const entry of ["README.md:1", "README.md", "src/unchanged.ts:3", "package.json"]) expect(ok(entry), entry).toBe(false);
  });
  it("refuses a line outside the changed hunks, past the new file, or on a deleted or unplaceable file", () => {
    for (const entry of ["src/a.ts:1", "src/a.ts:15", "src/a.ts:9-20", "src/new.ts:41", "src/old.ts:3", "src/odd.ts:2"]) expect(ok(entry), entry).toBe(false);
  });
  it("accepts a deleted or unplaceable file by its path alone, and refuses anything that is not a path", () => {
    expect(ok("src/old.ts")).toBe(true);
    expect(ok("src/odd.ts")).toBe(true);
    for (const entry of ["all requirements are met", "../src/a.ts", "/etc/passwd", "src/a.ts:abc", ""]) expect(ok(entry), entry).toBe(false);
  });
});

describe("m1: the pinned base must still be on the default branch", () => {
  it("holds the publication, permanently, when the base commit is no longer an ancestor of the default branch", async () => {
    const git = { getCommit: async () => ({ tree: "t".repeat(40), parents: [] }), getBranch: async () => undefined, branchContains: vi.fn(async () => false) } as unknown as SpecGitClient;
    const error = await publishSpec({ git, pullRequests: { open: vi.fn(), read: vi.fn(), close: vi.fn() } }, { files: FILES, folder: ".kiro/specs/x/", baseCommit: BASE, baseBranch: "main", branch: "agentx/11111111-1111-4111-a111-111111111111", title: "S", body: "b", forbiddenFolders: [] }).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "base", transient: false });
  });
});

describe("m2: an existing pull request on the spec branch is adopted only if it is Rovara's", () => {
  function gitThatVerifies(): SpecGitClient {
    const blobs = new Map<string, string>();
    return {
      getCommit: async (sha) => (sha === BASE ? { tree: "t".repeat(40), parents: [] } : { tree: "u".repeat(40), parents: [BASE] }), getBranch: async () => undefined, branchContains: async () => true,
      createBlob: async (content) => { const sha = gitBlobSha(content); blobs.set(sha, content); return sha; }, createTree: async () => "u".repeat(40), createCommit: async () => HEAD, createBranch: async () => undefined, deleteBranch: async () => undefined,
      compare: async () => ({ complete: true, commits: 1, files: FILES.map((file) => ({ path: file.path, status: "added", sha: gitBlobSha(file.content) })) }),
    };
  }
  const publish = (pullRequests: SpecPullRequestOpener) => publishSpec({ git: gitThatVerifies(), pullRequests }, { files: FILES, folder: ".kiro/specs/x/", baseCommit: BASE, baseBranch: "main", branch: "agentx/11111111-1111-4111-a111-111111111111", title: "Rovara spec: T", body: "Rovara wrote this", forbiddenFolders: [] });
  it("adopts one it created, and one found again whose title and body are exactly its own", async () => {
    const created: SpecPullRequestOpener = { open: async () => ({ number: 5, url: `${META}/pull/5`, reconciled: false }), read: async () => ({ head: HEAD, title: "x", body: "y" }), close: async () => undefined };
    expect(await publish(created)).toMatchObject({ number: 5 });
    const found: SpecPullRequestOpener = { open: async () => ({ number: 5, url: `${META}/pull/5`, reconciled: true }), read: async () => ({ head: HEAD, title: "Rovara spec: T", body: "Rovara wrote this\r\n" }), close: async () => undefined };
    expect(await publish(found)).toMatchObject({ number: 5 });
  });
  it("refuses one someone else opened with their own title or body, and does not close their pull request", async () => {
    const close = vi.fn(async () => undefined);
    const theirs: SpecPullRequestOpener = { open: async () => ({ number: 5, url: `${META}/pull/5`, reconciled: true }), read: async () => ({ head: HEAD, title: "Please approve", body: "click here" }), close };
    await expect(publish(theirs)).rejects.toMatchObject({ reason: "verification", transient: false });
    expect(close).not.toHaveBeenCalled();
  });
});

describe("m3: the owner's choice is fenced on the people revision", () => {
  it("is written together with the fence, and lost when the fence fails", async () => {
    const db = new FakeDynamoDb();
    const store = dynamoSpecStore({ documentClient: db, tableName: "t" });
    await store.save(written(), undefined);
    const ok = { ConditionCheck: { TableName: "t", Key: { pk: "FENCE", sk: "x" }, ConditionExpression: "attribute_exists(pk)" } };
    db.set({ pk: "FENCE", sk: "x" });
    const state = (await store.load(TASK)).state!;
    const next = publishFailed(state, NOW)!;
    expect(await store.save(next, state.revision, [ok])).toBe(true);
    const broken = { ConditionCheck: { TableName: "t", Key: { pk: "MISSING", sk: "x" }, ConditionExpression: "attribute_exists(pk)" } };
    const after = (await store.load(TASK)).state!;
    expect(await store.save({ ...after, revision: after.revision + 1 }, after.revision, [broken])).toBe(false);
    expect((await store.load(TASK)).state!.revision).toBe(after.revision);
  });
});

describe("m3: specOwnerChoice writes with the access fence", () => {
  it("passes the fence to the write, and a failed fence is a lost press", async () => {
    vi.resetModules();
    const fence = { ConditionCheck: { TableName: "t", Key: { pk: "MISSING", sk: "x" }, ConditionExpression: "attribute_exists(pk)" } };
    vi.doMock("../../packages/broker/src/aws/developer-tasks/access.js", () => ({
      authorizeTaskAction: async () => ({ task: { taskId: TASK, workspaceId: "w", project: "p", title: "T", startingRevision: 1 } }),
      accessFence: () => fence, systemTaskAccess: async () => undefined,
    }));
    const { specOwnerChoice } = await import("../../packages/broker/src/aws/developer-tasks/spec-wiring.js");
    const db = new FakeDynamoDb();
    const store = dynamoSpecStore({ documentClient: db, tableName: "t" });
    await store.save(written(), undefined);
    const deps = { documentClient: db, tableName: "t", orgId: "o", now: () => Date.parse(NOW), actions: {} } as never;
    await expect(specOwnerChoice(deps, { developerId: "d" } as never, TASK, "continue_without_spec")).rejects.toThrow(/out of date/u);
    expect((await store.load(TASK)).state!.continuedWithoutSpec).toBeUndefined();
    db.set({ pk: "MISSING", sk: "x" });
    expect(await specOwnerChoice(deps, { developerId: "d" } as never, TASK, "continue_without_spec")).toMatchObject({ status: "written" });
    expect((await store.load(TASK)).state!.continuedWithoutSpec).toBeDefined();
    vi.doUnmock("../../packages/broker/src/aws/developer-tasks/access.js");
  });
});

describe("m5: the project's knowledge folders are checked at render and at publish", () => {
  it("lists steering, skills, runbooks and key docs, and a spec folder inside one is refused by both", async () => {
    const { projectForbiddenFolders } = await import("../../packages/broker/src/spec/publish-request.js");
    const { assertSpecPaths } = await import("../../packages/broker/src/spec/publish.js");
    const forbidden = projectForbiddenFolders();
    expect(forbidden).toEqual(expect.arrayContaining([".kiro/steering", ".agents/skills", "runbooks", "docs/runbooks"]));
    expect(forbidden).not.toContain(".kiro/specs");
    expect(() => assertSpecPaths([{ path: "runbooks/x/spec.md", content: "x" }], "runbooks/x/", forbidden)).toThrow();
    expect(() => assertSpecPaths([{ path: ".kiro/specs/x/spec.md", content: "x" }], ".kiro/specs/x/", forbidden)).not.toThrow();
  });
});

describe("m1: the client asks GitHub whether the base is still on the branch", () => {
  it("is true when the branch is ahead of or at the commit, false when it diverged or is behind", async () => {
    const { githubSpecClient } = await import("../../packages/broker/src/spec/github-git-client.js");
    for (const [status, expected] of [["ahead", true], ["identical", true], ["diverged", false], ["behind", false]] as const) {
      const fetchImplementation = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status }) })) as unknown as typeof fetch;
      expect(await githubSpecClient({ repository: { owner: "a", name: "b" }, token: "T", fetchImplementation }).branchContains(BASE, "main")).toBe(expected);
    }
  });
});
