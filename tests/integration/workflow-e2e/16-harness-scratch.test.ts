// The E2E harness's worker reads base-commit rule files through scratch folders in the temporary directory, and sweeps old ones by the (fake) clock. Test files run side by
// side, so each harness must use a temporary directory of its own, or one file's far-ahead clock deletes a read another file has in progress.
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createWorkflowE2E } from "../../support/workflow-e2e.js";

describe("Suite 16: the E2E harness keeps its temporary files to itself", () => {
  const shared = tmpdir();

  it("16.1 a harness has its own temporary directory while its test runs, not the one other test files use", async () => {
    await createWorkflowE2E({});
    expect(tmpdir()).not.toBe(shared);
    expect(tmpdir()).toContain("agentx-e2e-tmp-");
  });

  it("16.2 the shared temporary directory is back once that test has finished", () => {
    expect(tmpdir()).toBe(shared);
  });
});
