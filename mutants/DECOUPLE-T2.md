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

### Rebase note (onto cloud/next cb4941c29)

cloud/next gained `you.chargedTo` in the strict `SessionViewSchema` (the one-field single), so the #1516 drift-gate test in `tests/contract/decouple-t2-forward-readers.test.ts` now adds a made-up `you.futureNote` to Code's snapshot instead of `you.chargedTo` (the gate treats every such field alike). M6 was rerun after the rebase on that test: still KILLED (3 failed: the drift-gate test, "reads the schemas Cloud's app and server name in code, not in a comment or a string", "has no drift in a schema Cloud parses that is not accepted").

## Pre-review fixes (S1 to S5; Sonnet pre-review of c8cb672dc)

Each mutant applied singly to one product line from the committed tree (b6bc4ce5a), then `tests/contract/decouple-t2-forward-readers.test.ts`, `tests/contract/contract-drift.test.ts`, `tests/unit/decouple-t2-projections.test.ts`, `tests/web/decouple-t2-merge-no-risk.test.ts`, `tests/unit/cloud-server-step-retry.test.ts` (vitest, `--maxWorkers=1`; contracts rebuilt with `tsc -b`), restored with `git checkout`. 11 of 11 killed, plus one equivalent mutant that led to a code simplification.

| # | Mutant | Result | Killed by |
|---|--------|---|---|
| P1 | a WARNING flag reads as absent when unreadable (the S1 bug: warnings caught to `undefined`) | KILLED (6 failed) | "a WARNING flag sent as a word / number / object / array reads as true" |
| P2 | a WARNING flag Code sends as an explicit false/null reads as a warning | KILLED (2 failed) | "a WARNING flag Code sends as an explicit false / null reads as absent" |
| P3 | `mayMerge` dropped from the grant list (an unreadable value refuses the answer) | KILLED (9 failed) | the grant-flag tests, the pinned list, the walk "every true-only flag ... is on a list" |
| P3b | a GRANT flag reads as true when unreadable | KILLED (7 failed) | "a GRANT flag sent as ... reads as absent (grants nothing)", the session-view grant test |
| P4 | `sessionRunning` counts an unknown status as running again | KILLED (3 failed) | "is not running: it stays off the Live board" |
| P5 | `blockedStepRetry` offers Retry on an unknown status again | KILLED (1 failed) | "offers no Retry on an unknown status even when the workflow is blocked at a retryable step" |
| P6 | `levelOf` reads an unknown risk level as medium again | KILLED (1 failed) | "a task risk level this build does not know draws no risk line and sends no Merge" |
| P7 | the mismatch check no longer has its own `=== "unknown"` clause | SURVIVED, equivalent: an unknown level never equals a known readiness risk, and when both are unknown `pressBound` refuses first (MergeSection.tsx:246). The redundant clause was removed from the code instead. | n/a |
| P7b | an unknown task level draws a risk line (display guard removed) | KILLED (1 failed) | the same Merge test (no "Medium risk", no reasons list) |
| P8 | the gate no longer maps `XReaderSchema` to `XSchema` for the hand-written exact readers | KILLED (1 failed) | "compares Code with the strict schema of every hand-written exact reader ..." |
| P9 | the gate drops the named mirrored schemas (the S5 loss) | KILLED (1 failed) | "keeps the named mirrored schemas compared ..." |
| P10 | the mirrored list gains `SessionViewSchema` (the #1516 failure comes back) | KILLED (5 failed) | the #1516 drift-gate test, the exact-readers test, "has no drift in a schema Cloud parses that is not accepted" |

## Opus fixes + sync (Opus review of e000cb343; rebased onto cloud/next de1accf1a)

Each mutant applied singly (committed tree fd38c8be5), then `decouple-t2-forward-readers`, `contract-drift`, `decouple-t2-opus-review`, `decouple-t2-projections`, `sources-member`, `sources-admin`, `setup-checklist`, `builder-unknown-thinking` (vitest, `--maxWorkers=1`; packages rebuilt with `tsc -b`), restored with `git checkout`. 6 of 6 killed.

| # | Mutant | Result | Killed by |
|---|--------|---|---|
| Q1 | `notesOptIn` back on the GRANT list (an unreadable value reads as "not kept") | KILLED (5 failed) | the SourcesTab test (a word / an object still says notes with links are kept), the SourceRow test (switch ON), the pinned lists and the path pin |
| Q2 | a listed key at a NEW path: a `fix: true` flag added to a reader schema is classified silently by key name | KILLED (1 failed) | "every true-only flag, at every path of every reader ... is pinned with its class" |
| Q3 | an unknown WORKFLOW state reads as running again (`state !== "COMPLETE"`) | KILLED (4 failed) | "a SUCCEEDED / RUNNING task whose workflow state is ... reads as unknown" |
| Q4 | the company line says "Slack not added" for an unknown workspace state | KILLED (1 failed) | "the company line for Slack ... paused_by_future_code says Slack unknown" |
| Q5 | the builder opens an editor with an empty step list when the resolved recipe cannot be read | KILLED (1 failed) | "a RESOLVED recipe ... says so instead of showing an empty step list" |
| Q6 | an exact reader with no Code counterpart loses its reason in `EXACT_READERS_NOT_COMPARED` | KILLED (1 failed) | the Opus pin (reasons equal the uncompared list) |
