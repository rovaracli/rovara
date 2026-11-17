# REVIEW-1: L4-D2 setup approval card (de3d86a29, base origin/cloud/next)

Read-only review. Code side read at Rovara #899 (`packages/broker/src/core-host/setup-run-routes.ts`, `setup-approval.ts`, `core/setup-agent/apply.ts`, `check.ts`).
Ran: `vt tests/unit/setup-approval-routes.test.ts tests/web/setup-approval-card.test.ts` (36 passed) and eslint on the changed source and test files (clean). Browser spec read, not run.

## High

None.

## Medium

None.

## Low

1. `packages/ui/src/screens/onboarding/steps/SetupStep.tsx:33` (the new re-seed `useEffect`). It resets all four form fields, the revision and calls `onProject(project)` whenever `project.latestRevision !== revision`, in either direction.
   - No loop: `acceptSaved` sets `revision` to the prop's revision, so the next run is equal. A save from this form sets `revision` first (the form's own `acceptSaved`), so it never fires on the person's own save.
   - It does throw away unsaved text when a teammate (or a window-focus refetch) moves the project to a newer revision. Those edits were based on a stale revision and would 409 on save, but the loss is silent.
   - It also fires for a lower revision. A refetch that was in flight before the person's own save and lands after it would put an older project into the cache (react-query does not cancel it on `setQueryData`); the effect then reverts the form and `revision` to the older values and the next save sends a stale `expectedRevision`. This needs narrow timing (polling is on only while `checking`, and the form is disabled then), so Low.
   - Suggest `project.latestRevision > revision` and either skipping when the form is dirty (`!unchanged`) or only reseeding from the card's `onDecided`. No test covers this effect.
2. `packages/ui/src/screens/setup/SetupApprovalCard.tsx:55-60` and `SetupRunSection.tsx:34-42`. After a successful decide the card stays mounted, with Approve and Reject enabled, until the invalidated read returns (`sending.current` and `busy` are cleared in `finally`). A second press sends the same request id again: Code answers `replayed`, or `IDEMPOTENCY_CONFLICT` for the opposite outcome (Cloud then says "This decision was already sent"), and `onDecided` can fire twice. Safe (Code is idempotent, Cloud checks the outcome), but a `done` latch on the card, or hiding the buttons once `decided` is set, would close it. No test for the double press.
3. `SetupRunSection.tsx:35` `decided` is never cleared. A later, unrelated moment where `apply` is undefined (a new run, then a candidate that is removed) can show an old "Approved." line again. Cosmetic.
4. `packages/cloud-server/src/setup-checklist-routes.ts` `approvalRefusal`: `IDEMPOTENCY_CONFLICT` is worded "This decision was already sent" for confirm and discard too. Code's confirm/discard do not raise it today, so it is unreachable now; use a neutral sentence or key it on `kind`.
5. `setup-checklist-routes.ts` `applyAnswer` caps `setup` and `readiness` at 40 lines, but Code's project schema allows 64 each (`project-node.ts:367`). Code's own candidate builder caps setup at 20 and readiness at 32 (`apply.ts:106`), so no candidate can exceed 40 today; if that cap rises, the whole run read turns into a 503 (the person loses the card and Discard). Consider 64 to match the schema.
6. `packages/contracts/src/code-contract-v0.ts:771` the comment still says the hosted setup run is "read, start, stop and journal"; add confirm/discard/decide. Nit.
7. Test gaps (all Low):
   - `tests/support/fake-code.ts` decide never answers REAUTH_REQUIRED and confirm always answers WORKSPACE_BUSY, so the browser spec cannot show the step-up refusal or a confirm-to-card flow; the unit test covers the refusal.
   - `tests/unit/setup-approval-routes.test.ts` mapping table has no case for `PROJECT_REVISION_MISMATCH` or `WORKSPACE_BUSY` carrying a listed sentence (the `said` branches at 409), nor for a listed sentence arriving with an unexpected status (for example 500).
   - `tests/web/setup-approval-card.test.ts` has no double-submit test and no test that a REAUTH after the 10-minute window resets `stale` after reload.
   - The browser spec asserts "no sideways scroll" only at 390px for the high-risk card with 3 changes; long commands in Details are not exercised.
   - The decide answer check does not compare `revision` or `risk` to what was seen or offered. Cloud only requires them to be well formed, which is consistent with the stated rule (checked against project and outcome).

## Checked and found correct

1. Cloud routes (`setup-checklist-routes.ts`):
   - Cloud adds only narrowing checks (project name shape, session company lookup via `companyCaller`, strict body shapes). It never sends a company; identity is `context.session` as the person's token.
   - Bodies are strict and rebuilt: `confirmBody`, `decideBody` (the `seen` object has exactly two keys), the discard body reuses `runBody`. The id, hex and UUID patterns match Code's schemas; Cloud is narrower on `reason` (no control characters) and `itemIds`.
   - Every Code answer is rebuilt from known fields. `apply` is rebuilt field by field, and an unreadable `apply` fails the whole read with the fixed 503 rather than showing a guessed card. The `approval` binding is passed whole but shape-checked (`setup-` id, 64 hex, `kind: "setup"`).
   - Only command lines and `failedStep` are Code-derived free text, bounded, and Code already makes `failedStep` one line with controls stripped (`check.ts` `oneLine`). The UI shows them through VisibleText.
   - `SETUP_APPROVAL_CODE_WORDS`: I compared all 13 sentences with Code's constants (`SETUP_CONFIRM_WORDS` ×9, `SETUP_NOTHING_WAITING`, `SETUP_NEEDS_ADMIN`, `SETUP_NEEDS_MAINTAINER`, `SETUP_PROOF_UNAVAILABLE`) with a script: exact matches. The `isn't available on this install yet.` 404 literal also matches `SETUP_APPROVAL_UNAVAILABLE`. What reaches the app is Cloud's own list member (`find` returns the list copy), never Code's string.
   - Status mapping matches Code's `errorStatus` and `gateRefusal`: REAUTH_REQUIRED is 403 (checked by code before status); CHANGE_STALE, IDEMPOTENCY_CONFLICT, WORKSPACE_BUSY and PROJECT_REVISION_MISMATCH are 409; CONFIG_INVALID is 400; AUDIT_UNAVAILABLE is 503; a reader's POST gets Code's 403 `SETUP_RUN_NOT_ALLOWED`, which becomes Cloud's decide or run sentence. An ended sign-in is not a CodeError and reaches the handler.
   - The decide answer must name the same project, `approved`/`rejected` matching the asked outcome, a known risk, a revision of at least 1 and a boolean `replayed`. Tested.
2. UI card:
   - Approve and Reject render only when `ready && approval !== undefined && canApprove/canReject`, so no dead button.
   - Not-fresh presses go to `host.signIn(..., { stepUp: true })` with the nonce return, using the same helpers as the admin screens.
   - The decide body is exactly `{requestId, outcome, seen:{revision, artifactDigest}}` from the read; `retry: "never"`; a `sending` ref plus `busy` disables the buttons during a send.
   - The digest appears nowhere in rendered text (tests assert it). Server text goes through VisibleText.
   - A moved candidate shows the fixed refusal and Refresh. Roles: `role="status"`, `role="alert"` for the failed check and the problem; `aria-label` on the section and lists; axe test passes.
   - CSS uses only generated `--rv-*` tokens (all exist in `design-tokens/src/look.ts` for light and dark); the risk is a word, not colour alone; actions stack at 480px and below.
   - Polling adds a 5 s refetch only while the check is `checking`.
3. `code-contract-v0.ts` diff is exactly 3 added lines and 1 changed (confirm L to LT; discard LT; decide T). `decide` as T only is right: the laptop's route table (`local/app/setup-agent.ts`) serves confirm and discard but not decide. Count 95 to 98 matches. Nothing else changed in the file.

## Builder's fixes after the review (no re-check: UI and wording only, no new access decision)

- Low 1: the SetupStep re-seed now runs only for a NEWER revision and only when the form has no unsaved edits.
- Low 2: a `done` latch on the card disables every button once a decision (or Discard) was accepted; new test for a double press.
- Low 3: the "Approved." line clears when a run is started or stopped.
- Low 4: the conflict sentence is neutral ("This was already sent.").
- Low 5: `apply` setup and readiness caps are 64 (Code's schema), in Cloud's rebuild and the app's schema.
- Low 7: mapping cases added for a listed sentence on WORKSPACE_BUSY and for a listed sentence arriving with a 500. Not done: fake Code REAUTH answer, long-command overflow screenshot (unit test covers the refusal).
- Low 6 (a nit about a comment) left as is.

VERDICT: PASS
