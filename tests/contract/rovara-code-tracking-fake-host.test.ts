// Enterprise foundations P5a: merge tracking reads and acts through the CodeHost port, so a whole pass runs on `FakeCodeHost`: the status (draft, head, checks, reviews, mergeability), the
// standing of each reviewer, taking a draft out of draft and asking for reviewers. Every one of those spends the pass's request allowance, whatever the host.
import { describe, expect, it } from "vitest";
import { mergeTrackingKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { MergeTrackingItem } from "../../packages/contracts/src/rovara-code.js";
import { codeSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { trackPullRequest, trackTask, rowBudget, TrackingRequestCapError } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { NOW, TASK_ID, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

const URL = "https://github.com/acme/payments";
const itemOf = (w: TrackingWorld) => w.db.get(mergeTrackingKey(TASK_ID, "payments", 1)) as unknown as MergeTrackingItem & Record<string, unknown>;

/** A tracking world over a fake host: change request 1 is a draft whose checks have passed, with `reviewers` approvals by people who can write. */
function fakeTracking(options: { draft?: boolean; reviewers?: number } = {}) {
  const model = new FakeHostModel({ url: URL, id: "42", fullName: "acme/payments", webBase: "https://github.com", drafts: true });
  const head = model.commit("agentx/limit", { "src/limit.ts": "export const limit = 1;\n" });
  const { cr } = model.reconcile({ sourceBranch: "agentx/limit", targetBranch: "main", title: "Limit", draft: options.draft ?? true });
  model.setChecks(head, [{ name: "test", state: "completed", conclusion: "success", required: false, url: "" }]);
  for (let index = 0; index < (options.reviewers ?? 0); index += 1) {
    model.setAccount(`person${String(index)}`, "write");
    model.addReview(cr.id, { login: `person${String(index)}`, state: "APPROVED" });
  }
  model.setAccount("alice", "write");
  const host = new FakeCodeHost(model);
  const w = world({ pullRequests: [{ repositoryId: "payments", number: Number(cr.id), headSha: head }], deps: { repository: async () => ({ url: URL, codeHost: host }) } });
  w.db.set({ ...codeSettingsKey(TEST_ORG, "web"), allowSelfApproval: false, mergeMethod: "squash", codeReviewers: ["alice"], revision: 1 });
  return { w, model, host, head, crId: cr.id };
}

describe("a tracking pass on the fake code host", () => {
  it("takes a draft whose checks pass out of draft, asks for the project's reviewers once, and writes the item", async () => {
    const { w, model, crId } = fakeTracking();
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("changed");
    expect(model.getChangeRequest(crId)).toMatchObject({ draft: false, requestedReviewers: ["alice"] });
    expect(itemOf(w)).toMatchObject({ draft: false, ci: "passing", review: "requested", readyAt: new Date(NOW).toISOString(), reviewersRequestedAt: new Date(NOW).toISOString() });
    // The next pass reads the host and asks it for nothing more.
    expect(await trackPullRequest(w.deps, TASK_ID)).toBe("unchanged");
    expect(model.getChangeRequest(crId).requestedReviewers).toEqual(["alice"]);
  });

  it("reads an approval from a person who can write (their standing is read live through the port), and never one who cannot", async () => {
    const approved = fakeTracking({ draft: false, reviewers: 1 });
    await trackPullRequest(approved.w.deps, TASK_ID);
    expect(itemOf(approved.w)).toMatchObject({ review: "approved", approval: { login: "person0" } });
    const reader = fakeTracking({ draft: false, reviewers: 1 });
    reader.model.setAccount("person0", "read");
    await trackPullRequest(reader.w.deps, TASK_ID);
    expect(itemOf(reader.w)).toMatchObject({ review: "requested" });
    expect(itemOf(reader.w).approval).toBeUndefined();
  });

  it("spends the pass's allowance on every read and write the host is asked for (standing, ready, reviewers), so a pass cannot run on past it", async () => {
    const { w, host } = fakeTracking({ reviewers: 3 });
    const spent: string[] = [];
    for (const method of ["changeRequestStatus", "standing", "markReady", "requestReviewers"] as const) {
      const original = (host[method] as (...args: unknown[]) => Promise<unknown>).bind(host);
      (host as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => { spent.push(method); return original(...args); };
    }
    const used: number[] = [];
    const budget = rowBudget({ signal: new AbortController().signal, beforeRequest: () => { used.push(1); } }, 100);
    await trackTask({ ...w.deps, budget }, TASK_ID);
    // Each call the pass made reached the budget (the fake spends one request for each).
    expect(spent).toEqual(expect.arrayContaining(["changeRequestStatus", "standing", "markReady", "requestReviewers"]));
    expect(used.length).toBe(spent.length);
  });

  it("stops at its allowance: a pass whose allowance is spent by the host's own reads fails with the cap error and decides nothing as approved", async () => {
    const { w } = fakeTracking({ draft: false, reviewers: 3 });
    // 1 status read, then the reviewer lookups: an allowance of 2 runs out in the lookups.
    const budget = rowBudget({ signal: new AbortController().signal, beforeRequest: () => undefined }, 2);
    await expect(trackTask({ ...w.deps, budget }, TASK_ID)).rejects.toBeInstanceOf(TrackingRequestCapError);
    expect(itemOf(w)).toMatchObject({ review: "requested" });
    expect(itemOf(w).approval).toBeUndefined();
  });

  it("is told apart by the repository's record: a repository on a host the install has not registered is refused before anything is read", async () => {
    const { w } = fakeTracking();
    const refused = Object.assign(new Error("This repository's code host is not available in this install."), { code: "CONFIG_INVALID" });
    await expect(trackTask({ ...w.deps, repository: async () => { throw refused; } }, TASK_ID)).rejects.toBe(refused);
    expect(itemOf(w)).toBeUndefined();
  });
});
