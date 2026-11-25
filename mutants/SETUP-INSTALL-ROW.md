# SETUP-INSTALL-ROW mutants (Cloud)

Each mutant is applied, `tests/web/setup-tab.test.ts` and `tests/unit/setup-approval-routes.test.ts` are run, and the file is restored. KILLED = a test failed.

| Mutant | File | Result |
| --- | --- | --- |
| M1 a row that does not match is not tickable again | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M2 useAnyway is never sent | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M3 the disabled button gives no reason | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M4 the tests-without-install warning is dropped | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M5 the named command is dropped from the row | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M6 the Cloud route refuses useAnyway | packages/cloud-server/src/setup-checklist-routes.ts | KILLED |
