# The Rovara operator role (Enterprise, managed-VPC agreement)

Draft of 31 October 2026. This page replaces the earlier break-glass wording ("no standing access; a role disabled until you flip a parameter") wherever it appears. Owner decision, 31 October 2026: under the managed-VPC agreement Rovara holds one standing operator role in your account. It is narrow, you control it, and every use is visible to you. Your security team must still agree to it per install.

Status marks as in the security pack: **[Built, not deployed]** means infrastructure code and tests exist and nothing has run in an account. **[Designed]** means written down and not built.

## What it is for

Running upgrades. The role can start the deployment of a Rovara release bundle that you approved first, through a deploy role you own. It can read stack events and health metrics so it can tell whether an upgrade worked. It cannot do anything else.

## What it is not

This page does not promise that Rovara cannot read your content, and no list of denied actions on one role could promise it: code that is deployed to your account runs under the application's own roles, and those roles read your stores. The promise rests on three things together.

1. **Only a bundle you approved is deployed.** A bundle carries a signature from Rovara's release key and a hash of every file in it. Its id is the SHA-256 of its manifest. You approve an id; you then place that bundle in a bucket that only you can write to. The operator role can deploy templates from that bucket and from nowhere else.
2. **Your deploy role does the work.** CloudFormation runs under a service role you own (`agentx-<env>-cloudformation`). The operator role may pass that role and no other, and may create no role.
3. **The operator role is narrow, with your switches above it.** You can suspend it at once, you see every use, and a Rovara operator can neither change the role nor redeploy the stack that holds it.

## The approval step, in practice [Built, not deployed] (bucket and role) [Designed] (the command that places a bundle)

1. Rovara sends you the release notes and the bundle's id.
2. Your team checks the bundle: `agentx upgrade --bundle <dir> --approved-bundle-sha256 <id> --bundle-public-key <our published key>` verifies the signature, every file's hash and the id before it changes anything (task N3, built). Your team approves the id in its own process.
3. Your team places the verified bundle under `approved/<id>/` in the approval bucket (stack output `ApprovedBundlesBucketName`). Only your principals can write there: the operator role and the deploy role are denied by the bucket policy and by the role's own policy. The command that does this placement is not built yet; until it is, your team copies the files with its own tooling.
4. In your change window a Rovara operator assumes the role and runs `agentx upgrade --bundle <dir> --approved-bundle-sha256 <id>`. The CLI refuses any other id for this role (built, task N6). CloudFormation refuses any template that is not under `approved/` in your bucket (the role's policy, built).

Not built: the engine path that uploads nothing and deploys the templates already sitting in the approval bucket. Today the CLI's templates engine writes packages to the install's artifact bucket, which the operator role is not allowed to write; that is the deliberate effect of the narrow role, and it means the operator flow needs that engine change before the first real upgrade (see "What is not built").

## Who may assume it

- One named IAM role in Rovara's account (`rovaraOperatorPrincipalArn`). An account root, a user, a wildcard or a role pattern is refused when the stack is built.
- Your external id (`rovaraOperatorExternalId`, 16 characters or more) is required.
- Multi-factor authentication must have been used.
- The session must set a source identity (the name of the person). CloudTrail then names the person on every call, including calls made after role chaining. A session without one cannot be created.
- Sessions last at most one hour.

## What it can do

| Allowed | Limit |
| --- | --- |
| Start a CloudFormation change set | Only on this environment's stacks except the access stack; only with your deploy role; only from a template under `approved/` in your bucket |
| Run, inspect or delete change sets | This environment's stacks except the access stack |
| Read stack status, events, resources and templates | This environment's stacks |
| Pass a role | Only your deploy role, only to CloudFormation |
| Read templates and packages | Only under `approved/` in your approval bucket |
| Read the install's records in Parameter Store | `/agentx/<env>/` |
| Write upgrade records (settings, lock, bundle id, restore points) | Exactly those parameters |
| Load images into the bundle repositories | `rovara-bundle/<env>/*` only |
| Read health metrics and alarms | Any |
| Read log lines | Only log groups you name (`rovaraOperatorLogGroups`) that hold no content; none by default |

## What it can never do

These are explicit Deny statements. An Allow, here or in a policy someone attaches later, cannot override them.

- Any IAM change; passing any role but your deploy role; assuming any role; federation.
- A shell on a worker (`ssm:StartSession`, `ssm:SendCommand`, instance connect), console output, or a snapshot or image of a worker's disk.
- Reading or replacing function code or configuration; invoking functions.
- Any secret value; any use of a key (`kms:Decrypt` and the rest).
- Reading or writing the stores that hold code, tasks, plans, conversations and the Team record: DynamoDB data calls, queues, state machine histories, vector indexes, query results, model invocation.
- Reading any object outside `approved/`; writing any object anywhere; changing any bucket.
- Reading log lines outside the groups you named.
- Calling the stack APIs directly, touching the access stack, using any deploy role but yours, or deploying any template that is not under `approved/` in your bucket.

The tests (`tests/contract/operator-access.test.ts`) evaluate the synthesised policy against concrete requests for each line above, so a deny that is present but ineffective fails them.

## Your switches

**Suspend, at once.** Set the stack parameter `OperatorAccessState` of the access stack to `suspended` with your own admin credentials. The role then denies every action, in sessions that are already open too (inline policy changes apply immediately). Set it back to `enabled` to resume. The operator cannot do this and cannot redeploy the access stack: the role is denied it, and the CLI's operator path excludes it.

**Suspend without our stack.** You own the account, so you do not need our infrastructure code to stop the role. Any of these works on its own:

- Attach a deny to the role: `aws iam put-role-policy --role-name agentx-<env>-rovara-operator --policy-name customer-suspend --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}'`. [verify in a test account: that a later stack update leaves this policy in place.]
- Attach a service control policy that denies `*` to that role. Neither the operator role nor your deploy role can change an SCP.
- Delete the role. The access stack keeps it, so redeploy or remove the setting when you mean to keep it gone.

**Say no to a bundle.** Do not place it under `approved/`. Nothing else can start it.

**Change windows.** Not built. If you need the role to work only at set times, the same deny-all mechanism can be driven by a schedule you own. Owner to decide whether to build it.

## What you see

- Your CloudTrail records every assumption and every call under the person's name (source identity).
- An EventBridge rule sends each assumption of the role to the SNS topic `agentx-<env>-rovara-operator-use` (stack output `RovaraOperatorAlertTopicArn`). It carries API call metadata and no content. Subscribe your security mailbox. The rule sees the events your region's CloudTrail management events carry; check that your setup delivers `AssumeRole` events to the region of the install (the global STS endpoint reports in us-east-1; prefer the regional endpoint) [verify in a test account].
- We give you a monthly list of uses.

## How it is turned on

Enterprise installs only. The role does not exist unless the install's CDK context says so; a Public install, and an Enterprise install that does not ask, create none of it, and asking outside Enterprise stops the build.

| Context key | Meaning |
| --- | --- |
| `rovaraOperatorAccess` | `disabled` (default), `enabled` or `suspended` (starts suspended) |
| `rovaraOperatorPrincipalArn` | The one Rovara role that may assume it |
| `rovaraOperatorExternalId` | The external id you hold |
| `rovaraOperatorLogGroups` | Comma-separated exact log group names you allow, or none |

## What is not built

- The command that verifies a bundle and places it under `approved/<id>/` for you (the verification half exists).
- The engine path that deploys from the approval bucket without uploading anything (needed before the first real operator upgrade).
- Change windows.
- A signing key. The release key is a KMS key; its public half has to be pinned in the CLI and published at the first signed release (an owner and operations step). Until then every bundle is refused unless you pass your own `--bundle-public-key`.
- A trial in a real account: the sealed-network install proof (N10) is where suspend, alert delivery, and a refused unapproved template are shown working.

## Reading content

Needs a separate, expiring grant from you with its own approval. It is not part of this role.
