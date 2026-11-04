Verdict: PROCEED WITH CHANGES

# REVIEW-M1: Task 1, company spending-stop enrollment

Reviewer: Opus, checkpoint M1, 2026-11-04. Read-only review of aef096def (base v0.5.3, 030a4b716).
Read: M1-READY.md, DESIGN.md, HANDOFF.md, tests/contract/task-stop-enrollment.test.ts, org/task-stop-{admission,bootstrap,editing,funding,unpriced,window}.ts,
spend/requests.ts (~470-490), aws/broker/project-registration.ts (~405-420), the fresh-sign-in pattern (developer/store.ts `isFreshSignIn`,
org/setup-recipes.ts `requireFreshAdmin`, design-review/route-facts.ts `freshSignInOf`), agents/budget-authority.ts (base and feat/s1-authority-fences),
the codex brief, the task checklist and the research register.

## Test run (confirmed)

`vt tests/contract/task-stop-enrollment.test.ts tests/contract/task-stop-editing.test.ts tests/contract/task-stop-admission-snapshot.test.ts tests/contract/task-stop-enrollment-off.test.ts`
(via heavy.sh): **1 file failed, 3 passed; 50 failed, 66 passed.** Every failure is the stated reason: the new routes return `NOT_FOUND`/404
(`expected 404 to be 200`, `expected 'NOT_FOUND' to be 'CONFIG_INVALID'`, `... 'TASK_STOP_CONFIG_MISSING'`, `{status:404} to match {status:403}`).
No collection errors. RED is honest.

## Overall

The design is careful and mostly right: no disabled-to-enabled path, owner-only on native rows rather than `caller.orgRole`, fenced at
commit, receipts and outbox audit in one transaction, review is server-built and never serialises native conditions, accepted windows
are immutable, and the GSI limit is called out honestly. `ready` is already treated as `disabled` by every existing reader I found
(admission :148, unpriced :26, requests.ts :476, funding :21, project-registration :412), so `ready` has no money effect. Good.

The problems are in the parts where the design meets existing code: the company `revision` bump breaks things the design relies on
(review digests, pending second-person edits), the enable re-check is too strict to be usable, the transaction budget does not fit
the stated bounds, and project/agent readiness outside the active-task set is not checked. None needs a redesign. Fix the items below
in DESIGN.md and the tests, then implement.

## Required changes

1. **The company revision bump at `ready` breaks the review digest and the stored source checks. Say how enable compares.**
   `captureTaskStopSnapshot` puts `sourceRevisions.company` into `policyDigest` and puts a ConditionCheck on the company row's
   `revision` and `enrollment` into `sourceChecks` (task-stop-admission.ts, `presenceFields`). A review captured at revision 1 /
   `disabled` therefore can never match a re-capture at revision 2 / `ready`, and its stored checks will always fail at enable.
   DESIGN.md must say: (a) enable always re-captures with `captureTaskStopCutoverReview` and uses only the fresh `sourceChecks`, never
   stored ones; (b) the enable comparison is over an "economic projection" that excludes the company `revision`, `enrollment` and
   `capturedAt` (per task: calculationInput, effectiveStopMicrousd, approvalCapMicrousd, bindingScopes, outcome, plus the ceiling,
   project, agent, seed and model-sources revisions); (c) the review `digest` returned to the browser is over that projection, not over
   `policyDigest`. Test to add: ready, then enable with no source change succeeds (exists), AND a unit-level test that the projection
   digest of a review captured at `disabled` equals one captured at `ready` with nothing else changed.

2. **Enable must not depend on the 5-minute review captured before `ready`; let enable use a fresh review taken while `ready`.**
   As written, review -> ready -> REAUTH sign-in -> enable must all fit in 5 minutes of the first capture, and the only way out of an
   expired `ready` is an audited `ready -> disabled -> ready`. Change to: enable accepts `reviewId` = the bound review if still within its
   lifetime, OR a newer complete review captured by the acting owner at the current (`ready`) revision within its lifetime, whose
   economic projection (item 1) equals the bound review's. `ready` itself then never needs to expire. Keep the existing tests
   ("enable refuses a review that expired after ready" stays valid). Add tests: (a) ready, advance 6 minutes, capture a new review while
   `ready`, enable with it -> 200, revision 3, one `enrollment_changed` audit for enable; (b) same but the new review's economics differ
   (company default edited between) -> CHANGE_STALE; (c) POST cutover-review while `enabled` -> refused, no writes.
   Also: the UI must check sign-in freshness at the start of the "Turn on enforcement" step (before the review), so the 10-minute
   `FRESH_SIGN_IN_SECONDS` window covers review + ready + enable.

3. **Define exactly what "observed change" blocks enable. Economic drift blocks; task-inventory drift does not.**
   Enabling is monotone-tightening (see the GSI answer below), so a task that appeared or finished since the review is not a money risk.
   Blocking on any inventory change will make enable fail forever in a busy company (tasks start and finish all the time, and the GSI
   lags). DESIGN.md: enable refuses (CHANGE_STALE) only on drift of authority or economic sources (company policy content, guardrails,
   every project AI row and agent/builtin row the projection used, seed receipts, model-sources revision used for exemptions). Inventory
   differences are reported in the enable response and in the audit facts (`tasksReviewed`, `tasksAtEnable`, new-impact counts), not
   blocking. Do not fence individual task or workspace rows at enable. Tests: (a) ready, start a new queued task, enable -> 200 and the
   audit facts carry the changed count; (b) existing "enable refuses economic sources edited" stays; add guardrail-ceiling, agent stop and
   model-sources-revision variants (parametrise it).

4. **Make the transaction budget fit, with a formula and a test at the bound.**
   With the proposed fences (per-task task row + workspace, per-project catalog + AI, per-agent, plus member, pointer, org, identity,
   session, policy, guardrails, 2 seeds, review, audit, receipt) 25 tasks across distinct projects and agents is about 135 items, over
   DynamoDB's 100. Dropping task/workspace fences (item 3) brings it to about 12 + 2P + A. Write the formula in DESIGN.md, pick bounds
   that guarantee <= 100 after de-duplication (for example, at most 40 distinct project/agent sources fenced), and refuse beyond it with a
   specific code (not a generic CONFIG_INVALID) whose message says the company is too large for one-step enable. Tests: the bound
   exactly succeeds; bound + 1 refuses the review with that code and writes nothing; > 25 active tasks refuses the same way. Assert the
   real `TransactItems.length <= 100` in the success test by intercepting `send`.

5. **Pending second-person company spending changes.** `task-stop-editing.ts` requires `pending.baseRevision === s.revision` to approve
   (line ~133). Any enrollment transition bumps the revision and silently strands a pending loosening proposal forever. DESIGN.md: `ready`
   and `enabled` refuse with CHANGE_STALE ("resolve the pending Spending change first") while the company row has
   `pendingTaskStopChange`; `disabled` (an emergency path) always succeeds and, in the same Put, expires the pending change with
   `lastTaskStopChange: {state: "expired", reason: "enrollment_changed"}`, and the audit facts record it. Tests for both.

6. **Check company-wide readiness, not only the active tasks' sources.** Once `enabled`, admission throws TASK_STOP_CONFIG_MISSING
   for any project whose PROJECT_AI row has no `taskStopPolicy`, any custom agent without `stopKind`/`maxPerRunUsd`, any builtin
   without settings, or a missing upgrade/bootstrap seed receipt. Enabling a half-upgraded company stops all work in those projects. The
   existing upgrade inventories say "exhaustion is never readiness", so nothing else checks this. The review must page the project catalog,
   the agent directory and the builtin registry (bounded, consistent reads) and refuse the review (or report a blocking `not_ready`
   list) if any is unprepared. Tests: a catalog project with no `taskStopPolicy` and no active task -> review refused, enrollment unchanged;
   an agent directory entry with no stop fields -> same.

7. **Project registration across the cutover.** project-registration.ts only adds the PROJECT_AI task-stop row and the `enrollment`
   condition when it read `enabled`. A registration that read `ready` and commits after enable creates a project with no `taskStopPolicy`,
   which then fails closed for every task. Either (a) when the policy row exists and is not `enabled`, registration adds a ConditionCheck
   that `enrollment` is unchanged (no other write; outputs identical; pin with the existing enrollment-off test plus a new assertion that
   no new item is Put), or (b) enable's readiness check (item 6) is repeated on every admission miss with a clear repair path. Prefer (a).
   Test: start a registration with the policy `ready`, commit enable in the race hook, registration fails with a retryable conflict and
   a retry creates the project with `taskStopPolicy: inherit`.

8. **Disable from `enabled` should require a fresh sign-in.** Turning enforcement off removes every company stop: the largest money
   loosening in this feature, and the editing code already needs a second person for a stop loosening. The brief only says "owner-only
   and audited", so the minimum is: `enabled -> disabled` needs REAUTH (same rules as enable); `ready -> disabled` does not (no money
   effect). Whether it should also need a second owner is a product question; note it in HANDOFF.md for the controller to take to the
   owner, and don't build it. Tests: parametrise the REAUTH loss table over enable AND disable-from-enabled; ready->disabled with a stale
   session -> 200.

9. **Authority: reuse the existing fences, restricted to owner, on every write path, and test the fence on every path.**
   Reuse `budgetActorChecks` (member role = owner, pointer role = owner, org open) and `readAllowedDomainActorConditions` for identity and
   `sessionsEndedAt`; do NOT reuse task-stop-editing's `financialConditions` unchanged (it allows admin). Map cancellation reasons by
   index the way S1's `fenceRefusal` does (copy the idea; don't import from the unmerged branch). Tests: parametrise "fences concurrent
   loss at commit" over ready, enable AND disable (now only enable), and add a `removed` drift (member row and pointer deleted) -> FORBIDDEN.
   Specify the check order: authority (FORBIDDEN) -> body schema (CONFIG_INVALID) -> REAUTH -> revision/review (CHANGE_STALE), so a
   non-owner never learns sign-in or revision state. Add `future` to the REAUTH checks explicitly: `isFreshSignIn` returns true for a
   future `authTime`, so this is a new rule on top of it, not the platform rule.

10. **Tenancy on every route.** The checklist says a cross-org id gives 404 on every route, tested with a second org. Today only PUT
    ready is tested. Add: GET enrollment, POST review, PUT enabled and PUT disabled from a caller whose live pointer is in the other org
    (caller claim says `orgId`) -> FORBIDDEN or NOT_FOUND as designed, with no writes in either org; and a review id from org A used by an
    owner of org B for enable -> NOT_FOUND.

11. **Transition matrix and review ownership.** The "no shortcut" test sends `ready`/`enabled` with no review fields, so it only proves the
    schema, not the transition rule. Add a table test over every (from, to) pair with VALID review fields: allowed are disabled->ready,
    ready->enabled, ready->disabled, enabled->disabled; everything else (disabled->enabled with a valid review, enabled->ready,
    enabled->enabled, disabled->disabled, ready->ready) is refused with no writes and no audit. Add: ready->disabled succeeds with one
    audit (no test today). Add: owner B cannot mark ready with owner A's review (CHANGE_STALE or FORBIDDEN, decide and write it down),
    and state in DESIGN.md whether a different owner may enable (recommend yes, with their own fresh review per item 2).

12. **Pin the cutover classification against the real admission.** "Use the calculator's existing semantics" needs a positive control.
    DESIGN.md must state the per-task capture identity: the reviewing owner (role `owner`) as actor, the task's own agent (or
    `ROVARA_CODE_AGENT_ID` when absent, as requests.ts does), and the task's bounds through the same helpers admission uses
    (`taskRunLimitMicrousd`, `savedTaskStopBounds`, committed max-per-run). Define the inputs for `stop_at_next_admission` precisely
    (which spend figure, read from where). Tests: (a) review a queued task, enable, run the real admission for that task, and assert its
    `effectiveStopMicrousd` equals the review's; (b) one test per outcome, including `exempt` (verified own-source funding) and
    `stop_at_next_admission`; (c) a workspace-index entry whose task row is in another org, and one whose pointer is malformed -> review
    refused, never skipped; (d) an agent-run task appears once even when reachable twice.

13. **Audit events.** `spending.enrollment_reviewed` is listed but the review-capture transaction has no audit Put. Either drop the action
    (reviews are read-only; `enrollment_changed` carries reviewId and digest) or add the pending Put to the capture transaction. Recommend
    dropping it. Also require `deps.audit.tableName === deps.tableName` and the same document client (project-domain-initial.ts pattern),
    else AUDIT_UNAVAILABLE, so the outbox row really is in the same transaction. Tests: facts of each change event contain requestId,
    reviewId/digest (when present), before/after, revision and counts, and contain no task id list, title or condition text (positive
    control: the fixture task title is present in the DB).

14. **Replay gaps.** Add: (a) replay by an owner who has since been demoted -> FORBIDDEN, and the response body reveals nothing of the
    stored result; (b) POST review replay with the same requestId returns the same reviewId and writes nothing; (c) the receipt carries a
    TTL attribute (request items expire, per the checklist); (d) the lost-acknowledgement test for enable and disable, not only ready.

15. **Existing-data compatibility.** Decide where the review binding lives. Recommend a sibling field (`enrollmentReview: {reviewId,
    digest, by, at}`) so `enrollment` stays exactly `{version, state}`; all five readers then see the same shape they parse today. Test:
    write an `enabled` row exactly as M2 will and assert admission, funding, unpriced, requests' decider rule, project registration and
    `bootstrapTaskStopPolicy` all accept it; and a `ready` row with the binding behaves as `disabled` in each (today only admission is
    pinned for `ready`, in task-stop-admission-snapshot.test.ts:127).

## Tests that will make M2 brittle (alter them)

- The race and lost-ack tests hook "the first TransactWriteCommand". If enable ever writes anything first (a refreshed review, an
  audit flush), the race lands on the wrong command and the test passes or fails for the wrong reason. Match on the command that Puts the
  policy key (`orgSettingsKey(orgId, "TASK_STOP_POLICY")`) instead, and assert that it was that command.
- "ready refuses policy-edited review" sends `expectedRevision: 1` against revision 2, so it only proves the revision check. Add the case
  that matters: `expectedRevision: 2` (current) with the old review -> CHANGE_STALE from the review's base revision.
- "no review and no disabled-to-enabled shortcut" passes on the schema alone; replace or extend per item 11.
- Whole-table `toEqual(before)` after refusals is right per the checklist; keep it, but write in DESIGN.md that refusals write nothing
  (no refusal audit, unlike `spending.stop_refused` in admission) so M2 doesn't add one.
- The digest regex and exact response field names are contract, not detail; fine.

## Optional suggestions

- GET enrollment for an owner could also return the bound review's id, expiry and counts so the UI can resume after a reload.
- Keep enrollment state owner-only on GET. Task 2's start preview should decide `enabled` on the server and return nothing otherwise,
  rather than exposing this route to members.
- The same-id/different-body code is CONFIG_INVALID per the checklist, but task-stop-editing uses IDEMPOTENCY_CONFLICT. Follow the
  checklist, and note the inconsistency in HANDOFF.md.
- Disable from `enabled` leaves already admitted enabled windows capped by their captured snapshot (immutable windows, both ways). State
  it in DESIGN.md and add a test: enable, admit a window, disable, the window's `spendingStop` is unchanged.
- Run task-owner-reads, agent-lifecycle and web-safe-files inventory tests at M2 (new contract file + new broker reads).

## Codex's two questions

**Is the as-of review over the eventually consistent workspace-project GSI safe enough for money?** Yes, with item 3. The review is a
preview, not the safety mechanism. The safety comes from admission: after the enable commits, every new admission and window does
a consistent TransactGet of the canonical policy row and takes the enabled branch, whether or not the review saw that task. Enabling
only tightens: `disabled`/`ready` apply no company stop, and the enabled-only paths (company stop, the different-person rule in
requests.ts, unpriced refusal) all add restrictions. The funding exemption only exempts from the new stop. So a task the GSI missed can
only be surprised by a refusal; it cannot overspend because of the miss. The one real gap is running tasks admitted while disabled: they
keep their current window without a company stop until their next admission ("retain_current_window"). They are still bounded by their
legacy task budget and the customer limits, and the review must say so in plain words. Label the report "as of <time>", as proposed. Do
not build an org-wide inventory generation now.

**Is 5 minutes right?** Yes for the review -> `ready` step: the review is cheap to recapture and the numbers can drift. It is wrong as a
deadline for enable, because the REAUTH round trip alone can take most of it. Use item 2: enable takes a fresh review captured while
`ready` and compares economics with the bound one; `ready` itself does not expire. Enforce expiry on the server clock (`expiresAt`), not
by DynamoDB TTL, which deletes late; the existing expiry tests already do this.

## Overlap with other lanes

- **S1 authority fences (feat/s1-authority-fences):** no shared files (it changes agents/*, chains/*). Reuse the pattern, not the code.
  Tasks 2-4 must stay out of chains/routes.ts and chains/store.ts, which S1 changes (the register's overlap note).
- **S3 email scrub:** no shared files.
- **feat/team-record-sources:** also edits `packages/broker/src/aws/developer-routes.ts`, `packages/contracts/src/audit.ts`,
  `packages/contracts/src/web.ts`, `packages/contracts/web-safe-files.json`, `tests/contract/audit-contracts.test.ts`,
  `tests/contract/web-bundle-budget.test.ts` and `docs/architecture/code-map.md`. Expect append-style conflicts; keep your edits to
  those files to small additions in their own lines. Re-measure the bundle at M3 against whichever lands first.
- **feat/live-buttons:** also edits `packages/contracts/src/web.ts` and `web-safe-files.json`; same advice.
