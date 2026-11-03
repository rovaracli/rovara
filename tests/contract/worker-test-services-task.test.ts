// Test services, slice 1, s1-worker-round T1 at the run-task level: a CHECKS run (a real workspace, a fake Docker) with and without a plan that has dependencies.
//   - WITHOUT dependencies (the `tx`-off case: the broker sends none) the run is today's, call for call: the golden snapshots below were taken from the tree BEFORE this lane's changes and must not change.
//   - WITH dependencies the services start after the working sandbox, the official round is sealed, and everything is torn down, also when the task throws.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, TaskDependencyPlanSchema, type ServiceCatalog, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { SEALED_ROUND_PORTS, TEST_SERVICES_USAGE_ARTIFACT, type TestServicesConfig } from "../../packages/worker/src/test-services-run.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { fakeServicesDocker } from "../support/fake-services-docker.js";

const run = promisify(execFile);
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const DIGEST = "a".repeat(64);
const cleanup: string[] = [];
beforeEach(() => forgetWorkerStartSweeps());
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

async function workspace() {
  const root = await temp("rsv-task-");
  const source = await temp("rsv-task-source-");
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await writeFile(join(source, "README.md"), "# sample\n");
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const definition = ProjectDefinitionSchema.parse({
    name: "sample", revision: 1,
    repositories: [{ name: "sample", url: "http://127.0.0.1/sample.git", path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
  });
  await prepareWorkspace({ rootPath: root, project: definition, materializer: async (_repository: unknown, destination: string) => { await run("git", ["clone", "--quiet", source, destination]); } });
  return root;
}

const READINESS = [{ cwd: "repo/sample", executable: "npm", args: ["test"], timeoutSeconds: 60 }];
const OPERATION = "55555555-5555-4555-8555-555555555555";

const dependencyPlan = () => TaskDependencyPlanSchema.parse({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: DIGEST,
  config: { database: "app", user: "app" }, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }],
  seeds: [{ command: { cwd: "repo/sample", executable: "npm", args: ["run", "migrate"], timeoutSeconds: 60 } }], reset: "fresh_per_round",
});

function checksInvocation(withDependencies: boolean): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: OPERATION, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: {
      conversationId: randomUUID(), prompt: "Run the checks.", workflowMode: "CHECKS", readiness: READINESS,
      testEnvironment: {
        revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }],
        ...(withDependencies ? { dependencies: [dependencyPlan()] } : {}),
      },
    },
  } as never;
}

const adapter: PiSessionAdapter = { create: () => Promise.reject(new Error("a CHECKS run starts no model session")) };

/** The run's calls with the random parts (uuids, the sandbox's name suffix, the workspace path) named, so two runs compare. */
function normalised(value: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(value).split(root).join("<root>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>").replace(/agentx-task-<uuid>-[0-9a-f]{8}\b/gu, "<sandbox>").replace(/agentx\.workspace=[0-9a-f]{16}/gu, "agentx.workspace=<ws>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/gu, "<time>").replace(/\b[0-9a-f]{40}\b/gu, "<sha>").replace(/"durationMs":\d+/gu, "\"durationMs\":0")) as unknown;
}

async function checksRun(options: { withDependencies: boolean; artifactSink?: (artifact: { name: string }) => Promise<void>; testServices?: TestServicesConfig; fake?: ReturnType<typeof fakeServicesDocker> }) {
  vi.stubEnv("AGENTX_RUNTIME", "ec2");
  vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
  vi.stubEnv("AGENTX_TASK_SHELL", "");
  vi.stubEnv("AGENTX_SANDBOX_IMAGE", IMAGE);
  const root = await workspace();
  const fake = options.fake ?? fakeServicesDocker({ imagePresent: true });
  const events: unknown[] = [];
  const artifacts: Array<{ name: string; content?: string }> = [];
  const dependencies = {
    rootPath: root, model: { provider: "fixture", modelId: "m" }, piAdapter: adapter,
    eventSink: (event: unknown) => { events.push(event); return Promise.resolve(); },
    artifactSink: options.artifactSink ?? ((artifact: { name: string; content?: string }) => { artifacts.push(artifact); return Promise.resolve(); }),
    taskShell: { kind: "sandbox" as const, docker: fake.docker, image: IMAGE },
    stopBeforeReading: { stopWorkspaceProcesses: () => Promise.resolve(), sweepWorkspaceContainers: () => Promise.resolve({ removed: 0 }), log: () => undefined },
    ...(options.testServices === undefined ? {} : { testServices: options.testServices }),
  };
  const result = await runTaskInvocation(checksInvocation(options.withDependencies), dependencies as never).then((value) => ({ value }), (error: unknown) => ({ error }));
  return { root, fake, events, artifacts, result };
}

describe("a CHECKS run with no dependencies in the plan (tx off) is today's, call for call", () => {
  it("docker calls, events and artifacts are the golden ones", async () => {
    const h = await checksRun({ withDependencies: false });
    expect("value" in h.result).toBe(true);
    expect(normalised(h.fake.calls, h.root)).toMatchInlineSnapshot(`
      [
        [
          "network",
          "inspect",
          "--format",
          "{{.Driver}} {{json .Options}} {{.Internal}}",
          "agentx-task",
        ],
        [
          "run",
          "--detach",
          "--name",
          "<sandbox>",
          "--label",
          "agentx.task=<uuid>",
          "--label",
          "agentx.workspace=<ws>",
          "--network",
          "agentx-task",
          "--user",
          "1000:1000",
          "--cpus",
          "17",
          "--memory",
          "39321m",
          "--memory-swap",
          "39321m",
          "--pids-limit",
          "4096",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--volume",
          "<root>:<root>",
          "--tmpfs",
          "<root>/.agentx:ro,noexec,nosuid,size=4k",
          "--tmpfs",
          "<root>/agent-sessions:ro,noexec,nosuid,size=4k",
          "--workdir",
          "<root>",
          "--entrypoint",
          "/usr/bin/tini",
          "registry.example.test/agentx/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "--",
          "sleep",
          "infinity",
        ],
        [
          "exec",
          "--env",
          "PYTHONUSERBASE=<root>/.agentx-python",
          "<sandbox>",
          "bash",
          "-c",
          "unset NODE_ENV; export PATH='<root>/.agentx-python/bin':"$PATH"; set -m; (cd -- "$1" && shift 2 && exec "$@") & child=$!; set +m; echo "$child" > "$2"; wait "$child"; status=$?; rm -f "$2"; exit "$status"",
          "bash",
          "<root>/repo/sample",
          "/tmp/agentx-command-<uuid>.pgid",
          "npm",
          "test",
        ],
        [
          "rm",
          "--force",
          "<sandbox>",
        ],
      ]
    `);
    expect(normalised(h.events, h.root)).toMatchInlineSnapshot(`
      [
        [
          {
            "payload": {
              "conversation": {
                "reopened": true,
                "started": true,
              },
              "conversationId": "<uuid>",
              "status": "RUNNING",
            },
            "timestamp": "<time>",
            "type": "lifecycle",
          },
        ],
        [
          {
            "payload": {
              "message": "AgentX is running the selected project checks against the current code. This retry has no code-editing tools.",
            },
            "timestamp": "<time>",
            "type": "progress",
          },
          {
            "payload": {
              "message": "AgentX found no new or changed tests, so nothing was checked against the original code.",
            },
            "timestamp": "<time>",
            "type": "progress",
          },
          {
            "payload": {
              "checks": {
                "agentClaim": "none",
                "checks": [
                  {
                    "after": "passed",
                    "before": "unknown",
                    "class": "passing",
                    "durationMs": 0,
                    "exitCode": 0,
                    "id": "readiness:0",
                    "label": "npm test (in repo/sample)",
                    "output": "",
                    "source": "project",
                  },
                ],
                "extraTry": "not_needed",
                "preambleSha256": "13700ee837b3fa8f1928cc23b88ce6c94d9bef179bb134758f95b4e6d69a47f3",
                "preambleVersion": "4",
                "source": "project",
                "status": "verified",
              },
              "conversationId": "<uuid>",
              "status": "SUCCEEDED",
              "workflowCandidateRepositories": [
                {
                  "baseCommitSha": "<sha>",
                  "commitSha": "<sha>",
                  "repositoryId": "sample",
                  "treeSha": "<sha>",
                },
              ],
              "workflowCheckCandidateRepositories": [
                {
                  "baseCommitSha": "<sha>",
                  "commitSha": "<sha>",
                  "repositoryId": "sample",
                  "treeSha": "<sha>",
                },
              ],
              "workflowMode": "CHECKS",
            },
            "timestamp": "<time>",
            "type": "result",
          },
        ],
      ]
    `);
    expect(normalised(h.artifacts.map((artifact) => artifact.name), h.root)).toMatchInlineSnapshot(`
      [
        "checks.json",
        "test-proof.json",
      ]
    `);
  });
});

function implementAdapter(): PiSessionAdapter {
  return {
    async create(input) {
      const sessionFile = join(input.sessionDirectory, "session.jsonl");
      await writeFile(sessionFile, "");
      return {
        conversationId: "c", sessionFile, prompt: async () => undefined, abort: async () => undefined, getModel: () => ({ provider: "fixture", modelId: "m" }),
        getSessionStats: () => ({ sessionFile, sessionId: "c", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: () => () => undefined, dispose: () => undefined,
      };
    },
  };
}

describe("an IMPLEMENT run (the default mode) with no dependencies in the plan is today's, call for call", () => {
  it("docker calls and events are the golden ones", async () => {
    vi.stubEnv("AGENTX_RUNTIME", "ec2");
    vi.stubEnv("AGENTX_WORKER_PROCESS_SCOPE", "container");
    vi.stubEnv("AGENTX_TASK_SHELL", "");
    vi.stubEnv("AGENTX_SANDBOX_IMAGE", IMAGE);
    const root = await workspace();
    const fake = fakeServicesDocker({ imagePresent: true });
    const events: unknown[] = [];
    const invocation = {
      protocolVersion: 1, kind: "task", operationId: OPERATION, workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { conversationId: randomUUID(), prompt: "run the tests", testEnvironment: checksInvocation(false).payload.testEnvironment },
    } as never;
    const result = await runTaskInvocation(invocation, {
      rootPath: root, model: { provider: "fixture", modelId: "m" }, piAdapter: implementAdapter(), eventSink: (event: unknown) => { events.push(event); return Promise.resolve(); }, artifactSink: () => Promise.resolve(),
      taskShell: { kind: "sandbox", docker: fake.docker, image: IMAGE },
    } as never).then((value) => ({ value }), (error: unknown) => ({ error }));
    expect("value" in result, String("error" in result ? (result.error as Error).message : "")).toBe(true);
    expect(normalised(fake.calls, root)).toMatchInlineSnapshot();
    expect(normalised(events, root)).toMatchInlineSnapshot();
  });
});

describe("a CHECKS run with a plan that has dependencies", () => {
  async function config(): Promise<TestServicesConfig> {
    const raw = JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog;
    const catalog = structuredClone(raw);
    for (const entry of catalog.entries) if (entry.id === "postgres@16") entry.image.digest = DIGEST;
    return { docker: undefined as never, registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", catalogEnv: "staging", edition: "public", probeImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: await temp("rsv-task-runs-"), catalog: () => Promise.resolve(catalog), sealedRound: SEALED_ROUND_PORTS, sleep: () => Promise.resolve(), log: () => undefined };
  }
  const withDocker = (base: TestServicesConfig, fake: ReturnType<typeof fakeServicesDocker>): TestServicesConfig => ({ ...base, docker: fake.docker });

  it("starts the services after the sandbox, seals the round, writes the usage record, and leaves nothing behind", async () => {
    const fake = fakeServicesDocker({ imagePresent: true });
    const base = await config();
    const h = await checksRun({ withDependencies: true, fake, testServices: withDocker(base, fake) });
    expect("value" in h.result, JSON.stringify("error" in h.result ? String((h.result.error as Error).message) : "")).toBe(true);
    const calls = fake.calls;
    const sandboxStart = calls.findIndex((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.startsWith("agentx-task-"));
    const networkCreate = calls.findIndex((call) => call[0] === "network" && call[1] === "create");
    const checkStart = calls.findIndex((call) => call[0] === "run" && call.includes("--detach") && call[call.indexOf("--name") + 1]!.endsWith("-check"));
    expect(sandboxStart).toBeGreaterThanOrEqual(0);
    expect(networkCreate).toBeGreaterThan(sandboxStart);
    expect(checkStart).toBeGreaterThan(networkCreate);
    // The readiness command ran in the check sandbox (sealed), with the env file; the usage record went out.
    expect(fake.execs.some((exec) => exec.args.some((arg) => arg.endsWith("-check")) && exec.envFile?.includes("DATABASE_URL=") === true)).toBe(true);
    expect(h.artifacts.map((artifact) => artifact.name)).toContain(TEST_SERVICES_USAGE_ARTIFACT);
    expect(fake.left().containers).toEqual([]);
    expect(fake.left().networks).toEqual([]);
    expect(await readdir(base.runDirectoryParent)).toEqual([]);
  });

  it("a task that throws after the services started (a sink fails) still tears everything down", async () => {
    const fake = fakeServicesDocker({ imagePresent: true });
    const base = await config();
    const h = await checksRun({ withDependencies: true, fake, testServices: withDocker(base, fake), artifactSink: (artifact) => (artifact.name === "checks.json" ? Promise.reject(new Error("the sink failed")) : Promise.resolve()) });
    expect("error" in h.result).toBe(true);
    expect(fake.left().containers).toEqual([]);
    expect(fake.left().networks).toEqual([]);
    expect(await readdir(base.runDirectoryParent)).toEqual([]);
  });

  it("a worker with no configuration refuses the task before it runs anything but the sandbox, with a fixed sentence", async () => {
    const fake = fakeServicesDocker({ imagePresent: true });
    const h = await checksRun({ withDependencies: true, fake });
    expect("error" in h.result && (h.result.error as Error).message).toMatch(/not set up to run test services/u);
    expect(fake.calls.filter((call) => call[0] === "network" && call[1] === "create")).toEqual([]);
  });
});
