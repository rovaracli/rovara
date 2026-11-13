# S2: Cloud's sets to marker rows (data move, verification, rollback)

Owner decision 60 item S2, convergence plan D3. **Staging only**: the controller runs it under DECISIONS 181 (89's sign-off, a clean dry run, this rehearsed reverse, a restore
point, a stop on any surprise). Production stays closed. A lane builds and rehearses this; it never runs it against an AWS account.

## What moves

The move is `s2-limits-session-markers` in `packages/broker/src/cloud/migrations/plugins/limit-markers.ts`, run by `scripts/cloud-data-move.ts`. **It is table-wide**: it scans every row of the State table and moves every counter and session it finds, whatever the company. The `--company` option is required by the command but this move ignores it (an install has one company, ruling R3). Do not run it against a table that holds more than one install.

| Before (a DynamoDB string set) | After (one row per entry) |
|---|---|
| a member counter's `tasks`: `DEVELOPER_LIMIT#<person>/MEMBER` (the person family) and `ORG#<org>#SLACK_LIMIT#<team>/MEMBER#<user>` (the Slack family) | `TASK#<taskId>` in the counter's partition, `entityType: DEVELOPER_LIMIT_TASK`, `memberSk` = the counter's sort key |
| a SESSION item's `waitingOutboxIds`: `WORKSPACE#<ws>/SESSION` | `SESSION_WAITING#<outboxId>` in the workspace's partition, `entityType: SESSION_WAITING` |

- Both counter families move, so the move does not depend on which family a Slack-started core task charges (D3 chose the person's: `cloud/rows/core-rows.ts` `CORE_LIMIT_FAMILY`).
- Counts never change: a counter already counts the task. Organization counters never held a set.
- The Slack member `threads` list is a DynamoDB list, not a set. It needs no move; the port reads it.
- `modelKeyIds` needs no move (a list; only its writer changed).
- One item is ONE entry (one task, one parked outbox id), moved in one DynamoDB transaction: put the marker only if it is absent, delete the entry from the set only if it is still in it. An entry added to a set during the run stays in the set (the next run moves it); an entry released during the run is skipped. A run can stop anywhere and be run again.
- The framework could not say this as port steps (the port has no set operation and refuses to read a row holding a set), so the plan kind `native` was added to `framework.ts`; the move uses its own DynamoDB client for the write. Everything else (paging, dry run, resume file, conflict list) is the framework's.

## Order of releases (DECISIONS 152a)

1. **0.5.18** carries the readers (`feat/s2-readers`): it reads and releases both forms and still writes sets.
2. **0.5.19** carries the writers (markers) and this move. Install it with the switch OFF, then run the move.
3. **Rolling back from 0.5.19 to 0.5.18: do NOT run the reverse.** 0.5.18 frees marker-form slots and parked deliveries itself, and the reverse would only convert the core's own `TASK#` rows into sets the core cannot read.
4. **Below 0.5.18 (0.5.17 and older) is two hops**, in this order, see "Roll back". `agentx upgrade --rollback-to` refuses a target below 0.5.18 from 0.5.19 (`ROLLBACK_FLOORS` in `packages/cli/src/upgrade/target.ts`), so the first hop is also the only one the tool allows.

## Before the run (the controller)

Everything through `~/.local/share/rovara-tools/staging-aws.sh`, from the root of the 0.5.19 checkout. `<STATE>` is the State table (`StateTableName` output of the control-plane stack, `infra/lib/control-plane.ts`); `<ORG>` is the staging company id; `<DIR>` is a private folder for resume files.

1. **89 signs off** the 0.5.19 package and this runbook. 0.5.19 is installed with the core switch OFF, and was preceded by 0.5.18 (readers) on staging. Confirm both before anything else (stop if either fails):
   - **0.5.18 was installed before 0.5.19**: 89's install record for 0.5.18, and the release high-water mark read before the 0.5.19 install was 0.5.18. After the install: `~/.local/share/rovara-tools/staging-aws.sh aws ssm get-parameter --name /agentx/<env>/release-high-water --query Parameter.Value --output text` must now say 0.5.19 (it never reads a secret).
   - **The core switch is OFF**: the packed setting `cc` / the broker's `CLOUD_CORE_ENGINE` is `off`, empty or absent (until S3i wires the stack parameter the deployed broker reads it as off). Look at the control-plane stack's parameters (`~/.local/share/rovara-tools/staging-aws.sh aws cloudformation describe-stacks --stack-name agentx-<env>-control-plane --query "Stacks[0].Parameters"`) for the core engine parameter; no such parameter also means off.
2. **Find the table** (read only):
   `~/.local/share/rovara-tools/staging-aws.sh aws cloudformation describe-stacks --query "Stacks[].Outputs[?OutputKey=='StateTableName'].OutputValue" --output text`
3. **Restore point.** Note the UTC time (`date -u +%FT%TZ`). Confirm point-in-time recovery is on:
   `~/.local/share/rovara-tools/staging-aws.sh aws dynamodb describe-continuous-backups --table-name <STATE> --query ContinuousBackupsDescription.PointInTimeRecoveryDescription`
   (`PointInTimeRecoveryStatus` must be `ENABLED`). Also take an on-demand backup named with the time:
   `~/.local/share/rovara-tools/staging-aws.sh aws dynamodb create-backup --table-name <STATE> --backup-name s2-before-<UTC-time>` and wait for `BackupStatus` `AVAILABLE`:
   `~/.local/share/rovara-tools/staging-aws.sh aws dynamodb describe-backup --backup-arn <arn> --query BackupDescription.BackupDetails.BackupStatus --output text`.
   **Sum of the member counts, before** (read only; counts never change, so this number must be the same after the move and after a reverse). It scans the member counters of both families and adds their `count`:
   `~/.local/share/rovara-tools/staging-aws.sh aws dynamodb scan --table-name <STATE> --consistent-read --filter-expression "(begins_with(#pk, :dev) AND #sk = :member) OR (contains(#pk, :slack) AND begins_with(#sk, :memberPrefix))" --expression-attribute-names '{"#pk":"pk","#sk":"sk","#c":"count"}' --expression-attribute-values '{":dev":{"S":"DEVELOPER_LIMIT#"},":member":{"S":"MEMBER"},":slack":{"S":"#SLACK_LIMIT#"},":memberPrefix":{"S":"MEMBER#"}}' --projection-expression "#pk, #sk, #c" --output json | python3 -c 'import sys,json; items=json.load(sys.stdin)["Items"]; print("counters", len(items), "sum of counts", sum(int(i.get("count",{}).get("N","0")) for i in items))'`
   Write the two numbers down.
4. **No task starting.** Nothing may start a task during the run (the move is safe against it, but the counts below are only clean when it is quiet). The 0.5.19 writers write markers, so the set count can only fall: run the forward dry run (next step) twice, one minute apart; the second `writes` must be the same or lower, and never higher. A higher number means set writers (an older release) are still live: stop.
5. **Dry run, forward** (reads only; the default). The report's `writes` is the number of set entries that would move; `conflicts` must be 0:
   `~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/cloud-data-move.ts --move s2-limits-session-markers --table <STATE> --company <ORG> --direction forward`
   Record `scanned`, `writes`, `conflicts`. (Exit code 3 means conflicts were found.) To count markers before the move, run the reverse dry run: its `writes` is the number of marker rows (the core's own `TASK#` rows included).

## Run

6. **Apply**:
   `~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/cloud-data-move.ts --move s2-limits-session-markers --table <STATE> --company <ORG> --direction forward --apply yes --resume <DIR>/s2-forward.resume.json`
   Add `--max-pages <n>` to cut a run into short pieces; run the same command again and it carries on from the resume file (mode 600; it holds a table key, which can name a person: never print it). A finished run marks the file `done`. Delete the file only to start over (safe: each entry moves at most once).
7. **Verify**: repeat the forward dry run until it reports `writes: 0` and `conflicts: 0`. Then run the reverse dry run: its `writes` must equal the markers before plus the entries moved (the number from step 5). Run the sum command of step 3 again: **the counters and the sum of counts must equal the numbers written down before** (a difference means a task started or closed meanwhile, or the move touched a count: stop and compare with the backup). Spot check one counter and one session: the count did not change, `tasks` / `waitingOutboxIds` is gone, the `TASK#` / `SESSION_WAITING#` rows are there.

## Stop conditions (stop, do not retry, tell the owner)

- `conflicts` above 0 in any dry run or apply (read the conflict list: step "By hand").
- A forward dry run `writes` that goes UP between two looks (a set writer is live).
- Any error that is not a throttle (AccessDenied, ValidationException, a table that is not the State table).
- After an apply, a dry run that still moves entries after two more applies.
- A failed task start, a limit refusal that is wrong, or a parked delivery that is not sent, seen at any time after the apply.

## Roll back

**To 0.5.18: roll back the code and stop. Do NOT run the reverse.** 0.5.18 reads and releases both forms, so nothing is stranded; the reverse is not needed and would only convert the core's own `TASK#` rows into set entries that the core cannot read or release. Check the sum of the member counts against the number written down before the move (step 3): it must match.

**Below 0.5.18 (0.5.17 or older) is two hops. Never go straight from 0.5.19 to 0.5.17**, and the tool refuses it (`ROLLBACK_FLOORS`):

1. **Hop 1: roll back the code to 0.5.18.** Check 0.5.18 is what is installed (`/agentx/<env>/settings` version through `agentx`, and the release high-water mark still 0.5.19).
2. **Middle step: the reverse, only now**, and only with **the core switch OFF and no core task open** (the reverse turns the core's `TASK#` rows into set entries; a core task that is still open would then have a slot only the core's own release, which deletes the row, can no longer free). Confirm both first (the switch as in "Before the run"; no open core task: no row `TASK_ENGINE#<id>` / `STAMP` whose task is not closed, or ask 89 for the list). Then:
   `~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/cloud-data-move.ts --move s2-limits-session-markers --table <STATE> --company <ORG> --direction reverse --apply yes --resume <DIR>/s2-reverse.resume.json`
   It puts every marker back into its set, including markers the new release wrote after the switch. Repeat the same command until it stops; then run it without `--apply yes` until it reports **`writes: 0` and `conflicts: 0`**. Fix any `conflicts` by hand (below) and repeat. Run the sum of member counts (step 3) and compare: it must equal the number written down before the move.
3. **Hop 2: roll back to 0.5.17 or older**, only after the middle step is clean. **Why this order:** 0.5.17 reads only the sets. Its `releaseConflict` treats a release that fails at the member's `contains(tasks)` condition as "already released", so a task still held as a `TASK#` row is never freed: its slot leaks for good (the count stays up, no later release finds it). Its parked-delivery code never sends a `SESSION_WAITING#` delivery either. After the middle step no marker exists, so 0.5.17 sees every slot and every parked delivery.
4. If anything else is wrong, restore from the point-in-time restore point or the backup of step 3 into a NEW table and compare; never restore over the live table.

## By hand (conflicts)

The conflict list names each row's key (a marker's key, so the entry is in the `sk`) and a reason. Each fix is one `delete-item` or one `update-item`, always run through `~/.local/share/rovara-tools/staging-aws.sh aws dynamodb ...`; after any fix, run the dry run again: it must report 0 conflicts.

- **In the set and already a marker row** (forward) / **in the set and a marker row** (reverse): the entry is in both forms. The count is right either way (it counts the task once). Keep the set entry and delete the marker (`~/.local/share/rovara-tools/staging-aws.sh aws dynamodb delete-item --table-name <STATE> --key '{"pk":{"S":"<pk>"},"sk":{"S":"<sk>"}}'`), then run the forward move again.
- **orphan: its counter or session is gone**, or **orphan: its session is deleted** (reverse): a marker whose counter or session no longer exists, or whose session is deleted (the reverse never puts a parked delivery back on a deleted session). If its task or outbox record is closed, delete the marker. Otherwise add the entry to the right set by hand and tell the owner.
- **changed under the move twice**: the entry kept changing under the write. Look at the counter, run the dry run again; it is usually gone on the next look.

## Rehearsal (local, no AWS)

`npx tsx scripts/s2-rehearsal.ts --endpoint http://127.0.0.1:<port>` seeds a staging-shaped table on the local Rovara emulator and runs these same commands through the real CLI: dry run, apply (cut after one page and resumed), verify, reverse dry run, reverse, verify, apply again. It refuses any endpoint that is not loopback, passes dummy credentials, and exits non-zero if any check fails. Start the emulator with `DOCKER_HOST=unix:///nonexistent ROVARA_AWS_DEV_OPEN_CONTROL=1 QUARKUS_HTTP_PORT=<port> ~/web/rovara-local-aws/dist/native/rovara-local-aws` and check `docker ps` afterwards.

Result of the last rehearsal (the emulator has the same set semantics as DynamoDB for `ADD`, `DELETE`, `contains` and `TransactWriteItems`, probed first; it is not DynamoDB Local, which is not installed here):

| Step | Scanned | Writes | Conflicts | Set entries left | Limit markers | Session markers |
|---|---|---|---|---|---|---|
| Before | | | | 156 | 9 (the core's own) | 0 |
| Forward dry run | 156 | 156 | 0 | | | |
| Forward apply (cut after one page: 90, then resumed: 66) | 156 | 156 | 0 | 0 | 135 | 30 |
| Forward dry run after | 0 | 0 | 0 | | | |
| Reverse dry run | 165 | 165 | 0 | | | |
| Reverse apply | 165 | 165 | 0 | 165 | 0 | 0 |
| Reverse dry run after | 0 | 0 | 0 | | | |
| Forward apply again | 165 | 165 | 0 | 0 | 135 | 30 |

Checks that passed: the dry run wrote nothing; every count unchanged; the reverse left every set the move took out exactly as it was; the second forward ended in the first forward's rows. The 9 extra entries in the reverse and the second forward are the core's own `TASK#` rows (they had no set to go back to; the reverse puts them in their counter's set so the previous releases can free them, and the second forward names their counter in `memberSk`).
