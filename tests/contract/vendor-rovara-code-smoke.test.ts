import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as cloudNames from "@agentx/cloud-contracts";
import { allContracts as cloudContracts } from "../support/contracts-barrels.js";
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

  it("resolves Code's own @agentx/contracts inside the vendored files, and Cloud has no package of that name any more", () => {
    // W0-3 renamed Cloud's contracts to @agentx/cloud-contracts, so the name belongs to the vendored Code alone (vendor/node_modules links it). A root link of that name would put Cloud's
    // workspace back in the way of Code's own imports.
    expect(existsSync("node_modules/@agentx/contracts")).toBe(false);
    expect(existsSync("node_modules/@agentx/cloud-contracts")).toBe(true);
    // Where Cloud still defines a name Code also defines (the owed-upstream list), the two are different functions: Code's files ran against Code's.
    const shared = Object.keys(codeContracts).filter((name) => typeof (codeContracts as Record<string, unknown>)[name] === "function" && typeof (cloudContracts as Record<string, unknown>)[name] === "function");
    expect(shared.length).toBeGreaterThan(10);
    const cloudDefined = Object.keys(cloudNames).filter((name) => typeof (cloudNames as Record<string, unknown>)[name] === "function" && typeof (codeContracts as Record<string, unknown>)[name] === "function");
    expect(cloudDefined.filter((name) => (cloudNames as Record<string, unknown>)[name] === (codeContracts as Record<string, unknown>)[name])).toEqual([]);
  });
});
