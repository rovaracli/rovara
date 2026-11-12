// Owner decision 123 (review L1): the worker turns the host wall's pinned name=address pairs into `--add-host` arguments for every task sandbox, and logs the step's counts; anything out of form gives nothing.
import { describe, expect, it } from "vitest";
import { privateAddressFacts, privateAddressHostArgs } from "../../packages/worker/src/private-address-hosts.js";
import { taskSandboxRunArgs } from "../../packages/worker/src/task-sandbox.js";

const PINS = "nexus.corp.example=10.60.0.7,nexus.corp.example=10.60.0.8";

describe("the pinned internal names", () => {
  it("become --add-host arguments only in their one written form", () => {
    expect(privateAddressHostArgs({ AGENTX_PRIVATE_ADDRESS_HOSTS: PINS })).toEqual(["--add-host", "nexus.corp.example:10.60.0.7", "--add-host", "nexus.corp.example:10.60.0.8"]);
    for (const bad of [undefined, "", "nexus.corp.example=10.60.0.7 --privileged", "nexus=10.0.0.1", "nexus.corp.example=10.0.0.256", "nexus.corp.example=999.1.1.1", "-x.corp=10.0.0.1", "a.b=1.2.3.4,"]) {
      expect(privateAddressHostArgs(bad === undefined ? {} : { AGENTX_PRIVATE_ADDRESS_HOSTS: bad }), String(bad)).toEqual([]);
    }
  });

  it("reach a task sandbox's docker run, before its image", () => {
    const base = { name: "s", taskId: "t", rootPath: "/mnt/workspace", maskedPaths: [], image: "img", hostCpus: 2, hostMemoryBytes: 8 * 1024 ** 3 } as const;
    const args = taskSandboxRunArgs({ ...base, environment: { AGENTX_PRIVATE_ADDRESS_HOSTS: PINS } });
    expect(args.indexOf("--add-host")).toBeGreaterThan(-1);
    expect(args.indexOf("--add-host")).toBeLessThan(args.indexOf("img"));
    expect(args.filter((arg) => arg === "--add-host")).toHaveLength(2);
    expect(taskSandboxRunArgs({ ...base, environment: {} })).not.toContain("--add-host");
  });

  it("the counts are read in their form only", () => {
    expect(privateAddressFacts({ AGENTX_PRIVATE_ADDRESS_FACTS: "entries=3,opened=2,skipped=1" })).toEqual({ entries: 3, opened: 2, skipped: 1 });
    expect(privateAddressFacts({ AGENTX_PRIVATE_ADDRESS_FACTS: "entries=3" })).toBeUndefined();
    expect(privateAddressFacts({})).toBeUndefined();
  });
});
