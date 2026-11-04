Verdict: FIX THEN MERGE

# REVIEW-M3: final review (Task 1 M2 fixes, 0.5.4 merge, Tasks 2-4)

Reviewer: Opus, final checkpoint M3, 2026-11-04. Read-only review of `ec8bd9baf..5e42cccac` at head 5e42cccac (the last commit only
changes docs). Read: M3-READY.md, DESIGN.md, HANDOFF.md, REVIEW-M1.md, REVIEW-M2.md, the brief, every changed source and test file, and
the real paths the changes rely on (`continue.ts` ~85-140, `start.ts` ~176-195 and ~365-470, `rovara-code/intent.ts`,
`playbook/project-process.ts`, `aws/web-auth.ts`, `aws/json-reply.ts`, `aws/broker/handler.ts` ~880-892, `ui/src/routes.tsx`,
`ui/src/api/without-request-id.ts`).

## What I ran

- `vt` with the 24 files from M3-READY's final affected list: **24 files, 1346 tests passed** (19.7 s). This matches Codex's numbers.
- Chromium, `admin-spending.e2e.ts` and `project.e2e.ts`, pinned Node 22.23.2, one worker, headless: **10/10 passed**.
- A schema probe on the built contracts with pinned Node (details under required fix 1). It shows that all four new browser reads reject
  what the real broker sends.

## Overall

The money and authority logic is now right. All nine REVIEW-M2 items are fixed in code, and the important ones have tests that fail
without the fix (four mutations, reproduced from `m2-fix-mutations.py`, plus two for the preview). The cutover review now uses Continue's
own identity helper, and the real Continue is run against the review for six cases. The 0.5.4 merge is clean, with no semantic conflict in
the server code. Tasks 2 and 3 are small and use the shared calculator and the existing guards.

There is one blocking defect, and the tests cannot catch it. The real broker adds the gateway's `requestId` to every object it returns.
The new owner-enforcement API and the new start preview read those answers with strict schemas, so in production both features fail
every time. Money stays safe because both fail closed: the owner can never enable enforcement, and the preview never shows. But neither
feature works. The Chromium mock leaves `requestId` out for exactly these routes, which is why the e2e passes. 0.5.4's QA-03 fix
(99ea53180) fixed this same bug for the older screens. This branch now contains that fix but did not apply it to its own new readers.

## Required fixes

### 1. The gateway `requestId` breaks every new strict browser read (enforcement GET, review, PUT, and start preview)

`json()` in `packages/broker/src/aws/json-reply.ts` returns `{ ...value, requestId }` for every object, and `handler.ts:891` sends every
`/v1/web` answer through `developerReply`. API Gateway HTTP API request ids look like `JZ3Fqi8xoAMEJgw=`. I parsed realistic wire bodies
against the built contracts (`packages/contracts/dist/web.js`):

| Reader | Schema | Result with gateway `requestId` |
| --- | --- | --- |
| `createTaskStopEnrollmentApi().get` | `TaskStopEnrollmentReadSchema` (strict) | **rejected** |
| `.review` | `TaskStopReviewSchema` (strict) | **rejected** (same shape issue) |
| `.transition` | `TaskStopEnrollmentResultSchema` (strict). Its own `requestId: uuid` is **overwritten** by the gateway id. | **rejected**. Also rejected after `withoutRequestId`, because the field is required. |
| `createCodeApi().previewStart` | `TaskStopStartPreviewSchema` (strict union) | **rejected**, so the preview never shows |

In production the owner sees "Could not verify enforcement…" permanently and can never turn enforcement on. The PUT case is worse: the
server may commit the change while the UI reports a failure. The owner then retries with a new request id and gets CHANGE_STALE.

Changes:
- `packages/ui/src/api/task-stop-enrollment.ts`: in `get`, `review` and `transition`, parse `withoutRequestId(...)` (or use
  `exactAnswer(...)`) from `./without-request-id.js`, like `task-stop-editing.ts:25` does.
- `packages/contracts/src/task-stop-enrollment.ts`: take `requestId` out of the wire `TaskStopEnrollmentResultSchema`. The broker overwrites
  it, so it can never reach the browser intact. The server can keep the request id in its private receipt, and the UI already knows the id
  it sent. If an echo is wanted, rename the field (for example `enrollmentRequestId`) so `json()` cannot clobber it. Then update the server's
  replay parse and the audit fact source to match. This wire schema is new in this branch, so changing it breaks no deployed client.
- `packages/ui/src/api/code.ts` `previewStart`: parse `withoutRequestId(response.body)`.
- Tests that fail without the fix:
  - `tests/web-e2e/support/mock-cell.ts`: in the `task-stop-policy` branch (~line 156) and the new `start-preview` branch (~line 127),
    add `requestId: "mock-gateway-request"` to object answers, as the generic admin branch at ~line 167 already does. The enforcement and
    preview Chromium journeys then exercise the real wire shape.
  - `tests/web/admin-budgets.test.ts` and `tests/web/start-work.test.ts`: make the fake host add a non-UUID `requestId` to every 200
    object. Assert that enforcement reaches the review and enable path, and that the preview text renders.
  - Run one mutation: drop the strip in `previewStart` and in `get`, and confirm that both suites fail.
- Also grep the rest of this branch's new UI readers for strict `.parse`/`.safeParse` on `response.body`. I found only these four.

### 2. The start preview sends the company's per-run ceiling to every project worker

`TaskStopStartPreviewSchema`'s `captured` branch returns `approvalCapMicrousd`, which is the company's `maxPerRunCeilingUsd` guardrail.
Any project member with work access receives it. `StartWorkBox` never shows it. Elsewhere that guardrail is only on admin screens
(`AgentsScreen.tsx` guardrails reader). The brief asks for no leak of company money settings to people who should not see them.
The effective stop is the minimum, and showing it to the person whose work it limits is the feature. The ceiling is a separate setting.
Change: remove `approvalCapMicrousd` from the preview wire schema and from `task-stop-start-preview.ts`. Update the contract test
(`toEqual` on the exact body) and the component fixture. Add an assertion that a member's preview body has exactly
`{orgId, project, kind, effectiveStopMicrousd}`. The calculator still computes the cap; it just doesn't leave the server.

## Verification of the nine REVIEW-M2 items

1. **Admitted-proof exemption only.** Fixed. `exempt = task.fundingProof !== undefined && isDeepStrictEqual(frozen.fundingProof,
   task.fundingProof)`. The `purpose: "cutover_review"` bypass is gone from `task-stop-funding.ts`. The Continue-driven `own-source` and
   `own-source-zero` cases start while disabled, assert there is no `fundingProof`, and show that the stop or the `TASK_STOP_ZERO` refusal
   applies. The exempt test at `task-stop-paid-start.test.ts:2814` still uses a task with an admitted proof. The `admitted-proof` mutation
   (dropping the `fundingProof !== undefined` guard) is killed.
2. **R38 new windows.** Fixed. Queued positive stops give `new_window_at_stop` and queued zero stops give `refuse_next_admission`. The
   `TASK_SPENT` read and its refusal are deleted. The `spent` Continue case asserts `budgetBaselineUsd` equals the current key spend (5)
   and that the window is at the review's stop. "keys without TASK_SPENT do not block review" covers the busy-company failure. `newImpacts`
   counts refuse and new-window, as DESIGN.md says.
3. **`requestedRunLimitUsd` through the shared identity.** Fixed. `continueAdmissionIdentity` is byte-for-byte the expression previously
   inline in `continue.ts` (I compared the removed and added lines), and both Continue and the review call it. The `requested` case shows
   500000 with `bindingScopes: ["requested"]` after the real Continue. The `requested-identity` mutation is killed. The legacy-field setup
   is explained in HANDOFF and is acceptable.
4. **Positive control drives real admission.** Fixed. There are six parametrised cases running review, ready, enable and then the real
   `POST /v1/dev/tasks/{id}/continue`. Running/`retain_current_window` is not driven, which is acceptable because Continue does not run
   on a running task.
5. **Emergency disable tolerates malformed money fields.** Fixed. `companySource(…, full=false)` is used for GET and for every
   `disabled` edge. The full-row native condition on the Put is unchanged. Both corruptions (`ceilingMicrousd: 1` and a bad `policy`)
   return 200 on GET and on disable, preserve the bad content, increment the revision and write one audit. The `lenient-disable` mutation
   is killed.
6. **Project registered while ready.** Fixed. `z.enum(["ready","enabled"])` seeds `inherit` under the policy condition. The test walks
   ready → disabled → review → ready → enabled through real registration. The `ready-registration` mutation is killed. Readiness names
   the project or agent (`TaskStopReadinessError.resource`), and it is tested.
7. **The 25-active-task cap.** Fixed. Up to 100 tasks are classified sequentially, all counts are returned, at most 25 are listed with
   refusals first, and `truncated` is set. The private row keeps every task id, so `newImpacts` counts beyond the list. Tests cover 26
   tasks enabling (counts 26, `tasksReviewed` and `tasksAtEnable` 26) and 101 refusing with no writes. The contract `superRefine` checks
   that counts and the list agree.
8. **UI errors.** Fixed. Each code maps to fixed text, the checked resource goes through `VisibleText` (it rejects Cc/Cf characters and is
   at most 256 chars), CHANGE_STALE has separate texts for ready and enable, and raw server text is never shown. One test per code, plus
   one for stale enable. (Fix 1 is a separate wire-shape problem in the same file.)
9. **REAUTH `sessionsEndedAt`.** Fixed. `sessions-ended` is in the request-time loss table for enable and disable (REAUTH_REQUIRED, no
   writes) and in the commit-race table. Commit-time stays FORBIDDEN, which was one of the two options REVIEW-M2 allowed, and DESIGN.md
   records it.

## Task 2: start preview

- **Authorization.** `projectRoleForRoute` (scoped to the caller's org; unknown and foreign-only projects return 404, tested) runs, then
  `requireNewWorkAllowed(...,"task")` (viewers get 403, tested, mutation killed), then `requireAgentAccess(process.agentId, "use")`. The
  scope check runs again inside the capture. So only someone who could start work in that project sees the stop that would apply to
  them. That is the right audience. Fix 2 removes the one extra money field.
- **One shared calculation.** It uses `captureTaskStopAdmission`, which calls `calculateTaskStop`, with `continueAdmissionIdentity({ budgetUsd })`.
  I checked this against `start.ts`. StartWorkBox starts through `startCodeIntent`, which names the project process agent. A process
  layer must extend Rovara Code (`requireProcessLayer`), so its runner is `coding`, `asWorkflow` is true and the path limit is
  `planningLimit(readProjectAi, workflowPath ?? "QUICK")`. That is exactly what the preview computes, with no committed max per run and no
  requested limit, as at start. The client cannot supply amounts (400, tested).
- **Unclear shows nothing and never blocks.** Disabled and ready return `disabled` before any money-source read. Exclusive own-source
  returns `unknown` (mutation killed). The UI shows an amount only for a validated `captured` answer for the same project. Errors, 503,
  malformed answers and a never-resolving request all leave Start enabled and working (tested). The admission-time zero refusal is kept
  (`approval_terms` only allows displaying $0).
- **Cost per call.** One POST per mount and project (`useEffect([api, project])`), not per keystroke. It does not retry and is aborted on
  unmount. Server cost is a role check plus one Get for every company today (disabled). Enabled companies add the playbook, agent,
  sources, PROJECT_AI and one TransactGet snapshot. That is acceptable for a page view.
- **Inventories.** The web-safe list was updated. task-owner-reads and agent-lifecycle pass (the preview reads no task rows).

## Task 3: admin menu

The Health and How we work `NavLink`s are inside the same `companyAdmin` fragment as the other company links, under the `features.admin`
route gate. Neither route has its own switch (`routes.tsx:28,34`), so the links match exactly what the pages allow. The owner and admin
cases are tested, members see neither link, and navigating does not fetch either page's data.

## Task 4: inapplicable

I confirmed there is no Send back control in `packages/ui/src`. The only matches are learning labels, lessons text and the builder's
"Send back to" step setting. There is also none in `aws/task-web.ts` or `aws/task-page-assets.ts`. The remaining Send back is Slack's
(`developer/workflow-messages.ts`). Skipping Task 4 is correct.

## The 0.5.4 merge (8956d344e)

The combined diff shows only the `contracts/src/web.ts` export append, and both blocks are kept. The merge adds nothing else. Only three
files are touched by both sides (`web.ts`, `web-safe-files.json`, `mock-cell.ts`), and all three merged cleanly.
- **S1 (`budget-authority.ts`, `agents/store.ts`).** S1 only adds `archiveActorChecks`, `destinationChecks` and `fenceRefusal`.
  `budgetActorChecks`, which the enrollment fences and Continue use, is unchanged. The agent status set that readiness accepts (`active`,
  `archived`) is unchanged.
- **S3 email scrub and live-buttons.** No shared files and no shared semantics.
- **Close fixes.** `close.ts` only moved its messages into `CLOSE_MESSAGES`. The review still skips tasks with `closedAt`/`releasedAt`.
- **The one semantic interaction** is QA-03's `withoutRequestId` convention, which this branch's new readers do not follow (fix 1).

## Bundle

Initial JS is 185004 gzip bytes (M2 184564; after the integration 185009). The budget stays at 256000. Nothing new loads eagerly:
`TaskStopEnforcement` and its API stay behind the owner step's dynamic import (the lazy-marker test passes). The preview code is in
`api/code.ts` and `StartWorkBox`, both in the lazy project-screen chunk. `AdminLayout` is lazy, so the two links add only their text.

## Optional notes

- A running task whose new effective stop is $0 is labelled `retain_current_window` ("…then a new window at this stop"), but its next
  admission is refused. It is also not counted in `newImpacts`. Consider giving running-with-zero its own label, or the text "then refused
  at next admission", and counting it as a refusal.
- The ordering of the truncated list (refusal, new-window, running, exempt) has no test. The 26-task test has only one outcome. Add a mix
  with refusals past position 25 and assert they are listed first.
- If a company has no `ORG_TASK_STOP_POLICY` row, `companySource` throws CONFIG_MISSING, so the preview returns 409 on every project page
  view. It is harmless (nothing is shown), but returning `disabled` would keep the logs quiet.
- Without a model proxy the preview uses `PER_TASK_BUDGET_USD`, while start uses `prepared.runLimitUsd ?? PER_TASK_BUDGET_USD`. These
  differ only in a proxy-less deployment, but naming the same helper would remove the gap.
- The preview could use a react-query key so going back and forth between project pages does not re-POST. That is low value.
- Still open from REVIEW-M2 (optional): a confirm step before "Turn off enforcement", and renaming the entry button when the state is already
  `enabled`.

## Next

Make fixes 1 and 2. Rerun `admin-budgets.test.ts`, `start-work.test.ts`, `task-stop-start-preview.test.ts`, `task-stop-enrollment.test.ts`,
`contracts-web-entry.test.ts`, the strict pkg-contracts and web-ui shards, changed-file lint, and the two Chromium journeys with the
requestId-adding mock, plus the one mutation in fix 1. Re-measure the bundle. No further Opus review is needed: a Sonnet re-check of the
fix diff is enough, and then hand off to the controller for merge.
