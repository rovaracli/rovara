# Destroy inventory over SSM's standard tier: fix

Branch `fix/destroy-inventory`, based on `feat/agents-plan3` at `d687a475`.

## The failure

`tests/contract/destroy-inventory-size.test.ts` ("fits SSM's standard tier for a 20-character environment, with every retained resource of a real synth") failed with

```
CONFIG_INVALID: the list of resources environment abcdefghij-klmnopq12's stacks keep is larger than SSM's 4096-byte limit
```

In production this means `agentx destroy` refuses before it deletes anything, for any environment whose inventory is that large.

## Cause: which resources

The test's synth now retains 22 resources. The inventory (schema 1, one JSON object per resource with `part`, `logicalId`, `type` and `physicalId`) measured **4338 bytes**. That is 242 bytes over the limit.

Plan 3 merges added these retained resources, all in `control-plane` unless noted:

| Source | Retained resources |
| --- | --- |
| Audit Ledger (`infra/lib/audit-ledger.ts`, merged by `805115b` / `49279ec`) | 3 tables (`AuditLedgerTable`, `AuditSealsTable`, `AuditKeysTable`), 2 SQS queues (intake and its dead-letter queue), the `AuditExportsBucket` bucket, and the `AuditVaultKeyAlias` KMS alias. That is 7 entries, about 1.3 KB. |
| Model proxy (`infra/lib/model-proxy.ts`) | The secret `ModelProxySaltKey`. Its ARN is generated from the stack name, which makes it the longest single entry at about 250 bytes. |
| Slack action logs (`infra/lib/slack-orchestrator.ts`, slack stack) | `ActionLogsKey` (KMS key), the `ActionLogs` log group, and the `ActionLogsSource` delivery source. |
| Developer sign-in, turn records | The tables `DeveloperSignInTable` and `TurnRecords`. |

The clone is shallow (depth 50), so I could not find the exact commit where the size first went over 4096. At `805115b` (Audit Ledger merged into Plan 3) the inventory was already 4337 bytes.

## Fix: option (a), a compact stored format (schema 2)

File: `packages/cli/src/destroy/inventory.ts`.

- **In memory, nothing changes.** `Inventory` and `RetainedResource` keep the same shape, so `run.ts`, the deletion loop and the plan text are untouched.
- **Stored form, schema 2:**
  ```json
  {"schemaVersion":2,"env":"…","resources":{"control-plane":{"AWS::DynamoDB::Table":[["State1C20CC9A","-ABCDEFGHIJKLM","sl"]], …}}, …}
  ```
  - Each stack part and each resource type is written once, not once per resource.
  - Each resource is stored as `[logicalId, id]` (the physical ID verbatim) or `[logicalId, rest, form]`:
    - `"s"` means the physical ID is `<stack name>-` + `rest`.
    - `"sl"` means it is `<stack name>-<logicalId>` + `rest`.
  - The stack name is not stored. On reading it is derived again with `environmentStackName(env, part)`.
  - A name that does not start with its own stack's name is stored verbatim. This covers Cognito pool IDs, KMS key IDs, secret ARNs, and names from another stack.
- **Validation.** The stored form is checked with a strict zod schema: known stack parts, the form must be `s` or `sl`, and the same length bounds as before. The decoded result is then checked against the existing `InventorySchema`, which still caps it at 40 resources. A malformed inventory gets the same `CONFIG_INVALID` refusal as before. The 4096-byte check in `writeInventory` stays.
- **Backward compatibility.** `readInventory` accepts schema 1 (anything written by an earlier agentx) as well as schema 2. The next write saves it as schema 2.
- **Every retained resource is still deleted.** Decoding gives back exactly the same `{part, logicalId, type, physicalId}` list. The tests check this round trip, and the existing destroy-run tests pass unchanged. The only difference is order: resources come back grouped by stack part, then type. The deletion loop handles each resource on its own, so the order does not matter.

### Why not (b) or (c)

- **(b), split across several parameters.** This needs an index, writes that span several parameters (a partial write is a new failure mode inside the lock), and cleanup of every piece in step 7. It is more moving parts for a problem that a compact format solves.
- **(c), the Advanced tier.** It costs money for every environment, needs IAM and tier changes, and only doubles the limit. It was not needed.

## Sizes (the test's worst case: 20-character env, every optional field, longest physical IDs)

| | Bytes | Share of 4096 |
| --- | --- | --- |
| Before (schema 1) | 4338 | 106% (fails) |
| After (schema 2) | 2019 | 49% |

That leaves about 2 KB of headroom. At roughly 40 to 60 bytes per added generated-name resource, the inventory now reaches the 40-resource cap before it reaches the byte limit.

## Tests

The tests were written first and committed red (`6bc84ef`), then the fix (`eafadf0`).

- `tests/contract/destroy-inventory-size.test.ts` is unchanged and now passes.
- `tests/contract/destroy-plan.test.ts` has three new tests:
  - **Schema 2 format:** the exact stored JSON, covering `sl`, `s`, verbatim secret ARNs and Cognito IDs, and a name from another stack kept verbatim. It also checks that reading gives back the identical resource list.
  - **Schema 2 refusals:** an unknown stack part, or an unknown form tag, is refused.
  - **Reading schema 1:** an old-format inventory is read back exactly. After a merge and write it becomes schema 2 and still holds the same resources.
- `npx tsc -b`: clean.
- `npx vitest run tests/contract/destroy-*.test.ts --maxWorkers=2`: 5 files, 112 tests, all passing.
- ESLint on the changed files: clean.

## Notes and follow-ups (not changed here)

- **Older CLIs.** An older agentx that finds a schema 2 inventory will refuse it as "not an agentx destroy inventory" and suggest deleting it. Once a newer CLI has written an inventory, destroy should be run with a CLI at least this new.
- **Types destroy does not delete (pre-existing, not caused by this fix).** The inventory also records `AWS::SQS::Queue` (×2) and `AWS::Logs::DeliverySource` (×1), which `agentx destroy` reports as "delete it by hand". KMS aliases have the same gap in the per-resource loop, but the alias sweep (runs without `--keep-data`) catches them. The queues and the delivery source are new with Plan 3, so the tear-down tool should probably learn to delete them.
- **The test's synthetic physical IDs.** Some of them differ from what AWS really returns. For example, a KMS alias's physical ID is its alias name. Such IDs are simply stored verbatim, so the real inventory can only be the same size or smaller than the test's worst case.
