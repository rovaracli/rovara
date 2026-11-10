# Runbook: a new resource size or name against the account's limits (before a switch-on or an install)

Why this exists: on 2026-11-10 the Team record switch-on on staging (0.5.12) failed at the embedder function: CloudFormation refused `MemorySize` 10,240 because the account's Lambda memory limit is 3,008 MB. The rollback then left one thing behind: the DynamoDB table `agentx-staging-team-record` (fixed name, deletion protection on), which blocks the next try with "already exists". A template diff, cfn-lint and a no-execute change set cannot see either problem: the first is an account limit, the second is state outside the stack.

## Rule

Any change that creates a resource, or makes one bigger, needs two answers before a switch-on or an install touches a real account:

1. Is the new size or count inside the account's limit? (the table below)
2. Does a fixed-name, deletion-protected resource from an earlier failed try stand in the way? (the second table)

## What the repo checks for you

- `infra/lib/account-limits.ts` holds the limits this product assumes (Lambda memory 3,008 MB). `tests/contract/account-limits.test.ts` synthesises the control plane (Public cloud with the Team record off and on, Enterprise with it on) and fails if any Lambda function asks for more. To ask for more than 3,008 MB: get the account's limit raised first, confirm it (below), change the number in `account-limits.ts` in the same commit and name the account.
- `agentx config set teamRecord.enabled 1` and `agentx upgrade` run a read-only check (one DynamoDB DescribeTable) before the first Team record build: if `agentx-<env>-team-record` exists while the control plane stack has no Team record, they stop with the fix. They delete nothing. If the check cannot run (no permission, network) they warn and go on; then do the manual check below.

## Limits to confirm by hand

| Limit | How to read it | Notes |
|---|---|---|
| Lambda function memory (default 3,008 MB for a new account; the documented maximum is 10,240 MB) | Not in `aws lambda get-account-settings` and not a Service Quotas item as far as we found. Confirm with the AWS Support case that raised it, or by a throwaway create at the new size in the target account and region. | AWS Support raises it on request (hours to days). More memory also means more vCPU, so a smaller size is slower: measure before choosing. |
| Lambda reserved concurrency | `aws lambda get-account-settings` (`UnreservedConcurrentExecutions` must stay at or above 100 after the reservation) | The embedder reserves 4; the `agentxReservedConcurrency` context turns reservations off. |
| Lambda container image size, code size | `aws lambda get-account-settings` (`AccountLimit`) | The embedder image holds 2.5 GB of model weights plus the runtime; its exact size is in the release's `images.embedder` push. |
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
