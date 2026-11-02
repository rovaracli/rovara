# Running Rovara

This guide covers an installed environment: checking it, upgrading it, changing its settings, and
adding projects, channels and connectors. [docs/install.md](install.md) covers the install.

## The operator role

Day-2 commands run with the operator role the install created, `agentx-<env>-operator`. It can do
everything on this page except the few places marked "admin credentials". Its ARN is the access
stack's `OperatorRoleArn` output:

```sh
aws cloudformation describe-stacks --stack-name agentx-<env>-access --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='OperatorRoleArn'].OutputValue" --output text
```

Add an AWS CLI profile that assumes it, then pass `--profile` or set `AWS_PROFILE`:

```ini
[profile agentx-<env>-operator]
role_arn = <the OperatorRoleArn>
source_profile = <your own profile>
region = <region>
```

Only the principal named at install (`--operator-principal`) may assume it. Without one, any
principal in the account that IAM allows may. Every command below takes `--region <region>`; it
defaults to your AWS configuration.

## Check it

```sh
agentx --env <env> doctor --region <region>
```

`doctor` checks every piece and prints, for each problem, what is wrong and how to fix it. The
checks, in order:

- **stacks**: every stack exists and is healthy, runs the release the settings name (by code
  package hashes and image digests), was deployed by the engine the settings name, and its last
  drift result.
- **secrets**: every secret exists and has the right shape. Values are read only to check their
  shape, and never printed. An Anthropic or OpenAI key init stored must start with that provider's
  prefix. An OpenRouter, Anthropic or OpenAI key in a secret you made yourself is shown as "skip":
  doctor's role cannot read it, so check it yourself.
- **slack**: the bot token works, both Request URLs answer a signed request (the same check
  `init` makes), and the bot is in the channel `init` bound.
- **github**: the GitHub App's installation and its repository access.
- **connectors**: for each connector in this environment's project files, the credential exists
  and, for Linear, Jira and an `mcp` connector's API key, still works (an `mcp` key must still reach
  every approved tool). Saved warnings (such as a Jira account that can see
  other projects) show here.
- **models**: each model answers a one-token call.
- **alerts**: the alert subscription is confirmed, and the budget matches its setting.
- **capacity**: the region's EC2 vCPU quota, and free EC2-VPC Elastic IPs. Fewer than two free is
  a warning: this environment keeps working, but another one in this region would not fit.
- **sign-in**: every check of `agentx signin check`.
- **chatgpt**: [Sign in with ChatGPT](chatgpt.md): whether it's on and which model tasks prefer, how
  many people have connected a plan, and whether the control plane reaches `auth.openai.com` and
  `api.openai.com`. An unreachable host fails while it's on, and only warns while it's off. The
  control plane alone knows these, so doctor reads them through this computer's admin sign-in
  (`agentx --env <env> login --admin`); without one, the group is skipped.

`--json` prints the whole report as one JSON document on stdout. The exit code is 0 when no check
failed (warnings and skips are fine), and 2 when any check failed or doctor could not start.

**Drift.** `doctor` shows each stack's last drift result. It never starts drift detection:
detection reads every resource with the caller's own rights, which the operator role does not
have. To check drift, run the command doctor prints, with admin credentials:

```sh
aws cloudformation detect-stack-drift --stack-name agentx-<env>-<part> --region <region>
```

**Bound channels.** No route lists channel bindings yet (spec 025 phase 25d adds it), so doctor
checks only the channel `init` bound. Channels bound later are not listed.

## Upgrade

```sh
agentx --env <env> upgrade --region <region> [--to <version>]
```

Without `--to`, it upgrades to the release of the `agentx` you run. So
`npx @preplabsai/rovara-code@<version> --env <env> upgrade --region <region>` is the usual form.
`--release <dir>` uses a release directory instead of downloading one.

The access stack deploys first, so the CloudFormation role can create the broker's
`agentx-<env>-broker-*` managed policies before the control plane needs them.

It prints the release notes, then deploys each stack in turn. For each stack it shows the change
set (or, for a cdk environment, `cdk diff`), lists IAM changes on their own, and asks before
deploying. It stops before any change that replaces or deletes a table, user pool, bucket, KMS
key, secret, queue or log group, because that loses its data. To accept one, type its logical
id when asked, or name it in advance:

```sh
agentx --env <env> upgrade --region <region> --allow-replace <LogicalId>
```

Repeat `--allow-replace` for each. `--yes` deploys without asking, but still prints every change
and still stops on a data replacement you did not name. Without a terminal, `--yes` is required.

**The order** is access, foundation, identity (skipped with your own OIDC provider), runtime,
control-plane, slack. The runtime goes before the control plane so the worker, which reads
strictly, is the tolerant side while the two differ.

**The worker image and its boot hash go together.** A worker boots its second stage from the worker
image and checks it against a hash (`BootStage2Sha256`, a parameter of the runtime stack), so the
image (`WorkerImageUri`) and the hash are always written in one runtime deploy, from the same
release. The control plane must be upgraded with them: a control plane that expects a hash will not
launch a worker while the runtime stack has none (it says `run agentx upgrade`), and a runtime
stack with a new image but an old hash makes every worker fail its boot check. So never change
`WorkerImageUri` on its own; deploy the runtime stack and then the control plane of one release, as
`upgrade` does. With `--worker-image`, pass `--boot-stage2-sha256` too, the SHA-256 of
`packages/worker/ec2/boot-stage2.sh` in the source the image was built from. `agentx doctor` fails
a runtime stack with no valid boot hash. If you deploy stacks by hand from an `--export` bundle,
keep that order.

**Stopping and re-running.** `upgrade` stops at the first failure; CloudFormation rolls that stack
back. Stacks before it stay on the new release. Run the same command again: it continues. When
every stack is done, it records the new version in the settings and runs `doctor`.

**Locking.** `upgrade` holds the environment's lock while it runs, so no other `agentx` command
changes the environment at the same time. A run that was cut off leaves its lock. At a terminal,
the same caller's next `upgrade` asks at once whether to take that lock over; say yes only if the
earlier run is no longer going. A lock someone else holds is refused until it is 2 hours old
(stale); then, at a terminal, `upgrade` asks too. `--yes` never answers this question, so without
a terminal no lock is taken over, not your own and not a stale one someone else holds.

**What it keeps.** Your settings survive: the budget, the limits, `slack.appPostedMessages`,
`alerts.slowTurnMinutes`, the models, the GitHub App, the admin claim and the operator principal
are all read from the environment, and nothing is asked again. If a release drops a `config` key,
`upgrade` names it before deploying, and says nothing replaces it.

**Never back.** `upgrade` refuses a release older than the one the environment runs, naming both,
because a newer release may have written data an older one cannot read. The same release is fine
(a re-run). It also refuses every prerelease (such as `1.4.0-rc.1`).

**The operator role and the access stack.** The operator role cannot change the access stack.
Under it, `upgrade` compares the deployed access template with the release's. If they are the
same, it upgrades every other stack. If they differ, it stops before deploying anything; then
either run it with admin credentials (which deploy access first), or give your platform team an
export (below) and run `upgrade` again once they deployed it.

**The cdk engine.** A cdk environment upgrades with admin credentials and a clean checkout of the
target release's tag (the operator role cannot use CDK's bootstrap resources):

```sh
agentx --env <env> upgrade --region <region> --to <version> --source <checkout of v<version>>
```

`--to` or `--release`, when given, must be the checkout's tag. An `agentx` built from source needs
neither: it upgrades to the checkout's tag, and reads the images from `--worker-image` and
`--slack-image`, or else from that tag's `release.json` on GitHub.

**For a pipeline: `upgrade --export`.** This writes the upgrade as files and changes nothing:

```sh
agentx --env <env> upgrade --region <region> --to <version> --export <dir>
```

The bundle holds each stack's template and parameters, the changed code packages, `SHA256SUMS`,
and a `README.md` with every command: check the checksums, upload the packages, and then, stack by
stack, create a change set, read it, execute it and wait. The platform team runs every command
from the bundle's directory. A changed access stack is included, to deploy with their own
credentials. No file holds a secret: kept values are marked `UsePreviousValue`. When they are
done, run `agentx --env <env> upgrade --to <version>` once more: it finds nothing left, records
the version and runs `doctor`. A cdk environment cannot export.

## Change settings

```sh
agentx --env <env> config list --region <region>
agentx --env <env> config get <key> --region <region>
agentx --env <env> config set <key> <value> --region <region>
```

The admin sign-in (`agentx --env <env> login --admin`) lasts 6 hours and is never refreshed: after
that, every `agentx admin` command asks you to sign in again. An environment whose identity
stack is not managed by Rovara (one that brings its own OIDC provider) sets this on its own app
client, as the access and ID token validity.

`set` shows the change and asks first (`--yes` skips the question). With this computer's admin
sign-in (`agentx --env <env> login --admin`), every change `set` makes is recorded in the admin
change history (`agentx --env <env> admin changes`) with the admin who made it, the `cli` client,
the key, the value before and after, and when it was asked, applied or failed. It is recorded
after the yes and before anything changes; if Rovara cannot record it, nothing changes. If the
outcome cannot be recorded, or a stack update may still be running when `set` stops, `set` warns
and the record stays `applying`. `alerts.address` is recorded only as changed, never its value.
Without the admin sign-in, the operator role alone can still change a setting, but `set` warns
first that the change will not be recorded. A stack-parameter change needs a sign-in with at
least 35 minutes left, so its outcome can be recorded too. The record is an audit trail for
admins, not a control: the operator role alone can always change a setting unrecorded. Changes made outside `agentx config
set` (the CloudFormation console, say) are not recorded. Each key lives in exactly one place:

| Key | Where it lives | Default | Notes |
|---|---|---|---|
| `models.orchestrator` | stack parameter ModelId on agentx-<env>-slack, and the settings | from init | tested with one call first |
| `models.classifier` | stack parameter GateClassifierModelId on agentx-<env>-slack, and the settings | from init | tested with one call first |
| `models.worker` | stack parameter ModelId on agentx-<env>-runtime, and the settings | from init | tested with one call first |
| `models.e2eAgent` | stack parameter E2eAgentModelId on agentx-<env>-runtime | default | the AI model that navigates your app in browser checks: `default` is Rovara's recommendation; any other value must be a model Rovara can use with your provider and region (for Bedrock, a `us.` or `global.` inference profile id; `us.` keeps your app's pages in US data centers, `global.` may process them outside the US). No test call is made here: a model is proved by its driving test before AI navigation runs with it. Changing it asks for a new setup approval |
| `models.fallback` | stack parameter ModelFallback on agentx-<env>-runtime and agentx-<env>-slack | none | the Bedrock model the coding worker, the orchestrator and the classifier run on when their provider's key secret is missing: `none` (no fallback: the call fails by name) or a Bedrock model id of Rovara's model catalog, tested with one call before it is set. It sets both stacks, one after the other, after one yes. When a fallback runs, the task page (for the worker) and the Slack reply (for the orchestrator) say which model ran and why; the classifier and router only log it |
| `models.chatgpt.enabled` | control-plane setting CHATGPT.enabled | false | true or false; [Sign in with ChatGPT](chatgpt.md); changes through the admin change path, with the admin sign-in |
| `models.chatgpt.preferredModel` | control-plane setting CHATGPT.preferredModel | gpt-6.1-sol | used only where a person's plan allows it; changes through the admin change path, with the admin sign-in |
| `limits.workspacesPerMember` | control-plane setting WORKSPACE_LIMITS.perPerson (install-time default SlackMemberWorkspaceLimit) | 3 | 1 to 50; changes through the admin change path, with the admin sign-in (`agentx --env <env> login --admin`) |
| `limits.workspacesPerOrg` | control-plane setting WORKSPACE_LIMITS.perOrganization (install-time default SlackOrganizationWorkspaceLimit) | 20 | 1 to 1000; changes through the admin change path, with the admin sign-in |
| `limits.threadTurnsPerMinute` | stack parameter SlackThreadTurnsPerMinute on agentx-<env>-control-plane | 6 | 1 to 60 |
| `slack.appPostedMessages` | stack parameter SlackAppPostedMessages on agentx-<env>-control-plane | accept | accept or ignore |
| `alerts.address` | SSM /agentx/<env>/settings (alertAddress) | none | a webhook comes from --value-file or --value-env |
| `alerts.slowTurnMinutes` | stack parameter SlowTurnMinutes on agentx-<env>-slack | 5 | 1 to 60 |
| `budget.monthlyUsd` | stack parameter BudgetMonthlyUsd on agentx-<env>-control-plane | 0 | 0 for none |
| `budget.scope` | stack parameter BudgetScope on agentx-<env>-control-plane | tag | tag or account |
| `audit.lock` | stack parameter AuditLockProfile on agentx-<env>-control-plane | production (trial in staging, test and dev*, when init chose nothing) | production or trial; trial to production only, never back: records written from now on are locked for 3 years and can't be shortened |
| `rovaraCode.v2` | stack parameter RovaraCodeV2Enabled on agentx-<env>-control-plane | false | true or false; true makes Rovara Code version 2 available in this environment (an org admin then adopts it; new tasks of an org that did run it, existing tasks keep their version). Named environments only; a released install never has it |
| `planSelfCheck.enabled` | stack parameter PlanSelfCheckEnabled on agentx-<env>-control-plane | true | true or false; false sends coding plans to the owner as written (no plan check, no second planning run, no check against the current app). Named environments only; a released install never has it and keeps the default (on) |
| `autofix.enabled` | stack parameter AutofixEnabled on agentx-<env>-control-plane | true | true or false; false leaves blocked checks and reviews to the owner (Rovara no longer sends them back to coding, or retries them, by itself). Named environments only; a released install never has it and keeps the default (on) |
| `liveSteer.enabled` | stack parameter LiveSteerEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 gives a person's message to a running Understand, Plan or Implement step live (0 keeps every message a note for the next step). Deploy the dispatcher, publisher and broker first, then the worker image that carries `task.liveSteer.v1`, then set 1; to roll back, set 0. Named environments only |
| `liveRedirect.enabled` | stack parameter LiveRedirectEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets the task owner or a co-owner stop a running step and redirect it with a new instruction (the route does not exist while it is 0). Deploy the dispatcher and the worker image that carries `task.ownerRedirect.v1` first, then the broker, then set 1; to roll back, set 0. Redirects that restart a coding run (keep the plan at coding, and the checks and the review) need the worker's feature list, which the session manager records on the workspace's session when the worker becomes ready (the broker has no network path to the workers); a workspace that was already running when this was deployed has no list until its next start, and a coding redirect on it is refused with the older-worker sentence, while Understand, Plan, "this changes the plan" and a plan waiting for approval work without it. Named environments only |
| `liveAsk.enabled` | stack parameter LiveAskEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 turns on Ask about this task (a person with "can use" asks a question about a task and an AI answers from its data; the answer cannot change anything). 0 answers "not found" on every Ask route. Deploy the broker and the chat service first, then set 1; to roll back, set 0. Named environments only |
| `liveFix.enabled` | stack parameter LiveFixEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 turns on Fix with agent (a person who can use an error's task asks for a diagnosis: an AI explains what went wrong and proposes fixes; it applies nothing, and a settings change is raised only when a person with the right role presses "Propose this change", through the ordinary settings route). 0 answers "not found" on every diagnosis route. Deploy the broker and the chat service first, then set 1; to roll back, set 0. Public: the light diagnosis is paid by Rovara, the deep one by the project payer; Enterprise: both run on your Bedrock and limits. Named environments only |
| `proofEvidence.enabled` | stack parameter ProofEvidenceEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 gathers the evidence of each task's checks (test totals and names, the worker's report of what was selected) and shows it: counts, a mocked/not-run list and a link on the pull request, an Evidence tab and a download behind sign-in on the task page. Data that looks personal or names production is dropped before anything is stored or posted. 0 gathers, posts and serves nothing new. Deploy the worker image that carries `task.evidenceCapture.v1` first, then the broker, then set 1; to roll back, set 0. Named environments only |
| `decisionCards.enabled` | stack parameter DecisionCardsEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 mounts the decision card routes (`/v1/app/decisions*`) and answers a Slack card press. A high-risk card has no approve button: it opens the confirmation page, which asks for a sign-in within the last 10 minutes. 0 answers "not found" on every card route. Named environments only |
| `testEnvironment.enabled` | stack parameter TestEnvironmentEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 turns on the project test environment: Rovara proposes it from the default branch's files, a maintainer proves it with the setup check and approves it, and later tasks run its checks (selected tests where a nightly map allows, the whole suite otherwise), name it in the evidence, and a nightly full run is scheduled for projects that turn it on. Deploy the worker image that carries `task.testEnvDetect.v1` and `task.testEnvironment.v1` first, then the broker, then set 1; to roll back, set 0. Production accounts and hosts are refused wherever the company lists them. Named environments only |
| `learnedLessons.enabled` | stack parameter LearnedLessonsEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets approved lessons be loaded into an agent as advice for its Understand, Plan, Plan-check, Implement and Review steps (a worker image that carries `task.learnedContext.v1` must be deployed; an older worker is sent none). It needs the Team record and is a separate switch from it: with 0, no lesson is loaded, recorded or sent to an agent, even where the Team record is on and a project's learning mode is On. Named environments only; a released install never has it |
| `mcp.confirmElicitation` | stack parameter McpConfirmElicitation on agentx-<env>-control-plane | enabled | enabled or disabled; disabled leaves only the Slack Confirm button or the CLI to confirm an admin change |

- **Models.** A new model must answer a one-token call before anything changes. `set` then
  updates the stack, the settings and the install answers, so `upgrade` and `init --resume` keep
  it.
- **Workspace limits.** `list` and `get` show the install-time default and say the control plane
  may hold a newer setting. `set` refuses both keys until spec 025 phase 25e ships the admin tool
  that changes them.
- **`alerts.address`.** `list` and `get` show only whether it is set, and whether it is an email
  or a webhook, never the address. An email goes on the command line. A PagerDuty or Opsgenie
  address is a secret: pass it with `--value-file <path>` or `--value-env <NAME>`, or leave the
  value out to be asked in a hidden prompt.

**Changing `alerts.address` leaves the old subscription.** `set` subscribes the new address, but
the operator role cannot unsubscribe. For each old subscription it prints the command for an
admin to run:

```sh
aws sns unsubscribe --subscription-arn <the ARN it prints> --region <region>
```

A new email address gets alarms once its owner confirms the subscription. Then send a test alarm
with `agentx --env <env> alerts test`.

## Replace the Slack bot token

When Slack refuses the bot token (doctor shows "Slack refused the bot token", with Slack's error
code such as `invalid_auth` or `token_revoked`), get a new one and store it. `agentx init` does not
do this for a finished install.

1. Open the Slack app at api.slack.com/apps, choose **Install App**, reinstall it to the
   workspace, and copy the **Bot User OAuth Token** (it starts with `xoxb-`).
2. In the AWS console for the environment's region, open **Secrets Manager** and choose the secret
   `agentx/<env>/slack`. The console lists secrets only for a caller allowed
   `secretsmanager:ListSecrets`, which the operator role is not, so use admin credentials here.
3. Choose **Retrieve secret value**, then **Edit**.
4. Change only the value of the `botToken` key to the new token. Leave the other keys
   (`signingSecret`, and `clientId` and `clientSecret` when Slack sign-in is on) as they are.
5. Choose **Save**.
6. Check it:

   ```sh
   agentx --env <env> doctor --region <region>
   ```

Nothing needs a restart. The Slack service and the control plane's Slack functions keep the
secret for up to 5 minutes, then read it again, so they use the new token within 5 minutes of the
save. `doctor` reads the secret itself, so it checks the new token at once.

## Projects, channels and connectors

- `agentx --env <env> project add --repository <owner/name>`: registers another project on EC2
  workers, and writes its file to `~/.agentx/projects/<name>.yaml`.
- `agentx --env <env> channel add --project <name> --channel <channel>`: binds a Slack channel,
  invites the bot, and waits for a mention to get a threaded reply (`--no-check` skips the wait).
- `agentx --env <env> connector add linear|jira|asana --project <name>`: adds a connector, tests a
  read, and registers the project's next revision.
- `agentx --env <env> connector add mcp --project <name> --endpoint <url>`: connects any other
  remote MCP server with an API key or an OAuth sign-in, lists its tools as the test read, and
  registers the project's next revision with the tools you approve
  ([connectors/custom-mcp.md](connectors/custom-mcp.md)).
- `agentx --env <env> alerts test`: sends a test alarm to the alert address and asks whether it
  arrived.

The worker image has Python 3, pip, venv and uv. Debian bookworm's system Python is externally
managed, so a Python project's setup command should make a virtual environment
(`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`) or use uv (`uv sync`).

## Developer sign-in

- `agentx --env <env> signin show`: which methods are on, and what the control plane offers.
- `agentx --env <env> signin enable slack|oidc`: turns a method on; shows the change and asks.
- `agentx --env <env> signin disable slack|oidc`: turns a method off; everyone signed in with it
  is signed out at once.
- `agentx --env <env> signin check`: checks every piece sign-in needs, and says what to fix.
- `agentx --env <env> signin unlink cloud|github`: removes that sign-in method from your own account and signs out
  its sessions; your other methods keep working. The method your account was created with, and your only method,
  cannot be removed. It needs a sign-in from the last 10 minutes with a method you are keeping: if yours is older,
  or is the method you are removing, the command signs you in again first and then retries once.
- `agentx --env <env> signin link cloud|github`: adds a sign-in method you removed earlier back to your own account
  (the same sign-in as before, never anyone else's). It needs the same fresh sign-in, opens the sign-in in your
  browser, and the page there says when it is added. Run `agentx whoami` to see it. A sign-in that has since started
  its own account cannot be added back.

Developers need no AWS credentials: they run `npx @preplabsai/rovara-code login <control plane URL>`.
To hand tasks to Rovara from Claude Code, Codex or Cursor, and to share them to Slack, they follow
[docs/mcp-install.md](mcp-install.md).

## GitHub connection requests (Rovara Cloud)

Only the Rovara operator can redeliver an `installation.created` webhook, from the GitHub App's settings (Advanced, Recent Deliveries), and only within about 3 days of the delivery: use it when an approved "ask my GitHub admin" request was not bound because GitHub or the control plane was down (the request stays waiting and a redelivery retries it).

## Shared tasks

A developer can share a task from their AI tool into a project's Slack channel, view only or open
to the channel (continue). A project's `developerTasks` settings decide whether sharing is required,
the default mode and whether continue is allowed; see
[docs/project-configuration.md](project-configuration.md#developer-tasks). To switch a shared task's
mode, sign in as an admin (`agentx --env <env> login`) and run:

```sh
agentx --env <env> admin task share-mode --task <task-id> --mode view|continue
```

The mode stays within the project's settings: with continue not allowed, the task stays view only.
An admin cannot share a private task or move a shared one to another channel. `agentx --env <env>
admin turns export --since 7d` shows task IDs.

## Private package registries (Enterprise, off by default)

A project can name private package registries (npm, PyPI, Maven; CodeArtifact first) that its setup and readiness commands install from. It is switched on only when the install is
synthesised with the context key `rovaraCodeArtifactDomains`; without it nothing is granted and a project that names a registry cannot start a preparation.

```text
-c rovaraCodeArtifactDomains=<domain>:<account>:<region>:<org>:<repository>+<repository>[,<more>]
```

`<org>` is an org id (`org_` and 20 characters) or the word `install`, the install's one org. Repositories are named, never a wildcard. At most 4 domains. The key is refused for the
Public edition, the hosted cloud and an install with no edition: those installs are shared by many companies and have no per-org binding yet.

What the admin accepts, plainly:

- **The token reads the named repositories, install-wide, not per project.** CodeArtifact's `GetAuthorizationToken` takes only a domain, an owner and a duration: it has no way to scope a
  token to one repository or one run. A token carries the permissions of the role that minted it, so Rovara limits the broker role to `codeartifact:ReadFromRepository` on the repositories
  you list. Every project of the bound org that names a listed repository gets a token that can read ALL listed repositories. Do not list a repository some of the org's projects should
  not read.
- A token lasts one hour (IAM refuses a longer one on this role: `sts:DurationSeconds` 900 to 3600) and exists only during a project's preparation. It is readable by that project's own
  setup and readiness commands, which need it to install. A command that copies it somewhere the agent can read stops the preparation and sets the workspace aside (it is set up again from
  a fresh clone), but a command that sends it over the network to a host the project may reach is not stopped.
- After every setup or readiness command Rovara searches the workspace for the token, and checks that no repository gained a commit, branch, tag, stash or object (a committed token sits in
  compressed objects). Either finding, or a search that cannot finish, sets the workspace aside and it is cloned again. **A very large tree (over 600,000 files, 6 GiB or 3 minutes of
  search) will keep being cloned again**: the worker log says `registry.scan_unfinished` with the reason (`files`, `bytes`, `time` or `unreadable`). Not covered: archives (a token packed
  into a tarball), and a repository created under `node_modules`. A setup step that itself commits, tags, stashes or runs `git gc` in a repository cannot be used with registries.
- A read through a repository that has an upstream or external connection can make CodeArtifact fetch and keep new package versions from upstream. That is how CodeArtifact reads work.
- **Cutting off outstanding tokens.** A token made with an assumed role's credentials stops working when that role's policy denies it (CodeArtifact docs, "Revoking CodeArtifact
  authorization tokens"). In an incident, remove the three registry statements from the broker role (redeploy without `rovaraCodeArtifactDomains`, or add an explicit deny): every
  token already issued stops working.
- Generic registries you run (npm, pypi, maven) need a credential store the install does not have yet, and projects with a devcontainer cannot use registries yet.
