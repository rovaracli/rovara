# Task 32 report: run-limit, planning and max-per-run requests

**Status: DONE_WITH_CONCERNS.** The concerns are listed at the end.

- **Where:** branch `feat/agents-32`, started from `53ce7170` on `feat/agents-plan3`. Built on the second Mac (`~/web/Rovara-cloud`, 48 GB RAM).
- **What was not touched:** no AWS, no secrets, no installs beyond `npm ci`, and no golden fixtures or `SHA256SUMS`. `rovara-code-golden` passes.
- **Memory rule:** every heavy command went through `heavy.sh` with `--maxWorkers=2` and named files. One exception: a single early vitest run of the new test file was started without `heavy.sh` by mistake.

## Commits (all end with the Opus 5.5 Co-Authored-By line)
| Commit | What it does |
|---|---|
| `32fd969e` | test: the failing tests (RED), with the contracts and the throwing stubs they import |
| `f88aa5b9` | feat(broker): run-limit, planning and max-per-run requests that resume in place |
| `ced8aa09` | fix: superseded keys documented as safe to finalize at once; a lost finalize gets its window; pinned tests follow the 202 owner-cap answer and the escalation job; lint |
| `11d844de` | fix: an approval's resume checks that the creator is still a member first (R60); tests the 202 replay |
| `5d1e8758` | fix: a request's end frees exactly the slot it took; tests for the decision's guards, found by the mutation run |
| `92d139c1` | test: an approval resumes no task whose creator left, or that is still paused on another limit |

## RED evidence
- **Command:** `heavy.sh npx vitest run tests/contract/spend-requests-run.test.ts --maxWorkers=2`, on `32fd969e` after `tsc -b packages/contracts`.
- **Result:** 43 failed, 6 passed, out of 49.
- **Why they failed:** they hit the stubs (`Error: not implemented`), found no request record (`expected undefined`), or got the old answers: 400 instead of 202 for the owner cap, no escalation budget, and a key still finalized where M-2 now gives it a window.
- **The 6 that passed:** they pin behaviour that already existed (a workspace not closed, an owner transfer with room, an unarchive that fits, an ended key finalized) and the contract helpers.
- **Two harness mistakes fixed before the RED commit:** `startAgentRun(starter, …)`, and Omar's role on payments.

## GREEN, tests and counts
- **`spend-requests-run.test.ts`:** 58 passed. It started at 49; the 9 added tests came from the mutation run (below) and the R18 replay.
- **Related suites:** 17 files, 944 passed. These are spend-requests-run, budget-settings, agent-lifecycle, spend-ledger, admission-levels, audit-contracts, agent-run-start, agent-run-engine, payer-place, decide-wiring, decide-presence, budget-exhausted, budgets, agent-approvals, budgets-private-install, org-members and rovara-code-golden.
- **Wider family:** 141 files (developer, task, workflow, slack-workflow, page, app, agent, approval, write, model-access, budget, org, creator, stuck, outbox, e2e-workflow, feedback). 4,300 passed and 1 failed. The failure was `org-members`' R60 call-site pin, which found a real gap: my system Continue had no creator check. That was fixed in `11d844de`, and the file now passes.
- **`npm run typecheck:all`:** clean (stricter check 0, baseline 0).
- **eslint:** clean on every changed file.
- **PF3:** the full contract suite was not run.

## What was built
### Spend requests (`packages/broker/src/spend/requests.ts`)
- **Storage:** each request is a `SPEND_REQUEST` record, written in one transaction with:
  - the org's open index item (`openSpendRequestsKey`),
  - a global due item (new `openSpendRequestDueKey`, pk `OPEN_SPEND_REQUESTS`, which carries the org id),
  - a slot per subject and kind (new `spendRequestSlotKey`), which keeps one request pending per (task, kind) or (agent, `owner_cap`); a second pause answers the first,
  - the `spend_request.created` audit item.
- **`spendApprovers` (read live, R68):**
  - `run_limit` and `planning`: the payer while the new limit is within the lead threshold, then the project's grant maintainers (org admins when there are none) up to the admin threshold, then org admins.
  - `max_per_run`: the agent's owner (the member; the owning project's maintainers; org admins for a built-in) while the raised stop is within `maxPerRunCeilingUsd`, else org admins; after escalation, org admins as well.
  - `owner_cap`: org admins.
  - A list that names nobody who is still a member falls to org admins.
- **Who may decide:**
  - Merged duplicates count as their survivor (`resolveSurvivor`).
  - The person who asked can't decide unless they are the payer.
  - For `owner_cap`, the asking admin can't decide while another owner or admin exists.
- **`decideSpendRequest`:**
  - Validated body, plus an R18 item (a replay answers the stored result; another body is `CONFIG_INVALID`).
  - Who may decide is checked for the final amount first, then `APPROVAL_CLOSED` (decided, or past `expiresAt` before the sweep reached it).
  - One transaction holds: the record (conditional on PENDING), the index, due and slot deletions, the audit item (with the decide proof), the R18 item, and the task change (conditional on the `budgetUsd` or `maxPerRunUsd` value that was read).
  - An approved `owner_cap` request applies its stored change through the store with `overrideCap` (below).
- **Effects of an approval:**
  - `run_limit`: `budgetUsd` becomes the new limit.
  - `planning`: `budgetUsd` becomes the approved amount as a fresh window (`budgetBaselineUsd` reset).
  - `max_per_run`: only `task.maxPerRunUsd` is raised, never the agent's setting. A raise past the run limit writes the event "That is more than this run's $X run limit, so I also asked … to raise it." and then opens a `run_limit` request.
  - The task's pause is removed, except for a run held at its start (the resume takes that one).
  - After the commit, `SpendRequestHost.resumeTask` runs.
- **`escalateOwnerRequests` (PF13):**
  - Reads the global due index oldest first.
  - Expires requests past `expiresAt` (`spend_request.expired`).
  - Escalates `max_per_run` requests nobody answered within `OWNER_ANSWER_HOURS`: sets `escalatedAt` and adds org admins (new `spend_request.escalated` audit action).
  - Stops at the first request too young for either, and at its time budget.
- **Mover (PF14):** `registerMemberMover({ name: "spend-requests" })` swaps approver, requester and new-owner ids on a merge or removal.
  - Conditional on PENDING and a `moveRevision`.
  - `by: "system"`, with the new `spend_request.rerouted` audit action in the same transaction.
  - Calls `checkTime` per item.
- **Page and routes (PF21):**
  - The `spr` decide kind: `inspect` evaluates live and checks "forbidden" first; `decide` requires a `fresh_sign_in` proof and uses a session-derived request id.
  - It is registered in the broker's `decideRequestContext`.
  - The page shows Payer, Project, Task, Agent, Raises, Amount, New limit and Expires, plus the reason.
  - Routes: `GET /v1/app/spend-requests` (only requests the caller may decide now), `GET /v1/app/spend-requests/{id}` (to deciders, the asker or the task's owner; 404 to anyone else), `POST …/confirm-link`, `POST …/decide` (only through `requireDecide`; refused and failed decisions settle the session as `approval-routes.ts` does), and `POST /v1/app/tasks/{id}/continue-as-task`.
- **Pause words, exactly as in the brief:**
  - Run limit and max per run, with the asked-who wording.
  - Planning.
  - Test cap (a task event only; no request).
  - The pause message is the request's `reason`, written as a task event in the request's transaction.

### Pauses and resume
- **Where requests are made:**
  - After any task operation ends `FAILED` with `BUDGET_EXHAUSTED_FAILURE_MESSAGE` (`recordTerminalResult` → `askForPausedTask`, which never fails the worker's result). This covers plain, workflow and agent-step tasks in one place; the engine's own pause handler was not needed.
  - A run started with run limit 0 asks in `agentRunStarterOf` after the paused start commits (PF17).
- **Task 31 Minor 2:** with no `budgetPause`, the scope is derived from the task's figures at its end (test cap, else max per run / planning / run limit once the window reached the stop), written first-wins, then asked for. A budget scope (a month) asks nothing; that is Task 33's.
- **Workflow block reason:** a budget end blocks the workflow with `WORKFLOW_BLOCK_REASONS.budgetPaused`, for both the PLAN and IMPLEMENT paths.
- **`resumeTaskAfterSpendApproval`** (developer-tasks.ts):
  - Run as the task's owner by the broker host (live sign-in record and org role; nothing for a revoked or departed owner), after the R60 creator check.
  - Held start: dispatched.
  - Agent-step run: `advanceAgentRun`, which runs the same step.
  - Workflow task blocked by `budgetPaused`: `retryTaskWorkflow` as the owner, with the cap window kept unless the approval reset it (`spendResume.keepWindow`).
  - Plain task: the system Continue "Your AI budget was raised. Continue where you stopped."
  - A task still paused on another limit is left alone.
- **Held start (Task 15 hand-off):**
  - The paused start now keeps the run's pull-request checkout on `budgetPause.firstDispatch`.
  - A new `DeveloperTaskActions.preparationDispatch` rebuilds the prepare's outbox item with a new capability and repository grant (the broker's `heldPreparationDispatch` refuses a stale fence or status).
  - The resume writes the workspace charge, the outbox item, the `SETUP_WATCH` and `REMOVE budgetPause` in one transaction, conditional on the pause.
- **`continueAsTask`:** owner only (404 otherwise), and only a `test_run` paused on `test`.
  - `resolveRunPayer` with origin `app` sets `origin`, `payer`, `place` and `startedBy`, and removes the pause, in one conditional update; then the resume runs.
  - Later keys are minted for `MEMBER#owner`; earlier ledger lines stay on `TESTING#starter`.
  - The run keeps its current run limit (Task 34's tier rules aren't built yet).
- **Stale pause (Task 31 concern 1):** a human Continue and every workflow retry or send-back (`capWindowUpdate`) remove a mid-run `budgetPause`; a held start's pause is kept.
- **Task view:**
  - `paused { reason: "budget", scope, spendRequestId?, message? }`. `message` is an addition to the brief's shape (it carries the pause words for Task 36).
  - `planningSoFar`: the last PLAN operation's last assistant answer, at most 4,096 characters.
  - `testOffer { capUsd }`.
  - The task-level events of any non-workflow agent task.

### Owner cap (PF27, Task 28's and Task 11's seams)
- **Routes:** `setBudget`, `unarchive`, `setOwner` and `setAccountable` call `holdingCap`, which now opens an `owner_cap` request holding the exact change and answers `202 { status: "NEEDS_ADMIN_APPROVAL", spendRequestId, message }`. The message is "…for one person. I asked an org admin to approve it."
  - It does the same when the store's own cap check refuses after the read.
  - The request carries the route's R18 item, so a replay answers the same 202 (`waitingReplay`).
- **Store:** `BudgetWriteOptions.overrideCap { spendRequestId, items, closed }`. No cap is held (the approval is the override); the event detail names `overrideCap`, the `by` is the deciding admin, and the request's own end commits in the store's transaction.
- **Task 11's seam (`noteOwnerCap`):** it calls a hook that spend/requests registers (`registerOwnerCapConfirmation`; this avoids an import cycle). The hook opens one `owner_cap` "confirm_move" request per person while one is open. Approving it records the confirmation; the move had already applied.
- **Trial default (Task 28 ruling):** a trial org that never wrote a spend policy has `ownerAgentBudgetCapUsd` = min(100, `TRIAL_LIMITS_R49`) = $29.

### Settlement (PF13)
- The job `escalate-owner-requests` runs after `expire-approvals` and before `sweep-model-sources` and `sweep-spend`.
- It has its own 2 s cap (`SETTLEMENT_BUDGETS_MS.escalate`). The spend sweep still takes what is left.

### Task 31 carry-overs
- **M-1, documented rather than changed:** `supersedeKeys` still finalizes earlier keys at once.
  - Keeping the 120 s window for a key of the running operation brings back Task 31's I1: four `admission-levels` tests failed, because a run competes with its own earlier hold and can end early.
  - It is safe because a finalized key keeps settling for `FINALIZED_SETTLE_WINDOW_MS`, so in-flight spend is still counted, only not held. The overshoot is bounded by that key's cap.
  - A new test proves late spend settles onto the scope after the supersede.
- **M-2:** a `finalizeKey` that loses both of its tries gets `finalizeAfter` (`startFinalizeClock`), so the sweep finalizes it.
- **Nits:** the refusal now says "is used or held for work that is running ($X of $Y)" (the figure includes settled spend), and the "never live at once" comment is rewritten. The `admission-levels` pin was updated.
- **Minor 2:** the derived pause, above.

## Mutants
The script is `scratchpad/t32/mutate.py`. It names this worktree, refuses a dirty tree and restores each file from git. Every run was committed first.
- **Count:** 39 mutants over requests.ts, developer-tasks.ts, store.ts, routes.ts, settings.ts, ledger.ts and broker.ts; one was misbuilt and later rebuilt.
- **First run:** 28 killed. The 9 survivors drove 9 new tests and one real fix: a request made with its own subject freed the wrong slot (`5d1e8758`).
- **Final:** 35 of 39 killed. Each of the 4 survivors is equivalent:
  - **"Caller still in org":** the live approver lists never name a departed member (a departed payer falls to admins; project lists leave out non-members).
  - **"Decide closed status" and "end conditional on PENDING":** each one alone stops a decided request (the pre-check, and the conditional write with its re-read), so removing either single guard changes nothing.
  - **"Resume checks the creator":** the broker's task launch also refuses a removed creator (R60's pinned broker sites). This guard is required by the R60 call-site test.
- **Killed included:** thresholds, ceiling, escalation (including "only `max_per_run`"), slot, derived pause, test-cap, read-value condition, pause removal, raise past the limit, reset window, R18 fingerprint, org check, mover, expiry, page, view, list, stale pause, owner-only continue-as-task, held-start condition, override detail, 202 replay, trial default, M-2, the PLAN block reason, and asking at the budget end.

## Checklist items judged not to apply
- **12 (IAM):** no IAM change. The broker already writes the State table with no leading-key limits; the new keys (`OPEN_SPEND_REQUESTS`, `ORG#…#SPEND_REQUEST*`) are covered. No infra file changed, so the policy group sizes are unchanged.

## Pre-flight
1. **Same transaction:** done.
   - Request create holds the record, index, due item, slot, audit, task event and R18 item.
   - Decide holds the record, index, due and slot deletions, audit, R18 item and the task change (or the store change for `owner_cap`).
   - Escalate, expire and reroute each hold the change and its audit.
   - The held dispatch holds the charge, outbox, watch and pause removal.
   - A request is at most about 10 items.
   - Not in the same transaction: the follow-up `run_limit` request after a `max_per_run` raise, and the resume. Both run after the commit; see item 9.
2. **Replay (R18):** done for decide, owner-cap 202 and continue-as-task (by state). Request items expire through `indexExpiresAt`.
3. **Conditions on what was read:** done. The record is PENDING (with `moveRevision` for moves), the task's `budgetUsd`/`maxPerRunUsd`, the closed state, the slot id and the held-start operation are all conditions. A lost race re-reads before answering (`APPROVAL_CLOSED` / conflict).
4. **Tenancy:** done. Every key comes from the caller's org, records are re-checked by `orgId`, and a cross-org id gives the same 404 (tests). The global due item carries only ids and the org, and the reader re-checks the record.
5. **Nothing learned below view:** done. Forbidden is checked before ended; lists and reads show only what the caller may decide or owns; 404 texts don't echo the id.
6. **Fail closed:** done. A reset window with no proxy figure refuses (503); an unreadable or malformed record is not a request; approvers who left fall to admins.
7. **Validate at every boundary:** done. Strict bodies, `SpendRequestIdSchema`, and reasons with control and format characters spaced out and capped at 300 code points; names are cleaned as well.
8. **Untrusted output:** done. The page escapes everything (21a); reasons and names are cleaned; the view message is capped.
9. **Partial failure:**
   - The decision stands if the resume fails (logged). The owner's Continue, the workflow retry, or the engine's dispatch sweep then goes on from the raised limit; an agent run's `advanceAgentRun` is safe to call again.
   - The `max_per_run` follow-up request is also asked for by the next pause.
   - A request that can't be made at a budget end is logged, and the next refusal or Continue asks again.
   - See concern 2.
10. **Tests prove the fix:** RED recorded; mutants above.
11. **Live data:** done. Approvers, roles, policy, guardrails, membership and the owner's sign-in are read on every call.
12. **IAM:** no change.
13. **Memory rule:** followed (one slip, noted at the top).

## Hand-offs
- **Task 33 (top-ups, `month`):** budget-scope pauses (org, member, project, agent) make no request here. The view shows `paused` with no `spendRequestId`. `spendApprovers` routes `month` to org admins, and the slot and escalation machinery is ready. `kind: "month"` needs its scope on `scope`.
- **Task 34 (run limits and estimates):**
  - `continue-as-task` keeps the current run limit; plug the tier rules in there and open a `run_limit` request when they don't accept it.
  - `resume: "implement"` resets the window (built and tested through `resetRunWindow`); Task 34 creates those requests at plan approval.
  - The planning limit is still not applied at mint (planning pauses use `task.budgetUsd`).
- **Task 35 (CLI and MCP):** list with `GET /v1/app/spend-requests`, read with `GET /v1/app/spend-requests/{id}` (it carries `confirmUrl`), and get a ticketed link with `POST …/confirm-link`. A token's decide gets `REAUTH_REQUIRED` plus `confirmUrl`.
- **Task 36 (display):** `paused.message` carries the exact words; also `planningSoFar` and `testOffer`. Spend events are task-level events in the view.
- **Task 37 (staging):** see below.

## Task 37 staging
1. A real run that hits its run limit: the request appears, the page decides it, and the run continues.
2. A run started with run limit 0 (Plan 4): the approval dispatches its preparation, including a pull-request checkout.
3. The settlement event shows `escalate-owner-requests` within its 2 s cap.
4. An owner-cap 202 decided on the page by a second admin.
5. A notification of new requests to approvers does not exist yet (only lists and links).

## Files changed
- **New:** `packages/broker/src/spend/requests.ts`, `tests/contract/spend-requests-run.test.ts`.
- **Modified (contracts):** `spend.ts`, `org-scoped-keys.ts`, `audit.ts` (two actions), `developer-tasks.ts` (view fields), `task-workflow.ts` (`budgetPaused`).
- **Modified (broker):** `agents/{routes,store,lifecycle}.ts`, `aws/{broker,developer-tasks,developer-routes,developer-task-actions}.ts`, `audit/events.ts`, `developer/task-records.ts`, `spend/{admission,ledger,settings,settlement-job}.ts`.
- **Pinned tests moved:**
  - `budget-settings` (five Task 28 refusals are now 202, as their own titles anticipated).
  - `spend-ledger` and `agent-lifecycle` (the job list now has `escalate-owner-requests`; the budgets now have `escalate`).
  - `admission-levels` (the held wording).
  - `audit-contracts` (two actions).
  - `org-members` (11 `acceptTask` sites; the new one is guarded).

## Concerns
1. **M-1** was answered by documentation, not by the window (see above). If the controller wants the window anyway, it brings back I1 for keys re-minted within an operation.
2. **The held-start dispatch can fail after the approval commits** (the workspace limit is full, or the project revision is gone). The task then has its raised `budgetUsd` but stays held, and nothing retries it; the owner can close it. A retry path (a dispatch row) would close this gap.
3. **`continue-as-task`** keeps the run limit (Task 34 pending), and its R18 is by state rather than by a stored request item.
4. **Approving a move confirmation** (`confirm_move`) only records the confirmation; a DENY can't undo a removal or merge. The brief doesn't say what DENY means here.
5. **broker.ts and developer-tasks.ts grew** by about 95 and 190 lines net; requests.ts is about 1,040 lines (one responsibility). Nothing was split.
6. **The `paused.message` field** is an addition to the brief's view shape.
