# SETUP-INSTALL-ROW mutants (Cloud)

Each mutant is applied, `tests/web/setup-tab.test.ts` and `tests/unit/setup-approval-routes.test.ts` and `tests/web/setup-run-screen.test.ts` are run, and the file is restored. KILLED = a test failed.

| Mutant | File | Result |
| --- | --- | --- |
| M1 a row that does not match is not tickable again | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M2 useAnyway is never sent | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M3 the disabled button gives no reason | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M4 the tests-without-install warning is dropped | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M5 the named command is dropped from the row | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M6 the Cloud route refuses useAnyway | packages/cloud-server/src/setup-checklist-routes.ts | KILLED |
| M7 the older card still blocks a non-matching row | packages/ui/src/screens/setup/ConfirmCard.tsx | KILLED |
| M8 the older card never sends useAnyway | packages/ui/src/screens/setup/ConfirmCard.tsx | KILLED |
| M9 the log line drops the rows ticked anyway | packages/cloud-server/src/setup-checklist-routes.ts | KILLED |
| M10 the words claim the command is not in your code | packages/ui/src/screens/setup/words.ts | KILLED |
