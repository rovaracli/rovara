# Mutants: TAG-GATED-TESTS (local-gate-only helper)

Each mutant was applied alone to a scratch copy of the branch (tests/support/local-gate-only.ts), run against `tests/unit/local-gate-only.test.ts`, then reverted. Baseline: 9 of 9 pass.

| # | Mutant | Killed by |
|---|--------|-----------|
| 1 | ROVARA_REQUIRE_GIT_HISTORY no longer throws | "with ROVARA_REQUIRE_GIT_HISTORY set ... THROWS" |
| 2 | the CI skip writes no LOCAL-GATE-ONLY line (silent) | "in CI it SKIPS with one counted line", "on a developer machine ..." |
| 3 | CI throws instead of skipping | "in CI it SKIPS ..." |
| 4 | a failing `--is-ancestor` (shallow history) is not missing history | "treats a failing is-ancestor ... as missing" |
| 5 | a missing tag is not reported | 3 cases |
| 6 | the Code clone need is ignored | "a Code commit needs ROVARA_CODE_REPO ..." |
| 7 | "0" / "false" / "" count as setting the variable | "'0' and 'false' do not count ..." |
| 8 | the line says "here" in CI too | "in CI it SKIPS ..." |

Killed 8 of 8.
