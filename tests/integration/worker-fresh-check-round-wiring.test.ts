// TE-B1-fresh: the fresh check round through the worker's CHECKS path (run-task.ts -> check-round-choice.ts -> fresh-check-round.ts). Real git workspace, fake Docker CLI, offline. With the company gate on, the official round
// runs in a NEW container made from the committed code and the working sandbox's exec is never used for it; with the gate off, it is today's round, unchanged.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ProjectCommand } from "@rovara-code/contracts";
import { type WorkerInvocation } from "@agentx/cloud-contracts";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { projectCheckKey } from "../../packages/worker/src/verification/check-history.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL } from "../support/faux-model.js";
import { git } from "../support/test-proof-fixture.js";

const IMAGE = "registry.example.test/agentx/worker@sha256:" + "b".repeat(64);
const check: ProjectCommand = { cwd: "app", executable: "npm", args: ["fresh-wiring-marker", "--outputFile=report.json"], timeoutSeconds: 60 };

async function workspace(): Promise<string> {
  const rootPath = await createFixtureDirectory("agentx-wire-");
  const repository = join(rootPath, "app");
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(repository, ".gitignore"), "node_modules/\nreport.json\n");
  git(repository, "init", "-q", "-b", "main");
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", "fixture");
  const resolvedCommit = git(repository, "rev-parse", "HEAD");
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "fresh", projectRevision: 1, repositories: [{ name: "app", path: "app", defaultBranch: "main", resolvedCommit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], readinessCommandKeys: [projectCheckKey(check)], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  // what the agent left behind in the working tree that git ignores (an installed dependency it edited): a clean export must not carry it, and the candidate's tree does not name it
  await mkdir(join(repository, "node_modules", "dep"), { recursive: true });
  await writeFile(join(repository, "node_modules", "dep", "index.js"), "// edited by the agent\n");
  return rootPath;
}

function fakeDocker(exitOf: (text: string, container: string) => number = () => 0, onExec?: (text: string, calls: string[][]) => void) {
  const calls: string[][] = [];
  const docker: DockerCli = {
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: 'bridge {"com.docker.network.bridge.enable_icc":"false","com.docker.network.bridge.name":"rvbtask"} false', stderr: "" };
      if (args[0] === "exec") {
        const text = args.join(" ");
        if (text.includes("REMAINING:")) return { exitCode: 0, stdout: "REMAINING:0\n", stderr: "" };
        if (text.includes("kill")) return { exitCode: 0, stdout: "", stderr: "" };
        onExec?.(text, calls);
        return { exitCode: exitOf(text, args.find((arg) => arg.startsWith("agentx-task-") || arg.startsWith("agentx-fresh-")) ?? ""), stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { docker, calls };
}
const nameOf = (args: string[]) => args[args.indexOf("--name") + 1]!;

async function checksRun(rootPath: string, fake: ReturnType<typeof fakeDocker>, extra: Partial<Parameters<typeof runTaskInvocation>[1]> & { evidenceCapture?: boolean } = {}) {
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "check it", readiness: [check], workflowMode: "CHECKS", ...(extra.evidenceCapture === true ? { evidenceCapture: true } : {}) },
  };
  const events: WorkerEvent[] = [];
  const artifacts: Array<{ name: string; content: string }> = [];
  const result = await runTaskInvocation(invocation, {
    rootPath, model: FAUX_MODEL, taskShell: { kind: "sandbox", docker: fake.docker, image: IMAGE },
    eventSink: async (batch) => { events.push(...batch); }, artifactSink: async (artifact) => { artifacts.push(artifact); }, ...extra,
  });
  return { result, events, artifacts };
}
const progressTexts = (events: WorkerEvent[]) => events.filter((event) => event.type === "progress").map((event) => JSON.stringify(event));
const execsWith = (calls: string[][], marker: string) => calls.filter((args) => args[0] === "exec" && args.join(" ").includes(marker));

describe("the CHECKS round with the freshCheckRound gate", () => {
  it("gate on: the check runs in a NEW container made from the committed code, never in the working sandbox; the first line says 'not sealed'; the container and export are gone after", async () => {
    const rootPath = await workspace();
    const fake = fakeDocker();
    const { result, events } = await checksRun(rootPath, fake, { freshCheckRound: () => ({ setup: [] }) });
    expect(result.checks).toMatchObject({ status: "verified", source: "project", checks: [expect.objectContaining({ after: "passed" })] });
    const starts = fake.calls.filter((args) => args[0] === "run");
    expect(starts).toHaveLength(2);
    const working = starts.find((args) => nameOf(args).startsWith("agentx-task-"))!;
    const fresh = starts.find((args) => nameOf(args).startsWith("agentx-fresh-"))!;
    expect(fresh).toContain("rovara.check-round=fresh");
    expect(fresh[fresh.indexOf("--volume") + 1]).toContain(join(rootPath, ".agentx", "fresh-check"));
    expect(fresh.filter((arg) => arg === "--network")).toHaveLength(1);
    // the check's command went to the fresh container, and to nothing else
    const checkExecs = execsWith(fake.calls, "fresh-wiring-marker");
    expect(checkExecs.length).toBeGreaterThan(0);
    for (const args of checkExecs) { expect(args).toContain(nameOf(fresh)); expect(args).not.toContain(nameOf(working)); }
    // the working sandbox was never paused, never joined to another network
    expect(fake.calls.some((args) => args[0] === "pause" || (args[0] === "network" && args[1] === "connect"))).toBe(false);
    // the first progress line of the round
    const lines = progressTexts(events);
    const first = lines.findIndex((line) => line.includes("not sealed: checked in a fresh sandbox"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(lines.filter((line) => /(?<!not )sealed/iu.test(line))).toEqual([]);
    // cleanup
    expect(fake.calls.some((args) => args[0] === "rm" && args.includes(nameOf(fresh)))).toBe(true);
    const parent = join(rootPath, ".agentx", "fresh-check");
    expect(existsSync(parent) ? readdirSync(parent).filter((name) => name !== "scratch") : []).toEqual([]);
  });

  it("gate off: today's round, in the working sandbox, with no second container", async () => {
    const rootPath = await workspace();
    const fake = fakeDocker();
    await checksRun(rootPath, fake);
    const starts = fake.calls.filter((args) => args[0] === "run");
    expect(starts).toHaveLength(1);
    expect(nameOf(starts[0]!).startsWith("agentx-task-")).toBe(true);
    expect(execsWith(fake.calls, "fresh-wiring-marker").every((args) => args.includes(nameOf(starts[0]!)))).toBe(true);
    expect(fake.calls.some((args) => args.join(" ").includes("agentx-fresh-"))).toBe(false);
  });

  it("gate on but the sandbox cannot start: the check is 'not run' with the fixed sentence and nothing runs in the working sandbox", async () => {
    const rootPath = await workspace();
    const base = fakeDocker();
    const failing: DockerCli = { run: (args, options) => (args[0] === "run" && nameOf([...args]).startsWith("agentx-fresh-") ? Promise.resolve({ exitCode: 125, stdout: "", stderr: "daemon text that must not be repeated" }) : base.docker.run(args, options)) };
    const fake = { docker: failing, calls: base.calls };
    const { result } = await checksRun(rootPath, fake, { freshCheckRound: () => ({ setup: [] }) });
    expect(result.checks!.checks[0]).toMatchObject({ after: "not_run" });
    expect(result.checks!.checks[0]!.output).toContain("not run: the fresh check sandbox could not start");
    expect(result.checks!.checks[0]!.output).not.toContain("daemon text");
    expect(execsWith(base.calls, "fresh-wiring-marker")).toEqual([]);
  });

  it("gate on with files the agent changed after the commit: the tree is not the committed one, so the round is 'not run'", async () => {
    const rootPath = await workspace();
    await writeFile(join(rootPath, "app/src/a.ts"), "export const a = 2; // edited after the commit\n");
    const fake = fakeDocker();
    const { result } = await checksRun(rootPath, fake, { freshCheckRound: () => ({ setup: [] }) });
    expect(result.checks!.checks[0]).toMatchObject({ after: "not_run" });
    expect(result.checks!.checks[0]!.output).toContain("not run: the fresh check sandbox could not start");
    expect(execsWith(fake.calls, "fresh-wiring-marker")).toEqual([]);
  });

  it("a dev-container-less local shell is never moved: with the gate on and no sandbox the round is today's", async () => {
    const rootPath = await workspace();
    const fake = fakeDocker();
    const ran: ProjectCommand[] = [];
    const { result } = await checksRun(rootPath, fake, { taskShell: { kind: "local" }, freshCheckRound: () => ({ setup: [] }),
      checkRunners: { runProjectCommand: (command) => { ran.push(command); return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }); }, runAgentCommand: () => Promise.reject(new Error("no")) } });
    expect(result.checks!.status).toBe("verified");
    expect(ran).toHaveLength(1);
    expect(fake.calls).toEqual([]);
  });
});

describe("H1c: the fresh round's evidence comes from its export", () => {
  const report = (name: string) => JSON.stringify({ testResults: [{ name: "/w/src/a.test.ts", status: "passed", assertionResults: [{ fullName: name, status: "passed", duration: 3 }] }] });
  it("reads the test report the check wrote in the export, ignores a report written into the working tree during the round, and removes the export afterwards", async () => {
    const rootPath = await workspace();
    const fake = fakeDocker(() => 0, (text, calls) => {
      if (!text.includes("fresh-wiring-marker")) return;
      const fresh = calls.find((args) => args[0] === "run" && args[args.indexOf("--name") + 1]!.startsWith("agentx-fresh-"))!;
      const exportDirectory = fresh[fresh.indexOf("--volume") + 1]!.split(":")[0]!;
      // the check wrote its report in the fresh sandbox (the export); the agent's leftover program wrote another into the working tree
      writeFileSync(join(exportDirectory, "app", "report.json"), report("from-the-export works"));
      writeFileSync(join(rootPath, "app", "report.json"), report("planted-in-the-working-tree works"));
    });
    const { artifacts } = await checksRun(rootPath, fake, { freshCheckRound: () => ({ setup: [] }), evidenceCapture: true, stopBeforeReading: { stopWorkspaceProcesses: () => Promise.resolve() } });
    const raw = artifacts.find((artifact) => artifact.name === "evidence-raw.json");
    expect(raw).toBeDefined();
    expect(raw!.content).toContain("from-the-export");
    expect(raw!.content).not.toContain("planted-in-the-working-tree");
    // the working sandbox is quieted again before the scanner baseline runs there (once for the round, once for the baseline)
    expect(fake.calls.filter((args) => args[0] === "exec" && args.join(" ").includes("REMAINING:"))).toHaveLength(2);
    const parent = join(rootPath, ".agentx", "fresh-check");
    expect(existsSync(parent) ? readdirSync(parent).filter((name) => name !== "scratch") : []).toEqual([]);
  });
  it("a fresh round whose container could not be removed has no export to read: no evidence is claimed, and the working tree is NOT read instead", async () => {
    const rootPath = await workspace();
    const base = fakeDocker(() => 0, (text) => { if (text.includes("fresh-wiring-marker")) writeFileSync(join(rootPath, "app", "report.json"), report("planted-in-the-working-tree works")); });
    const stuck: DockerCli = { run: (args, options) => (args[0] === "rm" && args.some((arg) => arg.startsWith("agentx-fresh-")) ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "busy" }) : base.docker.run(args, options)) };
    const { artifacts } = await checksRun(rootPath, { docker: stuck, calls: base.calls }, { freshCheckRound: () => ({ setup: [] }), evidenceCapture: true, stopBeforeReading: { stopWorkspaceProcesses: () => Promise.resolve() } });
    expect(artifacts.find((artifact) => artifact.name === "evidence-raw.json")).toBeUndefined();
  });
  it("a run that asked for no evidence keeps no export (it is removed with the sandbox)", async () => {
    const rootPath = await workspace();
    await checksRun(rootPath, fakeDocker(), { freshCheckRound: () => ({ setup: [] }), stopBeforeReading: { stopWorkspaceProcesses: () => Promise.resolve() } });
    const parent = join(rootPath, ".agentx", "fresh-check");
    expect(existsSync(parent) ? readdirSync(parent).filter((name) => name !== "scratch") : []).toEqual([]);
  });
  it("the same run with the gate off reads the working tree, as always", async () => {
    const rootPath = await workspace();
    const fake = fakeDocker(() => 0, (text) => { if (text.includes("fresh-wiring-marker")) writeFileSync(join(rootPath, "app", "report.json"), report("from-the-working-tree works")); });
    const { artifacts } = await checksRun(rootPath, fake, { evidenceCapture: true, stopBeforeReading: { stopWorkspaceProcesses: () => Promise.resolve() } });
    expect(artifacts.find((artifact) => artifact.name === "evidence-raw.json")?.content).toContain("from-the-working-tree");
  });
});

describe("H1b: the leftover programs are stopped before the fresh round", () => {
  it("the working sandbox's stop script runs before the fresh container starts, and a sandbox that still holds programs makes the check 'not run'", async () => {
    const rootPath = await workspace();
    const fake = fakeDocker();
    await checksRun(rootPath, fake, { freshCheckRound: () => ({ setup: [] }), stopBeforeReading: { stopWorkspaceProcesses: () => Promise.resolve() } });
    const order = fake.calls.filter((args) => args[0] === "run" || (args[0] === "exec" && args.join(" ").includes("REMAINING:"))).map((args) => (args[0] === "run" ? (args[args.indexOf("--name") + 1]!.startsWith("agentx-fresh-") ? "fresh start" : "working start") : "stop programs"));
    expect(order).toEqual(["working start", "stop programs", "fresh start"]);
    const refusing = fakeDocker();
    const stuck: DockerCli = { run: (args, options) => (args[0] === "exec" && args.join(" ").includes("REMAINING:") ? Promise.resolve({ exitCode: 0, stdout: "REMAINING:2\n", stderr: "" }) : refusing.docker.run(args, options)) };
    const { result } = await checksRun(await workspace(), { docker: stuck, calls: refusing.calls }, { freshCheckRound: () => ({ setup: [] }), stopBeforeReading: { stopWorkspaceProcesses: () => Promise.resolve() } });
    expect(result.checks!.checks[0]).toMatchObject({ after: "not_run" });
    expect(result.checks!.checks[0]!.output).toContain("programs the agent left running could not be stopped");
    expect(refusing.calls.some((args) => args[0] === "run" && args[args.indexOf("--name") + 1]!.startsWith("agentx-fresh-"))).toBe(false);
  });
});
