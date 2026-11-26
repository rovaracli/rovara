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
