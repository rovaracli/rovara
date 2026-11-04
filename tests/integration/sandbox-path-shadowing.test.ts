// C67: the Python user site's bin is first on a sandbox command's PATH (Bug K: pip --user installs of pytest and ruff must be found). It is a folder the task controls, so a program
// planted there must shadow tools for the task's own command only. The wrapper AgentX runs around the command (it records the process group and removes its file with `rm`) must
// not resolve its own tools through that PATH.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { SANDBOX_PYTHON_USER_BASE_DIRECTORY, TaskSandbox } from "../../packages/worker/src/task-sandbox.js";

const IMAGE = "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "d".repeat(64);
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A Docker CLI whose container is this machine: `docker exec` runs the command here, with the `--env` pairs and the host's PATH. */
function localContainer(): DockerCli {
  return {
    run: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "bridge {} false", stderr: "" };
      if (args[0] !== "exec") return { exitCode: 0, stdout: "", stderr: "" };
      const flags: Record<string, string> = {};
      let index = 1;
      while (args[index] === "--env") {
        const [name, ...value] = args[index + 1]!.split("=");
        flags[name!] = value.join("=");
        index += 2;
      }
      const command = args.slice(index + 1);
      return await new Promise((resolve) => {
        const child = spawn(command[0]!, command.slice(1), { env: { PATH: process.env["PATH"] ?? "", ...flags }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", (error) => resolve({ exitCode: -1, stdout, stderr: `${stderr}${error.message}` }));
        child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
      });
    },
  };
}

async function started(): Promise<{ root: string; sandbox: TaskSandbox; marker: string; plant(name: string): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-path-shadow-")));
  cleanup.push(root);
  await mkdir(join(root, "repo"), { recursive: true });
  const sandbox = new TaskSandbox({ rootPath: root, taskId: "path-shadow", docker: localContainer(), image: IMAGE });
  await sandbox.start();
  const marker = join(root, "shadow-ran.marker");
  return {
    root, sandbox, marker,
    // A program of the task's own, put where the sandbox looks first.
    async plant(name) {
      const path = join(root, SANDBOX_PYTHON_USER_BASE_DIRECTORY, "bin", name);
      await mkdir(join(root, SANDBOX_PYTHON_USER_BASE_DIRECTORY, "bin"), { recursive: true });
      await writeFile(path, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(path, 0o755);
    },
  };
}

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const exits = (executable: string, args: string[]) => ({ cwd: "repo", executable, args, timeoutSeconds: 20 });

describe("C67: a program in the Python user site's bin does not shadow what AgentX's own wrapper calls", () => {
  it("positive control: the planted program is first on PATH for the task's own command, as Bug K needs", async () => {
    const box = await started();
    await box.plant("rm");
    const result = await box.sandbox.runCommand(exits("rm", ["-f", join(box.root, "nothing")]));
    expect(result.exitCode).toBe(0);
    expect(await exists(box.marker)).toBe(true);
  });

  it("a planted rm does not run in the wrapper of a project command (setup, readiness)", async () => {
    const box = await started();
    await box.plant("rm");
    const result = await box.sandbox.runCommand(exits("sh", ["-c", "exit 0"]));
    expect(result.exitCode).toBe(0);
    expect(await exists(box.marker)).toBe(false);
  });

  it("a planted rm does not run in the wrapper of the agent's shell", async () => {
    const box = await started();
    await box.plant("rm");
    const output: string[] = [];
    const result = await box.sandbox.bashOperations().exec("exit 0", join(box.root, "repo"), { onData: (data) => output.push(data.toString()), timeout: 20, env: {} });
    expect(result.exitCode).toBe(0);
    expect(await exists(box.marker)).toBe(false);
  });
});
