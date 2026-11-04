Verdict: FIX THEN PROCEED

# REVIEW-M2: Task 1, company spending-stop enrollment (implementation)

Reviewer: Opus, checkpoint M2, 2026-11-04. Read-only review of `aef096def..ec8bd9baf` (one commit, ec8bd9baf).
Read: M2-READY.md, DESIGN.md, HANDOFF.md, REVIEW-M1.md, the brief, all changed source and tests, and the real admission paths the
review claims to project (`org/task-stop-admission.ts`, `aws/developer-tasks/continue.ts` ~85-130 and ~460-495,
`aws/developer-tasks/start.ts` ~410-470, `aws/developer-tasks/task-window.ts` `windowAndPauseUpdate`, `org/task-stop-funding.ts`,
`spend/task-approval-terms.ts`, `spend/ledger.ts`, `org/second-person-evidence.ts`, `agents/budget-authority.ts`,
`agents/table-writes.ts`, `aws/broker/project-registration.ts`).

## What I ran

- `vt` with the 21 files listed in M2-READY.md: **21 files, 1241 tests passed** (34.7 s). Matches Codex's numbers.
- Initial bundle, pinned Node 22.23.2, `scripts/web-bundle-budget.ts` against the existing dist: **184564 gzip bytes**
  (base 183820, +744, budget 256000 unchanged). The lazy-marker test passes, so the enforcement UI is not in the initial chunks.
- Dry-run merge of ec8bd9baf with the 0.5.4 head cb3a087a0 (`git merge-tree`): see "Overlap" below.

## Overall

The authority, atomicity, replay and compatibility work is good, and every one of the 15 M1 items has code and a test. Owner-only is
enforced from native rows at every edge, the role/pointer/org/identity checks are inside the commit transaction, and REAUTH
(including a future `authTime` and `sessionsEndedAt`) is applied to enable and to disable-from-enabled only. Receipts, the policy Put and
the audit outbox commit together. Lost acknowledgements, demoted replays and body mismatches behave correctly. `enrollment` stays exactly
`{version,state}`, and the sibling `enrollmentReview` is invisible to every existing reader (tested for admission, funding, unpriced,
bootstrap and the spend-request decider). The transaction arithmetic holds: enable is at most 80 (W) + policy + guardrails + 2 seeds +
model sources (5) + member, pointer, org, identity (4) + session + review + audit + receipt (4) = **93 actions**, under the stated 94 and
DynamoDB's 100. Keys are de-duplicated by `mergeChecks`, task/workspace rows add zero, and bytes are checked under 4 MB.

The problem is money projection. M1 item 12 asked for the review to match the *real* next admission, and the positive-control test
does not exercise the real admission. When I traced the real path (`continue.ts`), three of the four outcomes do not match what will
happen to a task admitted while the company was disabled, which is every task that exists at cutover. The owner is shown the wrong
consequence. None of these mismatches lets a task overspend (admission is still the safety mechanism, and it reads the canonical row),
but the review is the owner's consent screen for a money change, so it has to be right. There are also two ways an owner can get stuck
with no way to enable, and one way the emergency off-switch can be blocked.

## Required fixes

### 1. `exempt` is projected for tasks that real admission will NOT exempt

`org/task-stop-cutover-review.ts` (~lines 129-135) marks a task `exempt` when a fresh `captureTaskFundingProof` succeeds. Real admission
does not do that for an existing task. `continue.ts:87` applies the company stop whenever `task.fundingProof === undefined`, and only
`start.ts:427` (a brand-new task) captures a funding proof. A task started while the company was disabled never has a `fundingProof`,
because `captureTaskFundingProof` returns `undefined` unless enrollment is `enabled`. So for every own-source task at cutover, the review
says "Verified own-source exemption" while the next Continue applies the stop. With a $0 effective stop, the review says exempt and the
task is actually refused with `TASK_STOP_ZERO`. The existing exempt test (`task-stop-paid-start.test.ts`, last block) passes only because
its task was started while enrolled, so it already has a `fundingProof`. That cannot happen to a task that exists at a real first
cutover.

Change: classify `exempt` exactly as continue does. Exempt only if `task.fundingProof !== undefined` (and, to match the spend-approval
path at `continue.ts:464-468`, the frozen recipe's `fundingProof` deep-equals it). Otherwise run the normal stop classification. Remove
the new `purpose: "cutover_review"` bypass in `org/task-stop-funding.ts`; nothing will need it.
Tests: (a) an own-source task started while **disabled** (no `fundingProof`) is NOT exempt in the review, and after enable the real
Continue applies the stop the review showed; (b) the same with a $0 company default gives `refuse_next_admission`, and Continue refuses
with `TASK_STOP_ZERO`; (c) keep an exempt case, built from a task that really has an admitted `fundingProof`.

### 2. `stop_at_next_admission` contradicts ruling R38; the spend read blocks the whole review

A Continue starts a new window at what the task's keys have already spent: `continue.ts:118-129` passes `taskSpendBaseline(...)` as the
new `budgetBaselineUsd` (`task-window.ts:131`), and the spend-approval path does the same (`continue.ts:492`). So a queued task whose
`settledUsd - budgetBaselineUsd` is already at or above the new stop is NOT stopped at its next admission. It gets a fresh window of the
full effective stop. The review tells the owner the opposite.
A queued task under its stop is also labelled `retain_current_window`, but it has no window. Its next admission opens a new one at the
company stop. And the spend read refuses the entire company review (`TASK_STOP_CONFIG_INVALID`) whenever any task has minted keys but no
`TASK_SPENT` row yet. That is the normal state for a task that has just started, so a busy company will see the review fail on and off.

Change (contract is new in this branch, so it can change): outcomes become
`refuse_next_admission` (effective stop is 0), `new_window_at_stop` (queued, positive stop; the next admission opens a window of
`effectiveStopMicrousd` from current spend), `retain_current_window` (running only; keeps its disabled-era window until its next
admission, then `new_window_at_stop`), and `exempt` (fix 1). Delete the `TASK_SPENT` read and its refusal. Update
`contracts/src/task-stop-enrollment.ts`, the `outcomes` labels in `TaskStopEnforcement.tsx`, the `newImpacts` rule in
`task-stop-enrollment.ts` (count `refuse_next_admission` only, or both refuse and new-window, and say which in DESIGN.md), and DESIGN.md.
Tests: replace "queued settled spend ... is a stop_at_next_admission impact" with: settled spend at or above the stop gives
`new_window_at_stop`, and after enable the real Continue admits a window whose baseline equals current spend. Add: a task with model keys
and no `TASK_SPENT` row does not fail the review.

### 3. The review's capture identity is not the one Continue uses

`continue.ts:88-99` builds the admission identity with
`requestedMicrousd = previous?.requestedMicrousd ?? usdToWholeMicrodollars(task.requestedRunLimitUsd)` (or `null` when that value cannot
be represented). The review uses only `savedTaskStopBounds(task.spendingStop)`, which is `{}` for every disabled-era task. So it drops
`requestedRunLimitUsd` (set by `start.ts:523` whenever a run limit was asked for). `calculateTaskStop` takes the minimum over candidates
including `requested`, so the review can show a HIGHER stop than the one admission will apply.
Change: extract one pure helper, e.g. `continueAdmissionIdentity(task)` in `org/task-stop-window.ts`, returning `pathLimitMicrousd`,
`committedMaxPerRunMicrousd`, `requestedMicrousd`, `chainMicrousd` and `testingMicrousd` exactly as `continue.ts:88-99` computes them. Call
it from both `continue.ts` and the review, so the two can never drift. (`continue.ts` is not touched by any 0.5.4 lane.)
Test: a disabled-era task with `requestedRunLimitUsd: 0.5`, company default $2. The review shows `effectiveStopMicrousd: 500000` with
binding `requested`, and the real Continue after enable admits 500000.

### 4. Replace the positive-control test with one that drives real admission

"review classification matches the real enrolled admission" (`task-stop-enrollment.test.ts` ~line 380) calls
`captureTaskStopAdmission` with a hand-built identity, and the $2 company default binds. It would pass even if the review's task inputs
were wrong. That is why fixes 1 to 3 got through.
Change: in a fixture that can run the Continue route (the `task-stop-paid-start.test.ts` harness already has `start`, enrolled
admission and the model-access fake), create tasks while **disabled**, capture a review, go ready and enable, then call the real Continue
for each task. Assert that the window's `spendingStop.effectiveStopMicrousd` (or the refusal code) matches the review row's
`effectiveStopMicrousd` and `outcome`. Parametrise over: a plain queued task; `requestedRunLimitUsd` binding (fix 3); an own-source task
without a proof (fix 1); spend at or above the stop (fix 2); and a $0 stop. This is the M1 item 12(a) test as specified.

### 5. The emergency off-switch is blocked by malformed policy content

`writeTaskStopEnrollment` calls `companySource` first for every edge. `companySource` (`task-stop-enrollment-common.ts`) throws
`TASK_STOP_CONFIG_INVALID` when `policy` fails `TaskStopCompanyPolicySchema` or a stray ceiling field is present. If an enabled company's
row ever becomes malformed, admission fails closed for all work (correct), but the owner also cannot turn enforcement off. Turning it off
is the recovery path. GET enrollment fails the same way, so the UI cannot even show the state.
Change: split `companySource` into a minimal identity parse (`pk`, `sk`, `orgId`, `entityType`, positive safe-integer `revision`,
`enrollment {version:1,state}`) used by GET and by the `disabled` edge, and the full content validation used only by review, ready and
enable. The full-row native condition on the disable Put stays.
Test: enabled row plus `ceilingMicrousd: 1` (and, separately, a `policy` that fails the schema). GET returns 200 with state `enabled`.
Disable with a fresh session returns 200, revision +1, one audit, and the malformed field is preserved unchanged.

### 6. A project registered while `ready` makes enable impossible

`project-registration.ts:416-421`: while the policy is `ready`, a new project gets a condition on the policy row but no `PROJECT_AI`
task-stop item. `ready` never expires, so this is likely. Afterwards every review fails with `TASK_STOP_CONFIG_MISSING`, because readiness
requires `taskStopPolicy` on every catalog project. Enable maps that to `CHANGE_STALE`, and the UI says "Resolve pending Spending
changes". The project is never named. Going `ready -> disabled -> ready` does not help either. The only repair is to find the project and
initialise its stop in the project editor.
Change: when the policy is `ready`, use the enabled branch's items (`taskStopProjectCreationItems` plus the policy snapshot condition).
`ready` has no money effect, and an `inherit` row is what enable would require anyway. Keep the condition-only branch for `disabled`.
Also return the first unprepared resource kind and name in the readiness refusal (owner-only route; project names are already shown in
the review), and show it in the UI (fix 8).
Tests: (a) policy `ready`, register a project, and the `PROJECT_AI` row has `taskStopPolicy: {schemaVersion:2, kind:"inherit"}`;
(b) after that, `ready -> disabled -> ready -> enabled` succeeds (the new project changes `sourceDigest`, so the old review is
correctly stale); (c) the existing `enrollment-off` disabled test still shows no `PROJECT_AI` Put.

### 7. The 25-active-task cap means many real companies can never enable

`captureCompanyCutover` refuses the whole review (`TASK_STOP_REVIEW_TOO_LARGE`) at 26 non-closed, non-COMPLETE tasks. The cap came from
M1 when every task row was fenced in the transaction. After M1 item 3, tasks add zero transaction actions, and the only remaining
constraint is the wire/row size. Idle, unclosed tasks pile up, so "26 active tasks" is an ordinary state, and the suggested "staged
enforcement cutover" does not exist.
Change: classify up to a larger bound (e.g. 100 tasks, matching the existing 500-workspace and 100-page bounds, with bounded concurrency).
Return per-outcome counts for all of them plus at most 25 listed impacts, ordered refuse first, then new-window, then the rest, with
`truncated: true` when the list is cut. The review row stays under 128 KiB. Raise `TaskStopEnrollmentResultSchema` maxima to match.
If the controller prefers to keep 25, record that as an owner-visible product limit in HANDOFF.md and make the UI message say exactly
that (fix 8). Do not leave it implicit.
Tests: 26 queued tasks give a 200 review with counts summing to 26, a list of 25 or fewer, and `truncated: true`, and enable succeeds;
bound+1 still refuses with no writes.

### 8. UI: show the server's reason, not one generic message

`packages/ui/src/api/task-stop-enrollment.ts` turns every non-REAUTH failure into "Could not confirm enforcement. Resolve pending
Spending changes, then reload the review." So TOO_LARGE, CONFIG_MISSING/INVALID (with fix 6's resource name) and AUDIT_UNAVAILABLE all
give wrong guidance. `CHANGE_STALE` at enable usually means sources changed since `ready`, and a fresh review cannot fix that: binding
`sourceDigest` must match. The right instruction there is "Cancel setup and review again".
Change: map codes to fixed owner-facing texts: TOO_LARGE; CONFIG_MISSING/INVALID with the resource; CHANGE_STALE separately for the
ready and enable steps; AUDIT_UNAVAILABLE. Never echo raw server text except the checked resource name through `VisibleText`.
Tests (`tests/web/admin-budgets.test.ts`): one per code, asserting the text and that no PUT follows.

### 9. Close the remaining REAUTH test gap

`sessionsEndedAt` is tested only on `GET ?fresh=1`. Add `"sessions-ended"` (identity row `sessionsEndedAt` after the session's
`startedAt`) to the loss table at `task-stop-enrollment.test.ts` ~line 138, for both enable and disable, expecting `REAUTH_REQUIRED`
and no writes. Also add a commit-time race for it in the "fences concurrent ... loss" table. The identity row is in the authority group
today, so that race returns `FORBIDDEN`. Either move the `DEVELOPER#` identity key into the session group in `classifier` so it returns
`REAUTH_REQUIRED` (preferred: the person is still an owner and only needs to sign in again), or pin `FORBIDDEN`. Write the choice in
DESIGN.md.

## Optional suggestions

- One task whose own admission would refuse (an archived custom agent, `TASK_STOP_CONFIG_INVALID` in
  `captureTaskStopSnapshot`) currently fails the whole company review. Consider classifying that task as `refuse_next_admission`, which is
  what Continue will do, rather than blocking enable. Keep company-wide readiness failures fatal.
- "Turn off enforcement" is one click for the largest money loosening. A confirm step ("Company task stops will no longer apply to new
  admissions") costs nothing, because the component is lazy.
- Rename the owner's entry button when the state is already `enabled` (it says "Turn on enforcement" and opens the off-switch).
- The registration change adds one ConditionCheck to registrations while `disabled`. That is behaviourally invisible unless enrollment
  moves mid-registration, but it is not literally byte-identical. Say so in HANDOFF.md so the acceptance line is honest.
- In the bound test, also assert the enable transaction's exact `TransactItems.length` at W=80 (93 with the current fixed set). Then a
  future extra fence that breaks the 94 claim fails loudly.
- `write()` re-runs `ownerChecks` in its catch even for non-ambiguous refusals. That is fine, but a comment would help the next reader:
  "an owner demoted after a lost ack gets FORBIDDEN although the change committed; the receipt is still authoritative."

## Test spot-checks (failure without the guard)

- "requires recent interactive sign-in: future": removing the `authTime > now` check makes `isFreshSignIn` accept a negative age, so the
  test fails. Meaningful.
- "fences concurrent removed loss at commit": without `budgetActorChecks` in the transaction the Put commits, so it fails. Meaningful.
- "one-step source bound +1 refuses": changing 80 to 81 lets +1 through, so it fails. Meaningful, though it does not pin 94 (see
  optional).
- "complete review digests are stable across the ready revision bump": including the company revision in the digest breaks it.
  Meaningful.
- "review classification matches the real enrolled admission": **not meaningful**. It passes with wrong task inputs (see fix 4).
- No test over-specifies implementation. Exact error codes, the response field names and the PUT-count in the e2e are contract.

## Overlap with 0.5.4 (cb3a087a0)

- `git merge-tree ec8bd9baf cb3a087a0`: **one textual conflict**, in `packages/contracts/src/web.ts`. Both branches append exports at
  end of file (live-buttons adds `live-interaction`/`live-ask`/`live-diagnosis`). Resolve by keeping both blocks.
  `packages/contracts/web-safe-files.json` and `tests/web-e2e/support/mock-cell.ts` auto-merge.
- S1 (`agents/budget-authority.ts`, `agents/store.ts`): only adds `archiveActorChecks`, `fenceRefusal` and `destinationChecks`.
  `budgetActorChecks` is unchanged, so there is no semantic conflict. The agent `status` values this review accepts (`active`,
  `archived`) are unchanged.
- S3 email scrub, close-dialog and IPv6 fixes: no shared files.
- Re-measure the initial bundle after merging 0.5.4. Live-buttons adds session-page code. Report before/after at M3.

## Next

Make fixes 1 to 9, rerun the 21 files plus the new Continue-driven test file(s), the strict shards for the touched packages, Chromium
`admin-spending.e2e.ts`, and mutation checks for the new exempt, identity-helper, lenient-disable and ready-registration guards.
Then write M2-FIXES in HANDOFF.md and proceed to Tasks 2 to 4. Task 2's start preview must call the same identity helper (fix 3), so
it shows the stop that admission will apply.
