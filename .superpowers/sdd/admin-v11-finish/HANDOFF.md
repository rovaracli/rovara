# Admin v11 finish handoff

## Scope and checkpoints

Working alone as required by the repo checklist. Controller Claude session abhishekgarg-37 owns reviews and all merges. M1 contains design and RED tests only; Tasks 1 implementation and 2–4 await their required checkpoints.

## Decisions / items for controller

- Design proposes a five-minute cutover-review lifetime, strict owner-only review reads, and ready-to-disabled cancellation.
- Existing workspace-project inventory is eventually consistent. DESIGN.md explicitly documents its limits and does not certify an instant exhaustive cutover.
- Existing calculateTaskStop treats the ceiling as an approval cap, retaining ordinary unapproved estimates above it. Task 2's “strictest” wording must use that shared calculator, without a competing UI/route formula.
- Preserve existing accepted windows and customer limits for own-source exemptions. Existing named regression tests already cover exempt max-per-run refusal and remaining customer room.
- No other lane files, IAM, env vars, budget constant, production code or dependencies changed at M1.

## Setup

Ran the brief's exact new-lane command. The sandboxed attempt could not create the outside-workspace worktree; the authorized escalated rerun completed. Branch feat/admin-v11-finish, base v0.5.3 at 030a4b716beeb816f7a17eb4f960a6afa6727c39; dependencies cloned and contracts built by setup.

## M1 evidence and remaining work

See M1-READY.md for exact commands and results. Final run: 50 expected RED enrollment tests; 66 neighboring tests and 2 focused exempt-task customer-limit regressions passed. Required npm typecheck, owning strict typecheck, changed-file lint and owning strict lint shard passed. Initial web build passed and scripts/web-bundle-budget.ts measured 183820 gzip bytes against 256000. No implementation yet; mutation/UI/inventory additions await M2. An initial collection failure from absent model-runtime dist was resolved by the required reference build, not counted as RED evidence.

Await REVIEW-M1.md before Task 1 implementation. Tasks 2–4 and M2/M3 remain deferred by the mandatory checkpoint sequence. No CI result exists because the brief expressly prohibits CI runs; Linux/full-suite validation belongs to the controller's merge workflow.
