// K1 lane D, D4: what people do to the spec pull request. Rovara opened it and never pushes to it again, so a head that is not the recorded one is a person's edit: the task owner is asked "The spec changed.
// Re-plan or keep?" and the code pull requests wait for the answer. A review that approves the recorded head is the approval `spec_first` waits for. The facts come from GitHub (never from the event), so a
// missed or repeated delivery changes nothing; the same refresh runs when a delivery arrives and whenever the held code pull request is looked at again.
import { approved, edited, stepFailed, type SpecState } from "./state.js";
import type { SpecStore } from "./hooks.js";

export interface SpecPullRequestFacts {
  state: "open" | "closed" | "merged";
  headSha: string;
  reviews: ReadonlyArray<{ state: string; commitId: string; login?: string }>;
  /** The list of reviews was cut: what is past it is not known, so no approval may be read from it. */
  reviewsIncomplete?: boolean | undefined;
}

const SHA = /^[a-f0-9]{40}$/u;

/** The state after what GitHub shows now, or undefined when nothing changes. Pure. */
export function specStateFromFacts(state: SpecState, facts: SpecPullRequestFacts, now: string): SpecState | undefined {
  const link = state.specPullRequest;
  if (state.status !== "published" || link === undefined || !SHA.test(facts.headSha)) return undefined;
  // A head that is not the recorded one: a person's edit (this runs even when the pull request was closed since).
  if (facts.headSha !== link.commit) {
    const changed = edited(state, { headSha: facts.headSha }, now);
    if (changed !== undefined) return changed;
    // Already asked about this head, or kept at it: nothing more to say about the edit.
    if (state.editPrompt?.headSha === facts.headSha) return undefined;
  }
  if (facts.state === "closed") {
    const operationId = state.publishOperationId;
    // Closed without a merge: the spec is gone, and the owner chooses (retry writes it again; continuing goes on without).
    return operationId === undefined ? undefined : failedAfterPublish(state, now);
  }
  if (state.target.linkStyle !== "spec_first" || state.approvedAt !== undefined) return undefined;
  if (facts.reviewsIncomplete === true) return undefined;
  const atHead = facts.reviews.filter((review) => review.commitId === link.commit);
  const approver = atHead.find((review) => review.state === "APPROVED");
  const objection = atHead.some((review) => review.state === "CHANGES_REQUESTED");
  if (facts.state === "merged") return approved(state, { headSha: link.commit, by: approver?.login ?? "merged" }, now);
  if (approver === undefined || objection) return undefined;
  return approved(state, { headSha: link.commit, by: approver.login ?? "reviewer" }, now);
}

function failedAfterPublish(state: SpecState, now: string): SpecState | undefined {
  // `stepFailed` knows only an operation that is running; a published spec that is closed is moved by hand to the same failed shape.
  const failed = stepFailed({ ...state, status: "publishing" }, { operationId: state.publishOperationId!, code: "spec_closed" }, now);
  return failed === undefined ? undefined : { ...failed, revision: state.revision + 1 };
}

/** Reads GitHub's view of the spec pull request and stores the state it implies. `read` returns undefined when GitHub cannot say; then nothing changes. Returns the state to use now. */
export async function refreshSpecState(
  env: { store: SpecStore; now(): string; read(state: SpecState): Promise<SpecPullRequestFacts | undefined> }, taskId: string,
): Promise<{ state: SpecState | undefined; changed: boolean }> {
  const { state } = await env.store.load(taskId);
  if (state === undefined || state.status !== "published" || state.specPullRequest === undefined || state.continuedWithoutSpec !== undefined) return { state, changed: false };
  let facts: SpecPullRequestFacts | undefined;
  try { facts = await env.read(state); } catch { facts = undefined; }
  if (facts === undefined) return { state, changed: false };
  const next = specStateFromFacts(state, facts, env.now());
  if (next === undefined) return { state, changed: false };
  // A lost race (another refresh or an owner's choice moved the state first) is read again by the next look.
  return (await env.store.save(next, state.revision)) ? { state: next, changed: true } : { state, changed: false };
}

