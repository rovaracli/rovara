// Enterprise foundations P6 (register SY-3): the track record reads what a pull request merged as, and when, through the code host port, so a merged change request on ANY host gives its
// samples a merge commit and a merge time. GitHub's reads are the same provider call as before.
import { describe, expect, it, vi } from "vitest";
import { hostRateLimitRetryAt } from "../../packages/contracts/src/index.js";
import { endedPullRequestReader } from "../../packages/broker/src/aws/broker/terminal-and-github-events.js";
import { status as githubStatus } from "../support/rovara-code-tracking.js";
import { TASK, world } from "../support/p5-host-world.js";
import { pullRequestDetails } from "../support/p5-world.js";
import { TEST_ORG } from "../support/orgs.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";

const task = { taskId: TASK, orgId: TEST_ORG, project: "demo", startingRevision: 1 } as unknown as DeveloperTaskRecord;
const MERGE = "9".repeat(40);
const MERGED_AT = "2026-10-31T12:30:00.000Z";

function mergedFakePullRequest(w: ReturnType<typeof world>) {
  w.model.commit("rovara/x", { "a.txt": "1" });
  const { cr } = w.model.reconcile({ sourceBranch: "rovara/x", targetBranch: "main", title: "t" });
  const merged = w.model.merge(cr.id, { revision: w.model.headRevisionOf(cr), method: "merge" });
  return { cr, merged };
}

describe("P6: the merge commit and time of a merged change request, from its own host", () => {
  it("a merged change request on the fake host gives its merge commit and time", async () => {
    const w = world();
    const { cr, merged } = mergedFakePullRequest(w);
    const read = await endedPullRequestReader(w.dependencies, task)!("api", Number(cr.id));
    expect(read.status.state).toBe("merged");
    expect(read.mergeCommit).toBe(merged.outcome === "merged" ? merged.mergeRevision : "x");
    expect(read.mergedAt).toBe(cr.mergedAt);
    expect(Number.isFinite(Date.parse(read.mergedAt ?? ""))).toBe(true);
    // GitHub was not asked about a repository on another host.
    expect(w.github.getPullRequestStatus).not.toHaveBeenCalled();
  });

  it("an open change request reads no merge observation", async () => {
    const w = world();
    w.model.commit("rovara/x", { "a.txt": "1" });
    const { cr } = w.model.reconcile({ sourceBranch: "rovara/x", targetBranch: "main", title: "t" });
    const observe = vi.spyOn(w.fakeHost, "mergeObservation");
    const read = await endedPullRequestReader(w.dependencies, task)!("api", Number(cr.id));
    expect(read.mergeCommit).toBeUndefined();
    expect(read.mergedAt).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });

  it("a host that cannot observe a merge leaves the samples without a time: never guessed", async () => {
    const w = world();
    const { cr } = mergedFakePullRequest(w);
    (w.fakeHost as { mergeObservation?: unknown }).mergeObservation = undefined;
    const read = await endedPullRequestReader(w.dependencies, task)!("api", Number(cr.id));
    expect(read.status.state).toBe("merged");
    expect(read.mergeCommit).toBeUndefined();
    expect(read.mergedAt).toBeUndefined();
  });

  it("a failed observation leaves the samples without a time, and the read of the status still stands", async () => {
    const w = world();
    const { cr } = mergedFakePullRequest(w);
    vi.spyOn(w.fakeHost, "mergeObservation").mockRejectedValue(new Error("host down"));
    const read = await endedPullRequestReader(w.dependencies, task)!("api", Number(cr.id));
    expect(read.status.state).toBe("merged");
    expect(read.mergedAt).toBeUndefined();
  });

  it("a host that is rate limited stops the read with the neutral signal, so the pass backs off", async () => {
    const w = world();
    const { cr } = mergedFakePullRequest(w);
    w.model.rateLimitedUntil = Date.parse("2026-11-01T00:00:00.000Z");
    const failure = await endedPullRequestReader(w.dependencies as never, task)!("api", Number(cr.id)).catch((error: unknown) => error);
    expect(hostRateLimitRetryAt(failure)).toBe(Date.parse("2026-11-01T00:00:00.000Z"));
  });

  it("GitHub: the same budgeted provider call as before, with the read's allowance", async () => {
    const getPullRequestMergeObservation = vi.fn(async () => ({ ...pullRequestDetails(7, { state: "merged" }), mergeCommit: MERGE, mergedAt: MERGED_AT, headTreeSha: "b".repeat(40) }));
    const w = world({ github: { getPullRequestStatus: vi.fn(async () => githubStatus({ number: 7, state: "merged" })), getPullRequestMergeObservation } });
    const read = await endedPullRequestReader(w.dependencies, task)!("web", 7);
    expect(read).toMatchObject({ mergeCommit: MERGE, mergedAt: MERGED_AT });
    expect(getPullRequestMergeObservation).toHaveBeenCalledTimes(1);
    const [url, number, budget, scope] = getPullRequestMergeObservation.mock.calls[0] as unknown as [string, number, { signal: AbortSignal; beforeRequest: () => void }, unknown];
    expect(url).toBe("https://github.com/acme/web.git");
    expect(number).toBe(7);
    expect(typeof budget.beforeRequest).toBe("function");
    expect(scope).toEqual({ system: "private-install" });
  });

  it("GitHub: a pull request that is not merged is not observed", async () => {
    const getPullRequestMergeObservation = vi.fn();
    const w = world({ github: { getPullRequestStatus: vi.fn(async () => githubStatus({ number: 7, state: "open" })), getPullRequestMergeObservation } });
    const read = await endedPullRequestReader(w.dependencies, task)!("web", 7);
    expect(read.mergeCommit).toBeUndefined();
    expect(getPullRequestMergeObservation).not.toHaveBeenCalled();
  });
});
