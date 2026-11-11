// TASK-BRIDGE-UNWALLED: on an EC2 worker a dev container joins the walled task network (the one with the rvbtask interface the boot firewall walls), never the default bridge docker0.
// The network is made (or made again) before the start, the container is checked on it after, and one that is not on it is created again once, then refused.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDevcontainerCli, ensureDevcontainer, type DevcontainerCli, type DevcontainerTarget } from "../../packages/worker/src/devcontainer.js";
import type { ContainerInspection } from "../../packages/worker/src/devcontainer-policy.js";

async function workspace(config = '{ "image": "node:22" }\n'): Promise<DevcontainerTarget> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-walled-net-")));
  await mkdir(join(root, "repo/sample/.devcontainer"), { recursive: true });
  await writeFile(join(root, "repo/sample/.devcontainer/devcontainer.json"), config, "utf8");
  return { rootPath: root, workspaceFolder: join(root, "repo/sample"), configPath: join(root, "repo/sample/.devcontainer/devcontainer.json") };
}

interface Shape { networks?: string[]; capDrop?: string[] | null }
/** What `docker inspect` gives for a dev container: its network mode, the networks it is attached to, what it dropped, and the workspace mounts a start gives it. */
const on = (network: string, root: string, shape: Shape = {}): ContainerInspection => ({
  HostConfig: { NetworkMode: network, CapDrop: shape.capDrop === undefined ? ["NET_RAW"] : shape.capDrop },
  NetworkSettings: { Networks: Object.fromEntries((shape.networks ?? [network]).map((name) => [name, {}])) },
  Mounts: [{ Type: "bind", Source: root, Destination: root }, ...[".agentx", "agent-sessions"].map((name) => ({ Type: "volume", Destination: join(root, name) }))],
});

/** `containers` answers `inspect` in turn for what `up` started; `existing` are the containers the CLI would reuse, by id, with their shape. */
function fakeCli(root: string, containers: Array<string | { network: string; shape: Shape }>, options: { walled?: boolean; existing?: Record<string, { network: string; shape?: Shape }> } = {}) {
  const events: string[] = [];
  const removed: string[] = [];
  const upArgs: string[][] = [];
  const queue = [...containers];
  let started = 0;
  const cli: DevcontainerCli = {
    run: async (args) => {
      started += 1;
      upArgs.push([...args]);
      events.push(`up ${started}`);
      return { exitCode: 0, stdout: `{"outcome":"success","containerId":"id-${started}","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/sample"}`, stderr: "" };
    },
    ...(options.walled === false ? {} : { walledNetwork: { name: "agentx-task", ensure: async () => { events.push("ensure"); } } }),
    checks: {
      fullConfiguration: async () => ({ configuration: {}, mergedConfiguration: {} }),
      inspect: async (id) => {
        const old = options.existing?.[id];
        if (old !== undefined) return on(old.network, root, old.shape);
        const next = queue.shift() ?? "bridge";
        return typeof next === "string" ? on(next, root) : on(next.network, root, next.shape);
      },
      remove: async (id) => { removed.push(id); events.push(`remove ${id}`); },
      ...(options.existing === undefined ? {} : { listExisting: async () => Object.keys(options.existing!) }),
    },
  };
  return { cli, events, removed, upArgs };
}

describe("a dev container on an EC2 worker", () => {
  it("has its network made before it starts, and starts once when it is on that network", async () => {
    const target = await workspace();
    const { cli, events, removed } = fakeCli(target.rootPath, ["agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-1" });
    expect(events).toEqual(["ensure", "up 1"]);
    expect(removed).toEqual([]);
  });

  it("is created again when a stopped container of an earlier release was on the default bridge", async () => {
    const target = await workspace();
    const { cli, events, removed } = fakeCli(target.rootPath, ["bridge", "agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-2" });
    expect(removed).toEqual(["id-1"]);
    expect(events).toEqual(["ensure", "up 1", "remove id-1", "up 2"]);
  });

  it("is removed and refused when the second start is still not on the network (nothing else cures it)", async () => {
    const target = await workspace();
    const { cli, removed } = fakeCli(target.rootPath, ["bridge", "bridge"]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/does not wall/u) as string });
    expect(removed).toEqual(["id-1", "id-2"]);
  });

  it("is created again when it is attached to a second network too, or kept NET_RAW (a stopped container of an earlier release has both faults)", async () => {
    for (const bad of [{ network: "agentx-task", shape: { networks: ["agentx-task", "bridge"] } }, { network: "agentx-task", shape: { capDrop: null } }, { network: "bridge", shape: { capDrop: null } }]) {
      const target = await workspace();
      const { cli, removed } = fakeCli(target.rootPath, [bad, "agentx-task"]);
      await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-2" });
      expect(removed, JSON.stringify(bad)).toEqual(["id-1"]);
    }
  });

  it("removes a stopped container of an earlier release (on docker0, or with NET_RAW) BEFORE `up`, so its start commands never run unwalled, and leaves a walled one alone", async () => {
    const target = await workspace();
    const { cli, events, removed } = fakeCli(target.rootPath, ["agentx-task"], { existing: { old: { network: "bridge" }, noRaw: { network: "agentx-task", shape: { capDrop: [] } }, good: { network: "agentx-task" } } });
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-1" });
    expect(removed).toEqual(["old", "noRaw"]);
    expect(events).toEqual(["ensure", "remove old", "remove noRaw", "up 1"]);
  });

  it("builds with the classic builder only on a walled worker (--buildkit never), because only it can put build containers on the walled network", async () => {
    const walledTarget = await workspace();
    const walled = fakeCli(walledTarget.rootPath, ["agentx-task"]);
    await ensureDevcontainer(walled.cli, walledTarget);
    expect(walled.upArgs[0]!.join(" ")).toContain("--buildkit never");
    const plainTarget = await workspace();
    const plain = fakeCli(plainTarget.rootPath, ["my-net"], { walled: false });
    await ensureDevcontainer(plain.cli, plainTarget);
    expect(plain.upArgs[0]).not.toContain("--buildkit");
  });

  it("refuses a build.options network before anything starts", async () => {
    const target = await workspace('{ "build": { "dockerfile": "Dockerfile", "options": ["--network=host"] } }\n');
    const { cli, events } = fakeCli(target.rootPath, ["agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/build\.options --network/u) as string });
    expect(events).toEqual([]);
  });

  it("refuses a runArgs network before anything starts, because it would override the walled one", async () => {
    const target = await workspace('{ "image": "node:22", "runArgs": ["--network=bridge"] }\n');
    const { cli, events } = fakeCli(target.rootPath, ["agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/--network/u) as string });
    expect(events).toEqual([]);
  });

  it("is not checked for a network, and its runArgs network is allowed, where nothing is walled (a developer's machine)", async () => {
    const target = await workspace('{ "image": "node:22", "runArgs": ["--network=my-net"] }\n');
    const { cli, events, removed } = fakeCli(target.rootPath, ["my-net"], { walled: false });
    await expect(ensureDevcontainer(cli, target)).resolves.toMatchObject({ containerId: "id-1" });
    expect(events).toEqual(["up 1"]);
    expect(removed).toEqual([]);
  });
});

describe("createDevcontainerCli", () => {
  it("is walled on an EC2 worker, by either marker, and not elsewhere", () => {
    const wrapper = new URL("../../packages/worker/ec2/docker-walled.sh", import.meta.url).pathname;
    for (const environment of [{ AGENTX_RUNTIME: "ec2" }, { AGENTX_WORKER_PROCESS_SCOPE: "container" }]) {
      expect(createDevcontainerCli({ environment: { ...environment, AGENTX_WALLED_DOCKER: wrapper } }).walledNetwork?.name).toBe("agentx-task");
    }
    expect(createDevcontainerCli({ environment: {} }).walledNetwork).toBeUndefined();
    expect(createDevcontainerCli({ environment: { AGENTX_RUNTIME: "ec2" }, walled: false }).walledNetwork).toBeUndefined();
  });

  it("fails closed when the image has no wrapper, instead of starting dev containers on the default bridge", () => {
    expect(() => createDevcontainerCli({ environment: { AGENTX_RUNTIME: "ec2", AGENTX_WALLED_DOCKER: "/nonexistent/docker-walled.sh" } })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });
});
