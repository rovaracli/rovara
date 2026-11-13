# S2: Cloud's sets to marker rows (migration, verification, rollback)

Owner decision 60 item S2, convergence plan D3. Owner gate G-DATA: the controller runs this, with the owner's go, in the release that carries S0. Never a lane.

## What moves

| Before (a DynamoDB string set) | After (one row per entry) |
|---|---|
| a workspace-limit member counter's `tasks` (`DEVELOPER_LIMIT#<dev>/MEMBER`, `ORG#<org>#SLACK_LIMIT#<team>/MEMBER#<user>`) | `TASK#<taskId>` in the counter's partition, `entityType: DEVELOPER_LIMIT_TASK`, `memberSk` = the counter's sort key |
| a SESSION item's `waitingOutboxIds` (`WORKSPACE#<ws>/SESSION`) | `SESSION_WAITING#<outboxId>` in the workspace's partition, `entityType: SESSION_WAITING` |

Counts never change: a counter already counts the task. `modelKeyIds` needs no move (it stays a list; only its writer changed).

The release that carries this code reads and releases both forms, so the migration can run with the release live. **The release before it reads only the sets**:
a row in the new form is invisible to it (a slot it never frees, a task it can charge a second time, a parked delivery it never sends). That is why rollback has a
fixed order (below).

## Run

All through the staging guard (`~/.local/share/rovara-tools/staging-aws.sh`), from the repository root.

1. Take a point-in-time restore point of the State table, and note the time.
2. Dry run (the default; reads only, prints counts):
   `npx tsx scripts/migrate-s2-marker-rows.ts --table <State> --direction forward`
3. When no task is starting, apply:
   `npx tsx scripts/migrate-s2-marker-rows.ts --table <State> --direction forward --apply yes`
   A run stopped by `--max-ms` keeps the place it stopped in `s2-migration-resume.forward.apply.json` (mode 600; it holds a table key, which can name a person,
   so it is never printed). Run the same command again; a finished run deletes the file. Delete the file only to start over from the beginning (safe: each entry
   moves at most once).
4. Repeat the dry run until `limitMoved` and `sessionMoved` are 0. `limitConflicts` / `sessionConflicts` above 0 are entries in both forms: see "By hand" below.

## Roll back

Only in this order:

1. **Roll back the code** to the previous release.
2. **At once**, run the reverse with `--apply yes`:
   `npx tsx scripts/migrate-s2-marker-rows.ts --table <State> --direction reverse --apply yes`
   It puts every marker back into its set, including markers the new release wrote after the switch, and deletes the markers. Until it has run, the previous
   release cannot see those slots and parked deliveries.
3. **Repeat until a dry run moves 0**:
   `npx tsx scripts/migrate-s2-marker-rows.ts --table <State> --direction reverse` shows `limitMoved: 0` and `sessionMoved: 0`.
4. **Fix `limitConflicts` by hand** (and `sessionConflicts`, `limitOrphans`, `sessionOrphans`), below.

## By hand

- **Conflict** (an entry is both in the set and a marker): keep the set entry, delete the marker. The count is right either way (it counts the task once).
- **Orphan** (reverse: a marker whose counter or session is gone, or a Slack marker with no `memberSk`): if its task or outbox record is closed, delete the marker;
  otherwise add it to the right set by hand and tell the owner.
- After any hand fix, run the dry run again; it must move 0 and report no conflict.
