# STRICT-READERS-KNOWN-FIELDS mutants (solo lane on cloud/next)

## Regression proof: the live break fails without the fix
tests/web/admin-project-archive.test.ts and admin-project-restore.test.ts each gained one test: an archive (restore) OUTCOME whose `current` carries `expectedProjectIncarnation` must read as confirmed ("Current project status: Archived." / "Active."), one POST, and no "unconfirmed" text on the page.
- On cloud/next de1accf1a with the 3 contract files unchanged (contracts dist built from them): 2 failed, 83 passed (85) in the two files; both new tests fail with "Unable to find an element with the text: Current project status: ...". The outcome's strict nested `current` refused the answer, so the screen said the outcome was unconfirmed.
- With the fix: both pass (105 tests pass across those two files and tests/contract/strict-readers-known-fields.test.ts).
- UI-1 (archive field removed again, restore kept): only the archive UI test fails (1 failed, 37 passed). UI-2 (restore field removed, archive kept): only the restore UI test fails (1 failed, 46 passed).

## Unit mutants: tests/contract/strict-readers-known-fields.test.ts (20 tests). 16 of 16 killed
| # | Mutant | File | Result |
|---|--------|------|--------|
| M1 | `expectedProjectIncarnation` removed again from the archive preview | reviewed-project-archive.ts | killed (4 failed) |
| M2 | same, restore preview | reviewed-project-restore.ts | killed (4) |
| M3 | archive field made required | reviewed-project-archive.ts | killed (4) |
| M4 | restore field made required | reviewed-project-restore.ts | killed (4) |
| M5 | archive field `z.number().optional()` (0, -1, 1.5 read) | reviewed-project-archive.ts | killed (2) |
| M6 | restore field `z.any().optional()` | reviewed-project-restore.ts | killed (2) |
| M7 | archive field nullable | reviewed-project-archive.ts | killed (2) |
| M8 | archive preview `.strict()` -> `.passthrough()` | reviewed-project-archive.ts | killed (2) |
| M9 | restore preview `.strict()` -> `.passthrough()` | reviewed-project-restore.ts | killed (2) |
| M10 | `teamRecord` removed again | app-service-status.ts | killed (3) |
| M11 | `teamRecord` required | app-service-status.ts | killed (1) |
| M12 | `teamRecord` inner object opened | app-service-status.ts | killed (1) |
| M13 | `teamRecord.detail` limit 300 -> 3000 | app-service-status.ts | killed (1) |
| M14 | `teamRecord.status` gains a word | app-service-status.ts | killed (1) |
| M15 | `teamRecord.status` any string | app-service-status.ts | killed (1) |
| M16 | service status top object `.strict()` -> `.passthrough()` | app-service-status.ts | killed (1) |
