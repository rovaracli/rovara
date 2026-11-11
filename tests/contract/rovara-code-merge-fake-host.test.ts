// Enterprise foundations P5a: Rovara Code's merge path runs on the CodeHost port, so it runs on `FakeCodeHost` as it does on the GitHub adapter. The same press, the same readiness words,
// the same claim; the host here is a fake change request on an in-memory repository, not a GitHub-shaped provider. What the GitHub-shaped world proves for the wrapper
// (rovara-code-merge.test.ts, rovara-code-oneclick-merge.test.ts) this proves for a host that is not GitHub, on the paths that read the port: status, standing, code owners, changed files and merge.
import { describe, expect, it } from "vitest";
import { orgMemberKey, MERGE_NOT_READY_MESSAGES as M } from "../../packages/contracts/src/index.js";
import { pressMerge } from "../../packages/broker/src/rovara-code/merge.js";
import { approvalReviewsOf, changedPathsOf } from "../../packages/broker/src/rovara-code/host-port.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { PRIYA, ARJUN, MAX, ORG_A } from "../support/agent-session-world.js";
import { GH, LOGIN, mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const URL = "https://github.com/acme/payments";
const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const browser = (w: MergeWorld, who: string = PRIYA) => ({ ...w.caller(who), browserSession: true as const });
const webPress = (w: MergeWorld, who: string = PRIYA) => pressMerge(w.shareDeps, browser(w, who), w.sessionId, { requestId: w.requestId(), risk: "low" }, w.deps);

interface FakeWorld { w: MergeWorld; model: FakeHostModel; host: FakeCodeHost; head: string; crId: string }

/** A project whose one repository is the fake host's: change request 1 from a branch of the base, checks passing, approved by Arjun (a member) on the head. */
async function fakeWorld(options: { codeOwners?: string; allowSelfApproval?: boolean; host?: (model: FakeHostModel) => FakeCodeHost } = {}): Promise<FakeWorld> {
  const model = new FakeHostModel({
    url: URL, id: "42", fullName: "acme/payments", webBase: "https://github.com",
    ...(options.codeOwners === undefined ? {} : { initialFiles: { "README.md": "# demo\n", ".github/CODEOWNERS": options.codeOwners } }),
  });
  // The host knows the people by the same account ids the world links to its members.
  for (const [login, id] of [[LOGIN.priya, GH.priya], [LOGIN.arjun, GH.arjun], [LOGIN.max, GH.max], [LOGIN.ola, GH.ola]] as const) model.setAccount(login, "write").hostUserId = id;
  const head = model.commit("agentx/limit", { "src/limit.ts": "export const limit = 1;\n" });
  const { cr } = model.reconcile({ sourceBranch: "agentx/limit", targetBranch: "main", title: "Limit" });
  model.setChecks(head, [{ name: "test", state: "completed", conclusion: "success", required: false, url: "" }]);
  model.addReview(cr.id, { login: LOGIN.arjun, state: "APPROVED" });
  const host = options.host?.(model) ?? new FakeCodeHost(model);
  const w = mergeWorld({ pullRequests: [{ repositoryId: "payments", number: Number(cr.id) }], codeHost: host, ...(options.allowSelfApproval === undefined ? {} : { allowSelfApproval: options.allowSelfApproval }) });
  await w.linkAll();
  w.setPullRequests(w.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, url: `${URL}/pull/${String(pr.number)}`, headSha: head, candidateDigest: "c".repeat(64), required: true, state: "OPEN" })));
  w.seedTracking({ headSha: head, approval: { githubUserId: GH.arjun, login: LOGIN.arjun, commitId: head } });
  return { w, model, host, head, crId: cr.id };
}

describe("merging on the fake code host", () => {
  it("merges a ready change request at once: the checked head, the project's method, the claim on the tracking item", async () => {
    const { w, model, head, crId } = await fakeWorld();
    const reply = await webPress(w);
    expect(reply.status).toBe(200);
    expect(model.getChangeRequest(crId)).toMatchObject({ state: "merged", mergedBy: "rovara-user" });
    expect(model.headOf("main")).toBe(model.getChangeRequest(crId).mergeRevision);
    expect(w.trackingOf({ repositoryId: "payments", number: Number(crId) })?.mergeClaim).toMatchObject({ headSha: head, by: PRIYA });
  });

  it("re-reads the host: checks that went red since tracking looked stop the merge, and so does a head that moved", async () => {
    const red = await fakeWorld();
    red.model.setChecks(red.head, [{ name: "test", state: "completed", conclusion: "failure", required: false, url: "" }]);
    expect(await codeOf(webPress(red.w))).toEqual({ code: "MERGE_NOT_READY", message: M.checks });
    expect(red.model.getChangeRequest(red.crId).state).toBe("open");
    const moved = await fakeWorld();
    moved.model.commit("agentx/limit", { "src/limit.ts": "export const limit = 2;\n" });
    expect(await codeOf(webPress(moved.w))).toEqual({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
    expect(moved.model.getChangeRequest(moved.crId).state).toBe("open");
  });

  it("counts an approval only from a person with write access on the host (read live through the port)", async () => {
    const { w, model, crId } = await fakeWorld();
    model.setAccount(LOGIN.arjun, "read").hostUserId = GH.arjun;
    expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.needsWriteApproval("payments") });
    expect(model.getChangeRequest(crId).state).toBe("open");
  });

  it("keeps the Auditor non-writer filter on the live read: a linked Auditor's approval on the host never counts, with self-approval on or off", async () => {
    for (const allowSelfApproval of [false, true]) {
      const { w, model, head, crId } = await fakeWorld({ allowSelfApproval });
      // What tracking stored is acceptable (a member's approval), so the press reaches the merge's own fresh read of the host, where the only approval is the Auditor's.
      w.seedTracking({ headSha: head, approval: { githubUserId: GH.max, login: LOGIN.max, commitId: head } });
      w.db.set({ ...orgMemberKey(ORG_A, ARJUN), orgId: ORG_A, developerId: ARJUN, role: "auditor" });
      const refusal = await codeOf(webPress(w));
      // An excluded account is "no write access" to the rule, in both modes.
      expect(refusal, String(allowSelfApproval)).toEqual({ code: "MERGE_NOT_READY", message: M.needsWriteApproval("payments") });
      expect(model.getChangeRequest(crId).state).toBe("open");
    }
    // Positive control: the same world with Arjun as a member merges.
    const { w, model, head, crId } = await fakeWorld({ allowSelfApproval: true });
    w.seedTracking({ headSha: head, approval: { githubUserId: GH.max, login: LOGIN.max, commitId: head } });
    expect((await webPress(w)).status).toBe(200);
    expect(model.getChangeRequest(crId).state).toBe("merged");
  });

  it("a review from a host that gives no account id never counts as an approval (an Auditor-linked login, self-approval on or off), and a positive control with the id merges", async () => {
    for (const allowSelfApproval of [false, true]) {
      const { w, model, head, crId } = await fakeWorld({ allowSelfApproval });
      w.seedTracking({ headSha: head, approval: { githubUserId: GH.max, login: LOGIN.max, commitId: head } });
      w.db.set({ ...orgMemberKey(ORG_A, ARJUN), orgId: ORG_A, developerId: ARJUN, role: "auditor" });
      // The host reports Arjun's approval with no account id: the Auditor exclusion cannot see who it is.
      for (const review of model.getChangeRequest(crId).reviews) delete (review.reviewer as { hostUserId?: string }).hostUserId;
      const refusal = await codeOf(webPress(w));
      expect(refusal?.code, String(allowSelfApproval)).toBe("MERGE_NOT_READY");
      expect(model.getChangeRequest(crId).state, String(allowSelfApproval)).toBe("open");
    }
    const { w, model, head, crId } = await fakeWorld({ allowSelfApproval: true });
    w.seedTracking({ headSha: head, approval: { githubUserId: GH.max, login: LOGIN.max, commitId: head } });
    expect((await webPress(w)).status).toBe(200);
    expect(model.getChangeRequest(crId).state).toBe("merged");
  });

  it("an id-less review keeps its power to block: changes requested still refuses, and only an approval is dropped", async () => {
    const { w, model, crId } = await fakeWorld({ allowSelfApproval: true });
    model.addReview(crId, { login: LOGIN.max, state: "CHANGES_REQUESTED" });
    for (const review of model.getChangeRequest(crId).reviews) delete (review.reviewer as { hostUserId?: string }).hostUserId;
    expect(await codeOf(webPress(w))).toMatchObject({ code: "MERGE_NOT_READY" });
    expect(model.getChangeRequest(crId).state).toBe("open");
    const reviews = model.getChangeRequest(crId).reviews;
    const mapped = approvalReviewsOf(reviews);
    expect(mapped.map((review) => [review.state, review.githubUserId])).toEqual([["CHANGES_REQUESTED", `login:${LOGIN.max}`]]);
  });

  it("asks for a code owner from the host's CODEOWNERS and changed files, and merges once one has approved", async () => {
    const { w, model, head, crId } = await fakeWorld({ codeOwners: "/src/ @max-gh\n" });
    expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.needsCodeOwner("@max-gh") });
    model.addReview(crId, { login: LOGIN.max, state: "APPROVED" });
    // Tracking last saw Max's approval as the newest one on the head.
    w.seedTracking({ headSha: head, approval: { githubUserId: GH.max, login: LOGIN.max, commitId: head } });
    expect((await webPress(w)).status).toBe(200);
    expect(model.getChangeRequest(crId).state).toBe("merged");
    expect(MAX).toBeDefined();
  });

  it("never asks a host for code owners when its capabilities say it has none, even if the method is there", async () => {
    let asked = 0;
    const { w, model, crId } = await fakeWorld({
      codeOwners: "/src/ @max-gh\n",
      host: (m) => {
        const host = new FakeCodeHost(m);
        Object.defineProperty(host, "capabilities", { value: { ...host.capabilities, codeOwners: false } });
        const original = host.codeOwners.bind(host);
        host.codeOwners = async (...args) => { asked += 1; return original(...args); };
        return host;
      },
    });
    // With the capability on, Arjun's approval would not satisfy /src/ (see the code-owner test); with it off nothing is asked and the merge goes through.
    expect((await webPress(w)).status).toBe(200);
    expect(asked).toBe(0);
    expect(model.getChangeRequest(crId).state).toBe("merged");
  });

  it("a rename out of a code-owned path still needs its owner: the old path counts as changed", async () => {
    const { w, model, crId } = await fakeWorld({
      codeOwners: "/secure/ @max-gh\n",
      host: (m) => {
        const host = new FakeCodeHost(m);
        host.changedFiles = async () => ({ files: [{ path: "src/limit.ts", previousPath: "secure/limit.ts", status: "renamed", additions: 0, deletions: 0 }] });
        return host;
      },
    });
    expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.needsCodeOwner("@max-gh") });
    expect(model.getChangeRequest(crId).state).toBe("open");
    // The paths the check sees are both names.
    const host = new FakeCodeHost(model);
    host.changedFiles = async () => ({ files: [{ path: "src/limit.ts", previousPath: "secure/limit.ts", status: "renamed", additions: 0, deletions: 0 }] });
    expect(await changedPathsOf(host, { repository: { url: URL }, id: crId, url: "" }, { orgId: ORG_A })).toEqual({ paths: ["src/limit.ts", "secure/limit.ts"], complete: true });
  });

  it("never merges a task's pull request that changes the team's lessons file (owner decision 50.4): an add, a rename onto it, an incomplete or unreadable list; a clean one merges", async () => {
    for (const files of [
      [{ path: ".rovara/lessons.md", status: "added", additions: 1, deletions: 0 }],
      [{ path: ".rovara/lessons.md", previousPath: "docs/lessons.md", status: "renamed", additions: 0, deletions: 0 }],
      [{ path: "docs/old.md", previousPath: ".rovara/lessons.md", status: "renamed", additions: 0, deletions: 0 }],
    ]) {
      const { w, model, crId } = await fakeWorld({ host: (m) => { const host = new FakeCodeHost(m); host.changedFiles = async () => ({ files }); return host; } });
      expect(await codeOf(webPress(w))).toEqual({ code: "MERGE_NOT_READY", message: M.touchesLessonsFile });
      expect(model.getChangeRequest(crId).state).toBe("open");
    }
    const cut = await fakeWorld({ host: (m) => { const host = new FakeCodeHost(m); host.changedFiles = async (_ref, page) => ({ files: [{ path: `src/f${String(page)}.ts`, status: "modified", additions: 1, deletions: 0 }], nextPage: page + 1 }); return host; } });
    expect(await codeOf(webPress(cut.w))).toEqual({ code: "MERGE_NOT_READY", message: M.lessonsFileUnreadable });
    const down = await fakeWorld({ host: (m) => { const host = new FakeCodeHost(m); host.changedFiles = async () => { throw new Error("host down"); }; return host; } });
    expect(await codeOf(webPress(down.w))).toEqual({ code: "MERGE_NOT_READY", message: M.lessonsFileUnreadable });
    const clean = await fakeWorld({ host: (m) => { const host = new FakeCodeHost(m); host.changedFiles = async () => ({ files: [{ path: ".rovara/project.yaml", status: "modified", additions: 1, deletions: 0 }] }); return host; } });
    expect((await webPress(clean.w)).status).toBe(200);
    expect(clean.model.getChangeRequest(clean.crId).state).toBe("merged");
  });

  it("never merges a task's pull request that changes the company rules file (G-04): at its default path, or at the path the company connected (read while si is on); the connected path is not read while si is off", async () => {
    const touching = (path: string) => (m: FakeHostModel) => { const host = new FakeCodeHost(m); host.changedFiles = async () => ({ files: [{ path, status: "modified", additions: 1, deletions: 0 }] }); return host; };
    const byDefault = await fakeWorld({ host: touching(".rovara/company-rules.md") });
    expect(await codeOf(webPress(byDefault.w))).toEqual({ code: "MERGE_NOT_READY", message: M.touchesCompanyRulesFile });
    expect(byDefault.model.getChangeRequest(byDefault.crId).state).toBe("open");
    const link = { pk: `ORG#${ORG_A}`, sk: "COMPANYRULES#SYNC", entityType: "COMPANY_RULES_SYNC", orgId: ORG_A, revision: 1, repositoryName: "acme/meta", repositoryUrl: "https://github.com/acme/meta.git", repositoryId: 5, path: "docs/our-rules.md", branch: "main", connectedBy: "a".repeat(64), connectedAt: "2026-11-11T05:00:00.000Z", fileState: "match" };
    try {
      process.env.STANDING_INSTRUCTIONS_ENABLED = "1";
      const connected = await fakeWorld({ host: touching("docs/our-rules.md") });
      connected.w.db.set(link);
      expect(await codeOf(webPress(connected.w))).toEqual({ code: "MERGE_NOT_READY", message: M.touchesCompanyRulesFile });
      expect(connected.model.getChangeRequest(connected.crId).state).toBe("open");
      delete process.env.STANDING_INSTRUCTIONS_ENABLED;
      const off = await fakeWorld({ host: touching("docs/our-rules.md") });
      off.w.db.set(link);
      expect((await webPress(off.w)).status).toBe(200);
    } finally { delete process.env.STANDING_INSTRUCTIONS_ENABLED; }
  });

  it("never merges on a host that does not offer merge: it is found before any claim is made", async () => {
    const { w, model, crId } = await fakeWorld({ host: (m) => { const host = new FakeCodeHost(m); Object.defineProperty(host, "merge", { value: undefined }); return host; } });
    const refusal = await codeOf(webPress(w));
    expect(refusal).toEqual({ code: "MERGE_NOT_READY", message: "Rovara can't merge on this repository's code host. Merge it there." });
    expect(model.getChangeRequest(crId).state).toBe("open");
    expect(w.trackingOf({ repositoryId: "payments", number: Number(crId) })?.mergeClaim).toBeUndefined();
  });
});
