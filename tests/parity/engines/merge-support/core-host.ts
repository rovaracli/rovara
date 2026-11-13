// The core engine's fake code host, made to say what GitHub says about a moved base. The vendored FakeHostModel knows drafts, conflicts and required checks
// but has no "behind": GitHub reports a branch whose head does not contain the base's head as `behind` (behindBy > 0). This wraps the host instance's
// `changeRequestStatus` to add exactly that, read from the model's own revisions, and one passing CI check on a head that has none (as Cloud's tracking
// seam reports for every head).
import type { FakeCodeHost } from "../../../../vendor/rovara-code/packages/broker/src/plugins/fake/code-host.js";
import type { FakeHostModel } from "../../../../vendor/rovara-code/packages/broker/src/plugins/fake/model.js";

/** Whether `ancestor` is `revision` or one of its ancestors in the model. */
function contains(model: FakeHostModel, revision: string, ancestor: string): boolean {
  const seen = new Set<string>();
  const queue = [revision];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    queue.push(...model.revision(sha).parents);
  }
  return false;
}

/** One passing CI check on every head, as Cloud's tracking seam reports it (merge-support/cloud-github.ts): the CI is not what these scenarios test. */
const GREEN = { name: "test", state: "completed" as const, conclusion: "success" as const, required: false, url: "https://github.com/example/demo/actions/runs/1/job/1" };

export function reportBehind(host: FakeCodeHost, model: FakeHostModel): void {
  const status = host.changeRequestStatus.bind(host);
  host.changeRequestStatus = async (ref, scope, budget) => {
    const read = await status(ref, scope, budget);
    const answer = read.checks.length === 0 ? { ...read, checks: [GREEN] } : read;
    if (answer.state !== "open" || answer.mergeableState !== "clean") return answer;
    const cr = model.changeRequests.find((entry) => entry.id === answer.id)!;
    const behind = !contains(model, model.headRevisionOf(cr), model.headOf(cr.targetBranch));
    return behind ? { ...answer, mergeableState: "behind", behindBy: 1 } : { ...answer, behindBy: 0 };
  };
}

/** A person with write access approves the change request on the host, on its head (the same approval Cloud's tracking seam reports). */
export function approveOnHost(model: FakeHostModel, id: string): void {
  model.setAccount("maint", "write");
  const cr = model.changeRequests.find((entry) => entry.id === id)!;
  model.addReview(id, { login: "maint", state: "APPROVED", revision: model.headRevisionOf(cr) });
}
