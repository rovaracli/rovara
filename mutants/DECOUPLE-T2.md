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
