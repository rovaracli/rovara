# Runbook: a new resource size or name against the account's limits (before a switch-on or an install)

Why this exists: on 2026-11-10 the Team record switch-on on staging (0.5.12) failed at the embedder function: CloudFormation refused `MemorySize` 10,240 because the account's Lambda memory limit is 3,008 MB. The rollback then left one thing behind: the DynamoDB table `agentx-staging-team-record` (fixed name, deletion protection on), which blocks the next try with "already exists". A template diff, cfn-lint and a no-execute change set cannot see either problem: the first is an account limit, the second is state outside the stack.

## Rule

Any change that creates a resource, or makes one bigger, needs two answers before a switch-on or an install touches a real account:

1. Is the new size or count inside the account's limit? (the table below)
2. Does a fixed-name, deletion-protected resource from an earlier failed try stand in the way? (the second table)

## What the repo checks for you

- `infra/lib/account-limits.ts` holds the limits this product assumes (Lambda memory 3,008 MB). `tests/contract/account-limits.test.ts` synthesises the control plane (Public cloud with the Team record off and on, Enterprise with it on) and fails if any Lambda function asks for more. To ask for more than 3,008 MB: get the account's limit raised first, confirm it (below), change the number in `account-limits.ts` in the same commit and name the account.
- `agentx upgrade` (the main path and the Enterprise `--bundle` path), `agentx deploy` (cdk engine) and `agentx config set teamRecord.enabled 1` run a read-only check (one DynamoDB DescribeTable) before the first Team record build: if `agentx-<env>-team-record` exists while the control plane stack has no Team record, they stop with the fix, before any AWS write. They delete nothing. The table's item count they print is approximate (DynamoDB refreshes it about every six hours): look at the table with a live read before anyone deletes it. If the check cannot run they warn and go on; the operator role used by `config set` cannot read the table (adding that right would change the access stack of every install, so it was left out), and then the upgrade with admin credentials checks again. Do the manual check below when you saw the warning.

## Limits to confirm by hand

| Limit | How to read it | Notes |
|---|---|---|
| Lambda function memory (default 3,008 MB for a new account; the documented maximum is 10,240 MB) | Not in `aws lambda get-account-settings` and not a Service Quotas item as far as we found. Confirm with the AWS Support case that raised it, or by a throwaway create at the new size in the target account and region. | AWS Support raises it on request (hours to days). More memory also means more vCPU, so a smaller size is slower: measure before choosing. |
| Lambda reserved concurrency | `aws lambda get-account-settings` (`UnreservedConcurrentExecutions` must stay at or above 100 after the reservation) | The embedder reserves 4; the `agentxReservedConcurrency` context turns reservations off. |
| Lambda container image size | Fixed by Lambda at 10 GB uncompressed; it is not an account setting and not in `get-account-settings` (that `AccountLimit` reports zip code sizes and concurrency only) | The embedder image holds 2.5 GB of model weights plus the runtime; its size is in the release's `images.embedder` push. |
| VPCs per region, subnets, Elastic IPs, NAT gateways | `aws service-quotas list-service-quotas --service-code vpc` and `--service-code ec2` (Elastic IPs: L-0263D0A3) | The embedder adds one VPC with two subnets and no gateway. |
| Lambda concurrent executions (account) | `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384` | New accounts start low. |
| ECR, KMS, DynamoDB tables per region | `aws service-quotas list-service-quotas --service-code <ecr|kms|dynamodb>` | |

Use the staging helper for staging (`staging-aws.sh`), never the default region of this machine.

## Left-over fixed-name resources to confirm absent before the first Team record build

| Resource | Name | Why it survives a rollback |
|---|---|---|
| DynamoDB table | `agentx-<env>-team-record` | Deletion protection is on, so the rollback's delete is refused and the table stays with its fixed name. The CLI check above covers this one. |
| S3 vectors bucket, S3 tables bucket, Athena workgroup | `agentx-<env>-record-vectors`, `agentx-<env>-record-lake`, `agentx-<env>-record` | Fixed names. Whether one can survive a failed first create was not tested; look if a build fails on "already exists". Not checked by the CLI. |
| Log group, queues, schedules | `/aws/lambda/agentx-<env>-embedder`, the `agentx-<env>-team-record-*` queues | Removed with the stack as a rule; look if a build fails on "already exists". |

If the table is an orphan (no Team record in the stack, no items you need): the account owner turns off its deletion protection and deletes it, then runs the upgrade again. A table with data is never deleted to make an upgrade pass.

Root cause to remember: a deletion-protected resource with a fixed name cannot be cleaned up by a rolled-back first create (the same reason `infra/lib/audit-ledger.ts` and `infra/lib/retention.ts` note). Prefer that a first create can be undone; if a resource must be protected, the pre-check above is the guard.

## Long texts at 3,008 MB (the embedder)

The embedder function runs at 3,008 MB (about 1.7 vCPUs). A text near the model's 2,048-token limit took about 17 s under Docker on Apple silicon at that size; Graviton may be slower. The broker's waits are 15 s (ingest) and 20 s (re-embed job, inside a 25 s run). The re-embed job therefore handles rows like this: it starts a LONG row (6,000 characters or more) only when a whole 20 s wait is left; it counts a timeout on any row (`embedTimeouts`), because the cost is tokens and a 3,000-character row of CJK, code or logs can reach the cap too; and at the second timeout it marks the row `embedSkip` and logs `record.embed_too_long`. A timeout never counts toward the job's "two failures in a row" stop (an embedder that is down, refused or answering 5xx, still stops the run). The broker cannot tell a cold container from a warm one (the function's init report does not reach it), so a timeout on a cold start can count against a row that would finish warm; the second timeout comes on a later run, 15 minutes later, and staging check 5 (cold against warm long-text times) says whether that is enough. A skipped row keeps its text and is found by keyword search until the text expires; it is tried again when the embedding spec changes or `TOO_LONG_RETRY_EPOCH` in `packages/broker/src/team-record/reembed.ts` is raised, or when someone removes `embedSkip` and `embedTimeouts` from the row. The text is never cut shorter to fit: the spec pins the model's token limit, and a different prefix is outside what the parity gate checks. The real Lambda times (the staging checks below) decide whether a larger account limit is worth asking for; if they are far over 15 s, ask AWS Support for the limit first and raise `ASSUMED_LAMBDA_MEMORY_LIMIT_MB` and `EMBEDDER_MEMORY_MB` together.

## Staging checks before the next Team record switch-on

All through `staging-aws.sh` (us-west-2). Read-only unless the step says otherwise.

1. `aws dynamodb describe-table --table-name agentx-staging-team-record` returns ResourceNotFound; no `agentx-staging-record-vectors` vector bucket and no `agentx-staging-record-lake` table bucket is left over.
2. `aws lambda get-account-settings`: `UnreservedConcurrentExecutions` stays at 100 or more after reserving 4 for the embedder. If the account's concurrency is low, upgrade with `--no-reserved-concurrency` or get the limit raised first (a reservation fails CREATE the way MemorySize did).
3. The VPC count per region is under the quota (the embedder adds one VPC with two subnets).
4. The 0.5.13 embedder image build log shows `parity_check.py` passing and `embedder smoke ok`, and the image is linux/arm64.
5. Right after the switch-on, invoke the embedder directly: cold with a short query, then warm with a short query; a 2,048-token document twice in a row. From the REPORT and INIT_REPORT lines record Max Memory Used (expect well under 3,008), Init Duration (the 10 s init limit), and both long-text durations. If the second long call is not faster than the first, the page cache is being thrashed.
6. With admin credentials, `agentx --env staging upgrade ...` runs the pre-check without a "Could not check" warning.
7. During the first re-embed runs watch the logs for `record.reembed_stopped`, `record.embed_pending` (ingest) and `record.embed_too_long`. Repeated stops in one workspace were the old stall; `record.embed_too_long` shows rows the function could not finish in time.
