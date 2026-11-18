# Release runbook: private values

This file holds the real values behind the placeholders in the public docs (`docs/releases.md`,
`docs/maintainers-release.md`, `docs/specs/rovara-e2e-runtimes/m1-live-acceptance.md` in Rovara Code).
It is private. Do not copy these values into the public repository, public issues or pull requests.
Owner decision 2026-11-18: the public docs carry placeholders and history is not rewritten.
Later (owner decision, not done): move the release resources into their own AWS account, separate
from staging, before production customers (see DEFERRED-CHECKS.md).

| Placeholder | Value |
| --- | --- |
| `<release-account-id>` | `944937319445` (today the same account as staging and the live-test installations; region `us-east-1`) |
| `<codeconnections-arn>` | `arn:aws:codeconnections:us-east-1:944937319445:connection/7e76074b-e840-439f-b94c-6806a2bf9513` (GitHub connection, already authorized) |

## Resources in the release account

- ECR Public repositories `agentx-worker` and `agentx-slack`, registry alias `i7z2k3a8` (the alias is
  public: it is in image URLs).
- Publish role `arn:aws:iam::944937319445:role/agentx-github-release` (GitHub OIDC, version tags only).
- Installer bucket `rovara-installer-us-east-1` (public read of objects by design; the publish role writes).
- Release pipeline stack `AgentXReleasePipeline`, deployed with `--parameters GitHubConnectionArn=<the ARN above>`.
- Account-level check for the installer bucket: `aws s3control get-public-access-block --account-id 944937319445`
  (use the staging guard script `staging-aws.sh` for any AWS call; us-east-1 is the release region, us-west-2 is staging).

## Rules

- A bare account id grants nothing and must not be treated as a secret or as proof of anything; no
  policy may trust "anyone who knows the account id". See `briefs/lead4/L4-ACCT-TRUST-REVIEW.md`.
- Use the placeholders in anything public. Add new real values here, not in public docs.
