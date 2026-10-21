# Runbook: the audit anchor reports an object conflict, a chain mismatch or a version drift

Applies to the audit ledger's anchor (the function that seals each org's new records every 15 minutes) and to these alarms, named `agentx-<env>-<suffix>`:

| Alarm suffix | Log event | Meaning |
|---|---|---|
| `AuditObjectConflict` | `audit.object_conflict` | A create-only write got `412 Precondition Failed` and the bytes already stored at that key are not the bytes the anchor meant to write. The run stopped. |
| `AuditChainMismatch` | `audit.chain_mismatch` | An org's records or its sealed state do not fit the locked seal. That org was left unsealed in this epoch. |
| `AuditChainMismatch` | `audit.version_drift` | A key the anchor was about to create holds a delete marker, a second version, or one version with other bytes. That org was left unsealed in this epoch. |
| `AuditSealOverdue` | (no `audit.epoch_sealed` for 45 minutes) | The anchor is stopped, failing or not running. Usually the next step after one of the events above. |

Nothing here is a reason to delete anything. The sealed objects are locked on purpose, and the anchor never rewrites or removes a sealed object.

## What the anchor already does

- Every sealed object is created with `If-None-Match: *`. A second, different seal for the same records is refused by S3 itself.
- When a key already holds one version with the same bytes (a crash between the write and the bookkeeping), the anchor treats it as written and carries on. That is not an event.
- `audit.object_conflict` stops the whole run on purpose: sealing pauses for every org until a person has looked. The epoch stays open, no new epoch is opened, and the next run resumes the same epoch.
- On the next run the same key is met by the check that comes before every write. That check reports `audit.version_drift` for the one org and skips it; the other orgs seal normally. The skipped org is tried again in every epoch and alarms in each, until its records and sealed state fit the locked seals again.
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
