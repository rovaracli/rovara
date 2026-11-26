# Mutants: TIMING-TESTS-SWEEP (Cloud)

Each timing assertion that was widened has a mutant of the slow shape it guards, applied to a scratch edit of the code under test (git checkout restores it; `git status` was clean of source changes afterwards).
A mutant makes the operation slower than the NEW bound by about 1 s (waits and hangs: the operation settles late; compute: extra work after the call; ratio tests: real quadratic or lost-cache work). The test must then FAIL on the timing assertion (the message shows the measured value against the new bound) or by its own timeout. One run per batch, `-t` limited to the guarded tests, vitest `--maxWorkers=1`, via 9d-heavy.sh.

| mutant | what it does | test | result | failure |
|---|---|---|---|---|
| eval-cap:263 | `answerEvalCap` in `packages/model-gateway/src/eval-cap.ts` settles 6000 ms later (async wrapper, delay in a `finally`) | `model-gateway-eval-cap.test.ts` / a connection read that outlasts its own bound | KILLED | AssertionError: expected 7008 to be less than 6000 |
| round2:44 | `packages/model-gateway/src/provider.ts`: inserted `__busy(130);` after `push(bytes: Uint8Array): { bytes: Buffer; hit: boolean } {` | `model-gateway-round2.test.ts` / R2 scanner processes the response ceiling | KILLED | AssertionError: expected 21264.5 to be less than 20000 |
| round3:169 | `effectivePrices` in `packages/model-gateway/src/price-sanity.ts` returns after 20500 ms of extra busy work | `model-gateway-price-round3.test.ts` / pooled sanity preserves provider/kind boundaries | KILLED | AssertionError: expected 20696.8 to be less than 20000 |
| round3:252 | `runCorrections` in `packages/model-gateway/src/correction.ts` settles 210 ms later (async wrapper, delay in a `finally`) | `model-gateway-price-round3.test.ts` / retry bookkeeping is bounded | KILLED | AssertionError: expected 21576.9 to be less than 20000 |
| round4 | `packages/model-gateway/src/price-sources.ts`: inserted `{ let __a = 0; const __n = keys.length; for (let i = 0; i < __n; i++) for (let j = 0; j < __n; j++) __a += Math.log(i + j + 2) * Math.cos(j); if (__a ` after `const map = await read(transport, LITELLM_URL, budget); const keys` | `model-gateway-price-round4.test.ts` / scales the 20,000-row mixed source | KILLED | AssertionError: expected 42.7 to be less than or equal to 30 |
| round5:150 | `packages/model-gateway/src/price-sanity.ts`: inserted `if ((sources.litellm?.entries.length ?? 0) > 10_000) __busy(28000);` after `export function effectivePrices(` | `model-gateway-price-round5.test.ts` / the complete pooled identity/alias bound | KILLED | AssertionError: expected 57113.7 to be less than 55000 |
| round8 | `effectivePrices` in `packages/model-gateway/src/price-sanity.ts` returns after 44000 ms of extra busy work | `model-gateway-price-round8.test.ts` / L3 evicts oldest retained aliases | KILLED | AssertionError: expected 88078.5 to be less than 3000 |
| round8 | `effectivePrices` in `packages/model-gateway/src/price-sanity.ts` returns after 44000 ms of extra busy work | `model-gateway-price-round8.test.ts` / L3 a full 40000-identity replacement | KILLED | Error: Test timed out in 60000ms. |
| turn-record:196/411 | `redactText` in `packages/contracts/src/redaction.ts` returns after 2000 ms of extra busy work | `turn-record-contract.test.ts` / redacts 160,000 characters of | KILLED | AssertionError: expected 4006.1 to be less than 1500 |

Killed 9 / 9 (test, mutant) pairs.

## Notes for a reviewer

- The gateway tests (round2, round3, round4, round5, round8, eval-cap) are byte-identical in Code and Cloud after this change, and their mutants are the same ones as in Code's `mutants/TIMING-TESTS-SWEEP.md`, applied to Cloud's copy of `packages/model-gateway`. round3:169 ran in its own batch (it mutates the same function as round8).
- turn-record-contract: `redactText` in `packages/contracts/src/redaction.ts` gets 2 s of extra busy work per call, against the new 1.5 s bound (it was 0.5 s; this repo measured 25 to 41 ms). 22 of the cases fail, one per input.
- round4: the mutant adds an n-by-n loop to `fetchLiteLLM`; the ratio assertion fails (`42.7` against 30; Code measured 39.8).
- Cloud's old `model-gateway-price-round8` had a 5 s bound and Code's a 15 s one; both are now the same file with a 45 s bound.
