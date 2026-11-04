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

The workspace index is eventually consistent; the review is an as-of preview, not a serializable exhaustive rollout certificate. Admission is the safety mechanism. One-step bounds are W=2P+A+B <=80, <=25 active tasks, <=500 workspaces, <=128 KiB review, <=94 conservative transaction actions plus checked byte/item limits. Oversize is TASK_STOP_REVIEW_TOO_LARGE. Missing spend evidence with existing model keys refuses review; settled spend is advisory. newImpacts counts newly observed task ids whose fresh outcome is stop_at_next_admission or refuse_next_admission, relative to the supplied review.

The existing calculator treats the ceiling as an approval cap and keeps ordinary unapproved estimates; no second formula was added. Task 2 must honor the shared calculation rather than invent a client-side minimum. New same-id/different-body requests follow checklist CONFIG_INVALID; task-stop-editing's older IDEMPOTENCY_CONFLICT convention was left unchanged.

No switch/env/IAM/default-boundary/budget constant, worker protocol or deployment changes. Broker Lambda env and IAM headroom are unchanged. No agents/chains, team-record/*, email-scrub, Ask/Fix panels, test-services or design-review files changed. Shared-file hunks are limited to route dispatch/browser gate, audit action/facts, exports/web-safe list, checked review key, error code and lazy-bundle markers. The registration/funding edits are small feature-local integrations.

## Gates and artifacts

M2-READY.md records final gate commands/results and a requirement-by-requirement review map. Initial bundle before: 183820 gzip bytes. The final measured value is recorded there; INITIAL_JS_BUDGET_GZIP_BYTES remains 256000. Local logs, m2-final-gates.json, m2-registration-final-gates.json, m2-mutations.json and the reproducible mutation runner are in this lane folder. Each of 29 money/auth mutations was observed to fail a focused test, then restored; no mutant remains.

Chromium evidence (local, ignored build output) is under .test-build/web-e2e/results/admin-spending.e2e.ts-owne-fdde8-backed-audited-transactions-chromium/: enforcement-review-light.png, enforcement-review-dark.png and enforcement-enabled.png. Light/dark accessibility checks pass and the screenshots were inspected.

No CI, full suite, typecheck:all, Linux runtime gate, AWS commands, deployment, Docker/colima, merge, stash or shared git-config writes were run. CI/Linux/full-suite verification is deliberately left to the controller's merge workflow, as required by the brief. This is a local M2 implementation handoff, not a deployment.

## Next checkpoint

STOP at M2 and wait for REVIEW-M2.md. Address findings before proceeding. Task 2 start-preview, Task 3 menu links and optional Task 4 Send back visibility are not implemented and remain behind M2 approval. M3 is not started.
