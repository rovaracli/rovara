# Customer test account: what TA11 proves live, and what the signer and cleanup must do

Nothing in lane TA1 was run against AWS. The boundary (`packages/cloud-contracts/src/test-access-policy.ts`) is checked here by a small IAM evaluator in `tests/unit/test-access-policy.test.ts`; real IAM may differ. TA11 (Rovara's staging account, through `staging-aws.sh`, $20 cap) proves each item below. An item that fails is a bug in the boundary, not in the test.

## Prove live in TA11

From the second review (each one is a thing the boundary assumes):

1. `s3:ResourceAccount` is in the request context of `s3:CreateBucket` (and of object calls), so the S3 name fence holds across accounts.
2. `aws:RequestTag` and `aws:ResourceTag` work on event source mappings: create with the run tag succeeds, `GetEventSourceMapping` and `DeleteEventSourceMapping` by resource tag succeed, `UpdateEventSourceMapping` is refused.
3. A session tag overrides a role's tag. An outside principal assumes a run-created role with `rovara-run` set to another run: every call is refused (`Forged`).
4. An event source mapping to a shared function is refused (`lambda:FunctionArn` is in the create call's context), and to a run's own function succeeds. Also: whether a mapping to a shared queue can drain it (the function's role is bounded, so it should not be able to read it).
5. `ListVersionsByFunction`, `GetFunction` and `GetFunctionConfiguration` on a shared function are refused, and on the run's own succeed (they return environment variables).
6. EventBridge: `PutTargets` with a target in another account, or a shared target, is refused (`events:TargetArn`), and a rule on the default bus is refused.
7. DynamoDB replicas and Secrets Manager replication against the Region deny: creating a global table replica or replicating a secret to another Region is refused (`aws:RequestedRegion`), and a normal single-Region use is not.
8. `DeleteRole` of a run's role that still has attached or inline policies: the cleanup order (detach, delete the role policy, delete the policy, then the role) works with the cleanup role's permissions.
9. `iam:PassedToService` is set per service on `CreateFunction`, `CreateStateMachine` and `PutTargets`, so passing a role to Lambda, Step Functions and EventBridge works and to another service is refused.
10. `UntagResource` of `rovara-run` is refused on every service of the default list, and removing another tag key is not. Create-time tagging works: `sqs:CreateQueue` with Tags on `rv-<run>-q`, and `sqs:TagQueue` on it; tagging an untagged shared queue is refused.
11. A role created under a path (`/rv-<run>-x/admin`) is refused at `CreateRole` (`NoPath`), and cleanup finds and removes roles by the run's name prefix.

From the third review (the list of eight was not in the request; these are the eight things that review's fixes assume):

17. `events:TargetArn` is multivalued: `PutTargets` with a run target and a shared or outside target together is refused (`ForAnyValue:ArnNotLike`), one with none is refused (`NoTarget`), and a target in another Region or a name that merely contains the run id is refused (anchored, Region pinned).
18. `aws:PrincipalArn` for a role session is the role's ARN, not the assumed-role session ARN. The policy now lists only the role form (`Reads`, `Forged`, `RunRoles`); if real IAM gives the session form, every run-role rule fails open and this item is a release blocker.
19. `sns:Endpoint` is in the context of `sns:Subscribe`, and an `ArnNotLike` on it refuses SMS, email, HTTP(S), another account's queue and a call with no endpoint, while a subscription of a run's topic to a run's queue or function works.
20. `aws:ResourceAccount` is in the context of the create calls of every default service (`sqs:CreateQueue`, `sns:CreateTopic`, `dynamodb:CreateTable`, `lambda:CreateFunction`, ...), so the `Named` allow does not refuse the run's own creates, and it refuses a write to `rv-<run>-*` in another account.
21. Resource-policy and creation actions of a role a run creates (`RunRoles`): a Lambda function that deploys with an execution role can do its work (S3, DynamoDB, SQS data calls, logs) with every action of that list refused. `sqs:CreateQueue` and `sns:CreateTopic` carrying a Policy have no condition key, so they are refused outright for run roles and gated by the signer for the test role.
22. Replication: `dynamodb:CreateTableReplica`, `dynamodb:UpdateGlobalTable*` and `secretsmanager:ReplicateSecretToRegions` are refused for both roles even though the Region deny cannot see their target Region; `dynamodb:CreateTable` with a ResourcePolicy and a DynamoDB global table create are refused or gated by the signer.
23. `lambda:GetLayerVersion` and `GetLayerVersionByArn` on another team's layer are refused for both roles, and the run's own functions can still run (layers are not fenced to a run).
24. `ssm:SendCommand` and `ssm:CreateAssociation` are refused for both roles (explicit deny), and `ssm:PutParameter` and `GetParameter` on `rv-<run>-*` still work.

Carried from the first review:

12. The policy variable `${aws:PrincipalTag/rovara-run}` is accepted in `Resource`, `NotResource` and condition values.
13. `aws:PrincipalArn` for a role session is the role ARN (see item 18): confirm it.
14. `sts:TagSession` is granted by the trust statement that has no external id condition.
15. Whose credentials CloudFormation publishes to the SNS topic with, and what the response URL host looks like in each Region (`cloudFormationResponseHosts`).
16. Quick-create accepts a template with named IAM resources (CAPABILITY_NAMED_IAM) in one acknowledgement.

## For the signer (TA4)

IAM cannot see these, so the signer must:

- Read the trust policy of every `iam:CreateRole` (and refuse `iam:UpdateAssumeRolePolicy`, which the boundary already denies): only AWS service principals for Lambda, Step Functions and EventBridge. Never an AWS account, never `*`, never a federated principal. A run-created role has no path and a name `rv-<run8>-...`.
- Read every resource policy the test role sets (`lambda:AddPermission`, queue, topic, bucket and event bus policies): never `*`, never an AWS account that is not the connected one. Refuse a function URL with `AuthType: NONE`.
- Refuse `CreateBucket` with Object Lock enabled, and `dynamodb:CreateTable` or `UpdateTable` with deletion protection on. (The boundary cannot see either; the cleanup role can clear deletion protection with `dynamodb:UpdateTable`.)
- Read every resource policy and creation the test role makes that IAM cannot see (a Policy attribute on `sqs:CreateQueue` and `sns:CreateTopic`, `CreateTable` with a ResourcePolicy), and the policy actions the boundary denies only to run-created roles: `dynamodb:PutResourcePolicy`, `kinesis:PutResourcePolicy`, `secretsmanager:PutResourcePolicy`, `ssm:PutResourcePolicy`, `ssm:ModifyDocumentPermission`, `lambda:AddLayerVersionPermission`, `lambda:AddPermission`, queue, topic, bucket and event bus policies. Never public, never another account.
- Count and cap what the test role creates, per run: number of creates, provisioned DynamoDB read and write capacity, Kinesis shard counts, Lambda code size and memory, Lambda concurrency (the boundary refuses the account-wide pool actions), Step Functions state machines. A role a run creates builds nothing (boundary `RunRoles`), so every create is the test role's and passes the signer.
- Hold the read allow-list. Rovara's roles can read any resource of the connection's Region except secrets and Lambda configuration outside the run (boundary `Secrets`); an admin-allowed read of an existing secret or parameter needs a stack parameter that does not exist yet.

## For cleanup (TA6)

- Delete from the creation record, then sweep by the run's name prefix: roles `rv-<run8>-*`, policies, instance profiles, and anything under a path `/rv-<run8>-.../`. A role a Lambda function or a state machine created never reaches the signer, so the sweep (not the record) finds it. Roles a run creates can call no IAM (boundary `RunRoles`), so only the test role makes them.
- Take a role apart first: `DetachRolePolicy`, `DeleteRolePolicy`, `DeletePolicyVersion`, `DeletePolicy`, `RemoveRoleFromInstanceProfile`, then `DeleteRole`.
- Before a customer deletes the stack, delete the run-created roles: the boundary policy cannot be deleted while a role carries it.
