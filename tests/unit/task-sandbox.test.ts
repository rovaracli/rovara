// Ruling R56: on an EC2 worker, task-controlled code never runs in the worker's own process, network or user. It runs
// in a sandbox container with no Docker socket, no host network, no capabilities and only the workspace mounted.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TASK_SANDBOX_NETWORK,
  TaskSandbox,
  assertLocalTaskExecutionAllowed,
  taskSandboxRunArgs,
  taskShellFromEnvironment,
} from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const IMAGE = "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "a".repeat(64);
const TASK = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const EC2 = { AGENTX_WORKER_PROCESS_SCOPE: "container" };

/** A fake Docker CLI that records every call and answers like a healthy daemon. */
function fakeDocker(behaviour: { networkExists?: boolean; stale?: string[]; failRun?: string; failExec?: boolean } = {}) {
  const calls: string[][] = [];
  const docker: DockerCli = {
    run: async (args) => {
      calls.push([...args]);
      const [verb, noun] = args;
      if (verb === "network" && noun === "inspect") return { exitCode: behaviour.networkExists === true ? 0 : 1, stdout: "", stderr: "" };
      if (verb === "ps") return { exitCode: 0, stdout: (behaviour.stale ?? []).join("\n"), stderr: "" };
      if (verb === "run" && behaviour.failRun !== undefined) return { exitCode: 125, stdout: "", stderr: behaviour.failRun };
      if (verb === "exec" && behaviour.failExec === true) return { exitCode: 1, stdout: "", stderr: "boom" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { docker, calls, verbs: (verb: string) => calls.filter((args) => args[0] === verb) };
}

describe("the task sandbox's docker run arguments (R56)", () => {
  const args = taskSandboxRunArgs({ name: "agentx-task-x", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] });

  it("carry every R56 flag", () => {
    expect(args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000"]));
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args[args.indexOf("--network") + 1]).toBe(TASK_SANDBOX_NETWORK);
    expect(TASK_SANDBOX_NETWORK).toBe("agentx-task");
  });

  it("mount only the workspace, and never the Docker socket, the host network or privileges", () => {
    const joined = args.join(" ");
    expect(args.filter((arg) => arg === "--volume")).toHaveLength(1);
    expect(args[args.indexOf("--volume") + 1]).toBe("/mnt/workspace:/mnt/workspace");
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain("/var/run");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("host");
    expect(joined).not.toMatch(/--network[ =]host|--net[ =]host|--pid|--ipc|--userns|--uts|--device|--cap-add|--volumes-from|--add-host/);
  });

  it("label the container with the task and start the image's own init with nothing to run", () => {
    expect(args[args.indexOf("--label") + 1]).toBe(`agentx.task=${TASK}`);
    expect(args[args.indexOf("--name") + 1]).toBe("agentx-task-x");
    expect(args.slice(args.indexOf(IMAGE) - 2)).toEqual(["--entrypoint", "/usr/bin/tini", IMAGE, "--", "sleep", "infinity"]);
  });

  it("hide the workspace volume's Docker data and verifier runtime behind empty tmpfs mounts", () => {
    const masked = taskSandboxRunArgs({ name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: ["/mnt/workspace/.docker", "/mnt/workspace/.agentx-runtime"] });
    const tmpfs = masked.flatMap((arg, index) => (arg === "--tmpfs" ? [masked[index + 1]] : []));
    expect(tmpfs).toEqual([
      "/mnt/workspace/.docker:ro,noexec,nosuid,size=4k",
      "/mnt/workspace/.agentx-runtime:ro,noexec,nosuid,size=4k",
    ]);
  });
});

describe("starting and stopping a sandbox", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  const workspace = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-")));
    cleanup.push(root);
    return root;
  };

  it("creates the agentx-task bridge network when it is missing, and leaves an existing one alone", async () => {
    const root = await workspace();
    const missing = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: missing.docker, image: IMAGE }).start();
    expect(missing.calls).toContainEqual(["network", "create", "--driver", "bridge", TASK_SANDBOX_NETWORK]);

    const present = fakeDocker({ networkExists: true });
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: present.docker, image: IMAGE }).start();
    expect(present.verbs("network").map((call) => call[1])).toEqual(["inspect"]);
  });

  it("accepts a network that another start created in between", async () => {
    const root = await workspace();
    const calls: string[][] = [];
    let inspections = 0;
    const docker: DockerCli = {
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "inspect") return { exitCode: ++inspections === 1 ? 1 : 0, stdout: "", stderr: "" };
        if (args[0] === "network" && args[1] === "create") return { exitCode: 1, stdout: "", stderr: "network with name agentx-task already exists" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await expect(new TaskSandbox({ rootPath: root, taskId: TASK, docker, image: IMAGE }).start()).resolves.toBeUndefined();
  });

  it("starts once however many commands run, and runs them with docker exec in that container", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE });
    await sandbox.exec(["bash", "-c", "true"], { env: { PI_X: "1" } });
    await sandbox.exec(["bash", "-c", "true"], {});
    expect(fake.verbs("run")).toHaveLength(1);
    const exec = fake.verbs("exec");
    expect(exec).toHaveLength(2);
    expect(exec[0]).toEqual(["exec", "--env", "PI_X=1", sandbox.name, "bash", "-c", "true"]);
    expect(sandbox.name).toMatch(/^agentx-task-0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11-[0-9a-f]{8}$/u);
  });

  it("removes containers an earlier worker process left behind, by label, before it starts", async () => {
    const root = await workspace();
    const fake = fakeDocker({ stale: ["abc123", "def456"] });
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }).start();
    expect(fake.calls).toContainEqual(["ps", "--all", "--quiet", "--filter", "label=agentx.task"]);
    expect(fake.calls).toContainEqual(["rm", "--force", "abc123", "def456"]);
    const order = fake.calls.map((args) => args[0]);
    expect(order.indexOf("rm")).toBeLessThan(order.indexOf("run"));
  });

  it("masks .docker and .agentx-runtime only where they exist in the workspace", async () => {
    const root = await workspace();
    await mkdir(join(root, ".docker"));
    const fake = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }).start();
    const run = fake.verbs("run")[0]!;
    const tmpfs = run.flatMap((arg, index) => (arg === "--tmpfs" ? [run[index + 1]] : []));
    expect(tmpfs).toEqual([`${root}/.docker:ro,noexec,nosuid,size=4k`]);
  });

  it("removes the container when it is disposed, and does nothing when nothing was started", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }).dispose();
    expect(fake.calls).toEqual([]);
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE });
    await sandbox.exec(["true"], {});
    await sandbox.dispose();
    expect(fake.verbs("rm").at(-1)).toEqual(["rm", "--force", sandbox.name]);
    await sandbox.dispose();
    expect(fake.verbs("rm").filter((call) => call.includes(sandbox.name))).toHaveLength(1);
    await expect(sandbox.exec(["true"], {})).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("removes the container even when docker run failed part-way, and reports why it failed", async () => {
    const root = await workspace();
    const fake = fakeDocker({ failRun: "Error response from daemon: pull access denied" });
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE });
    await expect(sandbox.start()).rejects.toThrow(/could not start the task sandbox.*pull access denied/su);
    await expect(sandbox.exec(["true"], {})).rejects.toThrow(/could not start the task sandbox/u);
    expect(fake.verbs("run")).toHaveLength(1);
    await sandbox.dispose();
    expect(fake.verbs("rm").at(-1)).toEqual(["rm", "--force", sandbox.name]);
  });

  it("is unavailable, not local, when no sandbox image is configured", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, environment: {} });
    await expect(sandbox.start()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(fake.calls).toEqual([]);
  });

  it("reads the image from AGENTX_SANDBOX_IMAGE", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, environment: { AGENTX_SANDBOX_IMAGE: IMAGE } }).start();
    expect(fake.verbs("run")[0]).toContain(IMAGE);
  });
});

describe("where the local shell may run (R56)", () => {
  it("is refused on the EC2 runtime, whatever asks for it", () => {
    expect(() => assertLocalTaskExecutionAllowed(EC2)).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    expect(() => taskShellFromEnvironment({ ...EC2, AGENTX_TASK_SHELL: "local" })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });

  it("selects the sandbox on the EC2 runtime", () => {
    expect(taskShellFromEnvironment(EC2)).toBe("sandbox");
    expect(taskShellFromEnvironment({ ...EC2, AGENTX_TASK_SHELL: "sandbox" })).toBe("sandbox");
  });

  it("allows the local shell off EC2, and the sandbox when asked for", () => {
    expect(() => assertLocalTaskExecutionAllowed({})).not.toThrow();
    expect(taskShellFromEnvironment({})).toBe("local");
    expect(taskShellFromEnvironment({ AGENTX_TASK_SHELL: "local" })).toBe("local");
    expect(taskShellFromEnvironment({ AGENTX_TASK_SHELL: "sandbox" })).toBe("sandbox");
  });

  it("refuses a value it does not know", () => {
    expect(() => taskShellFromEnvironment({ AGENTX_TASK_SHELL: "host" })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
