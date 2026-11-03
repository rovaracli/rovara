# Signing Enterprise release bundles: the key, the role, and the owner's one-time steps

Status: the code is built and tested; **nothing here has been done in AWS**. No signing key exists
(register item EW2-2). The steps below are for the owner to run later, once, by hand. Nothing in the
release workflow or in any deploy creates the key.

## Why the signing permission is limited to one workflow job

`release:kit` writes a synthesis kit and records the SHA-256 of every kit file in `kit.json`.
`release:bundle` checks those hashes again, immediately before it signs (it hashes the bytes it is
about to sign, in the same process, and refuses on any difference). Both checks use hashes that come
from the kit itself, so they protect against mistakes and against a file changing mid-run. They do
not stop a person who can run `release:bundle` with a signing permission: they can edit the kit,
recompute `kit.json`, and sign it.

The complete answer is that nobody holds the signing permission except one job:

- **The role.** `rovara-release-bundle-signing` can be assumed only through GitHub's OIDC token, and
  only when all of these hold:
  - `aud` is `sts.amazonaws.com`;
  - `sub` is `repo:<owner>/<repo>:ref:refs/tags/v*` (a version tag of the named repository; a branch,
    a pull request or an environment never matches);
  - `job_workflow_ref` is `<owner>/<repo>/.github/workflows/release.yml@refs/tags/v*`.
- **The key.** An ECC P-256 `SIGN_VERIFY` KMS key. Its key policy allows `kms:Sign` and
  `kms:GetPublicKey` only when the caller is that role, and has an explicit **Deny** of `kms:Sign` for
  every other principal, account administrators included. Administrators can manage the key but not
  use it or create grants for it.
- **The role's own policy.** `kms:Sign` and `kms:GetPublicKey` on that one key, and nothing else.

The key is in `infra/lib/bundle-signing.ts` (`BundleSigningStack`, stack name `AgentXBundleSigning`,
`us-east-1`). It exists only when the context key `agentxBundleSigning=enabled` is given; without it
every other template is byte-for-byte what it was (a test checks this).

## What this does not protect against (read before relying on it)

Anyone who can push a `v*` tag to the repository can start `release.yml` at that tag, and the
workflow file at that tag is the one that runs. A tag pointing at a commit that edits `release.yml`
(or the scripts it calls) would still get the role. The role limits signing to the release workflow;
it does not make the workflow itself trustworthy. Before the key is used:

1. Add a tag ruleset on the repository: only the release owners can create `v*` tags, nobody can
   update or delete them.
2. Keep branch protection on `mainline`. The `images` job already refuses a tag whose commit is not on
   mainline, and the `bundle` job needs it; if a later change makes the bundle job independent of it,
   re-check this.
3. Optional hardening: put the bundle job in a GitHub environment with required reviewers. The
   token's `sub` then becomes `repo:<owner>/<repo>:environment:<name>`, so the trust patterns in
   `bundleSigningTrustPatterns` must be changed together with the workflow and their tests.

## Which repository

The release workflow's `bundle` job runs only where `github.repository == 'PrepLabsAI/Rovara'`
(the public repository; the Cloud copy never publishes). The role must name **the repository that
actually runs the job**. This is a required setting, with no default, so a wrong guess fails at synth
instead of creating a role no job can use. If the bundle job is moved to `PrepLabsAI/Rovara-cloud`,
change the job's repository guard, its test and this setting together.

If the repository's OIDC subject uses immutable ids (docs/releases.md describes this for the publish
role), also pass `agentxBundleSigningRepositoryIds=<ownerId>/<repoId>`; `sub` is then matched as
`repo:*@<ownerId>/*@<repoId>:ref:refs/tags/v*`. `job_workflow_ref` always uses names.

## One-time steps for the owner

Nothing below has been run. Use the release account (944937319445, `us-east-1`) with the
`staging-aws.sh`-style guard for the account you are in; check the account and region first.

1. **Check the GitHub OIDC provider exists** in the account (the publish role already uses one):

   ```sh
   aws iam list-open-id-connect-providers
   ```

   Note the ARN ending `oidc-provider/token.actions.githubusercontent.com`. An account can hold one
   provider per URL, which is why the stack takes the ARN instead of creating it.

2. **Synthesize and review** (no AWS call):

   ```sh
   npx cdk synth AgentXBundleSigning \
     -c agentxBundleSigning=enabled \
     -c agentxBundleSigningRepository=PrepLabsAI/Rovara \
     -c agentxBundleSigningOidcProviderArn=arn:aws:iam::944937319445:oidc-provider/token.actions.githubusercontent.com
   ```

   Read the key policy and the role's trust policy in the output. They must match the list above.

3. **Deploy** the same command with `cdk deploy AgentXBundleSigning`. The key has deletion policy
   Retain and termination protection is on: every installer pins the public half, so a deleted key
   cannot be replaced without shipping a new CLI.

4. **Verify the OIDC claim keys.** `job_workflow_ref` as an IAM condition key for the GitHub provider
   is supported according to secondary sources only; confirm it in the AWS IAM documentation
   ("OIDC federation: condition keys") before relying on it. If it were not supported, the condition
   would never match and the role could not be assumed (a failed release, not a weaker policy); the
   `sub` condition still pins the repository and tag.

5. **Set the repository variables** from the stack outputs: `AGENTX_BUNDLE_KMS_KEY` =
   `BundleSigningKeyArn`, `AGENTX_BUNDLE_SIGNING_ROLE_ARN` = `BundleSigningRoleArn`, then
   `AGENTX_BUNDLE_ENABLED=true`. The `bundle` job is off until all three are set.

6. **Prove the limit works** before the first real release:
   - from a branch or a workflow_dispatch run on a branch, the `bundle` job must fail at
     `configure-aws-credentials` (not assumable);
   - from your own credentials, `aws kms sign --key-id <arn> --message fileb://x --message-type RAW --signing-algorithm ECDSA_SHA_256`
     must be denied, even as an administrator.

7. **Publish the public key.** Fetch it with `aws kms get-public-key` (the release job does this at
   run time), add it to `packages/cli/src/upgrade/bundle/trusted-keys.ts`
   (`PINNED_BUNDLE_SIGNING_KEYS`) in a CLI release made before the first signed bundle, and publish it
   on the release channel for `--bundle-public-key`.

## Changing who may sign later

Replace the key policy (`PutKeyPolicy`) through the stack. It is logged in CloudTrail. Do not add
`kms:Sign` to any IAM user or role policy: the key policy's Deny overrides it, by design.
