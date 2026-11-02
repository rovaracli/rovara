import { readFileSync } from "node:fs";
// Live interaction A2, broker side: the dispatcher answers a direct `task-peek` event (it, not the broker, holds the signing permission), the broker's client asks it synchronously, and an Ask
// falls back to the pull request's diff whenever there is no peek. The dispatcher signs only a `peek`, only for a workspace that is up with the same fence, and only for a worker that lists
// the feature; nothing is ever woken, written or repeated.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PEEK_FEATURE, PEEK_NO_CALLBACK_CAPABILITY, WORKER_PING_FEATURES_FIELD, WorkerInvocationSchema, workspaceSessionKey, type PeekAnswer, type WorkerInvocation,
} from "../../packages/contracts/src/index.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { createPeekDispatch } from "../../packages/broker/src/agent-sessions/peek-dispatch.js";
import { PEEK_TIMEOUT_MS, createPeekClient, lambdaPeekInvoker } from "../../packages/broker/src/agent-sessions/peek-client.js";
import { createAskDiffReader, diffFromPeek, splitPatchByFile } from "../../packages/broker/src/agent-sessions/ask-diff.js";
import { taskPointerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { verifyInvokeAuthorization, invocationMatchesClaims } from "../../packages/worker/src/invoke-auth.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

const workspaceId = randomUUID();
const taskId = randomUUID();
type Item = Record<string, unknown>;

function table(items: Item[]) {
  const sent: string[] = [];
  return {
    sent,
    client: { send: async (command: { input: { Key: { pk: string; sk: string } } }) => { sent.push(command.input.Key.pk); return { Item: items.find((item) => item["pk"] === command.input.Key.pk && item["sk"] === command.input.Key.sk) }; } },
  };
}

const workspaceRows = (overrides: { workspace?: Item; session?: Item | null } = {}): Item[] => [
  { pk: `WORKSPACE#${workspaceId}`, sk: "META", deploymentMode: "ec2-ebs", status: "BUSY", fence: 4, projectRevision: 2, ...overrides.workspace },
  ...(overrides.session === null ? [] : [{ ...workspaceSessionKey(workspaceId), state: "READY", generation: 7, privateIp: "10.42.1.9", ...overrides.session }]),
  { ...taskPointerKey(workspaceId), taskId },
];

const answer: PeekAnswer = { accepted: true, outcome: "peeked", files: [{ repository: "app", path: "a.txt", additions: 2, deletions: 1 }], untracked: [{ repository: "app", path: "new.txt" }],
  patch: "## repository app\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n-one\n+ONE\n+two\n", patchTruncated: false, filesTruncated: false };

function peekEvent(overrides: Record<string, unknown> = {}, fence = 4): { kind: "task-peek"; invocation: unknown } {
  return { kind: "task-peek", invocation: { protocolVersion: 1, kind: "peek", operationId: randomUUID(), workspaceId, fence, projectRevision: 2, callbackCapability: PEEK_NO_CALLBACK_CAPABILITY, payload: { maxPatchBytes: 32_768 }, ...overrides } };
}

function dispatcherSetup(options: { rows?: Item[]; features?: string[] | "down"; status?: number; body?: unknown } = {}) {
  const db = table(options.rows ?? workspaceRows());
  const posts: Array<{ url: string; authorization: string; body: string }> = [];
  const pings: string[] = [];
  const signs = vi.fn(kmsSign);
  const peek = createPeekDispatch({
    documentClient: db.client as never, tableName: "state", now: () => NOW, sign: signs,
    workerFeatures: async (url) => { pings.push(url); if (options.features === "down") throw new Error("ping failed"); return options.features ?? [PEEK_FEATURE]; },
    post: async (url, init) => { posts.push({ url, ...init }); return { status: options.status ?? 200, body: JSON.stringify(options.body ?? answer) }; },
  });
  return { peek, posts, pings, signs, db };
}

describe("the dispatcher answering a task-peek event", () => {
  it("signs one workspace token for exactly this invocation, posts it to the worker and returns the worker's answer", async () => {
    const s = dispatcherSetup();
    const event = peekEvent();
    expect(await s.peek(event)).toEqual({ outcome: "peeked", answer });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.url).toBe("http://10.42.1.9:8080/invocations");
    const invocation = JSON.parse(s.posts[0]!.body) as WorkerInvocation;
    expect(invocation.kind).toBe("peek");
    const verified = verifyInvokeAuthorization(s.posts[0]!.authorization, { publicKey: keys.publicKey, workspaceId, generation: 7, now: () => Math.floor(NOW / 1000) });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(invocationMatchesClaims(invocation, verified.claims)).toBe(true);
    // The callback capability is the fixed filler, not a capability.
    expect((invocation as { callbackCapability: string }).callbackCapability).toBe(PEEK_NO_CALLBACK_CAPABILITY);
  });

  it("signs nothing for an invocation that is not a peek (a cancel, a steer, a task), whatever the event says", async () => {
    for (const other of [
      { kind: "cancel", payload: { targetOperationId: randomUUID() } },
      { kind: "steer", payload: { targetOperationId: randomUUID(), messageId: "msg_0123456789abcdefghij", step: "IMPLEMENT", authority: "owner_instruction", sender: "person p_a1b2c3", text: "x" } },
      { kind: "close", payload: {} },
    ]) {
      const s = dispatcherSetup();
      expect(await s.peek({ kind: "task-peek", invocation: { ...(peekEvent().invocation as object), ...other } })).toEqual({ outcome: "invalid" });
      expect(s.signs).not.toHaveBeenCalled();
      expect(s.posts).toEqual([]);
    }
    for (const bad of [undefined, null, "x", { kind: "task-peek" }, peekEvent({ payload: { maxPatchBytes: 99_999 } }), peekEvent({ payload: { maxPatchBytes: 10, command: "ls" } })]) {
      const s = dispatcherSetup();
      expect(await s.peek(bad)).toEqual({ outcome: "invalid" });
      expect(s.signs).not.toHaveBeenCalled();
    }
  });

  it("answers a fixed word, and signs nothing, for a workspace that is not up: closed, a stale fence, no session, a stopped worker", async () => {
    const cases: Array<[Parameters<typeof workspaceRows>[0], ReturnType<typeof peekEvent>, string]> = [
      [{ workspace: { status: "CLOSED" } }, peekEvent(), "not_running"],
      [{ workspace: { deploymentMode: "other" } }, peekEvent(), "not_running"],
      [{}, peekEvent({}, 3), "stale"],
      [{ session: null }, peekEvent(), "no_worker"],
      [{ session: { state: "STOPPED" } }, peekEvent(), "no_worker"],
    ];
    for (const [rows, event, outcome] of cases) {
      const s = dispatcherSetup({ rows: workspaceRows(rows) });
      expect(await s.peek(event)).toEqual({ outcome });
      expect(s.signs).not.toHaveBeenCalled();
      expect(s.posts).toEqual([]);
    }
    const none = dispatcherSetup({ rows: [] });
    expect(await none.peek(peekEvent())).toEqual({ outcome: "not_running" });
  });

  it("does not send a peek to a worker that does not list the feature (an older worker), or that does not answer", async () => {
    const old = dispatcherSetup({ features: ["task.liveSteer.v1"] });
    expect(await old.peek(peekEvent())).toEqual({ outcome: "old_worker" });
    expect(old.posts).toEqual([]);
    expect(old.signs).not.toHaveBeenCalled();
    const down = dispatcherSetup({ features: "down" });
    expect(await down.peek(peekEvent())).toEqual({ outcome: "unavailable" });
    expect(down.posts).toEqual([]);
  });

  it("gives a fixed word for a worker that refuses or answers something else, and never repeats the worker's words", async () => {
    const refused = dispatcherSetup({ status: 400, body: { error: "SECRET-WORKER-WORDS" } });
    expect(JSON.stringify(await refused.peek(peekEvent()))).toBe('{"outcome":"unavailable"}');
    const oversize = dispatcherSetup({ body: { ...answer, patch: "x".repeat(40_000) } });
    expect(await oversize.peek(peekEvent())).toEqual({ outcome: "unavailable" });
    const unavailableAnswer = dispatcherSetup({ body: { ...answer, outcome: "unavailable" } });
    expect(await unavailableAnswer.peek(peekEvent())).toEqual({ outcome: "unavailable" });
    const extra = dispatcherSetup({ body: { ...answer, secret: "x" } });
    expect(await extra.peek(peekEvent())).toEqual({ outcome: "unavailable" });
  });

  it("is reached through the dispatcher Lambda entry, and the queue's batch still works beside it", async () => {
    const s = dispatcherSetup();
    const markDispatching = vi.fn(async () => true);
    const handler = createDispatcherHandler({ markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined, peek: s.peek });
    expect(await handler(peekEvent() as never)).toEqual({ outcome: "peeked", answer });
    expect(await handler({ Records: [] })).toEqual({ batchItemFailures: [] });
    expect(markDispatching).not.toHaveBeenCalled();
    // A dispatcher built without it answers a fixed word and touches nothing.
    const without = createDispatcherHandler({ markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined });
    expect(await without(peekEvent() as never)).toEqual({ outcome: "unavailable" });
  });
});

describe("a direct invoke of the dispatcher is a peek or the dispatch queue's own batch, nothing else (S2)", () => {
  const QUEUE = "arn:aws:sqs:us-west-2:123456789012:agentx-staging-dispatch";
  const forged = { Records: [{ messageId: "m1", body: JSON.stringify({ id: "x", invocation: { kind: "steer" } }), attributes: { ApproximateReceiveCount: "1" } }] };
  const build = () => {
    const markDispatching = vi.fn(async () => true);
    const liveSteer = { deliver: vi.fn(async () => undefined) };
    const handler = createDispatcherHandler({ markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined, liveSteer: liveSteer as never, queueArn: QUEUE });
    return { handler, markDispatching, liveSteer };
  };

  it("refuses an SQS-shaped event with no source, another source, or another queue's ARN, and delivers nothing", async () => {
    const { handler, markDispatching, liveSteer } = build();
    const record = forged.Records[0]!;
    for (const event of [
      forged,
      { Records: [{ ...record, eventSource: "aws:sns", eventSourceARN: QUEUE }] },
      { Records: [{ ...record, eventSource: "aws:sqs", eventSourceARN: "arn:aws:sqs:us-west-2:123456789012:another-queue" }] },
      { Records: [{ ...record, eventSource: "aws:sqs" }] },
      { Records: [{ ...record, eventSource: "aws:sqs", eventSourceARN: QUEUE }, { ...record, messageId: "m2" }] },
      { nothing: true },
    ]) await expect(handler(event as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(markDispatching).not.toHaveBeenCalled();
    expect(liveSteer.deliver).not.toHaveBeenCalled();
  });

  it("takes the queue's own batch, and still answers a peek", async () => {
    const { handler, liveSteer } = build();
    await expect(handler({ Records: [] } as never)).resolves.toEqual({ batchItemFailures: [] });
    const own = { Records: [{ ...forged.Records[0]!, eventSource: "aws:sqs", eventSourceARN: QUEUE }] };
    // The record is taken and processed as a queued one is (this one is not a valid invocation, so it fails the way a bad queued record does, for the queue to retry), not refused.
    await expect(handler(own as never)).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(liveSteer.deliver).not.toHaveBeenCalled();
    const s = dispatcherSetup();
    const withPeek = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined, markFailed: async () => undefined, peek: s.peek, queueArn: QUEUE });
    expect(await withPeek(peekEvent() as never)).toEqual({ outcome: "peeked", answer });
  });

  it("fails closed when the production entry has no queue ARN: the entry passes the environment's, and an empty one matches nothing", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/dispatcher.ts", import.meta.url), "utf8");
    expect(source).toContain('queueArn: process.env.DISPATCH_QUEUE_ARN ?? ""');
  });
});

describe("the broker's peek client", () => {
  const task = (overrides: { [K in keyof DeveloperTaskRecord]?: DeveloperTaskRecord[K] | undefined } = {}) => ({ taskId, workspaceId, project: "p", ...overrides }) as DeveloperTaskRecord;

  it("builds a peek invocation with no capability and no command, and returns only a peeked answer", async () => {
    const db = table(workspaceRows());
    const seen: unknown[] = [];
    const client = createPeekClient({ documentClient: db.client as never, tableName: "state", invoke: async (event) => { seen.push(event); return { outcome: "peeked", answer }; } });
    expect(await client(task())).toEqual(answer);
    const event = seen[0] as { kind: string; invocation: unknown };
    expect(event.kind).toBe("task-peek");
    const parsed = WorkerInvocationSchema.parse(event.invocation);
    expect(parsed).toMatchObject({ kind: "peek", workspaceId, fence: 4, projectRevision: 2, callbackCapability: PEEK_NO_CALLBACK_CAPABILITY, payload: { maxPatchBytes: 32_768 } });
  });

  it("gives nothing, and never throws, when the workspace is not this task's, is not up, or the dispatcher fails or answers badly", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({ outcome: "peeked", answer }));
    const make = (rows: Item[], inv: () => Promise<unknown> = invoke) => createPeekClient({ documentClient: table(rows).client as never, tableName: "state", invoke: inv });
    expect(await make(workspaceRows())(task({ workspaceId: undefined }))).toBeUndefined();
    expect(await make(workspaceRows())(task({ taskId: randomUUID() }))).toBeUndefined();
    expect(await make(workspaceRows({ workspace: { status: "CLOSED" } }))(task())).toBeUndefined();
    expect(await make(workspaceRows({ workspace: { deploymentMode: "other" } }))(task())).toBeUndefined();
    expect(await make([])(task())).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    for (const reply of [{ outcome: "old_worker" }, { outcome: "peeked", answer: { ...answer, patch: "x".repeat(50_000) } }, "nonsense", null]) {
      expect(await make(workspaceRows(), async () => reply as never)(task())).toBeUndefined();
    }
    expect(await make(workspaceRows(), async () => { throw new Error("boom"); })(task())).toBeUndefined();
  });

  it("waits no longer than its timeout: the abort signal it hands the invoker is bounded", async () => {
    let signal: AbortSignal | undefined;
    const client = createPeekClient({ documentClient: table(workspaceRows()).client as never, tableName: "state", invoke: async (_event, options) => { signal = options.abortSignal; return { outcome: "no_worker" }; } });
    await client(task());
    expect(signal).toBeDefined();
    expect(PEEK_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("invokes the dispatcher Lambda request-response and rejects on a function error or an empty payload", async () => {
    const sent: Array<{ input: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array } }> = [];
    const ok = lambdaPeekInvoker({ send: async (command) => { sent.push(command as never); return { Payload: Buffer.from(JSON.stringify({ outcome: "no_worker" })) }; } }, "arn:aws:lambda:x:1:function:d");
    expect(await ok(peekEvent(), { abortSignal: AbortSignal.timeout(1_000) })).toEqual({ outcome: "no_worker" });
    expect(sent[0]!.input).toMatchObject({ FunctionName: "arn:aws:lambda:x:1:function:d", InvocationType: "RequestResponse" });
    const bad = lambdaPeekInvoker({ send: async () => ({ FunctionError: "Unhandled", Payload: Buffer.from("{}") }) }, "arn");
    await expect(bad(peekEvent(), { abortSignal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    const empty = lambdaPeekInvoker({ send: async () => ({}) }, "arn");
    await expect(empty(peekEvent(), { abortSignal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  });
});

describe("the diff an Ask is given: a peek first, then the pull request's diff", () => {
  const task = { taskId, workspaceId, orgId: "org_a", project: "p", startingRevision: 2 } as unknown as DeveloperTaskRecord;
  const pullRequests = {
    pullRequests: vi.fn(async () => [{ repository: "app", number: 7, url: "https://example.invalid/pr/7", state: "OPEN" }] as never),
    repository: vi.fn(async () => "https://example.invalid/app"),
    files: vi.fn(async () => ({ files: [{ filename: "pr.ts", status: "modified", additions: 4, deletions: 0, patch: "@@ pr patch @@" }, { filename: "bin.png", status: "added", additions: 0, deletions: 0 }] })),
  };

  it("uses the peek's working tree while there is one, with the patch split by file", async () => {
    const read = createAskDiffReader({ peek: async () => answer, pullRequests });
    const diff = await read(task, "patches");
    expect(diff?.source).toBe("working_tree");
    expect(diff?.files).toEqual([{ path: "a.txt", additions: 2, deletions: 1 }, { path: "new.txt (new, not yet tracked)", additions: 0, deletions: 0 }]);
    expect(diff?.patches?.map((patch) => patch.path)).toEqual(["a.txt"]);
    expect(diff?.patches?.[0]?.patch).toContain("+ONE");
    expect(pullRequests.pullRequests).not.toHaveBeenCalled();
  });

  it("falls back to the pull request's diff when there is no peek (an older worker, a stopped one, a failure)", async () => {
    for (const peek of [async () => undefined, async () => { throw new Error("x"); }, undefined]) {
      const diff = await createAskDiffReader({ peek, pullRequests })(task, "patches");
      expect(diff).toMatchObject({ source: "pull_request", files: [{ path: "pr.ts", additions: 4, deletions: 0 }, { path: "bin.png", additions: 0, deletions: 0 }], patches: [{ path: "pr.ts", patch: "@@ pr patch @@" }] });
    }
  });

  it("gives nothing when neither source has a diff, and never throws", async () => {
    expect(await createAskDiffReader({})(task, "files")).toBeUndefined();
    const failing = { ...pullRequests, pullRequests: async () => { throw new Error("github down"); } };
    expect(await createAskDiffReader({ pullRequests: failing })(task, "files")).toBeUndefined();
    expect(await createAskDiffReader({ pullRequests: { ...pullRequests, repository: async () => undefined } })(task, "files")).toBeUndefined();
  });

  it("names a file with its repository only when there are several, and splits a patch at each file header", () => {
    const several = diffFromPeek({ ...answer, files: [{ repository: "app", path: "a.txt", additions: 1, deletions: 0 }, { repository: "lib", path: "a.txt", additions: 2, deletions: 0 }], untracked: [],
      patch: "## repository app\ndiff --git a/a.txt b/a.txt\n+one\n## repository lib\ndiff --git a/a.txt b/a.txt\n+two\n" });
    expect(several.files.map((file) => file.path)).toEqual(["app/a.txt", "lib/a.txt"]);
    expect(several.patches?.map((patch) => patch.path)).toEqual(["app/a.txt", "lib/a.txt"]);
    expect(splitPatchByFile("noise\ndiff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2")).toEqual([{ path: "x", patch: "diff --git a/x b/x\n+1" }, { path: "y", patch: "diff --git a/y b/y\n+2" }]);
    expect(WORKER_PING_FEATURES_FIELD).toBeDefined();
  });
});
