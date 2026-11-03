# Signing Enterprise release bundles: the key, the role, and the owner's one-time steps

Status: the code is built and tested; **nothing here has been done in AWS or GitHub**. No signing key
exists (register item EW2-2). The steps below are for the owner to run later, once, by hand. Nothing in the
release workflow or in any deploy creates the key.

## What this protects, and what it does not

`release:kit` writes a synthesis kit and records the SHA-256 of every kit file in `kit.json`.
`release:bundle` checks those hashes again right before the bundle is finished, and the signing job checks
the whole bundle again from its bytes before it signs. Those hashes come from the kit itself, so they
protect against mistakes and against a file changing mid-run. They do not stop a person who can sign:
they could edit the kit, recompute `kit.json`, and sign it. So the real protection is **who can use the
signing key**.

What the code sets up (`infra/lib/bundle-signing.ts`, stack `AgentXBundleSigning`, `us-east-1`):

- **One signing job.** In `release.yml`, `bundle` builds and checks everything, holds no AWS credential
  and no `id-token`, and leaves the unsigned bundle folder as an artifact: **data only**. `sign` is the only
  job in that path with `id-token: write`. It never runs a file from that artifact. Its program comes from
  the tagged commit: it checks out only `scripts/release` and `packages/contracts/src` (actions pinned to
  commit SHAs), installs only `scripts/release/signer` (the KMS client, zod and esbuild, with its own
  lockfile) using `npm ci --ignore-scripts`, builds `sign-bundle.ts` from the checked-out source, and only
  then takes the AWS credentials. That program checks every file of the downloaded folder against
  `bundle.json` again (and the kit against `kit.json`) and signs. Tests pin all of this
  (`release-workflow.test.ts`, `signer-package.test.ts`).
- **The role** `rovara-release-bundle-signing` is assumable only through GitHub's OIDC token, and only when
  all of these hold:
  - `aud` is `sts.amazonaws.com`;
  - `repository_id` and `repository_owner_id` equal the repository's immutable ids (a renamed or
    reclaimed name cannot match);
  - `environment` is `release-signing` and `sub` is that repository's environment subject, in either
    the id form `repo:*@<ownerId>/*@<repoId>:environment:release-signing` or the name form;
  - `job_workflow_ref` is `<owner>/<repo>/.github/workflows/release.yml@refs/tags/v?*.?*.?*` and
    `ref` is `refs/tags/v?*.?*.?*`.

  The environment is what separates the sign job from the `images` and `npm` jobs, which also hold
  `id-token` (for other roles): the trust policy cannot tell jobs of one workflow apart by name, but only
  the sign job's token carries the `release-signing` environment.
- **The key**: ECC P-256, `SIGN_VERIFY`, deletion policy Retain. The key policy allows `kms:Sign` and
  `kms:GetPublicKey` only when the caller is that role, explicitly denies `kms:Sign` to every other
  principal, and gives administrators management actions without `Sign`, `Verify` or `CreateGrant`.

**This does not make a shared account safe.** An administrator cannot call `Sign` directly, but anyone who can
edit IAM or the key policy in the same account can re-open the role: `iam:UpdateAssumeRolePolicy` on the
role and then assume it; delete the role and create one with the same name (the key policy matches the role's
ARN string); or `kms:PutKeyPolicy`. The staging account (944937319445) holds roles that can do this (the
CDK deploy role, the publish role's admin). That is why:

- the signing account is a required setting, and `944937319445` is refused at synth unless
  `agentxBundleSigningAllowSharedAccount=true` is given (the synth then prints a warning);
- the recommended setup is a **dedicated AWS account** for the signing key, protected by the organisation
  service control policy below.

Residual risks, even with everything below done:

- **The signer's own supply chain.** The sign job runs the KMS client, zod and the esbuild binary from
  `scripts/release/signer/package-lock.json` (hash-pinned, installed without install scripts). A compromised
  release of one of those three at the locked version, or a malicious change to the lockfile or to
  `scripts/release` in the tagged commit, would run with the signing role. Keep that folder tiny, review
  every change to it as a key-holder change (CODEOWNERS on `scripts/release/signer/**`,
  `scripts/release/sign-bundle.ts`, `scripts/release/bundle-verify.ts`, `scripts/release/bundle-signer.ts`
  and `.github/workflows/release.yml`), and upgrade its three dependencies deliberately, not by bot. A
  committed hash of the built signer would not close this: the tagged commit controls that hash too.
- **A compromised `bundle` job.** It runs the whole project's dependencies, but it can no longer change
  the signer: it can only hand over a folder, and the signer signs it only if every file matches
  `bundle.json` and the kit matches `kit.json` and the release. It can still hand over a bundle that is
  consistently malicious (a poisoned kit with its own matching `kit.json`), and the kit's self-checks run
  in that same job, so they do not defend against it. The reviewers of the `release-signing`
  environment are the defence: they approve a release whose tagged commit they have looked at.
- Anyone who controls the tagged commit controls the workflow file and the signer built from it, so the environment's required reviewers and the tag ruleset are what
stop a malicious tag; the tag pattern can only be approximated (`v?*.?*.?*`, the workflow triggers on
`v[0-9]+.[0-9]+.[0-9]+`; IAM `StringLike` has no character classes), so it also matches names like
`vx.y.z`, which the ruleset and the reviewers must refuse.

## One-time steps for the owner

Nothing below has been run. Region `us-east-1`. Use the dedicated signing account; check
`aws sts get-caller-identity` and the region before every command. (This stack is not run through
`staging-aws.sh`: that script forces the staging account in `us-west-2`, which is the wrong place for
this key.)

### 1. A dedicated signing account and its OIDC provider

1. Create an AWS account for signing (an Organizations member account), with no workloads, and note its 12-digit id.
2. In it, create the GitHub OIDC provider if none exists:

   ```sh
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```

   Its `ClientIDList` must contain `sts.amazonaws.com` (check with
   `aws iam get-open-id-connect-provider --open-id-connect-provider-arn <arn>`). No thumbprint is needed:
   AWS validates GitHub's token with its own trusted CA list. An account holds one provider per URL, so
   the stack takes its ARN rather than creating it.

### 2. GitHub: ids, environment, tags

1. Get the immutable ids: `gh api repos/PrepLabsAI/Rovara --jq '"\(.owner.id)/\(.id)"'` (for PrepLabsAI/Rovara
   this is `272978771/1307121896`, see docs/releases.md).
2. Create the **environment** `release-signing` (Settings, Environments) on the repository that runs the
   workflow:
   - required reviewers: at least two release owners, and "prevent self-review" on;
   - deployment branches and tags: selected tags only, pattern `v*.*.*`;
   - no secrets, and no variables other than what the workflow already reads.
3. Add a **tag ruleset** for `v*`: only the release owners can create matching tags; block updates,
   non-fast-forward changes and deletion; no bypass for anyone else. A ruleset cannot require that a tagged
   commit is on `mainline`; the check for that lives in the `images` job of the tagged commit itself, which a
   tag pusher controls, so keep it a second line of defence and rely on who may push tags and on the reviewers.
4. Keep branch protection on `mainline`.

### 3. Synthesize, review and deploy the stack (in the signing account)

```sh
npx cdk synth AgentXBundleSigning \
  -c agentxBundleSigning=enabled \
  -c agentxBundleSigningAccountId=<signing account id> \
  -c agentxBundleSigningRepository=PrepLabsAI/Rovara \
  -c agentxBundleSigningRepositoryIds=272978771/1307121896 \
  -c agentxBundleSigningOidcProviderArn=arn:aws:iam::<signing account id>:oidc-provider/token.actions.githubusercontent.com
```

Read the key policy and the role's trust policy in the output; they must match the list above. Then
`cdk deploy AgentXBundleSigning` with the same context. The key has deletion policy Retain and termination
protection is on: every installer pins the public half, so a deleted key cannot be replaced without a new CLI.
The repository must be the one whose `release.yml` runs the `sign` job (the job is guarded to
`PrepLabsAI/Rovara`); if you move the job, change the guard, its test and this setting together. Use
`-c agentxBundleSigningEnvironment=<name>` only if the GitHub environment has another name.

### 4. Protect the role and the key (organisation management account)

Attach this service control policy to the signing account, after the stack is deployed (the stack's own
deploy creates the role, so later changes go through the break-glass principal). Replace the placeholders.
Resource names for KMS are key ARNs, so use the key ARN from the stack output.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProtectTheSigningRole",
      "Effect": "Deny",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"
      ],
      "Resource": "arn:aws:iam::<signing account id>:role/rovara-release-bundle-signing",
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": "arn:aws:iam::<signing account id>:role/<break-glass role>" } }
    },
    {
      "Sid": "ProtectTheSigningKey",
      "Effect": "Deny",
      "Action": ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:ScheduleKeyDeletion", "kms:DisableKey"],
      "Resource": "<key ARN>",
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": "arn:aws:iam::<signing account id>:role/<break-glass role>" } }
    }
  ]
}
```

Keep one break-glass role (MFA, used only for this, its credentials not in CI), and make the
organisation's own administrators unable to detach the SCP without a second person.

### 5. An alarm on those calls

In the signing account, an EventBridge rule on CloudTrail management events, to an SNS topic that pages the
owners:

- IAM: `CreateRole`, `DeleteRole`, `UpdateAssumeRolePolicy`, `PutRolePolicy`, `AttachRolePolicy` where
  the role name is `rovara-release-bundle-signing`;
- KMS: `PutKeyPolicy`, `CreateGrant`, `ScheduleKeyDeletion`, `DisableKey` on the key;
- KMS: any `Sign` on the key whose caller is not an assumed-role session of the signing role (this should
  never fire; the key policy denies it, and the denied attempt is itself the signal).

Check the rule fires (call one of them with the break-glass role in a test, or send a test event) before
the first release.

### 6. Repository variables

From the stack outputs: `AGENTX_BUNDLE_KMS_KEY` = `BundleSigningKeyArn`, `AGENTX_BUNDLE_SIGNING_ROLE_ARN` =
`BundleSigningRoleArn`, then `AGENTX_BUNDLE_ENABLED=true`. The `bundle` and `sign` jobs are off until all
three are set.

### 7. Prove the limit before the first real release

- From a branch or a `workflow_dispatch` run on a branch, the `sign` job must fail at
  `configure-aws-credentials` (not assumable) or be refused by the environment.
- From a tag, a job outside the environment (for example a throwaway workflow step in the `images` job
  in a test fork) must fail to assume the role.
- From your own credentials, `aws kms sign --key-id <arn> --message fileb://x --message-type RAW --signing-algorithm ECDSA_SHA_256`
  must be denied, even as an administrator of the signing account.
- AWS documents `job_workflow_ref`, `repository_id`, `repository_owner_id`, `ref` and `environment` as
  condition keys for the GitHub provider (IAM user guide, "Available keys for AWS OIDC federation").
  The first real assume is still the proof: if any claim failed to match, the role cannot be assumed
  (a failed release, never a weaker policy).

### 8. Publish the public key

Fetch it with `aws kms get-public-key` (the sign job does this at run time), add it to
`packages/cli/src/upgrade/bundle/trusted-keys.ts` (`PINNED_BUNDLE_SIGNING_KEYS`) in a CLI release made
before the first signed bundle, and publish it on the release channel for `--bundle-public-key`.

## Changing who may sign later

Through the break-glass role only: replace the stack's key policy or role (a CloudTrail alarm fires, by
design). Do not add `kms:Sign` to any IAM user or role policy: the key policy's Deny overrides it.
