# setup-draft-prove (TE-3) report

Branch fix/setup-draft-prove, from cloud/next 49f693754. One commit (see git log).

## What it does
Applying a "Set up with AI" draft's setup or test commands now proves them first (owner decision 2026-11-02, TE-3, option A).
- `rovara-code/setup-draft-check.ts` (new): builds the exact lists the settings save would store (`settingsCommands`, extracted from `org/project-settings.ts` and used by the save too; a list the draft does not touch stays exactly as stored, env and timeout included), their digest (sha256 of the canonical lists, namespaced), the verdict on a stored check, and `gateDraftCommands`.
- Reuses TE-2's candidate check: `startListsCandidateSetupCheck` (project-archive-setup.ts) runs the same `runSetupCheck` (same admissions, limits, fresh workspace, stored record `TEST_ENV_CANDIDATE_CHECK` per (project, digest, settings revision)) with the lists given and `expectedRevision`. `candidateStateOf` reads the result.
- `applySetupDraft`: a settings batch that changes setup/test commands is saved only when the stored check is ready, recent (7 days), at THIS revision, and its lists are identical (canonical JSON, every field) to the lists the save would write. Otherwise nothing is saved: no check -> started, item outcome `checking`; running -> `checking`; failed (started by this request) -> `check_failed` + `reason` (the check's own redacted one-liner); a new press (new request id) after a failure starts a new check. No candidate port (setup checks not set up) -> `not_available` with fixed words. A dev container alone needs no check.
- Authority: maintainer as before, plus a browser session for any batch with commands (a token gets 403 before anything is read or started). Settings revision: the check is keyed by revision, the batch must equal the latest revision, the save is a CAS on `expectedRevision`; a moved revision is 409 and nothing is saved.
- A request that waits or failed is not recorded (its repeat, same id, goes on from where the check stands); approval-card items in such a request are answered `not_available` ("Not tried") and no card/consent is touched.
- Contracts: outcomes `checking`, `check_failed`; result item field `reason`.
- UI (onboarding Setup step): "Apply selected" is "Check and apply" when a setup/tests item is ticked; the page re-sends the same request every 10 s (up to 60 min; the broker fails a stalled check at 50 min), shows the "running on a fresh machine" words, then the result, and the reason on failure. Initial JS: 183070 gzip bytes (baseline 183071; budget 256000, not raised).

## Existing drafts
No migration, no setting rewritten. A stored draft, an apply in progress (a draft partly applied, `appliedRevision`) and the v1 `APPLY#` records all go through the same code: any command batch needs its check at the current revision (tested: the rest of a draft after a partial apply is checked again at the revision the first part made). Completed `APPLY#` records still replay.

## The setup-run (fresh sign-in) rule
`setupDraftState` accepts only a task with `purpose: "setup_draft"`, so a setup agent's proposal can never come through this route (it goes through TE-2's confirm/propose/approve path, which has the fresh sign-in rule). A test pins that a pointer to a `setup_agent` task is refused. Nothing to add here; if a setup run's proposal is ever routed here, the fresh-sign-in rule must be added at the same place as the browser-session check (`gateDraftCommands`).

## Tests (all fail with the gate removed: mutation run, 15 failures)
- tests/contract/rovara-code-setup-draft.test.ts (+9 end-to-end: press -> checking, nothing saved, lists sent to the worker; pass -> exactly the checked commands saved, record kept, repeat replays; fail -> reason shown, settings unchanged, new press new check; revision race; other-list/earlier-revision checks not used; untouched list with env/timeout stays exactly as stored; token refused; contributor refused; waiting request leaves cards alone; setup_agent task refused). The harness `apply` now drives the real flow through a browser session.
- tests/contract/setup-draft-apply-unit.test.ts (+10: no candidate port fails closed; NOT_FOUND start fails closed; token; other revision/list/timeout/env/old/missing/outdated checks never accepted; lost; waits/failed/new check; start refusals with reason; archived and moved revision said as they are; save-level revision race records nothing; waiting request not recorded).
- tests/unit/setup-draft-check.test.ts (5).
- tests/web/setup-agent.test.ts (+2: polling with the same request until saved; failure reason shown and a new press is a new request); tests/web-e2e/setup-agent.e2e.ts and mock-cell updated (check, then save).

## Gates run
- `npm run typecheck:all`: 0 errors (strict check 0 in 0 files).
- Strict lint shards: pkg-broker, pkg-contracts, tests-contract-s, tests-unit (needs --heap 8192; 4096 aborts on this Mac, as before my change), web-ui, web-tests, web-e2e-tests: all ok.
- Inventory: task-owner-reads(+bypass), agent-lifecycle, broker-settings, broker-environment-provided, egress outbound-hosts, role-sites, contracts-web-entry (the web-safe-files test), named-templates, legacy-templates: pass (no infra change).
- TE-2 neighbours: test-env-candidate-check, setup-wizard-test-env, test-environment-flow, setup-agent-confirm, test-env-candidate, setup-proposal-contracts, rovara-code-contracts, admin-health-infrastructure: pass.
- Chromium web-e2e (node 22.23.2): setup-agent, onboarding, test-environment, part-a-sweep: 40 passed.

## Wiring pending (hot file)
None. `setupDraftDepsOf` (aws/developer-routes/dependencies.ts) gains `candidate` (only when `deps.tasks` is set).

## Blocked on owner
None.

## Risks / notes
- Cost: a draft apply with commands now runs a full prepare plus the commands (30-45 min on the Amazon pilot), then the project's own setup check starts as before (second run). The draft's own check could be reused for the project's status later.
- The candidate check's workspace counts against the person's and the company's workspace limits like any setup check; a full limit shows as `check_failed` with the limit sentence.
- The 7-day freshness and the 50-minute stall rule are TE-2's.
- A request that waits is not stored, so a different request id with the same ticks also finds the same running check (no second one).
- `reason` is the check's redacted one-line failing step (up to 400 chars), shown through VisibleText.

## High-risk (needs Opus review)
Yes: settings writes and approval authority (what is saved is only what was proved; browser-session requirement; revision race; the exact-lists comparison).

## Review round 1 (Opus) fixes
- B1: a dev container ticked in the same batch is part of the check: `DraftCommandLists.devcontainer` (as the save stores it, via the exported `resolveRepository`), in the digest, and the candidate workspace is prepared with it (`runSetupCheck`). Commands and dev container are saved together only after that check passes. Tests: outbox payload carries the new dev container; both saved together; a commands-only check never stands for commands+container (other digest); a dev container alone still needs no check.
- S3: after a passing check the project's own follow-up check is NOT run: `adoptCandidateAsProjectCheck` writes META `setupCheck` pointing at the candidate workspace at the new revision (only if the check is under 60 min old, no newer check exists, project not archived; otherwise the own check starts as before). A failed check for the same digest and revision is shown again to any new press and starts nothing; `checkAgain: true` (the "Check again" button) starts a new one.
- S2: release note: reload the Setup page after the upgrade. An old tab rejects the new `checking` outcome, so the press starts the check but shows "Couldn't apply the suggestions"; it fails closed and a reload fixes it. No version-tolerant reply (the server cannot tell the client's version).
- S1 (plain settings PUT can write commands with a token) predates this lane: unchanged; "tokens refused" applies to the draft route only.
