# Mutant evidence: DECOUPLE T2 (pr/decouple-t2-20261125)

Each mutant was applied singly to one product line (from a clean committed tree), `npx tsc -b packages/contracts` was rerun (the tests import the built contracts), then `tests/contract/decouple-t2-forward-readers.test.ts`, `tests/web/decouple-t2-unknown-action.test.ts` and `tests/contract/contract-drift.test.ts` were run (vitest, `--maxWorkers=1`), and the line was restored with `git checkout`.

| # | Mutant | Result | Killed by |
|---|--------|---|---|
| M1 | nested strict back: `nullable` no longer looked through by `readerOf` | KILLED (2 failed) | "accepts an unknown key under nullable, default, readonly..."; the generic "no reader keeps a strict object or a closed enum" walk |
| M1b | objects rebuilt with `z.strictObject` again (the #1516 shape) | KILLED (7 failed) | the #1516 session view test, the nested-key test, the deep-wrapper test, the generic walk |
| M2 | an unknown word is kept as the raw string instead of "unknown" (an unknown action / level survives as itself) | KILLED (5 failed) | "an action or access level a newer Code adds reads as unknown", the deep-wrapper test, the payer test, the SessionControls render test |
| M2b | unknown action renders: SessionControls draws a button for any action word it does not know | KILLED | tests/web/decouple-t2-unknown-action.test.ts "draws no control for it" |
| M3 | chargedTo interpreted: a loose object holding an unknown `chargedTo` key is rewritten (`owner: true`) | first attempt SURVIVED (the fixture's reader was already the owner, so the mutant changed nothing visible); the fixture now reads as a non-owner and the rerun is KILLED (1 failed) | "is refused by the strict schema (the failure) and read by the readers Cloud uses" (`you.owner` stays false) |
| M4 | `you.mayMerge: "yes"` is not read as absent (the grant-flag catch removed) | KILLED | "an action or access level ... the grant flags read absent unless they are exactly true" |
| M5 | task money partly read: an unreadable money block read as a loose object | KILLED | "a money block this build cannot read reads as no money" |
| M6 | a `...Schema` word in a comment counts as parsed again (the #1516 gate failure) | KILLED (3 failed) | "does not fail the deployed-drift gate", the contract-drift test that `SessionViewSchema` is not parsed, and the no-unaccepted-drift test (stale entries) |

## DEC 582: task-start-request Reply forward, disconnect-preview Reply strict

Each mutant was applied singly to one product line (from the clean committed tree 2e291f1e7), then `tests/unit/task-start-request-routes.test.ts`, `tests/unit/github-disconnect-preview-routes.test.ts` and `tests/unit/cloud-server.test.ts` were run (vitest, `--maxWorkers=1`), and the file was restored with `git checkout`. 11 of 11 killed.

| # | Mutant | Result | Killed by |
|---|--------|---|---|
| M7 | task-start `Confirmed` object `.strict()` again (an extra field refused) | KILLED (1 failed) | "ignores extra fields a newer Code adds, at every level, and does not relay them" |
| M7b | task-start `Task` object `.strict()` again (extra field inside the task refused) | KILLED (1 failed) | the same test |
| M8 | an unknown outcome is relayed with its other fields (the task and extras kept) | KILLED (8 failed) | "an unknown outcome ... grants nothing" (every word), "ignores extra fields on an unknown-outcome answer too" |
| M9 | an unknown outcome word is passed on as itself instead of "unknown" | KILLED (7 failed) | "an unknown outcome ... grants nothing" |
| M10 | a "confirmed" whose task cannot be read falls back to "unknown" (hides a broken success) | KILLED (5 failed) | "rejects invalid success" (bad task id, project, createdAt, missing/null task) |
| M11 | the confirmed outcome is no longer exact (`z.string()`: an unknown word with a task reads as a start) | KILLED (8 failed) | "an unknown outcome ... grants nothing" |
| M12 | disconnect preview `Reply` loose (`z.looseObject`: extra fields tolerated) | first attempt SURVIVED (removing the trailing `.strict()` changed nothing: `Input.extend` keeps the strictness); as `z.looseObject({ ...Input.shape, ... })` KILLED (3 failed) | "the disconnect preview reader stays strict: an extra top-level field is refused", "rejects an unexpected requestId instead of stripping it" |
| M13 | disconnect preview: an extra blockers variant maps ANY kind to exact-zero blockers (an unknown kind read as "no blockers") | KILLED (26 failed) | the strict-reader test (unknown kind "partial" / "none"), "rejects invalid/ambiguous success", the happy-path test |
| M14 | disconnect preview: the unknown-blockers object loose (extra field tolerated) | KILLED (1 failed) | "the disconnect preview reader stays strict: an extra field in unknown blockers is refused" |
| M15 | disconnect preview: the target object loose | KILLED (3 failed) | "the disconnect preview reader stays strict: an extra field in the target", "refuses invalid body", "rejects invalid/ambiguous success" |
| M16 | disconnect preview: the unknown-blockers reason opened (`z.string()`) | KILLED (1 failed) | "the disconnect preview reader stays strict: an unknown-blockers reason this build does not know is refused" |
