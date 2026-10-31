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

Owner decision, 31 October 2026 (option A): **an Enterprise upgrade is built at approval.** When your administrator approves a release, Rovara's signed release is used to build the templates for your install, from your own settings, and what the approval pins is the result of that build. Nothing is built when the upgrade runs.

1. Rovara sends you the release notes and the bundle's id.
2. Your administrators record the settings your install is built from, once, and again when they change: `agentx bundle record-settings --file settings.json`. They are your network ranges for the workers, your timestamp authority for the audit log, the operator-access settings (principal, external id, approvers, log groups), the private MCP ranges and the other build settings the release accepts (a fixed list; an unknown key is refused). They are stored in your own Parameter Store (`/agentx/<env>/synth-settings`). Neither the bundle, a command-line option nor the Rovara operator can set or change them: the operator role has no Parameter Store access at all.
3. Your administrator runs `agentx bundle approve --bundle <dir> --approved-bundle-sha256 <id> [--parameters parameters.json] [--yes]` with your own credentials. It verifies the signature, every file's hash and the id (task N3). For an Enterprise install (the edition recorded in your account), it then:
   - reads your recorded settings and checks they are this install's (environment, region, identity mode);
   - runs the release's own pinned CDK app, **the synthesis kit** the signed bundle carries, with exactly those settings and nothing else: a scrubbed environment (no credentials, no proxy, none of your shell's variables), a directory of its own, and, where this Node has the permission model, no file access beyond its own files. The kit is signed with the bundle; it is given no network and needs none;
   - checks what it produced (every stack, every package, nothing extra, nothing built for no install) and writes the result as a manifest only this command writes: no time, no path, no host in it. The same bundle and the same settings are the same bytes, so the same hash;
   - **shows you** the settings it used (a secret as its hash), the kit's hash, the result's hash, and per stack what changes against what is deployed now (resources added, removed and changed; IAM changes; parameters). It refuses to go on if a stack is not deployed or if the access stack would change (the deployer never changes the access stack, so it would refuse the approval);
   - asks you to confirm (or takes `--yes`), loads the bundle's images into your registry, places the **built** templates and packages under `approved/<id>/built/` (not the release's own prebuilt templates), and last writes `approvals/<id>.json`. The record pins each file's object version and hash, the **hash of the result**, the hash of the kit, the hash of the settings and every setting, and the stack parameters a deployment may set (`parameters.json`). Every parameter not named keeps its current value.
   For an install that is not Enterprise, nothing changes: the bundle's own templates are placed and pinned as before.
4. In your change window a Rovara operator assumes the role and runs `agentx upgrade --deploy-approved <id>`. That sends the deployer exactly `{"bundleId": "<id>"}`.
   Your own administrators can do the same in one step: `agentx upgrade --bundle <dir>` on an Enterprise (cdk-engine) install builds at approval, writes the approval and starts the same deployer for that bundle id. Nothing of the bundle's prebuilt templates is deployed on this path, and `--no-reserved-concurrency` and every other option that would change what is built is refused.
5. To refuse or undo: do not approve, or run `agentx bundle withdraw <id>` (it deletes the record). The deployer reads the current record on every start, so a withdrawn bundle is refused, including one that was half deployed. Changing the recorded settings ends every approval built from the old ones.

An older release is refused unless the approval says `--rollback` (for a `--bundle` upgrade, never). A bundle whose build changes the access stack (the stack that holds this role and the deployer) is refused: your administrators deploy that one.

## What the deployer does, in order

It refuses unless every step holds, and it returns only fixed words and part names (never text from a stack or a file):

0. The deployer publishes to your alert topic that it was called (the bundle id, or null for a malformed request). If it cannot, it does nothing. It publishes again with the outcome. Nothing here depends on CloudTrail data events.
0. Your switch (`/agentx/<env>/operator-access/state`) says `enabled`, and no other run holds the lock (one run at a time; a lock older than 20 minutes is taken over, atomically: the run reads the parameter back and proceeds only if it holds exactly its own value at the next version; a lock that cannot be read is dated by when the parameter last changed).
1. The request is exactly a bundle id (an extra field, a template, a stack name, a parameter is refused).
2. `approvals/<id>.json` exists in the current version of your bucket and names this id.
3. Your list of trusted signing keys (`/agentx/<env>/bundle-trust/public-keys`, written by your administrators; the operator role cannot even read it) is not empty.
4. Each pinned file version is read once, and its size and hash match both your record and the signed manifest; the manifest's hash is the id; the signature verifies against a trusted key; the approval, the manifest and the release agree about the version; the files pinned are exactly the files the manifest lists.
5. The installed version is not newer than the bundle, unless you approved a rollback.
5a. The install's edition, read from your account: an Enterprise install takes only an approval that pins a build made at approval (below), and an install that is not Enterprise never takes one. An edition record that cannot be read refuses. **The bundle's own prebuilt templates are refused for every Enterprise install.**
5b. For a build made at approval: the build's manifest is the result the approval pinned; every settings hash agrees with your recorded settings **as they are now** (a record you changed since refuses); the kit hash is the hash of the kit entries in the signed manifest; the build is of this bundle, this version, this environment and region; every built file's hash is the one the build's manifest lists; the files pinned are exactly the signed lineage and the build, and the build holds exactly this install's stacks.
6. The access stack is unchanged (compared apart from where its Lambda code is read from, so an install first deployed with CDK's bootstrap bucket compares equal to one built for parameters, and a change of code or anything else does not).
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
8. Built at approval: with an access stack first deployed by `cdk deploy`, run `agentx bundle approve` for a real release and confirm the summary says `access: unchanged` (the comparison ignores where the Lambda code is read from, and nothing else); then change one setting of the access stack and confirm it says changed. Then run the deployer on a real build and confirm a change set for each stack is created from the `deploying/` copies.
9. Run the real synthesis kit under the Node permission model (the runner confines it to its own files) and confirm it builds; a kit that needs a path outside its own files fails, and the fix is in the kit, never a wider allowance.
10. Change one recorded build setting after an approval and confirm the deployer refuses that approval until it is approved again.

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

The same keys, with the rest of the build's settings (network ranges, audit timestamp authority, private MCP ranges), are what `agentx bundle record-settings` records for the build at approval; the list the release accepts is `SYNTH_CONTEXT_KEYS` in `packages/contracts/src/synth-build.ts`. The recorded values must be the ones this install was deployed with: `agentx init` and `deploy` do not record them yet (see "What is not built").

The trusted signing key comes from you, not from the bundle: it is written to `/agentx/<env>/bundle-trust/public-keys` by the access stack, and `agentx bundle approve` and `agentx upgrade --bundle` read the same list. A key published beside a bundle is not trusted by that fact. Record the key's fingerprint (SHA-256 of its SubjectPublicKeyInfo) in your security file when you first set it.

## What is not built

- **The synthesis kit producer.** The approval, the runner, the verification, the deployer and the Enterprise routing are built and tested with a small test kit. What is not built is the release pipeline step that produces the real kit: the release's CDK app bundled so that it runs from the signed bundle alone (its Lambda code is bundled from source today at synth time, which needs the source tree and `node_modules`; the kit needs those code directories prebuilt and the app's `NodejsFunction`s pointed at them). Until it exists, a real release carries no kit and `agentx bundle approve` refuses an Enterprise install with "this bundle carries no synthesis kit".
- Recording the build settings from `agentx init` / `deploy` (they are recorded today with `agentx bundle record-settings`).
- The Node permission model confines the kit's file access, not its network (Node 22/24 have no network permission). The kit is signed code; the summary says when confinement is not available.
- Worker, Slack and executor images are mirrored into the bundle and repositories exist for them, but the engine that sets the runtime stack's image parameters still derives them from the pull-through cache. Pinning them in the approval's `parameters.json` works; automatic use is not built.
- Change windows.
- A signing key. The release key is a KMS key; its public half has to be created, published and put in your `rovaraBundleSigningKeys` (an owner and operations step). Until then every bundle is refused.
- A trial in a real account: the sealed-network install proof (N10) is where suspend, alert delivery, the deployer and a refused unapproved bundle are shown working.

## Reading content

Needs a separate, expiring grant from you with its own approval. It is not part of this role.
