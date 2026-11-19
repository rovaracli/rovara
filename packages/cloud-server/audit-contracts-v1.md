# Hosted audit contracts v1 (AUD-0)

These are pure private contracts in `packages/cloud-server/src/audit-contracts-v1.ts`.
They add no routes, IAM, AWS calls, capture integration, transport acceptance or
worker. No replay path or extensible acceptance placeholder is present. v1
refuses every delivery authenticated as ReplayRole regardless of body or claims
and performs no writes; recovery is only the original relay resending its
retained pending item. A successful-replay origin-proof design comes later to the
controller. Direct authenticated installation binding remains an AUD-3
enablement gate. Body fields and hashes provide no authentication.

The public module `@agentx/contracts/audit-record-v1` is mirrored from Code,
byte for byte, with its tests and independent golden fixture. The local SHA-256
manifest ratchets all three artifacts in each repo. Existing Cloud verifier code
was not moved to Code. Compatibility tests compare the new output with the
existing verifier's canonical bytes, genesis, record hash and commitment.

## Source mapping

| Source | Original ID/time | Actor | Target | Original-facts commitment |
| --- | --- | --- | --- | --- |
| Code durable `AuditEvent` | `eventId` / `at` | `actor.type`; salted commitment of `{type,id}` | salted `subject` or explicit none | all parsed source fields, including time and optional details |
| Cloud durable `CloudAuditRecord` | `id` / `at` | `actor.type`; salted commitment of `{type,id:developerId}` | salted `{subject}` or explicit none for empty subject | all parsed source fields, including actor name, project, outcome, via and detail |

Both mappings commit the source binding `{installId, companyId, sourceKind}` in
each commitment. The event-ID commitment uses subject `event-id`; actor and target
use `actor` and `target`; the full-facts digest uses `source`. Source JSON is sorted
and committed as text to preserve finite decimal source facts without changing the
existing verifier's safe-integer JSON format. Absent optional fields normalize to
absence. Unknown source fields refuse capture, so schema evolution cannot silently
drop a fact. Raw event IDs, names, target identifiers, project names and details
never appear in the mapped record. Machine action names, event/receipt times,
company/deployment IDs and actor kind remain visible. Deployment/company IDs must
be nonpersonal immutable configuration, and action names must remain a fixed
machine taxonomy. Golden mappings cover both source kinds.

Capture must persist a random per-event salt alongside the erasable original
source in the same atomic capture operation and reuse it on retries. The mapper
does not allocate it. Do not regenerate it when draining pending delivery. No salt
is included in the pending item, receipt or record. Erasing source details/salt
does not change existing mapped evidence; sources erased before capture cannot be
recovered. A future importer needs its explicitly marked import/coverage contract;
these functions do not authorize an unmarked historical import.

## Approved record families

| Family | Partition / sort key | Required meaning |
| --- | --- | --- |
| Pending | `AUDIT_PENDING#00` … `#0f` / encoded event ID | source identity, original-facts digest, capture time and commitment-only record content; no TTL; retain until matching committed receipt |
| Receipt | `RECEIPT#<install>#<company>` / encoded event ID | same identity/digest, committed sequence/hash/time; atomically written with append in AUD-3 |
| Seal progress | `SEALSTATE#<company>` / padded from/to sequence | fixed range/head/previous seal/epoch, batch root; planned → batch-locked → locked, with exact object versions |
| Epoch progress | `EPOCHSTATE#<epoch>` / `STATE` | fixed statement fields/hash; planned → waiting-timestamp → timestamp-received → timestamped |
| Verify job | `VERIFYJOB#<company>` / job ID | fixed checkpoint, bounded coverage and explicit terminal result; no arbitrary object-key input |

Pending shards are the low four bits of the first SHA-256 byte of the encoded
event identity. Receipt matching checks every identity component and facts digest;
it is meaningful only against the separately authorized committed receipt store.
Queue acceptance does not acknowledge delivery. Runtime CAS, atomicity, retention
and append proof are future worker obligations, not established by these parsers.

Object references require exact key/version, bytes digest, write time, COMPLIANCE
mode and retain-until at least 365 days after write time. AUD-4 must read back and
verify those values before persisting the corresponding locked phase. Persist
uploaded batch versions before seal upload; persist timestamp token bytes/hash
before token upload so restart uses the same received response. A worker must
resume the saved checkpoint and use conditional writes. Parsing asserted metadata
does not prove an S3 lock or a valid timestamp signature.

The verify worker invocation is only `{v:1,companyId,jobId}` and must load that
exact stored job. Submission derives company from current server authority;
start/result/download must recheck current company and owner/admin role. Stored
job fields never authorize a caller. A passed bounded result requires the full
checkpoint range, timestamp coverage and zero reported pending/unsealed backlog.
Partial/unavailable evidence is incomplete; a structural break carries the first
broken sequence/category; missing timestamp coverage remains visible. A result
proves only its range and fixed checkpoint, never total historical capture.

Region, minimum retention and TSA provider are required configuration inputs.
The pilot provider is `freetsa`; other provider labels are supported without
changing the contract. Provider transport, trust roots, timestamp verification,
same-account/region binding, size/cost validation and deployment remain later
review gates. The sample pending JSON is 878/889 bytes before storage-key/item
overhead; AUD-1 must measure complete worst-case DynamoDB item sizes against the
plan's budget rather than treating those examples as a size guarantee.
