# lessons-l7 progress (branch feat/lessons-l7, base 9dcd735f3)

## Task 1: poisoning suite P1-P12 -- DONE (commit below)
- tests/contract/learning-poisoning.test.ts (63 passing, 2 `it.fails` = GAP-1, GAP-2, 1 `it.todo` for the wiring lane)
- tests/support/lessons-poisoning-world.ts (capture through the REAL taps + REAL record sink; pipeline through learnFromEndedTask / processDraft / approveLesson / loadLessonsForStage; scripted "fooled" model)
- 28 mutants of the guarded code run against the suite; the survivors are explained in report.md.

## Task 2: "same mistake twice" metric -- DONE (commit below)
- packages/broker/src/lessons/metric.ts (sameMistakeTwice: read-only; ports for corrections and matcher; the lesson store through a 3-method read type)
- packages/broker/src/lessons/metric-source.ts (v1.2 CORRECTION# reader + text-free signature matcher)
- tests: tests/unit/lessons/metric.test.ts (24), metric-source.test.ts (8); read-paths.test.ts got one list entry for metric.ts (counts only)
- 14 mutants of metric.ts killed by the tests.
- NOT wired (no route, no UI): the controller hands it the curator matcher and mounts it on the overview.
## Task 3: W1 memory-arm hook -- DONE (commit below)
- packages/contracts/src/eval-memory.ts (+1 export line in index.ts): EvalMemoryArm off|on, EvalMemoryDimension, evalMemoryArms, memoryInputForArm (on = frozen snapshot, never live), compareMemoryArms (paired, Wilson).
- tests/contract/eval-memory-contracts.test.ts (10); 7 mutants killed.
- Contract only: the quality-suite batch is not on cloud/next; today's EvalBatchFileSchema refuses a `memory` key (pinned by a test).
- Inventory gates: task-owner-reads(+bypass), role-sites, agent-lifecycle, contracts-web-entry (the web-safe-files inventory) pass; contracts-web-entry's one dist test needs packages/web/dist (environmental).

## Status: ALL THREE TASKS DONE. Commits: 6be9916e3 + c670da0ea (suite), 951a19edd (metric), 1fae8e043 (memory arm).
- Gaps found: GAP-1 reflect-input.ts:79 (steeringTrust absent fails open); GAP-2 sources.ts:60-76 + process.ts:104-110 (a burst spread over many sources never pauses auto-apply). Both are `it.fails` in learning-poisoning.test.ts.
- report.md could not be written (the Write tool refused report files for this subagent); the full report went to the controller in the final hand-back message.

## Fix round 1 (Opus review) -- DONE; merged private/cloud/next first (74c2cd3f2)
1. GAP-1 fixed (e6dc7a22e): `reflect-input.ts` returns `unknown_steering` when `steeringTrust` is undefined; explicit `[]` stays eligible; it.fails flipped to a passing test.
2. Bot trust (a4b71739b): `sources/slack.ts` takes the lower of `system` and the user's own trust for a bot message (the resolver answers system for any bot, so the user is asked as a person too). Tests in team-record-ingest-slack.test.ts and the suite; mutant killed.
3. Stronger tests (7145dd0be): P1 variants carry a member span and assert the specific reason; P5 uses the real createCodeFacts + shared locateCitation over a fixture repo (only the file reader is a fixture; no production CitationVerifier on this branch yet, re-point `fixtureVerifier` when it lands). Mutants killed: F1-F8 (each eligibility rule, unknown_steering, stale/unknown citation as valid, PR head accepted, pathExists true).
4. GAP-2 renamed "[open owner question, pins superseded rule C10]" with a comment (ec9dc6a6e); still it.fails.
- Not touched: lessons/approve.ts (another lane). Mutated files restored byte for byte (git diff clean after each run).
