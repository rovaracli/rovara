# Mutant evidence: AL-1 sealed audit log appender and sealer (pr/al-1-audit-sealer-20261125)

Each mutant was applied singly, in place, to one production line, then `tests/unit/audit-appender-sealer.test.ts` was run (vitest, `--maxWorkers=1`), and the line was restored. M13 changed the built `packages/contracts/dist/audit.js` (the test reads the contracts package through its dist); the dist was restored and compared with a saved copy.

| # | Mutant (file) | Result | Killed by |
|---|---|---|---|
| M1 | each record links to genesis instead of the head (audit-appender.ts) | KILLED | chain links; restart continues the chain |
| M2 | recordedAt follows the clock backwards (audit-appender.ts) | KILLED | "never lets recordedAt go backwards" |
| M3a | head condition removed from the append transaction (audit-ledger-store.ts) | KILLED | "the store refuses a second record at the same place and a head that is not the one read" |
| M3b | record put condition removed, head condition kept | SURVIVED (redundant guard) | the head condition alone still refuses the second writer; see M24/M25 |
| M3c | first-record head condition removed, record condition kept | SURVIVED (redundant guard) | the record condition alone still refuses it; see M24 |
| M4 | receipt condition removed | KILLED | "an appender that checked for the event, then lost the race and reads a newer head, still writes the event once" (without it the same event is written twice) |
| M5 | other facts under a known event identity accepted (audit-appender.ts) | KILLED | "same item again is already appended, other facts ... refused" |
| M6 | chain not checked before a seal is planned (audit-sealer.ts) | KILLED | "re-hashes the changed record but breaks the link to the next one" |
| M7 | segment ignores the epoch boundary | KILLED | cadence tests |
| M8 | a seal links to genesis instead of the company's last seal | KILLED | verifier check across several epochs |
| M9 | range not re-checked before it is locked | KILLED | "refuses to lock a range that changed between planning and locking" |
| M10 | storage answer for other bytes accepted | KILLED | "refuses evidence that is for other bytes" |
| M11 | epoch stamped before its seals are locked | KILLED | "does not stamp an epoch until every seal in it is locked" and the restart test |
| M12 | tick guard against a passed epoch removed (audit-sealer.ts), store check kept | SURVIVED (redundant guard) | the store's planned-epoch check refuses it; see M26 |
| M13 | interval 15 instead of 5 (contracts dist) | KILLED | cadence and the seal tests |
| M14 | planSeal: tip condition removed | KILLED | "a seal planned from a stale tip is refused" |
| M15 | planSeal: closed-epoch check removed | KILLED | "no seal joins a closed epoch ..." |
| M16 | planSeal: planned-epoch check removed, tick guard kept | SURVIVED (redundant guard) | the tick guard and the closed-epoch check cover it; see M26 |
| M17 | planSeal: one seal per company per epoch removed | KILLED | "a company gets one seal in an epoch" |
| M18 | planEpoch: tip condition removed | KILLED | "a statement planned from a stale tip ... is refused" |
| M19 | planEpoch: closed check removed | KILLED | "a statement is planned once, only from a closed epoch ..." |
| M20 | planEpoch: statement may be written twice | KILLED | "... planned a second time with the right tip, is refused" |
| M21 | advance: phase condition removed | KILLED | "a phase moves forward from the phase it was read in only" |
| M22 | readRecords: gap and place check removed | KILLED | "refuses a chain with a record removed from the middle" |
| M23 | readRecords: record digest not checked | KILLED | "refuses a row whose content no longer hashes to itself" |
| M24 | record condition and first-record head condition both removed | KILLED | ten appenders at once |
| M25 | record condition and later-head condition both removed | KILLED | ten appenders at once |
| M26 | tick guard and store planned-epoch check both removed | KILLED | "a late tick does not plan into an epoch that is already passed" (a record committed late by a clock that is behind) |

26 mutants run: 22 killed alone; 4 survived alone (M3b, M3c, M12, M16), all halves of deliberately doubled guards (the record's own condition and the head's; the tick's check and the store's). Each doubled guard is killed when both halves are removed (M24, M25, M26), so nothing survives that removes a protection entirely.

## Pre-review round (fixes for MUST-1 and SHOULD-1 to SHOULD-6)

The reviewer's tests (`tests/unit/audit-appender-sealer-review.test.ts`, `.fails` removed once each fix was in) killed the four mutants that survived alone above: M3b, M3c, M12, M16 (re-run against both test files: all KILLED, so no mutant now survives alone). New mutants, run the same way against both test files:

| # | Mutant | Result | Killed by |
|---|---|---|---|
| P1 | tick does not close earlier epochs that hold planned seals | KILLED | "a seal planned in an epoch whose tick stopped before closing it ..." |
| P2 | tick does not fence earlier epochs | KILLED | "a seal planned into an earlier epoch after the next tick listed its sealed epochs is refused" |
| P3 | planSeal: fence check removed | KILLED | "fencing an epoch refuses later seals into it ..." |
| P4 | planSeal: epoch-sealed marker not written | KILLED | the MUST-1 restart test |
| P5 | a statement is planned after an earlier closed epoch that has none | KILLED | "does not plan a later statement while an earlier closed epoch has none" |
| P6 | a transaction conflict is thrown, not retried | KILLED | "an append that meets a transaction conflict is retried" |
| P7 | chain end not checked against the head (too few rows) | KILLED | "a record that the head names but that is missing from the end ..." |
| P8 | last record not compared with the head's hash | KILLED | "stops a company whose head names a record that is not the chain's last" |
| P9 | a stand-in timestamp source may lock a statement | KILLED | "a statement locked while no timestamp source is wired ..." |
| P10 | the authority named on a statement not enforced | KILLED | "refuses to stamp a statement with a source other than the one it names" |
| P11 | seal row not compared with its progress row | KILLED | "a seal row changed after it was planned ..." |
| P12 | retention not compared with the clock | KILLED | "refuses an answer written just now whose lock ends before the retention period is over" |
| P13 | evidence time not compared with the clock | KILLED | "refuses an answer written long ago ..." |
| P14 | no report of records held by a fast clock | KILLED | "holds back that company's later records ..." (now asserts the `blocked` entry) |

A fifteenth, P15 (`readSeal` row-key check), was an equivalent mutant: the clause it removed (`item.sk !== companyId`) could not be false at either call site, so the clause was deleted from the code. 14 of 14 killed.
