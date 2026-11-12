// The messages facet: what the person who asked is told, as KINDS (text is not a parity concern; kinds and counts are).
//
// One vocabulary, the core's attention kinds (`core/notify/attention.ts#attentionKindOf`): needs_you, paused, ready, failed, done; plus `progress`, a
// narration post with nothing asked of the person (Cloud's thread narrates; the core tells only what needs the person), and `pr_opened`.
//
// Cloud: each post in the task's Slack thread, classified by the table below (first match wins; an unmatched post is `other:<first words>`, so a new post
// shows up as a difference instead of being dropped).
// Core: each attention row the core queues for the person (`NOTIFY_PENDING`, the batch it then delivers to the channel adapter), by its kind.

export interface PostRule {
  pattern: RegExp;
  kind: string;
  /** Why this post is that kind. */
  reason: string;
}

export const CLOUD_POST_KINDS: readonly PostRule[] = [
  { pattern: /^Started on (Quick|Full)/u, kind: "progress", reason: "the start acknowledgement; asks nothing" },
  { pattern: /^The workspace is ready/u, kind: "progress", reason: "the worker came up; asks nothing" },
  { pattern: /^\*?(Coding plan|Requirements|Design) v\d+ is ready for your approval/u, kind: "needs_you", reason: "a document card: the person must decide (core: needs_you)" },
  { pattern: /^(Coding plan|Requirements|Design) approved by/u, kind: "progress", reason: "echo of the decision" },
  { pattern: /^Got it\. Revising the coding plan/u, kind: "progress", reason: "echo of a change request" },
  { pattern: /^The check passed|^Checks and reviews passed/u, kind: "progress", reason: "build narration" },
  { pattern: /^Rovara sent this back to coding by itself/u, kind: "progress", reason: "Rovara's own send-back; asks nothing" },
  { pattern: /^The base branch was merged into this pull request/u, kind: "progress", reason: "branch sync narration (the re-check follows by itself)" },
  { pattern: /^The pull request's branch conflicts with the base branch/u, kind: "progress", reason: "Rovara resolves the conflict by itself; asks nothing" },
  { pattern: /^Brought <[^>]+> up to date|^Brought .* up to date/u, kind: "progress", reason: "branch sync narration" },
  { pattern: /^Running the selected checks/u, kind: "progress", reason: "build narration" },
  { pattern: /^Draft pull request opened/u, kind: "pr_opened", reason: "the pull request waits for a person on GitHub" },
  { pattern: /^Pushed the fix to/u, kind: "pr_updated", reason: "a fix pushed to the open pull request; it waits for a person on GitHub again" },
  { pattern: /^Coding stopped before it finished/u, kind: "failed", reason: "the run was lost (core: failed)" },
  { pattern: /didn't pass|Why I'm asking you|Choose checks/u, kind: "needs_you", reason: "a block that asks the person (core: needs_you)" },
  { pattern: /^Merged: |The pull request is merged\. This task is complete/u, kind: "done", reason: "the task ended (core: done)" },
  { pattern: /stopped|cancelled/iu, kind: "done", reason: "the task was stopped (core: done when closed)" },
];

export function cloudPostKind(text: string): string {
  const rule = CLOUD_POST_KINDS.find((entry) => entry.pattern.test(text));
  return rule?.kind ?? `other:${text.split(/\s+/u).slice(0, 4).join(" ")}`;
}
