# SETUP-INSTALL-ROW mutants (Cloud)

Each mutant is applied, `tests/web/setup-tab.test.ts` and `tests/unit/setup-approval-routes.test.ts` and `tests/web/setup-run-screen.test.ts` are run, and the file is restored. KILLED = a test failed.

| Mutant | File | Result |
| --- | --- | --- |
| M1 a row that does not match (command named) cannot be ticked | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M2 useAnyway is never sent | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M3 the disabled button gives no reason | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M4 the tests-without-install warning is dropped | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M5 the named command is dropped from the row | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M6 the Cloud route refuses useAnyway | packages/cloud-server/src/setup-checklist-routes.ts | KILLED |
| M7 the older card blocks a non-matching row (command named) | packages/ui/src/screens/setup/ConfirmCard.tsx | KILLED (after the test pinned the box as enabled) |
| M8 the older card never sends useAnyway | packages/ui/src/screens/setup/ConfirmCard.tsx | KILLED |
| M10 the words claim the command is not in your code | packages/ui/src/screens/setup/words.ts | KILLED |
| M11 the route drops usedWithoutMatch | packages/cloud-server/src/setup-checklist-routes.ts | KILLED |
| M12 the Setup tab approval card shows no tag on a test command | packages/ui/src/screens/setup-tab/ApproveCard.tsx | KILLED |
| M16 a misread row (no command named) can be ticked | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M17 a misread row offers no Run setup again | packages/ui/src/screens/setup/MisreadRow.tsx | KILLED |
| M18 a misread row says it can be ticked anyway | packages/ui/src/screens/setup-tab/FoundSetupCard.tsx | KILLED |
| M19 the older card lets a misread row be ticked | packages/ui/src/screens/setup/ConfirmCard.tsx | KILLED |
| M13 the older approval card shows no tag | packages/ui/src/screens/setup/SetupApprovalCard.tsx | KILLED |
| M14 the approval card gives no count line | packages/ui/src/screens/setup-tab/ApproveCard.tsx | KILLED |
| M15 the log line joins ids into one string | packages/cloud-server/src/setup-checklist-routes.ts | KILLED |
