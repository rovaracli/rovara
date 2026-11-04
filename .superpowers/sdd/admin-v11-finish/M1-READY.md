# M1 READY — design and RED tests, awaiting controller review

Controller: Claude session **abhishekgarg-37** (Opus). Branch `feat/admin-v11-finish`, base `v0.5.3` (`030a4b716beeb816f7a17eb4f960a6afa6727c39`). Intended remote: **private**, PrepLabsAI/Rovara-cloud. No merge permitted.

## Review packet

- `DESIGN.md`: proposed enrollment states/authority, checked keys, atomic source fences, audit events, replay, REAUTH, bounded cutover review and lazy UI approach.
- `tests/contract/task-stop-enrollment.test.ts`: 50 RED tests through the real app router and atomic DynamoDB fake. There is **no production implementation**. The new endpoints return NOT_FOUND, so these tests fail at their first required endpoint assertion; deeper guard assertions become actionable at M2, and are not claimed independently proven yet.
- `HANDOFF.md`: decisions, constraints, deferred work and setup notes.

## Gates run and observed results

All heavy commands used `/Users/abhishekgarg/.local/share/rovara-tools/heavy.sh`, directly or through `vt`; one job at a time. Local logs are alongside this file and deliberately untracked.

| Gate | Command / scope | Result |
| --- | --- | --- |
| RED + affected neighbors | `vt tests/contract/task-stop-enrollment.test.ts tests/contract/task-stop-editing.test.ts tests/contract/task-stop-admission-snapshot.test.ts tests/contract/task-stop-enrollment-off.test.ts` | Exit 1, **50 expected RED failures**, **66 existing tests passed**; 1 RED file and 3 green files. No collection errors in final run. |
| Customer limits on exempt tasks | `vt tests/contract/task-stop-paid-start.test.ts -- -t 'funding review: an exempt'` | Exit 0, **2 passed**, 402 intentionally filtered out. Tests cover refusal at $5 customer max-per-run and only $3 remaining room after $2 spent. |
| Required typecheck | `heavy.sh npm run typecheck` | Exit 0. Built the fresh worktree's package references. |
| Owning strict typecheck | `heavy.sh node node_modules/typescript/bin/tsc -p tsconfig.lint/tests-contract-t-z.json --noEmit --pretty false` | Exit 0, **0 TS errors**, rerun after final test edits. |
| Changed-file lint | `heavy.sh env ROVARA_LINT_PROJECT=./tsconfig.lint/tests-contract-t-z.json node --max-old-space-size=12288 node_modules/eslint/bin/eslint.js tests/contract/task-stop-enrollment.test.ts` | Exit 0, no diagnostics, final file. |
| Strict lint shard discovery | `node scripts/lint-shards.ts --list` | Identified `tests-contract-t-z` as the owning shard. |
| Strict lint shard | `heavy.sh node scripts/lint-shards.ts --only tests-contract-t-z` | Exit 0, **1/1 shard passed**, 268 files, 30 seconds, final file. |
| Baseline build | `heavy.sh npm run build:web` | Exit 0. |
| Initial bundle | Pinned Node with `--import tsx scripts/web-bundle-budget.ts` | **183,820 gzip bytes**, budget **256,000**; headroom **72,180**. No production/UI changes at M1; M3 must rebuild and report final after-size. |
| Diff hygiene | `git diff --check` (and staged check before commit) | No whitespace errors. |

Initial test collection failed because setup had built contracts only, leaving model-runtime exports absent. The successful required typecheck built these outputs; final test runs collect and execute normally. That failed collection was not counted as RED evidence.

## Review focus / deferred gates

The workspace-project GSI is eventually consistent. DESIGN.md calls out the exact limit of an as-of review and the proposed revalidation. It does not claim serializable inventory completeness. Confirm this and the proposed 5-minute review lifetime before implementation.

Mutation checks cannot prove missing guard implementations at M1; perform each money/auth mutation individually at M2 after the guards exist. New UI/browser screenshots, inventory updates, new audit-contract cases and relevant package/UI tests also belong to M2 implementation. No screens, broker reads or contract files were added at M1, so those inventory/browser checks are currently inapplicable. Tasks 2–4 remain behind M2 review. No full suite, typecheck:all, CI, AWS, deployment, Docker/colima, IAM/env/bundle-budget changes, shared config edits, or other-lane changes.

**STOP at M1.** Wait for `.superpowers/sdd/admin-v11-finish/REVIEW-M1.md`; address findings before implementing Task 1. M2 and M3 are not started.
