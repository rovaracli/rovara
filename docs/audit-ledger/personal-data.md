# Personal data in the audit ledger

This page is the source for the privacy notice's section on the audit ledger. The list of stores below is also in code
(`AUDIT_DETAIL_STORES` in `packages/broker/src/audit/erase.ts`), and `tests/contract/audit-erase.test.ts` checks the two agree and that no
copy of a person's details outlives its window in the test fakes.

## What the ledger holds

The chain (the ledger table, the seals, the locked bucket) holds no name, email, login, repository name, project name, domain or reason.
It holds ids, actions, times, a small allowlist of facts, and a salted commitment per person. The details themselves (the names and the
rest) are sealed in the **keys table**, each person's under a key of their own, wrapped by the company's data key, wrapped by KMS.

Deleting a key makes that person's details unreadable. The chain still verifies, because it only ever held the commitments.

## What an erasure does

A Rovara staff member erases one person from one company (`POST /v1/admin/audit/{orgId}/erase-subject`, with the reason, recorded):

1. In one transaction, the person's key is replaced by a tombstone (`{ erasedAt }`, no key) and the `audit.subject_erased` event is
   recorded. Either both happen or neither. From that moment the person's details cannot be read, by anyone, from any record, past or
   future. A later event about the same person is recorded without their details, and no key is ever made for them again.
2. The company's export files are deleted (they hold details in plain text). A person who asks for a new export gets one with the
   person's details shown as erased.

The answer says: "&lt;name&gt;'s details in the audit ledger can't be read any more. Copies in queues, backups and recent exports are
gone within 35 days."

## What a shred does

Thirty days after a company closes, its details are shredded. The anchor (every 15 minutes) writes a `SHREDDED` marker, waits at least 30
seconds so that any key already being created has landed, deletes every other item of the company's keys partition (its data key, its
pseudonym key, every person's key and tombstone) and its export files, and then clears its due item. The marker stays for good, so no key
is ever made for that company again. From the marker on, no new export can be started for the company and no download link is signed for
an old one. The records stay (the log of a closed company is evidence), and their details read as erased. The company's own record is not
touched.

## Every store that can hold details in plain text

| Store | Longest a copy lives there | How it goes |
| --- | --- | --- |
| Intake queue (SQS) | 14 days | Deleted when the appender appends the event. Only an event that is stuck stays, up to the queue's retention. |
| Intake dead-letter queue (SQS) | 14 days | A message that could not be appended waits here for at most the queue's retention. |
| Pending audit items (State table) | 14 days | Deleted as soon as the event is sent. An item that cannot be sent is removed by the table's time to live. |
| Point-in-time recovery of the State table | 35 days | Keeps the table's earlier states for up to 35 days, counted from the day a pending item was deleted. |
| The State table's change stream | 1 day | Keeps a change for 24 hours. |
| Export files (S3) | 7 days | Deleted when a person is erased and when a company is shredded. Otherwise the bucket's lifecycle rule removes them after 7 days; an export stops being offered after 6. |
| The appender's and the broker's memory | 5 minutes | A decrypted key is cached for 5 minutes. Erasure and shredding are read from the keys table on every call, so they take effect at once. |

The ledger table, the seals table, the locked bucket and the logs never hold details. (Logs record ids, actions and error names only.)

## The completion window to state

- The details are unreadable in the ledger **at once** when the erasure is accepted.
- Copies in queues, pending items, backups and recent exports are gone **within 35 days**.
- A copy can be older than the pending item's time to live only if it was never delivered (the intake queue was down for days). The
  worst case for an undelivered event is its 14 days in the State table plus the 35 days the table's backups keep it after deletion, 49
  days from the event. The notice says "within 35 days" of the erasure for what exists at the time; an event stuck at that moment can
  take longer. A person who needs the worst case in writing should be given 49 days.
- The keys table has no point-in-time recovery, so a deleted key is gone at once, and nothing can bring it back.

## Not covered by an erasure

- Any export a person already downloaded, and copies the company made of them.
- The person's name in the company's own systems (their sign-in record is not part of the ledger and is not touched by this).
- An export that began building before the erasure and finishes after it can leave one file with the person's details in the exports
  bucket until the bucket's 7-day lifecycle removes it. The export function re-checks only for a shredded company, not for an erased
  person; the notice's "recent exports are gone within 35 days" covers it.
