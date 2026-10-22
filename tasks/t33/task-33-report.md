# Task 33 report: monthly requests and top-ups

**Status: DONE_WITH_CONCERNS.** The concerns are listed at the end.

- **Where:** branch `feat/agents-33`, from `origin/feat/agents-32` at `75b0f7f9` (Task 32, in review). Built on the second Mac (`~/web/Rovara-cloud`).
- **What was not touched:** no AWS, no secrets, no installs (the lockfile is unchanged), and no golden fixtures. `rovara-code-golden` passes.
- **Memory rule:** heavy commands went through `heavy.sh` with `--maxWorkers=2` and named files. One exception: a single early stricter-typecheck run (`tsc -p tsconfig.lint.json`) went outside the lock by mistake.

## Commits (all end with the Opus 5.5 Co-Authored-By line)
| Commit | What it does |
|---|---|
| `81c39546` | test: the failing tests (RED), with the contract and stubs they import; the spend request tests now share one world (`tests/support/spend-world.ts`) |
| `6e923991` | feat(broker): monthly spend requests routed to the budget owner |
| `a4a19940` | test: a month's top-up is the amount approved (found by the mutation run) |

## RED evidence
- **Command:** `heavy.sh npx vitest run tests/contract/spend-requests-month.test.ts --maxWorkers=2`, on `81c39546` after `tsc -b packages/contracts`.
- **Result:** 17 failed, 2 passed, out of 19.
- **Why they failed:** they hit the stubs (`Error: not implemented`), found no month request (`expected undefined`), hit the missing `POST /v1/app/spend-requests` (404 "route not found"), or got Task 32's admin-only routing for months.
- **The 2 that passed:** the `MONTH_APPROVERS` key list (the stub's table) and the `suggestedMonthTopUpUsd` contract.

## GREEN, tests and counts
- **`spend-requests-month.test.ts`:** 20 passed.
- **`spend-requests-run.test.ts`:** 58 passed. It now uses the shared world; no behaviour changed.
- **Related suites:** 18 files, 963 passed. These are both spend-request files, budget-settings, agent-lifecycle, spend-ledger, admission-levels, audit-contracts, agent-run-start, agent-run-engine, payer-place, decide-wiring, decide-presence, budget-exhausted, budgets, agent-approvals, budgets-private-install, org-members and rovara-code-golden.
- **Wider family:** 141 files (developer, task, workflow, slack-workflow, page, app, agent, approval, write, model-access, budget, org, creator, stuck, outbox, e2e-workflow, feedback), 4,301 passed, 0 failed.
- **`npm run typecheck:all`:** clean (stricter check 0, baseline 0).
- **eslint:** clean on every changed file.
- **PF3:** the full contract suite was not run.

## What was built
- **A month's pause** (`requestForPausedTask` → `requestForMonth`): a task stopped by a member, project, agent, org or testing budget is written at `pausedTasksKey(orgId, pauseKey(scope), taskId)`.
  - It then asks for one `month` request per (month, scope, requester); a pause asks as `system`.
  - The amount is `suggestedMonthTopUpUsd(limit)` = max(10, ceil(limit × 0.2)), and the new limit is the effective limit plus that amount.
  - A scope with no limit asks nothing (R47).
  - The task event names who was asked, for example "Your monthly AI budget is used up. I asked an admin to add $10 for this month."
  - The task view's `paused.spendRequestId` finds the month's request.
- **`MONTH_APPROVERS: Record<BudgetScope["kind"], MonthApproverRule>`:**
  - Member, project, testing and org go to the org's owners and admins.
  - An agent goes to its owner (the member; a project agent's maintainers) while two things hold:
    - the new limit stays within `maxAgentMonthlyUsd`;
    - `ownerEffectiveTotal` plus the top-up stays within `ownerAgentBudgetCapUsd`.
  - Otherwise, and for a built-in, it goes to the admins.
  - `spendApprovers` uses the table for `month`, so it is read live on every decision (R68).
- **`ownerEffectiveTotal(deps, { orgId, owner, month })`:** sums every `OWNER_TOTAL_CONTRIBUTORS` entry.
  - Agents are registered now: each agent's base plus this month's top-up, from the store's new public `ownerAgents`. Plan 4 pushes chains onto the same array.
  - It returns the owner counter's `version`, read before the sum.
- **Race safety (R4-6):**
  - The owner counter now carries `version`:
    - `ensureOwnerTotal` writes 0;
    - every Task 28 counter update bumps it (`withVersionBump` in `ownerTotalItems`);
    - `rebuildOwnerTotal` bumps it;
    - every agent-scope top-up approval bumps it.
  - Routing records `ownerVersion` on the request.
  - An owner's approval holds an `UpdateItem` on the counter, conditional on the version just summed at (`ownerVersionItem`), and bumps it.
  - If that condition alone fails, the request is re-routed with the approvers read once more (to the admins when now over the cap), audited as `spend_request.rerouted` mode `recounted`, and nothing applies. The answer is the PENDING request with `rerouted: true`.
  - An admin's approval of an agent top-up bumps the version without a condition.
- **Approval** (`decideMonth`):
  - ADDs the top-up (`topUpKey(org, request month, scope)`) for the approved amount, in the transaction that ends the request, with its audit and R18 item.
  - Then `resumeMonthTasks` goes through every task under the scope's `pausedTasksKey`. In one transaction per task it deletes the item and removes the pause, conditional on the pause it was listed with and on the task being open. It then resumes through Task 32's `resumeTaskAfterSpendApproval` with `resetRunWindow: false`, which includes the R60 creator check.
  - A task that closed, or now waits on another limit, only loses its item.
- **Denied:** the tasks stay paused and listed.
- **Expiry:** the sweep's `expireOne` ends the request (audited) and deletes the scope's `pausedTasksKey` items. The tasks stay paused and their owners may ask again. A request past `expiresAt` reads `EXPIRED` in every view before the sweep reaches it.
- **Routes:**
  - `POST /v1/app/spend-requests` [member]: `{ requestId, kind: "month", scope, amountUsd, reason }`, with a strict schema.
    - The caller must be able to ask for that scope: their own month or testing allowance (merged ids count as their survivor), a project they have a role on (else PROJECT_NOT_FOUND), an agent they may `use` (else 404), or the org.
    - R18 applies. One open request per (month, scope, requester): asking again answers the open one with 200.
  - `GET /v1/app/spend-requests?status=PENDING` lists what the caller may decide plus their own requests; any other status is CONFIG_INVALID.
  - Deciding stays `POST …/decide`, through `requireDecideSession` only (R66).
- **Contracts and audit:** `suggestedMonthTopUpUsd`. `auditSpendRequestRerouted` gains mode `recounted`, which names no member in `related`.

## Mutants
The script is `scratchpad/t33/mutate.py`. It names this worktree and branch, refuses a dirty tree and restores each file from git; every run was committed first.
- **Count:** 14 mutants over requests.ts and owner-total.ts.
- **First run:** 13 killed. The survivor ("top-up adds the approved amount") drove the test in `a4a19940`; it is now killed.
- **Final:** 14 of 14.
- **Covered:** the guardrail, the owner cap, top-ups counted in the total, the version condition, the lost race re-routing, resuming only tasks paused on the scope, expiry dropping items, the view reading EXPIRED, the list including your own, the status filter, the approved amount, budget scopes asking, "only your own month", and budget writes bumping the version.

## Checklist items judged not to apply
- **12 (IAM):** no IAM change. The broker already writes the State table without leading-key limits; the new keys (`PAUSED_TASKS#`, `TOPUP#`, `SPEND_REQUEST_FOR#MONTH#…`) are covered. No infra file changed, so the policy group sizes are unchanged.

## Pre-flight
1. **Same transaction:** done. The request's creation, end, top-up, version check and bump, and audit (create, decide, expire, re-route) commit together; each task's item deletion and pause removal commit together.
   - Not atomic with the request: the paused-task item (written before the request; a repeat of the pause rewrites it), and each resume after the approval (see item 9).
2. **Replay (R18):** done for `POST` (stored answer; another body is CONFIG_INVALID) and for decide (Task 32).
3. **Conditions on what was read:** done. The counter version, the record being PENDING, and each task's pause `at` and open state; a lost race re-reads and re-routes.
4. **Tenancy:** done. Keys come from the caller's org; another org's id is NOT_FOUND (test).
5. **Nothing learned below view:** done. Agents the caller can't use are 404; projects without a role are PROJECT_NOT_FOUND; lists show only what the caller may decide or asked for.
6. **Fail closed:** done. A scope with no limit refuses; approvers who left fall to admins (Task 32); an unreadable policy or guardrail throws.
7. **Validate at every boundary:** done. Strict body schema, scope ids, positive capped amounts, and the reason cleaned and capped at 300 code points (Task 32's `cleanReason`).
8. **Untrusted output:** done. The reason is cleaned and the page escapes (21a).
9. **Partial failure:** a resume that fails after its pause was removed is logged, and the owner's Continue goes on. An item written without a request is cleared by the next approval or expiry of that scope; a pause asks again the next time.
10. **Tests prove the fix:** RED recorded; 14 of 14 mutants killed.
11. **Live data:** done. Approvers, the guardrail, the policy, the owner total and its version are read at each routing and decision.
12. **IAM:** no change.
13. **Memory rule:** followed (one slip, noted at the top).

## Hand-offs
- **Task 35 (CLI and MCP):**
  - `POST /v1/app/spend-requests` `{ requestId, kind: "month", scope, amountUsd, reason }` answers 201 when created and 200 with the open request when one is already open for the same month, scope and asker. It is 403, 404 or PROJECT_NOT_FOUND for a scope the caller can't ask for.
  - `GET /v1/app/spend-requests?status=PENDING` lists the caller's own requests plus the ones they may decide.
  - A request past its time reads `status: "EXPIRED"` before the sweep.
  - An owner's approval that lost a race answers `{ spendRequest: { status: "PENDING", approverRole: "org_admin", … }, rerouted: true }`, which a client should show as "this now needs an admin".
- **Task 36 (display):**
  - A task stopped by a month's budget shows `paused { reason: "budget", scope: { kind: "member" | … }, spendRequestId, message }`, with the month words above.
  - Top-ups appear in the limits that `effectiveLimits` and the spend routes already read.
- **Plan 4 (chains):** push a chain contributor onto `OWNER_TOTAL_CONTRIBUTORS`, bump the owner counter's `version` (`ownerVersionItem(table, orgId, owner)`) on every chain budget or top-up change, and add `chain` to `MONTH_APPROVERS` (and the scope schema).

## Task 37 staging
1. A member pause in a real cloud org: the admin approves on the page, the member's proxy limit rises at the next mint (`ensureSynced`), and the paused task continues.
2. An agent owner's approval of a top-up that fits, and one that crosses the cap (it goes to an admin).
3. The settlement event shows `escalate-owner-requests` expiring a month's request after 7 days (a time-shifted check).

## Files changed
- `packages/broker/src/spend/requests.ts` (+342), `spend/owner-total.ts` (version helpers), `agents/store.ts` (`ownerAgents`, versioned counter writes), `aws/developer-tasks.ts` (the view finds month requests), `audit/events.ts` (`recounted`), `contracts/src/spend.ts`.
- Tests: `tests/contract/spend-requests-month.test.ts` (new), `tests/support/spend-world.ts` (new; the world Task 32's tests used, moved), `tests/contract/spend-requests-run.test.ts` (imports the world).

## Concerns
1. **Task 32 is still in review.** If its fixes change `requests.ts`, merging them here will touch the same functions: `spendApprovers`, `decideSpendRequest` and `createSpendRequest`.
2. **Two open month requests for the same scope** (the system's from a pause and a member's own): approving one resumes every listed task, and expiring the other also drops the listed items. A task dropped that way stays paused until someone asks again or continues it.
3. **The paused-task item is written just before the request**, not in its transaction (so a pause that finds an open request still lists its task). An item can briefly exist with no request; the next approval or expiry of the scope clears it.
4. **An admin's approval of an agent top-up** bumps the owner version without a condition (an admin's decision is not held to the cap). This is by design, but it means an owner's concurrent approval re-routes.
5. **Moving the test world to `tests/support/spend-world.ts`** touched Task 32's test file (imports only).

---

# Fix round 1

**Status: DONE.** Every finding in `review-out/task-33-review.md` (1 Critical, 5 Important, 11 Minor) is fixed, and each probe P1 to P7 is now a test.

- **Where:** branch `feat/agents-33`. Built in a cloud session (Node 22.22.0, `npm ci --engine-strict=false`).
- **What was not touched:** no AWS, no secrets, no installs (the lockfile is unchanged), and no golden fixtures.

## Commits (all end with the Opus 5.5 Co-Authored-By line)
| Commit | What it does |
|---|---|
| `a56c579` | Merge `origin/feat/agents-32` (Task 32 fix round 1: `7c20568`, `a971a6b`, `2fbae3b`) |
| `e31f991` | test: the failing tests (RED): P1 to P7 and the minors |
| `71b41b9` | fix(broker): the fixes |

## Step 1: the merge
- **Text conflicts:** `requests.ts` (imports, `decideSpendRequest`, and the block after `decideMonth`) and `spend-requests-run.test.ts` (imports, and the inline test world).
- **`requests.ts`:**
  - `decideSpendRequest` keeps Task 32's `closedTask` and `refused` paths, then routes `month` to `decideMonth`.
  - `decideMonth`, `agentBudgetOwner` and `reroute` sit before Task 32's held-start section.
  - `expireOne` keeps Task 32's `because` argument.
- **The test world:** Task 32's new `shareWith` helper moved into `tests/support/spend-world.ts`. The run test keeps its imports from the shared world, plus Task 32's `capturingAuditDeps`.
- **One type fix in the merge:** `forgetPausedTasks` takes the narrower deps type that `expireOne` has.
- **Checks on the merge commit:** `tsc -b` and `typecheck:all` are clean. `spend-requests-run` and `spend-requests-month` pass (98 tests) before any fix.

## RED evidence
- **Command:** `npx vitest run tests/contract/spend-requests-month.test.ts --maxWorkers=2` on `e31f991`.
- **Result:** 18 failed, 21 passed. The 21 are the earlier tests; each of the 18 new ones fails on its own assertion, with no setup errors:
  - P1: no `rerouted`.
  - P2: the raise answered 200.
  - P3 and the prune test: the items were gone.
  - P4: routed to `agent_owner`.
  - The sole-owner test: FORBIDDEN.
  - P6: still `agent_owner`.
  - P7: no resume item.
  - P5: an item was left.
  - M-2: the pause was removed.
  - M-3, M-4: wrong expiry, no `spendRequestId`.
  - M-7: the scope was stored as the duplicate.
  - M-8: `newLimitUsd` was shown.
  - M-9: no re-route.
  - M-10: no `differs`.
  - The I-1 race: the write applied.

## What changed
- **C-1, one read per decision:**
  - `mayDecideNow` answers the `SpendApprovers` it read, and `decideMonth` takes them; it no longer calls `spendApprovers` again.
  - When that read routed to the agent's owner (`approvers.owner` is set), the version item is conditional on its `version`. A route to `agent_owner` without the owner's figures fails closed.
  - A failed condition re-routes as before.
  - **P1 test:** a third agent's $15 raise lands just after the authorising read. The request ends PENDING, `rerouted: true`, `org_admin`, with a top-up of 0, and the `spend_request.rerouted` audit with mode `recounted` is flushed (M-5).
  - **One change from the probe:** the probe raised on the *second* `ownerAgents` call. With one read per decision there is no second call before the write, so the test raises just after the first read (the authorising one). The old code fails this test.
- **I-1, the cap is on the effective total:**
  - **Ruling taken:** the cap covers base plus this month's top-ups, the figure Task 33 routes on.
  - `holdingCap` (agent routes) passes `effectiveOwnerCap` (requests.ts) to `ownerBudgetRefusal`. That reads `ownerEffectiveTotal`: the total, the counter's base and the counter's `version`, all from one read of the counter item.
  - An over-cap change gets Task 28/32's 202 `NEEDS_ADMIN_APPROVAL` answer.
  - Otherwise the store gets `OwnerCap.seen`. `ownerTotalItems` holds the owner's raise to the cap less the top-ups, **and** to the counter's `version` (`atVersion`), so a top-up approved after the read fails the write.
  - On that refusal, `holdingCap` reads again: if the change is now over the cap it asks an admin, and if only the version moved it writes once more.
  - Rovara's own moves (`noteOwnerCap`) still check the counter alone. Doc comments were updated in owner-total.ts, store.ts (`OwnerCap`), settings.ts and routes.ts.
  - **P2 test:** the $15 raise answers 202 and the budget is unchanged, while a $10 raise still answers 200.
  - **Race test:** a top-up approved between the route's read and the store's write makes the write refuse.
- **I-2, expiry keeps the items:**
  - `forgetPausedTasks` is replaced by `prunePausedTasks`, which deletes only the items whose task is gone, closed, or no longer paused on that scope.
  - P3 is a regression test, the old expiry test now expects the item to stay, and a new test covers the prune.
- **I-3 and M-11, month requests carry `requestedFor`:**
  - A member's own request is for the asker (the survivor). A pause's request is for the task's starter (`startedBy`, else the owner).
  - `starterMayDecide` treats `month` like `max_per_run`: never, unless the person is the org's only owner or admin. `withoutStarter` then routes to the others, falling back to the org's other owners and admins.
  - `mayDecideNow`'s "the asker" branch uses the same rule for `month`.
  - **Tests:**
    - P4: routed to `org_admin` [Ada, Deb]; Maya is FORBIDDEN and Deb approves.
    - The sole owner approves their own member month.
    - A pause's request is FORBIDDEN to its starter (Deb), and Ada approves it.
  - Month requests still don't escalate; with this routing nothing is left to escalate to.
- **I-4, the live limit:**
  - `unclampedAgentLimit` is the agent's base plus this month's top-up, before the clamp. `agentMonth` routes to the admins when that plus the amount is over `maxAgentMonthlyUsd`.
  - `decideMonth` refuses (CONFIG_INVALID, the request stays PENDING) any agent approval whose new limit is over the guardrail, whoever decides.
  - **P6 test:** the second $15 goes to the admins, Maya is FORBIDDEN, and Deb is refused. A $5 approval (exactly $50) is the owner's again and applies.
- **I-5, retried resumes:**
  - The transaction that removes a pause also writes a due item (`HELD_SPEND_STARTS`, `resume: "month"`, Task 32's held-start list), and the item is deleted after a successful resume.
  - `retryHeldStarts` handles these items: it resumes the task again, or drops the item once the task is gone, closed or paused again, or after 7 days.
  - **P7 test:** the failed task has an item, the next settlement run resumes it (`heldStarts: 1`), and the item is gone.
- **Minors:**
  - **M-1:** the paused-task item is written after the no-limit check, and still before the open-request lookup (the order the review asked to keep).
  - **M-2:** the pause removal is conditional on the listed `pausedAt`. The item's delete is also conditional on it, so a listing a new pause wrote is kept.
  - **M-3:**
    - A month request expires after 7 days or at the end of its UTC month, whichever comes first.
    - The task view looks for the request by the pause's month first, then the current month.
  - **M-4:** the task view also looks in the slots of the task's starter and owner, not only `system`.
  - **M-5:** the re-route audit is asserted in the P1 test.
  - **M-6:** a test closes the task between the approval's read and its write: the task is neither unpaused nor resumed, and no resume item is left.
  - **M-7:** a member or testing scope is stored as its survivor.
  - **M-8:**
    - `spendRequestView` takes the viewer: an org-scope request leaves out `newLimitUsd` for anyone not an owner or admin. This applies to the POST answer, the list and GET.
    - On an install where the org has no monthly limit, a non-admin's org-scope ask gets "you can't ask for more of that budget".
  - **M-9:** an owner's approval carries a ConditionCheck on the spend policy revision that `agentMonth` read. A failure re-routes (test: an admin lowers the cap to $85 mid-decision).
  - **M-10:** asking again with a different amount or reason answers 200 with `differs: true`.
  - `spendRequestView` also hides the stored `topUpMonth`.

## GREEN, tests and counts
- **`spend-requests-month.test.ts`:** 39 passed (21 earlier + 18 new).
- **`spend-requests-run.test.ts`:** 78 passed (Task 32's fix round included).
- **Related suites:** 20 files, 1,124 passed. These are the 18 files listed above plus `agent-routes` and `audit-hooks-plan3` (the agent budget route and the spend policy route are touched).
- **`npx tsc -b`:** clean.
- **`npm run typecheck:all`:** clean (stricter check 0, baseline 0).
- **eslint:** clean on every changed file. It needed `NODE_OPTIONS=--max-old-space-size=6144` here; the default heap ran out.
- **Quick mutants:** each was killed by one new test, and the sources were restored from a copy:
  - no version condition on Task 28's raise;
  - the policy ConditionCheck not treated as a race;
  - no month-resume retry;
  - `month` dropped from `starterMayDecide`.
  - The review's survivors M3, M4 and M5 are now covered by the M-5, M-6 and M-3 tests.

## Notes and left as they are
- **A pause's request** is for the starter of the first task that paused on the scope. Starters of later tasks paused on the same scope are not excluded (one request per month and scope).
- **A Continue (Task 32) doesn't withdraw a month's system request** (it lives in a `MONTH#` slot). Its later approval just drops the item for that task, as the review judged acceptable.
- **An admin's agent top-up still bumps the version without a condition** (Concern 4). Two admin approvals racing on one agent can each pass the live guardrail check. The clamp still holds the money, so this is left as it is.
- **Task 37 staging:** add an owner's budget raise refused after a top-up (I-1), and a month request made on the 30th expiring at midnight UTC (M-3).

# Fix round 2

Source: `origin/review/task-32-33-recheck-1:review-out/task-32-33-recheck-1.md`. Every first-round finding was RESOLVED there; this round fixes the new Important finding (N-1) and both minors. Tests came first, and each RED run is recorded below.

## RED (before the fix)
All runs are in `tests/contract/spend-requests-month.test.ts`, under `describe("fix round 2 …")`, with `--maxWorkers=2`.
- **N-1:** 3 failed and 1 passed. The owner move, the unarchive and the `set_accountable` variants each got **200** instead of 202. The no-top-up control (N1c) already got 202.
- **Minor 1:** 2 failed.
  - The month resume item of a removed creator was still there after the sweep (`month_resume_failed`, AgentXError).
  - The slow-retry sweep answered `expired: 0`: the retries had used the whole budget.
- **Minor 2:** 2 failed. Both racing admin approvals applied, for a custom agent and for a built-in one. The top-up reached $30, past the $50 guardrail on a $30 base.

## Fixes
- **N-1** (`agents/routes.ts` `holdingCap`, `spend/settings.ts` `ownerBudgetRefusal`):
  - When the change makes the agent count for a new owner (an owner move, a new accountable maintainer, an unarchive), `holdingCap` reads the agent's `readTopUp` for the current month.
  - `ownerBudgetRefusal` (new `carriedUsd` argument) adds it to that owner's `deltaUsd` and to `seen.extraUsd`. The store's condition `counter + base ≤ cap − extra` therefore holds it too.
  - When the owner stays the same, nothing is carried.
- **Minor 1** (`spend/requests.ts`):
  - A month resume refused with `TASK_ACCESS_DENIED` (the creator was removed, R60) or `FORBIDDEN` (the owner can't act in the org) is deleted. The delete is in one transaction with a new system audit event, `spend_request.resume_dropped`:
    - target: the task;
    - `related`: the spend request;
    - facts: `kind`, `cause: "member_left"`.
  - The new action is added to `AUDIT_ACTIONS` and `AUDIT_FACT_KEYS`, and `audit-contracts.test.ts` is updated to match.
  - `retryHeldStarts` now has its own deadline: `min(500 ms, budgetMs / 4)` from the start of the run. Expiry and escalation always run after it.
  - If the retries didn't finish, the run reports `complete: false` (logged as `sweep_incomplete`), and the next run starts with them.
- **Minor 2** (`decideMonth`), on the admin path of an agent top-up (no owner read carried):
  - The owner counter's version is read before the limit, and the write is conditioned on it.
  - The top-up `Update` is conditioned on the amount the guardrail check added up (`amountUsd = :seen`; when nothing was seen, absent or ≤ 0).
  - A built-in agent has no counter, so only the top-up condition applies to it.
  - If either condition fails, the approval is refused with `AGENT_REVISION_CONFLICT` and the request stays PENDING. Deciding it again checks the live limit, so the test's second $15 gets CONFIG_INVALID and $5 applies.
  - The owner path is unchanged (it re-routes on a version change).

## GREEN
- `npx tsc -b`: clean.
- `npm run typecheck:all`: clean (stricter check: 0 errors, baseline 0).
- `spend-requests-month`, `spend-requests-run`, `budget-settings`, `budgets` (`--maxWorkers=2`, from the repo root): **4 files, 262 passed.**
  - `spend-requests-month` has 47 tests (39 before, plus 8 new).
- Neighbouring suites: `agent-routes`, `spend-ledger`, `audit-contracts` and `audit-hooks-plan2` ran together, **4 files, 256 passed**.

## Left as they are
- **N-1 race:** a top-up approved for the moving agent by its old owner, between the move's read and its write, is not covered by the new owner's version condition. The old owner's approval is held to the old owner's version, and the move bumps that version without being conditioned on it.
- **Minor 2, built-in base:** a built-in agent's base raised during an admin's top-up decision isn't conditioned on. The guardrail clamp still holds the money.
- **Held-start gaps** (both are as before):
  - A held start (`firstDispatch`) whose creator left is not dropped early. It still gives up when its time runs out.
  - Retries that keep failing at the head of the list still use up the retry share before later items.
- The earlier note above, "an admin's agent top-up still bumps the version without a condition" (Concern 4), is resolved by Minor 2.
