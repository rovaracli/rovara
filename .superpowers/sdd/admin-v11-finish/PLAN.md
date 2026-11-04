# Task 1 M2 implementation plan

Spec: original codex-admin-console-prompt.md + REVIEW-M1.md + owner's disable decision.
Execute inline, alone; controller review replaces skill subagent reviews. No implementation of Tasks 2–4 before M2 approval.

- [x] Amend DESIGN.md for all 15 review items and write additional RED tests; run named tests before implementation.
- [x] Add browser-safe enrollment contracts, checked review key, bounded economic projection and company readiness/cutover capture.
- [x] Add owner evidence, fresh-session guard, receipt/replay, transactional enrollment store and narrow browser-route wiring; register one audit action.
- [x] Fence first project registration against a concurrent cutover without adding writes while off.
- [x] Add lazy owner enforcement flow and component/browser evidence.
- [x] Make tests green; extend compatibility, source, tenancy, audit, replay, bound and admission-positive controls until every review item is pinned.
- [x] Mutation-check each money/auth guard individually, restore code and rerun affected tests. Run inventories, required typecheck, strict owning typechecks, changed lint, owning lint shards, focused Chromium and bundle check via heavy.sh.
- [ ] Update HANDOFF and M2-READY with evidence; commit required identity; check remote PRIVATE; push private feat/admin-v11-finish; STOP for REVIEW-M2.md.

Constraints: 256000 gzip budget unchanged; no new Lambda env or IAM boundary; no AWS/CI/deploy/Docker; one heavy job at a time; no stash/config/merge/public push. Refusals write nothing. Disable-from-enabled needs fresh sign-in and exactly one acting owner; no second-owner approval.
