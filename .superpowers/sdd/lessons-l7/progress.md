# lessons-l7 progress (branch feat/lessons-l7, base 9dcd735f3)

## Task 1: poisoning suite P1-P12 -- DONE (commit below)
- tests/contract/learning-poisoning.test.ts (63 passing, 2 `it.fails` = GAP-1, GAP-2, 1 `it.todo` for the wiring lane)
- tests/support/lessons-poisoning-world.ts (capture through the REAL taps + REAL record sink; pipeline through learnFromEndedTask / processDraft / approveLesson / loadLessonsForStage; scripted "fooled" model)
- 28 mutants of the guarded code run against the suite; the survivors are explained in report.md.

## Task 2: "same mistake twice" metric -- TODO
## Task 3: W1 memory-arm hook -- TODO
