// A step that only reads the workspace (the reviews, the plan check, Understand, the PR feedback review) runs after the coding session, in a workspace that session wrote. Before any of
// them begins, every program the session started is stopped, the way publication does before a push: the worker's own leftover processes, then every container but the worker's (a task
// sandbox, the project's dev container). Nothing here starts a real process or container: the operating system and Docker are fakes that keep one timeline of what happened.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { DevcontainerCli } from "../../packages/worker/src/devcontainer.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { anotherOperationActive, createWorkerServerState, handleWorkerRequest, type WorkerServerState } from "../../packages/worker/src/server.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { sweepWorkspaceContainers, type DockerContainer } from "../../packages/worker/src/workspace-containers.js";
import { stopWorkspaceProcesses, type ProcessEntry } from "../../packages/worker/src/workspace-processes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const UID = 1000;
const SELF_PID = 7;
const UP_OUTPUT = "{\"outcome\":\"success\",\"containerId\":\"f832494aef96\",\"remoteUser\":\"node\",\"remoteWorkspaceFolder\":\"/workspaces/app\"}";
const SENTINEL = "the session was about to open";

type Mode = "REVIEW" | "FEEDBACK_REVIEW" | "PLAN_CRITIQUE" | "UNDERSTAND";
const MODES: readonly Mode[] = ["REVIEW", "FEEDBACK_REVIEW", "PLAN_CRITIQUE", "UNDERSTAND"];

async function workspace(options: { manifest?: boolean } = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stop-before-reading-")));
  roots.push(root);
  await mkdir(join(root, ".agentx"));
  await mkdir(join(root, "app/.devcontainer"), { recursive: true });
  await writeFile(join(root, "app/.devcontainer/devcontainer.json"), "{\"image\":\"node:22\"}\n");
  if (options.manifest !== false) await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "x", projectRevision: 1, creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(), completedSetupSteps: [], readinessResults: [],
    repositories: [{ name: "app", path: "app", url: "http://127.0.0.1/app.git", defaultBranch: "main" }],
    devcontainer: { repository: "app", configPath: "app/.devcontainer/devcontainer.json" },
  }));
  return root;
}

/** One timeline for the fake operating system, Docker and Pi, so the order of what happened can be asserted. */
function fakeWorld(root: string) {
  const timeline: string[] = [];
  const processes = new Map<number, { cwd: string; respawns: number }>();
  const containers: DockerContainer[] = [
    { id: "worker-own", names: ["/worker"], labels: {}, state: "running" },
    { id: "devcontainer-1", names: ["/vsc-app"], labels: { "devcontainer.local_folder": join(root, "app") }, state: "running" },
    { id: "old-sandbox-1", names: ["/agentx-task-old"], labels: { "agentx.task": "an-earlier-operation" }, state: "running" },
  ];
  let nextPid = 100;
  const world = {
    timeline, processes, containers, upCalls: 0, sessionsOpened: 0, listCalls: 0, sweepCalls: 0, removeFails: false, killsDoNothing: false,
    /** A program the coding session left behind: `setsid nohup server &`, working in the repository. */
    leave(respawns = 0) { const pid = nextPid++; processes.set(pid, { cwd: join(root, "app"), respawns }); return pid; },
    options: {
      stopWorkspaceProcesses: (rootPath: string) => stopWorkspaceProcesses({
        rootPath, scope: "container", selfPid: SELF_PID, uid: UID, rounds: 3,
        listProcesses: async (): Promise<ProcessEntry[]> => {
          world.listCalls += 1;
          return [{ pid: 1, ppid: 0, uid: 0, state: "S" }, { pid: SELF_PID, ppid: 1, uid: UID, state: "S", cwd: root },
            ...[...processes].map(([pid, entry]): ProcessEntry => ({ pid, ppid: 1, uid: UID, state: "S", cwd: entry.cwd }))];
        },
        kill: (pid) => {
          if (world.killsDoNothing) return;
          const entry = processes.get(pid);
          processes.delete(pid);
          timeline.push(`kill:${pid}`);
          // A program that starts another as it is stopped.
          if (entry !== undefined && entry.respawns > 0) processes.set(nextPid++, { cwd: entry.cwd, respawns: entry.respawns - 1 });
        },
      }),
      sweepWorkspaceContainers: (rootPath: string) => {
        world.sweepCalls += 1;
        return sweepWorkspaceContainers({
          rootPath, scope: "container", rounds: 3, log: () => undefined, socketMounted: async () => true, selfContainerId: async () => "worker-own",
          docker: {
            listContainers: async () => containers.map((entry) => ({ ...entry })),
            removeContainer: async (id) => {
              if (world.removeFails) throw new Error("permission denied for agentx-secret-customer-container");
              const at = containers.findIndex((entry) => entry.id === id);
              if (at >= 0) containers.splice(at, 1);
              timeline.push(`remove:${id}`);
            },
          },
        });
      },
      log: () => undefined,
    },
    docker: {
      async run(args) {
        timeline.push(`docker:${args[0]}`);
        if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async execBytes() { return { exitCode: 0, stdout: Buffer.from("{\"ok\":true,\"result\":{\"removed\":0}}\n"), stderr: "" }; },
    } satisfies DockerCli,
    devcontainerCli: {
      run: (args) => {
        timeline.push(`devcontainer:${args[0] ?? ""}`);
        if (args[0] === "up") world.upCalls += 1;
        return Promise.resolve({ exitCode: 0, stdout: args[0] === "up" ? UP_OUTPUT : "", stderr: "" });
      },
    } satisfies DevcontainerCli,
    /** Pi: the first session a step opens ends the run, after recording what was alive at that moment. */
    piAdapter: {
      async create() {
        world.sessionsOpened += 1;
        timeline.push(`session:open(processes=${processes.size},containers=${containers.map((entry) => entry.id).join("+")})`);
        throw new Error(SENTINEL);
      },
    } as unknown as PiSessionAdapter,
  };
  return world;
}

function invocation(mode: Mode | "IMPLEMENT"): WorkerInvocation {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Read it.", workflowMode: mode,
      ...(mode === "FEEDBACK_REVIEW" ? { workflowFeedbackReview: { taskId: randomUUID(), workflowRevision: 1, candidateDigest: "a".repeat(64) } } : {}) },
  };
}

async function run(root: string, world: ReturnType<typeof fakeWorld>, mode: Mode | "IMPLEMENT", extra: { otherOperationActive?: () => boolean } = {}) {
  const events: WorkerEvent[] = [];
  const outcome = await runTaskInvocation(invocation(mode), {
    rootPath: root, model: { provider: "fixture", modelId: "fixture" }, piAdapter: world.piAdapter, docker: world.docker, devcontainerCli: world.devcontainerCli,
    taskShell: { kind: "sandbox", docker: world.docker, image: "sandbox-image" },
    stopBeforeReading: { ...world.options, ...extra },
    // The feedback review reads its bundles right after the programs are stopped; reading them is where this test ends that run.
    feedbackBundleReader: async () => { world.timeline.push(`session:open(processes=${world.processes.size},containers=${world.containers.map((entry) => entry.id).join("+")})`); throw new Error(SENTINEL); },
    eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined, log: () => undefined,
  }).then(() => undefined, (error: unknown) => error as Error);
  return { outcome, events };
}

describe.each(MODES)("%s stops what the coding session started before it begins", (mode) => {
  it("kills a background program, removes a leftover sandbox and the dev container, then begins with none left", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    const background = world.leave();
    const daemon = world.leave(1);
    const { outcome } = await run(root, world, mode);

    // The step reached its first read (a positive control: the stop did not just fail the run).
    expect(outcome?.message).toBe(SENTINEL);
    const opened = world.timeline.findIndex((entry) => entry.startsWith("session:open"));
    expect(opened).toBeGreaterThan(-1);
    expect(world.timeline[opened]).toBe("session:open(processes=0,containers=worker-own)");
    const before = world.timeline.slice(0, opened);
    expect(before).toEqual(expect.arrayContaining([`kill:${background}`, `kill:${daemon}`, "remove:devcontainer-1", "remove:old-sandbox-1"]));
    // The program that started another as it was stopped is gone too.
    expect(before.filter((entry) => entry.startsWith("kill:")).length).toBeGreaterThanOrEqual(3);
    // The step's own sandbox is started only after everything was stopped, so it is never among what was removed.
    const sandboxStart = world.timeline.indexOf("docker:run");
    expect(sandboxStart).toBeGreaterThan(before.lastIndexOf("remove:old-sandbox-1"));
    expect(sandboxStart).toBeGreaterThan(before.lastIndexOf(`kill:${daemon}`));
    expect(sandboxStart).toBeLessThan(opened);
    // Nothing was killed or removed after the read began.
    expect(world.timeline.slice(opened + 1).filter((entry) => /^(kill|remove):/u.test(entry))).toEqual([]);
  });

  it("does not start the project's dev container, so none of its lifecycle commands runs before the read", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    await run(root, world, mode);
    expect(world.upCalls).toBe(0);
    expect(world.timeline.filter((entry) => entry.startsWith("devcontainer:"))).toEqual([]);
  });

  it("stops the step with one fixed reason, reads nothing and opens no sandbox, when a program cannot be stopped", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    world.leave();
    world.killsDoNothing = true;
    const { outcome, events } = await run(root, world, mode);

    expect(outcome?.message).toBe(`RUNTIME_UNAVAILABLE: AgentX ${WORKFLOW_LEFTOVER_PROCESSES_MESSAGE}, so it did not read the workspace`);
    expect(world.sessionsOpened).toBe(0);
    expect(world.timeline.some((entry) => entry.startsWith("session:open"))).toBe(false);
    expect(world.timeline.filter((entry) => entry.startsWith("docker:run"))).toEqual([]);
    expect(world.upCalls).toBe(0);
    // One attempt, bounded: the containment ran once, and the program list was read a bounded number of times (3 rounds of at most 4 containment rounds).
    expect(world.sweepCalls).toBeLessThanOrEqual(4);
    expect(world.listCalls).toBeLessThanOrEqual(12);
    if (mode === "FEEDBACK_REVIEW") {
      expect(events.find((event) => event.type === "error")?.payload).toMatchObject({ message: expect.stringContaining(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) as unknown });
    }
  });

  it("stops the step with the same fixed reason, and none of Docker's words, when a container cannot be removed", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    world.removeFails = true;
    const { outcome } = await run(root, world, mode);

    expect(outcome?.message).toBe(`RUNTIME_UNAVAILABLE: AgentX ${WORKFLOW_LEFTOVER_PROCESSES_MESSAGE}, so it did not read the workspace`);
    expect(outcome?.message).not.toContain("agentx-secret-customer-container");
    expect(world.sessionsOpened).toBe(0);
    expect(world.timeline.filter((entry) => entry.startsWith("docker:run"))).toEqual([]);
  });
});

describe.each(MODES)("%s and another operation still running in the worker", (mode) => {
  const FIXED = `RUNTIME_UNAVAILABLE: AgentX ${WORKFLOW_LEFTOVER_PROCESSES_MESSAGE}, so it did not read the workspace`;

  it("stops with the fixed reason and reads nothing: its children being killed would not stop code still writing the workspace", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    world.leave();
    const { outcome } = await run(root, world, mode, { otherOperationActive: () => true });
    expect(outcome?.message).toBe(FIXED);
    expect(world.timeline).toEqual([]);
    expect(world.sessionsOpened).toBe(0);
    expect(world.upCalls).toBe(0);
  });

  it("control: with no other operation running it stops what was left and reads", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    const { outcome } = await run(root, world, mode, { otherOperationActive: () => false });
    expect(outcome?.message).toBe(SENTINEL);
  });

  // The stop comes before the step reads anything in the workspace, the manifest the coding session could write included.
  it("stops first, before the workspace's manifest is read", async () => {
    const root = await workspace({ manifest: false });
    const world = fakeWorld(root);
    const background = world.leave();
    const { outcome } = await run(root, world, mode);
    expect(outcome?.message).not.toBe(SENTINEL);
    expect(outcome?.message).toMatch(/ENOENT|no such file/iu);
    expect(world.timeline).toEqual(expect.arrayContaining([`kill:${background}`, "remove:devcontainer-1"]));

    const refusing = fakeWorld(root);
    refusing.leave();
    refusing.killsDoNothing = true;
    const refused = await run(root, refusing, mode);
    expect(refused.outcome?.message).toBe(FIXED);
  });
});

describe("the worker's own record of running operations", () => {
  it("an IMPLEMENT still running and a REVIEW that arrives give the fixed stop, and no read", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    world.leave();
    const journalRoot = await mkdtemp(join(tmpdir(), "stop-before-reading-journal-"));
    roots.push(journalRoot);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const finished = new Map<string, { status: string; error?: string }>();
    const state: WorkerServerState = createWorkerServerState(new OperationJournal(journalRoot), {
      async execute(invocation: WorkerInvocation) {
        if (invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT") { await gate; return undefined; }
        await runTaskInvocation(invocation, {
          rootPath: root, model: { provider: "fixture", modelId: "fixture" }, piAdapter: world.piAdapter, docker: world.docker, devcontainerCli: world.devcontainerCli,
          taskShell: { kind: "sandbox", docker: world.docker, image: "sandbox-image" },
          stopBeforeReading: { ...world.options, otherOperationActive: () => anotherOperationActive(state, invocation.operationId) },
          eventSink: async () => undefined, artifactSink: async () => undefined, log: () => undefined,
        });
        return undefined;
      },
    }, { onTerminal: async (result) => { finished.set(result.operationId, { status: result.status, ...(result.error === undefined ? {} : { error: result.error }) }); } });
    const post = (invocation: WorkerInvocation) => handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", body: JSON.stringify(invocation) }), state);
    const implement = invocation("IMPLEMENT");
    const review = invocation("REVIEW");
    expect((await post(implement)).status).toBe(200);
    expect((await post(review)).status).toBe(200);
    for (let attempt = 0; attempt < 200 && !finished.has(review.operationId); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 10));

    expect(finished.get(review.operationId)).toMatchObject({ status: "FAILED", error: expect.stringContaining(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) as unknown });
    expect(world.timeline).toEqual([]);
    expect(world.sessionsOpened).toBe(0);
    // Once the IMPLEMENT has ended, the same kind of step goes on.
    release();
    for (let attempt = 0; attempt < 200 && !finished.has(implement.operationId); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(state.activeOperations.has(implement.operationId)).toBe(false);
    expect(anotherOperationActive(state, randomUUID())).toBe(false);
  });

  it("counts every operation but the asking one", () => {
    const state = { activeOperations: new Set(["a", "b"]) } as unknown as WorkerServerState;
    expect(anotherOperationActive(state, "a")).toBe(true);
    expect(anotherOperationActive({ activeOperations: new Set(["a"]) }, "a")).toBe(false);
    expect(anotherOperationActive({ activeOperations: new Set() } as unknown as WorkerServerState, "a")).toBe(false);
  });
});

describe("control: a step that runs the project's code is not stopped first", () => {
  it("starts the dev container for a coding run, which the reading steps above do not", async () => {
    const root = await workspace();
    const world = fakeWorld(root);
    world.leave();
    await run(root, world, "IMPLEMENT");
    expect(world.upCalls).toBeGreaterThan(0);
    expect(world.timeline.some((entry) => entry.startsWith("kill:"))).toBe(false);
    expect(world.timeline.some((entry) => entry.startsWith("remove:"))).toBe(false);
  });
});
