// Enterprise foundations P6: the neutral rate-limit signal. A host that has told Rovara to slow down throws `HostRateLimitError` (GitHub's class is one), and everything that bounds its reads
// (merge tracking, the merge sweep) reads that one signal: it stops, keeps what it has and tries again when the host said it may.
import { describe, expect, it } from "vitest";
import { HostRateLimitError, hostRateLimitRetryAt } from "@rovara-code/contracts";
import { GithubMergeRateLimitError } from "../../packages/broker/src/github-app.js";
import { isHostRateLimit, rateLimitRetryAt } from "../../packages/broker/src/rovara-code/host-port.js";
import { reconcileTrackingTask, trackPullRequest } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { NOW, TASK_ID, world } from "../support/rovara-code-tracking.js";

// The tracking world pins GitHub-shaped addresses; the host behind this one is the fake.
const URL = "https://github.com/acme/payments";
const RETRY_AT = NOW + 600_000;

describe("P6: the neutral rate-limit signal", () => {
  it("is recognised on any host's error, GitHub's included, and on nothing else", () => {
    for (const error of [new HostRateLimitError(RETRY_AT), new GithubMergeRateLimitError(RETRY_AT)]) {
      expect(rateLimitRetryAt(error)).toBe(RETRY_AT);
      expect(isHostRateLimit(error)).toBe(true);
      expect(hostRateLimitRetryAt(error)).toBe(RETRY_AT);
    }
    for (const error of [new Error("rate limited"), Object.assign(new Error("x"), { retryAt: RETRY_AT }), { retryAt: RETRY_AT }, "rate limited", undefined, null]) {
      expect(rateLimitRetryAt(error)).toBeUndefined();
      expect(isHostRateLimit(error)).toBe(false);
    }
  });

  it("GitHub's class keeps its name and its words, and is one kind of the neutral class", () => {
    const error = new GithubMergeRateLimitError(RETRY_AT);
    // One kind of the neutral class: the brand says so, whichever copy of the class made it.
    expect(hostRateLimitRetryAt(error)).toBe(RETRY_AT);
    expect(error).toMatchObject({ name: "GithubMergeRateLimitError", message: "GitHub merge observation is rate limited", retryAt: RETRY_AT });
    expect(new HostRateLimitError(RETRY_AT)).toMatchObject({ name: "HostRateLimitError" });
  });

  it("refuses a retry time that is not a time", () => {
    for (const retryAt of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) expect(() => new HostRateLimitError(retryAt)).toThrow();
    expect(() => new GithubMergeRateLimitError(0)).toThrow();
  });
});

describe("P6: a tracking pass on a host that is rate limited", () => {
  function limited() {
    const model = new FakeHostModel({ url: URL, id: "42", fullName: "acme/payments" });
    const head = model.commit("rovara/limit", { "src/a.ts": "1\n" });
    const { cr } = model.reconcile({ sourceBranch: "rovara/limit", targetBranch: "main", title: "t", draft: false });
    const host = new FakeCodeHost(model);
    const w = world({ pullRequests: [{ repositoryId: "payments", number: Number(cr.id), headSha: head }], deps: { repository: async () => ({ url: URL, codeHost: host }) } });
    return { w, model };
  }

  it("stops with the host's own signal, and a sweep retries it at the time the host gave", async () => {
    const { w, model } = limited();
    model.rateLimitedUntil = RETRY_AT;
    await expect(trackPullRequest(w.deps, TASK_ID)).rejects.toSatisfy((error: unknown) => rateLimitRetryAt(error) === RETRY_AT);
    const result = await reconcileTrackingTask({ ...w.deps, observeMerge: async () => ({ kind: "OBSERVED" }) }, TASK_ID, { signal: new AbortController().signal, beforeRequest: () => undefined });
    expect(result).toEqual({ kind: "RETRY", retryAt: RETRY_AT, scope: "github-global" });
  });

  it("reads normally once the host no longer limits it", async () => {
    const { w, model } = limited();
    model.rateLimitedUntil = RETRY_AT;
    await expect(trackPullRequest(w.deps, TASK_ID)).rejects.toBeDefined();
    model.rateLimitedUntil = undefined;
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("changed");
  });
});
