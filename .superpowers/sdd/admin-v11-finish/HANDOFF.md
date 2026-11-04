# Admin v11 finish handoff — Task 1 / M2

Controller: Claude session abhishekgarg-37, sole merger. Branch feat/admin-v11-finish, based on v0.5.3 (030a4b716beeb816f7a17eb4f960a6afa6727c39). M1 was pushed at aef096def and REVIEW-M1.md authorized proceeding with changes. Work stayed in the dedicated worktree and was implemented alone.

## Implemented

Owner-only, audited, revision-fenced disabled -> ready -> enabled and enabled/ready -> disabled. The owner explicitly decided that disabling enabled enforcement requires fresh sign-in and does not require a second owner; ready cancellation needs no fresh sign-in. Native membership, pointer, open-org, identity and session evidence fence commits; strict JSON decoding occurs after owner authority. Receipts/TTL, policy and audit pending events are atomic and ambiguous acknowledgements recover by receipt.

Server-built cutover reviews validate the entire bounded project/agent/builtin configuration, reuse captureTaskStopCutoverReview/calculateTaskStop and current funding proof, and persist no native conditions. Economic source changes block enable; inventory changes do not. Bound/fresh reviews survive the ready revision bump through an economic projection that excludes the company revision/enrollment. A new review can be captured while ready after expiry/re-authentication. Existing captured task windows and customer limits remain untouched through both directions.

The owner-only enforcement step in TaskStopEditor is lazy, checks sign-in freshness before review, presents impacts before separate ready/enable confirmations, handles REAUTH and drops stale scope responses. Monthly-table wording now describes the table's coverage while enforcement has its own step.

## Additional findings resolved

- The existing Spending editor could not parse enrollment_changed as a pending-proposal expiry reason. Observed RED, extended the historical outcome schema and UI message, verified the editor can read the resulting row.
- Disable initially omitted the bound review's provenance from its event; observed RED, now retains reviewId/digest.
- Inactive company/ceiling data must meet the same canonical-field and microdollar precision rules as active admission. Observed RED, added readiness validation.
- Router argument evaluation could decode malformed JSON before checking ownership. Observed RED, decoding moved inside the owner-checked enrollment store.
- Registration's first cutover condition was broader than needed and caused an unrelated numeric-policy edit while disabled to interrupt registration. Observed RED, narrowed to enrollment and company identity, preserving the ready-to-enabled race refusal with no added off-state Put.
- Strict checks caught a token fixture that used false for a true-or-absent browser flag, and lint caught test assertions/local const style. Corrected the fixtures/style; no production permission was weakened.

## Limits and deliberately unchanged behavior

The workspace index is eventually consistent; the review is an as-of preview, not a serializable exhaustive rollout certificate. Admission is the safety mechanism. One-step bounds are W=2P+A+B <=80, <=100 active tasks, <=500 workspaces, <=128 KiB review, <=94 conservative transaction actions plus checked byte/item limits. Oversize is TASK_STOP_REVIEW_TOO_LARGE. No TASK_SPENT dependency: Continue opens a fresh window from current key spend. newImpacts counts newly observed task ids whose fresh outcome is new_window_at_stop or refuse_next_admission, relative to the supplied review.

The existing calculator treats the ceiling as an approval cap and keeps ordinary unapproved estimates; no second formula was added. Task 2 must honor the shared calculation rather than invent a client-side minimum. New same-id/different-body requests follow checklist CONFIG_INVALID; task-stop-editing's older IDEMPOTENCY_CONFLICT convention was left unchanged.

No switch/env/IAM/default-boundary/budget constant, worker protocol or deployment changes. Broker Lambda env and IAM headroom are unchanged. No agents/chains, team-record/*, email-scrub, Ask/Fix panels, test-services or design-review files changed. Shared-file hunks are limited to route dispatch/browser gate, audit action/facts, exports/web-safe list, checked review key, error code and lazy-bundle markers. The registration/funding edits are small feature-local integrations.

## Gates and artifacts

M2-READY.md records final gate commands/results and a requirement-by-requirement review map. Initial bundle before: 183820 gzip bytes. The final measured value is recorded there; INITIAL_JS_BUDGET_GZIP_BYTES remains 256000. Local logs, m2-final-gates.json, m2-registration-final-gates.json, m2-mutations.json and the reproducible mutation runner are in this lane folder. Each of 29 money/auth mutations was observed to fail a focused test, then restored; no mutant remains.

Chromium evidence (local, ignored build output) is under .test-build/web-e2e/results/admin-spending.e2e.ts-owne-fdde8-backed-audited-transactions-chromium/: enforcement-review-light.png, enforcement-review-dark.png and enforcement-enabled.png. Light/dark accessibility checks pass and the screenshots were inspected.

No CI, full suite, typecheck:all, Linux runtime gate, AWS commands, deployment, Docker/colima, merge, stash or shared git-config writes were run. CI/Linux/full-suite verification is deliberately left to the controller's merge workflow, as required by the brief. This is a local M2 implementation handoff, not a deployment.

## Next checkpoint

Historical M2 stop completed. REVIEW-M2 was addressed and the owner explicitly authorized the integ/054 merge and continuation to M3. See the current M3 section below.


## M2-FIXES (REVIEW-M2)

1. Exemption requires an admitted task funding proof equal to its frozen recipe proof. Removed the cutover-only funding bypass. Disabled-era own-source work is covered by real Continue tests, including zero refusal; admitted-proof coverage remains.
2. R38 projections now say new_window_at_stop for positive queued work and retain_current_window for running work. Removed TASK_SPENT reads, so minted keys without a spend row do not block review. Real Continue checks its fresh baseline against current key spend.
3. continueAdmissionIdentity is the pure shared input builder for Continue and cutover review, preserving disabled-era requestedRunLimitUsd and invalid-present refusal semantics. Task 2 must reuse it.
4. Replaced the hand-built admission control with six Continue-driven cutover cases: plain, requested, own-source, spent-at/above-stop, zero, own-source-zero. The requested case uses an actual disabled-era plain start with a legacy persisted requestedRunLimitUsd field; the normal modern agent-start path creates a workflow, which Continue correctly refuses for unrelated reasons.
5. GET and disable validate only company identity, revision and enrollment. Both malformed-policy regressions preserve the bad content, advance revision and produce one audit. The disable Put still fences the full native row.
6. Ready registration now writes the same inherit row and policy condition as enabled registration. A real registration test proceeds ready -> disabled -> fresh review -> ready -> enabled. Disabled registration remains condition-only: this is behaviorally compatible, but not literally byte-identical when enrollment moves concurrently.
7. Up to 100 tasks classified sequentially (bounded concurrency 1); all outcome counts returned, <=25 impacts listed with refusal/new-window priority, truncated explicitly. Review rows remain checked below 128 KiB. All private task ids are retained for correct newImpacts accounting beyond the list. 26-task enable and 101-task refusal covered.
8. Fixed code-to-message mapping for too-large, missing/invalid config with a checked resource, ready/enable stale guidance, audit unavailable. UI renders resource text through VisibleText and discards raw server text. No retry write follows a refusal.
9. sessions-ended loss added for enable and disable, plus both commit races. Request-time loss is REAUTH_REQUIRED. Commit-time identity drift remains FORBIDDEN by deliberate choice; membership/identity authority takes precedence and a reload/new sign-in is needed. No second owner is required for disabling.

The historical M2-READY gate table describes ec8bd9baf, not this fix revision. Fresh gate/mutation evidence is recorded separately in m2-fixes-gates.json and m2-fix-mutations.json before the authorized integ/054 merge.


M2-FIXES verification complete: `npm run typecheck`, strict pkg-broker/pkg-contracts/tests-contract-a/tests-contract-t-z, changed-file lint, seven owning lint shards, build:web, 21 named files / 1262 tests, six Chromium admin-spending journeys, codemap and diff checks passed. Four new mutations were killed by assertions and automatically restored; the final restored run passed four files / 609 tests. Initial JS is 184561 gzip bytes (historical M2 184564; original base 183820; cap 256000 unchanged). Review screenshot inspected. Exact commands/exits remain in local m2-fixes-gates.json and m2-fix-mutations.json.


## M3 implementation and integration

Merged exactly fae38ff6f272596cb5a4099ee3fe48980d8461b2 into the feature branch as 8956d344e after c218dc6a6's M2 fixes. One conflict, contracts/src/web.ts, resolved by retaining both export blocks. Required post-merge typecheck:all passed: zero strict errors against the zero-error baseline. No product branch, release tag or deployment changed.

Task 2 adds the read-only canonical start-preview route and independent, bounded StartWorkBox preview. Zero can be displayed by the existing request-building capture purpose; actual admission still refuses it. Body-supplied money is rejected. Disabled/ready, invalid/unknown/error and potential own-source exemptions show nothing. The selected planning limit (and existing no-proxy default), project process, native source records, identity helper and calculator are shared with work admission. The calculator retains the explicit-agent ceiling rule and its distinction between a general starting allowance and an approval cap; no second formula was added.

Task 3 adds Health and How we work under existing company-admin/web/admin-feature checks. Both screens remain lazy and no data is fetched from navigation. Task 3's RED tests failed for both missing links, then all 52 admin-foundation tests passed.

Task 4 skipped as inapplicable: a repository search at the merged head finds no Send back control in packages/ui, packages/web, aws/task-web.ts or aws/task-page-assets.ts. Its remaining button is in Slack's shared workflow message, outside this optional per-reader web change. Server pageAccess/projectWorkAllowed and the server Send back gate are untouched. No Ask/Fix panel or other lane-owned implementation file was edited; the integration's changes were merged intact.

Bundle stages (gzip bytes): original base 183820; historical M2 184564; M2 fixes 184561; integ/054 merged baseline 185009; Task 2 185009; after Task 3 185004. Thus navigation adds no initial growth. INITIAL_JS_BUDGET_GZIP_BYTES stays 256000, with 70996 bytes headroom.

During M2 verification one accidentally duplicated queued gate was terminated before it ran; subsequent gates and all mutations ran sequentially. No shared tool settings were changed.


Final M3 verification: 24 files / 1346 tests, 10 Chromium journeys, required root typecheck, three strict typecheck shards, all changed-file lint and six owning lint shards, web build, inventories, codemap and diff check passed. Both new preview mutations were killed and restored before the final green gates. Initial bundle 185004 gzip bytes. See M3-READY.md for complete commands/scope and local screenshot links. STOP at M3 for REVIEW-M3.md.
