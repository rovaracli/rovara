// Enterprise foundations P9: trackers in the plug-in registry. Linear is the install's own; any other tracker is an Enterprise plug-in; a kind with no tracker is refused with a fixed
// sentence, and nothing falls back to another tracker.
import { describe, expect, it } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FAKE_TRACKER_KIND, FakeTracker } from "../../packages/broker/src/plugins/fake/tracker.js";
import { NO_TRACKER_MESSAGE, createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { linearTracker } from "../../packages/broker/src/plugins/tracker/linear/index.js";
import { newModel } from "./fake-worlds.js";

const github = () => Object.assign(new FakeCodeHost(newModel()), { kind: "github" });
const thrown = (run: () => unknown): { code?: string; message: string } | undefined => {
  try { run(); } catch (error) { return error as { code?: string; message: string }; }
  return undefined;
};

describe("trackers in the registry", () => {
  it("looks a tracker up by kind; Linear is built in for every edition and for an install with no edition", () => {
    const linear = linearTracker();
    for (const policy of [undefined, editionPolicy("public"), editionPolicy("enterprise")]) {
      const registry = createPluginRegistry({ codeHosts: [github()], checkRunners: [], trackers: [linear], ...(policy === undefined ? {} : { policy }) });
      expect(registry.tracker("linear")).toBe(linear);
      expect(registry.trackerKinds()).toEqual(["linear"]);
    }
  });

  it("a registry with no trackers has none, and an unknown kind is refused with a fixed sentence that does not echo the kind", () => {
    const registry = createPluginRegistry({ codeHosts: [github()], checkRunners: [] });
    expect(registry.trackerKinds()).toEqual([]);
    const failure = thrown(() => registry.tracker("jira"));
    expect(failure?.code).toBe("CONFIG_INVALID");
    expect(failure?.message).toContain(NO_TRACKER_MESSAGE);
    expect(failure?.message).not.toContain("jira");
  });

  it("a tracker other than Linear needs the Enterprise edition: Public and an install with no edition refuse it", () => {
    const custom = new FakeTracker();
    for (const policy of [editionPolicy("public"), undefined]) {
      expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: [], trackers: [custom], ...(policy === undefined ? {} : { policy }) }))?.code, String(policy?.edition)).toBe("FORBIDDEN");
    }
    const registry = createPluginRegistry({ codeHosts: [github()], checkRunners: [], trackers: [linearTracker(), custom], policy: editionPolicy("enterprise") });
    expect(registry.trackerKinds()).toEqual([FAKE_TRACKER_KIND, "linear"]);
    expect(registry.tracker(FAKE_TRACKER_KIND)).toBe(custom);
  });

  it("refuses the same kind twice and a kind that is not a plug-in name", () => {
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: [], trackers: [linearTracker(), linearTracker()] }))?.code).toBe("CONFIG_INVALID");
    expect(thrown(() => createPluginRegistry({ codeHosts: [github()], checkRunners: [], trackers: [Object.assign(new FakeTracker(), { kind: "Bad Kind" })], policy: editionPolicy("enterprise") }))?.code).toBe("CONFIG_INVALID");
  });
});
