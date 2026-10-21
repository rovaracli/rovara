# Runbook: the audit anchor reports an object conflict, a chain mismatch, a version drift or a lock mismatch

Applies to the audit ledger's anchor (the function that seals each org's new records every 15 minutes) and to these alarms, named `agentx-<env>-<suffix>`:

| Alarm suffix | Log event | Meaning |
|---|---|---|
| `AuditObjectConflict` | `audit.object_conflict` | A create-only write got `412 Precondition Failed` and the bytes already stored at that key are not the bytes the anchor meant to write. That run stopped; see below for what the next run does. |
| `AuditChainMismatch` | `audit.chain_mismatch` | An org's records or its sealed state do not fit the locked seal. That org was left unsealed in this epoch. |
| `AuditChainMismatch` | `audit.version_drift` | A key the anchor was about to create holds a delete marker, a second version, or one version with other bytes. That org was left unsealed in this epoch. |
| `AuditLockDrift` | `audit.version_drift` | Same event as above, also found by the sweep that looks at a slice of the sealed keys every run: a sealed key holds a delete marker, a second version, another version than the one recorded, or no version. `reason` says which. |
| `AuditLockDrift` | `audit.lock_config_mismatch` | The ledger bucket is not what it must be. `check` says what: `default_retention_floor` (the default retention is below the floor: the run stops, nothing is written or finalized), `versioning` (not `Enabled`: the run stops), `default_retention_deployed` (differs from the deployed mode and days but meets the floor: alarm only), `bucket_policy` (the policy's hash differs from the synthesized one: alarm only), `object` (a sealed object came back with a weaker lock than the floor, or is gone), `ratchet_bucket` (the lock ratchet names another bucket than the configured one: the run stops). `expected` and `actual` carry both values. |
| `AuditLockDrift` | `audit.lock_sweep_failed` | The version sweep could not run in this run (an S3 or DynamoDB error, named in `error`). Sealing went on. If it repeats, nothing is looking for delete markers or extra versions: check the anchor role's `s3:ListBucketVersions` and the seals table. |
| `AuditSealOverdue` | (no `audit.epoch_sealed` for 45 minutes) | The anchor is stopped, failing or not running. Usually the next step after one of the events above. |

Nothing here is a reason to delete anything. The sealed objects are locked on purpose, and the anchor never rewrites or removes a sealed object.

## What the anchor already does

- Every sealed object is created with `If-None-Match: *`. A second, different seal for the same records is refused by S3 itself.
- When a key already holds one version with the same bytes (a crash between the write and the bookkeeping), the anchor treats it as written and carries on. That is not an event.
- `audit.object_conflict` stops that one run: the epoch stays open, no new epoch is opened, and nothing is finalized in that run. It does not keep the anchor stopped.
- The next run resumes the same epoch. It meets the same key in the check that comes before every write, which reports `audit.version_drift` for the one org and skips it; the other orgs seal normally and the epoch is closed. (If the conflicting key is the epoch's own statement or leaves object, the next run stops again with `audit.version_drift`, and sealing stays stopped for every org until a person has looked.) The skipped org is tried again in every epoch and alarms in each, until its records and sealed state fit the locked seals again.
- The anchor retries a `409` from S3 (another write to the key is in flight) up to five times, waiting 25 ms and doubling each time, before it gives up and the run fails.
- Every run starts by checking the bucket: its default retention against the floor, its versioning, its policy hash. A default retention below the floor or versioning that is not `Enabled` stops the run before anything is written (`audit.lock_config_mismatch`, `check` = `default_retention_floor` or `versioning`). Before an org is finalized, each of its objects and the epoch's two objects are read back by version id and must carry the floor's lock.
- The floor is in the anchor's code: a production-kind environment name is `COMPLIANCE` for 365 days; `staging`, `test`, `dev` and `dev-<suffix>` are `GOVERNANCE` for one day; a trial install (the `AuditLockProfile` stack parameter is `trial`) is `GOVERNANCE` for one day. It is a one-way ratchet: the first time the bucket's default retention is seen in `COMPLIANCE` mode the anchor creates `AUDIT_LOCK / RATCHET` in the seals table (once, with `attribute_not_exists`; it records the days and the bucket name), and from then on the floor is `COMPLIANCE` for at least those days whatever the parameter or the environment name says. Any item at that key counts as the ratchet. Do not delete or edit that item. If the bucket is ever replaced on purpose, the item names the old bucket and the check `ratchet_bucket` blocks finalizing until a person removes it with the table's own admin access. Objects written before the ratchet (a trial install upgraded to production with an epoch open) keep the trial floor they were written under. A failed sweep logs `audit.lock_sweep_failed` (same alarm) and does not stop sealing.
- Records appended while an org is skipped are not lost. They stay in the ledger table and are sealed once the org can be sealed.

## First look (read-only)

1. Find the event in the anchor's log group (`/aws/lambda/<anchor function>`): filter on `audit.object_conflict`, `audit.chain_mismatch` or `audit.version_drift`. The entry names the org (`orgId`), the epoch (`epochId`), and for conflicts and drift the key. For a chain mismatch, `reason` says which check failed:
   - `locked_seal_missing`, `locked_seal_unreadable`, `locked_seal_hash`, `locked_seal_end`, `locked_head_hash`: the sealed state in the seals table does not match the locked seal object it names.
   - `hash`, `link`, `gap`, `org`, `missing_records`: the org's records in the ledger table do not form the chain from the last sealed record.
   - `state_moved`: the org's sealed state changed between the epoch's freeze and now.
   - `finalize_refused`: the sealed state was changed after the seal was written; the seal is in the epoch's statement but the org's state did not move.
   - `statement_changed`: the epoch's frozen seals no longer give the statement that was chosen for it. The run stopped; nothing was rewritten.
2. List the versions of the key (read-only):
   `aws s3api list-object-versions --bucket <ledger bucket> --prefix <key>`
   A key with exactly one version and no delete marker is normal once sealed. A delete marker, a second version, or a version written at a time that does not fit any epoch is not.
3. Compare the bytes with what the anchor would write. Fetch the stored version with `aws s3api get-object --bucket <ledger bucket> --key <key> --version-id <id> <file>` and compare it with the seal named in `SEALS#<org>` (the index item for that first sequence number) and with the epoch's statement and leaves objects under `epochs/<yyyy>/<mm>/<dd>/`.
4. Check the org's state: the item `SEALED#<org> / STATE` in the seals table, the intents `EPOCH#<epochId> / ORG#<org>`, and the org's `HEAD` in the ledger table.
5. Check who changed what: CloudTrail data events for the ledger bucket and the two tables around the time of the first event.

## Lock mismatches (`audit.lock_config_mismatch`)

1. Read `check`, `expected` and `actual` in the entry.
2. `default_retention_floor` or `versioning`: someone changed the bucket (a stack update to the trial profile, a console edit, a restore). The anchor is stopped until the bucket is back at or above the floor: restore the stack's lock profile and default retention, and versioning. Do not lower the floor; there is no setting for it. Objects written while the bucket was weak were locked weakly; they cannot be strengthened. If the entry carries `key`, those are the objects (see below).
3. `object` with an `orgId`: that org's records or seal object was written with a weaker lock than the floor (the bucket was weak at that moment). The org is not finalized and its intent is marked blocked; the other orgs go on. The org stays unsealed from that sequence number and a person has to decide (engineering) how to continue; do not delete the object (it cannot be, in compliance mode).
4. `object` with only an `epochId`: the epoch's statement or leaves object has a weak lock. No org is finalized and the epoch stays open; the anchor stops in every run until engineering resolves it.
5. `bucket_policy`: compare `GetBucketPolicy` with the policy in the stack (CloudFormation drift detection on the bucket policy shows it). The check normalizes S3's serialization, but a first deployment is where a false positive would show: if the document is the stack's own, report the `actual` hash to engineering. This check never stops sealing.
6. `audit.version_drift` with a `reason` comes from the sweep (or from the check before a write): list the key's versions as in "First look".

## Reading the result

- **Identical bytes at the key.** Not a conflict. If it is reported anyway, that is a bug; keep the log lines and open an issue.
- **Different bytes, no explanation** (nobody ran a migration, no restore of the tables, no second deployment writing to the bucket). Treat it as a possible tampering attempt on the ledger: keep the evidence (log lines, `list-object-versions` output, the table items above, CloudTrail), tell the security owner, and do not edit the tables to make the alarm go away. Editing `SEALED#<org>` is exactly what the locked seals exist to catch.
- **A restore of the seals table from a backup or point in time** (the table now says an earlier seal is the last one, but the bucket holds later ones). The locked seals are the truth. The anchor will not seal over them and the org stays unsealed. The sealed state has to be rebuilt from the locked seals under `orgs/<org>/seals/`; there is no command for that yet, so stop and ask engineering, with the org id and the list of seal keys.
- **Two deployments, or a test run, writing to the same bucket.** Stop the other writer first. The conflicting objects stay (they are locked); the org they belong to stays unsealed until engineering has reviewed it.

## What not to do

- Do not try to delete or overwrite a sealed object, change a bucket's lock settings, or remove the bucket policy. In production (compliance mode) it cannot be done and the attempts are logged; in a trial install a removal destroys the evidence the ledger exists to keep.
- Do not delete the open epoch's items or `EPOCH_HEAD`. The epoch resumes by itself once the cause is gone.
- Do not raise the anchor's concurrency above 1.

## After it is resolved

The next run of the anchor resumes the open epoch and finishes it, then opens the epoch of its own slot. `audit.epoch_sealed` is logged again and `AuditSealOverdue` clears. An org that was skipped is sealed from the sequence number after its last locked seal, in the epoch after its records and state fit again.
