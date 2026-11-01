// The commit a pull request's base branch is at now (Plan 6 Task 17: the branch-sync start reads it, and a merge of the base takes that commit). The base is an ordinary branch, but GitHub's
// `getBranchHead` answers for Rovara's own `agentx/<uuid>` branches only and refuses any other name ("branch name is invalid"), so reading `main` that way failed every branch-sync start on real
// GitHub. The stand-ins below enforce the provider's two rules as github-app.ts states them (getBranchHead :1500, getDefaultBranchHead :1521), so the old call fails here.
import { describe, expect, it, vi } from "vitest";
import { GitBranchNameSchema, agentXError } from "@agentx/contracts";
import { currentBaseCommitOf } from "../../packages/broker/src/aws/broker/dispatch.js";
import { NO_HOST_MESSAGE } from "../../packages/broker/src/plugins/registry.js";
import { TEST_ORG } from "../support/orgs.js";
import { pullRequestDetails } from "../support/p5-world.js";
import { GITHUB_URL, SCOPE, refusal, world } from "../support/p5-host-world.js";

const BASE_HEAD = "a".repeat(40);

function baseWorld(baseBranch: string) {
  const getBranchHead = vi.fn(async (_url: string, branch: string) => {
    if (!/^agentx\/[0-9a-f-]{36}$/iu.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    return "c".repeat(40);
  });
  const getDefaultBranchHead = vi.fn(async (_url: string, branch: string) => {
    if (!GitBranchNameSchema.safeParse(branch).success) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    return BASE_HEAD;
  });
  const w = world({ github: { getBranchHead, getDefaultBranchHead, getPullRequest: vi.fn(async (_url: string, number: number) => pullRequestDetails(number, { baseBranch })) } });
  const target = { ...(w.db.get("DEVTASK#11111111-1111-4111-8111-111111111111", "META") as object), orgId: TEST_ORG, project: "demo", startingRevision: 1 } as never;
  return { ...w, target, getBranchHead, getDefaultBranchHead };
}

describe("the commit a pull request's base branch is at", () => {
  it.each(["main", "release/2026-11"])("is read for the base branch %s with the default-branch read, not the agentx-only one", async (base) => {
    const t = baseWorld(base);
    await expect(currentBaseCommitOf(t.dependencies)(t.target, { repositoryId: "web", number: 7 })).resolves.toBe(BASE_HEAD);
    expect(t.getDefaultBranchHead).toHaveBeenCalledWith(GITHUB_URL, base, SCOPE);
    expect(t.getBranchHead).not.toHaveBeenCalled();
  });

  // Replaces (P6): "is refused for a repository on another host (GITHUB_ONLY_MESSAGE)". The base branch's head is the port's now (`baseBranchHead`).
  it.each(["main", "release/2026-11"])("is read from the host a repository on another registered host names (base %s), and GitHub is never asked", async (base) => {
    const t = baseWorld("main");
    t.model.commit(base, { "base.txt": base });
    t.model.commit("rovara/x", { "a.txt": "1" });
    const { cr } = t.model.reconcile({ sourceBranch: "rovara/x", targetBranch: base, title: "t" });
    await expect(currentBaseCommitOf(t.dependencies)(t.target, { repositoryId: "api", number: Number(cr.id) })).resolves.toBe(t.model.headOf(base));
    expect(t.getDefaultBranchHead).not.toHaveBeenCalled();
    expect(t.github.getPullRequest).not.toHaveBeenCalled();
  });

  it("a GitHub provider built without the default-branch read cannot say, in GitHub's words, and is not asked", async () => {
    const t = baseWorld("main");
    delete (t.github as { getDefaultBranchHead?: unknown }).getDefaultBranchHead;
    await expect(currentBaseCommitOf(t.dependencies)(t.target, { repositoryId: "web", number: 7 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("GitHub cannot say what the base branch is at") as unknown });
  });

  it("is refused for an unknown host kind with the router's sentence, before the pull request is read", async () => {
    const t = baseWorld("main");
    await expect(currentBaseCommitOf(t.dependencies)(t.target, { repositoryId: "mystery", number: 7 })).rejects.toThrow(refusal(NO_HOST_MESSAGE));
    expect(t.getDefaultBranchHead).not.toHaveBeenCalled();
    expect(t.github.getPullRequest).not.toHaveBeenCalled();
  });
});
