# Fixes after 0.4.12/0.4.13 (branch fix/post-0412, from a390a6ea)

Nothing here is deployed. Each fix has a test written first and seen RED.

## C59: a pushed fix found already merged could never be saved
- Cause: when a fix's push landed without its callback and GitHub already shows the pull request merged, `completedPullRequestUpdateItems` (broker.ts) updated the pull request record (head and state) and `mergedStateItems` updated the same record again in the same DynamoDB transaction. DynamoDB refuses two operations on one item, so the completion save failed on every retry.
- Fix: the record is updated once. `mergedStateItems` takes a list of records the caller already writes (`recordsWrittenByCaller`); the broker passes it when its own update runs and the pull request is merged (that update already sets state to the merged state). Webhook and sweep callers are unchanged.
- Test: `developer-task-workflow-flow.test.ts`, "records a pushed fix GitHub already merged when its push landed without the callback ...". RED: FakeDynamoDb "Transaction request cannot include multiple operations on one item".

## C59 minor: Merge button hidden from people the server lets press
- The session view's `you` gains `mayMerge: true`, set only for a task session read at `view` by a project maintainer (granted or inherited) or an org admin (the rule of `pressMerge`). The web `MergeSection` shows the button when `level !== "view" || you.mayMerge`.
- Tests: `agent-session-read.test.ts` (admin gets it; owner, contributor, viewer do not), `session-merge.test.ts`.
- Not done: filtering emails out of model- and user-written text (the other minor in C59); see C60 below for the part that was done.

## C60: no email address in text Rovara writes for others
- `ownerLabel` (plan "Why" authors, decision and refusal names) and Merge's refusal words (`requesterNameOf`, the forbidden-press message) now use `personNameForText`: display name without any address, else the linked GitHub login (plan "Why" only, looked up only when the name is an address), else "the task owner" / "the person who asked".
- Quoted request text and thread notes are not rewritten (they are the person's own words); that is the open part of the C59 minor.
- Other places that show a stored owner name (session cards, take-over and handoff messages, write-gate approval text) still print `owner.name` as stored. If the name is an email address there, it shows. Not changed here.
- Tests: `agent-session-effective-owner-authority.test.ts`, `rovara-code-merge.test.ts`; `task-owner-reads.test.ts` row for `planWhyEntries` updated.

## Approval-to-ready latency (0.4.13: 62 s, worst about 93 s)
- Review wakes now coalesce for `TRACKING_REVIEW_COALESCE_SECONDS = 10` (was the 30 s `TRACKING_COALESCE_SECONDS`, which other wakes keep: check and status events, pushes, ready for review, reopen).
- New woken-rows pass: `runDueWorkflowMergeTracking(deps, { wokenOnly: true })`. It reads only due rows that carry `wakeAt`, takes the gate's lease without waiting for `nextSweepAt`, and leaves `nextSweepAt` as it was. Heartbeat rows stay behind the 60 s gate, so the GitHub cost of heartbeat passes is unchanged. It runs after the gated pass on the minute tick of the merge-recovery schedule, and on the minute tick of the dispatch-recovery schedule (a second moment of the minute), and writes nothing when no row is due.
- Bursts: a review's events still move the row's due time once (the first, +10 s), and the one woken row is passed once and its `wakeAt` cleared; a second woken pass reads nothing. No extra GitHub call per review beyond that one pass.
- Resulting timing: wake about 3 s, due 10 s later, then the next tick of either schedule. Typical about 13 s + the wait to the next tick; worst case about 3 + 10 + 60 = 73 s (was about 93 s), typical about 28 s if the two schedules are far apart in the minute (was 62 s).
- NOT met: "within about 15 s" cannot be guaranteed. Both schedules are `rate(1 minute)`, so a pass only starts at a tick. Getting under 15 s needs a sub-minute trigger from the webhook: for example an asynchronous self-invoke or a one-time EventBridge Scheduler `at()` schedule 10 s out (new IAM and infra; not done here, no AWS). Recorded as follow-up.
- Tests (RED first): `rovara-code-review-wake.test.ts` (review wake due +10 s and others +30 s; burst coalescing; woken pass with the gate closed reads only the woken task and leaves the gate; one pass per burst).
