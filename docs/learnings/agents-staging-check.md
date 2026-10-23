# Agents staging check (Plan 3 Task 37, combined round): attempt 1, 2026-10-23

Staging is us-west-2, account agentx-test (944937319445), env `staging`, cloud. The deploy ran from the isolated clone
`~/web/Rovara-staging-clone`, branch `staging-deploy` at ba7e48d5 (= origin/feat/agents-plan3 on private Rovara-cloud).
The tag was local only: `v0.4.0`. `agentx upgrade` refuses prerelease versions, so a tag like `v0.4.0-staging.1` cannot be used.
Every command ran through `staging-aws.sh`. Nothing touched us-east-1 or agentxlivetest123.

Method: `agentx --env staging upgrade --region us-west-2 --source <clone> --worker-image ... --boot-stage2-sha256 ... --slack-image ... --yes`
(cdk engine). Images were built linux/arm64 from the clone and pushed to the staging ECR repos (tag v0.4.0):
- worker sha256:ad32b73d1e592909e4db6435d6e070aa0ed34fb15c49ae14d279eec4dda652fb
- slack sha256:d1141cd4e5394a689446c73de8cf9c3f92908f2b0ec18727f8e4203ea894dd07
- boot-stage2 sha256 1bfeb60ecf95c5179f1b21d4b5a518bd2143b7fdc26da06b3d1b6de91ed35cfb

## Result: FAILED at the control-plane stack (rolled back)

Pre-deploy `cdk diff` (template method, all six stacks) replaced or deleted no stateful resource. It replaced the broker
Lambda (expected), plus its Permission and EventInvokeConfig, and the ModelProxy ECS task definition. It also removed the
broker's inline DefaultPolicy, which moves into three managed policies.

The deploy order was access, foundation, identity (no change), runtime: all were UPDATE_COMPLETE. The control plane then
failed and rolled back to UPDATE_ROLLBACK_COMPLETE, so slack was not attempted.

**Cause (code bug):** `ConnectorSecretsRole` (`infra/lib/control-plane.ts`, `new iam.CfnRole`) has a fixed `roleName` and no
`path`, so it is created at `/`. The CloudFormation service role `agentx-staging-cloudformation` may manage only
`role/agentx/staging/*` (statement `IamRoles`). CREATE failed with AccessDenied on `iam:GetRole`, and the rollback
DELETE failed on `iam:DeleteRolePolicy`. The role does not exist (checked).

**Correction (2026-10-23, role-path fix):** the first reading above (no `path`) was wrong. The synthesized template already had
`Path: /agentx/staging/` (the `EnvironmentRolePath` aspect worked; `cdk.out/AgentXControlPlane.template.json` in the clone shows it). The
error names the path-less ARN `role/agentx-staging-connector-secrets` because CloudFormation looks a fixed-name role up by name before
creating it, and IAM authorizes a lookup of a role that does not exist yet against `role/<name>`, which `role/agentx/staging/*` does not
cover. Fix: the service role and the default boundary also allow the read and delete actions (no create) on that exact path-less ARN,
for each fixed-name role (`fixedNameEnvironmentRoleNames`). The access stack must be deployed first, to carry the new statement;
`tests/contract/role-paths.test.ts` guards it.

**Orphans left by the rollback:** three retained, empty audit DynamoDB tables with random names, so a retry does not
collide. Delete them at teardown or once the fix lands. Not deleted here.
- agentx-staging-control-plane-AuditLedgerAuditKeysTableF5520AEA-YXFB2KMELR4I
- agentx-staging-control-plane-AuditLedgerAuditLedgerTableC60B8D3B-NTHJP7D70UAX
- agentx-staging-control-plane-AuditLedgerAuditSealsTableF2EABAF8-RZBLW4DJYSAW

Audit buckets, log groups and the salt secret were rolled back (DELETE_COMPLETE).

**Mixed state now:** access, foundation and runtime (new worker image and boot hash) are on ba7e48d5. The control plane
and slack are on the previous code. The settings still record 0.3.5. Re-run the same `upgrade` once the fix is in:
it continues from the stack that failed.

## Checks

| Check | Result | Reason |
|---|---|---|
| Diff: no stateful replace/delete | PASS | Only the broker Lambda and its permission and invoke config, plus the proxy task definition, are replaced. |
| All agentx-staging-* stacks COMPLETE | FAIL | The control plane is UPDATE_ROLLBACK_COMPLETE. The others are complete; slack was not updated. |
| SpendSettlementSchedule exists | FAIL | Rolled back with the control plane. |
| ConnectorSecretsRole exists | FAIL | Its creation was the failure (role path, above). |
| Proxy STORE_MODEL_IN_DB=True | NOT TESTED | The new task definition was rolled back. |
| Task key 401/403 on /key/info, /model/new (R48) | NOT TESTED | The control plane was not deployed, and minting a key needs a signed-in task. |
| Broker env size < 4096 | NOT TESTED | The broker was not replaced. The live, old broker is still 47 vars and 3,856 bytes. |
| Broker starts with AGENTX_NAMES hydrated | NOT TESTED | The new broker was not deployed. |
| API answers | PASS (old code) | /v1/app/me and /v1/dev/whoami return 401 without a token. |
| Web health | NOT TESTED | There is no public health route. Admin health needs an admin sign-in (email; deferred). |
| Steps 4-13 (live flows), Cognito amr gate | NOT TESTED | Blocked by the failed deploy. Vendor and test-email checks are deferred to the final round. |

## Retry attempt, 2026-10-23: blocked before deploy (nothing changed)

- The clone moved to 44f5ef73 (fast-forward) with local-only tag `v0.4.1`. `npm ci`, build and `tsc -b` are clean.
- The images were reused, because 2a69897b..44f5ef73 changes only infra, contracts and tests.
- A fresh template diff of all six stacks matches attempt 1, so there is still no stateful replace or delete:
  - Access gains a CloudFormation service role Allow for 7 IAM read and delete actions on the path-less `role/agentx-staging-connector-secrets`, plus the boundary update.
  - Foundation, identity, runtime and slack show no changes.
  - The control plane has the same changes as attempt 1: the broker Lambda, its permission and invoke config, and the proxy task definition are replaced; the user pool is modified in place.
- The `agentx upgrade` command was **denied by the Claude Code permission system** (the auto-mode classifier). An agent's message is not owner approval, so it was not worked around.
- Stacks are as attempt 1 left them, with the control plane at UPDATE_ROLLBACK_COMPLETE.
- To proceed, the owner runs the upgrade, or allows it to run, from the clone:
  `staging-aws.sh node packages/cli/dist/bin.js --env staging upgrade --region us-west-2 --source <clone> --worker-image <repo>/worker@sha256:ad32b73d… --boot-stage2-sha256 1bfeb60e… --slack-image <repo>/slack@sha256:d1141cd4… --yes`
- Every post-deploy check stays NOT TESTED until then.

## Attempt 3, 2026-10-23: upgrade 0.3.5 to 0.4.2 COMPLETE (reserved concurrency off)

- Code c8a37cd5 (local tag v0.4.2), reused images (worker/slack/model-runtime unchanged since ba7e48d5). Run by the owner with `--no-reserved-concurrency`, because the account's Lambda concurrency limit was 10. The limit is now 1000 (quota approved), so a follow-up upgrade without the flag restores the reservations (AuditAnchor 5, the other 1).
- Doctor: 0 failed, 31 passed, 3 warnings, 2 skipped. Warnings: no release.json for 0.4.2 (local tag, expected); the GitHub webhook's latest delivery got HTTP 403 (see below); the Slack redirect URL could not be confirmed (the same as before).

| Check | Result | Reason |
|---|---|---|
| All agentx-staging-* stacks COMPLETE | PASS | All six are UPDATE_COMPLETE or CREATE_COMPLETE. |
| SpendSettlementSchedule exists | PASS | agentx-staging-control-pla-SpendSettlementSchedule-1QESDXDST2H89 |
| ConnectorSecretsRole exists | PASS | agentx-staging-connector-secrets |
| Proxy STORE_MODEL_IN_DB=True | PASS | model-proxy task definition :4 |
| Broker env size < 4096 | PASS | 3,019 bytes (names and values) |
| Broker starts with AGENTX_NAMES hydrated | PASS | An empty-event invoke answers 401 AUTH_REQUIRED with no init error. |
| API answers | PASS | /v1/app/me and /v1/dev/whoami return 401 without a token. |
| Task key 401/403 (R48) | NOT TESTED | Needs a signed-in task. |
| GitHub webhook delivery | OPEN | Doctor says the latest delivery got 403. It may predate this deploy; check the App's Advanced page or redeliver. |
