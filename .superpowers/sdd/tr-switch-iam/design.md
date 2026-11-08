# TR-SWITCH-B1/B2: access stack grants for the Team record switch-on

Lane: feat/tr-switch-iam, base private/integ/0511 a166dee74. IAM only; no lessons code touched. Source of the findings: release-notes/0.5.10-team-record-switch-on.md.

## Problem
`agentxTeamRecord=enabled` makes the control-plane deploy create S3 Vectors, S3 Tables and Athena resources. The deploy role (`agentx-<env>-cloudformation`, inline policy `deploy`) and the permissions boundary (`agentx-<env>-boundary`) had none of those services, so the deploy would fail (B1), and the broker and the vector data role would be denied at run time (B2).

## What changed (all in packages/contracts/src/access-policies.ts, re-exported by infra/lib/access-policies.ts)

### Deploy role: new statements `TeamRecordStorage` and `TeamRecordLists` (exist whether or not the record is on)
Source of the action list: handler permissions of the six CloudFormation types, from the public registry schemas (read 2026-11-08, pinned in tests/fixtures/cfn-handler-permissions-team-record-2026-11-08.json). Resources: this environment's `agentx-<env>-record-vectors` (+ `/index/*`), `agentx-<env>-record-lake` (+ `/table/*`), workgroup `agentx-<env>-record`, in the deploy region and account.

The service role's inline policy is capped at 10,240 characters, so the actions are name patterns. The coverage test matches them against AWS's full action list for the three services (tests/fixtures/team-record-service-actions-2026-11-08.json) and requires the match set to equal the handler actions exactly.

| Pattern | Matches (and nothing else of the service) | Why |
|---|---|---|
| `s3vectors:*VectorBucket` | Create/Get/DeleteVectorBucket | VectorBucket handler (not the *Policy actions) |
| `s3vectors:*Index`, `s3vectors:ListIndexes` | Create/Get/DeleteIndex, ListIndexes | S3Vectors::Index (Enterprise's one index) |
| `s3vectors:*Tag*` | TagResource, UntagResource, ListTagsForResource | tags on create and update |
| `s3tables:*TableBucket` | Create/Get/DeleteTableBucket | TableBucket |
| `s3tables:*TableBucketEncryption` | Put/Get/Delete | encryption configuration |
| `s3tables:*TableBucket*Configuration` | Put/Get TableBucketMaintenanceConfiguration, Put/Get/Delete TableBucketMetricsConfiguration | unreferenced-file removal is maintenance config; metrics read back |
| `s3tables:*Table*StorageClass` | Put/Get TableBucketStorageClass and TableStorageClass | handlers read/set it |
| `s3tables:GetTableBucketReplication` | the read only | handler read-back |
| `s3tables:*Namespace*` | Create/Get/Delete Namespace, ListNamespaces | Namespace |
| `s3tables:CreateTable`, `ListTables`, `GetTable`, `DeleteTable`, `RenameTable`, `PutTableData` | | Table (PutTableData is what CreateTable with an Iceberg schema needs) |
| `s3tables:*TableMaintenanceConfiguration` | Put/Get TableMaintenanceConfiguration | compaction and snapshot settings |
| `s3tables:*Tag*` | the three tag actions | tags |
| `athena:*WorkGroup` | Create/Get/Update/DeleteWorkGroup (not ListWorkGroups) | WorkGroup |
| `athena:*Tag*` | the three tag actions | tags |
| `s3vectors:ListVectorBuckets`, `s3tables:ListTableBuckets`, `athena:ListWorkGroups` on `"*"` | | The three handler List operations. They take no resource type, so "*" is the only possible resource; they return names only. Not needed by stack create/update/delete as far as is known: first to drop if staging proves it. |

Left out on purpose (the record sets none of these properties): `iam:PassRole`, `iam:CreateServiceLinkedRole` (Athena Spark only), `s3tables:PutTableBucketReplication`, `s3tables:DeleteTableBucketReplication` (would let a deploy copy the lake elsewhere). `kms:*` and `s3:*` the handlers call are already in the Services statement. The test lists these as excluded with reasons.

### Boundary (ceiling)
- `Services` statement gains `athena:*`, `s3tables:*`, `s3vectors:*` (BOUNDARY_SERVICES via TEAM_RECORD_BOUNDARY_SERVICES; NOT in the service role's wildcard list), and, as named reads on `"*"`: `lakeformation:GetDataAccess` (no resource type, TRW-1 R3, left as is), `glue:GetCatalog`, `glue:GetDatabase*`, `glue:GetTable*`.
- Why wildcards and not this environment's ARNs: the boundary cap is 6,144 characters and had ~560 free. Naming the bucket, table bucket, workgroup and the Glue catalog by ARN measured +876 on the worst case (6,461, over the limit). As wildcards the worst case is 5,898 (limit with the existing margin 6,054). The grants that actually allow things (deploy role above, broker, vector data role) name the resources; the boundary is only their ceiling, like every other service in it.
- `ConnectorSecretsRole` statement (sts:AssumeRole, sts:TagSession) gains the vector data role's exact ARN. The path-less lookup list (`IamFixedNameRolesNotYetCreated`) gains its name, in both the deploy role and the boundary (via fixedNameEnvironmentRoleNames).
- Derivation of the runtime actions: the coverage test reads every statement the switch adds to any role from the synthesized control plane (switch-on minus switch-off) and checks each action and resource against the synthesized boundary. At present: s3vectors Put/Query/Get/DeleteVectors, GetIndex, CreateIndex; athena Start/Get/GetResults/StopQueryExecution; s3tables GetTableBucket, GetNamespace, GetTable, Get/UpdateTableMetadataLocation, Get/PutTableData; glue GetCatalog, GetDatabase(s), GetTable(s); lakeformation GetDataAccess; sts AssumeRole/TagSession on the data role.

### Vector data role name
`agentx-<env>-record-vectors-data` (teamRecordVectorsRoleName), set as `roleName` on the DataRole (infra/lib/team-record-vectors.ts, env passed through TeamRecordStorage). The role is only created with the record on, and the record has never been switched on in any environment, so the rename moves no live role. The broker still receives the name in its packed names (`vr`); the ARN it builds is `role/agentx/<env>/<name>` as before. Length with a 20-character environment: 47 of 64.
Added to fixedNameEnvironmentRoleNames, so the path-less lookup (iam:GetRole etc. on `role/<name>`, needed before the role exists) is granted to the deploy role and the boundary.

### Dispatcher record read (TeamRecordLessonReads)
- Not narrowed by `dynamodb:LeadingKeys`. A lesson shares its partition (`WS#<org>#P#<project>`) with the project's REC#/FACT#/SOURCE# rows; they differ only in sort key, and no IAM condition can see the sort key. The access records and settings the dispatcher must also read sit in the workspace partitions. Narrowing needs lessons in partitions of their own: a lessons-code and stored-data change (feat/lessons-prod-* owns lessons). Recorded in DEFERRED-CHECKS.
- Narrowed what can be: the `/index/*` resource is removed. Every read in the delivery path (DynamoLessonStore, the learning settings, the access reader) is GetItem / BatchGetItem / Query on the base table by pk and sk; none uses a GSI, and gsi1/2/4/5 project ALL attributes (recorded text). The contract test now pins "table only, no index, no condition".

## Tests
- tests/contract/team-record-iam-coverage.test.ts (new): synthesizes the app with the record on and off; checks deploy coverage by type, handler permissions on own resources, exact pattern match sets, refused lookalikes, boundary coverage of every added statement (action and resource), the deploy role's own grants under the boundary, the fixed name, the sts grant and the lookups. Includes tests that the checkers fail on a made-up uncovered type and out-of-boundary action. Mutation-checked once (dropping athena and Namespace made 4 tests fail).
- Updated: access-policies.test.ts, access-stack.test.ts (adds the record-on app), default-boundary-equivalence.test.ts (new record grants excluded from the v0.5.2 grid), role-paths.test.ts (record on, new fixed name), team-record-wiring-infrastructure.test.ts (dispatcher no index).

## Sizes (worst case: 20-character environment, organization id)
Boundary 5,585 -> 5,898 of 6,144 (test limit 6,054). Service role 7,907 -> 9,158 of 10,240 (test limit 9,240).

## Release ordering
Access stack first (it already deploys first in every upgrade, so one upgrade can carry this plus the switch-on). The control-plane switch-on fails without it. See DEFERRED-CHECKS TR-SWITCH-B1/B2 fix.
