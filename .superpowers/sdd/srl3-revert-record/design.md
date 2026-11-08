# SRL-3: record reverts of Rovara pull requests

Owner decision 24b (2026-11-08). Gap: `RovaraPullRequestIndexPort.byMergeCommit` had no production implementation (`team-record/runtime.ts` returned `undefined`),
so a revert named by commit ("This reverts commit <sha>") never matched a Rovara PR: no `rovara.closed{reverted}`, no `rovara.reverted_by`, no track-record re-score.

## What exists today (investigated)
- Reverse link PR -> task: `GITHUB_PR#<owner/repo lower>` / `PR#<n>` rows (`developer/task-records.ts`), neutral `CODEHOST_CR#...` rows; read by `findLinkedChangeRequest`.
  The production `byNumber` (runtime.ts) already uses it, plus the task's `workflow.pullRequests[].headSha` for `candidateHeadSha`. A revert named by PR number ("Reverts owner/repo#12") works today.
- The merge commit is NOT stored on the task, the link row, the tracking row or the workflow entry. It is seen by GitHub reads: `reconcileTaskPullRequestFeedback`
  (`aws/github-webhooks.ts`, webhook + merge sweep) reads `feedback.pullRequest.mergeCommit`; the pushed-fix save (`aws/broker/workflow-items.ts`) reads it too.
  It is kept only inside track-record outcome samples (`pr.mergeCommit`, 180 days, v1.1.0 workflows only).
- Every path that moves a PR to MERGED passes through `rovara-code/merged-state.ts#mergedStateItems`, which adds side items to the SAME transaction as the workflow save
  (tracking row to merged, PR record to merged, timeline line). That is the merge-time write point.
- Detection (`team-record/sources/codehost.ts#revertsOf`, unchanged): a default-branch push whose commit message says "This reverts commit <40 hex>", or a merged
  "Revert ..." PR on the default branch whose body says "Reverts owner/repo#N" (byNumber) or "This reverts commit <sha>" (byMergeCommit). One record per task, `OnceClaimPort` for the re-score.

## Design
New index row in the state table, written at merge time in the merge transaction:

    pk = ORG#<org>#GITHUB_MERGE     sk = <owner/repo lower-cased>#<40 hex lower-case>      (contracts mergeCommitIndexKey; review fix M1)
    { entityType: "GITHUB_WORKFLOW_MERGE", orgId, repositoryFullName, repositoryId, number, url, taskId, mergeCommit, createdAt, expiresAt (INDEX_EXPIRY_ATTRIBUTE, 400 days) }

- Key = company + repo + sha (one partition per company), so two companies or repos never share a row; the row also carries `orgId` and the reader refuses a row whose `orgId` is not
  the asked workspace. A fork with the same sha is a different repo name. Company close erases the whole `ORG#<org>#GITHUB_MERGE` partition (`org/track-record-cleanup.ts`, up to 8000
  pages of 25) with no repository discovery, which is why it is one partition and not one per repository (review M1).
- Writer: `rovara-code/merge-commit-index.ts#mergeCommitIndexItem`, called from `mergedStateItems` for each newly merged PR whose observation names a 40-hex merge commit and whose
  url is `https://github.com/<owner>/<repo>/pull/<n>` (GitHub only, as `byNumber`). Unconditional Put (a replay writes the same values; one item per sha, so no duplicate-item
  transaction error). Callers pass the commit in `MergedObservation.mergeCommit` (`observedMerges`, and the pushed-fix save). No commit in the observation: nothing written, logged
  `merge_commit_index.skipped` (never blocks the merge record).
- Reader: `rovara-code/rovara-pull-request-index.ts#createRovaraPullRequestIndex` (moved out of runtime.ts so the TeamRecord storage-module list is untouched). `byMergeCommit`:
  strongly-consistent Get on the key; row must say what its key says and have `orgId === workspaceId`; then the existing `byNumber` path (task must be the same org,
  same task id, same pr url, `headSha` known); returns `{...pr, mergeCommitSha: sha}`. Any mismatch/miss/bad input: `undefined` (fail closed = not recorded). Host other than github: undefined.
- No person ids in the row: no person-erase walk needed (`person-fields.ts` untouched). It holds only task/repo/sha, expires by TTL (the state table's TTL attribute; none on the
  legacy template) and is erased at company close.
- Push-path detection (review L1) needs git's revert shape: subject `Revert "` and a body line starting `This reverts commit <sha>` (`gitRevertedCommits`). A revert of a revert does not un-revert.
- A merge with no usable commit logs a counts-only `merge_commit_index.missed` line (reason, count; no ids) (review L2).
- The index Put stays in the merge transaction (review L3): it is one item per newly merged PR, and the transaction limit of 100 is an existing limit that audit, stats, milestone,
  tracking, record and timeline items already approach; the merge record must not lose its index row to a later crash, which is the point of one transaction.
- Idempotency of the record: unchanged. `rovara.closed` id `task:<id>:closed` version `reverted`, `github.revert` id `<repo>:revert:<task>`, `rovara.reverted_by`: the sink dedupes by (id, version); the re-score is claimed once per task.
- Non-Rovara revert: no index row -> undefined -> nothing recorded, nothing failed (existing behaviour, now tested against the production port).

Squash and merge-commit merges give the PR's `merge_commit_sha` = the commit on the base branch (what "git revert" names). A rebase-merge's merge_commit_sha is the last rebased
commit only; a revert of an earlier rebased commit is not matched (deferred, noted in DEFERRED-CHECKS).

## Backfill (optional release step)
Merges recorded before this release have no index row. `backfillMergeCommitIndex` (library, `rovara-code/merge-commit-index.ts`) + `scripts/backfill-merge-commit-index.ts` (operator, run by the owner):
scans outcome samples that already hold `pr.mergeCommit` (GitHub-sourced), reads each task's MERGED pull request for its url, and puts the missing index row with `attribute_not_exists`
(idempotent, resumable, paced, read + put only). It covers only PRs scored in the last 180 days; older merges stay unmatched. Prod is paused and staging has few merged Rovara PRs, so this is optional.

## Out of scope / deferred
- "reviewOutcome is recorded at publication only": not trivial (needs a new row version on the rovara.review row at merge/request-changes); left as deferral.
- Live fallback lookup (GitHub "pulls for commit") for merges before the index: not built (rate cost on every non-Rovara revert).
