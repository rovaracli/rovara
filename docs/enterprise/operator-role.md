# The Rovara operator role (Enterprise, managed-VPC agreement)

Draft of 31 October 2026, revised after two reviews. This page replaces the earlier break-glass wording ("no standing access; a role disabled until you flip a parameter") wherever it appears. Owner decision, 31 October 2026: under the managed-VPC agreement Rovara holds one standing operator role in your account. It is narrow, you control it, and every use is visible to you. Your security team must still agree to it per install.

Status marks as in the security pack: **[Built, not deployed]** means infrastructure code and tests exist and nothing has run in an account. **[Designed]** means written down and not built. **[verify]** marks a behaviour of AWS that the tests cannot show and the install proof must.

## What it is for

Running upgrades. The role can ask a function in your account, the **bundle deployer**, to deploy a Rovara release bundle that you approved first. It can read stack status and health metrics so it can tell whether an upgrade worked. It cannot do anything else, and it does not deploy anything itself.

## What it is not

This page does not promise that Rovara cannot read your content, and no list of denied actions on one role could promise it: code that is deployed to your account runs under the application's own roles, and those roles read your stores. The promise rests on three things together.

1. **Only a bundle you approved is deployed, and what is deployed is what you pinned.** A bundle carries a signature from Rovara's release key and a hash of every file in it. Its id is the SHA-256 of its manifest. You approve an id; your approval pins the exact stored versions of its files and the only stack parameters a deployment may set. The deployer re-checks all of it on every start.
2. **Your code does the deploying, with your role.** The deployer is a function in your account, with its own role, writing to your logs. CloudFormation runs under a service role you own (`agentx-<env>-cloudformation`), and only the deployer may pass it. The operator role may create no role, pass no role, and make no CloudFormation call that changes anything.
3. **The operator role is narrow, with your switches above it.** You can suspend it at once, you see every use, and a Rovara operator can neither change the role nor redeploy the stack that holds it.

## The approval, in practice [Built, not deployed]

1. Rovara sends you the release notes and the bundle's id.
2. Your administrator runs `agentx bundle approve --bundle <dir> --approved-bundle-sha256 <id> [--parameters parameters.json]` with your own credentials. It verifies the signature and every file's hash and the id (task N3), loads the bundle's images into your registry, places the deployable files under `approved/<id>/` in your approval bucket, and last writes `approvals/<id>.json`. That record pins each file's object version and hash, the release version, whether a rollback is intended, and the stack parameters the deployment may set (`parameters.json`: `{"control-plane": {"BudgetMonthlyUsd": "300"}}`). Every parameter not named keeps its current value.
3. In your change window a Rovara operator assumes the role and runs `agentx upgrade --deploy-approved <id>`. That sends the deployer exactly `{"bundleId": "<id>"}`.
4. To refuse or undo: do not approve, or run `agentx bundle withdraw <id>` (it deletes the record). The deployer reads the current record on every start, so a withdrawn bundle is refused, including one that was half deployed.

An older release is refused unless the approval says `--rollback`. A bundle that changes the access stack (the stack that holds this role and the deployer) is refused: your administrators deploy that one.

## What the deployer does, in order

It refuses unless every step holds, and it returns only fixed words and part names (never text from a stack or a file):

0. The deployer publishes to your alert topic that it was called (the bundle id, or null for a malformed request). If it cannot, it does nothing. It publishes again with the outcome. Nothing here depends on CloudTrail data events.
0. Your switch (`/agentx/<env>/operator-access/state`) says `enabled`, and no other run holds the lock (one run at a time; a lock older than 20 minutes is taken over, atomically: the run reads the parameter back and proceeds only if it holds exactly its own value at the next version; a lock that cannot be read is dated by when the parameter last changed).
1. The request is exactly a bundle id (an extra field, a template, a stack name, a parameter is refused).
2. `approvals/<id>.json` exists in the current version of your bucket and names this id.
3. Your list of trusted signing keys (`/agentx/<env>/bundle-trust/public-keys`, written by your administrators; the operator role cannot even read it) is not empty.
4. Each pinned file version is read once, and its size and hash match both your record and the signed manifest; the manifest's hash is the id; the signature verifies against a trusted key; the approval, the manifest and the release agree about the version; the files pinned are exactly the files the manifest lists.
5. The installed version is not newer than the bundle, unless you approved a rollback.
6. The access stack is unchanged. (For an Enterprise install this refuses today: see "What is not built".)
7. The customer's switch is read again before every stack (below). A restore point is written (create-only), then each of the five fixed stacks (`foundation`, `identity` unless you bring your own provider, `runtime`, `control-plane`, `slack`) is updated in order, never created or deleted. For each: the template is the verified bytes, copied to `deploying/` (a prefix only the deployer may write) and handed to CloudFormation by the exact object version just written; every existing parameter is kept at its current value; each package's verified bytes are copied the same way and the stack's code location is that copy (Lambda reads the current object at a key, so the approved object itself is never the source); the only values that change are the ones your approval pins, and a pinned parameter the template does not declare, or a new parameter with no value, is refused. The change set goes through your deploy role.
8. After the last stack: the installed-bundle record and the settings version are written, and the progress record is closed. A deployment that needs longer than one run of the function resumes from its progress record.

## Who may assume it

- One named IAM role in Rovara's account (`rovaraOperatorPrincipalArn`). An account root, a user, a wildcard or a role pattern is refused when the stack is built.
- Your external id (`rovaraOperatorExternalId`, 16 characters or more) is required.
- Multi-factor authentication must have been used. [verify: a session obtained through IAM Identity Center may never satisfy it; confirm in the test account before relying on it.]
- The session must set a source identity (the name of the person). CloudTrail then names the person on every call, including calls made after role chaining.
- The role can be assumed only through this region's STS endpoint (`aws:RequestedRegion` is part of the trust policy), so the assumption is always recorded in the region where the alert rule listens. [verify: that the key is evaluated for `AssumeRole` through the regional endpoint.]
- Sessions last at most one hour.

## What the operator role can do

| Allowed | Limit |
| --- | --- |
| Invoke the bundle deployer | That function only; not a qualified version, not any other function |
| Read stack status, events and resources | The environment's stacks, by exact name (an environment called `prod-eu` is not reachable from `prod`) |
| Read health metrics and alarms | Any |
| Read log lines | The deployer's log group (bundle ids and fixed words) and the groups you name (`rovaraOperatorLogGroups`), which must hold no content |

It holds no S3, Parameter Store, registry or CloudFormation write at all. It cannot write the settings, the installed-bundle record or the restore points: only the deployer writes them, after verification.

## What it can never do

These are explicit Deny statements. An Allow, here or in a policy someone attaches later, cannot override them; the tests evaluate the role with a policy that allows everything added, and check each of these still holds.

- Any IAM change; passing any role; assuming any role; federation.
- A shell on a worker (`ssm:StartSession`, `ssm:SendCommand`, instance connect), console output, or a snapshot or image of a worker's disk.
- Reading or replacing any function's code or configuration; invoking any function but the deployer.
- Any secret value; any use of a key (`kms:Decrypt` and the rest).
- Reading or writing the stores that hold code, tasks, plans, conversations and the Team record: DynamoDB data calls (including PartiQL and transactions), queues, state machine histories, vector indexes, query results, model invocation.
- Any S3 call; any Parameter Store write; any registry write.
- Reading log lines outside the groups above.
- Any CloudFormation call that creates, updates, executes or deletes.

The tests (`tests/contract/operator-access.test.ts`) evaluate the synthesised policies against concrete requests for each line above; `tests/contract/bundle-deployer.test.ts` exercises the deployer's refusals.

## Your switches

**Suspend, at once.** Set the stack parameter `OperatorAccessState` of the access stack to `suspended` with your own admin credentials. The role then denies every action, in sessions that are already open too (inline policy changes apply immediately). The same switch is mirrored to `/agentx/<env>/operator-access/state`, which the deployer reads before it starts and before every stack, so a run already going stops before its next stack (the stack being updated finishes; CloudFormation cannot be stopped half way); a call queued asynchronously is dropped (no retry, 60 seconds of age at most). Progress is kept; set the parameter back to `enabled` and the same run continues. Set it back to `enabled` to resume. The operator cannot do this and cannot redeploy the access stack: the role is denied it, and the deployer refuses a bundle that changes it.

**Suspend without our stack.** You own the account, so you do not need our infrastructure code to stop the role. Any of these works on its own:

- Attach a deny to the role: `aws iam put-role-policy --role-name agentx-<env>-rovara-operator --policy-name customer-suspend --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}'`. [verify in a test account: that a later stack update leaves this policy in place.]
- Attach a service control policy that denies `*` to that role. Neither the operator role nor your deploy role can change an SCP.
- Delete the role. The access stack keeps it, so redeploy or remove the setting when you mean to keep it gone.

**Stop the deployer.** Remove the deployer's permission to pass the deploy role, or set its reserved concurrency to zero. Nothing is deployed while it cannot run.

**Say no to a bundle.** Do not approve it, or withdraw it (above). Nothing else can start it.

**Name the people who may approve.** `rovaraBundleApproverArns` is required (comma-separated role or user ARNs; never `role/*`, and never this module's own roles). The bucket refuses approvals and withdrawals from every other principal of your account, administrators included unless named. With none named the build stops, so the default is that nobody can approve. Approvers must all be in your account: the build stops if one is in Rovara's account (the account of `rovaraOperatorPrincipalArn`), matches the Rovara principal, or is in another account than the others (and, when the stack's account is known at synth, another than the stack's). The deployer's verified copies under `deploying/` can be written by the deployer alone, whoever else is named, and are kept (only superseded versions of a copy expire after seven days): a rollback to the previous bundle's Lambda code, or one you approve later, needs them. Clearing old copies is your administrators' act, after checking no stack or approval needs them.

**Clear a stuck deployment.** If a deployment failed and you do not mean to finish it (for example you withdrew its bundle), the deployer refuses every other bundle while its progress record stands. `agentx bundle reset-deployment` (your administrators; the operator role has no Parameter Store access) clears the record and the run lock. It refuses while a run holds a lock younger than 20 minutes, since that run may still be working. Stacks already updated stay as they are; check them first.

**Change windows.** Not built. If you need the role to work only at set times, the same deny-all mechanism can be driven by a schedule you own. Owner to decide whether to build it.

## What you see

- Your CloudTrail records every assumption and every call under the person's name (source identity).
- An EventBridge rule sends each assumption of the role to the SNS topic `agentx-<env>-rovara-operator-use` (stack output `RovaraOperatorAlertTopicArn`), and the deployer itself publishes to the same topic at every start and end (bundle id and fixed words; no content). The deployer's alert does not depend on CloudTrail: a function invocation is a CloudTrail data event and is not seen unless you log data events for it. The assumption rule needs an active trail that logs management events. Subscribe your security mailbox.

The deployer accepts any caller in your account that holds `lambda:InvokeFunction` on it; no application role does. Such a call skips the assumption alert, MFA and source identity, but it deploys only what you approved, and it is announced on the topic like any other. Do not grant that permission to people you would not trust to approve.
- The deployer writes its decisions to `/aws/lambda/agentx-<env>-bundle-deployer`, a log group in your account, kept for a year.
- We give you a monthly list of uses.

## Install-proof checklist for the [verify] items

Run these in the test account (Rovara's own, never a customer's) and write down what each shows; the results go into the security pack's evidence marks.

1. Assume the role through the regional STS endpoint and then the global one; only the regional one should succeed (`aws:RequestedRegion`), and an assumption event should reach the topic.
2. Assume it from a session obtained with MFA and one without, and from an IAM Identity Center session; record which satisfy `aws:MultiFactorAuthPresent`. If Identity Center sessions never do, the owner decides how Rovara's operators sign in (the MFA condition is not weakened in code).
3. Run the deployer for an approved test bundle; confirm CloudFormation reads the `?versionId=` template URL under `deploying/` with the deployer's credentials (the deployer holds `s3:GetObject` and `s3:GetObjectVersion` there, and CloudFormation fetches with the caller's credentials; if it does not, every change set is refused and nothing deploys), and that Lambda starts from the copied package.
4. Suspend while a multi-stack run is going; confirm it stops before the next stack and resumes after.
5. Withdraw an approval; confirm the next start is refused.
6. Attach the manual customer deny; update the stack; confirm the deny survives.
7. Export a real skopeo oci-archive and confirm `index.json` lists the source manifest digest (the builder refuses otherwise).

## How it is turned on

Enterprise installs only. The role does not exist unless the install's CDK context says so; a Public install, and an Enterprise install that does not ask, create none of it, and asking outside Enterprise stops the build.

| Context key | Meaning |
| --- | --- |
| `rovaraOperatorAccess` | `disabled` (default), `enabled` or `suspended` (starts suspended) |
| `rovaraOperatorPrincipalArn` | The one Rovara role that may assume it |
| `rovaraOperatorExternalId` | The external id you hold |
| `rovaraOperatorLogGroups` | Comma-separated exact log group names you allow, or none |
| `rovaraBundleSigningKeys` | JSON array of PEM public keys (ECDSA P-256) you trust to sign bundles; empty or absent: the deployer refuses every bundle |
| `rovaraBundleApproverArns` | The principals that may place and withdraw approvals (required; none named means the build stops) |

The trusted signing key comes from you, not from the bundle: it is written to `/agentx/<env>/bundle-trust/public-keys` by the access stack, and `agentx bundle approve` and `agentx upgrade --bundle` read the same list. A key published beside a bundle is not trusted by that fact. Record the key's fingerprint (SHA-256 of its SubjectPublicKeyInfo) in your security file when you first set it.

## What is not built

- **An Enterprise bundle cannot yet be deployed end to end.** The bundle carries the release's prebuilt, edition-less templates (the Public synthesis). An Enterprise install needs templates synthesised with its own network ranges and settings, which today means the CDK engine from a checkout of the release tag; the deployer deploys the templates it is given, so for Enterprise the bundle would have to carry per-customer templates or the source. This needs an owner decision between synthesising per customer at approval time and shipping a source archive with a CDK deploy step. The verification, the approval and the deployer are built and tested; the missing piece is what the templates are.
- Worker, Slack and executor images are mirrored into the bundle and repositories exist for them, but the engine that sets the runtime stack's image parameters still derives them from the pull-through cache. Pinning them in the approval's `parameters.json` works; automatic use is not built.
- Change windows.
- A signing key. The release key is a KMS key; its public half has to be created, published and put in your `rovaraBundleSigningKeys` (an owner and operations step). Until then every bundle is refused.
- A trial in a real account: the sealed-network install proof (N10) is where suspend, alert delivery, the deployer and a refused unapproved bundle are shown working.

## Reading content

Needs a separate, expiring grant from you with its own approval. It is not part of this role.
