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

const on = (network: string, root: string): ContainerInspection => ({
  HostConfig: { NetworkMode: network },
  Mounts: [{ Type: "bind", Source: root, Destination: root }, ...[".agentx", "agent-sessions"].map((name) => ({ Type: "volume", Destination: join(root, name) }))],
});

function fakeCli(root: string, networks: string[], options: { walled?: boolean } = {}) {
  const events: string[] = [];
  const removed: string[] = [];
  let started = 0;
  const cli: DevcontainerCli = {
    run: async () => {
      started += 1;
      events.push(`up ${started}`);
      return { exitCode: 0, stdout: `{"outcome":"success","containerId":"id-${started}","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/sample"}`, stderr: "" };
    },
    ...(options.walled === false ? {} : { walledNetwork: { name: "agentx-task", ensure: async () => { events.push("ensure"); } } }),
    checks: {
      fullConfiguration: async () => ({ configuration: {}, mergedConfiguration: {} }),
      inspect: async () => on(networks.shift() ?? "bridge", root),
      remove: async (id) => { removed.push(id); },
    },
  };
  return { cli, events, removed };
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
    expect(events).toEqual(["ensure", "up 1", "up 2"]);
  });

  it("is removed and refused when the second start is still not on the network (nothing else cures it)", async () => {
    const target = await workspace();
    const { cli, removed } = fakeCli(target.rootPath, ["bridge", "bridge"]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/does not wall/u) });
    expect(removed).toEqual(["id-1", "id-2"]);
  });

  it("refuses a runArgs network before anything starts, because it would override the walled one", async () => {
    const target = await workspace('{ "image": "node:22", "runArgs": ["--network=bridge"] }\n');
    const { cli, events } = fakeCli(target.rootPath, ["agentx-task"]);
    await expect(ensureDevcontainer(cli, target)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/--network/u) });
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
