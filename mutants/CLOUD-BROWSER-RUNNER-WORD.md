# CLOUD-BROWSER-RUNNER-WORD mutants

Tests: tests/contract/verification-result.test.ts (new describe "browser_runner_missing ..."), tests/web/lifecycle-task-proof-outcome.test.ts (new case "says browser checks did not run for want of a browser runner ..."), tests/contract/contracts-web-entry.test.ts (the exact import graph). Each mutant was applied alone, `packages/contracts` rebuilt (`tsc -b --force`, the tests read the package dist), the three files run with `--maxWorkers=1`, then the file restored and rebuilt. The web-entry file has 1 failure with no mutant at all ("emits no Node or TypeScript compiler code into browser assets": packages/web/dist is not built in this worktree), so a mutant counts as killed only when it adds failures beyond that one. Result: 7 of 7 killed.

| # | Mutant | File | Result (failed tests, baseline 1 included in the web-entry file only when it ran) |
|---|--------|------|--------|
| M1 | `browser_runner_missing` removed from TESTING_BLOCKED_REASONS | verification-result.ts | killed (5) |
| M2 | also listed as a partial reason (two kinds overlap) | verification-result.ts | killed (5) |
| M3 | its text says "browser checks passed" | verification-result.ts | killed (3) |
| M4 | its text is empty | verification-result.ts | killed (4) |
| M5 | browser-runner-words.ts left out of the web-safe manifest | web-safe-files.json | killed (2, one is the baseline) |
| M6 | `testingReason` says "failed" | browser-runner-words.ts | killed (3) |
| M7 | `notRun` loses "this install has no browser runner" | browser-runner-words.ts | killed (2, one is the baseline) |
