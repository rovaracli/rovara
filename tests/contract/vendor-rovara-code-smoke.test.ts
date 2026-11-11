import { describe, expect, it } from "vitest";
import * as cloudContracts from "@agentx/contracts";
import { estimateRun, planRunLimit } from "@rovara-code/broker/core/cost";
import { DEFAULT_RUN_ESTIMATE_USD, ESTIMATE_MIN_SAMPLES, ROVARA_CODE_AGENT_ID, formatRunLimitUsd, type RunEstimate } from "@rovara-code/contracts";
import * as codeContracts from "@rovara-code/contracts";

// Convergence plan W0-1: Cloud code CAN import Rovara Code through the `@rovara-code/*` shims over vendor/rovara-code (vendor/README.md), with no behaviour change.
// This is the only importer. It uses one Code contract value and type and one Code core function (the run-cost estimate), and checks that Code's files
// resolved Code's own contracts and not Cloud's package of the same name.
const ORG = `org_${"a".repeat(20)}`;

describe("Cloud code importing the pinned copy of Rovara Code", () => {
  it("runs a Code core function against a Code contract type, with the default estimate when there is no history", async () => {
    const store = { query: () => Promise.resolve({ items: [] }) };
    const estimate: RunEstimate = await estimateRun({ store }, { orgId: ORG, project: "example", agentId: ROVARA_CODE_AGENT_ID, path: "TASK" });
    expect(estimate).toMatchObject({ basis: "default", samples: 0, lowUsd: DEFAULT_RUN_ESTIMATE_USD.TASK.lowUsd, highUsd: DEFAULT_RUN_ESTIMATE_USD.TASK.highUsd });
  });

  it("works the estimate from history the way Code does, and plans the run limit from it", async () => {
    const items = Array.from({ length: ESTIMATE_MIN_SAMPLES }, () => ({ costUsd: 1.2 }));
    const store = { query: () => Promise.resolve({ items }) };
    const estimate = await estimateRun({ store }, { orgId: ORG, project: "example", agentId: ROVARA_CODE_AGENT_ID, path: "FULL" });
    expect(estimate).toMatchObject({ basis: "history", samples: ESTIMATE_MIN_SAMPLES, lowUsd: 1.5, highUsd: 1.5 });
    await expect(planRunLimit({ store }, { orgId: ORG, project: "example", requestedRunLimitUsd: 1 })).resolves.toBe(1);
    expect(formatRunLimitUsd(2.5)).toBe("$2.50");
  });

  it("resolves Code's own @agentx/contracts inside the vendored files, not Cloud's package of that name", () => {
    // Both packages export `parseAgentId`-style helpers under the same names; the same name must not be the same function.
    const shared = Object.keys(codeContracts).filter((name) => typeof (codeContracts as Record<string, unknown>)[name] === "function" && typeof (cloudContracts as Record<string, unknown>)[name] === "function");
    expect(shared.length).toBeGreaterThan(10);
    const different = shared.filter((name) => (codeContracts as Record<string, unknown>)[name] !== (cloudContracts as Record<string, unknown>)[name]);
    expect(different.length).toBe(shared.length);
  });
});
