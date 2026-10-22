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
