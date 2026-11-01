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
## Task 3: W1 memory-arm hook -- TODO
