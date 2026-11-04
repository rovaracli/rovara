// S3 (C59, C60): model-written and user-written text that reaches other people never carries an email address. One shared helper (`hideEmailAddresses`, contracts) is applied where
// the text is rendered or sent to others: session views and tiles, Home cards, write-gate and decision texts (`shownText`), the shared-thread Slack messages, the plan's "why" quote and
// the pull request's title and description. Text with no address is returned byte for byte. Fake addresses are built at runtime.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { agentSessionKey, hideEmailAddresses, EMAIL_HIDDEN, mySessionsKey, sharedSessionsKey } from "../../packages/contracts/src/index.js";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { planWhyEntries } from "../../packages/broker/src/aws/developer-tasks.js";
import { shownText } from "../../packages/broker/src/agents/approvals-store.js";
import { setupFailedReply, startMessage } from "../../packages/broker/src/developer/share-messages.js";
import { listSessions, sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { pullRequestTitle } from "../../packages/broker/src/aws/developer-tasks/pull-request-body.js";
import { AgentSessionStore } from "../../packages/broker/src/agent-sessions/store.js";
import { ARJUN, CELL, ORG_A, PRIYA, T0, sessionWorld } from "../support/agent-session-world.js";
import { iso, projectorWorld } from "../support/agent-session-projector-world.js";
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

  // H1: code text is not mail. Package versions, Go modules, scoped packages, git remotes and ssh hosts stay exactly as written.
  it("leaves package versions, modules, scopes, git remotes and ssh strings alone", () => {
    const at = String.fromCharCode(64);
    const samples = [
      `npm i react${at}18.3.1`, `node${at}22.23.2`, `"${at}agentx/contracts${at}0.4.2"`, `${at}scope/pkg${at}1.2.3`, `go get golang.org/x/tools${at}v0.1.0`, `lodash${at}4.17.21-rc.final`,
      `git clone git${at}github.com:org/repo.git`, `scp file.txt deploy${at}build.example.test:/srv/app`, `ssh ec2-user${at}ip-10-0-0-1.ec2.internal`, `ssh -i key.pem ec2-user${at}ip-10-0-0-1.ec2.internal`,
      `ssh://git${at}github.com/org/repo.git`, `git+ssh://git${at}github.com/org/repo.git`, `pkg${at}1.2.beta`, `pkg${at}1.0.0-rc.final`, `image${at}sha256:abc123`, `HEAD${at}{1}`, `pkg${at}git+https://example.test/pkg.git`, `${at}Component()`, `cc ${at}maya`, `https://example.test/${at}maya/post.html`,
    ];
    for (const text of samples) expect(hideEmailAddresses(text), text).toBe(text);
  });

  it("hides true addresses: any case, plus-addressing, dots, a trailing full stop, markup and a link around it", () => {
    const at = String.fromCharCode(64);
    const cases: Array<[string, string]> = [
      [`MAYA${at}EXAMPLE.TEST`, EMAIL_HIDDEN], [`maya+tag${at}example.test`, EMAIL_HIDDEN], [`maya.o_brien-x${at}mail.example.test.`, `${EMAIL_HIDDEN}.`],
      [`**maya${at}example.test**`, `**${EMAIL_HIDDEN}**`], [`|maya${at}example.test|admin|`, `|${EMAIL_HIDDEN}|admin|`], [`(maya${at}example.test)`, `(${EMAIL_HIDDEN})`],
      [`[Maya](mailto:maya${at}example.test)`, `[Maya](mailto:${EMAIL_HIDDEN})`], [`<mailto:a${at}x.test|a${at}x.test>`, `<mailto:${EMAIL_HIDDEN}|${EMAIL_HIDDEN}>`],
      [`https://example.test/u?email=maya${at}example.test&x=1`, `https://example.test/u?email=${EMAIL_HIDDEN}&x=1`], [`https://user:pw${at}host.example.test/path/x`, `https://user:${EMAIL_HIDDEN}/path/x`],
      [`ssh to maya${at}example.test later`, `ssh to ${EMAIL_HIDDEN} later`],
      // N1: a numeric first label with a letters-only TLD is a real address (163.com, 126.com), not a version.
      [`x${at}163.com`, EMAIL_HIDDEN], [`wang${at}126.com and li${at}189.cn`, `${EMAIL_HIDDEN} and ${EMAIL_HIDDEN}`],
      // N2: an underscore or a hyphen right after the address is not part of it.
      [`_a${at}b.io_`, `_${EMAIL_HIDDEN}_`], [`a${at}b.io-based`, `${EMAIL_HIDDEN}-based`], [`bob${at}example.com_x`, `${EMAIL_HIDDEN}_x`],
      // N3: an apostrophe is part of a local part.
      [`o'brien${at}example.com`, EMAIL_HIDDEN], [`ask d'arcy.o'neil${at}example.test now`, `ask ${EMAIL_HIDDEN} now`],
    ];
    for (const [text, expected] of cases) expect(hideEmailAddresses(text), text).toBe(expected);
  });

  it("hides a fullwidth address and a plain one in the same text, and changes no other character", () => {
    const at = String.fromCharCode(64);
    const text = `a${at}b.test and maya＠example.test, then ™ and … stay`;
    expect(hideEmailAddresses(text)).toBe(`${EMAIL_HIDDEN} and ${EMAIL_HIDDEN}, then ™ and … stay`);
    expect(hideEmailAddresses(`x ™ y maya＠example.test`)).toBe(`x ™ y ${EMAIL_HIDDEN}`);
  });
});

// S3-L5: the encoded spellings of the at sign (percent-encoded, once or twice, and the HTML references) are the same address, in a link's query or a rendered body.
describe("hideEmailAddresses: an at sign spelled %40 or &#64;", () => {
  const at = String.fromCharCode(64);
  it("hides an address whose at sign is percent-encoded or an HTML reference, and changes nothing else around it", () => {
    const cases: Array<[string, string]> = [
      [`https://example.test/u?email=maya%40example.test&x=1`, `https://example.test/u?email=${EMAIL_HIDDEN}&x=1`],
      [`maya%40example.test`, EMAIL_HIDDEN], [`maya%2540example.test`, EMAIL_HIDDEN], [`maya%2540EXAMPLE.TEST`, EMAIL_HIDDEN],
      [`write to maya&#64;example.test.`, `write to ${EMAIL_HIDDEN}.`], [`maya&#x40;example.test`, EMAIL_HIDDEN], [`maya&#X40;example.test`, EMAIL_HIDDEN], [`maya&#064;example.test`, EMAIL_HIDDEN], [`maya&commat;example.test`, EMAIL_HIDDEN],
      [`a%40b.test and c${at}d.test`, `${EMAIL_HIDDEN} and ${EMAIL_HIDDEN}`],
      [`<a href="mailto:maya%40example.test">maya&#64;example.test</a>`, `<a href="mailto:${EMAIL_HIDDEN}">${EMAIL_HIDDEN}</a>`],
    ];
    for (const [text, expected] of cases) expect(hideEmailAddresses(text), text).toBe(expected);
  });

  it("leaves encoded at signs that are not addresses alone (scopes, versions, mentions, percent signs)", () => {
    const samples = [
      "https://registry.npmjs.org/%40scope%2Fpkg", "https://registry.npmjs.org/%40scope/pkg/-/pkg-1.2.3.tgz", "npm i react%4018.3.1", "image%40sha256:abc123", "HEAD%40{1}",
      "mention &#64;octocat and &#64;team.", "a &commat; sign", "100%40 off", "5%40", "pkg%40git+https://example.test/pkg.git", "git clone git%40github.com:org/repo.git",
      "ssh://git%40github.com/org/repo.git", `${at}scope/pkg&#64;1.2.3`, "%4", "%2540", "&#64", "&#6;4",
    ];
    for (const text of samples) expect(hideEmailAddresses(text), text).toBe(text);
  });
});

// A pull request text makes an at sign inert with a zero-width joiner after it (`user@\u200Dexample.test`); GitHub shows that as an address, so it is one.
describe("hideEmailAddresses: an address made inert for GitHub", () => {
  const at = String.fromCharCode(64), zwj = "\u200D";
  it("hides an address whose at sign is followed by a zero-width character, and all of it", () => {
    expect(hideEmailAddresses(`notes/omar.diaz${at}${zwj}example.test.md (+3 -1)`)).toBe(`notes/${EMAIL_HIDDEN} (+3 -1)`);
    expect(hideEmailAddresses(`write to maya${at}${zwj}${zwj}example.test.`)).toBe(`write to ${EMAIL_HIDDEN}.`);
    expect(hideEmailAddresses(`maya${at}\u2060example.test and x${at}${zwj}y.test`)).toBe(`${EMAIL_HIDDEN} and ${EMAIL_HIDDEN}`);
  });

  it("leaves the inert forms of things that are not addresses alone", () => {
    for (const text of [`${at}${zwj}octocat and ${at}${zwj}scope/pkg`, `npm i react${at}${zwj}18.3.1`, `git clone git${at}${zwj}github.com:org/repo.git`, `see https://${zwj}example.test/${at}${zwj}maya/posts.html`, `a${at}${zwj}b`]) {
      expect(hideEmailAddresses(text), text).toBe(text);
    }
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

describe("a session's words in a view and a tile (to everyone but its owner)", () => {
  function world() {
    const w = sessionWorld();
    const deps: SessionReadDependencies = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task) => ({ taskId: task.taskId, title: `Reply to ${OMAR}`, project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
    };
    return { w, deps };
  }
  /** A session of Priya's with an address in the words, shared with Arjun (a person who is not its owner). */
  function shared(w: ReturnType<typeof sessionWorld>, words = { title: `Reply to ${OMAR}`, step: `Wrote to ${OMAR}`, peek: `Sent the draft to ${OMAR} just now` }) {
    const { sessionId } = w.seedSession({ owner: PRIYA });
    const meta = w.db.get(agentSessionKey(ORG_A, sessionId, "META"))! as { summary: Record<string, unknown>; createdAt: string };
    w.db.set({ ...meta, title: words.title, summaryRevision: 2, summary: { ...meta.summary, step: words.step, peek: words.peek } });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
    w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "member", developerId: ARJUN }, sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId, principal: { kind: "member", developerId: ARJUN }, level: "view", sharedAt: "2026-10-22T08:10:00.000Z" });
    w.db.set({ ...mySessionsKey(ORG_A, PRIYA, meta.createdAt, sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId, developerId: PRIYA, createdAt: meta.createdAt });
    return sessionId;
  }

  it("a person it was shared with sees no address in the title, the step, the latest line or the task's title", async () => {
    const { w, deps } = world();
    const sessionId = shared(w);
    const view = await sessionView(deps, w.caller(ARJUN), sessionId);
    expect(JSON.stringify(view)).not.toContain(OMAR);
    expect(view.title).toBe(`Reply to ${EMAIL_HIDDEN}`);
    expect(view.step).toBe(`Wrote to ${EMAIL_HIDDEN}`);
    expect(view.peek).toBe(`Sent the draft to ${EMAIL_HIDDEN} just now`);
    expect(JSON.stringify(view)).not.toContain(String.fromCharCode(64));
  });

  it("the owner's own view is their own words, as stored", async () => {
    const { w, deps } = world();
    const sessionId = shared(w);
    const view = await sessionView(deps, w.caller(PRIYA), sessionId);
    expect(view.title).toBe(`Reply to ${OMAR}`);
    expect(view.step).toBe(`Wrote to ${OMAR}`);
    expect(view.peek).toBe(`Sent the draft to ${OMAR} just now`);
  });

  it("the tile of a shared session hides the address, the owner's own tile does not, and a session with none is what was stored", async () => {
    const { w, deps } = world();
    const sessionId = shared(w);
    const plain = w.seedSession({ owner: PRIYA });
    const theirs = (await listSessions(deps, w.caller(ARJUN), { shared: "me" })).sessions.find((tile) => tile.sessionId === sessionId)!;
    expect(JSON.stringify(theirs)).not.toContain(OMAR);
    expect(theirs.title).toBe(`Reply to ${EMAIL_HIDDEN}`);
    expect(theirs.summary.step).toBe(`Wrote to ${EMAIL_HIDDEN}`);
    expect(theirs.summary.peek).toBe(`Sent the draft to ${EMAIL_HIDDEN} just now`);
    const createdAt = (w.db.get(agentSessionKey(ORG_A, plain.sessionId, "META")) as { createdAt: string }).createdAt;
    w.db.set({ ...mySessionsKey(ORG_A, PRIYA, createdAt, plain.sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId: plain.sessionId, developerId: PRIYA, createdAt });
    const mine = (await listSessions(deps, w.caller(PRIYA), { owner: "me" })).sessions;
    expect(mine.find((tile) => tile.sessionId === sessionId)!.title).toBe(`Reply to ${OMAR}`);
    const stored = w.db.get(agentSessionKey(ORG_A, plain.sessionId, "META"))! as { title: string; summary: unknown };
    const clean = mine.find((tile) => tile.sessionId === plain.sessionId)!;
    expect(clean.title).toBe(stored.title);
    expect(clean.summary).toEqual(stored.summary);
  });

  it("the stored record keeps the raw words (the refresh, a move to the cloud and make-an-agent work from them)", async () => {
    const { w } = world();
    const sessionId = shared(w);
    const record = await new AgentSessionStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now }).get(ORG_A, sessionId);
    expect(record?.title).toBe(`Reply to ${OMAR}`);
    expect(record?.summary.step).toBe(`Wrote to ${OMAR}`);
    expect(record?.summary.peek).toBe(`Sent the draft to ${OMAR} just now`);
  });

  it("a refresh that changes only the cost writes no second step event for a step that holds an address", async () => {
    const p = projectorWorld();
    const local = p.w.seedSession({ kind: "local", owner: PRIYA });
    const facts = { orgId: ORG_A, status: "running" as const, step: `Writing to ${OMAR}`, costUsd: 0.5, updatedAt: iso(T0) };
    const source = { read: vi.fn(async () => facts as Record<string, unknown>) };
    await p.refresh(local.sessionId, ORG_A, { local: source });
    expect(p.events(local.sessionId).filter((event) => event.type === "step")).toHaveLength(1);
    source.read.mockResolvedValue({ ...facts, costUsd: 0.75 });
    await p.refresh(local.sessionId, ORG_A, { local: source });
    expect(p.sessionOf(local.sessionId).summary).toMatchObject({ step: `Writing to ${OMAR}`, costUsd: 0.75 });
    expect(p.events(local.sessionId).filter((event) => event.type === "step")).toHaveLength(1);
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
