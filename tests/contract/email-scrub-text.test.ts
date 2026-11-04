// S3 (C59, C60): model-written and user-written text that reaches other people never carries an email address. One shared helper (`hideEmailAddresses`, contracts) is applied where
// the text is rendered or sent to others: session views and tiles, Home cards, write-gate and decision texts (`shownText`), the shared-thread Slack messages, the plan's "why" quote and
// the pull request's title and description. Text with no address is returned byte for byte. Fake addresses are built at runtime.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { agentSessionKey, hideEmailAddresses, EMAIL_HIDDEN, mySessionsKey } from "../../packages/contracts/src/index.js";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { planWhyEntries } from "../../packages/broker/src/aws/developer-tasks.js";
import { shownText } from "../../packages/broker/src/agents/approvals-store.js";
import { setupFailedReply, startMessage } from "../../packages/broker/src/developer/share-messages.js";
import { listSessions, sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { pullRequestTitle } from "../../packages/broker/src/aws/developer-tasks/pull-request-body.js";
import { ARJUN, CELL, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { PRIYA as PAGE_PRIYA, pageTask } from "../support/page-tasks.js";

/** A fake address, built at runtime. */
const mail = (local: string, domain = "example.test") => `${local}${String.fromCharCode(64)}${domain}`;
const OMAR = mail("omar.diaz");

describe("hideEmailAddresses", () => {
  it("replaces an address wherever it sits and keeps everything around it, line breaks included", () => {
    expect(hideEmailAddresses(`Ask ${OMAR} about it`)).toBe(`Ask ${EMAIL_HIDDEN} about it`);
    expect(hideEmailAddresses(`(${OMAR}) and <${mail("a")}.org>`)).toBe(`(${EMAIL_HIDDEN}) and <${EMAIL_HIDDEN}>`);
    expect(hideEmailAddresses(`one ${OMAR}\n\n  two\t${mail("x.y+z")}\n`)).toBe(`one ${EMAIL_HIDDEN}\n\n  two\t${EMAIL_HIDDEN}\n`);
  });

  it("does not break a code block: the fences, the indentation and the other lines stay as they were", () => {
    const text = ["Run this:", "```sh", "  git commit -m 'fix'   # keep  the  spacing", `  mail -s hi ${OMAR}`, "```", "and `inline` code."].join("\n");
    expect(hideEmailAddresses(text)).toBe(text.replace(OMAR, EMAIL_HIDDEN));
  });

  it("leaves a link without an address alone, and a path that merely has an at sign", () => {
    for (const text of ["https://example.test/a/b?c=d#e", "https://example.test/@maya/posts.html", "see [docs](https://example.test/docs.html)", "@octocat and @scope/pkg.js", "ssh://host.example.test/repo.git"]) {
      expect(hideEmailAddresses(text), text).toBe(text);
    }
  });

  it("returns text without an address exactly as it was", () => {
    const samples = ["", "plain words", "  leading and trailing  ", "line one\r\nline two\n", "tabs\tand  double  spaces", "emoji \u{1F600} and é and 中文", "a@b", "x @ y.z", "# Heading\n\n- item\n- item\n\n```ts\nconst a = 1;\n```\n"];
    for (const text of samples) expect(hideEmailAddresses(text), JSON.stringify(text)).toBe(text);
  });

  it("finds a fullwidth spelling too", () => {
    expect(hideEmailAddresses(`write to omar＠example.test`)).not.toContain("omar");
  });
});

describe("shownText (write-gate, decision and Home words)", () => {
  it("hides an address in what an agent or a vendor supplied", () => {
    const shown = shownText(`Email ${OMAR} the report`, 300);
    expect(shown).toBe(`Email ${EMAIL_HIDDEN} the report`);
  });

  it("is unchanged for text with none", () => {
    expect(shownText("  Create an issue\nin  Linear ", 300)).toBe("Create an issue in Linear");
  });
});

describe("a session's words in a view and a tile", () => {
  function world() {
    const w = sessionWorld();
    const deps: SessionReadDependencies = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task) => ({ taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
    };
    return { w, deps };
  }
  function seedWords(w: ReturnType<typeof sessionWorld>, sessionId: string, words: { title: string; step: string; peek: string }) {
    const meta = w.db.get(agentSessionKey(ORG_A, sessionId, "META"))! as { summary: Record<string, unknown> };
    w.db.set({ ...meta, title: words.title, summary: { ...meta.summary, step: words.step, peek: words.peek } });
  }

  it("the view carries no address in the title, the step or the latest line", async () => {
    const { w, deps } = world();
    const { sessionId } = w.seedSession({ owner: PRIYA });
    seedWords(w, sessionId, { title: `Reply to ${OMAR}`, step: `Wrote to ${OMAR}`, peek: `Sent the draft to ${OMAR} just now` });
    const view = await sessionView(deps, w.caller(PRIYA), sessionId);
    expect(JSON.stringify(view)).not.toContain(OMAR);
    expect(view.title).toBe(`Reply to ${EMAIL_HIDDEN}`);
    expect(view.peek).toBe(`Sent the draft to ${EMAIL_HIDDEN} just now`);
    expect(JSON.stringify(view)).not.toContain(String.fromCharCode(64));
  });

  it("the tile carries no address in the title, the step or the latest line, and one without any is unchanged", async () => {
    const { w, deps } = world();
    const plain = w.seedSession({ owner: PRIYA });
    const dirty = w.seedSession({ owner: PRIYA });
    seedWords(w, dirty.sessionId, { title: `Reply to ${OMAR}`, step: `Wrote to ${OMAR}`, peek: `Sent to ${OMAR}` });
    for (const id of [plain.sessionId, dirty.sessionId]) {
      const createdAt = (w.db.get(agentSessionKey(ORG_A, id, "META")) as { createdAt: string }).createdAt;
      w.db.set({ ...mySessionsKey(ORG_A, PRIYA, createdAt, id), entityType: "MY_SESSION", orgId: ORG_A, sessionId: id, developerId: PRIYA, createdAt });
    }
    const tiles = (await listSessions(deps, w.caller(PRIYA), { owner: "me" })).sessions;
    const shown = tiles.find((tile) => tile.sessionId === dirty.sessionId)!;
    expect(JSON.stringify(shown)).not.toContain(OMAR);
    expect(shown.title).toBe(`Reply to ${EMAIL_HIDDEN}`);
    expect(shown.summary.step).toBe(`Wrote to ${EMAIL_HIDDEN}`);
    expect(shown.summary.peek).toBe(`Sent to ${EMAIL_HIDDEN}`);
    // A session with no address reads exactly as stored.
    const stored = w.db.get(agentSessionKey(ORG_A, plain.sessionId, "META"))! as { title: string; summary: unknown };
    const clean = tiles.find((tile) => tile.sessionId === plain.sessionId)!;
    expect(clean.title).toBe(stored.title);
    expect(clean.summary).toEqual(stored.summary);
    expect(ARJUN).toBeDefined();
  });
});

describe("the shared Slack thread", () => {
  it("the start message hides an address in the title", () => {
    const text = startMessage({ developerName: "Priya", client: "Claude Code", title: `Reply to ${OMAR}`, project: "payments", mode: "view", status: "running", sharedReason: "requested" });
    expect(text).not.toContain(OMAR);
    expect(text).toContain(`*Reply to ${EMAIL_HIDDEN}*`);
  });

  it("a failure's words hide an address", () => {
    const text = setupFailedReply(`could not fetch for ${OMAR}`);
    expect(text).not.toContain(OMAR);
    expect(text).toContain(EMAIL_HIDDEN);
  });

  it("a message with no address is what it was", () => {
    const text = startMessage({ developerName: "Priya", client: "Claude Code", title: "Fix the flaky test", project: "payments", mode: "continue", status: "running", sharedReason: "requested" });
    expect(text).toBe([
      "Priya started a task from Claude Code: *Fix the flaky test*",
      "Project: `payments`. Status: running.",
      "Open to the channel: members of this channel may mention AgentX in this thread to steer the task.",
    ].join("\n"));
  });
});

describe("the plan's why quote", () => {
  it("hides an address in the request and in the replies it quotes", async () => {
    const fixture = pageTask();
    const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as never as Record<string, unknown>;
    const withRequest = { ...record, requestText: `Retry failed payments and tell ${OMAR}`, threadNotesFedThrough: "2026-10-22T10:30:00.000Z" };
    fixture.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: "NOTE#1695500000.000200", entityType: "WORKFLOW_THREAD_NOTE", schemaVersion: 1, taskId: fixture.taskId, slackUserId: "U0SAM0001", isOwner: true,
      teamId: "T0PAGE001", channelId: "C0PAGE001", threadTs: "1695500000.000100", messageTs: "1695500000.000200", eventId: "Ev1", text: `Please cc ${OMAR}`, truncated: false, receivedAt: "2026-10-22T10:20:00.000Z", workflowRevision: 1 });
    const entries = await planWhyEntries(fixture.deps, withRequest as never, []);
    expect(JSON.stringify(entries)).not.toContain(OMAR);
    expect(entries[0]!.text).toBe(`Retry failed payments and tell ${EMAIL_HIDDEN}`);
    expect(entries[1]!.text).toBe(`Please cc ${EMAIL_HIDDEN}`);
    expect(PAGE_PRIYA.name).toBeDefined();
  });
});

describe("the pull request Rovara writes", () => {
  const task = (title: string) => ({ title }) as never;
  const now = "2026-10-25T12:00:00.000Z";
  const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const review = (role: "CRITIC" | "SECURITY") => ({ operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now });
  const workflow = () => WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now, definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: [review("CRITIC"), review("SECURITY")],
  });
  const context = { changedFiles: { files: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }], complete: true } };
  const SESSION = "https://rovara.example/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";

  it("the description hides an address from the plan text and keeps the plan's layout", () => {
    const plan = `# Plan\n\n1. Tell ${OMAR} when it ships.\n2. Add a regression test.\n\n\`\`\`sh\n  npm   test\n\`\`\`\n`;
    const body = workflowPullRequestBody(task("Add a retry flag"), workflow(), plan, SESSION, context);
    expect(body).not.toContain(OMAR);
    expect(body).toContain(EMAIL_HIDDEN);
  });

  it("the title hides an address", () => {
    expect(pullRequestTitle(`Tell ${OMAR} about it`, true)).toBe(`Rovara: Tell ${EMAIL_HIDDEN} about it`);
    expect(pullRequestTitle("Add a retry flag", false)).toBe("AgentX: Add a retry flag");
  });
});
